import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import logger from '#logger';
import { installYtDlpBinary } from './local/ytDlpInstaller.js';
import {
  DEFAULT_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  YTDLP_INFO_TIMEOUT_MS,
  YTDLP_BINARY_PATH,
  YTDLP_COOKIES_FROM_BROWSER,
  PROJECT_ROOT_DIR,
  DEFAULT_COOKIES_PATH,
  MAX_SEARCH_RESULTS,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_MB_LABEL,
  THUMBNAIL_TIMEOUT_MS,
  MAX_THUMB_BYTES,
  VIDEO_PROCESS_TIMEOUT_MS,
  VIDEO_FORCE_TRANSCODE,
  FFMPEG_BIN,
  FFPROBE_BIN,
  SEARCH_CACHE_TTL_MS,
  MAX_SEARCH_CACHE_ENTRIES,
  MAX_REDIRECTS,
  MAX_ERROR_BODY_BYTES,
  MAX_META_BODY_CHARS,
  TRANSIENT_HTTP_STATUSES,
  TRANSIENT_NETWORK_CODES,
  YTDLS_ENDPOINTS,
  ERROR_CODES,
  KNOWN_ERROR_CODES,
  TYPE_CONFIG,
  PLAY_DOWNLOADS_DIR,
} from './playCommandConstants.js';

const createError = (code, message, meta) => {
  const error = new Error(message);
  error.code = code;
  if (meta) error.meta = meta;
  return error;
};

const withErrorMeta = (error, meta) => {
  if (!error || typeof error !== 'object') return error;
  error.meta = {
    ...(error.meta || {}),
    ...(meta || {}),
  };
  return error;
};

const isAbortError = (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ECONNABORTED';

const normalizeRequestError = (error, { timeoutMessage, fallbackMessage, fallbackCode }) => {
  if (KNOWN_ERROR_CODES.has(error?.code) && error?.message) return error;
  if (isAbortError(error)) {
    return createError(ERROR_CODES.TIMEOUT, timeoutMessage, {
      rawCode: error?.code || error?.name || null,
    });
  }
  return createError(fallbackCode || ERROR_CODES.API, fallbackMessage, {
    cause: error?.message || 'unknown',
    rawCode: error?.code || error?.name || null,
  });
};

const normalizePlayError = (error) => {
  if (KNOWN_ERROR_CODES.has(error?.code) && error?.message) return error;
  if (isAbortError(error)) {
    return createError(ERROR_CODES.TIMEOUT, 'Timeout ao processar sua solicitação.', {
      rawCode: error?.code || error?.name || null,
    });
  }
  return createError(ERROR_CODES.API, 'Erro inesperado ao processar sua solicitação.', {
    cause: error?.message || 'unknown',
    rawCode: error?.code || error?.name || null,
  });
};

const delay = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));

const truncateText = (value, maxChars = MAX_META_BODY_CHARS) => {
  if (typeof value !== 'string') return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated]`;
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const pickFirstString = (source, keys) => {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return null;
};

const ensureHttpUrl = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    return null;
  } catch {
    return null;
  }
};

const formatNumber = (value) => {
  const number = toNumberOrNull(value);
  if (number === null) return null;
  return number.toLocaleString('pt-BR');
};

const formatDuration = (value) => {
  if (value === null || value === undefined) return null;
  const number = toNumberOrNull(value);
  if (number !== null) {
    const totalSeconds = Math.max(0, Math.floor(number));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
};

const formatVideoInfo = (videoInfo) => {
  if (!videoInfo || typeof videoInfo !== 'object') return null;
  const lines = [];
  const title = pickFirstString(videoInfo, ['title', 'titulo', 'name']);
  if (title) lines.push(`🎧 ${title}`);
  const channel = pickFirstString(videoInfo, ['channel', 'uploader', 'uploader_name', 'author']);
  if (channel) lines.push(`📺 ${channel}`);
  const duration = formatDuration(videoInfo.duration);
  if (duration) lines.push(`⏱ ${duration}`);
  const id = pickFirstString(videoInfo, ['id', 'videoId', 'video_id']);
  if (id) lines.push(`🆔 ${id}`);
  return lines.length ? lines.join('\n') : null;
};

const getThumbnailUrl = (videoInfo) => {
  if (!videoInfo || typeof videoInfo !== 'object') return null;

  const direct = pickFirstString(videoInfo, ['thumbnail', 'thumb', 'thumbnail_url', 'thumbnailUrl', 'thumb_url', 'image', 'cover', 'artwork']);
  const directUrl = ensureHttpUrl(direct);
  if (directUrl) return directUrl;

  const objectThumb = videoInfo.thumbnail;
  if (objectThumb && typeof objectThumb === 'object') {
    const objectUrl = ensureHttpUrl(objectThumb.url || objectThumb.src);
    if (objectUrl) return objectUrl;
  }

  if (Array.isArray(videoInfo.thumbnails)) {
    for (const thumb of videoInfo.thumbnails) {
      const thumbUrl = ensureHttpUrl(thumb?.url || thumb?.src);
      if (thumbUrl) return thumbUrl;
    }
  }

  return null;
};

const buildQueueStatusText = (status) => {
  if (!status?.fila) return null;

  const fila = status.fila;
  const downloadsAhead = toNumberOrNull(fila.downloads_a_frente);
  const position = toNumberOrNull(fila.posicao_na_fila);
  const totalQueued = toNumberOrNull(fila.enfileirados);

  if (downloadsAhead === null && position === null && totalQueued === null) {
    return null;
  }

  const lines = [];
  if (position !== null) lines.push(`📍 Posição na fila: ${position}`);
  if (downloadsAhead !== null) lines.push(`🚀 Downloads à frente: ${downloadsAhead}`);
  if (!lines.length && totalQueued !== null) lines.push(`📦 Itens na fila: ${totalQueued}`);

  return lines.join('\n');
};

const buildReadyCaption = (type, infoText) => {
  const config = TYPE_CONFIG[type];
  if (!config) return infoText || '';
  if (!infoText) return config.readyTitle;
  return `${config.readyTitle}\n──────────────\n${infoText}`;
};

const buildTempFilePath = (requestId, type) => {
  const safeId = String(requestId || 'req')
    .replace(/[^a-z0-9-_]+/gi, '')
    .slice(0, 48);
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  return path.join(PLAY_DOWNLOADS_DIR, `play-${safeId}-${Date.now()}.${ext}`);
};

const safeUnlink = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    return;
  }
};

const createAbortSignal = (timeoutMs) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: undefined, cleanup: () => {} };
  }
  const controller = new globalThis.AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  };
};

const normalizeHeaderValue = (value) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const getHeaderValue = (headers, key) => {
  if (!headers || typeof headers !== 'object') return undefined;
  const lowerKey = key.toLowerCase();
  const raw = headers[lowerKey] ?? headers[key] ?? headers[key.toUpperCase()];
  return normalizeHeaderValue(raw);
};

const normalizeMimeType = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const mime = value.split(';', 1)[0]?.trim().toLowerCase();
  return mime || null;
};

const resolveMediaMimeType = (type, contentType) => {
  const normalized = normalizeMimeType(contentType);

  if (type === 'audio') {
    return normalized && normalized.startsWith('audio/') ? normalized : TYPE_CONFIG.audio.mimeFallback;
  }

  if (type === 'video') {
    return normalized && normalized.startsWith('video/') ? normalized : TYPE_CONFIG.video.mimeFallback;
  }

  return normalized || 'application/octet-stream';
};

const runBinaryCommand = (command, args, { timeoutMs = VIDEO_PROCESS_TIMEOUT_MS } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const maxCapturedBytes = MAX_ERROR_BODY_BYTES * 4;

    const appendChunk = (chunks, chunk, bytes) => {
      if (!chunk || bytes >= maxCapturedBytes) return bytes;
      const current = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxCapturedBytes - bytes);
      if (remaining <= 0) return bytes;
      const accepted = current.length <= remaining ? current : current.subarray(0, remaining);
      chunks.push(accepted);
      return bytes + accepted.length;
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes = appendChunk(stdoutChunks, chunk, stdoutBytes);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
    });

    const timeoutId =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;
    let settled = false;

    const finalize = (handler) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      handler();
    };

    child.on('error', (error) => {
      finalize(() => reject(error));
    });

    child.on('close', (code, signal) => {
      finalize(() => {
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf-8').trim();
        const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf-8').trim();

        if (!timedOut && code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const error = new Error(stderr || `Falha ao executar ${path.basename(command)}.`);
        error.code = timedOut ? 'ETIMEDOUT' : 'EPROCESS';
        error.exitCode = code;
        error.signal = signal || null;
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
      });
    });
  });

const normalizeBinaryError = (error, { timeoutMessage, fallbackMessage, endpoint, requestId, command, outputPath }) => {
  if (KNOWN_ERROR_CODES.has(error?.code) && error?.message) return error;
  if (error?.code === 'ETIMEDOUT') {
    return createError(ERROR_CODES.TIMEOUT, timeoutMessage, {
      endpoint,
      requestId,
      command,
      rawCode: error?.code || null,
    });
  }
  return createError(ERROR_CODES.API, fallbackMessage, {
    endpoint,
    requestId,
    command,
    outputPath: outputPath || null,
    rawCode: error?.code || null,
    exitCode: error?.exitCode ?? null,
    signal: error?.signal || null,
    cause: truncateText(error?.stderr || error?.message || 'unknown'),
  });
};

const probeVideoStreams = async (filePath, requestId, endpoint) => {
  try {
    const result = await runBinaryCommand(FFPROBE_BIN, ['-v', 'error', '-print_format', 'json', '-show_streams', filePath]);
    const parsed = JSON.parse(result.stdout || '{}');
    const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
    const videoStream = streams.find((stream) => stream?.codec_type === 'video') || null;
    const audioStream = streams.find((stream) => stream?.codec_type === 'audio') || null;

    return {
      hasVideo: Boolean(videoStream),
      hasAudio: Boolean(audioStream),
      videoCodec: videoStream?.codec_name || null,
      audioCodec: audioStream?.codec_name || null,
    };
  } catch (error) {
    const normalized = normalizeBinaryError(error, {
      timeoutMessage: 'Timeout ao analisar o vídeo recebido.',
      fallbackMessage: 'Falha ao validar o vídeo recebido.',
      endpoint,
      requestId,
      command: FFPROBE_BIN,
    });
    throw normalized;
  }
};

const transcodeVideoForWhatsapp = async (filePath, requestId, endpoint) => {
  const outputPath = `${filePath}.wa.mp4`;

  try {
    await safeUnlink(outputPath);

    await runBinaryCommand(FFMPEG_BIN, ['-y', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', outputPath], { timeoutMs: VIDEO_PROCESS_TIMEOUT_MS });

    const stats = await fs.promises.stat(outputPath);
    const transcodedBytes = Number(stats?.size || 0);

    if (transcodedBytes <= 0) {
      throw createError(ERROR_CODES.API, 'Falha ao gerar vídeo compatível para envio.', {
        endpoint,
        requestId,
        outputPath,
      });
    }

    if (transcodedBytes > MAX_MEDIA_BYTES) {
      throw createError(ERROR_CODES.TOO_BIG, `O arquivo excede o limite permitido de ${MAX_MEDIA_MB_LABEL} MB.`, {
        endpoint,
        requestId,
        bytes: transcodedBytes,
      });
    }

    await fs.promises.rename(outputPath, filePath);
    return transcodedBytes;
  } catch (error) {
    await safeUnlink(outputPath);
    const normalized = normalizeBinaryError(error, {
      timeoutMessage: 'Timeout ao normalizar o vídeo para envio.',
      fallbackMessage: 'Falha ao converter o vídeo para um formato compatível.',
      endpoint,
      requestId,
      command: FFMPEG_BIN,
      outputPath,
    });
    throw normalized;
  }
};

const resolveHttpModule = (urlObj) => (urlObj.protocol === 'https:' ? https : http);

const shouldFollowRedirect = (status, location, redirectCount, maxRedirects) => status >= 300 && status < 400 && Boolean(location) && redirectCount < maxRedirects;

const readResponseBuffer = async (stream, { maxBytes = Infinity, tooBigMessage } = {}) => {
  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    const current = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += current.length;

    if (Number.isFinite(maxBytes) && total > maxBytes) {
      stream.destroy();
      throw createError(ERROR_CODES.TOO_BIG, tooBigMessage || 'Conteúdo excede o limite permitido.', { bytes: total });
    }

    chunks.push(current);
  }

  return Buffer.concat(chunks, total);
};

const httpRequest = ({ url, timeoutMs = DEFAULT_TIMEOUT_MS, maxRedirects = 0, redirectCount = 0, endpoint = 'unknown', timeoutMessage = 'Timeout na requisição HTTP.', fallbackMessage = 'Falha na requisição HTTP.', onResponse }) =>
  new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const httpModule = resolveHttpModule(urlObj);
    const { signal, cleanup } = createAbortSignal(timeoutMs);

    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const settleResolve = (value) => settle(() => resolve(value));
    const settleReject = (error) => settle(() => reject(error));

    const req = httpModule.request(
      urlObj,
      {
        method: 'GET',
        headers: { Accept: '*/*' },
        signal,
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = getHeaderValue(res.headers, 'location');
        res.on('error', (error) => {
          const normalized = normalizeRequestError(error, {
            timeoutMessage,
            fallbackMessage,
          });
          settleReject(withErrorMeta(normalized, { endpoint, status }));
        });

        if (shouldFollowRedirect(status, location, redirectCount, maxRedirects)) {
          logger.debug('HTTP redirect.', {
            endpoint,
            status,
            location: String(location),
            redirectCount: redirectCount + 1,
          });
          const nextUrl = new URL(String(location), urlObj).toString();
          res.resume();
          settleResolve(
            httpRequest({
              url: nextUrl,
              timeoutMs,
              maxRedirects,
              redirectCount: redirectCount + 1,
              endpoint,
              timeoutMessage,
              fallbackMessage,
              onResponse,
            }),
          );
          return;
        }

        Promise.resolve(
          onResponse({
            res,
            status,
            headers: res.headers,
            endpoint,
            finalUrl: urlObj.toString(),
          }),
        )
          .then(settleResolve)
          .catch((error) => {
            const normalized = normalizeRequestError(error, {
              timeoutMessage,
              fallbackMessage,
            });
            settleReject(withErrorMeta(normalized, { endpoint, status }));
          });
      },
    );

    req.on('error', (error) => {
      const normalized = normalizeRequestError(error, {
        timeoutMessage,
        fallbackMessage,
      });
      settleReject(withErrorMeta(normalized, { endpoint }));
    });

    req.end();
  });

const requestBuffer = async ({ url, timeoutMs = THUMBNAIL_TIMEOUT_MS, maxBytes = MAX_THUMB_BYTES, endpoint = YTDLS_ENDPOINTS.thumbnail }) =>
  httpRequest({
    url,
    timeoutMs,
    endpoint,
    maxRedirects: MAX_REDIRECTS,
    timeoutMessage: 'Timeout ao baixar a thumbnail.',
    fallbackMessage: 'Falha ao baixar a thumbnail.',
    onResponse: async ({ res, status, headers, endpoint: currentEndpoint }) => {
      if (status < 200 || status >= 300) {
        res.resume();
        throw createError(ERROR_CODES.API, 'Falha ao baixar a thumbnail.', {
          endpoint: currentEndpoint,
          status,
        });
      }

      const contentLength = toNumberOrNull(getHeaderValue(headers, 'content-length'));
      if (contentLength !== null && contentLength > maxBytes) {
        res.resume();
        throw createError(ERROR_CODES.TOO_BIG, 'Thumbnail excede o limite permitido.', {
          endpoint: currentEndpoint,
          status,
          bytes: contentLength,
        });
      }

      return readResponseBuffer(res, {
        maxBytes,
        tooBigMessage: 'Thumbnail excede o limite permitido.',
      });
    },
  });

const httpClient = {
  requestBuffer,
};

const isTransientError = (error) => {
  if (!error) return false;
  if (error.code === ERROR_CODES.TIMEOUT) return true;

  const status = toNumberOrNull(error?.meta?.status);
  if (status !== null && TRANSIENT_HTTP_STATUSES.has(status)) return true;

  const rawCode = String(error?.meta?.rawCode || error?.code || '').toUpperCase();
  return TRANSIENT_NETWORK_CODES.has(rawCode);
};

const retryAsync = async (operation, { retries = 0, shouldRetry = () => false, onRetry } = {}) => {
  let attempt = 0;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) {
        throw error;
      }

      attempt += 1;
      if (typeof onRetry === 'function') {
        onRetry(error, attempt);
      }
      await delay(200 * attempt);
    }
  }
};

const searchCache = new Map();

const pruneSearchCache = () => {
  const now = Date.now();
  for (const [key, entry] of searchCache) {
    if (!entry || entry.expiresAt <= now) {
      searchCache.delete(key);
    }
  }

  if (searchCache.size <= MAX_SEARCH_CACHE_ENTRIES) {
    return;
  }

  const ordered = [...searchCache.entries()].sort((a, b) => (a[1]?.createdAt || 0) - (b[1]?.createdAt || 0));
  const toRemove = searchCache.size - MAX_SEARCH_CACHE_ENTRIES;
  for (let i = 0; i < toRemove; i += 1) {
    searchCache.delete(ordered[i][0]);
  }
};

const getSearchCache = (queryKey) => {
  const entry = searchCache.get(queryKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    searchCache.delete(queryKey);
    return null;
  }
  return entry.value;
};

const setSearchCache = (queryKey, value) => {
  const now = Date.now();
  searchCache.set(queryKey, {
    value,
    createdAt: now,
    expiresAt: now + SEARCH_CACHE_TTL_MS,
  });
  pruneSearchCache();
};

let ytDlpInstallPromise = null;

const ensurePlayLocalDirs = async () => {
  await fs.promises.mkdir(PLAY_DOWNLOADS_DIR, { recursive: true });
  await fs.promises.mkdir(path.dirname(YTDLP_BINARY_PATH), { recursive: true });
};

const hasLocalBinary = async () => {
  const mode = os.platform() === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
  try {
    await fs.promises.access(YTDLP_BINARY_PATH, mode);
    return true;
  } catch {
    return false;
  }
};

const ensureYtDlpReady = async () => {
  await ensurePlayLocalDirs();

  if (await hasLocalBinary()) {
    return YTDLP_BINARY_PATH;
  }

  if (!ytDlpInstallPromise) {
    ytDlpInstallPromise = installYtDlpBinary({ binaryPath: YTDLP_BINARY_PATH })
      .then(() => {
        logger.info('yt-dlp instalado para play local.', {
          endpoint: YTDLS_ENDPOINTS.install,
          binaryPath: YTDLP_BINARY_PATH,
        });
      })
      .finally(() => {
        ytDlpInstallPromise = null;
      });
  }

  await ytDlpInstallPromise;
  return YTDLP_BINARY_PATH;
};

const YOUTUBE_AUTH_COOKIE_NAMES = new Set(['SID', 'SSID', 'HSID', 'SAPISID', 'APISID', '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID']);
let warnedInvalidCookiesPath = false;
let warnedMissingCookiesPath = false;
let warnedWeakCookiesPath = false;

const inspectYtDlpCookiesFile = (cookiePath) => {
  try {
    const raw = fs.readFileSync(cookiePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let totalEntries = 0;
    let authCookieCount = 0;
    let hasYoutubeDomain = false;
    let hasGoogleDomain = false;

    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      totalEntries += 1;

      const domain = String(parts[0] || '').toLowerCase();
      const cookieName = String(parts[5] || '').trim();
      if (domain.includes('youtube.com')) hasYoutubeDomain = true;
      if (domain.includes('google.com')) hasGoogleDomain = true;
      if (YOUTUBE_AUTH_COOKIE_NAMES.has(cookieName)) authCookieCount += 1;
    }

    return {
      ok: true,
      totalEntries,
      authCookieCount,
      hasYoutubeDomain,
      hasGoogleDomain,
      isLikelyAuthenticated: totalEntries > 0 && authCookieCount > 0 && hasYoutubeDomain,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'unknown',
      totalEntries: 0,
      authCookieCount: 0,
      hasYoutubeDomain: false,
      hasGoogleDomain: false,
      isLikelyAuthenticated: false,
    };
  }
};

const resolveYtDlpCookiesPath = () => {
  const configuredPath = (process.env.PLAY_YTDLP_COOKIES_PATH || '').trim();
  const rawCookiePath = configuredPath || DEFAULT_COOKIES_PATH;

  if (!rawCookiePath) return null;
  const cookiePath = path.isAbsolute(rawCookiePath) ? rawCookiePath : path.resolve(PROJECT_ROOT_DIR, rawCookiePath);
  if (!fs.existsSync(cookiePath)) {
    if (!warnedMissingCookiesPath) {
      warnedMissingCookiesPath = true;
      logger.warn('Play local: arquivo de cookies configurado não encontrado.', {
        endpoint: YTDLS_ENDPOINTS.download,
        cookiePath,
        configuredPath: Boolean(configuredPath),
      });
    }
    return null;
  }

  const cookiesDiagnostics = inspectYtDlpCookiesFile(cookiePath);
  if (!cookiesDiagnostics.ok && !warnedInvalidCookiesPath) {
    warnedInvalidCookiesPath = true;
    logger.warn('Play local: falha ao ler arquivo de cookies do yt-dlp.', {
      endpoint: YTDLS_ENDPOINTS.download,
      cookiePath,
      cause: cookiesDiagnostics.error,
    });
  } else if (cookiesDiagnostics.ok && !cookiesDiagnostics.isLikelyAuthenticated && !warnedWeakCookiesPath) {
    warnedWeakCookiesPath = true;
    logger.warn('Play local: cookies carregados, mas parecem incompletos para autenticação no YouTube.', {
      endpoint: YTDLS_ENDPOINTS.download,
      cookiePath,
      totalEntries: cookiesDiagnostics.totalEntries,
      authCookieCount: cookiesDiagnostics.authCookieCount,
      hasYoutubeDomain: cookiesDiagnostics.hasYoutubeDomain,
      hasGoogleDomain: cookiesDiagnostics.hasGoogleDomain,
    });
  }

  return cookiePath;
};

const buildYtDlpArgsBase = () => {
  const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--js-runtimes', 'node', '--extractor-args', 'youtube:player_client=android,web'];
  const cookiesPath = resolveYtDlpCookiesPath();
  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  } else if (YTDLP_COOKIES_FROM_BROWSER) {
    args.push('--cookies-from-browser', YTDLP_COOKIES_FROM_BROWSER);
  }
  return args;
};

const parseJsonOutput = (stdout) => {
  const text = String(stdout || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.startsWith('{') && !line.startsWith('[')) continue;
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
  }

  return null;
};

const normalizeYoutubeWatchUrl = (value) => {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = ensureHttpUrl(trimmed);
  if (direct) return direct;

  if (/^[a-zA-Z0-9_-]{6,}$/.test(trimmed)) {
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }

  return null;
};

const extractYtDlpEntry = (payload) => {
  if (!payload || typeof payload !== 'object') return null;

  if (Array.isArray(payload.entries)) {
    const first = payload.entries.find((entry) => entry && typeof entry === 'object');
    if (first) return first;
  }

  return payload;
};

const normalizeResolvedVideoInfo = (entry, fallbackUrl = null) => {
  if (!entry || typeof entry !== 'object') return null;

  const resolvedUrl = normalizeYoutubeWatchUrl(entry.webpage_url) || normalizeYoutubeWatchUrl(entry.original_url) || normalizeYoutubeWatchUrl(entry.url) || normalizeYoutubeWatchUrl(entry.id) || normalizeYoutubeWatchUrl(fallbackUrl);

  return {
    ...entry,
    id: pickFirstString(entry, ['id', 'video_id', 'videoId']),
    title: pickFirstString(entry, ['title', 'fulltitle', 'name']) || 'Sem título',
    channel: pickFirstString(entry, ['channel', 'uploader', 'uploader_id', 'uploader_name']),
    uploader: pickFirstString(entry, ['uploader', 'channel', 'uploader_name']),
    duration: toNumberOrNull(entry.duration) ?? entry.duration ?? null,
    thumbnail: pickFirstString(entry, ['thumbnail']) || null,
    thumbnails: Array.isArray(entry.thumbnails) ? entry.thumbnails : [],
    url: resolvedUrl,
    webpage_url: resolvedUrl || entry.webpage_url || null,
  };
};

const normalizeYtDlpError = (error, { endpoint, requestId, input, timeoutMessage, fallbackMessage }) => {
  if (KNOWN_ERROR_CODES.has(error?.code) && error?.message) return error;

  const stderr = String(error?.stderr || '').trim();
  const stdout = String(error?.stdout || '').trim();
  const combined = `${stderr}\n${stdout}\n${error?.message || ''}`.trim();
  const low = combined.toLowerCase();

  if (error?.code === 'ETIMEDOUT') {
    return createError(ERROR_CODES.TIMEOUT, timeoutMessage, {
      endpoint,
      requestId,
      input: truncateText(input || ''),
      rawCode: error?.code || null,
    });
  }

  if (low.includes('no matches found') || low.includes('unsupported url')) {
    return createError(ERROR_CODES.NOT_FOUND, 'Nenhum resultado encontrado para a busca.', {
      endpoint,
      requestId,
      input: truncateText(input || ''),
      cause: truncateText(combined),
      rawCode: error?.code || null,
    });
  }

  if (low.includes('sign in to confirm') || low.includes('private video') || low.includes('video unavailable')) {
    return createError(ERROR_CODES.API, 'Não foi possível acessar este vídeo agora. Tente outro link.', {
      endpoint,
      requestId,
      input: truncateText(input || ''),
      cause: truncateText(combined),
      rawCode: error?.code || null,
    });
  }

  if (low.includes('ffmpeg') && low.includes('not found')) {
    return createError(ERROR_CODES.API, 'ffmpeg não encontrado no servidor para processar esta mídia.', {
      endpoint,
      requestId,
      input: truncateText(input || ''),
      cause: truncateText(combined),
      rawCode: error?.code || null,
    });
  }

  return createError(ERROR_CODES.API, fallbackMessage, {
    endpoint,
    requestId,
    input: truncateText(input || ''),
    rawCode: error?.code || null,
    exitCode: error?.exitCode ?? null,
    signal: error?.signal || null,
    cause: truncateText(combined || 'unknown'),
  });
};

const isRequestedFormatUnavailableError = (error) => {
  const stderr = String(error?.stderr || '').trim();
  const stdout = String(error?.stdout || '').trim();
  const message = String(error?.message || '').trim();
  const combined = `${stderr}\n${stdout}\n${message}`.toLowerCase();
  return combined.includes('requested format is not available');
};

const runYtDlp = async ({ args, endpoint, requestId, input, timeoutMs = DEFAULT_TIMEOUT_MS, timeoutMessage, fallbackMessage }) => {
  const binaryPath = await ensureYtDlpReady();

  try {
    return await runBinaryCommand(binaryPath, args, { timeoutMs });
  } catch (error) {
    throw normalizeYtDlpError(error, {
      endpoint,
      requestId,
      input,
      timeoutMessage: timeoutMessage || 'Timeout ao processar mídia com yt-dlp.',
      fallbackMessage: fallbackMessage || 'Falha ao processar mídia com yt-dlp.',
    });
  }
};

const fetchSearchResult = async (query) => {
  const normalized = typeof query === 'string' ? query.trim() : '';
  if (!normalized) {
    throw createError(ERROR_CODES.INVALID_INPUT, 'Você precisa informar um link do YouTube ou termo de busca.', { endpoint: YTDLS_ENDPOINTS.search });
  }

  const cacheKey = normalized.toLowerCase();
  const cached = getSearchCache(cacheKey);
  if (cached) {
    return cached;
  }

  const endpoint = YTDLS_ENDPOINTS.search;
  const isUrlLookup = /^https?:\/\//i.test(normalized);
  const lookup = isUrlLookup ? normalized : `ytsearch${MAX_SEARCH_RESULTS}:${normalized}`;

  const payload = await retryAsync(
    async () => {
      const args = isUrlLookup ? [...buildYtDlpArgsBase(), '--dump-single-json', lookup] : [...buildYtDlpArgsBase(), '--flat-playlist', '--ignore-errors', '--dump-single-json', lookup];

      const { stdout } = await runYtDlp({
        args,
        endpoint,
        input: normalized,
        timeoutMs: YTDLP_INFO_TIMEOUT_MS,
        timeoutMessage: 'Timeout ao buscar metadados do vídeo.',
        fallbackMessage: 'Não foi possível buscar o vídeo agora.',
      });

      const parsed = parseJsonOutput(stdout);
      const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries.filter((entry) => entry && typeof entry === 'object') : [];
      const candidateEntries = isUrlLookup ? [extractYtDlpEntry(parsed)].filter(Boolean) : rawEntries;
      const normalizedEntries = candidateEntries.map((entry) => normalizeResolvedVideoInfo(entry, isUrlLookup ? normalized : null)).filter((entry) => entry?.url);
      const info = normalizedEntries[0] || null;

      if (!info?.url) {
        throw createError(ERROR_CODES.NOT_FOUND, 'Nenhum resultado encontrado para a busca.', { endpoint });
      }

      return {
        sucesso: true,
        resultado: info,
        resultados: normalizedEntries,
      };
    },
    {
      retries: 1,
      shouldRetry: isTransientError,
      onRetry: (error, attempt) => {
        logger.warn('Play busca local: retry acionado.', {
          endpoint,
          attempt,
          code: error?.code,
          status: error?.meta?.status || null,
        });
      },
    },
  );

  setSearchCache(cacheKey, payload);
  return payload;
};

const resolveYoutubeLink = async (query) => {
  const normalized = query ? query.trim() : '';

  if (!normalized) {
    throw createError(ERROR_CODES.INVALID_INPUT, 'Você precisa informar um link do YouTube ou termo de busca.', { endpoint: YTDLS_ENDPOINTS.search });
  }

  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  const searchResult = await fetchSearchResult(normalized);
  if (!searchResult?.resultado?.url) {
    throw createError(ERROR_CODES.NOT_FOUND, 'Nenhum resultado encontrado para a busca.', {
      endpoint: YTDLS_ENDPOINTS.search,
    });
  }

  return searchResult.resultado.url;
};

const resolveYoutubeCandidates = async (query) => {
  const normalized = query ? query.trim() : '';

  if (!normalized) {
    throw createError(ERROR_CODES.INVALID_INPUT, 'Você precisa informar um link do YouTube ou termo de busca.', { endpoint: YTDLS_ENDPOINTS.search });
  }

  if (/^https?:\/\//i.test(normalized)) {
    return [normalized];
  }

  const searchResult = await fetchSearchResult(normalized);
  const urls = [];
  const seen = new Set();

  const pushUrl = (value) => {
    const url = ensureHttpUrl(value);
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  if (searchResult?.resultado?.url) {
    pushUrl(searchResult.resultado.url);
  }

  if (Array.isArray(searchResult?.resultados)) {
    for (const item of searchResult.resultados) {
      pushUrl(item?.url);
    }
  }

  if (!urls.length) {
    throw createError(ERROR_CODES.NOT_FOUND, 'Nenhum resultado encontrado para a busca.', {
      endpoint: YTDLS_ENDPOINTS.search,
    });
  }

  return urls;
};

const isYouTubeBotCheckCause = (error) => {
  const cause = String(error?.meta?.cause || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return cause.includes('sign in to confirm') || message.includes('sign in to confirm');
};

const buildYouTubeBotCheckUserMessage = () => {
  const cookiesPath = resolveYtDlpCookiesPath();
  if (cookiesPath) {
    return 'YouTube solicitou verificação anti-bot. Atualize o arquivo .secrets/cookies.txt e tente novamente.';
  }
  if (YTDLP_COOKIES_FROM_BROWSER) {
    return 'YouTube solicitou verificação anti-bot. Verifique o perfil informado em PLAY_YTDLP_COOKIES_FROM_BROWSER e tente novamente.';
  }
  return 'YouTube solicitou verificação anti-bot. Configure PLAY_YTDLP_COOKIES_PATH com um cookies.txt válido e tente novamente.';
};

const fetchVideoInfo = async (query, fallback) => {
  const tryQuery = async (value) => {
    if (!value) return null;
    try {
      const result = await fetchSearchResult(value);
      if (!result?.sucesso || !result?.resultado) return null;
      return result.resultado;
    } catch {
      return null;
    }
  };

  const first = await tryQuery(query);
  if (first) return first;

  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const normalizedFallback = typeof fallback === 'string' ? fallback.trim().toLowerCase() : '';
  if (normalizedFallback && normalizedFallback !== normalizedQuery) {
    return tryQuery(fallback);
  }

  return null;
};

const fetchQueueStatus = async (requestId) => {
  void requestId;
  return null;
};

const inferMimeFromFilePath = (filePath, type) => {
  const ext = path.extname(filePath || '').toLowerCase();
  if (type === 'audio') {
    if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4';
    if (ext === '.ogg' || ext === '.opus') return 'audio/ogg';
    if (ext === '.wav') return 'audio/wav';
    return TYPE_CONFIG.audio.mimeFallback;
  }

  if (type === 'video') {
    if (ext === '.webm') return 'video/webm';
    return TYPE_CONFIG.video.mimeFallback;
  }

  return 'application/octet-stream';
};

const findDownloadedFileByBase = async (basePath, preferredExt) => {
  const dir = path.dirname(basePath);
  const baseName = path.basename(basePath);

  let entries = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return null;
  }

  const candidates = entries.filter((name) => name.startsWith(`${baseName}.`));
  if (!candidates.length) return null;

  if (preferredExt) {
    const preferred = candidates.find((name) => path.extname(name).toLowerCase() === `.${preferredExt.toLowerCase()}`);
    if (preferred) {
      return path.join(dir, preferred);
    }
  }

  const stats = await Promise.all(
    candidates.map(async (name) => {
      const fullPath = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const existing = stats.filter(Boolean);
  if (!existing.length) return null;

  existing.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return existing[0].fullPath;
};

const cleanupDownloadedArtifacts = async (basePath) => {
  const dir = path.dirname(basePath);
  const baseName = path.basename(basePath);

  let entries = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }

  const targets = entries.filter((name) => name.startsWith(`${baseName}.`));
  await Promise.allSettled(targets.map((name) => safeUnlink(path.join(dir, name))));
};

const requestDownloadToFile = async (link, type, requestId) => {
  const endpoint = YTDLS_ENDPOINTS.download;
  const safeId = String(requestId || 'req')
    .replace(/[^a-z0-9-_]+/gi, '')
    .slice(0, 48);
  const basePath = path.join(PLAY_DOWNLOADS_DIR, `play-${safeId}-${Date.now()}`);
  const outputTemplate = `${basePath}.%(ext)s`;
  const preferredExt = type === 'audio' ? 'mp3' : 'mp4';
  let filePath = null;

  const attemptArgsList =
    type === 'audio'
      ? [
          ['--no-progress', '-o', outputTemplate, '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', link],
          ['--no-progress', '-o', outputTemplate, '-f', 'best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', link],
        ]
      : [
          ['--no-progress', '-o', outputTemplate, '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best', '--merge-output-format', 'mp4', link],
          ['--no-progress', '-o', outputTemplate, '-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4', link],
          ['--no-progress', '-o', outputTemplate, '-f', 'best', '--merge-output-format', 'mp4', link],
        ];

  try {
    let downloadCompleted = false;
    let lastError = null;

    for (let index = 0; index < attemptArgsList.length; index += 1) {
      const attemptArgs = attemptArgsList[index];
      try {
        if (index > 0) {
          await cleanupDownloadedArtifacts(basePath);
        }

        await runYtDlp({
          args: [...buildYtDlpArgsBase(), ...attemptArgs],
          endpoint,
          requestId,
          input: link,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          timeoutMessage: 'Timeout ao baixar o arquivo.',
          fallbackMessage: 'Falha ao baixar o arquivo localmente.',
        });
        downloadCompleted = true;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const shouldRetryWithFallback = isRequestedFormatUnavailableError(error) && index < attemptArgsList.length - 1;

        if (!shouldRetryWithFallback) {
          throw error;
        }

        logger.warn('Play download: formato indisponível, tentando fallback.', {
          requestId,
          endpoint,
          type,
          attempt: index + 1,
          nextAttempt: index + 2,
          code: error?.code || null,
          cause: truncateText(error?.meta?.cause || error?.message || ''),
        });
      }
    }

    if (!downloadCompleted && lastError) {
      throw lastError;
    }

    filePath = await findDownloadedFileByBase(basePath, preferredExt);
    if (!filePath) {
      throw createError(ERROR_CODES.API, 'Não foi possível localizar o arquivo baixado.', {
        endpoint,
        requestId,
      });
    }

    let stat = await fs.promises.stat(filePath);
    let finalBytes = Number(stat?.size || 0);
    let finalMimeType = inferMimeFromFilePath(filePath, type);
    let finalMediaType = type;

    if (finalBytes <= 0) {
      throw createError(ERROR_CODES.API, 'Falha ao baixar mídia válida.', {
        endpoint,
        requestId,
        filePath,
      });
    }

    if (finalBytes > MAX_MEDIA_BYTES) {
      throw createError(ERROR_CODES.TOO_BIG, `O arquivo excede o limite permitido de ${MAX_MEDIA_MB_LABEL} MB.`, {
        endpoint,
        requestId,
        bytes: finalBytes,
      });
    }

    if (type === 'video') {
      const streamInfo = await probeVideoStreams(filePath, requestId, endpoint);

      if (!streamInfo.hasVideo) {
        if (streamInfo.hasAudio) {
          finalMediaType = 'audio';
          finalMimeType = inferMimeFromFilePath(filePath, 'audio');

          logger.warn('Play vídeo: fonte retornou somente áudio, fallback ativado.', {
            requestId,
            endpoint,
            bytes: finalBytes,
            audioCodec: streamInfo.audioCodec || null,
          });
        } else {
          throw createError(ERROR_CODES.API, 'Não foi possível enviar como vídeo: a mídia não possui faixa de vídeo nem áudio.', {
            endpoint,
            requestId,
            hasAudio: streamInfo.hasAudio,
            videoCodec: streamInfo.videoCodec,
            audioCodec: streamInfo.audioCodec,
          });
        }
      }

      if (finalMediaType === 'video') {
        if (VIDEO_FORCE_TRANSCODE || streamInfo.videoCodec !== 'h264' || (streamInfo.hasAudio && streamInfo.audioCodec !== 'aac')) {
          finalBytes = await transcodeVideoForWhatsapp(filePath, requestId, endpoint);
          finalMimeType = TYPE_CONFIG.video.mimeFallback;
          logger.info('Play vídeo normalizado para compatibilidade.', {
            requestId,
            endpoint,
            originalVideoCodec: streamInfo.videoCodec || null,
            originalAudioCodec: streamInfo.audioCodec || null,
            bytes: finalBytes,
          });
        }
      }
    }

    stat = await fs.promises.stat(filePath);
    finalBytes = Number(stat?.size || finalBytes || 0);

    return {
      filePath,
      contentType: finalMimeType || resolveMediaMimeType(finalMediaType, null),
      bytes: finalBytes,
      mediaType: finalMediaType,
    };
  } catch (error) {
    await cleanupDownloadedArtifacts(basePath);
    const normalized =
      KNOWN_ERROR_CODES.has(error?.code) && error?.message
        ? error
        : normalizeYtDlpError(error, {
            endpoint,
            requestId,
            input: link,
            timeoutMessage: 'Timeout ao baixar o arquivo.',
            fallbackMessage: 'Falha ao baixar o arquivo.',
          });
    throw withErrorMeta(normalized, { endpoint, filePath });
  }
};

const fetchThumbnailBuffer = async (url) =>
  retryAsync(
    () =>
      httpClient.requestBuffer({
        url,
        timeoutMs: THUMBNAIL_TIMEOUT_MS,
        maxBytes: MAX_THUMB_BYTES,
        endpoint: YTDLS_ENDPOINTS.thumbnail,
      }),
    {
      retries: 1,
      shouldRetry: isTransientError,
      onRetry: (error, attempt) => {
        logger.warn('Play thumbnail: retry acionado.', {
          endpoint: YTDLS_ENDPOINTS.thumbnail,
          attempt,
          code: error?.code,
          status: error?.meta?.status || null,
        });
      },
    },
  );

const ytdlsClient = {
  resolveYoutubeLink,
  resolveYoutubeCandidates,
  resolveYtDlpCookiesPath,
  fetchVideoInfo,
  fetchQueueStatus,
  requestDownloadToFile,
  fetchThumbnailBuffer,
};

const formatters = {
  formatNumber,
  formatDuration,
  formatVideoInfo,
  getThumbnailUrl,
  buildQueueStatusText,
  buildReadyCaption,
};

const fileUtils = {
  buildTempFilePath,
  safeUnlink,
};

export {
  createError,
  withErrorMeta,
  normalizePlayError,
  truncateText,
  ytdlsClient,
  formatters,
  fileUtils,
  isYouTubeBotCheckCause,
  buildYouTubeBotCheckUserMessage,
};
