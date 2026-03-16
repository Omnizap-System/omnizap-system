import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import fs from 'node:fs/promises';
import os from 'node:os';

import logger from '#logger';
import { recordStickerClassificationCycle, setQueueDepth } from '../../observability/metrics.js';
import { listStickerAssetsPendingClassification, findStickerAssetById } from './stickerAssetRepository.js';
import { classifierConfig, ensureStickerAssetClassified } from './stickerClassificationService.js';
import { listAssetsForPrioritySignalBackfillReprocess, listAssetsForLowConfidenceReprocess, listAssetsForModelUpgradeReprocess } from './stickerAssetClassificationRepository.js';
import { claimStickerAssetReprocessTask, completeStickerAssetReprocessTask, countStickerAssetReprocessQueueByStatus, enqueueStickerAssetReprocess, failStickerAssetReprocessTask } from './stickerAssetReprocessQueueRepository.js';
import { batchReprocess as runDeterministicSemanticReclassification, deterministicReclassificationConfig } from './semanticReclassificationEngine.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const BACKGROUND_ENABLED = parseEnvBool(process.env.STICKER_CLASSIFICATION_BACKGROUND_ENABLED, true);
const STARTUP_DELAY_MS = Math.max(1_000, Number(process.env.STICKER_CLASSIFICATION_BACKGROUND_STARTUP_DELAY_MS) || 15_000);
const LEGACY_INTERVAL_MS = Number(process.env.STICKER_CLASSIFICATION_BACKGROUND_INTERVAL_MS);
const INTERVAL_MIN_MS_RAW = Number(process.env.STICKER_CLASSIFICATION_BACKGROUND_INTERVAL_MIN_MS);
const INTERVAL_MAX_MS_RAW = Number(process.env.STICKER_CLASSIFICATION_BACKGROUND_INTERVAL_MAX_MS);
const DEFAULT_INTERVAL_MIN_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MAX_MS = 10 * 60_000;
const INTERVAL_MIN_MS = Number.isFinite(INTERVAL_MIN_MS_RAW) ? Math.max(60_000, Math.min(3_600_000, INTERVAL_MIN_MS_RAW)) : DEFAULT_INTERVAL_MIN_MS;
const INTERVAL_MAX_MS_FROM_ENV = Number.isFinite(INTERVAL_MAX_MS_RAW) ? Math.max(60_000, Math.min(3_600_000, INTERVAL_MAX_MS_RAW)) : DEFAULT_INTERVAL_MAX_MS;
const INTERVAL_MAX_MS = Math.max(INTERVAL_MIN_MS, INTERVAL_MAX_MS_FROM_ENV);
const LEGACY_FIXED_INTERVAL_MS = Number.isFinite(LEGACY_INTERVAL_MS) && LEGACY_INTERVAL_MS > 0 ? Math.max(60_000, Math.min(3_600_000, LEGACY_INTERVAL_MS)) : null;
const EFFECTIVE_INTERVAL_MIN_MS = LEGACY_FIXED_INTERVAL_MS || INTERVAL_MIN_MS;
const EFFECTIVE_INTERVAL_MAX_MS = LEGACY_FIXED_INTERVAL_MS || INTERVAL_MAX_MS;
const cpuCount = Math.max(1, Number(os.cpus()?.length || 1));
const BACKGROUND_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.STICKER_CLASSIFICATION_BACKGROUND_CONCURRENCY) || cpuCount));
const BATCH_SIZE = Math.max(1, Math.min(300, Number(process.env.STICKER_CLASSIFICATION_BACKGROUND_BATCH_SIZE) || BACKGROUND_CONCURRENCY * 2));

const REPROCESS_ENABLED = parseEnvBool(process.env.STICKER_REPROCESS_QUEUE_ENABLED, true);
const REPROCESS_MAX_PER_CYCLE = Math.max(0, Math.min(300, Number(process.env.STICKER_REPROCESS_MAX_PER_CYCLE) || BATCH_SIZE));
const REPROCESS_MODEL_UPGRADE_SCAN_LIMIT = Math.max(0, Math.min(2000, Number(process.env.STICKER_REPROCESS_MODEL_UPGRADE_SCAN_LIMIT) || 350));
const REPROCESS_LOW_CONFIDENCE_SCAN_LIMIT = Math.max(0, Math.min(2000, Number(process.env.STICKER_REPROCESS_LOW_CONFIDENCE_SCAN_LIMIT) || 250));
const REPROCESS_LOW_CONFIDENCE_THRESHOLD = Number.isFinite(Number(process.env.STICKER_REPROCESS_LOW_CONFIDENCE_THRESHOLD)) ? Number(process.env.STICKER_REPROCESS_LOW_CONFIDENCE_THRESHOLD) : 0.65;
const REPROCESS_LOW_CONFIDENCE_STALE_HOURS = Math.max(1, Math.min(24 * 365, Number(process.env.STICKER_REPROCESS_LOW_CONFIDENCE_STALE_HOURS) || 48));
const REPROCESS_PRIORITY_BACKFILL_ENABLED = parseEnvBool(process.env.STICKER_REPROCESS_PRIORITY_BACKFILL_ENABLED, true);
const REPROCESS_PRIORITY_BACKFILL_SCAN_LIMIT = Math.max(0, Math.min(3000, Number(process.env.STICKER_REPROCESS_PRIORITY_BACKFILL_SCAN_LIMIT) || 300));
const REPROCESS_PRIORITY_BACKFILL_PRIORITY = Math.max(1, Math.min(100, Number(process.env.STICKER_REPROCESS_PRIORITY_BACKFILL_PRIORITY) || 95));
const REPROCESS_RETRY_DELAY_SECONDS = Math.max(5, Math.min(3600, Number(process.env.STICKER_REPROCESS_RETRY_DELAY_SECONDS) || 120));

let cycleHandle = null;
let startupTimeoutHandle = null;
let running = false;
let schedulerEnabled = false;
let reprocessQueueAvailable = true;

const classifyAsset = async ({ asset, force = false }) => {
  if (!asset?.storage_path || !asset?.id) {
    return { ok: false, reason: 'asset_missing_storage' };
  }

  const buffer = await fs.readFile(asset.storage_path);
  const result = await ensureStickerAssetClassified({ asset, buffer, force });
  return { ok: Boolean(result), reason: result ? null : 'classification_empty' };
};

const processPendingAssets = async () => {
  const stats = {
    processed: 0,
    classified: 0,
    failed: 0,
  };

  const assets = await listStickerAssetsPendingClassification({ limit: BATCH_SIZE });
  if (!assets.length) {
    logger.debug('Worker de classificação: sem assets pendentes.', {
      action: 'sticker_classification_background_idle',
    });
    return stats;
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(BACKGROUND_CONCURRENCY, assets.length) }).map(async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= assets.length) break;

      const asset = assets[index];
      stats.processed += 1;

      try {
        const result = await classifyAsset({ asset, force: false });
        if (result.ok) {
          stats.classified += 1;
        } else {
          stats.failed += 1;
        }
      } catch (error) {
        stats.failed += 1;
        logger.warn('Falha ao classificar asset no worker de background.', {
          action: 'sticker_classification_background_asset_failed',
          asset_id: asset?.id || null,
          storage_path: asset?.storage_path || null,
          error: error?.message,
        });
      }
    }
  });

  await Promise.all(workers);
  return stats;
};

const enqueueModelUpgradeCandidates = async () => {
  if (!REPROCESS_ENABLED || !classifierConfig?.classification_version) return 0;

  const assetIds = await listAssetsForModelUpgradeReprocess({
    currentVersion: classifierConfig.classification_version,
    limit: REPROCESS_MODEL_UPGRADE_SCAN_LIMIT,
  });

  let enqueued = 0;
  for (const assetId of assetIds) {
    const inserted = await enqueueStickerAssetReprocess({
      assetId,
      reason: 'MODEL_UPGRADE',
      priority: 60,
    });
    if (inserted) enqueued += 1;
  }

  return enqueued;
};

const enqueueLowConfidenceCandidates = async () => {
  if (!REPROCESS_ENABLED || !Number.isFinite(REPROCESS_LOW_CONFIDENCE_THRESHOLD)) return 0;

  const assetIds = await listAssetsForLowConfidenceReprocess({
    confidenceThreshold: REPROCESS_LOW_CONFIDENCE_THRESHOLD,
    staleHours: REPROCESS_LOW_CONFIDENCE_STALE_HOURS,
    limit: REPROCESS_LOW_CONFIDENCE_SCAN_LIMIT,
  });

  let enqueued = 0;
  for (const assetId of assetIds) {
    const inserted = await enqueueStickerAssetReprocess({
      assetId,
      reason: 'LOW_CONFIDENCE',
      priority: 70,
    });
    if (inserted) enqueued += 1;
  }

  return enqueued;
};

const enqueuePriorityBackfillCandidates = async () => {
  if (!REPROCESS_ENABLED || !REPROCESS_PRIORITY_BACKFILL_ENABLED) return 0;

  const assetIds = await listAssetsForPrioritySignalBackfillReprocess({
    limit: REPROCESS_PRIORITY_BACKFILL_SCAN_LIMIT,
  });

  let enqueued = 0;
  for (const assetId of assetIds) {
    const inserted = await enqueueStickerAssetReprocess({
      assetId,
      reason: 'MODEL_UPGRADE',
      priority: REPROCESS_PRIORITY_BACKFILL_PRIORITY,
    });
    if (inserted) enqueued += 1;
  }

  return enqueued;
};

const processReprocessQueue = async ({ limit = REPROCESS_MAX_PER_CYCLE } = {}) => {
  if (!REPROCESS_ENABLED || limit <= 0 || !reprocessQueueAvailable) {
    return {
      processed: 0,
      classified: 0,
      failed: 0,
      enqueued_priority_backfill: 0,
      enqueued_model_upgrade: 0,
      enqueued_low_confidence: 0,
    };
  }

  let enqueuedPriorityBackfill = 0;
  let enqueuedModelUpgrade = 0;
  let enqueuedLowConfidence = 0;
  try {
    enqueuedPriorityBackfill = await enqueuePriorityBackfillCandidates();
    enqueuedModelUpgrade = await enqueueModelUpgradeCandidates();
    enqueuedLowConfidence = await enqueueLowConfidenceCandidates();
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      reprocessQueueAvailable = false;
      logger.warn('Fila de reprocessamento indisponivel (migração pendente). Seguindo sem reprocessar.', {
        action: 'sticker_reprocess_queue_unavailable',
      });
      return {
        processed: 0,
        classified: 0,
        failed: 0,
        enqueued_priority_backfill: 0,
        enqueued_model_upgrade: 0,
        enqueued_low_confidence: 0,
      };
    }
    throw error;
  }

  const stats = {
    processed: 0,
    classified: 0,
    failed: 0,
    enqueued_priority_backfill: enqueuedPriorityBackfill,
    enqueued_model_upgrade: enqueuedModelUpgrade,
    enqueued_low_confidence: enqueuedLowConfidence,
  };

  for (let i = 0; i < limit; i += 1) {
    const task = await claimStickerAssetReprocessTask();
    if (!task) break;

    stats.processed += 1;

    try {
      const asset = await findStickerAssetById(task.asset_id);
      if (!asset?.id) {
        await completeStickerAssetReprocessTask(task.id);
        continue;
      }

      const result = await classifyAsset({ asset, force: true });
      if (result.ok) {
        await completeStickerAssetReprocessTask(task.id);
        stats.classified += 1;
      } else {
        stats.failed += 1;
        await failStickerAssetReprocessTask(task.id, {
          error: result.reason || 'reprocess_failed',
          retryDelaySeconds: REPROCESS_RETRY_DELAY_SECONDS,
        });
      }
    } catch (error) {
      stats.failed += 1;
      await failStickerAssetReprocessTask(task.id, {
        error: error?.message || 'reprocess_exception',
        retryDelaySeconds: REPROCESS_RETRY_DELAY_SECONDS,
      });

      logger.warn('Falha ao reclassificar asset da fila de reprocessamento.', {
        action: 'sticker_reprocess_queue_task_failed',
        task_id: task.id,
        asset_id: task.asset_id,
        reason: task.reason,
        attempts: task.attempts,
        error: error?.message,
      });
    }
  }

  try {
    const [pendingDepth, processingDepth] = await Promise.all([countStickerAssetReprocessQueueByStatus('pending'), countStickerAssetReprocessQueueByStatus('processing')]);
    setQueueDepth('sticker_reprocess_pending', pendingDepth);
    setQueueDepth('sticker_reprocess_processing', processingDepth);
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      reprocessQueueAvailable = false;
    } else {
      throw error;
    }
  }

  return stats;
};

const processDeterministicReclassification = async () => {
  if (!deterministicReclassificationConfig.enabled) {
    return {
      enabled: false,
      processed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      batches: 0,
      last_cursor: null,
      entropy_threshold: deterministicReclassificationConfig.entropy_threshold,
      affinity_threshold: deterministicReclassificationConfig.affinity_threshold,
    };
  }

  return runDeterministicSemanticReclassification({
    maxItems: deterministicReclassificationConfig.max_per_cycle,
    batchSize: deterministicReclassificationConfig.batch_size,
    entropyThreshold: deterministicReclassificationConfig.entropy_threshold,
    affinityThreshold: deterministicReclassificationConfig.affinity_threshold,
  });
};

export const runStickerClassificationCycle = async ({ processPending = true, processReprocess = true, processDeterministic = true } = {}) => {
  const startedAt = __timeNowMs();
  const shouldProcessClassifier = classifierConfig.enabled;
  const shouldProcessDeterministic = deterministicReclassificationConfig.enabled;

  if (!BACKGROUND_ENABLED || (!shouldProcessClassifier && !shouldProcessDeterministic)) {
    recordStickerClassificationCycle({
      status: 'skipped',
      durationMs: __timeNowMs() - startedAt,
      processed: 0,
      classified: 0,
      failed: 0,
    });
    return {
      skipped: true,
      reason: !BACKGROUND_ENABLED ? 'background_disabled' : 'no_active_processors',
    };
  }

  try {
    const reprocessStats = processReprocess && shouldProcessClassifier ? await processReprocessQueue() : null;
    const pendingStats = processPending && shouldProcessClassifier ? await processPendingAssets() : null;
    const deterministicStats = processDeterministic ? await processDeterministicReclassification() : null;

    const processed = Number(pendingStats?.processed || 0) + Number(reprocessStats?.processed || 0) + Number(deterministicStats?.processed || 0);
    const classified = Number(pendingStats?.classified || 0) + Number(reprocessStats?.classified || 0) + Number(deterministicStats?.updated || 0);
    const failed = Number(pendingStats?.failed || 0) + Number(reprocessStats?.failed || 0) + Number(deterministicStats?.failed || 0);
    const durationMs = __timeNowMs() - startedAt;

    recordStickerClassificationCycle({
      status: 'ok',
      durationMs,
      processed,
      classified,
      failed,
    });

    return {
      skipped: false,
      duration_ms: durationMs,
      pending: pendingStats,
      reprocess: reprocessStats,
      deterministic_reclassification: deterministicStats,
    };
  } catch (error) {
    recordStickerClassificationCycle({
      status: 'failed',
      durationMs: __timeNowMs() - startedAt,
      processed: 0,
      classified: 0,
      failed: 1,
    });
    throw error;
  }
};

const clearCycleHandle = () => {
  if (!cycleHandle) return;
  clearTimeout(cycleHandle);
  cycleHandle = null;
};

const resolveNextCycleDelayMs = () => {
  if (EFFECTIVE_INTERVAL_MAX_MS <= EFFECTIVE_INTERVAL_MIN_MS) {
    return EFFECTIVE_INTERVAL_MIN_MS;
  }

  return EFFECTIVE_INTERVAL_MIN_MS + Math.floor(Math.random() * (EFFECTIVE_INTERVAL_MAX_MS - EFFECTIVE_INTERVAL_MIN_MS + 1));
};

const scheduleNextCycle = () => {
  if (!schedulerEnabled) return;
  clearCycleHandle();

  const safeDelay = Math.max(1_000, resolveNextCycleDelayMs());
  cycleHandle = setTimeout(() => {
    cycleHandle = null;
    if (!schedulerEnabled) return;
    scheduleNextCycle();
    void classifyBatch().catch((error) => {
      logger.error('Falha ao executar ciclo agendado de classificação em background.', {
        action: 'sticker_classification_background_schedule_failed',
        error: error?.message,
      });
    });
  }, safeDelay);

  if (typeof cycleHandle.unref === 'function') {
    cycleHandle.unref();
  }
};

const classifyBatch = async () => {
  if (running) {
    return {
      executed: false,
      reason: 'already_running',
      gain_count: 0,
    };
  }
  if (!BACKGROUND_ENABLED || (!classifierConfig.enabled && !deterministicReclassificationConfig.enabled)) {
    return {
      executed: false,
      reason: 'disabled',
      gain_count: 0,
    };
  }

  running = true;
  const startedAt = __timeNowMs();

  try {
    const result = await runStickerClassificationCycle({
      processPending: true,
      processReprocess: true,
      processDeterministic: true,
    });

    const pending = result?.pending || { processed: 0, classified: 0, failed: 0 };
    const reprocess = result?.reprocess || {
      processed: 0,
      classified: 0,
      failed: 0,
      enqueued_priority_backfill: 0,
      enqueued_model_upgrade: 0,
      enqueued_low_confidence: 0,
    };
    const deterministic = result?.deterministic_reclassification || {
      processed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      batches: 0,
      last_cursor: null,
      entropy_threshold: deterministicReclassificationConfig.entropy_threshold,
      affinity_threshold: deterministicReclassificationConfig.affinity_threshold,
    };

    const processed = Number(pending.processed || 0) + Number(reprocess.processed || 0) + Number(deterministic.processed || 0);
    const classified = Number(pending.classified || 0) + Number(reprocess.classified || 0) + Number(deterministic.updated || 0);
    const failed = Number(pending.failed || 0) + Number(reprocess.failed || 0) + Number(deterministic.failed || 0);
    const gainCount = classified;

    if (processed > 0 || reprocess.enqueued_priority_backfill > 0 || reprocess.enqueued_model_upgrade > 0 || reprocess.enqueued_low_confidence > 0 || deterministic.updated > 0) {
      logger.info('Worker de classificação executado.', {
        action: 'sticker_classification_background_cycle',
        processed,
        classified,
        failed,
        reprocess_processed: Number(reprocess.processed || 0),
        reprocess_classified: Number(reprocess.classified || 0),
        reprocess_failed: Number(reprocess.failed || 0),
        reprocess_enqueued_priority_backfill: Number(reprocess.enqueued_priority_backfill || 0),
        reprocess_enqueued_model_upgrade: Number(reprocess.enqueued_model_upgrade || 0),
        reprocess_enqueued_low_confidence: Number(reprocess.enqueued_low_confidence || 0),
        deterministic_reclassification_processed: Number(deterministic.processed || 0),
        deterministic_reclassification_updated: Number(deterministic.updated || 0),
        deterministic_reclassification_skipped: Number(deterministic.skipped || 0),
        deterministic_reclassification_failed: Number(deterministic.failed || 0),
        deterministic_reclassification_batches: Number(deterministic.batches || 0),
        deterministic_reclassification_last_cursor: deterministic.last_cursor || null,
        duration_ms: __timeNowMs() - startedAt,
        batch_size: BATCH_SIZE,
        concurrency: BACKGROUND_CONCURRENCY,
        gain_count: gainCount,
      });
    }
    return {
      executed: true,
      reason: 'ok',
      gain_count: Number(gainCount || 0),
      processed: Number(processed || 0),
      classified: Number(classified || 0),
      failed: Number(failed || 0),
      duration_ms: __timeNowMs() - startedAt,
    };
  } catch (error) {
    logger.error('Falha no loop de classificação em background.', {
      action: 'sticker_classification_background_cycle_failed',
      error: error?.message,
    });
    return {
      executed: true,
      reason: 'failed',
      gain_count: 0,
      duration_ms: __timeNowMs() - startedAt,
    };
  } finally {
    running = false;
  }
};

export const startStickerClassificationBackground = () => {
  if (cycleHandle || startupTimeoutHandle || schedulerEnabled) return;

  if (!BACKGROUND_ENABLED) {
    logger.info('Worker de classificação em background desabilitado.', {
      action: 'sticker_classification_background_disabled',
    });
    return;
  }

  if (!classifierConfig.enabled && !deterministicReclassificationConfig.enabled) {
    logger.info('Worker de classificação em background ignorado (nenhum processador ativo).', {
      action: 'sticker_classification_background_all_processors_disabled',
    });
    return;
  }
  schedulerEnabled = true;

  logger.info('Iniciando worker de classificação em background.', {
    action: 'sticker_classification_background_start',
    startup_delay_ms: STARTUP_DELAY_MS,
    interval_min_ms: EFFECTIVE_INTERVAL_MIN_MS,
    interval_max_ms: EFFECTIVE_INTERVAL_MAX_MS,
    scheduler_mode: 'timer_non_chained_random_window',
    interval_source: LEGACY_FIXED_INTERVAL_MS ? 'legacy_fixed_interval_ms' : 'interval_window',
    batch_size: BATCH_SIZE,
    concurrency: BACKGROUND_CONCURRENCY,
    classifier_api: classifierConfig.api_url,
    reprocess_enabled: REPROCESS_ENABLED,
    reprocess_max_per_cycle: REPROCESS_MAX_PER_CYCLE,
    reprocess_priority_backfill_enabled: REPROCESS_PRIORITY_BACKFILL_ENABLED,
    reprocess_priority_backfill_scan_limit: REPROCESS_PRIORITY_BACKFILL_SCAN_LIMIT,
    reprocess_priority_backfill_priority: REPROCESS_PRIORITY_BACKFILL_PRIORITY,
    deterministic_reclassification_enabled: deterministicReclassificationConfig.enabled,
    deterministic_reclassification_batch_size: deterministicReclassificationConfig.batch_size,
    deterministic_reclassification_max_per_cycle: deterministicReclassificationConfig.max_per_cycle,
    deterministic_reclassification_entropy_threshold: deterministicReclassificationConfig.entropy_threshold,
    deterministic_reclassification_affinity_threshold: deterministicReclassificationConfig.affinity_threshold,
  });

  startupTimeoutHandle = setTimeout(() => {
    startupTimeoutHandle = null;
    if (!schedulerEnabled) return;
    scheduleNextCycle();
    void classifyBatch().catch((error) => {
      logger.error('Falha ao executar ciclo inicial de classificação em background.', {
        action: 'sticker_classification_background_initial_cycle_failed',
        error: error?.message,
      });
    });
  }, STARTUP_DELAY_MS);

  if (typeof startupTimeoutHandle.unref === 'function') {
    startupTimeoutHandle.unref();
  }
};

export const stopStickerClassificationBackground = () => {
  schedulerEnabled = false;

  if (startupTimeoutHandle) {
    clearTimeout(startupTimeoutHandle);
    startupTimeoutHandle = null;
  }

  clearCycleHandle();
};
