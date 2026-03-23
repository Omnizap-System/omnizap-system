import test from 'node:test';
import assert from 'node:assert/strict';

import { createGroupOwnershipService } from './groupOwnershipService.js';
import { closePool } from '../../../database/index.js';

const cloneDate = (value) => (value instanceof Date ? new Date(value.getTime()) : null);

const createInMemoryRepository = () => {
  const assignments = new Map();
  const history = [];

  const normalizeGroupJid = (value) => {
    const normalized = String(value || '').trim().slice(0, 255);
    return normalized || null;
  };
  const normalizeSessionId = (value) => {
    const normalized = String(value || '').trim().slice(0, 64);
    return normalized || null;
  };
  const normalizeReason = (value) => {
    const normalized = String(value || '').trim().slice(0, 64);
    return normalized || null;
  };
  const normalizeChangedBy = (value) => {
    const normalized = String(value || 'system').trim().slice(0, 64);
    return normalized || 'system';
  };

  const cloneAssignment = (row) => {
    if (!row) return null;
    return {
      groupJid: row.groupJid,
      ownerSessionId: row.ownerSessionId,
      leaseExpiresAt: cloneDate(row.leaseExpiresAt),
      cooldownUntil: cloneDate(row.cooldownUntil),
      assignmentVersion: Number(row.assignmentVersion || 1),
      pinned: row.pinned === true,
      lastReason: row.lastReason || null,
      createdAt: cloneDate(row.createdAt),
      updatedAt: cloneDate(row.updatedAt),
    };
  };

  const upsertAssignment = (assignment) => {
    const now = new Date();
    const current = assignments.get(assignment.groupJid);
    const next = {
      groupJid: assignment.groupJid,
      ownerSessionId: assignment.ownerSessionId,
      leaseExpiresAt: cloneDate(assignment.leaseExpiresAt),
      cooldownUntil: cloneDate(assignment.cooldownUntil),
      assignmentVersion: Number(assignment.assignmentVersion || 1),
      pinned: assignment.pinned === true,
      lastReason: assignment.lastReason || null,
      createdAt: current?.createdAt ? cloneDate(current.createdAt) : now,
      updatedAt: now,
    };
    assignments.set(next.groupJid, next);
    return cloneAssignment(next);
  };

  return {
    normalizeGroupJid,
    normalizeSessionId,
    normalizeReason,
    normalizeChangedBy,
    getAssignment: async (groupJid) => cloneAssignment(assignments.get(normalizeGroupJid(groupJid))),
    getAssignmentForUpdate: async (groupJid) => cloneAssignment(assignments.get(normalizeGroupJid(groupJid))),
    listAssignments: async ({ groupJid = null, ownerSessionId = null, includeExpired = true, limit = 200 } = {}) => {
      const safeGroupJid = normalizeGroupJid(groupJid);
      const safeOwnerSessionId = normalizeSessionId(ownerSessionId);
      const nowMs = Date.now();
      const rows = Array.from(assignments.values())
        .filter((row) => (safeGroupJid ? row.groupJid === safeGroupJid : true))
        .filter((row) => (safeOwnerSessionId ? row.ownerSessionId === safeOwnerSessionId : true))
        .filter((row) => (includeExpired ? true : row.leaseExpiresAt?.getTime?.() > nowMs))
        .slice(0, Math.max(1, Number(limit || 200)));
      return rows.map((row) => cloneAssignment(row));
    },
    createAssignment: async ({ groupJid, ownerSessionId, leaseExpiresAt, cooldownUntil = null, pinned = false, reason = null, assignmentVersion = 1 } = {}) => {
      const safeGroupJid = normalizeGroupJid(groupJid);
      if (!safeGroupJid) {
        throw new Error('groupJid invalido');
      }
      if (assignments.has(safeGroupJid)) {
        const error = new Error('duplicate');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      return upsertAssignment({
        groupJid: safeGroupJid,
        ownerSessionId: normalizeSessionId(ownerSessionId),
        leaseExpiresAt: cloneDate(leaseExpiresAt),
        cooldownUntil: cloneDate(cooldownUntil),
        assignmentVersion: Number(assignmentVersion || 1),
        pinned: pinned === true,
        lastReason: normalizeReason(reason),
      });
    },
    updateAssignmentOwner: async ({ groupJid, ownerSessionId, leaseExpiresAt, reason = null, bumpVersion = true, cooldownUntil = undefined, pinned = undefined } = {}) => {
      const safeGroupJid = normalizeGroupJid(groupJid);
      const current = assignments.get(safeGroupJid);
      if (!current) return null;
      return upsertAssignment({
        ...current,
        ownerSessionId: normalizeSessionId(ownerSessionId) || current.ownerSessionId,
        leaseExpiresAt: cloneDate(leaseExpiresAt),
        cooldownUntil: cooldownUntil === undefined ? current.cooldownUntil : cloneDate(cooldownUntil),
        pinned: pinned === undefined ? current.pinned : pinned === true,
        lastReason: normalizeReason(reason),
        assignmentVersion: bumpVersion ? Number(current.assignmentVersion || 1) + 1 : Number(current.assignmentVersion || 1),
      });
    },
    updateAssignmentLease: async ({ groupJid, ownerSessionId, leaseExpiresAt, reason = undefined } = {}) => {
      const safeGroupJid = normalizeGroupJid(groupJid);
      const current = assignments.get(safeGroupJid);
      if (!current) return null;
      if (current.ownerSessionId !== normalizeSessionId(ownerSessionId)) return cloneAssignment(current);
      return upsertAssignment({
        ...current,
        leaseExpiresAt: cloneDate(leaseExpiresAt),
        lastReason: reason === undefined ? current.lastReason : normalizeReason(reason),
      });
    },
    expireAssignment: async ({ groupJid, ownerSessionId = null, reason = null, bumpVersion = true, leaseExpiresAt = new Date() } = {}) => {
      const safeGroupJid = normalizeGroupJid(groupJid);
      const current = assignments.get(safeGroupJid);
      if (!current) return null;
      const safeOwnerSessionId = normalizeSessionId(ownerSessionId);
      if (safeOwnerSessionId && current.ownerSessionId !== safeOwnerSessionId) return cloneAssignment(current);
      return upsertAssignment({
        ...current,
        leaseExpiresAt: cloneDate(leaseExpiresAt),
        lastReason: normalizeReason(reason),
        assignmentVersion: bumpVersion ? Number(current.assignmentVersion || 1) + 1 : Number(current.assignmentVersion || 1),
      });
    },
    renewLeasesByOwner: async ({ ownerSessionId, leaseExpiresAt, reason = null, now = undefined } = {}) => {
      const safeOwnerSessionId = normalizeSessionId(ownerSessionId);
      const safeNow = now instanceof Date ? now.getTime() : Date.now();
      let renewed = 0;
      for (const current of assignments.values()) {
        if (current.ownerSessionId !== safeOwnerSessionId) continue;
        if ((current.leaseExpiresAt?.getTime?.() || 0) <= safeNow) continue;
        upsertAssignment({
          ...current,
          leaseExpiresAt: cloneDate(leaseExpiresAt),
          lastReason: normalizeReason(reason),
        });
        renewed += 1;
      }
      return renewed;
    },
    insertAssignmentHistory: async ({ groupJid, previousSessionId = null, newSessionId, changeReason = null, changedBy = 'system', assignmentVersion = 1, metadata = null } = {}) => {
      history.push({
        groupJid: normalizeGroupJid(groupJid),
        previousSessionId: normalizeSessionId(previousSessionId),
        newSessionId: normalizeSessionId(newSessionId),
        changeReason: normalizeReason(changeReason),
        changedBy: normalizeChangedBy(changedBy),
        assignmentVersion: Number(assignmentVersion || 1),
        metadata,
      });
      return { id: history.length };
    },
    __state: {
      assignments,
      history,
    },
  };
};

const createSessionRegistryMock = () => ({
  ensureSession: async () => ({ ok: true }),
  heartbeatSession: async () => ({ ok: true }),
});

const createService = ({ nowRef }) => {
  const repository = createInMemoryRepository();
  const sessionRegistry = createSessionRegistryMock();
  const service = createGroupOwnershipService({
    repository,
    sessionRegistry,
    withTransactionImpl: async (handler) => handler({}),
    nowImpl: () => nowRef.value,
    loggerImpl: { warn: () => {} },
    cacheTtlMs: 1,
  });
  return { service, repository };
};

test.after(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 200);
  });
  await closePool();
});

test('groupOwnershipService: claim concorrente no mesmo grupo resulta em owner unico', async () => {
  const nowRef = { value: 1_000 };
  const { service } = createService({ nowRef });

  const [left, right] = await Promise.all([
    service.tryAcquire({
      groupJid: '120363222222222222@g.us',
      sessionId: 'session-a',
      reason: 'claim_a',
    }),
    service.tryAcquire({
      groupJid: '120363222222222222@g.us',
      sessionId: 'session-b',
      reason: 'claim_b',
    }),
  ]);

  const acquiredCount = [left, right].filter((item) => item?.acquired).length;
  assert.equal(acquiredCount, 1);

  const owner = await service.getOwner('120363222222222222@g.us', { bypassCache: true });
  assert.ok(owner);
  assert.equal(owner.assignmentVersion, 1);
  assert.ok(owner.ownerSessionId === 'session-a' || owner.ownerSessionId === 'session-b');
});

test('groupOwnershipService: heartbeat renova lease e failover ocorre apos expirar', async () => {
  const nowRef = { value: 10_000 };
  const { service } = createService({ nowRef });
  const groupJid = '120363333333333333@g.us';

  const firstClaim = await service.tryAcquire({
    groupJid,
    sessionId: 'session-a',
    leaseMs: 2_000,
  });
  assert.equal(firstClaim.acquired, true);
  assert.equal(firstClaim.assignmentVersion, 1);

  nowRef.value += 1_000;
  const heartbeat = await service.heartbeatOwnerSession({
    sessionId: 'session-a',
    leaseMs: 2_000,
    reason: 'test_heartbeat',
  });
  assert.ok(heartbeat.renewedAssignments >= 1);

  nowRef.value = heartbeat.leaseExpiresAt.getTime() + 10;
  const failover = await service.tryAcquire({
    groupJid,
    sessionId: 'session-b',
    leaseMs: 2_000,
    reason: 'failover_after_expiry',
  });

  assert.equal(failover.acquired, true);
  assert.equal(failover.reason, 'reassigned');
  assert.equal(failover.assignmentVersion, 2);

  const owner = await service.getOwner(groupJid, { bypassCache: true });
  assert.equal(owner?.ownerSessionId, 'session-b');
  assert.equal(owner?.assignmentVersion, 2);
});

test('groupOwnershipService: fence token com assignment_version invalida sessao com token antigo', async () => {
  const nowRef = { value: 50_000 };
  const { service } = createService({ nowRef });
  const groupJid = '120363444444444444@g.us';

  const claimed = await service.tryAcquire({
    groupJid,
    sessionId: 'session-a',
    leaseMs: 5_000,
    reason: 'initial_claim',
  });
  assert.equal(claimed.acquired, true);
  assert.equal(claimed.assignmentVersion, 1);

  const tokenBefore = service.buildFencingToken({
    groupJid,
    ownerSessionId: 'session-a',
    assignmentVersion: 1,
  });
  assert.equal(tokenBefore, `${groupJid}:session-a:1`);

  const forced = await service.forceAssign({
    groupJid,
    sessionId: 'session-b',
    reason: 'forced_failover',
    changedBy: 'test',
  });
  assert.equal(forced.reassigned, true);
  assert.equal(forced.assignmentVersion, 2);

  const oldTokenValidation = await service.validateFenceToken({
    groupJid,
    sessionId: 'session-a',
    assignmentVersion: 1,
    bypassCache: true,
  });
  assert.equal(oldTokenValidation.valid, false);

  const newTokenValidation = await service.validateFenceToken({
    groupJid,
    sessionId: 'session-b',
    assignmentVersion: 2,
    bypassCache: true,
  });
  assert.equal(newTokenValidation.valid, true);
});
