import { executeQuery, TABLES } from '../../../database/index.js';

const GROUP_ASSIGNMENT_TABLE = TABLES.GROUP_ASSIGNMENT;
const GROUP_ASSIGNMENT_HISTORY_TABLE = TABLES.GROUP_ASSIGNMENT_HISTORY;
const MAX_GROUP_JID_LENGTH = 255;
const MAX_SESSION_ID_LENGTH = 64;
const MAX_REASON_LENGTH = 64;
const MAX_CHANGED_BY_LENGTH = 64;

const toDateOrNull = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toPositiveInt = (value, fallback = 1) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const toBool = (value) => value === true || value === 1 || value === '1';

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
  if (value === undefined || value === null) return null;
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

export const normalizeGroupJid = (value) => {
  const normalized = String(value || '')
    .trim()
    .slice(0, MAX_GROUP_JID_LENGTH);
  return normalized || null;
};

export const normalizeSessionId = (value) => {
  const normalized = String(value || '')
    .trim()
    .slice(0, MAX_SESSION_ID_LENGTH);
  return normalized || null;
};

export const normalizeReason = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value)
    .trim()
    .slice(0, MAX_REASON_LENGTH);
  return normalized || null;
};

export const normalizeChangedBy = (value) => {
  const normalized = String(value || 'system')
    .trim()
    .slice(0, MAX_CHANGED_BY_LENGTH);
  return normalized || 'system';
};

export const normalizeAssignmentRow = (row = null) => {
  if (!row) return null;
  return {
    groupJid: normalizeGroupJid(row.group_jid),
    ownerSessionId: normalizeSessionId(row.owner_session_id),
    leaseExpiresAt: toDateOrNull(row.lease_expires_at),
    cooldownUntil: toDateOrNull(row.cooldown_until),
    assignmentVersion: toPositiveInt(row.assignment_version, 1),
    pinned: toBool(row.pinned),
    lastReason: normalizeReason(row.last_reason),
    createdAt: toDateOrNull(row.created_at),
    updatedAt: toDateOrNull(row.updated_at),
  };
};

const ASSIGNMENT_SELECT_COLUMNS = `group_jid,
  owner_session_id,
  lease_expires_at,
  cooldown_until,
  assignment_version,
  pinned,
  last_reason,
  created_at,
  updated_at`;

export const getAssignment = async (groupJid, connection = null) => {
  const safeGroupJid = normalizeGroupJid(groupJid);
  if (!safeGroupJid) return null;

  const rows = await executeQuery(
    `SELECT ${ASSIGNMENT_SELECT_COLUMNS}
       FROM ${GROUP_ASSIGNMENT_TABLE}
      WHERE group_jid = ?
      LIMIT 1`,
    [safeGroupJid],
    connection,
  );

  return normalizeAssignmentRow(rows?.[0] || null);
};

export const getAssignmentForUpdate = async (groupJid, connection) => {
  const safeGroupJid = normalizeGroupJid(groupJid);
  if (!safeGroupJid) return null;
  if (!connection) {
    throw new Error('getAssignmentForUpdate requer connection transacional.');
  }

  const rows = await executeQuery(
    `SELECT ${ASSIGNMENT_SELECT_COLUMNS}
       FROM ${GROUP_ASSIGNMENT_TABLE}
      WHERE group_jid = ?
      LIMIT 1
      FOR UPDATE`,
    [safeGroupJid],
    connection,
  );

  return normalizeAssignmentRow(rows?.[0] || null);
};

export const createAssignment = async (
  { groupJid, ownerSessionId, leaseExpiresAt, cooldownUntil = null, pinned = false, reason = null, assignmentVersion = 1 } = {},
  connection = null,
) => {
  const safeGroupJid = normalizeGroupJid(groupJid);
  const safeOwnerSessionId = normalizeSessionId(ownerSessionId);
  const safeLeaseExpiresAt = toDateOrNull(leaseExpiresAt);
  if (!safeGroupJid || !safeOwnerSessionId || !safeLeaseExpiresAt) {
    throw new Error('createAssignment requer groupJid, ownerSessionId e leaseExpiresAt validos.');
  }

  await executeQuery(
    `INSERT INTO ${GROUP_ASSIGNMENT_TABLE}
      (group_jid, owner_session_id, lease_expires_at, cooldown_until, assignment_version, pinned, last_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [safeGroupJid, safeOwnerSessionId, safeLeaseExpiresAt, toDateOrNull(cooldownUntil), toPositiveInt(assignmentVersion, 1), toBool(pinned) ? 1 : 0, normalizeReason(reason)],
    connection,
  );

  return getAssignment(safeGroupJid, connection);
};

export const updateAssignmentOwner = async (
  { groupJid, ownerSessionId, leaseExpiresAt, reason = null, bumpVersion = true, cooldownUntil = undefined, pinned = undefined } = {},
  connection = null,
) => {
  const safeGroupJid = normalizeGroupJid(groupJid);
  const safeOwnerSessionId = normalizeSessionId(ownerSessionId);
  const safeLeaseExpiresAt = toDateOrNull(leaseExpiresAt);

  if (!safeGroupJid || !safeOwnerSessionId || !safeLeaseExpiresAt) {
    throw new Error('updateAssignmentOwner requer groupJid, ownerSessionId e leaseExpiresAt validos.');
  }

  const sets = ['owner_session_id = ?', 'lease_expires_at = ?', 'last_reason = ?'];
  const params = [safeOwnerSessionId, safeLeaseExpiresAt, normalizeReason(reason)];

  if (cooldownUntil !== undefined) {
    sets.push('cooldown_until = ?');
    params.push(toDateOrNull(cooldownUntil));
  }

  if (pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(toBool(pinned) ? 1 : 0);
  }

  if (bumpVersion) {
    sets.push('assignment_version = assignment_version + 1');
  }

  params.push(safeGroupJid);
  await executeQuery(
    `UPDATE ${GROUP_ASSIGNMENT_TABLE}
        SET ${sets.join(', ')}
      WHERE group_jid = ?`,
    params,
    connection,
  );

  return getAssignment(safeGroupJid, connection);
};

export const updateAssignmentLease = async (
  { groupJid, ownerSessionId, leaseExpiresAt, reason = undefined } = {},
  connection = null,
) => {
  const safeGroupJid = normalizeGroupJid(groupJid);
  const safeOwnerSessionId = normalizeSessionId(ownerSessionId);
  const safeLeaseExpiresAt = toDateOrNull(leaseExpiresAt);
  if (!safeGroupJid || !safeOwnerSessionId || !safeLeaseExpiresAt) {
    throw new Error('updateAssignmentLease requer groupJid, ownerSessionId e leaseExpiresAt validos.');
  }

  const sets = ['lease_expires_at = ?'];
  const params = [safeLeaseExpiresAt];

  if (reason !== undefined) {
    sets.push('last_reason = ?');
    params.push(normalizeReason(reason));
  }

  params.push(safeGroupJid, safeOwnerSessionId);
  await executeQuery(
    `UPDATE ${GROUP_ASSIGNMENT_TABLE}
        SET ${sets.join(', ')}
      WHERE group_jid = ? AND owner_session_id = ?`,
    params,
    connection,
  );

  return getAssignment(safeGroupJid, connection);
};

export const expireAssignment = async (
  { groupJid, ownerSessionId = null, reason = null, bumpVersion = true, leaseExpiresAt = new Date() } = {},
  connection = null,
) => {
  const safeGroupJid = normalizeGroupJid(groupJid);
  if (!safeGroupJid) {
    throw new Error('expireAssignment requer groupJid valido.');
  }

  const safeOwnerSessionId = normalizeSessionId(ownerSessionId);
  const safeLeaseExpiresAt = toDateOrNull(leaseExpiresAt) || new Date();
  const sets = ['lease_expires_at = ?', 'last_reason = ?'];
  if (bumpVersion) {
    sets.push('assignment_version = assignment_version + 1');
  }

  const params = [safeLeaseExpiresAt, normalizeReason(reason), safeGroupJid];
  let where = 'group_jid = ?';
  if (safeOwnerSessionId) {
    where += ' AND owner_session_id = ?';
    params.push(safeOwnerSessionId);
  }

  await executeQuery(
    `UPDATE ${GROUP_ASSIGNMENT_TABLE}
        SET ${sets.join(', ')}
      WHERE ${where}`,
    params,
    connection,
  );

  return getAssignment(safeGroupJid, connection);
};

export const insertAssignmentHistory = async (
  { groupJid, previousSessionId = null, newSessionId, changeReason = null, changedBy = 'system', assignmentVersion = 1, metadata = null } = {},
  connection = null,
) => {
  const safeGroupJid = normalizeGroupJid(groupJid);
  const safePreviousSessionId = normalizeSessionId(previousSessionId);
  const safeNewSessionId = normalizeSessionId(newSessionId) || safePreviousSessionId;
  const safeChangedBy = normalizeChangedBy(changedBy);
  const safeVersion = toPositiveInt(assignmentVersion, 1);

  if (!safeGroupJid || !safeNewSessionId) {
    throw new Error('insertAssignmentHistory requer groupJid e newSessionId validos.');
  }

  const result = await executeQuery(
    `INSERT INTO ${GROUP_ASSIGNMENT_HISTORY_TABLE}
      (group_jid, previous_session_id, new_session_id, change_reason, changed_by, assignment_version, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [safeGroupJid, safePreviousSessionId, safeNewSessionId, normalizeReason(changeReason), safeChangedBy, safeVersion, serializeJson(metadata)],
    connection,
  );

  return {
    id: Number(result?.insertId || 0),
    groupJid: safeGroupJid,
    previousSessionId: safePreviousSessionId,
    newSessionId: safeNewSessionId,
    changeReason: normalizeReason(changeReason),
    changedBy: safeChangedBy,
    assignmentVersion: safeVersion,
    metadata: parseJson(serializeJson(metadata)),
  };
};
