const DEFAULT_SESSION_ID = 'default';
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9:_-]+$/;
const OWNER_ENFORCEMENT_MODES = new Set(['off', 'shadow', 'enforce']);

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseEnvInt = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

const parseFlexibleEntries = (value) =>
  String(value || '')
    .split(/[,\n;]+/g)
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);

const normalizeSessionId = (value) => String(value || '').trim();

const isValidSessionId = (value) => {
  const normalized = normalizeSessionId(value);
  if (!normalized) return false;
  if (normalized.length > SESSION_ID_MAX_LENGTH) return false;
  return SESSION_ID_PATTERN.test(normalized);
};

const parseSessionIds = ({ sessionIdsRaw = '', legacySessionIdRaw = '' } = {}) => {
  const warnings = [];
  const validSessionIds = [];
  const seen = new Set();

  const legacySessionId = normalizeSessionId(legacySessionIdRaw) || DEFAULT_SESSION_ID;
  const requestedSessionIds = parseFlexibleEntries(sessionIdsRaw);
  const sourceSessionIds = requestedSessionIds.length > 0 ? requestedSessionIds : [legacySessionId];

  for (const candidate of sourceSessionIds) {
    const sessionId = normalizeSessionId(candidate);
    if (!isValidSessionId(sessionId)) {
      warnings.push(`session_id invalido ignorado: "${candidate}"`);
      continue;
    }
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    validSessionIds.push(sessionId);
  }

  if (validSessionIds.length === 0) {
    validSessionIds.push(DEFAULT_SESSION_ID);
    warnings.push(`nenhum session_id valido encontrado; usando fallback "${DEFAULT_SESSION_ID}"`);
  }

  return {
    sessionIds: validSessionIds,
    warnings,
  };
};

const parseSessionWeights = (rawValue, sessionIds, warnings) => {
  const allowedSessions = new Set(sessionIds);
  const weights = {};
  for (const sessionId of sessionIds) {
    weights[sessionId] = 1;
  }

  const entries = parseFlexibleEntries(rawValue);
  if (entries.length === 0) return weights;

  for (const entry of entries) {
    const separator = entry.includes('=') ? '=' : entry.includes(':') ? ':' : '';
    if (!separator) {
      warnings.push(`peso de sessao invalido (faltando separador "=" ou ":"): "${entry}"`);
      continue;
    }

    const [rawSessionId, rawWeight] = entry.split(separator, 2);
    const sessionId = normalizeSessionId(rawSessionId);
    if (!isValidSessionId(sessionId)) {
      warnings.push(`peso ignorado para session_id invalido: "${rawSessionId}"`);
      continue;
    }
    if (!allowedSessions.has(sessionId)) {
      warnings.push(`peso ignorado para session_id nao listado em BAILEYS_SESSION_IDS: "${sessionId}"`);
      continue;
    }

    const weight = parseEnvInt(rawWeight, Number.NaN, 1, 1000);
    if (!Number.isFinite(weight)) {
      warnings.push(`peso invalido para "${sessionId}": "${rawWeight}"`);
      continue;
    }
    weights[sessionId] = weight;
  }

  return weights;
};

export const resolveMultiSessionRuntimeConfig = (env = process.env) => {
  const warnings = [];
  const legacySessionId = normalizeSessionId(env.BAILEYS_AUTH_SESSION_ID) || DEFAULT_SESSION_ID;
  const { sessionIds, warnings: parseWarnings } = parseSessionIds({
    sessionIdsRaw: env.BAILEYS_SESSION_IDS,
    legacySessionIdRaw: legacySessionId,
  });
  warnings.push(...parseWarnings);

  const requestedPrimary = normalizeSessionId(env.BAILEYS_PRIMARY_SESSION_ID);
  let primarySessionId = requestedPrimary || sessionIds[0];

  if (requestedPrimary && !isValidSessionId(requestedPrimary)) {
    warnings.push(`BAILEYS_PRIMARY_SESSION_ID invalido: "${requestedPrimary}"`);
    primarySessionId = sessionIds[0];
  } else if (requestedPrimary && !sessionIds.includes(requestedPrimary)) {
    warnings.push(`BAILEYS_PRIMARY_SESSION_ID fora da lista de sessoes: "${requestedPrimary}"`);
    primarySessionId = sessionIds[0];
  }

  const ownerEnforcementModeRaw = String(env.GROUP_OWNER_ENFORCEMENT_MODE || 'off')
    .trim()
    .toLowerCase();
  const ownerEnforcementMode = OWNER_ENFORCEMENT_MODES.has(ownerEnforcementModeRaw) ? ownerEnforcementModeRaw : 'off';
  if (!OWNER_ENFORCEMENT_MODES.has(ownerEnforcementModeRaw)) {
    warnings.push(`GROUP_OWNER_ENFORCEMENT_MODE invalido: "${ownerEnforcementModeRaw}"`);
  }

  const ownerLeaseMs = parseEnvInt(env.GROUP_OWNER_LEASE_MS, 120_000, 5_000, 15 * 60 * 1000);
  let ownerHeartbeatMs = parseEnvInt(env.GROUP_OWNER_HEARTBEAT_MS, 30_000, 1_000, 5 * 60 * 1000);
  if (ownerHeartbeatMs >= ownerLeaseMs) {
    ownerHeartbeatMs = Math.max(1_000, Math.floor(ownerLeaseMs / 2));
    warnings.push(`GROUP_OWNER_HEARTBEAT_MS ajustado automaticamente para ${ownerHeartbeatMs}ms (precisa ser menor que lease)`);
  }

  const balancerEnabled = parseEnvBool(env.GROUP_BALANCER_ENABLED, false);
  const sessionWeights = parseSessionWeights(env.BAILEYS_SESSION_WEIGHTS, sessionIds, warnings);

  return Object.freeze({
    sessionIds: Object.freeze([...sessionIds]),
    primarySessionId,
    sessionWeights: Object.freeze({ ...sessionWeights }),
    ownerEnforcementMode,
    ownerLeaseMs,
    ownerHeartbeatMs,
    balancerEnabled,
    warnings: Object.freeze([...warnings]),
  });
};

export const multiSessionRuntimeConfig = resolveMultiSessionRuntimeConfig();

export const getMultiSessionRuntimeConfig = () => multiSessionRuntimeConfig;
