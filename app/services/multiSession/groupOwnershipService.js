import logger from '#logger';
import { withTransaction } from '../../../database/index.js';
import { getMultiSessionRuntimeConfig } from '../../configParts/sessionConfig.js';
import * as groupOwnershipRepository from './groupOwnershipRepository.js';
import sessionRegistryService from './sessionRegistryService.js';

const runtimeConfig = getMultiSessionRuntimeConfig();
const DEFAULT_LEASE_MS = Math.max(5_000, Number(runtimeConfig?.ownerLeaseMs) || 120_000);
const DEFAULT_CACHE_TTL_MS = Math.max(250, Math.min(5_000, Math.floor((Number(runtimeConfig?.ownerHeartbeatMs) || 30_000) / 4)));
const DEFAULT_CACHE_MAX_ENTRIES = 10_000;
const DUPLICATE_KEY_ERRORS = new Set(['ER_DUP_ENTRY', 'ER_DUP_KEY']);

const parsePositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const isDuplicateError = (error) => {
  const code = String(error?.code || error?.originalError?.code || '');
  return DUPLICATE_KEY_ERRORS.has(code);
};

const hasActiveLease = (assignment, nowMs) => {
  const leaseMs = assignment?.leaseExpiresAt instanceof Date ? assignment.leaseExpiresAt.getTime() : Number.NaN;
  return Number.isFinite(leaseMs) && leaseMs > nowMs;
};

const cloneDate = (value) => (value instanceof Date ? new Date(value.getTime()) : null);

const toOwnerState = (assignment, nowMs) => {
  if (!assignment) return null;
  if (!hasActiveLease(assignment, nowMs)) return null;

  return {
    groupJid: assignment.groupJid,
    ownerSessionId: assignment.ownerSessionId,
    leaseExpiresAt: cloneDate(assignment.leaseExpiresAt),
    cooldownUntil: cloneDate(assignment.cooldownUntil),
    assignmentVersion: Number(assignment.assignmentVersion || 1),
    pinned: assignment.pinned === true,
    lastReason: assignment.lastReason || null,
    createdAt: cloneDate(assignment.createdAt),
    updatedAt: cloneDate(assignment.updatedAt),
  };
};

const cloneOwnerState = (ownerState) => {
  if (!ownerState) return null;
  return {
    ...ownerState,
    leaseExpiresAt: cloneDate(ownerState.leaseExpiresAt),
    cooldownUntil: cloneDate(ownerState.cooldownUntil),
    createdAt: cloneDate(ownerState.createdAt),
    updatedAt: cloneDate(ownerState.updatedAt),
  };
};

const cloneOutcome = (outcome = null) => {
  if (!outcome || typeof outcome !== 'object') return outcome;
  return {
    ...outcome,
    owner: cloneOwnerState(outcome.owner),
  };
};

export const createGroupOwnershipService = ({
  repository = groupOwnershipRepository,
  sessionRegistry = sessionRegistryService,
  withTransactionImpl = withTransaction,
  nowImpl = () => Date.now(),
  loggerImpl = logger,
  defaultLeaseMs = DEFAULT_LEASE_MS,
  cacheTtlMs = parsePositiveInt(process.env.GROUP_OWNER_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 250, 10_000),
  cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
} = {}) => {
  const ownerCache = new Map();
  const safeDefaultLeaseMs = parsePositiveInt(defaultLeaseMs, DEFAULT_LEASE_MS, 5_000, 15 * 60 * 1000);
  const safeCacheTtlMs = parsePositiveInt(cacheTtlMs, DEFAULT_CACHE_TTL_MS, 250, 10_000);
  const safeCacheMaxEntries = parsePositiveInt(cacheMaxEntries, DEFAULT_CACHE_MAX_ENTRIES, 10, 100_000);

  const getCacheEntry = (groupJid, nowMs = nowImpl()) => {
    const cached = ownerCache.get(groupJid);
    if (!cached) return null;
    if (cached.expiresAtMs <= nowMs) {
      ownerCache.delete(groupJid);
      return null;
    }
    return cached;
  };

  const setCacheEntry = (groupJid, ownerState, nowMs = nowImpl()) => {
    ownerCache.delete(groupJid);
    ownerCache.set(groupJid, {
      owner: cloneOwnerState(ownerState),
      expiresAtMs: nowMs + safeCacheTtlMs,
    });

    while (ownerCache.size > safeCacheMaxEntries) {
      const firstKey = ownerCache.keys().next()?.value;
      if (!firstKey) break;
      ownerCache.delete(firstKey);
    }
  };

  const invalidateCache = (groupJid) => {
    const safeGroupJid = repository.normalizeGroupJid(groupJid);
    if (!safeGroupJid) return false;
    return ownerCache.delete(safeGroupJid);
  };

  const clearCache = () => {
    ownerCache.clear();
  };

  const resolveLeaseMs = (leaseMs) => parsePositiveInt(leaseMs, safeDefaultLeaseMs, 5_000, 15 * 60 * 1000);

  const resolveHistoryVersion = async (groupJid, assignmentVersion, connection = null) => {
    const safeVersion = Number.parseInt(String(assignmentVersion ?? ''), 10);
    if (Number.isFinite(safeVersion) && safeVersion > 0) return safeVersion;
    const assignment = await repository.getAssignment(groupJid, connection);
    return Number(assignment?.assignmentVersion || 1);
  };

  const recordHistory = async (
    {
      groupJid,
      previousSessionId = null,
      newSessionId = null,
      reason = null,
      changedBy = 'system',
      assignmentVersion = null,
      metadata = null,
    } = {},
    connection = null,
  ) => {
    const safeGroupJid = repository.normalizeGroupJid(groupJid);
    const safePreviousSessionId = repository.normalizeSessionId(previousSessionId);
    const safeNewSessionId = repository.normalizeSessionId(newSessionId) || safePreviousSessionId;
    if (!safeGroupJid || !safeNewSessionId) {
      throw new Error('recordHistory requer groupJid e newSessionId validos.');
    }

    const safeVersion = await resolveHistoryVersion(safeGroupJid, assignmentVersion, connection);
    return repository.insertAssignmentHistory(
      {
        groupJid: safeGroupJid,
        previousSessionId: safePreviousSessionId,
        newSessionId: safeNewSessionId,
        changeReason: reason,
        changedBy,
        assignmentVersion: safeVersion,
        metadata,
      },
      connection,
    );
  };

  const getOwner = async (groupJid, { bypassCache = false } = {}) => {
    const safeGroupJid = repository.normalizeGroupJid(groupJid);
    if (!safeGroupJid) return null;

    const nowMs = nowImpl();
    if (!bypassCache) {
      const cached = getCacheEntry(safeGroupJid, nowMs);
      if (cached) return cloneOwnerState(cached.owner);
    }

    const assignment = await repository.getAssignment(safeGroupJid);
    const ownerState = toOwnerState(assignment, nowMs);
    setCacheEntry(safeGroupJid, ownerState, nowMs);
    return cloneOwnerState(ownerState);
  };

  const tryAcquire = async (
    {
      groupJid,
      sessionId,
      leaseMs = safeDefaultLeaseMs,
      reason = 'claim',
      changedBy = null,
      metadata = null,
    } = {},
  ) => {
    const safeGroupJid = repository.normalizeGroupJid(groupJid);
    const safeSessionId = repository.normalizeSessionId(sessionId);
    if (!safeGroupJid || !safeSessionId) {
      throw new Error('tryAcquire requer groupJid e sessionId validos.');
    }

    const safeLeaseMs = resolveLeaseMs(leaseMs);
    const safeChangedBy = repository.normalizeChangedBy(changedBy || safeSessionId || 'system');
    const safeReason = repository.normalizeReason(reason) || 'claim';

    const outcome = await withTransactionImpl(async (connection) => {
      await sessionRegistry.ensureSession(safeSessionId, { status: 'online', connection });

      let current = await repository.getAssignmentForUpdate(safeGroupJid, connection);
      const nowMs = nowImpl();
      const leaseExpiresAt = new Date(nowMs + safeLeaseMs);

      if (!current) {
        try {
          const created = await repository.createAssignment(
            {
              groupJid: safeGroupJid,
              ownerSessionId: safeSessionId,
              leaseExpiresAt,
              reason: safeReason,
              assignmentVersion: 1,
            },
            connection,
          );

          const assignmentVersion = Number(created?.assignmentVersion || 1);
          await recordHistory(
            {
              groupJid: safeGroupJid,
              previousSessionId: null,
              newSessionId: safeSessionId,
              reason: safeReason,
              changedBy: safeChangedBy,
              assignmentVersion,
              metadata,
            },
            connection,
          );

          return {
            acquired: true,
            owner: toOwnerState(created, nowMs),
            reason: 'created',
            assignmentVersion,
            previousOwnerSessionId: null,
          };
        } catch (error) {
          if (!isDuplicateError(error)) {
            throw error;
          }

          loggerImpl.warn('Conflito de claim concorrente detectado; aplicando fallback transacional.', {
            action: 'group_owner_claim_conflict_fallback',
            groupJid: safeGroupJid,
            sessionId: safeSessionId,
          });
          current = await repository.getAssignmentForUpdate(safeGroupJid, connection);
        }
      }

      if (!current) {
        return {
          acquired: false,
          owner: null,
          reason: 'claim_lost',
          assignmentVersion: null,
          previousOwnerSessionId: null,
        };
      }

      const leaseIsActive = hasActiveLease(current, nowMs);
      if (leaseIsActive && current.ownerSessionId !== safeSessionId) {
        return {
          acquired: false,
          owner: toOwnerState(current, nowMs),
          reason: 'owned_by_other',
          assignmentVersion: current.assignmentVersion,
          previousOwnerSessionId: current.ownerSessionId,
        };
      }

      if (current.ownerSessionId === safeSessionId) {
        const renewed = await repository.updateAssignmentLease(
          {
            groupJid: safeGroupJid,
            ownerSessionId: safeSessionId,
            leaseExpiresAt,
            reason: safeReason,
          },
          connection,
        );

        return {
          acquired: true,
          owner: toOwnerState(renewed, nowMs),
          reason: 'already_owner',
          assignmentVersion: Number(renewed?.assignmentVersion || current.assignmentVersion || 1),
          previousOwnerSessionId: current.ownerSessionId,
        };
      }

      const updated = await repository.updateAssignmentOwner(
        {
          groupJid: safeGroupJid,
          ownerSessionId: safeSessionId,
          leaseExpiresAt,
          reason: safeReason,
          bumpVersion: true,
        },
        connection,
      );
      const assignmentVersion = Number(updated?.assignmentVersion || current.assignmentVersion + 1);

      await recordHistory(
        {
          groupJid: safeGroupJid,
          previousSessionId: current.ownerSessionId,
          newSessionId: safeSessionId,
          reason: safeReason,
          changedBy: safeChangedBy,
          assignmentVersion,
          metadata,
        },
        connection,
      );

      return {
        acquired: true,
        owner: toOwnerState(updated, nowMs),
        reason: 'reassigned',
        assignmentVersion,
        previousOwnerSessionId: current.ownerSessionId,
      };
    });

    setCacheEntry(safeGroupJid, outcome.owner ?? null);
    return cloneOutcome(outcome);
  };

  const renewLease = async (
    {
      groupJid,
      sessionId,
      leaseMs = safeDefaultLeaseMs,
      reason = 'renew',
    } = {},
  ) => {
    const safeGroupJid = repository.normalizeGroupJid(groupJid);
    const safeSessionId = repository.normalizeSessionId(sessionId);
    if (!safeGroupJid || !safeSessionId) {
      throw new Error('renewLease requer groupJid e sessionId validos.');
    }

    const safeLeaseMs = resolveLeaseMs(leaseMs);
    const safeReason = repository.normalizeReason(reason) || 'renew';

    const outcome = await withTransactionImpl(async (connection) => {
      const nowMs = nowImpl();
      const current = await repository.getAssignmentForUpdate(safeGroupJid, connection);
      if (!current) {
        return {
          renewed: false,
          owner: null,
          reason: 'not_found',
          assignmentVersion: null,
        };
      }

      if (current.ownerSessionId !== safeSessionId) {
        return {
          renewed: false,
          owner: toOwnerState(current, nowMs),
          reason: 'not_owner',
          assignmentVersion: Number(current.assignmentVersion || 1),
        };
      }

      const leaseExpiresAt = new Date(nowMs + safeLeaseMs);
      const updated = await repository.updateAssignmentLease(
        {
          groupJid: safeGroupJid,
          ownerSessionId: safeSessionId,
          leaseExpiresAt,
          reason: safeReason,
        },
        connection,
      );

      return {
        renewed: true,
        owner: toOwnerState(updated, nowMs),
        reason: 'renewed',
        assignmentVersion: Number(updated?.assignmentVersion || current.assignmentVersion || 1),
      };
    });

    setCacheEntry(safeGroupJid, outcome.owner ?? null);
    return cloneOutcome(outcome);
  };

  const release = async (
    {
      groupJid,
      sessionId = null,
      reason = 'release',
      changedBy = null,
      metadata = null,
    } = {},
  ) => {
    const safeGroupJid = repository.normalizeGroupJid(groupJid);
    const safeSessionId = repository.normalizeSessionId(sessionId);
    if (!safeGroupJid) {
      throw new Error('release requer groupJid valido.');
    }

    const safeReason = repository.normalizeReason(reason) || 'release';
    const safeChangedBy = repository.normalizeChangedBy(changedBy || safeSessionId || 'system');

    const outcome = await withTransactionImpl(async (connection) => {
      const nowMs = nowImpl();
      const current = await repository.getAssignmentForUpdate(safeGroupJid, connection);
      if (!current) {
        return {
          released: false,
          owner: null,
          reason: 'not_found',
          assignmentVersion: null,
          previousOwnerSessionId: null,
        };
      }

      const leaseIsActive = hasActiveLease(current, nowMs);
      if (safeSessionId && current.ownerSessionId !== safeSessionId && leaseIsActive) {
        return {
          released: false,
          owner: toOwnerState(current, nowMs),
          reason: 'not_owner',
          assignmentVersion: Number(current.assignmentVersion || 1),
          previousOwnerSessionId: current.ownerSessionId,
        };
      }

      const ownerFilter = safeSessionId && current.ownerSessionId === safeSessionId ? safeSessionId : null;

      const expired = await repository.expireAssignment(
        {
          groupJid: safeGroupJid,
          ownerSessionId: ownerFilter,
          reason: safeReason,
          bumpVersion: leaseIsActive,
          leaseExpiresAt: new Date(nowMs),
        },
        connection,
      );

      const assignmentVersion = Number(expired?.assignmentVersion || (leaseIsActive ? Number(current.assignmentVersion || 1) + 1 : Number(current.assignmentVersion || 1)));

      if (leaseIsActive && current.ownerSessionId) {
        await recordHistory(
          {
            groupJid: safeGroupJid,
            previousSessionId: current.ownerSessionId,
            newSessionId: current.ownerSessionId,
            reason: safeReason,
            changedBy: safeChangedBy,
            assignmentVersion,
            metadata,
          },
          connection,
        );
      }

      return {
        released: true,
        owner: null,
        reason: 'released',
        assignmentVersion,
        previousOwnerSessionId: current.ownerSessionId,
      };
    });

    if (outcome.released) {
      setCacheEntry(safeGroupJid, null);
    } else {
      setCacheEntry(safeGroupJid, outcome.owner ?? null);
    }
    return cloneOutcome(outcome);
  };

  const getCacheStats = () => ({
    size: ownerCache.size,
    ttlMs: safeCacheTtlMs,
  });

  return {
    getOwner,
    tryAcquire,
    renewLease,
    release,
    recordHistory,
    invalidateCache,
    clearCache,
    getCacheStats,
  };
};

const groupOwnershipService = createGroupOwnershipService();

export const getOwner = (...args) => groupOwnershipService.getOwner(...args);
export const tryAcquire = (...args) => groupOwnershipService.tryAcquire(...args);
export const renewLease = (...args) => groupOwnershipService.renewLease(...args);
export const release = (...args) => groupOwnershipService.release(...args);
export const recordHistory = (...args) => groupOwnershipService.recordHistory(...args);

export default groupOwnershipService;
