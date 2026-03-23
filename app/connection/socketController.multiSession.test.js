import test from 'node:test';
import assert from 'node:assert/strict';

import { createGroupOwnerWriteStateResolver } from './groupOwnerWriteStateResolver.js';

const createCache = () => {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
      return true;
    },
    del: (key) => map.delete(key),
    keys: () => Array.from(map.keys()),
  };
};

const buildCacheKey = (groupJid, sessionId) => `${sessionId}:${groupJid}`;

const normalizeSessionId = (value) => String(value || '').trim() || 'default';
const isGroupJid = (jid) => String(jid || '').endsWith('@g.us');

test('socketController multi-session: fencing token por assignment_version invalida writer stale', async () => {
  let ownerState = {
    ownerSessionId: 'session-a',
    assignmentVersion: 1,
  };

  const resolver = createGroupOwnerWriteStateResolver({
    buildCacheKeyImpl: buildCacheKey,
    getOwnerImpl: async () => ownerState,
    tryAcquireImpl: async () => ({ acquired: false, reason: 'claim_disabled' }),
    cacheImpl: createCache(),
    isGroupJidImpl: isGroupJid,
    normalizeSessionIdImpl: normalizeSessionId,
    loggerImpl: { warn: () => {} },
  });

  const first = await resolver('120363555555555555@g.us', 'session-a', {
    allowClaim: false,
    source: 'test_first',
  });
  assert.equal(first.allowed, true);
  assert.equal(first.assignmentVersion, 1);

  ownerState = {
    ownerSessionId: 'session-a',
    assignmentVersion: 2,
  };

  const stale = await resolver('120363555555555555@g.us', 'session-a', {
    allowClaim: false,
    source: 'test_stale',
    expectedAssignmentVersion: 1,
    enforceFence: true,
  });
  assert.equal(stale.allowed, false);
  assert.equal(stale.reason, 'fence_token_mismatch');
  assert.equal(stale.assignmentVersion, 2);
});

test('socketController multi-session: sessão antiga perde escrita após failover de owner', async () => {
  let ownerState = {
    ownerSessionId: 'session-a',
    assignmentVersion: 7,
  };

  const resolver = createGroupOwnerWriteStateResolver({
    buildCacheKeyImpl: buildCacheKey,
    getOwnerImpl: async () => ownerState,
    tryAcquireImpl: async () => ({ acquired: false, reason: 'claim_disabled' }),
    cacheImpl: createCache(),
    isGroupJidImpl: isGroupJid,
    normalizeSessionIdImpl: normalizeSessionId,
    loggerImpl: { warn: () => {} },
  });

  const beforeFailover = await resolver('120363666666666666@g.us', 'session-a', {
    allowClaim: false,
    source: 'before_failover',
  });
  assert.equal(beforeFailover.allowed, true);
  assert.equal(beforeFailover.assignmentVersion, 7);

  ownerState = {
    ownerSessionId: 'session-b',
    assignmentVersion: 8,
  };

  const staleOwner = await resolver('120363666666666666@g.us', 'session-a', {
    allowClaim: false,
    source: 'after_failover_old_owner',
    expectedAssignmentVersion: 7,
    enforceFence: true,
  });
  assert.equal(staleOwner.allowed, false);
  assert.equal(staleOwner.reason, 'owned_by_other');

  const newOwner = await resolver('120363666666666666@g.us', 'session-b', {
    allowClaim: false,
    source: 'after_failover_new_owner',
    expectedAssignmentVersion: 8,
    enforceFence: true,
  });
  assert.equal(newOwner.allowed, true);
  assert.equal(newOwner.assignmentVersion, 8);
});
