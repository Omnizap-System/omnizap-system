import crypto from 'node:crypto';
import logger from '#logger';
import { sendAndStore } from '../../services/messaging/messagePersistenceService.js';
import { getAdminJid } from '../../config/index.js';
import { getPlayUsageText } from './playConfigRuntime.js';
import { DEFAULT_COMMAND_PREFIX, ERROR_CODES, KNOWN_ERROR_CODES, TYPE_CONFIG, YTDLS_ENDPOINTS } from './playCommandConstants.js';
import {
  createError,
  withErrorMeta,
  normalizePlayError,
  truncateText,
  ytdlsClient,
  formatters,
  fileUtils,
  isYouTubeBotCheckCause,
  buildYouTubeBotCheckUserMessage,
} from './playCommandYtDlpClient.js';

const adminJid = getAdminJid();

export { DEFAULT_COMMAND_PREFIX };

const buildRequestId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const getUserErrorMessage = (error) => {
  if (!error) return 'Erro inesperado ao processar sua solicitação.';
  if (KNOWN_ERROR_CODES.has(error?.code) && error?.message) return error.message;
  return 'Erro inesperado ao processar sua solicitação.';
};

const notifyFailure = async (sock, remoteJid, messageInfo, expirationMessage, error, context) => {
  const errorMessage = getUserErrorMessage(error);

  await sendAndStore(sock, remoteJid, { text: `❌ Erro: ${errorMessage}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });

  if (adminJid) {
    await sendAndStore(sock, adminJid, {
      text: `Erro no módulo play.\nChat: ${remoteJid}\nRequest: ${context?.requestId || 'n/a'}\nTipo: ${context?.type || 'n/a'}\nEndpoint: ${error?.meta?.endpoint || 'n/a'}\nStatus: ${error?.meta?.status || 'n/a'}\nErro: ${errorMessage}\nCode: ${error?.code || 'n/a'}`,
    });
  }
};

const processPlayRequest = async ({ sock, remoteJid, messageInfo, expirationMessage, text, type }) => {
  const startTime = Date.now();
  const requestId = buildRequestId();
  const config = TYPE_CONFIG[type];

  if (!config) {
    throw createError(ERROR_CODES.INVALID_INPUT, 'Tipo de mídia inválido.');
  }

  logger.info('Play request iniciado.', {
    requestId,
    remoteJid,
    type,
    elapsedMs: 0,
  });

  let filePath = null;

  try {
    const candidateLinks = await ytdlsClient.resolveYoutubeCandidates(text);
    await sendAndStore(sock, remoteJid, { text: config.waitText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });

    let downloadResult = null;
    let videoInfo = null;
    let selectedLink = null;
    let lastDownloadError = null;

    for (let index = 0; index < candidateLinks.length; index += 1) {
      const candidateLink = candidateLinks[index];
      selectedLink = candidateLink;
      try {
        [downloadResult, videoInfo] = await Promise.all([ytdlsClient.requestDownloadToFile(candidateLink, type, requestId), ytdlsClient.fetchVideoInfo(candidateLink, text)]);
        lastDownloadError = null;
        break;
      } catch (error) {
        lastDownloadError = error;
        if (isYouTubeBotCheckCause(error)) {
          const cookiesPath = ytdlsClient.resolveYtDlpCookiesPath();
          logger.warn('Play download: bloqueio anti-bot detectado; abortando novas tentativas de candidato.', {
            requestId,
            remoteJid,
            type,
            endpoint: error?.meta?.endpoint || YTDLS_ENDPOINTS.download,
            attempt: index + 1,
            candidateLink,
            cookiesPath: cookiesPath || null,
            cause: truncateText(error?.meta?.cause || error?.message || ''),
          });
          throw withErrorMeta(createError(ERROR_CODES.API, buildYouTubeBotCheckUserMessage()), {
            endpoint: error?.meta?.endpoint || YTDLS_ENDPOINTS.download,
            cause: error?.meta?.cause || error?.message || '',
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
        createError(ERROR_CODES.API, 'Falha ao baixar o arquivo localmente.', {
          endpoint: YTDLS_ENDPOINTS.download,
          requestId,
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
      elapsedMs: Date.now() - startTime,
      bytes: downloadResult.bytes || 0,
    });

    if (fallbackToAudio) {
      await sendAndStore(sock, remoteJid, { text: '⚠️ Este link retornou somente áudio. Enviando no formato de áudio.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    }

    if (deliveredType === 'audio') {
      const infoText = formatters.formatVideoInfo(videoInfo);
      const caption = formatters.buildReadyCaption(deliveredType, infoText);
      const thumbUrl = formatters.getThumbnailUrl(videoInfo);
      let thumbBuffer = null;
      let previewDelivered = false;

      if (thumbUrl) {
        try {
          thumbBuffer = await ytdlsClient.fetchThumbnailBuffer(thumbUrl);
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
            elapsedMs: Date.now() - startTime,
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
            elapsedMs: Date.now() - startTime,
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
            elapsedMs: Date.now() - startTime,
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
        elapsedMs: Date.now() - startTime,
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
      elapsedMs: Date.now() - startTime,
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
      elapsedMs: Date.now() - startTime,
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
      const usageText =
        getPlayUsageText(commandName, { commandPrefix }) ||
        (type === 'audio' ? `🎵 Uso: ${commandPrefix}play <link do YouTube ou termo de busca>` : `🎬 Uso: ${commandPrefix}playvid <link do YouTube ou termo de busca>`);

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
