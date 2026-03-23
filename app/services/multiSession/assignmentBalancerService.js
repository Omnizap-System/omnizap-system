import logger from '#logger';
import { executeQuery, TABLES, withTransaction } from '../../../database/index.js';
import { getActiveSocketsBySession, getMultiSessionRuntimeConfig, isSocketOpen, parseEnvInt } from '../../config/index.js';
import groupOwnershipService, { recordHistory as recordGroupOwnerHistory } from './groupOwnershipService.js';

const runtimeConfig = getMultiSessionRuntimeConfig();
const SESSION_IDS = Array.isArray(runtimeConfig?.sessionIds) && runtimeConfig.sessionIds.length > 0 ? runtimeConfig.sessionIds : ['default'];
const PRIMARY_SESSION_ID = String(runtimeConfig?.primarySessionId || SESSION_IDS[0] || 'default').trim() || 'default';

const GROUP_BALANCER_ENABLED = runtimeConfig?.balancerEnabled === true;
const GROUP_OWNER_LEASE_MS = Math.max(5_000, Number(runtimeConfig?.ownerLeaseMs) || 120_000);

const BALANCER_START_DELAY_MS = parseEnvInt(process.env.GROUP_BALANCER_START_DELAY_MS, 20_000, 1_000, 5 * 60 * 1000);
const BALANCER_INTERVAL_MS = parseEnvInt(process.env.GROUP_BALANCER_INTERVAL_MS, 60_000, 10_000, 15 * 60 * 1000);
const BALANCER_MESSAGES_WINDOW_SECONDS = parseEnvInt(process.env.GROUP_BALANCER_MESSAGES_WINDOW_SECONDS, 60, 30, 30 * 60);
const BALANCER_ERRORS_WINDOW_SECONDS = parseEnvInt(process.env.GROUP_BALANCER_ERRORS_WINDOW_SECONDS, 300, 60, 2 * 60 * 60);
const BALANCER_MAX_MOVES_PER_CYCLE = parseEnvInt(process.env.GROUP_BALANCER_MAX_MOVES_PER_CYCLE, Math.max(1, Math.ceil(SESSION_IDS.length / 2)), 1, 500);
const BALANCER_GROUP_COOLDOWN_MS = parseEnvInt(process.env.GROUP_BALANCER_GROUP_COOLDOWN_MS, 5 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000);

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const SCORE_WEIGHT_ACTIVE_GROUPS = parseNumber(process.env.GROUP_BALANCER_SCORE_GROUPS_WEIGHT, 2.0);
const SCORE_WEIGHT_MESSAGES_PER_MIN = parseNumber(process.env.GROUP_BALANCER_SCORE_MESSAGES_WEIGHT, 1.0);
const SCORE_WEIGHT_ERRORS = parseNumber(process.env.GROUP_BALANCER_SCORE_ERRORS_WEIGHT, 3.5);
const SCORE_STICKINESS_BONUS = parseNumber(process.env.GROUP_BALANCER_STICKINESS_BONUS, 1.5);
const SCORE_MIN_IMPROVEMENT = parseNumber(process.env.GROUP_BALANCER_MIN_IMPROVEMENT, 1.0);

const clampNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const normalizeSessionId = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return PRIMARY_SESSION_ID;
  return SESSION_IDS.includes(normalized) ? normalized : PRIMARY_SESSION_ID;
};

const buildInClause = (items = []) => items.map(() => '?').join(', ');

const toMs = (value) => {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const computeSessionScore = (stats = {}) => {
  const groupsOwned = clampNumber(stats.groupsOwned, 0, 0, 100_000);
  const messagesPerMin = clampNumber(stats.messagesPerMin, 0, 0, 1_000_000);
  const errorsRecent = clampNumber(stats.errorsRecent, 0, 0, 1_000_000);
  const sessionWeight = Math.max(1, clampNumber(stats.sessionWeight, 1, 1, 10_000));

  const load = groupsOwned * SCORE_WEIGHT_ACTIVE_GROUPS + messagesPerMin * SCORE_WEIGHT_MESSAGES_PER_MIN + errorsRecent * SCORE_WEIGHT_ERRORS;
  return Number((load / sessionWeight).toFixed(4));
};

const listOnlineSessions = () => {
  const socketsBySession = getActiveSocketsBySession();
  const onlineSessionIds = [];

  for (const sessionId of SESSION_IDS) {
    const socket = socketsBySession.get(sessionId);
    if (isSocketOpen(socket)) {
      onlineSessionIds.push(sessionId);
    }
  }

  return onlineSessionIds;
};

const fetchGroupCountsBySession = async (sessionIds) => {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return new Map();
  const placeholders = buildInClause(sessionIds);
  const rows = await executeQuery(
    `SELECT owner_session_id AS session_id, COUNT(*) AS total
       FROM ${TABLES.GROUP_ASSIGNMENT}
      WHERE owner_session_id IN (${placeholders})
        AND lease_expires_at > UTC_TIMESTAMP()
      GROUP BY owner_session_id`,
    sessionIds,
  );

  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sessionId = normalizeSessionId(row?.session_id);
    counts.set(sessionId, Number(row?.total || 0));
  }
  return counts;
};

const fetchMessagesPerMinuteBySession = async (sessionIds) => {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return new Map();
  const placeholders = buildInClause(sessionIds);
  const sinceDate = new Date(Date.now() - BALANCER_MESSAGES_WINDOW_SECONDS * 1000);
  const rows = await executeQuery(
    `SELECT session_id, COUNT(*) AS total
       FROM ${TABLES.MESSAGES}
      WHERE session_id IN (${placeholders})
        AND timestamp >= ?
      GROUP BY session_id`,
    [...sessionIds, sinceDate],
  );

  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sessionId = normalizeSessionId(row?.session_id);
    counts.set(sessionId, Number(row?.total || 0));
  }
  return counts;
};

const fetchRecentErrorsBySession = async (sessionIds) => {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return new Map();
  const placeholders = buildInClause(sessionIds);
  const sinceDate = new Date(Date.now() - BALANCER_ERRORS_WINDOW_SECONDS * 1000);
  const rows = await executeQuery(
    `SELECT session_id, COUNT(*) AS total
       FROM ${TABLES.MESSAGE_ANALYSIS_EVENT}
      WHERE session_id IN (${placeholders})
        AND created_at >= ?
        AND processing_result = 'error'
      GROUP BY session_id`,
    [...sessionIds, sinceDate],
  );

  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const sessionId = normalizeSessionId(row?.session_id);
    counts.set(sessionId, Number(row?.total || 0));
  }
  return counts;
};

const fetchCandidateAssignments = async (sessionIds) => {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
  const placeholders = buildInClause(sessionIds);
  const rows = await executeQuery(
    `SELECT group_jid, owner_session_id, lease_expires_at, cooldown_until, assignment_version, pinned
       FROM ${TABLES.GROUP_ASSIGNMENT}
      WHERE owner_session_id IN (${placeholders})
        AND lease_expires_at > UTC_TIMESTAMP()
      ORDER BY lease_expires_at DESC`,
    sessionIds,
  );

  return (Array.isArray(rows) ? rows : []).map((row) => ({
    groupJid: String(row?.group_jid || '').trim(),
    ownerSessionId: normalizeSessionId(row?.owner_session_id),
    leaseExpiresAt: row?.lease_expires_at ? new Date(row.lease_expires_at) : null,
    cooldownUntil: row?.cooldown_until ? new Date(row.cooldown_until) : null,
    assignmentVersion: Number(row?.assignment_version || 1),
    pinned: Number(row?.pinned || 0) === 1,
  }));
};

const pickBestTargetSession = (sessionIds, scoreBySession, currentOwnerSessionId) => {
  const candidates = sessionIds
    .filter((sessionId) => sessionId !== currentOwnerSessionId)
    .map((sessionId) => ({
      sessionId,
      score: Number(scoreBySession.get(sessionId) || 0),
    }))
    .sort((a, b) => (a.score === b.score ? a.sessionId.localeCompare(b.sessionId) : a.score - b.score));

  return candidates[0] || null;
};

const rebalanceAssignment = async ({ groupJid, fromSessionId, toSessionId, cycleId, fromScore, toScore }) =>
  withTransaction(async (connection) => {
    const rows = await executeQuery(
      `SELECT group_jid, owner_session_id, assignment_version, pinned, cooldown_until
         FROM ${TABLES.GROUP_ASSIGNMENT}
        WHERE group_jid = ?
        LIMIT 1
        FOR UPDATE`,
      [groupJid],
      connection,
    );

    const current = rows?.[0];
    if (!current) {
      return { moved: false, reason: 'assignment_not_found' };
    }

    const currentOwnerSessionId = normalizeSessionId(current.owner_session_id);
    if (currentOwnerSessionId !== fromSessionId) {
      return { moved: false, reason: 'owner_changed' };
    }

    if (Number(current.pinned || 0) === 1) {
      return { moved: false, reason: 'pinned_assignment' };
    }

    const nowMs = Date.now();
    const cooldownUntilMs = toMs(current.cooldown_until);
    if (cooldownUntilMs > nowMs) {
      return { moved: false, reason: 'cooldown_active' };
    }

    const leaseExpiresAt = new Date(nowMs + GROUP_OWNER_LEASE_MS);
    const cooldownUntil = new Date(nowMs + BALANCER_GROUP_COOLDOWN_MS);
    const nextAssignmentVersion = Number(current.assignment_version || 1) + 1;

    const updateResult = await executeQuery(
      `UPDATE ${TABLES.GROUP_ASSIGNMENT}
          SET owner_session_id = ?,
              lease_expires_at = ?,
              cooldown_until = ?,
              assignment_version = assignment_version + 1,
              last_reason = ?
        WHERE group_jid = ?
          AND owner_session_id = ?`,
      [toSessionId, leaseExpiresAt, cooldownUntil, 'balancer_rebalance', groupJid, fromSessionId],
      connection,
    );

    if (Number(updateResult?.affectedRows || 0) < 1) {
      return { moved: false, reason: 'update_noop' };
    }

    await recordGroupOwnerHistory(
      {
        groupJid,
        previousSessionId: fromSessionId,
        newSessionId: toSessionId,
        reason: 'balancer_rebalance',
        changedBy: 'group_balancer',
        assignmentVersion: nextAssignmentVersion,
        metadata: {
          cycleId,
          fromScore,
          toScore,
        },
      },
      connection,
    );

    return {
      moved: true,
      reason: 'rebalanced',
      groupJid,
      fromSessionId,
      toSessionId,
      assignmentVersion: nextAssignmentVersion,
      cooldownUntil,
    };
  });

let schedulerTimeout = null;
let schedulerInterval = null;
let cycleInProgress = false;
let missingTablesLogged = false;

export const runGroupAssignmentBalancerCycle = async () => {
  if (!GROUP_BALANCER_ENABLED) {
    return {
      moved: 0,
      reason: 'balancer_disabled',
    };
  }

  if (cycleInProgress) {
    return {
      moved: 0,
      reason: 'cycle_in_progress',
    };
  }

  cycleInProgress = true;
  const cycleId = `${Date.now()}:${Math.floor(Math.random() * 10_000)}`;

  try {
    const onlineSessionIds = listOnlineSessions();
    if (onlineSessionIds.length < 2) {
      return {
        moved: 0,
        reason: 'insufficient_online_sessions',
        onlineSessionIds,
      };
    }

    const [groupCounts, messageRates, errorCounts, assignments] = await Promise.all([fetchGroupCountsBySession(onlineSessionIds), fetchMessagesPerMinuteBySession(onlineSessionIds), fetchRecentErrorsBySession(onlineSessionIds), fetchCandidateAssignments(onlineSessionIds)]);

    const nowMs = Date.now();
    const sessionStats = new Map();
    const scoreBySession = new Map();
    for (const sessionId of onlineSessionIds) {
      const sessionWeight = Math.max(1, Number(runtimeConfig?.sessionWeights?.[sessionId] || 1));
      const stats = {
        sessionId,
        groupsOwned: Number(groupCounts.get(sessionId) || 0),
        messagesPerMin: Number(messageRates.get(sessionId) || 0),
        errorsRecent: Number(errorCounts.get(sessionId) || 0),
        sessionWeight,
      };
      sessionStats.set(sessionId, stats);
      scoreBySession.set(sessionId, computeSessionScore(stats));
    }

    const movableAssignments = assignments
      .filter((assignment) => assignment.groupJid && onlineSessionIds.includes(assignment.ownerSessionId))
      .filter((assignment) => assignment.pinned !== true)
      .filter((assignment) => toMs(assignment.cooldownUntil) <= nowMs)
      .sort((a, b) => Number(scoreBySession.get(b.ownerSessionId) || 0) - Number(scoreBySession.get(a.ownerSessionId) || 0));

    if (movableAssignments.length === 0) {
      return {
        moved: 0,
        reason: 'no_movable_assignments',
      };
    }

    const maxMoves = Math.max(1, BALANCER_MAX_MOVES_PER_CYCLE);
    const movedGroups = [];

    for (const assignment of movableAssignments) {
      if (movedGroups.length >= maxMoves) break;

      const fromSessionId = assignment.ownerSessionId;
      const target = pickBestTargetSession(onlineSessionIds, scoreBySession, fromSessionId);
      if (!target) continue;

      const fromScore = Number(scoreBySession.get(fromSessionId) || 0);
      const toScore = Number(target.score || 0);
      const improvement = fromScore - toScore;
      if (improvement <= SCORE_MIN_IMPROVEMENT + SCORE_STICKINESS_BONUS) {
        continue;
      }

      const rebalanceResult = await rebalanceAssignment({
        groupJid: assignment.groupJid,
        fromSessionId,
        toSessionId: target.sessionId,
        cycleId,
        fromScore,
        toScore,
      });
      if (!rebalanceResult?.moved) continue;

      groupOwnershipService.invalidateCache(assignment.groupJid);
      movedGroups.push({
        groupJid: assignment.groupJid,
        fromSessionId,
        toSessionId: target.sessionId,
        fromScore,
        toScore,
      });

      const fromStats = sessionStats.get(fromSessionId);
      const toStats = sessionStats.get(target.sessionId);
      if (fromStats) {
        fromStats.groupsOwned = Math.max(0, Number(fromStats.groupsOwned || 0) - 1);
        scoreBySession.set(fromSessionId, computeSessionScore(fromStats));
      }
      if (toStats) {
        toStats.groupsOwned = Number(toStats.groupsOwned || 0) + 1;
        scoreBySession.set(target.sessionId, computeSessionScore(toStats));
      }
    }

    if (movedGroups.length > 0) {
      logger.info('Balanceador multi-sessão executou rebalance de owners.', {
        action: 'group_balancer_cycle_rebalanced',
        cycleId,
        moved: movedGroups.length,
        movedGroups,
        onlineSessionIds,
      });
    } else {
      logger.debug('Balanceador multi-sessão sem movimentos neste ciclo.', {
        action: 'group_balancer_cycle_noop',
        cycleId,
        onlineSessionIds,
      });
    }

    return {
      moved: movedGroups.length,
      reason: movedGroups.length > 0 ? 'rebalanced' : 'no_better_target',
      movedGroups,
    };
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      if (!missingTablesLogged) {
        missingTablesLogged = true;
        logger.warn('Balanceador de grupos indisponível: tabelas de multi-sessão ausentes.', {
          action: 'group_balancer_tables_missing',
        });
      }
      return {
        moved: 0,
        reason: 'tables_missing',
      };
    }

    logger.error('Falha ao executar ciclo do balanceador multi-sessão.', {
      action: 'group_balancer_cycle_failed',
      error: error?.message,
    });
    throw error;
  } finally {
    cycleInProgress = false;
  }
};

export const startGroupAssignmentBalancer = () => {
  if (!GROUP_BALANCER_ENABLED) {
    logger.info('Balanceador de ownership por grupo desativado.', {
      action: 'group_balancer_disabled',
    });
    return;
  }

  if (schedulerTimeout || schedulerInterval) return;

  logger.info('Iniciando balanceador de ownership por grupo.', {
    action: 'group_balancer_start',
    startDelayMs: BALANCER_START_DELAY_MS,
    intervalMs: BALANCER_INTERVAL_MS,
    maxMovesPerCycle: BALANCER_MAX_MOVES_PER_CYCLE,
    cooldownMs: BALANCER_GROUP_COOLDOWN_MS,
  });

  schedulerTimeout = setTimeout(() => {
    schedulerTimeout = null;
    void runGroupAssignmentBalancerCycle();

    schedulerInterval = setInterval(() => {
      void runGroupAssignmentBalancerCycle();
    }, BALANCER_INTERVAL_MS);

    if (typeof schedulerInterval.unref === 'function') schedulerInterval.unref();
  }, BALANCER_START_DELAY_MS);

  if (typeof schedulerTimeout.unref === 'function') schedulerTimeout.unref();
};

export const stopGroupAssignmentBalancer = () => {
  if (schedulerTimeout) {
    clearTimeout(schedulerTimeout);
    schedulerTimeout = null;
  }
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
};

export const isGroupAssignmentBalancerEnabled = () => GROUP_BALANCER_ENABLED;
