import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { baileysConnectionLogger as logger } from './loggerConfig.js';
import { queueMessageInsert } from '../services/infra/dbWriteQueue.js';
import { parseEnvBool, parseEnvInt, normalizeJid, isGroupJid, isStatusJid, isBroadcastJid, isNewsletterJid, normalizeWAPresence } from './baileysConfig.js';
import { getOwner as getGroupOwner, tryAcquire as tryAcquireGroupOwner } from '../services/multiSession/groupOwnershipService.js';

const BAILEYS_SEND_RETRY_ATTEMPTS = parseEnvInt(process.env.BAILEYS_SEND_RETRY_ATTEMPTS, 2, 1, 5);
const BAILEYS_SEND_RETRY_BASE_DELAY_MS = parseEnvInt(process.env.BAILEYS_SEND_RETRY_BASE_DELAY_MS, 600, 100, 10_000);
const BAILEYS_SEND_MEDIA_UPLOAD_TIMEOUT_MS = parseEnvInt(process.env.BAILEYS_SEND_MEDIA_UPLOAD_TIMEOUT_MS, 0, 0, 120_000);
const BAILEYS_REPLY_PRESENCE_ENABLED = parseEnvBool(process.env.BAILEYS_REPLY_PRESENCE_ENABLED, true);
const BAILEYS_REPLY_PRESENCE_SUBSCRIBE = parseEnvBool(process.env.BAILEYS_REPLY_PRESENCE_SUBSCRIBE, true);
const BAILEYS_REPLY_PRESENCE_DELAY_MS = parseEnvInt(process.env.BAILEYS_REPLY_PRESENCE_DELAY_MS, 280, 0, 3_000);
const BAILEYS_REPLY_PRESENCE_BEFORE = normalizeWAPresence(process.env.BAILEYS_REPLY_PRESENCE_BEFORE, 'composing');
const BAILEYS_REPLY_PRESENCE_AFTER = normalizeWAPresence(process.env.BAILEYS_REPLY_PRESENCE_AFTER, 'paused');
const GROUP_WRITE_PERMISSION_CACHE_TTL_MS = parseEnvInt(process.env.GROUP_OWNER_WRITE_CACHE_TTL_MS, 8_000, 1_000, 60_000);

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';

const ANY_MESSAGE_CONTENT_PRIMARY_KEYS = new Set(['text', 'image', 'video', 'audio', 'sticker', 'stickerPack', 'stickerPackMessage', 'document', 'event', 'poll', 'contacts', 'location', 'react', 'buttonReply', 'groupInvite', 'listReply', 'pin', 'product', 'sharePhoneNumber', 'requestPhoneNumber', 'forward', 'delete', 'disappearingMessagesInChat', 'limitSharing']);
const PRESENCE_NON_REPLY_CONTENT_KEYS = new Set(['react', 'delete', 'pin', 'disappearingMessagesInChat']);
const groupWritePermissionCache = new Map();

const normalizeSessionId = (value) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const getCachedGroupWritePermission = (groupJid, sessionId) => {
  const key = `${sessionId}:${groupJid}`;
  const cached = groupWritePermissionCache.get(key);
  if (!cached) return null;
  if (cached.expiresAtMs <= __timeNowMs()) {
    groupWritePermissionCache.delete(key);
    return null;
  }
  return cached;
};

const setCachedGroupWritePermission = (groupJid, sessionId, allowed, ownerSessionId = null) => {
  const key = `${sessionId}:${groupJid}`;
  groupWritePermissionCache.set(key, {
    allowed: Boolean(allowed),
    ownerSessionId: normalizeSessionId(ownerSessionId),
    expiresAtMs: __timeNowMs() + GROUP_WRITE_PERMISSION_CACHE_TTL_MS,
  });
};

const resolveGroupWritePermission = async (groupJid, sessionId) => {
  if (!isGroupJid(groupJid) || !sessionId) {
    return {
      allowed: true,
      ownerSessionId: null,
      reason: 'not_group_or_missing_session',
    };
  }

  const cached = getCachedGroupWritePermission(groupJid, sessionId);
  if (cached) {
    return {
      allowed: cached.allowed,
      ownerSessionId: cached.ownerSessionId,
      reason: 'cache_hit',
    };
  }

  try {
    const ownerState = await getGroupOwner(groupJid);
    let ownerSessionId = normalizeSessionId(ownerState?.ownerSessionId);
    let allowed = false;
    let reason = 'owned_by_other';

    if (!ownerSessionId) {
      const claimOutcome = await tryAcquireGroupOwner({
        groupJid,
        sessionId,
        reason: 'send_store_claim',
        changedBy: sessionId,
        metadata: {
          source: 'message_persistence_service',
          gate: 'group_write',
        },
      });
      ownerSessionId = normalizeSessionId(claimOutcome?.owner?.ownerSessionId);
      allowed = Boolean(claimOutcome?.acquired && ownerSessionId === sessionId);
      reason = claimOutcome?.reason || 'claim_attempt';
    } else {
      allowed = ownerSessionId === sessionId;
      reason = allowed ? 'owner_match' : 'owned_by_other';
    }

    setCachedGroupWritePermission(groupJid, sessionId, allowed, ownerSessionId);
    return {
      allowed,
      ownerSessionId,
      reason,
    };
  } catch (error) {
    logger.warn('Falha ao validar ownership para persistência de saída em grupo.', {
      action: 'group_write_permission_resolution_failed',
      groupJid,
      sessionId,
      error: error?.message,
    });
    return {
      allowed: false,
      ownerSessionId: null,
      reason: 'resolution_failed',
    };
  }
};

/**
 * Verifica se o payload se parece com AnyMessageContent do Baileys.
 * @param {unknown} content
 * @returns {boolean}
 */
const hasKnownAnyMessageContentShape = (content) => {
  if (!isPlainObject(content)) return false;
  return Object.keys(content).some((key) => ANY_MESSAGE_CONTENT_PRIMARY_KEYS.has(key));
};

/**
 * Normaliza opções de envio aceitas pelo Baileys (MiscMessageGenerationOptions).
 * @param {unknown} options
 * @returns {import('@whiskeysockets/baileys').MiscMessageGenerationOptions|undefined}
 */
const normalizeSendOptions = (options) => {
  if (!isPlainObject(options)) return undefined;

  const normalized = { ...options };

  if (typeof normalized.messageId === 'string') {
    const trimmedMessageId = normalized.messageId.trim();
    if (trimmedMessageId) {
      normalized.messageId = trimmedMessageId;
    } else {
      delete normalized.messageId;
    }
  }

  if (typeof normalized.mediaUploadTimeoutMs !== 'number' && BAILEYS_SEND_MEDIA_UPLOAD_TIMEOUT_MS > 0) {
    normalized.mediaUploadTimeoutMs = BAILEYS_SEND_MEDIA_UPLOAD_TIMEOUT_MS;
  }

  if (normalized.statusJidList !== undefined && !Array.isArray(normalized.statusJidList)) {
    delete normalized.statusJidList;
  }

  return normalized;
};

/**
 * Separa opções internas de presença das opções reais de envio do Baileys.
 * @param {unknown} options
 * @returns {{
 *   sendOptions: import('@whiskeysockets/baileys').MiscMessageGenerationOptions|undefined,
 *   sessionId: string | null,
 *   allowGroupWrite: boolean | undefined,
 *   skipPresenceUpdate: boolean,
 *   presenceBefore: import('@whiskeysockets/baileys').WAPresence,
 *   presenceAfter: import('@whiskeysockets/baileys').WAPresence,
 *   presenceDelayMs: number,
 *   presenceSubscribe: boolean
 * }}
 */
const resolveRuntimeSendOptions = (options) => {
  if (!isPlainObject(options)) {
    return {
      sendOptions: undefined,
      sessionId: null,
      allowGroupWrite: undefined,
      skipPresenceUpdate: false,
      presenceBefore: BAILEYS_REPLY_PRESENCE_BEFORE,
      presenceAfter: BAILEYS_REPLY_PRESENCE_AFTER,
      presenceDelayMs: BAILEYS_REPLY_PRESENCE_DELAY_MS,
      presenceSubscribe: BAILEYS_REPLY_PRESENCE_SUBSCRIBE,
    };
  }

  const { skipPresenceUpdate, presenceBefore, presenceAfter, presenceDelayMs, presenceSubscribe, sessionId, allowGroupWrite, ...sendOptions } = options;
  const normalizedDelay = parseEnvInt(presenceDelayMs, BAILEYS_REPLY_PRESENCE_DELAY_MS, 0, 3_000);
  return {
    sendOptions: Object.keys(sendOptions).length > 0 ? sendOptions : undefined,
    sessionId: normalizeSessionId(sessionId),
    allowGroupWrite: typeof allowGroupWrite === 'boolean' ? allowGroupWrite : undefined,
    skipPresenceUpdate: Boolean(skipPresenceUpdate),
    presenceBefore: normalizeWAPresence(presenceBefore, BAILEYS_REPLY_PRESENCE_BEFORE),
    presenceAfter: normalizeWAPresence(presenceAfter, BAILEYS_REPLY_PRESENCE_AFTER),
    presenceDelayMs: normalizedDelay,
    presenceSubscribe: typeof presenceSubscribe === 'boolean' ? presenceSubscribe : BAILEYS_REPLY_PRESENCE_SUBSCRIBE,
  };
};

/**
 * Indica se o conteúdo é uma resposta "normal" (texto/mídia) que merece presença.
 * @param {unknown} content
 * @returns {boolean}
 */
const shouldApplyPresenceByContent = (content) => {
  if (!isPlainObject(content)) return false;
  const keys = Object.keys(content);
  if (keys.length === 0) return false;
  return !keys.every((key) => PRESENCE_NON_REPLY_CONTENT_KEYS.has(key));
};

/**
 * Resolve se a presença deve ser enviada para este envio.
 * @param {string} jid
 * @param {unknown} content
 * @param {{skipPresenceUpdate: boolean}} runtimeOptions
 * @returns {boolean}
 */
const shouldSendReplyPresence = (jid, content, runtimeOptions) => {
  if (!BAILEYS_REPLY_PRESENCE_ENABLED) return false;
  if (runtimeOptions.skipPresenceUpdate) return false;
  if (!shouldApplyPresenceByContent(content)) return false;

  const normalizedJid = normalizeJid(jid) || String(jid || '').trim();
  if (!normalizedJid) return false;
  if (isGroupJid(normalizedJid)) return false;
  if (isStatusJid(normalizedJid)) return false;
  if (isBroadcastJid(normalizedJid)) return false;
  if (isNewsletterJid(normalizedJid)) return false;

  return true;
};

const sendPresenceSilently = async (sock, type, jid, subscribeFirst = false) => {
  if (!sock || typeof sock.sendPresenceUpdate !== 'function') return;
  try {
    if (subscribeFirst && typeof sock.presenceSubscribe === 'function') {
      await sock.presenceSubscribe(jid);
    }
    await sock.sendPresenceUpdate(type, jid);
  } catch (error) {
    logger.debug('Falha ao enviar atualização de presença no Baileys.', {
      jid,
      presence: type,
      error: error?.message,
    });
  }
};

/**
 * Converte um timestamp da mensagem para ms com fallback seguro.
 * @param {import('@whiskeysockets/baileys').WAMessage} msg
 * @returns {number}
 */
const resolveMessageTimestampMs = (msg) => {
  const rawTimestamp = msg?.messageTimestamp;
  if (rawTimestamp !== null && rawTimestamp !== undefined) {
    const tsNumber = typeof rawTimestamp === 'number' ? rawTimestamp : Number(rawTimestamp);
    if (Number.isFinite(tsNumber) && tsNumber > 0) {
      return tsNumber * 1000;
    }
  }
  return __timeNowMs();
};

/**
 * Normaliza uma mensagem do Baileys para o formato persistido no banco.
 * @param {import('@whiskeysockets/baileys').WAMessage} msg - Mensagem recebida/enviada.
 * @param {string} [senderId] - ID do remetente (opcional).
 * @param {string|null} [sessionId] - Sessão lógica para persistência.
 * @returns {Object} Objeto com dados prontos para persistencia.
 */
export const buildMessageData = (msg, senderId, sessionId = null) => ({
  session_id: normalizeSessionId(sessionId),
  message_id: msg?.key?.id,
  chat_id: msg?.key?.remoteJid,
  sender_id: senderId || msg?.key?.participant || msg?.key?.remoteJid,
  content: msg?.message?.conversation || msg?.message?.extendedTextMessage?.text || null,
  raw_message: msg || {},
  timestamp: new Date(resolveMessageTimestampMs(msg)),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const isTransientSendError = (error) => {
  const statusCode = Number(error?.output?.statusCode || error?.statusCode || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(statusCode)) return true;

  const code = String(error?.code || '')
    .trim()
    .toUpperCase();
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_SOCKET_CLOSED', 'ERR_NETWORK'].includes(code)) {
    return true;
  }

  const rawMessage = `${error?.message || ''} ${error?.data?.message || ''}`.toLowerCase();
  const transientFragments = ['timeout', 'timed out', 'connection closed', 'socket closed', 'media conn', 'media_conn', 'fetch failed', 'temporarily unavailable', 'network'];
  return transientFragments.some((fragment) => rawMessage.includes(fragment));
};

const shouldRefreshMediaConnection = (error) => {
  const rawMessage = `${error?.message || ''} ${error?.data?.message || ''}`.toLowerCase();
  return rawMessage.includes('media') || rawMessage.includes('directpath') || rawMessage.includes('upload');
};

/**
 * Envia uma mensagem via Baileys e persiste imediatamente o retorno.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid
 * @param {import('@whiskeysockets/baileys').AnyMessageContent} content
 * @param {import('@whiskeysockets/baileys').MiscMessageGenerationOptions & {
 *   skipPresenceUpdate?: boolean,
 *   presenceBefore?: import('@whiskeysockets/baileys').WAPresence,
 *   presenceAfter?: import('@whiskeysockets/baileys').WAPresence,
 *   presenceDelayMs?: number,
 *   presenceSubscribe?: boolean
 * }} [options]
 * @returns {Promise<import('@whiskeysockets/baileys').WAMessage|undefined>}
 */
export async function sendAndStore(sock, jid, content, options) {
  if (!sock || typeof sock.sendMessage !== 'function') {
    throw new TypeError('Socket Baileys inválido: sendMessage indisponível.');
  }

  if (!jid || typeof jid !== 'string') {
    throw new TypeError('JID inválido para envio de mensagem.');
  }

  if (!hasKnownAnyMessageContentShape(content)) {
    const payloadKeys = isPlainObject(content) ? Object.keys(content).slice(0, 10) : [];
    throw new TypeError(`Payload de mensagem inválido. Chaves recebidas: ${payloadKeys.join(', ') || 'nenhuma'}`);
  }

  const normalizedJid = normalizeJid(jid) || String(jid).trim();
  const runtimeOptions = resolveRuntimeSendOptions(options);
  const runtimeSessionId = runtimeOptions.sessionId || normalizeSessionId(sock?.__omnizapSessionId);
  let resolvedGroupWritePermission = null;

  if (isGroupJid(normalizedJid)) {
    if (runtimeOptions.allowGroupWrite === false) {
      logger.debug('Envio para grupo ignorado por bloqueio explícito de escrita.', {
        action: 'send_group_blocked_explicit',
        groupJid: normalizedJid,
        sessionId: runtimeSessionId,
      });
      return undefined;
    }

    if (runtimeOptions.allowGroupWrite === true) {
      resolvedGroupWritePermission = {
        allowed: true,
        ownerSessionId: runtimeSessionId,
        reason: 'explicit_allow',
      };
    } else {
      resolvedGroupWritePermission = await resolveGroupWritePermission(normalizedJid, runtimeSessionId);
      if (!resolvedGroupWritePermission.allowed) {
        logger.info('Envio para grupo bloqueado por sessão não-owner.', {
          action: 'send_group_blocked_non_owner',
          groupJid: normalizedJid,
          sessionId: runtimeSessionId,
          ownerSessionId: resolvedGroupWritePermission.ownerSessionId,
          reason: resolvedGroupWritePermission.reason,
        });
        return undefined;
      }
    }
  }

  const normalizedOptions = normalizeSendOptions(runtimeOptions.sendOptions);
  const shouldSendPresence = shouldSendReplyPresence(normalizedJid, content, runtimeOptions);

  if (shouldSendPresence) {
    await sendPresenceSilently(sock, runtimeOptions.presenceBefore, normalizedJid, runtimeOptions.presenceSubscribe);
    if (runtimeOptions.presenceDelayMs > 0) {
      await wait(runtimeOptions.presenceDelayMs);
    }
  }

  let attempt = 0;
  let sent;
  let lastError;

  try {
    while (attempt < BAILEYS_SEND_RETRY_ATTEMPTS) {
      attempt += 1;
      try {
        sent = await sock.sendMessage(normalizedJid, content, normalizedOptions);
        break;
      } catch (error) {
        lastError = error;
        const shouldRetry = attempt < BAILEYS_SEND_RETRY_ATTEMPTS && isTransientSendError(error);
        if (!shouldRetry) {
          throw error;
        }

        if (shouldRefreshMediaConnection(error) && typeof sock?.refreshMediaConn === 'function') {
          try {
            await sock.refreshMediaConn(true);
          } catch (refreshError) {
            logger.debug('Falha ao forçar refresh de mediaConn antes do retry.', {
              error: refreshError?.message,
              attempt,
              jid: normalizedJid,
            });
          }
        }

        const delayMs = BAILEYS_SEND_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn('Falha transitória ao enviar mensagem; novo retry agendado.', {
          attempt,
          maxAttempts: BAILEYS_SEND_RETRY_ATTEMPTS,
          delayMs,
          jid: normalizedJid,
          code: error?.code || null,
          statusCode: error?.output?.statusCode || error?.statusCode || null,
          error: error?.message,
        });
        await wait(delayMs);
      }
    }
  } finally {
    if (shouldSendPresence) {
      await sendPresenceSilently(sock, runtimeOptions.presenceAfter, normalizedJid, false);
    }
  }

  if (!sent) {
    throw lastError || new Error('Falha ao enviar mensagem: resultado vazio.');
  }

  const senderId = sock?.user?.id || sent?.key?.participant;
  if (sent?.key?.id) {
    try {
      const messageData = buildMessageData(sent, senderId, runtimeSessionId);
      const targetGroupJid = normalizeJid(messageData.chat_id || normalizedJid);
      if (isGroupJid(targetGroupJid)) {
        const allowGroupWrite = runtimeOptions.allowGroupWrite === true || resolvedGroupWritePermission?.allowed === true;
        messageData.allow_group_write = allowGroupWrite;
      }
      queueMessageInsert(messageData);
    } catch (error) {
      logger.warn('Falha ao enfileirar mensagem enviada para persistencia.', {
        error: error.message,
        messageId: sent?.key?.id,
        remoteJid: sent?.key?.remoteJid,
      });
    }
  }

  return sent;
}
