import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

const normalizeJid = (jid) => {
  if (!jid) return '';
  return jidNormalizedUser(jid);
};

const parseEnvInt = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

export const MIN_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES = 1;
export const MAX_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES = 24 * 60;
export const DEFAULT_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES = parseEnvInt(process.env.STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES ?? process.env.STICKER_FOCUS_TEXT_COOLDOWN_MINUTES, 60, MIN_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES, MAX_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES);
export const MIN_STICKER_FOCUS_MESSAGE_ALLOWANCE = 1;
export const MAX_STICKER_FOCUS_MESSAGE_ALLOWANCE = 10;
export const DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE = parseEnvInt(process.env.STICKER_FOCUS_MESSAGE_ALLOWANCE, 2, MIN_STICKER_FOCUS_MESSAGE_ALLOWANCE, MAX_STICKER_FOCUS_MESSAGE_ALLOWANCE);

export const MIN_STICKER_FOCUS_CHAT_WINDOW_MINUTES = 1;
export const MAX_STICKER_FOCUS_CHAT_WINDOW_MINUTES = 6 * 60;
export const DEFAULT_STICKER_FOCUS_CHAT_WINDOW_MINUTES = parseEnvInt(process.env.STICKER_FOCUS_CHAT_WINDOW_MINUTES, 15, MIN_STICKER_FOCUS_CHAT_WINDOW_MINUTES, MAX_STICKER_FOCUS_CHAT_WINDOW_MINUTES);

const STICKER_FOCUS_WARNING_COOLDOWN_MS = parseEnvInt(process.env.STICKER_FOCUS_WARNING_COOLDOWN_MS, 45_000, 10_000, 5 * 60_000);
const NON_HUMAN_PLACEHOLDERS = new Set(['Mensagem vazia', 'Tipo de mensagem não suportado ou sem conteúdo.']);
const IGNORED_MESSAGE_TYPES = new Set(['messagehistorybundle', 'messagehistorynotice', 'keydistribution', 'senderkeydistribution', 'reaction', 'devicesent', 'contextinfo', 'protocol', 'botinvoke']);
const NON_THROTTLED_MESSAGE_TYPES = new Set(['sticker', 'image', 'video', 'stickerpack', 'stickerpackmessage']);
const MESSAGE_WRAPPER_KEYS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'deviceSentMessage', 'editedMessage'];

const sharedMessageAllowance = globalThis.__omnizapStickerFocusMessageAllowance instanceof Map ? globalThis.__omnizapStickerFocusMessageAllowance : new Map();
const sharedWarningThrottle = globalThis.__omnizapStickerFocusWarningThrottle instanceof Map ? globalThis.__omnizapStickerFocusWarningThrottle : new Map();

globalThis.__omnizapStickerFocusMessageAllowance = sharedMessageAllowance;
globalThis.__omnizapStickerFocusWarningThrottle = sharedWarningThrottle;

const normalizeMinutes = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

const parseTimestampMs = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 0;
};

const buildSenderKey = ({ groupId = '', senderJid = '' }) => {
  const normalizedGroup = normalizeJid(groupId) || String(groupId || '').trim();
  const normalizedSender = normalizeJid(senderJid) || String(senderJid || '').trim();
  if (!normalizedGroup || !normalizedSender) return '';
  return `${normalizedGroup}:${normalizedSender}`;
};

const hasExplicitTextPayload = (messagePayload) => {
  if (!messagePayload || typeof messagePayload !== 'object') return false;

  const queue = [messagePayload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;

    const conversationText = typeof current.conversation === 'string' ? current.conversation.trim() : '';
    if (conversationText) return true;

    const extendedText = typeof current.extendedTextMessage?.text === 'string' ? current.extendedTextMessage.text.trim() : '';
    if (extendedText) return true;

    for (const wrapperKey of MESSAGE_WRAPPER_KEYS) {
      const nestedMessage = current?.[wrapperKey]?.message;
      if (nestedMessage && typeof nestedMessage === 'object') {
        queue.push(nestedMessage);
      }
    }
  }

  return false;
};

const hasStickerPackPayload = (messagePayload) => {
  if (!messagePayload || typeof messagePayload !== 'object') return false;

  const queue = [messagePayload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;

    if (current.stickerPackMessage && typeof current.stickerPackMessage === 'object') {
      return true;
    }

    for (const wrapperKey of MESSAGE_WRAPPER_KEYS) {
      const nestedMessage = current?.[wrapperKey]?.message;
      if (nestedMessage && typeof nestedMessage === 'object') {
        queue.push(nestedMessage);
      }
    }
  }

  return false;
};

const isPlaceholderOnlyText = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return true;
  if (NON_HUMAN_PLACEHOLDERS.has(normalized)) return true;
  return /^\[[^\]]+\]$/.test(normalized);
};

const normalizeMessageTypes = (mediaEntries = []) => {
  if (!Array.isArray(mediaEntries)) return [];
  return mediaEntries
    .map((entry) =>
      String(entry?.mediaType || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
};

const isIgnoredSystemMessageType = (type) => {
  const normalized = String(type || '')
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  if (IGNORED_MESSAGE_TYPES.has(normalized)) return true;
  // Cobre variações do Baileys/proto para eventos internos de distribuição de chave.
  if (normalized.includes('keydistribution')) return true;
  if (normalized.includes('senderkeydistribution')) return true;
  return false;
};

const isAlbumMediaMessageType = (type) => {
  const normalized = String(type || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (normalized === 'album') return true;
  return normalized.startsWith('album');
};

export const clampStickerFocusMessageCooldownMinutes = (value, fallback = DEFAULT_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES) => normalizeMinutes(value, fallback, MIN_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES, MAX_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES);
export const clampStickerFocusMessageAllowance = (value, fallback = DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE) => normalizeMinutes(value, fallback, MIN_STICKER_FOCUS_MESSAGE_ALLOWANCE, MAX_STICKER_FOCUS_MESSAGE_ALLOWANCE);

export const clampStickerFocusChatWindowMinutes = (value, fallback = DEFAULT_STICKER_FOCUS_CHAT_WINDOW_MINUTES) => normalizeMinutes(value, fallback, MIN_STICKER_FOCUS_CHAT_WINDOW_MINUTES, MAX_STICKER_FOCUS_CHAT_WINDOW_MINUTES);

export const minutesToMs = (minutes) => Math.max(0, Math.floor(Number(minutes) || 0) * 60 * 1000);

export const resolveStickerFocusState = (groupConfig = {}, now = __timeNowMs()) => {
  const rawCooldown = groupConfig?.stickerFocusMessageCooldownMinutes ?? groupConfig?.stickerFocusTextCooldownMinutes;
  const messageCooldownMinutes = clampStickerFocusMessageCooldownMinutes(rawCooldown);
  const rawAllowance = groupConfig?.stickerFocusMessageAllowance ?? groupConfig?.stickerFocusMessageAllowanceCount;
  const messageAllowanceCount = clampStickerFocusMessageAllowance(rawAllowance);
  const messageCooldownMs = minutesToMs(messageCooldownMinutes);
  const chatWindowUntilMs = parseTimestampMs(groupConfig?.stickerFocusChatWindowUntilMs);
  const safeNow = Number.isFinite(now) ? now : __timeNowMs();
  const chatWindowRemainingMs = Math.max(0, chatWindowUntilMs - safeNow);

  return {
    enabled: Boolean(groupConfig?.stickerFocusEnabled),
    messageAllowanceCount,
    messageCooldownMinutes,
    messageCooldownMs,
    // backward compatibility for old reads
    textAllowanceCount: messageAllowanceCount,
    textCooldownMinutes: messageCooldownMinutes,
    textCooldownMs: messageCooldownMs,
    chatWindowUntilMs,
    chatWindowRemainingMs,
    isChatWindowOpen: chatWindowRemainingMs > 0,
  };
};

export const resolveStickerFocusMessageClassification = ({ messageInfo, extractedText, mediaEntries = [] }) => {
  if (messageInfo?.messageStubType !== undefined && messageInfo?.messageStubType !== null) {
    return {
      isThrottleCandidate: false,
      messageType: 'system_stub',
      reason: 'stub',
    };
  }

  if (hasStickerPackPayload(messageInfo?.message)) {
    return {
      isThrottleCandidate: false,
      messageType: 'sticker_pack',
      reason: 'sticker_pack_payload',
    };
  }

  const messageTypes = normalizeMessageTypes(mediaEntries);
  const filteredTypes = messageTypes.filter((type) => !isIgnoredSystemMessageType(type));
  const primaryType = filteredTypes[0] || messageTypes[0] || 'unknown';
  const nonThrottledType = filteredTypes.find((type) => NON_THROTTLED_MESSAGE_TYPES.has(type) || isAlbumMediaMessageType(type));

  if (nonThrottledType) {
    return {
      isThrottleCandidate: false,
      messageType: nonThrottledType || primaryType,
      reason: 'sticker_flow_media',
    };
  }

  if (filteredTypes.length > 0) {
    return {
      isThrottleCandidate: true,
      messageType: primaryType,
      reason: 'message_type',
    };
  }

  if (!isPlaceholderOnlyText(extractedText) && hasExplicitTextPayload(messageInfo?.message)) {
    return {
      isThrottleCandidate: true,
      messageType: 'text',
      reason: 'explicit_text_payload',
    };
  }

  return {
    isThrottleCandidate: false,
    messageType: primaryType,
    reason: 'non_human_or_empty',
  };
};

const normalizeAllowanceHistory = (historyValue) => {
  if (Array.isArray(historyValue)) {
    return historyValue
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry > 0)
      .map((entry) => Math.floor(entry))
      .sort((a, b) => a - b);
  }

  const singleTimestamp = Number(historyValue);
  if (Number.isFinite(singleTimestamp) && singleTimestamp > 0) {
    return [Math.floor(singleTimestamp)];
  }

  return [];
};

export const canSendMessageInStickerFocus = ({ groupId, senderJid, messageCooldownMs, messageAllowanceCount = DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE, now = __timeNowMs() }) => {
  const senderKey = buildSenderKey({ groupId, senderJid });
  if (!senderKey) {
    return {
      allowed: true,
      remainingMs: 0,
      usageCount: 0,
      allowanceCount: clampStickerFocusMessageAllowance(messageAllowanceCount),
    };
  }

  const normalizedCooldownMs = Math.max(0, Math.floor(Number(messageCooldownMs) || 0));
  const normalizedAllowanceCount = clampStickerFocusMessageAllowance(messageAllowanceCount);
  if (normalizedCooldownMs <= 0) {
    const rawHistory = normalizeAllowanceHistory(sharedMessageAllowance.get(senderKey));
    return {
      allowed: true,
      remainingMs: 0,
      usageCount: rawHistory.length,
      allowanceCount: normalizedAllowanceCount,
    };
  }

  const safeNow = Number.isFinite(now) ? now : __timeNowMs();
  const history = normalizeAllowanceHistory(sharedMessageAllowance.get(senderKey)).filter((timestamp) => safeNow - timestamp < normalizedCooldownMs);
  if (history.length > 0) {
    sharedMessageAllowance.set(senderKey, history);
  } else {
    sharedMessageAllowance.delete(senderKey);
  }

  if (history.length < normalizedAllowanceCount) {
    return {
      allowed: true,
      remainingMs: 0,
      usageCount: history.length,
      allowanceCount: normalizedAllowanceCount,
    };
  }

  const oldestTimestamp = history[0] || safeNow;
  return {
    allowed: false,
    remainingMs: Math.max(0, normalizedCooldownMs - (safeNow - oldestTimestamp)),
    usageCount: history.length,
    allowanceCount: normalizedAllowanceCount,
  };
};

export const registerMessageUsageInStickerFocus = ({ groupId, senderJid, messageCooldownMs = minutesToMs(DEFAULT_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES), messageAllowanceCount = DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE, now = __timeNowMs() }) => {
  const senderKey = buildSenderKey({ groupId, senderJid });
  if (!senderKey) return;
  const normalizedCooldownMs = Math.max(0, Math.floor(Number(messageCooldownMs) || 0));
  const normalizedAllowanceCount = clampStickerFocusMessageAllowance(messageAllowanceCount);
  const safeNow = Number.isFinite(now) ? now : __timeNowMs();
  const history = normalizeAllowanceHistory(sharedMessageAllowance.get(senderKey));
  const recentHistory = normalizedCooldownMs > 0 ? history.filter((timestamp) => safeNow - timestamp < normalizedCooldownMs) : history;
  recentHistory.push(safeNow);
  const trimmedHistory = recentHistory.slice(-normalizedAllowanceCount);
  sharedMessageAllowance.set(senderKey, trimmedHistory);
};

export const shouldSendStickerFocusWarning = ({ groupId, senderJid, now = __timeNowMs() }) => {
  const senderKey = buildSenderKey({ groupId, senderJid });
  if (!senderKey) return true;
  const safeNow = Number.isFinite(now) ? now : __timeNowMs();
  const lastWarningAt = Number(sharedWarningThrottle.get(senderKey) || 0);
  if (!lastWarningAt || safeNow - lastWarningAt >= STICKER_FOCUS_WARNING_COOLDOWN_MS) {
    sharedWarningThrottle.set(senderKey, safeNow);
    return true;
  }
  return false;
};

// Backward compatibility aliases
export const MIN_STICKER_FOCUS_TEXT_COOLDOWN_MINUTES = MIN_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES;
export const MAX_STICKER_FOCUS_TEXT_COOLDOWN_MINUTES = MAX_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES;
export const DEFAULT_STICKER_FOCUS_TEXT_COOLDOWN_MINUTES = DEFAULT_STICKER_FOCUS_MESSAGE_COOLDOWN_MINUTES;
export const clampStickerFocusTextCooldownMinutes = clampStickerFocusMessageCooldownMinutes;
export const MIN_STICKER_FOCUS_TEXT_ALLOWANCE = MIN_STICKER_FOCUS_MESSAGE_ALLOWANCE;
export const MAX_STICKER_FOCUS_TEXT_ALLOWANCE = MAX_STICKER_FOCUS_MESSAGE_ALLOWANCE;
export const DEFAULT_STICKER_FOCUS_TEXT_ALLOWANCE = DEFAULT_STICKER_FOCUS_MESSAGE_ALLOWANCE;
export const clampStickerFocusTextAllowance = clampStickerFocusMessageAllowance;
export const isPlainTextMessageForStickerFocus = ({ messageInfo, extractedText, mediaEntries = [] }) => resolveStickerFocusMessageClassification({ messageInfo, extractedText, mediaEntries }).messageType === 'text';
export const canSendTextInStickerFocus = ({ groupId, senderJid, textCooldownMs, textAllowanceCount, now = __timeNowMs() }) =>
  canSendMessageInStickerFocus({
    groupId,
    senderJid,
    messageCooldownMs: textCooldownMs,
    messageAllowanceCount: textAllowanceCount,
    now,
  });
export const registerTextUsageInStickerFocus = ({ groupId, senderJid, textCooldownMs, textAllowanceCount, now = __timeNowMs() }) =>
  registerMessageUsageInStickerFocus({
    groupId,
    senderJid,
    messageCooldownMs: textCooldownMs,
    messageAllowanceCount: textAllowanceCount,
    now,
  });
