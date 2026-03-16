import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { getToolRecord } from '../services/ai/moduleToolRegistryService.js';
import { applyCommandConfigEnrichmentSuggestion, getCommandConfigEnrichmentCursor, listLearningEventsForCommandConfigEnrichment, saveCommandConfigEnrichmentSuggestion, updateCommandConfigEnrichmentCursor } from '../services/ai/commandConfigEnrichmentRepository.js';
import { generateCommandConfigEnrichmentSuggestion } from '../services/ai/commandConfigEnrichmentService.js';
import { markToolCandidateCommandConfigCacheDirty } from '../services/ai/toolCandidateSelectorService.js';

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_MIN_AUTO_APPLY_CONFIDENCE = 0.72;

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseEnvInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const parseEnvFloat = (value, fallback, min, max) => {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const COMMAND_CONFIG_ENRICHMENT_WORKER_ENABLED = parseEnvBool(process.env.COMMAND_CONFIG_ENRICHMENT_WORKER_ENABLED, true);
const COMMAND_CONFIG_ENRICHMENT_WORKER_INTERVAL_MS = parseEnvInt(process.env.COMMAND_CONFIG_ENRICHMENT_WORKER_INTERVAL_MS, DEFAULT_INTERVAL_MS, 60_000, 24 * 60 * 60 * 1000);
const COMMAND_CONFIG_ENRICHMENT_WORKER_BATCH_SIZE = parseEnvInt(process.env.COMMAND_CONFIG_ENRICHMENT_WORKER_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 200);
const COMMAND_CONFIG_ENRICHMENT_MIN_AUTO_APPLY_CONFIDENCE = parseEnvFloat(process.env.COMMAND_CONFIG_ENRICHMENT_MIN_AUTO_APPLY_CONFIDENCE, DEFAULT_MIN_AUTO_APPLY_CONFIDENCE, 0.1, 0.99);

let schedulerHandle = null;
let schedulerStarted = false;
let cycleInProgress = false;

const isWorkerReady = () => COMMAND_CONFIG_ENRICHMENT_WORKER_ENABLED;

const resolveToolRecordFromEvent = (event = {}) => {
  const candidates = [event?.tool_executed, event?.tool_suggested];
  for (const candidate of candidates) {
    const record = getToolRecord(candidate);
    if (record) return record;
  }
  return null;
};

const processEnrichmentBatch = async ({ reason = 'scheduler' } = {}) => {
  if (cycleInProgress) return;
  if (!isWorkerReady()) return;

  cycleInProgress = true;
  const startedAt = __timeNowMs();

  try {
    logger.info('Worker de enriquecimento de commandConfig iniciado.', {
      action: 'command_config_enrichment_worker_started',
      reason,
      batch_size: COMMAND_CONFIG_ENRICHMENT_WORKER_BATCH_SIZE,
      min_auto_apply_confidence: COMMAND_CONFIG_ENRICHMENT_MIN_AUTO_APPLY_CONFIDENCE,
    });

    const cursor = await getCommandConfigEnrichmentCursor();
    const events = await listLearningEventsForCommandConfigEnrichment({
      afterId: cursor,
      limit: COMMAND_CONFIG_ENRICHMENT_WORKER_BATCH_SIZE,
    });

    if (!events.length) {
      logger.info('Nenhum evento novo para enriquecimento de commandConfig.', {
        action: 'command_config_enrichment_batch_processed',
        reason,
        cursor,
        fetched_events: 0,
        generated_suggestions: 0,
        auto_applied: 0,
        applied_changed: 0,
        duration_ms: __timeNowMs() - startedAt,
      });
      return;
    }

    let highestEventId = cursor;
    let generatedSuggestions = 0;
    let autoApplied = 0;
    let appliedChanged = 0;
    let skippedUnknownTool = 0;

    for (const event of events) {
      highestEventId = Math.max(highestEventId, Number(event?.id || 0));

      const toolRecord = resolveToolRecordFromEvent(event);
      if (!toolRecord) {
        skippedUnknownTool += 1;
        logger.debug('Evento sem tool registrada para enriquecimento de commandConfig.', {
          action: 'command_config_enrichment_event_tool_unknown',
          source_event_id: event?.id || null,
          tool_executed: event?.tool_executed || null,
          tool_suggested: event?.tool_suggested || null,
        });
        continue;
      }

      try {
        const suggestionOutput = await generateCommandConfigEnrichmentSuggestion({
          learningEvent: event,
          toolRecord,
        });
        if (!suggestionOutput?.suggestion) continue;

        const savedSuggestion = await saveCommandConfigEnrichmentSuggestion({
          moduleKey: toolRecord.moduleKey,
          commandName: toolRecord.commandName,
          sourceTool: event.tool_executed || event.tool_suggested,
          sourceEventId: event.id,
          question: event.user_question,
          normalizedQuestion: event.normalized_question,
          suggestion: suggestionOutput.suggestion,
          confidence: suggestionOutput.confidence,
          modelName: suggestionOutput.modelName,
          source: suggestionOutput.source,
          status: 'pending',
        });
        if (!savedSuggestion?.id) continue;

        generatedSuggestions += 1;
        logger.info('Sugestao de enriquecimento de commandConfig gerada.', {
          action: 'command_config_enrichment_suggestion_generated',
          suggestion_id: savedSuggestion.id,
          source_event_id: event.id,
          module_key: savedSuggestion.module_key,
          command_name: savedSuggestion.command_name,
          source: savedSuggestion.source,
          confidence: savedSuggestion.confidence,
          success_signal: Boolean(event.success),
        });

        const shouldAutoApply = savedSuggestion.confidence >= COMMAND_CONFIG_ENRICHMENT_MIN_AUTO_APPLY_CONFIDENCE && (event.success || savedSuggestion.source !== 'heuristic');

        if (!shouldAutoApply) continue;

        const applyResult = await applyCommandConfigEnrichmentSuggestion({
          suggestionId: savedSuggestion.id,
          reviewNotes: `auto_apply: confidence>=${COMMAND_CONFIG_ENRICHMENT_MIN_AUTO_APPLY_CONFIDENCE}`,
        });
        if (!applyResult?.applied) continue;

        autoApplied += 1;
        if (applyResult.changed) appliedChanged += 1;

        logger.info('Sugestao de enriquecimento de commandConfig aplicada.', {
          action: 'command_config_enrichment_suggestion_applied',
          suggestion_id: savedSuggestion.id,
          module_key: savedSuggestion.module_key,
          command_name: savedSuggestion.command_name,
          new_version: applyResult.version,
          changed: Boolean(applyResult.changed),
        });
      } catch (error) {
        logger.warn('Falha ao processar evento de enriquecimento de commandConfig.', {
          action: 'command_config_enrichment_event_failed',
          source_event_id: event?.id || null,
          tool_executed: event?.tool_executed || null,
          error: error?.message,
        });
      }
    }

    if (highestEventId > cursor) {
      await updateCommandConfigEnrichmentCursor(highestEventId);
    }
    if (appliedChanged > 0) {
      markToolCandidateCommandConfigCacheDirty();
    }

    logger.info('Batch de enriquecimento de commandConfig processado.', {
      action: 'command_config_enrichment_batch_processed',
      reason,
      previous_cursor: cursor,
      next_cursor: highestEventId,
      fetched_events: events.length,
      generated_suggestions: generatedSuggestions,
      auto_applied: autoApplied,
      applied_changed: appliedChanged,
      skipped_unknown_tool: skippedUnknownTool,
      duration_ms: __timeNowMs() - startedAt,
    });
  } finally {
    cycleInProgress = false;
  }
};

export const startCommandConfigEnrichmentWorker = () => {
  if (schedulerStarted) return;

  if (!isWorkerReady()) {
    logger.info('Worker de enriquecimento de commandConfig desativado.', {
      action: 'command_config_enrichment_worker_disabled',
      enabled: COMMAND_CONFIG_ENRICHMENT_WORKER_ENABLED,
    });
    return;
  }

  schedulerStarted = true;
  void processEnrichmentBatch({ reason: 'startup' });

  schedulerHandle = setInterval(() => {
    void processEnrichmentBatch({ reason: 'scheduler' });
  }, COMMAND_CONFIG_ENRICHMENT_WORKER_INTERVAL_MS);
  if (typeof schedulerHandle?.unref === 'function') {
    schedulerHandle.unref();
  }

  logger.info('Scheduler do worker de enriquecimento de commandConfig iniciado.', {
    action: 'command_config_enrichment_worker_scheduler_started',
    interval_ms: COMMAND_CONFIG_ENRICHMENT_WORKER_INTERVAL_MS,
    batch_size: COMMAND_CONFIG_ENRICHMENT_WORKER_BATCH_SIZE,
    min_auto_apply_confidence: COMMAND_CONFIG_ENRICHMENT_MIN_AUTO_APPLY_CONFIDENCE,
  });
};

export const stopCommandConfigEnrichmentWorker = () => {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  schedulerStarted = false;
};

export const runCommandConfigEnrichmentWorkerOnce = async (reason = 'manual') => {
  await processEnrichmentBatch({ reason });
};

export const getCommandConfigEnrichmentWorkerConfig = () => ({
  enabled: COMMAND_CONFIG_ENRICHMENT_WORKER_ENABLED,
  intervalMs: COMMAND_CONFIG_ENRICHMENT_WORKER_INTERVAL_MS,
  batchSize: COMMAND_CONFIG_ENRICHMENT_WORKER_BATCH_SIZE,
  minAutoApplyConfidence: COMMAND_CONFIG_ENRICHMENT_MIN_AUTO_APPLY_CONFIDENCE,
});
