import { executeQuery, TABLES } from '../../../database/index.js';
import { normalizeSessionId } from './groupOwnershipRepository.js';

const SESSION_REGISTRY_TABLE = TABLES.WA_SESSION_REGISTRY;
const MAX_STATUS_LENGTH = 24;
const MAX_BOT_JID_LENGTH = 255;
const DEFAULT_STATUS = 'offline';
const DEFAULT_WEIGHT = 1;

const toDateOrNull = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toPositiveInt = (value, fallback = DEFAULT_WEIGHT, min = 1, max = 10_000) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeStatus = (value, fallback = DEFAULT_STATUS) => {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .slice(0, MAX_STATUS_LENGTH);
  return normalized || fallback;
};

const normalizeBotJid = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .slice(0, MAX_BOT_JID_LENGTH);
  return normalized || null;
};

const parseJson = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
};

const serializeJson = (value) => {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const normalizeSessionRow = (row = null) => {
  if (!row) return null;
  return {
    sessionId: normalizeSessionId(row.session_id),
    botJid: normalizeBotJid(row.bot_jid) ?? null,
    status: normalizeStatus(row.status, DEFAULT_STATUS),
    capacityWeight: toPositiveInt(row.capacity_weight, DEFAULT_WEIGHT),
    currentScore: toNumber(row.current_score, 0),
    lastHeartbeatAt: toDateOrNull(row.last_heartbeat_at),
    lastConnectedAt: toDateOrNull(row.last_connected_at),
    lastDisconnectedAt: toDateOrNull(row.last_disconnected_at),
    metadata: parseJson(row.metadata),
    createdAt: toDateOrNull(row.created_at),
    updatedAt: toDateOrNull(row.updated_at),
  };
};

const SESSION_SELECT_COLUMNS = `session_id,
  bot_jid,
  status,
  capacity_weight,
  current_score,
  last_heartbeat_at,
  last_connected_at,
  last_disconnected_at,
  metadata,
  created_at,
  updated_at`;

export const getSession = async (sessionId, { connection = null } = {}) => {
  const safeSessionId = normalizeSessionId(sessionId);
  if (!safeSessionId) return null;

  const rows = await executeQuery(
    `SELECT ${SESSION_SELECT_COLUMNS}
       FROM ${SESSION_REGISTRY_TABLE}
      WHERE session_id = ?
      LIMIT 1`,
    [safeSessionId],
    connection,
  );

  return normalizeSessionRow(rows?.[0] || null);
};

export const listSessions = async ({ status = null, limit = 100, connection = null } = {}) => {
  const safeLimit = Math.max(1, Math.min(2_000, toPositiveInt(limit, 100, 1, 2_000)));
  const safeStatus = status ? normalizeStatus(status, '') : '';

  const params = [];
  let where = '';
  if (safeStatus) {
    where = 'WHERE status = ?';
    params.push(safeStatus);
  }

  const rows = await executeQuery(
    `SELECT ${SESSION_SELECT_COLUMNS}
       FROM ${SESSION_REGISTRY_TABLE}
      ${where}
      ORDER BY updated_at DESC
      LIMIT ${safeLimit}`,
    params,
    connection,
  );

  return (Array.isArray(rows) ? rows : []).map((row) => normalizeSessionRow(row));
};

export const upsertSession = async (
  {
    sessionId,
    botJid = undefined,
    status = DEFAULT_STATUS,
    capacityWeight = DEFAULT_WEIGHT,
    currentScore = 0,
    metadata = undefined,
    heartbeatAt = undefined,
    connectedAt = undefined,
    disconnectedAt = undefined,
  } = {},
  { connection = null } = {},
) => {
  const safeSessionId = normalizeSessionId(sessionId);
  if (!safeSessionId) {
    throw new Error('upsertSession requer sessionId valido.');
  }

  const safeBotJid = normalizeBotJid(botJid);
  const safeStatus = normalizeStatus(status, DEFAULT_STATUS);
  const safeCapacityWeight = toPositiveInt(capacityWeight, DEFAULT_WEIGHT);
  const safeCurrentScore = toNumber(currentScore, 0);
  const safeMetadata = serializeJson(metadata);
  const safeHeartbeatAt = heartbeatAt === undefined ? null : toDateOrNull(heartbeatAt);
  const safeConnectedAt = connectedAt === undefined ? null : toDateOrNull(connectedAt);
  const safeDisconnectedAt = disconnectedAt === undefined ? null : toDateOrNull(disconnectedAt);

  await executeQuery(
    `INSERT INTO ${SESSION_REGISTRY_TABLE}
      (session_id, bot_jid, status, capacity_weight, current_score, last_heartbeat_at, last_connected_at, last_disconnected_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
      bot_jid = COALESCE(VALUES(bot_jid), bot_jid),
      status = VALUES(status),
      capacity_weight = VALUES(capacity_weight),
      current_score = VALUES(current_score),
      last_heartbeat_at = COALESCE(VALUES(last_heartbeat_at), last_heartbeat_at),
      last_connected_at = COALESCE(VALUES(last_connected_at), last_connected_at),
      last_disconnected_at = COALESCE(VALUES(last_disconnected_at), last_disconnected_at),
      metadata = COALESCE(VALUES(metadata), metadata),
      updated_at = CURRENT_TIMESTAMP`,
    [safeSessionId, safeBotJid, safeStatus, safeCapacityWeight, safeCurrentScore, safeHeartbeatAt, safeConnectedAt, safeDisconnectedAt, safeMetadata],
    connection,
  );

  return getSession(safeSessionId, { connection });
};

export const ensureSession = async (
  sessionId,
  {
    status = 'online',
    capacityWeight = DEFAULT_WEIGHT,
    currentScore = 0,
    metadata = undefined,
    botJid = undefined,
    connection = null,
  } = {},
) =>
  upsertSession(
    {
      sessionId,
      status,
      capacityWeight,
      currentScore,
      metadata,
      botJid,
    },
    { connection },
  );

export const heartbeatSession = async (
  sessionId,
  {
    status = 'online',
    currentScore = 0,
    metadata = undefined,
    botJid = undefined,
    capacityWeight = DEFAULT_WEIGHT,
    connection = null,
  } = {},
) =>
  upsertSession(
    {
      sessionId,
      status,
      currentScore,
      metadata,
      botJid,
      capacityWeight,
      heartbeatAt: new Date(),
    },
    { connection },
  );

export const markSessionConnected = async (
  sessionId,
  {
    botJid = undefined,
    currentScore = 0,
    metadata = undefined,
    capacityWeight = DEFAULT_WEIGHT,
    connection = null,
  } = {},
) =>
  upsertSession(
    {
      sessionId,
      botJid,
      status: 'online',
      currentScore,
      metadata,
      capacityWeight,
      heartbeatAt: new Date(),
      connectedAt: new Date(),
    },
    { connection },
  );

export const markSessionDisconnected = async (
  sessionId,
  {
    status = 'offline',
    currentScore = 0,
    metadata = undefined,
    capacityWeight = DEFAULT_WEIGHT,
    connection = null,
  } = {},
) =>
  upsertSession(
    {
      sessionId,
      status,
      currentScore,
      metadata,
      capacityWeight,
      disconnectedAt: new Date(),
    },
    { connection },
  );

const sessionRegistryService = {
  getSession,
  listSessions,
  upsertSession,
  ensureSession,
  heartbeatSession,
  markSessionConnected,
  markSessionDisconnected,
};

export default sessionRegistryService;
