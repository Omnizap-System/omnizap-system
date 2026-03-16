import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { executeQuery, TABLES } from '../../../database/index.js';
import logger from '#logger';
import { getEmptyStickerPackEngagement, getStickerPackEngagementByPackId } from './stickerPackEngagementRepository.js';
import { listStickerPackItems } from './stickerPackItemRepository.js';
import { listStickerClassificationsByAssetIds } from './stickerAssetClassificationRepository.js';
import { getPackClassificationSummaryByAssetIds } from './stickerClassificationService.js';
import { listStickerPackInteractionStatsByPackIds } from './stickerPackInteractionEventRepository.js';
import { getMarketplaceDriftSnapshot } from './stickerMarketplaceDriftService.js';
import { computePackSignals } from './stickerPackMarketplaceService.js';
import { removeSnapshotsForDeletedPacks, upsertStickerPackScoreSnapshots } from './stickerPackScoreSnapshotRepository.js';
import { setQueueDepth } from '../../observability/metrics.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const SNAPSHOT_ENABLED = parseEnvBool(process.env.STICKER_SCORE_SNAPSHOT_ENABLED, true);
const SNAPSHOT_STARTUP_DELAY_MS = Math.max(1_000, Number(process.env.STICKER_SCORE_SNAPSHOT_STARTUP_DELAY_MS) || 20_000);
const SNAPSHOT_REFRESH_INTERVAL_MS = Math.max(30_000, Number(process.env.STICKER_SCORE_SNAPSHOT_REFRESH_INTERVAL_MS) || 5 * 60_000);
const SNAPSHOT_BATCH_SIZE = Math.max(10, Math.min(500, Number(process.env.STICKER_SCORE_SNAPSHOT_BATCH_SIZE) || 120));
const SNAPSHOT_TARGETED_BATCH_SIZE = Math.max(5, Math.min(200, Number(process.env.STICKER_SCORE_SNAPSHOT_TARGETED_BATCH_SIZE) || 60));
const SNAPSHOT_SOURCE_VERSION = String(process.env.STICKER_SCORE_SNAPSHOT_SOURCE_VERSION || 'v1').trim() || 'v1';
const SNAPSHOT_MAX_PENDING_PACKS = Math.max(20, Math.min(20_000, Number(process.env.STICKER_SCORE_SNAPSHOT_MAX_PENDING_PACKS) || 2_000));
const SNAPSHOT_FULL_REBUILD_EVERY_CYCLES = Math.max(1, Math.min(500, Number(process.env.STICKER_SCORE_SNAPSHOT_FULL_REBUILD_EVERY_CYCLES) || 12));

let startupHandle = null;
let cycleHandle = null;
let running = false;
let cycleCounter = 0;
const pendingPackIds = new Set();

const listPublishedCatalogPacks = async ({ limit = SNAPSHOT_BATCH_SIZE, offset = 0 } = {}) => {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || SNAPSHOT_BATCH_SIZE));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const rows = await executeQuery(
    `SELECT id, owner_jid, name, publisher, description, pack_key, cover_sticker_id, visibility, status, pack_status, is_auto_pack, updated_at, created_at
       FROM ${TABLES.STICKER_PACK}
      WHERE deleted_at IS NULL
        AND status = 'published'
        AND COALESCE(pack_status, 'ready') = 'ready'
        AND visibility IN ('public', 'unlisted')
      ORDER BY updated_at DESC, id DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [],
  );
  return Array.isArray(rows) ? rows : [];
};

const listPacksByIdsForSnapshot = async (packIds = []) => {
  const ids = Array.from(new Set((Array.isArray(packIds) ? packIds : []).filter(Boolean)));
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await executeQuery(
    `SELECT id, owner_jid, name, publisher, description, pack_key, cover_sticker_id, visibility, status, pack_status, is_auto_pack, updated_at, created_at
       FROM ${TABLES.STICKER_PACK}
      WHERE id IN (${placeholders})
        AND deleted_at IS NULL
        AND status = 'published'
        AND COALESCE(pack_status, 'ready') = 'ready'
        AND visibility IN ('public', 'unlisted')`,
    ids,
  );
  return Array.isArray(rows) ? rows : [];
};

const buildSnapshotForPack = async ({ pack, driftWeights }) => {
  const items = await listStickerPackItems(pack.id);
  const stickerIds = items.map((item) => item.sticker_id).filter(Boolean);
  const [packClassification, itemClassifications, engagement, interactionStatsByPackId] = await Promise.all([getPackClassificationSummaryByAssetIds(stickerIds), stickerIds.length ? listStickerClassificationsByAssetIds(stickerIds) : Promise.resolve([]), getStickerPackEngagementByPackId(pack.id), listStickerPackInteractionStatsByPackIds([pack.id])]);

  const byAssetId = new Map((Array.isArray(itemClassifications) ? itemClassifications : []).map((entry) => [entry.asset_id, entry]));
  const orderedClassifications = stickerIds.map((id) => byAssetId.get(id)).filter(Boolean);
  const signals = computePackSignals({
    pack: { ...pack, items },
    engagement: engagement || getEmptyStickerPackEngagement(),
    packClassification,
    itemClassifications: orderedClassifications,
    interactionStats: interactionStatsByPackId.get(pack.id) || null,
    scoringWeights: driftWeights || null,
  });

  return {
    pack_id: pack.id,
    signals,
    tags: Array.isArray(packClassification?.tags) ? packClassification.tags : [],
    sticker_count: items.length,
    source_version: SNAPSHOT_SOURCE_VERSION,
  };
};

const rebuildSnapshotsForPacks = async (packs = []) => {
  if (!packs.length) return { scanned: 0, written: 0 };
  const driftSnapshot = await getMarketplaceDriftSnapshot();
  const driftWeights = driftSnapshot?.weights || null;
  const snapshots = [];
  let scanned = 0;

  for (const pack of packs) {
    scanned += 1;
    try {
      const snapshot = await buildSnapshotForPack({ pack, driftWeights });
      snapshots.push(snapshot);
    } catch (error) {
      logger.warn('Falha ao montar snapshot de score do pack.', {
        action: 'sticker_pack_score_snapshot_build_failed',
        pack_id: pack?.id || null,
        error: error?.message,
      });
    }
  }

  const written = await upsertStickerPackScoreSnapshots(snapshots);
  return { scanned, written };
};

const consumePendingPackIds = (limit = SNAPSHOT_TARGETED_BATCH_SIZE) => {
  const consumed = [];
  for (const packId of pendingPackIds) {
    consumed.push(packId);
    pendingPackIds.delete(packId);
    if (consumed.length >= limit) break;
  }
  return consumed;
};

export const enqueuePackScoreSnapshotRefresh = (packIds = []) => {
  const ids = Array.isArray(packIds) ? packIds : [packIds];
  ids.forEach((packId) => {
    const normalized = String(packId || '').trim();
    if (!normalized) return;
    if (pendingPackIds.size >= SNAPSHOT_MAX_PENDING_PACKS) return;
    pendingPackIds.add(normalized);
  });
  setQueueDepth('sticker_pack_score_snapshot_pending', pendingPackIds.size);
};

export const runStickerPackScoreSnapshotCycle = async () => {
  if (!SNAPSHOT_ENABLED) {
    return {
      executed: false,
      reason: 'disabled',
      pending_pack_ids: pendingPackIds.size,
    };
  }
  if (running) {
    return {
      executed: false,
      reason: 'already_running',
      pending_pack_ids: pendingPackIds.size,
    };
  }

  running = true;
  const startedAt = __timeNowMs();
  let scanned = 0;
  let written = 0;
  let fullRebuildExecuted = false;

  try {
    const targetedPackIds = consumePendingPackIds(SNAPSHOT_TARGETED_BATCH_SIZE);
    if (targetedPackIds.length) {
      const targetedPacks = await listPacksByIdsForSnapshot(targetedPackIds);
      const targetedResult = await rebuildSnapshotsForPacks(targetedPacks);
      scanned += targetedResult.scanned;
      written += targetedResult.written;
    }

    cycleCounter += 1;
    fullRebuildExecuted = cycleCounter % SNAPSHOT_FULL_REBUILD_EVERY_CYCLES === 0 || targetedPackIds.length === 0;

    if (fullRebuildExecuted) {
      let offset = 0;
      while (true) {
        const packs = await listPublishedCatalogPacks({
          limit: SNAPSHOT_BATCH_SIZE,
          offset,
        });
        if (!packs.length) break;
        const result = await rebuildSnapshotsForPacks(packs);
        scanned += result.scanned;
        written += result.written;
        offset += packs.length;
        if (packs.length < SNAPSHOT_BATCH_SIZE) break;
      }
    }

    const removed = await removeSnapshotsForDeletedPacks().catch(() => 0);
    setQueueDepth('sticker_pack_score_snapshot_pending', pendingPackIds.size);

    logger.info('Ciclo de snapshot de score de packs finalizado.', {
      action: 'sticker_pack_score_snapshot_cycle',
      scanned,
      written,
      removed,
      pending_pack_ids: pendingPackIds.size,
      full_rebuild_executed: fullRebuildExecuted,
      full_rebuild_every_cycles: SNAPSHOT_FULL_REBUILD_EVERY_CYCLES,
      duration_ms: __timeNowMs() - startedAt,
      batch_size: SNAPSHOT_BATCH_SIZE,
      targeted_batch_size: SNAPSHOT_TARGETED_BATCH_SIZE,
    });

    return {
      executed: true,
      reason: 'ok',
      scanned,
      written,
      removed,
      pending_pack_ids: pendingPackIds.size,
      full_rebuild_executed: fullRebuildExecuted,
      duration_ms: __timeNowMs() - startedAt,
    };
  } catch (error) {
    logger.error('Falha no ciclo de snapshot de score de packs.', {
      action: 'sticker_pack_score_snapshot_cycle_failed',
      error: error?.message,
    });
    return {
      executed: true,
      reason: 'failed',
      scanned,
      written,
      pending_pack_ids: pendingPackIds.size,
      full_rebuild_executed: fullRebuildExecuted,
      duration_ms: __timeNowMs() - startedAt,
    };
  } finally {
    running = false;
  }
};

const scheduleNextCycle = () => {
  if (!SNAPSHOT_ENABLED) return;
  if (cycleHandle) {
    clearTimeout(cycleHandle);
    cycleHandle = null;
  }
  cycleHandle = setTimeout(() => {
    cycleHandle = null;
    void runStickerPackScoreSnapshotCycle().finally(() => {
      scheduleNextCycle();
    });
  }, SNAPSHOT_REFRESH_INTERVAL_MS);
  if (typeof cycleHandle?.unref === 'function') cycleHandle.unref();
};

export const startStickerPackScoreSnapshotRuntime = () => {
  if (!SNAPSHOT_ENABLED) return;
  if (startupHandle || cycleHandle) return;
  startupHandle = setTimeout(() => {
    startupHandle = null;
    void runStickerPackScoreSnapshotCycle();
    scheduleNextCycle();
  }, SNAPSHOT_STARTUP_DELAY_MS);
  if (typeof startupHandle?.unref === 'function') startupHandle.unref();
};

export const stopStickerPackScoreSnapshotRuntime = () => {
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (cycleHandle) {
    clearTimeout(cycleHandle);
    cycleHandle = null;
  }
};
