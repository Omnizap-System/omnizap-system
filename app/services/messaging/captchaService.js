import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { getJidUser } from '../../config/index.js';
import { isUserAdmin, updateGroupParticipants } from '../../config/index.js';
import { extractUserIdInfo, resolveUserId, resolveUserIdCached } from '../../config/index.js';
import { sendAndStore } from './messagePersistenceService.js';
import { getActiveSocket } from '../../config/index.js';

export const CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;
export const CAPTCHA_TIMEOUT_MINUTES = 5;
const CAPTCHA_OK_EMOJI = process.env.CAPTCHA_OK_EMOJI || '✅';

const pendingCaptchas = new Map();
const captchaMessageState = new Map();
const NON_HUMAN_CAPTCHA_MESSAGE_TEXTS = new Set(['Mensagem vazia', 'Tipo de mensagem não suportado ou sem conteúdo.', '[Histórico de mensagens]', '[Aviso de histórico de mensagens]']);

const buildMessageStateKey = (groupId, messageId) => `${groupId}:${messageId}`;
const normalizeMessageText = (messageText) => (typeof messageText === 'string' ? messageText.trim() : '');
const hasMessageStubType = (messageInfo) => messageInfo?.messageStubType !== undefined && messageInfo?.messageStubType !== null;

const resolveMessagePayload = (messageInfo) => {
  const payload = messageInfo?.message;
  if (!payload || typeof payload !== 'object') return null;

  if (payload.deviceSentMessage?.message && typeof payload.deviceSentMessage.message === 'object') {
    return payload.deviceSentMessage.message;
  }

  return payload;
};

const isHumanCaptchaMessage = ({ messageInfo, extractedText }) => {
  const normalizedText = normalizeMessageText(extractedText);
  if (!normalizedText || NON_HUMAN_CAPTCHA_MESSAGE_TEXTS.has(normalizedText)) {
    return false;
  }

  if (!messageInfo || typeof messageInfo !== 'object' || hasMessageStubType(messageInfo)) {
    return false;
  }

  const payload = resolveMessagePayload(messageInfo);
  if (!payload) return false;

  if (payload.protocolMessage || payload.messageHistoryBundle || payload.messageHistoryNotice || payload.fastRatchetKeySenderKeyDistributionMessage) {
    return false;
  }

  return true;
};

const toNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const appendCandidate = (set, value) => {
  const normalized = toNonEmptyString(value);
  if (normalized) {
    set.add(normalized);
  }
};

const buildUserIdCandidates = (...sources) => {
  const candidateIds = new Set();

  for (const source of sources) {
    if (!source) continue;
    const info = extractUserIdInfo(source);
    appendCandidate(candidateIds, resolveUserIdCached(info));
    appendCandidate(candidateIds, info.jid);
    appendCandidate(candidateIds, info.lid);
    appendCandidate(candidateIds, info.participantAlt);
    appendCandidate(candidateIds, info.raw);

    if (typeof source === 'object') {
      appendCandidate(candidateIds, source.id);
      appendCandidate(candidateIds, source.jid);
      appendCandidate(candidateIds, source.lid);
      appendCandidate(candidateIds, source.participant);
      appendCandidate(candidateIds, source.participantAlt);
    }
  }

  return Array.from(candidateIds);
};

const ensureGroupMap = (groupId) => {
  if (!pendingCaptchas.has(groupId)) {
    pendingCaptchas.set(groupId, new Map());
  }
  return pendingCaptchas.get(groupId);
};

const cleanupGroupIfEmpty = (groupId, groupMap) => {
  if (!groupMap || groupMap.size > 0) return;
  pendingCaptchas.delete(groupId);
};

const cleanupMessageStateForEntry = (entry) => {
  if (!entry?.messageStateKey) return null;
  const state = captchaMessageState.get(entry.messageStateKey);
  if (!state) return null;
  state.pendingCount = Math.max(0, (state.pendingCount || 0) - 1);
  if (state.pendingCount <= 0) {
    captchaMessageState.delete(entry.messageStateKey);
  }
  return state;
};

const removeEntryAliasesFromGroup = (groupMap, entry) => {
  if (!groupMap || !entry) return;
  for (const [key, mappedEntry] of groupMap.entries()) {
    if (mappedEntry === entry) {
      groupMap.delete(key);
    }
  }
};

const findPendingEntry = (groupId, ...identitySources) => {
  const groupMap = pendingCaptchas.get(groupId);
  if (!groupMap) return null;

  const candidates = buildUserIdCandidates(...identitySources);
  for (const candidate of candidates) {
    const entry = groupMap.get(candidate);
    if (entry) {
      return { groupMap, entry, lookupUserId: candidate };
    }
  }

  return null;
};

const findPendingEntryAsync = async (groupId, ...identitySources) => {
  const directMatch = findPendingEntry(groupId, ...identitySources);
  if (directMatch) return directMatch;

  const groupMap = pendingCaptchas.get(groupId);
  if (!groupMap) return null;

  const asyncCandidates = new Set();

  for (const source of identitySources) {
    if (!source) continue;
    const info = extractUserIdInfo(source);
    const hasLidLikeIdentity = Boolean(info.lid || (typeof info.raw === 'string' && info.raw.includes('@lid')));
    if (!hasLidLikeIdentity) continue;

    try {
      const resolved = await resolveUserId(info);
      appendCandidate(asyncCandidates, resolved);
    } catch (error) {
      logger.warn('Falha ao resolver ID canônico no captcha via lid_map.', {
        groupId,
        errorMessage: error.message,
      });
    }
  }

  for (const candidate of asyncCandidates) {
    const entry = groupMap.get(candidate);
    if (entry) {
      // guarda alias resolvido para próximos eventos do mesmo usuário
      groupMap.set(candidate, entry);
      return { groupMap, entry, lookupUserId: candidate };
    }
  }

  return null;
};

const clearEntry = (groupId, userId, reason) => {
  const groupMap = pendingCaptchas.get(groupId);
  if (!groupMap) return null;
  const entry = groupMap.get(userId);
  if (!entry) return null;

  if (entry.timeoutId) {
    clearTimeout(entry.timeoutId);
  }

  removeEntryAliasesFromGroup(groupMap, entry);
  cleanupGroupIfEmpty(groupId, groupMap);
  const messageState = cleanupMessageStateForEntry(entry);

  logger.debug('Captcha resolvido/removido.', {
    action: 'captcha_clear',
    groupId,
    userId: entry.userId || userId,
    lookupUserId: userId,
    reason,
  });

  return { entry, messageState };
};

const handleCaptchaTimeout = async (groupId, userId) => {
  const groupMap = pendingCaptchas.get(groupId);
  const entry = groupMap?.get(userId);
  if (!entry) return;

  if (__timeNowMs() < entry.expiresAt) {
    return;
  }

  const cleared = clearEntry(groupId, userId, 'timeout');
  if (!cleared) return;
  const resolvedEntry = cleared.entry;

  try {
    const sock = getActiveSocket();
    if (!sock) {
      logger.warn('Socket ativo indisponível para aplicar timeout de captcha.', {
        groupId,
        userId,
      });
      return;
    }

    const removalId = resolvedEntry.rawId || userId;
    const isAdmin = await isUserAdmin(groupId, removalId);
    if (isAdmin) {
      logger.info('Captcha expirado, mas usuário é admin. Nenhuma ação tomada.', {
        groupId,
        userId: removalId,
      });
      return;
    }

    await updateGroupParticipants(sock, groupId, [removalId], 'remove');

    const user = getJidUser(removalId);
    await sendAndStore(sock, groupId, {
      text: `⏳ @${user || 'usuario'} foi removido por não completar a verificação em ${CAPTCHA_TIMEOUT_MINUTES} minutos.`,
      mentions: [removalId],
    });

    logger.info('Usuário removido por falha no captcha.', {
      action: 'captcha_remove',
      groupId,
      userId: removalId,
    });
  } catch (error) {
    logger.error('Erro ao aplicar timeout do captcha.', {
      groupId,
      userId,
      errorMessage: error.message,
      stack: error.stack,
    });
  }
};

const sendCaptchaApprovalReaction = async ({ groupId, messageKey, userId }) => {
  if (!groupId || !messageKey || !CAPTCHA_OK_EMOJI) return;
  const sock = getActiveSocket();
  if (!sock) {
    logger.warn('Socket ativo indisponível para enviar reação de captcha.', {
      groupId,
      userId,
    });
    return;
  }

  try {
    await sendAndStore(sock, groupId, {
      react: {
        text: CAPTCHA_OK_EMOJI,
        key: messageKey,
      },
    });
  } catch (error) {
    logger.warn('Falha ao enviar reação de captcha.', {
      groupId,
      userId,
      errorMessage: error.message,
    });
  }
};

const sendCaptchaApprovalEdit = async ({ groupId, entry, messageState }) => {
  if (!groupId || !entry?.messageKey) return;

  const mentionId = entry.rawId || entry.userId;
  const userLabel = getJidUser(mentionId) || 'usuario';
  const approvalLine = `✅ @${userLabel} passou na verificação.`;
  const baseText = normalizeMessageText(messageState?.text);
  const updatedText = baseText.includes(approvalLine) ? baseText : `${baseText}${baseText ? '\n' : ''}${approvalLine}`;

  const mentionsSet = new Set(Array.isArray(messageState?.mentions) ? messageState.mentions : []);
  if (mentionId) {
    mentionsSet.add(mentionId);
  }
  const mentions = Array.from(mentionsSet);

  const sock = getActiveSocket();
  if (!sock) {
    logger.warn('Socket ativo indisponível para editar mensagem de captcha.', {
      groupId,
      userId: mentionId,
    });
    return;
  }

  try {
    await sendAndStore(sock, groupId, {
      text: updatedText,
      mentions,
      edit: entry.messageKey,
    });
    if (messageState) {
      messageState.text = updatedText;
      messageState.mentions = mentions;
    }
  } catch (error) {
    logger.warn('Falha ao editar mensagem de captcha.', {
      groupId,
      userId: mentionId,
      errorMessage: error.message,
    });
  }
};

const sendCaptchaApprovalNotice = async ({ groupId, entry, method }) => {
  if (!groupId) return;

  const mentionId = entry?.rawId || entry?.userId || null;
  const userLabel = getJidUser(mentionId) || 'usuario';
  const methodLabel = method === 'reaction' ? 'reação' : 'mensagem';

  const sock = getActiveSocket();
  if (!sock) {
    logger.warn('Socket ativo indisponível para enviar aviso de aprovação no captcha.', {
      groupId,
      userId: mentionId,
      method,
    });
    return;
  }

  try {
    await sendAndStore(sock, groupId, {
      text: `✅ @${userLabel} completou a verificação por ${methodLabel} e foi aprovado(a).`,
      mentions: mentionId ? [mentionId] : [],
    });

    logger.info('Usuário aprovado no captcha.', {
      action: 'captcha_approved',
      groupId,
      userId: mentionId,
      method,
    });
  } catch (error) {
    logger.warn('Falha ao enviar aviso de aprovação de captcha.', {
      groupId,
      userId: mentionId,
      method,
      errorMessage: error.message,
    });
  }
};

export const registerCaptchaChallenge = ({ groupId, participantJid, messageKey, messageText, messageMentions }) => {
  if (!groupId) return;
  const userIdCandidates = buildUserIdCandidates(participantJid);
  const userId = userIdCandidates[0] || null;
  if (!userId) return;
  const rawId = toNonEmptyString(participantJid) || userId;

  const groupMap = ensureGroupMap(groupId);
  const existingMatch = findPendingEntry(groupId, participantJid, userId);
  if (existingMatch?.entry?.timeoutId) {
    clearTimeout(existingMatch.entry.timeoutId);
  }
  if (existingMatch?.entry) {
    removeEntryAliasesFromGroup(groupMap, existingMatch.entry);
    cleanupMessageStateForEntry(existingMatch.entry);
  }

  const expiresAt = __timeNowMs() + CAPTCHA_TIMEOUT_MS;
  const messageId = messageKey?.id || null;
  const normalizedText = normalizeMessageText(messageText);
  const messageStateKey = messageId && normalizedText ? buildMessageStateKey(groupId, messageId) : null;

  if (messageStateKey) {
    const mentions = Array.isArray(messageMentions) ? Array.from(new Set(messageMentions.filter(Boolean))) : [];
    const existingState = captchaMessageState.get(messageStateKey);
    if (existingState) {
      existingState.pendingCount = (existingState.pendingCount || 0) + 1;
      if (!existingState.text) existingState.text = normalizedText;
      if ((!existingState.mentions || existingState.mentions.length === 0) && mentions.length > 0) {
        existingState.mentions = mentions;
      }
    } else {
      captchaMessageState.set(messageStateKey, {
        text: normalizedText,
        mentions,
        pendingCount: 1,
      });
    }
  }

  const timeoutId = setTimeout(() => {
    handleCaptchaTimeout(groupId, userId);
  }, CAPTCHA_TIMEOUT_MS);

  const entry = {
    userId,
    rawId,
    messageId,
    messageKey: messageKey || null,
    messageStateKey,
    expiresAt,
    timeoutId,
  };

  const aliases = Array.from(new Set([userId, rawId, ...userIdCandidates].filter(Boolean)));
  for (const alias of aliases) {
    groupMap.set(alias, entry);
  }

  logger.debug('Captcha iniciado para usuário.', {
    action: 'captcha_start',
    groupId,
    userId,
    expiresAt,
    messageId,
  });
};

export const clearCaptchaForUser = (groupId, participantJid, reason = 'manual') => {
  const match = findPendingEntry(groupId, participantJid);
  if (!match) return false;
  const cleared = clearEntry(groupId, match.lookupUserId, reason);
  return Boolean(cleared);
};

export const clearCaptchasForGroup = (groupId, reason = 'manual') => {
  const groupMap = pendingCaptchas.get(groupId);
  if (!groupMap) return;

  const uniqueEntries = new Set(groupMap.values());
  for (const entry of uniqueEntries) {
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    cleanupMessageStateForEntry(entry);
  }

  pendingCaptchas.delete(groupId);

  logger.debug('Captchas do grupo limpos.', {
    action: 'captcha_clear_group',
    groupId,
    reason,
  });
};

export const resolveCaptchaByMessage = async ({ groupId, senderJid, senderIdentity, messageKey, messageInfo, extractedText }) => {
  if (!groupId) return false;
  if (!isHumanCaptchaMessage({ messageInfo, extractedText })) return false;
  const match = await findPendingEntryAsync(groupId, senderIdentity, senderJid);
  if (!match) return false;

  const cleared = clearEntry(groupId, match.lookupUserId, 'message');
  if (!cleared) return false;

  sendCaptchaApprovalReaction({
    groupId,
    messageKey,
    userId: cleared.entry.userId || match.lookupUserId,
  });
  sendCaptchaApprovalNotice({ groupId, entry: cleared.entry, method: 'message' });
  return true;
};

export const resolveCaptchaByReaction = async ({ groupId, senderJid, senderIdentity, reactedMessageId, reactionText }) => {
  if (!groupId) return false;
  if (!normalizeMessageText(reactionText)) return false;
  const match = await findPendingEntryAsync(groupId, senderIdentity, senderJid);
  if (!match?.entry) return false;

  if (match.entry.messageId && match.entry.messageId !== reactedMessageId) {
    return false;
  }

  const cleared = clearEntry(groupId, match.lookupUserId, 'reaction');
  if (!cleared) return false;

  sendCaptchaApprovalEdit({ groupId, entry: cleared.entry, messageState: cleared.messageState });
  sendCaptchaApprovalNotice({ groupId, entry: cleared.entry, method: 'reaction' });
  return true;
};
