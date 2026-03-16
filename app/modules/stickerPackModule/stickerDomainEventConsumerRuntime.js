import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { setQueueDepth } from '../../observability/metrics.js';
import { isFeatureEnabled } from '../../services/infra/featureFlagService.js';
import { claimDomainEvent, completeDomainEvent, countDomainEventsByStatus, failDomainEvent } from './domainEventOutboxRepository.js';
import { STICKER_DOMAIN_EVENTS } from './domainEvents.js';
import { enqueueWorkerTask } from './stickerWorkerTaskQueueRepository.js';
import { enqueuePackScoreSnapshotRefresh } from './stickerPackScoreSnapshotRuntime.js';
import { listPackIdsByStickerId } from './stickerPackItemRepository.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const CONSUMER_ENABLED = parseEnvBool(process.env.STICKER_DOMAIN_EVENT_CONSUMER_ENABLED, true);
const STARTUP_DELAY_MS = Math.max(1_000, Number(process.env.STICKER_DOMAIN_EVENT_CONSUMER_STARTUP_DELAY_MS) || 8_000);
const POLLER_INTERVAL_MS = Math.max(1_000, Number(process.env.STICKER_DOMAIN_EVENT_CONSUMER_POLLER_INTERVAL_MS) || 2_000);
const RETRY_DELAY_SECONDS = Math.max(5, Math.min(3600, Number(process.env.STICKER_DOMAIN_EVENT_CONSUMER_RETRY_DELAY_SECONDS) || 45));
const CLASSIFICATION_COALESCE_WINDOW_SECONDS = Math.max(30, Math.min(3600, Number(process.env.STICKER_DOMAIN_EVENT_CLASSIFICATION_COALESCE_WINDOW_SECONDS) || 60));
const CURATION_COALESCE_WINDOW_SECONDS = Math.max(30, Math.min(3600, Number(process.env.STICKER_DOMAIN_EVENT_CURATION_COALESCE_WINDOW_SECONDS) || 60));
const REBUILD_COALESCE_WINDOW_SECONDS = Math.max(30, Math.min(3600, Number(process.env.STICKER_DOMAIN_EVENT_REBUILD_COALESCE_WINDOW_SECONDS) || 120));
const CONSUMER_COHORT_KEY = String(process.env.STICKER_DOMAIN_EVENT_CONSUMER_COHORT_KEY || process.env.HOSTNAME || process.pid).trim() || 'consumer';

let startupHandle = null;
let pollerHandle = null;
let running = false;

const refreshOutboxDepthMetrics = async () => {
  const [pending, processing, failed] = await Promise.all([countDomainEventsByStatus('pending'), countDomainEventsByStatus('processing'), countDomainEventsByStatus('failed')]);
  setQueueDepth('domain_event_outbox_pending', pending);
  setQueueDepth('domain_event_outbox_processing', processing);
  setQueueDepth('domain_event_outbox_failed', failed);
};

const canRunConsumer = async () =>
  isFeatureEnabled('enable_domain_event_outbox', {
    fallback: true,
    subjectKey: `domain_event_consumer:${CONSUMER_COHORT_KEY}`,
  });

const enqueueTaskSafely = async ({ taskType, payload, priority, idempotencyKey }) => {
  await enqueueWorkerTask({
    taskType,
    payload,
    priority,
    idempotencyKey,
  });
};

const toUnixSeconds = (value) => {
  if (!value) return Math.floor(__timeNowMs() / 1000);
  const numeric = Date.parse(value);
  if (!Number.isFinite(numeric)) return Math.floor(__timeNowMs() / 1000);
  return Math.floor(numeric / 1000);
};

const toWindowBucket = (value, windowSeconds) => {
  const safeWindow = Math.max(1, Math.floor(windowSeconds || 1));
  return Math.floor(toUnixSeconds(value) / safeWindow);
};

const handleDomainEvent = async (event) => {
  const eventType = String(event?.event_type || '')
    .trim()
    .toUpperCase();
  const aggregateId = String(event?.aggregate_id || '').trim();
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};

  if (eventType === STICKER_DOMAIN_EVENTS.STICKER_ASSET_CREATED) {
    const coalesceBucket = toWindowBucket(event?.created_at, CLASSIFICATION_COALESCE_WINDOW_SECONDS);
    await enqueueTaskSafely({
      taskType: 'classification_cycle',
      payload: {
        reason: 'domain_event',
        event_type: eventType,
        aggregate_id: aggregateId,
        coalesced: true,
      },
      priority: 80,
      idempotencyKey: `evt:${eventType}:${coalesceBucket}:classification_cycle`,
    });
    return;
  }

  if (eventType === STICKER_DOMAIN_EVENTS.STICKER_CLASSIFIED) {
    const coalesceBucket = toWindowBucket(event?.created_at, CURATION_COALESCE_WINDOW_SECONDS);
    const assetId = String(payload?.asset_id || aggregateId || '').trim();
    const relatedPackIds = assetId ? await listPackIdsByStickerId(assetId).catch(() => []) : [];
    if (relatedPackIds.length) {
      enqueuePackScoreSnapshotRefresh(relatedPackIds);
    }
    await enqueueTaskSafely({
      taskType: 'curation_cycle',
      payload: {
        reason: 'domain_event',
        event_type: eventType,
        aggregate_id: aggregateId,
        related_pack_ids: relatedPackIds,
        coalesced: true,
      },
      priority: 65,
      idempotencyKey: `evt:${eventType}:${coalesceBucket}:curation_cycle`,
    });
    return;
  }

  if (eventType === STICKER_DOMAIN_EVENTS.PACK_UPDATED) {
    const coalesceBucket = toWindowBucket(event?.created_at, REBUILD_COALESCE_WINDOW_SECONDS);
    const packId = String(payload?.pack_id || aggregateId || '').trim();
    if (packId) {
      enqueuePackScoreSnapshotRefresh([packId]);
    }
    const rebuildIdempotency = packId ? `evt:${eventType}:${packId}:${coalesceBucket}:rebuild_cycle` : `evt:${eventType}:${coalesceBucket}:rebuild_cycle`;
    await enqueueTaskSafely({
      taskType: 'rebuild_cycle',
      payload: {
        reason: 'domain_event',
        event_type: eventType,
        aggregate_id: aggregateId,
        pack_id: packId || null,
        coalesced: true,
      },
      priority: 60,
      idempotencyKey: rebuildIdempotency,
    });
    return;
  }

  if (eventType === STICKER_DOMAIN_EVENTS.ENGAGEMENT_RECORDED) {
    const packId = String(payload?.pack_id || aggregateId || '').trim();
    if (packId) {
      enqueuePackScoreSnapshotRefresh([packId]);
    }
    return;
  }
};

const pollOnce = async () => {
  if (running || !CONSUMER_ENABLED) return;
  running = true;
  try {
    if (!(await canRunConsumer())) return;

    const event = await claimDomainEvent();
    if (!event) {
      await refreshOutboxDepthMetrics();
      return;
    }

    try {
      await handleDomainEvent(event);
      await completeDomainEvent(event.id);
    } catch (error) {
      await failDomainEvent(event.id, {
        error: error?.message || 'domain_event_consumer_failed',
        retryDelaySeconds: RETRY_DELAY_SECONDS,
      });
      logger.warn('Evento de domínio falhou no consumidor interno.', {
        action: 'sticker_domain_event_consumer_event_failed',
        event_id: event.id,
        event_type: event.event_type,
        aggregate_type: event.aggregate_type,
        aggregate_id: event.aggregate_id,
        error: error?.message,
      });
    }

    await refreshOutboxDepthMetrics();
  } catch (error) {
    if (error?.code !== 'ER_NO_SUCH_TABLE') {
      logger.error('Falha no poller do consumidor de eventos de domínio.', {
        action: 'sticker_domain_event_consumer_poll_failed',
        error: error?.message,
      });
    }
  } finally {
    running = false;
  }
};

export const startStickerDomainEventConsumer = () => {
  if (!CONSUMER_ENABLED) return;
  if (startupHandle || pollerHandle) return;

  startupHandle = setTimeout(() => {
    startupHandle = null;
    void pollOnce();
    pollerHandle = setInterval(() => {
      void pollOnce();
    }, POLLER_INTERVAL_MS);
    if (typeof pollerHandle?.unref === 'function') pollerHandle.unref();
  }, STARTUP_DELAY_MS);
  if (typeof startupHandle?.unref === 'function') startupHandle.unref();
};

export const stopStickerDomainEventConsumer = () => {
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
};
