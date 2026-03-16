import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import axios from 'axios';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

import logger from '#logger';
import { sendAndStore } from '../../services/messaging/messagePersistenceService.js';
import { getTikTokUsageText } from './tiktokConfigRuntime.js';

const DEFAULT_COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';
const TIKTOK_EXTRACT_BASE_URL = (process.env.TIKTOK_EXTRACT_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const TIKTOK_EXTRACT_PATH = process.env.TIKTOK_EXTRACT_PATH || '/extract';
const TIKTOK_EXTRACT_TIMEOUT_SECONDS = Number.parseInt(process.env.TIKTOK_EXTRACT_TIMEOUT_SECONDS || '60', 10);
const TIKTOK_HTTP_TIMEOUT_MS = Number.parseInt(process.env.TIKTOK_HTTP_TIMEOUT_MS || '120000', 10);
const TIKTOK_MAX_MB = Number.parseInt(process.env.TIKTOK_MAX_MB || '80', 10);
const TIKTOK_MAX_BYTES = Number.isFinite(TIKTOK_MAX_MB) ? TIKTOK_MAX_MB * 1024 * 1024 : 80 * 1024 * 1024;
const TIKTOK_MAX_URLS_PER_COMMAND = Number.parseInt(process.env.TIKTOK_MAX_URLS_PER_COMMAND || '5', 10);
const TIKTOK_MAX_IMAGES_PER_POST = Number.parseInt(process.env.TIKTOK_MAX_IMAGES_PER_POST || '10', 10);
const CAPTION_MAX_CHARS = 950;

const TEMP_DIR = path.join(os.tmpdir(), 'omnizap-tiktok');
const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;
const IMAGE_PATH_HINTS = ['image', 'images', 'img', 'photo', 'photos', 'pic', 'pics', 'slide', 'slideshow', 'gallery', 'carousel', 'album'];
const ALBUM_KIND_HINTS = ['slide', 'album', 'image', 'images', 'photo', 'carousel'];
const TIKTOK_HOSTNAME = 'tiktok.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const truncate = (value, maxChars) => {
  const text = `${value || ''}`.trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
};

const toPositiveInt = (value, fallback) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

const sanitizeUrlToken = (value) => `${value || ''}`.trim().replace(/[),.;!?]+$/g, '');

const isHttpUrl = (value) => {
  if (!value || typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const isTikTokUrl = (value) => {
  if (!isHttpUrl(value)) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === TIKTOK_HOSTNAME || host.endsWith(`.${TIKTOK_HOSTNAME}`);
  } catch {
    return false;
  }
};

const extractUrlsFromText = (text) => {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(URL_REGEX) || [];
  return matches.map(sanitizeUrlToken).filter(Boolean);
};

const resolveUrl = (value, baseUrl) => {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
};

const formatStat = (value) => {
  const numeric = toNumberOrNull(value);
  if (numeric === null) return '0';
  return numeric.toLocaleString('pt-BR');
};

const pickFirst = (...candidates) => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
};

const buildCaption = ({ requestedUrl, video, tiktok, mediaType = 'video' }) => {
  const author = pickFirst(video?.author_name, tiktok?.username) || 'Desconhecido';
  const username = pickFirst(tiktok?.username, video?.author_name);
  const description = truncate(video?.description || 'Sem descrição.', 480);
  const likes = formatStat(video?.stats?.likes);
  const comments = formatStat(video?.stats?.comments);
  const shares = formatStat(video?.stats?.shares);
  const title = mediaType === 'images' ? "┏━〔 🖼️ TikTok Imagens Sem Marca d'Água 〕━⬣" : "┏━〔 🎬 TikTok Sem Marca d'Água 〕━⬣";

  const lines = [title, `┃ 👤 Autor: *${author}*`, username ? `┃ 🆔 Perfil: *@${username.replace(/^@+/, '')}*` : null, `┃ ❤️ Curtidas: *${likes}*`, `┃ 💬 Comentários: *${comments}*`, `┃ 🔁 Compart.: *${shares}*`, '┗━━━━━━━━━━━━━━━⬣', '', '📝 *Descrição*', description, '', `🔗 ${requestedUrl}`].filter(Boolean);

  return truncate(lines.join('\n'), CAPTION_MAX_CHARS);
};

const ensureTempDir = async () => {
  await fsp.mkdir(TEMP_DIR, { recursive: true });
};

const safeUnlink = async (filePath) => {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    logger.warn('tiktok: falha ao remover arquivo temporário.', {
      filePath,
      error: error?.message || 'erro desconhecido',
    });
  }
};

const buildTempFilePath = () => path.join(TEMP_DIR, `tiktok-${__timeNowMs()}-${randomUUID()}.mp4`);

const requestExtract = async (videoUrl) => {
  const endpoint = `${TIKTOK_EXTRACT_BASE_URL}${TIKTOK_EXTRACT_PATH.startsWith('/') ? TIKTOK_EXTRACT_PATH : `/${TIKTOK_EXTRACT_PATH}`}`;
  const { data } = await axios.get(endpoint, {
    params: {
      url: videoUrl,
      timeout_seconds: TIKTOK_EXTRACT_TIMEOUT_SECONDS,
    },
    timeout: TIKTOK_HTTP_TIMEOUT_MS,
    headers: HEADERS,
  });
  return data;
};

const collectInputUrls = ({ text, messageInfo }) => {
  const urls = new Set();
  const sources = [];

  if (typeof text === 'string' && text.trim()) sources.push(text);

  const rawMessage = messageInfo?.message;
  if (rawMessage) {
    try {
      const serialized = JSON.stringify(rawMessage);
      if (serialized) sources.push(serialized);
    } catch (error) {
      logger.warn('tiktok: não foi possível serializar mensagem para extração de URLs.', {
        error: error?.message || 'erro desconhecido',
      });
    }
  }

  for (const source of sources) {
    for (const candidate of extractUrlsFromText(source)) {
      if (!isTikTokUrl(candidate)) continue;
      urls.add(candidate);
    }
  }

  return [...urls];
};

const collectDownloadCandidates = (payload) => {
  const pageUrl = payload?.page?.url || TIKTOK_EXTRACT_BASE_URL;
  const hd = payload?.download_buttons?.without_watermark_hd;
  const noWm = payload?.download_buttons?.without_watermark;
  const preferred = payload?.preferred_download;

  const candidates = [
    { kind: 'without_watermark', url: resolveUrl(noWm?.url, pageUrl), isHd: false },
    {
      kind: preferred?.kind || 'preferred_download',
      url: resolveUrl(preferred?.url, pageUrl),
      isHd: `${preferred?.kind || ''}`.toLowerCase().includes('hd'),
    },
    { kind: 'without_watermark_hd', url: resolveUrl(hd?.url, pageUrl), isHd: true },
    { kind: 'without_watermark_hd', url: resolveUrl(hd?.data_directurl, pageUrl), isHd: true },
  ];

  const dedupe = new Set();
  return candidates
    .filter((candidate) => candidate.url && isHttpUrl(candidate.url))
    .filter((candidate) => {
      if (dedupe.has(candidate.url)) return false;
      dedupe.add(candidate.url);
      return true;
    });
};

const isAlbumKind = (value) => {
  const normalized = `${value || ''}`.trim().toLowerCase();
  if (!normalized) return false;
  return ALBUM_KIND_HINTS.some((hint) => normalized.includes(hint));
};

const normalizeUrlList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string');
  if (typeof value === 'string') return [value];
  return [];
};

const collectAlbumImageCandidates = (payload) => {
  const pageUrl = payload?.page?.url || TIKTOK_EXTRACT_BASE_URL;
  const preferredKind = payload?.preferred_download?.kind;
  const postType = payload?.tiktok?.post_type;
  const dedupe = new Set();
  const collected = [];

  const append = (rawList) => {
    for (const rawUrl of normalizeUrlList(rawList)) {
      const resolved = resolveUrl(rawUrl, pageUrl);
      if (!resolved || !isHttpUrl(resolved)) continue;
      if (dedupe.has(resolved)) continue;
      dedupe.add(resolved);
      collected.push(resolved);
    }
  };

  append(payload?.album?.slide_download_urls);
  append(payload?.album?.slide_image_urls);
  append(payload?.album?.images);

  if (isAlbumKind(preferredKind) || isAlbumKind(postType)) {
    append(payload?.preferred_download?.url);
    append(payload?.download_buttons?.slide?.url);
    append(payload?.download_buttons?.slide?.data_directurl);
  }

  return collected;
};

const isAlbumPayload = (payload) => {
  const albumCount = toPositiveInt(payload?.album?.count, 0);
  const slideImageCount = normalizeUrlList(payload?.album?.slide_image_urls).length;
  const slideDownloadCount = normalizeUrlList(payload?.album?.slide_download_urls).length;
  const preferredKind = payload?.preferred_download?.kind;
  const postType = payload?.tiktok?.post_type;
  const slideButtonAvailable = Boolean(payload?.download_buttons?.slide?.available);

  return albumCount > 0 || slideImageCount > 0 || slideDownloadCount > 0 || isAlbumKind(preferredKind) || isAlbumKind(postType) || slideButtonAvailable;
};

const hasImagePathHint = (pathSegments) => {
  if (!Array.isArray(pathSegments) || !pathSegments.length) return false;
  return pathSegments.some((segment) => IMAGE_PATH_HINTS.some((hint) => segment.includes(hint)));
};

const isLikelyImageUrl = (value) => {
  if (!value || typeof value !== 'string') return false;
  return /(\.jpe?g|\.png|\.webp|\.gif|\.bmp|\.avif|\.heic)(\?|$)/i.test(value) || /[?&]format=(jpg|jpeg|png|webp|gif)\b/i.test(value);
};

const collectImageCandidates = (payload) => {
  const pageUrl = payload?.page?.url || TIKTOK_EXTRACT_BASE_URL;
  const urls = new Set();
  const visited = new WeakSet();

  const walk = (value, pathSegments = []) => {
    if (value === null || value === undefined) return;

    if (typeof value === 'string') {
      const resolved = resolveUrl(value, pageUrl);
      const pathHint = hasImagePathHint(pathSegments);
      const looksLikeImage = isLikelyImageUrl(resolved);
      const joinedPath = pathSegments.join('.');
      const isAvatarPath = /(avatar|thumbnail|thumb|profile)/i.test(joinedPath);
      if (resolved && !isAvatarPath && (pathHint || looksLikeImage)) {
        urls.add(resolved);
      }
      return;
    }

    if (typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, [...pathSegments, String(index)]));
      return;
    }

    for (const [key, entry] of Object.entries(value)) {
      walk(entry, [...pathSegments, key.toLowerCase()]);
    }
  };

  walk(payload, []);

  const filtered = [...urls].filter((url) => {
    const normalized = `${url}`.toLowerCase();
    if (normalized.includes('/ssstik/m/')) return false;
    if (normalized.includes('.mp3')) return false;
    return true;
  });

  return filtered;
};

const sendImageCollection = async ({ sock, remoteJid, messageInfo, expirationMessage, imageUrls, caption }) => {
  const maxImages = toPositiveInt(TIKTOK_MAX_IMAGES_PER_POST, 10);
  const selected = imageUrls.slice(0, maxImages);
  const skipped = Math.max(0, imageUrls.length - selected.length);
  let sent = 0;

  for (let index = 0; index < selected.length; index += 1) {
    const imageUrl = selected[index];
    const indexLabel = `🖼️ Imagem ${index + 1}/${selected.length}`;
    const firstCaption = skipped > 0 ? `${caption}\n\n${indexLabel}\n⚠️ Mostrando ${selected.length}/${imageUrls.length} imagens.` : `${caption}\n\n${indexLabel}`;

    try {
      await sendAndStore(
        sock,
        remoteJid,
        {
          image: { url: imageUrl },
          caption: index === 0 ? firstCaption : indexLabel,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );
      sent += 1;
    } catch (error) {
      logger.warn('tiktok: falha ao enviar imagem do carrossel.', {
        remoteJid,
        index: index + 1,
        total: selected.length,
        error: truncate(error?.message || 'erro desconhecido', 240),
      });
    }
  }

  if (sent <= 0) {
    throw new Error('Falha ao enviar imagens do TikTok.');
  }

  return { sent, skipped, totalDetected: imageUrls.length };
};

const downloadToTempFile = async (url) => {
  await ensureTempDir();
  const filePath = buildTempFilePath();
  const writer = fs.createWriteStream(filePath);
  let totalBytes = 0;

  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: TIKTOK_HTTP_TIMEOUT_MS,
      maxRedirects: 5,
      headers: HEADERS,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const contentType = `${response.headers?.['content-type'] || ''}`.toLowerCase();
    const looksLikeMedia = !contentType || contentType.includes('video') || contentType.includes('octet-stream') || contentType.includes('mp4');
    if (!looksLikeMedia) {
      throw new Error(`Content-Type inválido para vídeo: ${contentType || 'desconhecido'}`);
    }

    const contentLength = toNumberOrNull(response.headers?.['content-length']);
    if (contentLength !== null && contentLength > TIKTOK_MAX_BYTES) {
      throw new Error(`Arquivo excede o limite de ${TIKTOK_MAX_MB}MB.`);
    }

    await new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > TIKTOK_MAX_BYTES) {
          const error = new Error(`Arquivo excede o limite de ${TIKTOK_MAX_MB}MB.`);
          response.data.destroy(error);
          reject(error);
        }
      });

      response.data.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
      response.data.pipe(writer);
    });

    if (totalBytes <= 0) {
      throw new Error('Download vazio.');
    }

    return {
      filePath,
      bytes: totalBytes,
      contentType: response.headers?.['content-type'] || 'video/mp4',
    };
  } catch (error) {
    await safeUnlink(filePath);
    throw error;
  }
};

const tryDownloadCandidates = async (candidates) => {
  const failures = [];

  for (const candidate of candidates) {
    try {
      const result = await downloadToTempFile(candidate.url);
      return {
        ...result,
        selectedUrl: candidate.url,
        selectedKind: candidate.kind,
        isHd: candidate.isHd,
      };
    } catch (error) {
      failures.push({
        kind: candidate.kind,
        url: candidate.url,
        error: error?.message || 'falha desconhecida',
      });
    }
  }

  const detailed = failures.map((failure) => `[${failure.kind}] ${failure.error}`).join('; ');
  throw new Error(detailed || 'Nenhum link de download disponível.');
};

const trySendDirectCandidates = async ({ sock, remoteJid, messageInfo, expirationMessage, caption, candidates }) => {
  const failures = [];

  for (const candidate of candidates) {
    try {
      await sendAndStore(
        sock,
        remoteJid,
        {
          video: { url: candidate.url },
          mimetype: 'video/mp4',
          caption,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );

      return {
        delivery: 'direct',
        selectedUrl: candidate.url,
        selectedKind: candidate.kind,
        isHd: candidate.isHd,
      };
    } catch (error) {
      failures.push({
        kind: candidate.kind,
        url: candidate.url,
        error: error?.message || 'falha desconhecida',
      });
    }
  }

  const detailed = failures.map((failure) => `[${failure.kind}] ${failure.error}`).join('; ');
  throw new Error(detailed || 'Falha no envio direto por URL.');
};

const sendUsage = async ({ sock, remoteJid, messageInfo, expirationMessage, commandPrefix }) =>
  sendAndStore(
    sock,
    remoteJid,
    {
      text: [getTikTokUsageText('tiktok', { commandPrefix }) || '', '', '✅ Suporta múltiplos links e posts de imagem (carrossel).'].filter(Boolean).join('\n'),
    },
    { quoted: messageInfo, ephemeralExpiration: expirationMessage },
  );

const processTikTokUrl = async ({ sock, remoteJid, messageInfo, expirationMessage, inputUrl }) => {
  let tempFilePath = null;
  try {
    const payload = await requestExtract(inputUrl);

    if (!payload?.ok) {
      const reason = truncate(payload?.error || payload?.message || 'A API não retornou um download válido.', 220);
      throw new Error(reason);
    }

    const requestedUrl = payload?.requested_url || inputUrl;
    const albumPost = isAlbumPayload(payload);
    if (albumPost) {
      const albumCandidates = collectAlbumImageCandidates(payload);
      const imageCandidates = albumCandidates.length > 0 ? albumCandidates : collectImageCandidates(payload);
      if (!imageCandidates.length) {
        throw new Error('A API indicou álbum de imagens, mas não retornou URLs válidas.');
      }

      const imageCaption = buildCaption({
        requestedUrl,
        video: payload?.video || {},
        tiktok: payload?.tiktok || {},
        mediaType: 'images',
      });

      const imageResult = await sendImageCollection({
        sock,
        remoteJid,
        messageInfo,
        expirationMessage,
        imageUrls: imageCandidates,
        caption: imageCaption,
      });

      return {
        mediaType: 'images',
        requestedUrl,
        imageCount: imageResult.sent,
      };
    }

    const candidates = collectDownloadCandidates(payload);
    if (!candidates.length) {
      const imageCandidates = collectImageCandidates(payload);
      if (imageCandidates.length > 0) {
        const imageCaption = buildCaption({
          requestedUrl,
          video: payload?.video || {},
          tiktok: payload?.tiktok || {},
          mediaType: 'images',
        });

        const imageResult = await sendImageCollection({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          imageUrls: imageCandidates,
          caption: imageCaption,
        });

        return {
          mediaType: 'images',
          requestedUrl,
          imageCount: imageResult.sent,
        };
      }

      throw new Error('Não encontrei links de download no retorno da API.');
    }

    const caption = buildCaption({
      requestedUrl,
      video: payload?.video || {},
      tiktok: payload?.tiktok || {},
      mediaType: 'video',
    });

    let deliveryResult = null;
    try {
      deliveryResult = await trySendDirectCandidates({
        sock,
        remoteJid,
        messageInfo,
        expirationMessage,
        caption,
        candidates,
      });
    } catch (directError) {
      logger.warn('tiktok: envio direto falhou, aplicando fallback com download local.', {
        remoteJid,
        error: truncate(directError?.message || 'erro desconhecido', 300),
      });

      const download = await tryDownloadCandidates(candidates);
      tempFilePath = download.filePath;

      await sendAndStore(
        sock,
        remoteJid,
        {
          video: { url: tempFilePath },
          mimetype: download.contentType || 'video/mp4',
          caption,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );

      deliveryResult = {
        delivery: 'local',
        selectedUrl: download.selectedUrl,
        selectedKind: download.selectedKind,
        isHd: download.isHd,
        bytes: download.bytes,
      };
    }

    logger.info('tiktok: vídeo enviado com sucesso.', {
      remoteJid,
      delivery: deliveryResult?.delivery || 'unknown',
      isHd: Boolean(deliveryResult?.isHd),
      selectedKind: deliveryResult?.selectedKind || null,
      bytes: deliveryResult?.bytes || null,
      source: payload?.source || null,
      requestedUrl,
    });

    return {
      mediaType: 'video',
      requestedUrl,
      delivery: deliveryResult?.delivery || 'unknown',
    };
  } finally {
    await safeUnlink(tempFilePath);
  }
};

export async function handleTikTokCommand({ sock, remoteJid, messageInfo, expirationMessage, text, commandPrefix = DEFAULT_COMMAND_PREFIX }) {
  const inputUrls = collectInputUrls({ text, messageInfo });
  if (!inputUrls.length) {
    await sendUsage({ sock, remoteJid, messageInfo, expirationMessage, commandPrefix });
    return;
  }

  const maxUrls = toPositiveInt(TIKTOK_MAX_URLS_PER_COMMAND, 5);
  const urls = inputUrls.slice(0, maxUrls);
  const ignoredCount = Math.max(0, inputUrls.length - urls.length);

  try {
    const startText = urls.length === 1 ? "⏳ Baixando TikTok sem marca d'água, aguarde..." : `⏳ Processando ${urls.length} links do TikTok...`;

    await sendAndStore(
      sock,
      remoteJid,
      {
        text: ignoredCount > 0 ? `${startText}\n⚠️ Limite por comando: ${maxUrls}. Ignorados: ${ignoredCount}.` : startText,
      },
      { quoted: messageInfo, ephemeralExpiration: expirationMessage },
    );

    const failures = [];
    let deliveredCount = 0;
    let videosSent = 0;
    let imagesSent = 0;

    for (let index = 0; index < urls.length; index += 1) {
      const currentUrl = urls[index];
      try {
        const result = await processTikTokUrl({
          sock,
          remoteJid,
          messageInfo,
          expirationMessage,
          inputUrl: currentUrl,
        });

        deliveredCount += 1;
        if (result?.mediaType === 'images') {
          imagesSent += 1;
        } else {
          videosSent += 1;
        }
      } catch (error) {
        failures.push({
          url: currentUrl,
          error: truncate(error?.message || 'erro desconhecido', 200),
        });
        logger.warn('tiktok: falha em item da fila.', {
          remoteJid,
          index: index + 1,
          total: urls.length,
          url: currentUrl,
          error: error?.message || 'erro desconhecido',
        });
      }
    }

    if (urls.length === 1 && deliveredCount <= 0) {
      throw new Error(failures[0]?.error || 'Nenhum link foi processado com sucesso.');
    }

    if (urls.length > 1) {
      if (deliveredCount <= 0) {
        const failureDetails = failures
          .slice(0, 3)
          .map((item, index) => `${index + 1}. ${item.error}`)
          .join('\n');
        throw new Error(failureDetails || 'Nenhum link foi processado com sucesso.');
      }

      const summaryLines = ['✅ Processamento do TikTok concluído.', `• Itens enviados: ${deliveredCount}/${urls.length}`, `• Vídeos: ${videosSent}`, `• Posts de imagem: ${imagesSent}`];

      if (failures.length > 0) {
        summaryLines.push(`• Falhas: ${failures.length}`);
      }

      await sendAndStore(sock, remoteJid, { text: summaryLines.join('\n') }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    }
  } catch (error) {
    logger.error('tiktok: falha ao processar comando.', {
      remoteJid,
      error: error?.message || 'erro desconhecido',
      requestedText: truncate(text, 400),
    });

    await sendAndStore(
      sock,
      remoteJid,
      {
        text: ['❌ Não consegui baixar esse TikTok agora.', '', `Motivo: ${truncate(error?.message || 'falha desconhecida', 240)}`].join('\n'),
      },
      { quoted: messageInfo, ephemeralExpiration: expirationMessage },
    );
  }
}
