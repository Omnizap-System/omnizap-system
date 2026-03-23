import logger from '#logger';
import { setQueueDepth } from '../../app/observability/metrics.js';
import { claimEmailOutboxTask, completeEmailOutboxTask, countEmailOutboxByStatus, failEmailOutboxTask } from './emailOutboxRepository.js';
import { isEmailTransportConfigured, sendEmailMessage } from './emailTransportService.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const clampInt = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

const clampNumber = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
};

const EMAIL_AUTOMATION_ENABLED = parseEnvBool(process.env.EMAIL_AUTOMATION_ENABLED, true);
const EMAIL_AUTOMATION_WORKER_ENABLED = parseEnvBool(process.env.EMAIL_AUTOMATION_WORKER_ENABLED, true);
const EMAIL_AUTOMATION_POLL_INTERVAL_MS = clampInt(process.env.EMAIL_AUTOMATION_POLL_INTERVAL_MS, 12_000, 1_000, 300_000);
const EMAIL_AUTOMATION_IDLE_BACKOFF_MULTIPLIER = clampNumber(process.env.EMAIL_AUTOMATION_IDLE_BACKOFF_MULTIPLIER, 1.7, 1, 5);
const EMAIL_AUTOMATION_IDLE_MAX_POLL_INTERVAL_MS = clampInt(process.env.EMAIL_AUTOMATION_IDLE_MAX_POLL_INTERVAL_MS, Math.max(60_000, EMAIL_AUTOMATION_POLL_INTERVAL_MS * 8), 1_000, 900_000);
const EMAIL_AUTOMATION_IDLE_JITTER_PERCENT = clampInt(process.env.EMAIL_AUTOMATION_IDLE_JITTER_PERCENT, 12, 0, 60);
const EMAIL_AUTOMATION_MAX_PER_TICK = clampInt(process.env.EMAIL_AUTOMATION_MAX_PER_TICK, 3, 1, 20);
const EMAIL_AUTOMATION_RETRY_DELAY_SECONDS = clampInt(process.env.EMAIL_AUTOMATION_RETRY_DELAY_SECONDS, 120, 5, 86_400);

let started = false;
let stopping = false;
let inFlight = false;
let timerHandle = null;
let nextDelayMs = EMAIL_AUTOMATION_POLL_INTERVAL_MS;

const maskEmailForLogs = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 255);
  const [localPartRaw, domainRaw] = normalized.split('@');
  const localPart = String(localPartRaw || '').trim();
  const domain = String(domainRaw || '').trim();
  if (!localPart || !domain) return 'invalid-email';
  const localMasked = localPart.length <= 2 ? `${localPart.charAt(0) || '*'}*` : `${localPart.slice(0, 2)}***`;
  return `${localMasked}@${domain}`;
};

const applyDelayJitter = (delayMs) => {
  const baseDelay = Math.max(250, Math.floor(Number(delayMs) || 0));
  if (EMAIL_AUTOMATION_IDLE_JITTER_PERCENT <= 0) return baseDelay;
  const variation = (Math.random() * 2 - 1) * (EMAIL_AUTOMATION_IDLE_JITTER_PERCENT / 100);
  return Math.max(250, Math.floor(baseDelay * (1 + variation)));
};

const refreshQueueDepthMetrics = async () => {
  const [pending, processing, failed] = await Promise.all([countEmailOutboxByStatus('pending'), countEmailOutboxByStatus('processing'), countEmailOutboxByStatus('failed')]);
  setQueueDepth('email_outbox_pending', pending);
  setQueueDepth('email_outbox_processing', processing);
  setQueueDepth('email_outbox_failed', failed);
};

const scheduleNextTick = (delayMs = EMAIL_AUTOMATION_POLL_INTERVAL_MS) => {
  if (stopping || !started) return;
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }

  timerHandle = setTimeout(() => {
    timerHandle = null;
    void runLoopOnce();
  }, applyDelayJitter(delayMs));

  if (typeof timerHandle?.unref === 'function') {
    timerHandle.unref();
  }
};

export const runEmailAutomationTick = async ({ maxPerTick = EMAIL_AUTOMATION_MAX_PER_TICK, retryDelaySeconds = EMAIL_AUTOMATION_RETRY_DELAY_SECONDS } = {}) => {
  if (!EMAIL_AUTOMATION_ENABLED || !EMAIL_AUTOMATION_WORKER_ENABLED) {
    return {
      executed: false,
      reason: 'disabled',
      claimed: 0,
      sent: 0,
      failed: 0,
    };
  }

  if (!isEmailTransportConfigured()) {
    return {
      executed: false,
      reason: 'smtp_not_configured',
      claimed: 0,
      sent: 0,
      failed: 0,
    };
  }

  const safeMaxPerTick = clampInt(maxPerTick, EMAIL_AUTOMATION_MAX_PER_TICK, 1, 20);
  const safeRetryDelay = clampInt(retryDelaySeconds, EMAIL_AUTOMATION_RETRY_DELAY_SECONDS, 5, 86_400);
  const stats = {
    executed: true,
    reason: 'ok',
    claimed: 0,
    sent: 0,
    failed: 0,
  };

  for (let index = 0; index < safeMaxPerTick; index += 1) {
    const task = await claimEmailOutboxTask();
    if (!task) break;

    stats.claimed += 1;

    try {
      const delivery = await sendEmailMessage({
        to: task.recipient_email,
        subject: task.subject,
        text: task.text_body,
        html: task.html_body,
      });

      await completeEmailOutboxTask(task.id, {
        providerMessageId: delivery?.messageId || '',
      });

      stats.sent += 1;
      logger.debug('E-mail da fila entregue com sucesso.', {
        action: 'email_automation_delivery_succeeded',
        task_id: task.id,
        template_key: task.template_key || null,
        recipient_email_masked: maskEmailForLogs(task.recipient_email),
        attempts: task.attempts,
        max_attempts: task.max_attempts,
        provider_message_id: delivery?.messageId || null,
        provider_response: delivery?.response || null,
      });
    } catch (error) {
      stats.failed += 1;
      await failEmailOutboxTask(task.id, {
        error: error?.message || 'email_delivery_failed',
        retryDelaySeconds: safeRetryDelay,
      });

      logger.warn('Falha ao entregar e-mail da fila.', {
        action: 'email_automation_delivery_failed',
        task_id: task.id,
        template_key: task.template_key || null,
        recipient_email_masked: maskEmailForLogs(task.recipient_email),
        attempts: task.attempts,
        max_attempts: task.max_attempts,
        retry_delay_seconds: safeRetryDelay,
        metadata_keys: Object.keys(task?.metadata || {}).slice(0, 20),
        error: error?.message,
      });
    }
  }

  if (stats.claimed > 0) {
    await refreshQueueDepthMetrics().catch(() => null);
    logger.info('Processamento da fila de e-mail concluído.', {
      action: 'email_automation_tick_processed',
      claimed: stats.claimed,
      sent: stats.sent,
      failed: stats.failed,
      max_per_tick: safeMaxPerTick,
      retry_delay_seconds: safeRetryDelay,
    });
  }

  return stats;
};

const runLoopOnce = async () => {
  if (stopping || inFlight) return;
  inFlight = true;
  let tickStats = null;

  try {
    tickStats = await runEmailAutomationTick();
  } catch (error) {
    logger.error('Falha no runtime de automação de e-mail.', {
      action: 'email_automation_runtime_tick_failed',
      error: error?.message,
    });
  } finally {
    inFlight = false;
  }

  if (stopping || !started) return;

  const claimed = Number(tickStats?.claimed || 0);
  if (claimed > 0) {
    nextDelayMs = EMAIL_AUTOMATION_POLL_INTERVAL_MS;
  } else {
    nextDelayMs = Math.min(EMAIL_AUTOMATION_IDLE_MAX_POLL_INTERVAL_MS, Math.max(EMAIL_AUTOMATION_POLL_INTERVAL_MS, Math.floor(nextDelayMs * EMAIL_AUTOMATION_IDLE_BACKOFF_MULTIPLIER)));
  }

  scheduleNextTick(nextDelayMs);
};

export const startEmailAutomationRuntime = () => {
  if (started) return;

  if (!EMAIL_AUTOMATION_ENABLED || !EMAIL_AUTOMATION_WORKER_ENABLED) {
    logger.info('Runtime de automação de e-mail desabilitado.', {
      action: 'email_automation_runtime_disabled',
      automation_enabled: EMAIL_AUTOMATION_ENABLED,
      worker_enabled: EMAIL_AUTOMATION_WORKER_ENABLED,
    });
    return;
  }

  if (!isEmailTransportConfigured()) {
    logger.warn('Runtime de automação de e-mail não iniciado: SMTP não configurado.', {
      action: 'email_automation_runtime_smtp_not_configured',
    });
    return;
  }

  started = true;
  stopping = false;
  inFlight = false;
  nextDelayMs = EMAIL_AUTOMATION_POLL_INTERVAL_MS;

  logger.info('Runtime de automação de e-mail iniciado.', {
    action: 'email_automation_runtime_started',
    poll_interval_ms: EMAIL_AUTOMATION_POLL_INTERVAL_MS,
    idle_backoff_multiplier: EMAIL_AUTOMATION_IDLE_BACKOFF_MULTIPLIER,
    idle_max_poll_interval_ms: EMAIL_AUTOMATION_IDLE_MAX_POLL_INTERVAL_MS,
    max_per_tick: EMAIL_AUTOMATION_MAX_PER_TICK,
    retry_delay_seconds: EMAIL_AUTOMATION_RETRY_DELAY_SECONDS,
  });

  void runLoopOnce();
};

export const stopEmailAutomationRuntime = () => {
  if (!started && !timerHandle) return;
  stopping = true;
  started = false;
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }

  logger.info('Runtime de automação de e-mail encerrado.', {
    action: 'email_automation_runtime_stopped',
  });
};

export const isEmailAutomationRuntimeEnabled = () => EMAIL_AUTOMATION_ENABLED && EMAIL_AUTOMATION_WORKER_ENABLED;
export const isEmailAutomationRuntimeRunning = () => started && !stopping;
