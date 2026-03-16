import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HISTORY_LIMIT = 8;

const sessions = new Map();

const toFinitePositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
};

const normalizeToken = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const buildSessionKey = ({ chatId, userId, scope = 'private' } = {}) => {
  const safeScope = normalizeToken(scope) || 'private';
  const safeChatId = String(chatId || '').trim();
  const safeUserId = String(userId || '').trim();
  if (!safeChatId || !safeUserId) return '';
  return `${safeScope}:${safeChatId}:${safeUserId}`;
};

const pruneExpiredSessions = (nowMs = __timeNowMs()) => {
  for (const [key, session] of sessions.entries()) {
    if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= nowMs) {
      sessions.delete(key);
    }
  }
};

const cloneSession = (session) => ({
  key: session.key,
  scope: session.scope,
  chatId: session.chatId,
  userId: session.userId,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  expiresAt: session.expiresAt,
  lastIntent: session.lastIntent ? { ...session.lastIntent } : null,
  history: Array.isArray(session.history) ? session.history.map((item) => ({ ...item })) : [],
});

const getOrCreateSession = ({ chatId, userId, scope = 'private', ttlMs }) => {
  pruneExpiredSessions();
  const key = buildSessionKey({ chatId, userId, scope });
  if (!key) return null;

  const nowMs = __timeNowMs();
  const safeTtlMs = toFinitePositiveInt(ttlMs, DEFAULT_SESSION_TTL_MS, 1_000);
  const existing = sessions.get(key);

  if (existing && Number.isFinite(existing.expiresAt) && existing.expiresAt > nowMs) {
    existing.updatedAt = new Date(nowMs).toISOString();
    existing.expiresAt = nowMs + safeTtlMs;
    return existing;
  }

  const created = {
    key,
    scope: normalizeToken(scope) || 'private',
    chatId: String(chatId || '').trim(),
    userId: String(userId || '').trim(),
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: nowMs + safeTtlMs,
    lastIntent: null,
    history: [],
  };

  sessions.set(key, created);
  return created;
};

export const getConversationSession = ({ chatId, userId, scope = 'private', ttlMs } = {}) => {
  const session = getOrCreateSession({ chatId, userId, scope, ttlMs });
  if (!session) return null;
  return cloneSession(session);
};

export const appendConversationSessionMessage = ({ chatId, userId, scope = 'private', role = 'user', text = '', metadata = null, ttlMs, historyLimit = DEFAULT_HISTORY_LIMIT } = {}) => {
  const session = getOrCreateSession({ chatId, userId, scope, ttlMs });
  if (!session) return null;

  const safeText = String(text || '').trim();
  if (safeText) {
    const safeRole = normalizeToken(role) || 'user';
    session.history.push({
      role: safeRole,
      text: safeText,
      metadata: metadata && typeof metadata === 'object' ? { ...metadata } : null,
      createdAt: __timeNowIso(),
    });
    const maxHistory = toFinitePositiveInt(historyLimit, DEFAULT_HISTORY_LIMIT, 1);
    if (session.history.length > maxHistory) {
      session.history = session.history.slice(-maxHistory);
    }
  }

  session.updatedAt = __timeNowIso();
  return cloneSession(session);
};

export const setConversationSessionIntent = ({ chatId, userId, scope = 'private', intent = null, ttlMs } = {}) => {
  const session = getOrCreateSession({ chatId, userId, scope, ttlMs });
  if (!session) return null;

  session.lastIntent =
    intent && typeof intent === 'object'
      ? {
          ...intent,
          updatedAt: __timeNowIso(),
        }
      : null;
  session.updatedAt = __timeNowIso();
  return cloneSession(session);
};

export const clearConversationSession = ({ chatId, userId, scope = 'private' } = {}) => {
  const key = buildSessionKey({ chatId, userId, scope });
  if (!key) return false;
  return sessions.delete(key);
};

export const getConversationSessionStoreStats = () => {
  pruneExpiredSessions();
  return {
    activeSessions: sessions.size,
  };
};
