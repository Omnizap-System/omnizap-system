import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { setQueueDepth } from '../../observability/metrics.js';
import { isFeatureEnabled } from '../../services/infra/featureFlagService.js';
import { runStickerClassificationCycle } from './stickerClassificationBackgroundRuntime.js';
import { runStickerAutoPackByTagsCycle } from './stickerAutoPackByTagsRuntime.js';
import { claimWorkerTask, completeWorkerTask, countWorkerTasksByStatus, enqueueWorkerTask, failWorkerTask, hasPendingWorkerTask } from './stickerWorkerTaskQueueRepository.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const PIPELINE_ENABLED = parseEnvBool(process.env.STICKER_WORKER_PIPELINE_ENABLED, false);
const STARTUP_DELAY_MS = Math.max(1_000, Number(process.env.STICKER_WORKER_PIPELINE_STARTUP_DELAY_MS) || 12_000);
const SCHEDULER_INTERVAL_MS = Math.max(2_000, Number(process.env.STICKER_WORKER_PIPELINE_SCHEDULER_INTERVAL_MS) || 15_000);
const POLLER_INTERVAL_MS = Math.max(1_000, Number(process.env.STICKER_WORKER_PIPELINE_POLLER_INTERVAL_MS) || 4_000);
const WORKER_RETRY_DELAY_SECONDS = Math.max(5, Math.min(3600, Number(process.env.STICKER_WORKER_PIPELINE_RETRY_DELAY_SECONDS) || 45));
const INLINE_POLLER_ENABLED = parseEnvBool(process.env.STICKER_WORKER_PIPELINE_INLINE_POLLER_ENABLED, true);
const INLINE_POLLER_FORCE_ENABLED = parseEnvBool(process.env.STICKER_WORKER_PIPELINE_INLINE_POLLER_FORCE_ENABLED, false);
const INLINE_POLLER_LOOP_ACTIVE = INLINE_POLLER_ENABLED || INLINE_POLLER_FORCE_ENABLED;

const TASK_CADENCE_MS = {
  classification_cycle: Math.max(10_000, Number(process.env.STICKER_WORKER_CLASSIFICATION_CADENCE_MS) || 120_000),
  curation_cycle: Math.max(15_000, Number(process.env.STICKER_WORKER_CURATION_CADENCE_MS) || 180_000),
  rebuild_cycle: Math.max(15_000, Number(process.env.STICKER_WORKER_REBUILD_CADENCE_MS) || 240_000),
};

const TASK_PRIORITY = {
  classification_cycle: 70,
  curation_cycle: 55,
  rebuild_cycle: 50,
};
const PIPELINE_PROCESS_COHORT_KEY = String(process.env.STICKER_WORKER_PIPELINE_COHORT_KEY || process.env.HOSTNAME || process.pid).trim() || 'pipeline';

let startupHandle = null;
let schedulerHandle = null;
let pollerHandle = null;
let runningPoll = false;
let taskQueueAvailable = true;
const nextScheduleByTask = new Map();

const taskHandlers = {
  classification_cycle: async () => runStickerClassificationCycle({ processPending: true, processReprocess: true }),
  curation_cycle: async () => runStickerAutoPackByTagsCycle({ enableAdditions: true, enableRebuild: false }),
  rebuild_cycle: async () => runStickerAutoPackByTagsCycle({ enableAdditions: false, enableRebuild: true }),
};

const refreshQueueDepthMetrics = async () => {
  if (!taskQueueAvailable) return;
  const [pending, processing, failed] = await Promise.all([countWorkerTasksByStatus('pending'), countWorkerTasksByStatus('processing'), countWorkerTasksByStatus('failed')]);
  setQueueDepth('sticker_worker_tasks_pending', pending);
  setQueueDepth('sticker_worker_tasks_processing', processing);
  setQueueDepth('sticker_worker_tasks_failed', failed);
};

const canRunInlinePoller = async () => {
  if (!INLINE_POLLER_ENABLED) return false;
  if (INLINE_POLLER_FORCE_ENABLED) return true;
  const dedicatedWorkersEnabled = await isFeatureEnabled('enable_worker_dedicated_processes', {
    fallback: false,
    subjectKey: `pipeline:inline_poller:${PIPELINE_PROCESS_COHORT_KEY}`,
  });
  return !dedicatedWorkersEnabled;
};

const scheduleTaskIfNeeded = async (taskType) => {
  if (!taskQueueAvailable) return;
  const cadence = TASK_CADENCE_MS[taskType];
  if (!cadence) return;

  const now = __timeNowMs();
  const nextDueAt = nextScheduleByTask.get(taskType) || 0;
  if (now < nextDueAt) return;

  const hasPending = await hasPendingWorkerTask(taskType);
  if (hasPending) {
    nextScheduleByTask.set(taskType, now + Math.floor(cadence / 2));
    return;
  }

  await enqueueWorkerTask({
    taskType,
    payload: { scheduled_by: 'sticker_worker_pipeline' },
    priority: TASK_PRIORITY[taskType] || 50,
    idempotencyKey: `pipeline:${taskType}:${Math.floor(now / cadence)}`,
  });
  nextScheduleByTask.set(taskType, now + cadence);
};

const schedulerTick = async () => {
  if (!PIPELINE_ENABLED) return;

  try {
    await Promise.all([scheduleTaskIfNeeded('classification_cycle'), scheduleTaskIfNeeded('curation_cycle'), scheduleTaskIfNeeded('rebuild_cycle')]);
    await refreshQueueDepthMetrics();
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      taskQueueAvailable = false;
      logger.warn('Fila do pipeline de workers indisponivel (migração pendente).', {
        action: 'sticker_worker_pipeline_queue_unavailable',
      });
      return;
    }
    throw error;
  }
};

const processSingleTaskType = async (taskType) => {
  if (!taskQueueAvailable) return false;
  const task = await claimWorkerTask({ taskType });
  if (!task) return false;

  try {
    const handler = taskHandlers[taskType];
    if (typeof handler !== 'function') {
      throw new Error(`handler_not_found:${taskType}`);
    }

    await handler(task.payload || {});
    await completeWorkerTask(task.id);

    logger.debug('Task de worker concluída.', {
      action: 'sticker_worker_task_completed',
      task_type: taskType,
      task_id: task.id,
      attempts: task.attempts,
    });
    return true;
  } catch (error) {
    await failWorkerTask(task.id, {
      error: error?.message || 'worker_task_failed',
      retryDelaySeconds: WORKER_RETRY_DELAY_SECONDS,
    });

    logger.warn('Task de worker falhou.', {
      action: 'sticker_worker_task_failed',
      task_type: taskType,
      task_id: task.id,
      attempts: task.attempts,
      error: error?.message,
    });
    return true;
  }
};

const pollerTick = async () => {
  if (runningPoll || !PIPELINE_ENABLED) return;
  runningPoll = true;

  try {
    if (!(await canRunInlinePoller())) return;

    let progressed = false;

    progressed = (await processSingleTaskType('classification_cycle')) || progressed;
    progressed = (await processSingleTaskType('curation_cycle')) || progressed;
    progressed = (await processSingleTaskType('rebuild_cycle')) || progressed;

    if (progressed) {
      await refreshQueueDepthMetrics();
    }
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      taskQueueAvailable = false;
      logger.warn('Fila do pipeline de workers indisponivel durante o poll.', {
        action: 'sticker_worker_pipeline_queue_unavailable_poll',
      });
    } else {
      logger.error('Falha no poller do pipeline de workers.', {
        action: 'sticker_worker_pipeline_poll_failed',
        error: error?.message,
      });
    }
  } finally {
    runningPoll = false;
  }
};

export const startStickerWorkerPipeline = () => {
  if (!PIPELINE_ENABLED) {
    logger.info('Pipeline de workers de sticker desabilitado.', {
      action: 'sticker_worker_pipeline_disabled',
    });
    return;
  }

  if (startupHandle || schedulerHandle || pollerHandle) return;

  logger.info('Iniciando pipeline de workers de sticker.', {
    action: 'sticker_worker_pipeline_start',
    startup_delay_ms: STARTUP_DELAY_MS,
    scheduler_interval_ms: SCHEDULER_INTERVAL_MS,
    poller_interval_ms: POLLER_INTERVAL_MS,
    inline_poller_enabled: INLINE_POLLER_ENABLED,
    inline_poller_loop_active: INLINE_POLLER_LOOP_ACTIVE,
    cadence_ms: TASK_CADENCE_MS,
  });

  startupHandle = setTimeout(() => {
    startupHandle = null;

    void schedulerTick();
    if (INLINE_POLLER_LOOP_ACTIVE) {
      void pollerTick();
    }

    schedulerHandle = setInterval(() => {
      void schedulerTick();
    }, SCHEDULER_INTERVAL_MS);

    if (INLINE_POLLER_LOOP_ACTIVE) {
      pollerHandle = setInterval(() => {
        void pollerTick();
      }, POLLER_INTERVAL_MS);
    }

    if (typeof schedulerHandle.unref === 'function') schedulerHandle.unref();
    if (typeof pollerHandle?.unref === 'function') pollerHandle.unref();
  }, STARTUP_DELAY_MS);

  if (typeof startupHandle.unref === 'function') startupHandle.unref();
};

export const stopStickerWorkerPipeline = () => {
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
};

export const isStickerWorkerPipelineEnabled = () => PIPELINE_ENABLED;
