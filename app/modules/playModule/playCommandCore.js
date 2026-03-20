import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import crypto from 'node:crypto';
import logger from '#logger';
import { sendAndStore } from '../../services/messaging/messagePersistenceService.js';
import { getAdminJid } from '../../config/index.js';
import { getPlayOperationalLimits, getPlayText, getPlayUsageFallbackText, getPlayUsageText, getPlayWaitText } from './playConfigRuntime.js';
import { DEFAULT_COMMAND_PREFIX, ERROR_CODES, KNOWN_ERROR_CODES, TYPE_CONFIG, YTDLS_ENDPOINTS } from './playCommandConstants.js';
import { createError, withErrorMeta, normalizePlayError, truncateText, playMediaClient, formatters, fileUtils, isYouTubeBotCheckCause, buildYouTubeBotCheckUserMessage } from './playCommandMediaClient.js';

const adminJid = getAdminJid();
const adminAlertDedupCache = new Map();

export { DEFAULT_COMMAND_PREFIX };

const buildRequestId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${__timeNowMs()}-${Math.random().toString(16).slice(2)}`;
};

const isTechnicalError = (error) => Boolean(error?.meta?.technical);

const getUserErrorMessage = (error) => {
  const genericError = getPlayText('generic_error', 'Erro inesperado ao processar sua solicitação.');
  if (isTechnicalError(error)) {
    if (error?.code === ERROR_CODES.TIMEOUT) {
      return getPlayText('user_error_timeout', 'A operação demorou mais que o esperado. Tente novamente.');
    }
    return getPlayText('user_error_technical_generic', 'Não foi possível processar sua solicitação agora. Tente novamente em instantes.');
  }
  if (!error) return genericError;
  if (KNOWN_ERROR_CODES.has(error?.code) && error?.message) return error.message;
  return genericError;
};

const buildAdminFailureText = (error, context = {}) => {
  const adminTitle = getPlayText('admin_error_title', 'Erro no módulo play (diagnóstico).');
  const cause = truncateText(error?.meta?.cause || error?.stack || error?.message || '', 1200);
  const lines = [adminTitle, `Chat: ${context?.remoteJid || 'n/a'}`, `Request: ${context?.requestId || error?.meta?.requestId || 'n/a'}`, `Tipo: ${context?.type || error?.meta?.type || 'n/a'}`, `Code: ${error?.code || 'n/a'}`, `Endpoint: ${error?.meta?.endpoint || 'n/a'}`, `Status: ${error?.meta?.status || 'n/a'}`, `RawCode: ${error?.meta?.rawCode || 'n/a'}`, `ExitCode: ${error?.meta?.exitCode ?? 'n/a'}`, `Signal: ${error?.meta?.signal || 'n/a'}`, `Input: ${truncateText(error?.meta?.input || '', 300) || 'n/a'}`, `FilePath: ${error?.meta?.filePath || 'n/a'}`, `Mensagem usuário: ${getUserErrorMessage(error)}`, `Causa técnica: ${cause || 'n/a'}`];
  return lines.join('\n');
};

const buildAdminAlertDedupKey = (error, context = {}) => {
  const causeKey = truncateText(error?.meta?.cause || error?.message || '', 160);
  return [context?.type || error?.meta?.type || 'n/a', error?.code || 'n/a', error?.meta?.endpoint || 'n/a', error?.meta?.status || 'n/a', error?.meta?.rawCode || 'n/a', causeKey || 'n/a'].join('|');
};

const pruneAdminAlertDedupCache = (nowMs, dedupeWindowMs) => {
  const maxAge = Math.max(60_000, dedupeWindowMs * 2);
  for (const [key, timestamp] of adminAlertDedupCache.entries()) {
    if (!Number.isFinite(timestamp) || nowMs - timestamp > maxAge) {
      adminAlertDedupCache.delete(key);
    }
  }
};

const shouldNotifyAdminAlert = (error, context = {}) => {
  if (!adminJid) return false;
  if (!isTechnicalError(error)) return false;

  const limits = getPlayOperationalLimits();
  const dedupeWindowMs = Number(limits?.admin_alert_dedupe_window_ms ?? 120000);
  if (!Number.isFinite(dedupeWindowMs) || dedupeWindowMs <= 0) {
    return true;
  }

  const nowMs = __timeNowMs();
  const dedupeKey = buildAdminAlertDedupKey(error, context);
  const lastSentAt = adminAlertDedupCache.get(dedupeKey);
  if (Number.isFinite(lastSentAt) && nowMs - lastSentAt < dedupeWindowMs) {
    return false;
  }

  adminAlertDedupCache.set(dedupeKey, nowMs);
  pruneAdminAlertDedupCache(nowMs, dedupeWindowMs);
  return true;
};

const resetAdminAlertDedupCacheForTests = () => {
  adminAlertDedupCache.clear();
};

const notifyFailure = async (sock, remoteJid, messageInfo, expirationMessage, error, context) => {
  const errorMessage = getUserErrorMessage(error);
  const errorPrefix = getPlayText('error_prefix', '❌ Erro: ');

  await sendAndStore(sock, remoteJid, { text: `${errorPrefix}${errorMessage}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });

  if (shouldNotifyAdminAlert(error, context)) {
    await sendAndStore(sock, adminJid, {
      text: buildAdminFailureText(error, { ...(context || {}), remoteJid }),
    });
  }
};

const processPlayRequest = async ({ sock, remoteJid, messageInfo, expirationMessage, text, type }) => {
  const startTime = __timeNowMs();
  const requestId = buildRequestId();
  const config = TYPE_CONFIG[type];

  if (!config) {
    throw createError(ERROR_CODES.INVALID_INPUT, getPlayText('invalid_media_type', 'Tipo de mídia inválido.'), { technical: false });
  }

  logger.info('Play request iniciado.', {
    requestId,
    remoteJid,
    type,
    elapsedMs: 0,
  });

  let filePath = null;

  try {
    const candidateLinks = await playMediaClient.resolveYoutubeCandidates(text);
    await sendAndStore(sock, remoteJid, { text: getPlayWaitText(type) || config.waitText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });

    let downloadResult = null;
    let videoInfo = null;
    let selectedLink = null;
    let lastDownloadError = null;

    for (let index = 0; index < candidateLinks.length; index += 1) {
      const candidateLink = candidateLinks[index];
      selectedLink = candidateLink;
      try {
        [downloadResult, videoInfo] = await Promise.all([playMediaClient.requestDownloadToFile(candidateLink, type, requestId), playMediaClient.fetchVideoInfo(candidateLink, text)]);
        lastDownloadError = null;
        break;
      } catch (error) {
        lastDownloadError = error;
        if (isYouTubeBotCheckCause(error)) {
          logger.warn('Play download: bloqueio anti-bot detectado; abortando novas tentativas de candidato.', {
            requestId,
            remoteJid,
            type,
            endpoint: error?.meta?.endpoint || YTDLS_ENDPOINTS.download,
            attempt: index + 1,
            candidateLink,
            cause: truncateText(error?.meta?.cause || error?.message || ''),
          });
          throw withErrorMeta(createError(ERROR_CODES.API, buildYouTubeBotCheckUserMessage()), {
            endpoint: error?.meta?.endpoint || YTDLS_ENDPOINTS.download,
            cause: error?.meta?.cause || error?.message || '',
            technical: false,
          });
        }

        const hasNextCandidate = index < candidateLinks.length - 1;
        if (!hasNextCandidate) {
          throw error;
        }
      }
    }

    if (!downloadResult) {
      throw (
        lastDownloadError ||
        createError(ERROR_CODES.API, getPlayText('download_failed', 'Falha ao baixar o arquivo localmente.'), {
          endpoint: YTDLS_ENDPOINTS.download,
          requestId,
          technical: true,
        })
      );
    }

    filePath = downloadResult.filePath;
    const deliveredType = downloadResult.mediaType || type;
    const deliveredConfig = TYPE_CONFIG[deliveredType] || config;
    const fallbackToAudio = type === 'video' && deliveredType === 'audio';

    logger.info('Play download concluído.', {
      requestId,
      remoteJid,
      type,
      deliveredType,
      fallbackToAudio,
      endpoint: YTDLS_ENDPOINTS.download,
      selectedLink: selectedLink || null,
      elapsedMs: __timeNowMs() - startTime,
      bytes: downloadResult.bytes || 0,
    });

    if (fallbackToAudio) {
      await sendAndStore(sock, remoteJid, { text: getPlayText('video_fallback_to_audio', '⚠️ Este link retornou somente áudio. Enviando no formato de áudio.') }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    }

    if (deliveredType === 'audio') {
      const infoText = formatters.formatVideoInfo(videoInfo);
      const caption = formatters.buildReadyCaption(deliveredType, infoText);
      const thumbUrl = formatters.getThumbnailUrl(videoInfo);
      let thumbBuffer = null;
      let previewDelivered = false;

      if (thumbUrl) {
        try {
          thumbBuffer = await playMediaClient.fetchThumbnailBuffer(thumbUrl);
        } catch (error) {
          logger.warn('Falha ao baixar thumbnail.', {
            requestId,
            remoteJid,
            type: deliveredType,
            requestedType: type,
            endpoint: error?.meta?.endpoint || YTDLS_ENDPOINTS.thumbnail,
            status: error?.meta?.status || null,
            code: error?.code,
            error: truncateText(error?.message || ''),
            elapsedMs: __timeNowMs() - startTime,
          });
        }
      }

      if (thumbBuffer) {
        try {
          await sendAndStore(sock, remoteJid, { image: thumbBuffer, caption }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
          previewDelivered = true;
        } catch (error) {
          logger.warn('Falha ao enviar thumbnail de áudio.', {
            requestId,
            remoteJid,
            type: deliveredType,
            requestedType: type,
            code: error?.code || null,
            error: truncateText(error?.message || ''),
            elapsedMs: __timeNowMs() - startTime,
          });
        }
      }

      if (!previewDelivered && caption) {
        try {
          await sendAndStore(sock, remoteJid, { text: caption }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        } catch (error) {
          logger.warn('Falha ao enviar preview textual do áudio.', {
            requestId,
            remoteJid,
            type: deliveredType,
            requestedType: type,
            code: error?.code || null,
            error: truncateText(error?.message || ''),
            elapsedMs: __timeNowMs() - startTime,
          });
        }
      }

      await sendAndStore(
        sock,
        remoteJid,
        {
          audio: { url: filePath },
          mimetype: downloadResult.contentType || deliveredConfig.mimeFallback,
          ptt: false,
        },
        { quoted: messageInfo, ephemeralExpiration: expirationMessage },
      );

      logger.info('Play áudio enviado.', {
        requestId,
        remoteJid,
        type: deliveredType,
        requestedType: type,
        fallbackToAudio,
        bytes: downloadResult.bytes || 0,
        elapsedMs: __timeNowMs() - startTime,
      });

      return;
    }

    const infoText = formatters.formatVideoInfo(videoInfo);
    const caption = formatters.buildReadyCaption(deliveredType, infoText);

    await sendAndStore(
      sock,
      remoteJid,
      {
        video: { url: filePath },
        mimetype: downloadResult.contentType || deliveredConfig.mimeFallback,
        caption,
      },
      { quoted: messageInfo, ephemeralExpiration: expirationMessage },
    );

    logger.info('Play vídeo enviado.', {
      requestId,
      remoteJid,
      type: deliveredType,
      requestedType: type,
      bytes: downloadResult.bytes || 0,
      elapsedMs: __timeNowMs() - startTime,
    });
  } catch (error) {
    if (!filePath && error?.meta?.filePath) {
      filePath = error.meta.filePath;
    }

    const normalizedError = withErrorMeta(normalizePlayError(error), {
      requestId,
      remoteJid,
      type,
    });

    logger.error('Play falhou.', {
      requestId,
      remoteJid,
      type,
      endpoint: normalizedError?.meta?.endpoint || null,
      status: normalizedError?.meta?.status || null,
      elapsedMs: __timeNowMs() - startTime,
      error: truncateText(normalizedError.message || ''),
      cause: truncateText(normalizedError?.meta?.cause || ''),
      code: normalizedError.code,
    });

    throw normalizedError;
  } finally {
    await fileUtils.safeUnlink(filePath);
  }
};

const playService = {
  processPlayRequest,
};

const resolveCommandNameByType = (type) => (type === 'audio' ? 'play' : 'playvid');

export const handleTypedPlayCommand = async ({ sock, remoteJid, messageInfo, expirationMessage, text, commandPrefix, type }) => {
  try {
    if (!text?.trim()) {
      const commandName = resolveCommandNameByType(type);
      const usageText = getPlayUsageText(commandName, { commandPrefix }) || getPlayUsageFallbackText(type, commandPrefix);

      await sendAndStore(sock, remoteJid, { text: usageText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      return;
    }

    await playService.processPlayRequest({
      sock,
      remoteJid,
      messageInfo,
      expirationMessage,
      text,
      type,
    });
  } catch (error) {
    await notifyFailure(sock, remoteJid, messageInfo, expirationMessage, error, {
      type,
      requestId: error?.meta?.requestId,
    });
  }
};

export const __playCommandCoreTestUtils = {
  isTechnicalError,
  getUserErrorMessage,
  buildAdminFailureText,
  shouldNotifyAdminAlert,
  resetAdminAlertDedupCacheForTests,
  notifyFailure,
};
