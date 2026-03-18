import { executeQuery, TABLES } from '../../../database/index.js';

const MAX_REASON_CHARS = 500;
const DEFAULT_LIST_LIMIT = 20;

const normalizeGroupId = (value) => {
  const normalized = String(value || '')
    .trim()
    .slice(0, 255);
  return normalized || null;
};

const normalizeParticipantJid = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 255);
  return normalized || null;
};

const normalizeReason = (value) => {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_CHARS);
  return normalized || null;
};

const normalizeWarnByJid = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 255);
  return normalized || null;
};

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric < min) return fallback;
  return Math.max(min, Math.min(max, numeric));
};

export const addGroupWarning = async ({ groupId, participantJid, warnedByJid, reason = null } = {}) => {
  const safeGroupId = normalizeGroupId(groupId);
  const safeParticipantJid = normalizeParticipantJid(participantJid);
  const safeWarnedByJid = normalizeWarnByJid(warnedByJid);

  if (!safeGroupId || !safeParticipantJid) {
    throw new Error('group_warning_invalid_target');
  }

  await executeQuery(
    `INSERT INTO ${TABLES.GROUP_USER_WARNINGS}
      (group_id, participant_jid, warned_by_jid, reason)
      VALUES (?, ?, ?, ?)`,
    [safeGroupId, safeParticipantJid, safeWarnedByJid, normalizeReason(reason)],
  );

  return true;
};

export const countGroupWarnings = async ({ groupId, participantJid } = {}) => {
  const safeGroupId = normalizeGroupId(groupId);
  const safeParticipantJid = normalizeParticipantJid(participantJid);

  if (!safeGroupId || !safeParticipantJid) return 0;

  const rows = await executeQuery(
    `SELECT COUNT(*) AS total
       FROM ${TABLES.GROUP_USER_WARNINGS}
      WHERE group_id = ? AND participant_jid = ?`,
    [safeGroupId, safeParticipantJid],
  );

  const total = Number(rows?.[0]?.total || 0);
  return Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
};

export const listGroupWarnings = async ({ groupId, participantJid, limit = DEFAULT_LIST_LIMIT } = {}) => {
  const safeGroupId = normalizeGroupId(groupId);
  const safeParticipantJid = normalizeParticipantJid(participantJid);
  const safeLimit = toPositiveInt(limit, DEFAULT_LIST_LIMIT, 1, 100);

  if (!safeGroupId || !safeParticipantJid) return [];

  const rows = await executeQuery(
    `SELECT id, group_id, participant_jid, warned_by_jid, reason, created_at
       FROM ${TABLES.GROUP_USER_WARNINGS}
      WHERE group_id = ? AND participant_jid = ?
      ORDER BY id DESC
      LIMIT ?`,
    [safeGroupId, safeParticipantJid, safeLimit],
  );

  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: Number(row?.id || 0),
    groupId: normalizeGroupId(row?.group_id),
    participantJid: normalizeParticipantJid(row?.participant_jid),
    warnedByJid: normalizeWarnByJid(row?.warned_by_jid),
    reason: normalizeReason(row?.reason),
    createdAt: row?.created_at || null,
  }));
};

export const clearGroupWarnings = async ({ groupId, participantJid, clearAll = false, limit = 1 } = {}) => {
  const safeGroupId = normalizeGroupId(groupId);
  const safeParticipantJid = normalizeParticipantJid(participantJid);
  const safeLimit = toPositiveInt(limit, 1, 1, 500);

  if (!safeGroupId || !safeParticipantJid) {
    return {
      removedCount: 0,
      remainingCount: 0,
    };
  }

  const beforeCount = await countGroupWarnings({
    groupId: safeGroupId,
    participantJid: safeParticipantJid,
  });
  if (beforeCount <= 0) {
    return {
      removedCount: 0,
      remainingCount: 0,
    };
  }

  if (clearAll) {
    await executeQuery(
      `DELETE FROM ${TABLES.GROUP_USER_WARNINGS}
        WHERE group_id = ? AND participant_jid = ?`,
      [safeGroupId, safeParticipantJid],
    );
  } else {
    await executeQuery(
      `DELETE FROM ${TABLES.GROUP_USER_WARNINGS}
        WHERE group_id = ? AND participant_jid = ?
        ORDER BY id DESC
        LIMIT ?`,
      [safeGroupId, safeParticipantJid, safeLimit],
    );
  }

  const remainingCount = await countGroupWarnings({
    groupId: safeGroupId,
    participantJid: safeParticipantJid,
  });
  return {
    removedCount: Math.max(0, beforeCount - remainingCount),
    remainingCount,
  };
};
