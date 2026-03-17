import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { getAllToolRecords } from '../services/ai/moduleToolRegistryService.js';
import { applyCommandConfigEnrichmentSuggestion, saveCommandConfigEnrichmentSuggestion } from '../services/ai/commandConfigEnrichmentRepository.js';
import { generateCommandConfigEnrichmentSuggestion } from '../services/ai/commandConfigEnrichmentService.js';
import { upsertAiHelpCachedResponse } from '../services/ai/aiHelpResponseCacheRepository.js';
import { markToolCandidateCommandConfigCacheDirty } from '../services/ai/toolCandidateSelectorService.js';

const DEFAULT_INTERVAL_MS = 4 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_MIN_AUTO_APPLY_CONFIDENCE = 0.7;
const DEFAULT_MAX_HELP_QUESTIONS_PER_COMMAND = 3;
const DEFAULT_MAX_HELP_CALLS_PER_CYCLE = 42;

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

const AI_HELP_CONTINUOUS_LEARNING_ENABLED = parseEnvBool(process.env.AI_HELP_CONTINUOUS_LEARNING_ENABLED, true);
const AI_HELP_CONTINUOUS_LEARNING_INTERVAL_MS = parseEnvInt(process.env.AI_HELP_CONTINUOUS_LEARNING_INTERVAL_MS, DEFAULT_INTERVAL_MS, 45_000, 24 * 60 * 60 * 1000);
const AI_HELP_CONTINUOUS_LEARNING_BATCH_SIZE = parseEnvInt(process.env.AI_HELP_CONTINUOUS_LEARNING_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 120);
const AI_HELP_CONTINUOUS_LEARNING_MIN_AUTO_APPLY_CONFIDENCE = parseEnvFloat(
  process.env.AI_HELP_CONTINUOUS_LEARNING_MIN_AUTO_APPLY_CONFIDENCE,
  DEFAULT_MIN_AUTO_APPLY_CONFIDENCE,
  0.1,
  0.99,
);
const AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_QUESTIONS_PER_COMMAND = parseEnvInt(
  process.env.AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_QUESTIONS_PER_COMMAND,
  DEFAULT_MAX_HELP_QUESTIONS_PER_COMMAND,
  1,
  12,
);
const AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_CALLS_PER_CYCLE = parseEnvInt(
  process.env.AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_CALLS_PER_CYCLE,
  DEFAULT_MAX_HELP_CALLS_PER_CYCLE,
  1,
  250,
);

let schedulerHandle = null;
let schedulerStarted = false;
let cycleInProgress = false;
let proactiveCursorIndex = 0;
let proactiveRound = 0;
let proactiveRegistrySignature = '';

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/_.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeDisplayText = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ');

const uniqueList = (items = [], limit = 8) => {
  const output = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeDisplayText(item);
    if (!normalized) continue;
    const dedupeKey = normalizeText(normalized);
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
};

const ensureArray = (value) => (Array.isArray(value) ? value : []);
const pickFirstText = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
};

const readCommandUsage = (entry = {}) => {
  const usageV2 = ensureArray(entry?.usage);
  if (usageV2.length) return usageV2;
  const docsUsage = ensureArray(entry?.docs?.usage_examples);
  if (docsUsage.length) return docsUsage;
  return ensureArray(entry?.metodos_de_uso);
};

const readCommandFaqPatterns = (entry = {}) => {
  const discovery = entry?.discovery && typeof entry.discovery === 'object' && !Array.isArray(entry.discovery) ? entry.discovery : {};
  const source = ensureArray(discovery?.faq_queries).length ? discovery.faq_queries : entry?.faq_patterns;
  return ensureArray(source);
};

const readCommandUserPhrasings = (entry = {}) => {
  const discovery = entry?.discovery && typeof entry.discovery === 'object' && !Array.isArray(entry.discovery) ? entry.discovery : {};
  const source = ensureArray(discovery?.user_phrasings).length ? discovery.user_phrasings : entry?.user_phrasings;
  return ensureArray(source);
};

const readCommandDescription = (entry = {}) => pickFirstText(entry?.description, entry?.docs?.summary, entry?.descricao);

const readCommandPermission = (entry = {}) => pickFirstText(entry?.permission, entry?.permissao_necessaria);

const readCommandContexts = (entry = {}) => {
  const contextsV2 = ensureArray(entry?.contexts);
  if (contextsV2.length) return contextsV2;
  return ensureArray(entry?.local_de_uso);
};

const readCommandUsageLimit = (entry = {}) => pickFirstText(entry?.limits?.usage_description, entry?.limite_de_uso);

const renderUsage = (method, commandPrefix = '/') => String(method || '').replaceAll('<prefix>', commandPrefix);

const computeRegistrySignature = (records = []) =>
  records
    .map((record) => `${record?.toolName || ''}:${record?.moduleKey || ''}:${record?.commandName || ''}`)
    .join('|');

const buildDeterministicExplainAnswer = ({ record, commandPrefix = '/' }) => {
  const entry = record?.commandEntry && typeof record.commandEntry === 'object' ? record.commandEntry : {};
  const commandName = String(record?.commandName || '').trim();
  const commandToken = `${commandPrefix}${commandName}`;
  const usage = readCommandUsage(entry).map((line) => renderUsage(line, commandPrefix));
  const description = readCommandDescription(entry) || 'Sem descricao cadastrada.';
  const permission = readCommandPermission(entry) || 'nao definido';
  const contexts = readCommandContexts(entry);
  const whereLabel = contexts.length ? contexts.join(', ') : 'nao definido';
  const usageLimit = readCommandUsageLimit(entry) || 'nao informado';

  const lines = [`Comando: ${commandToken}`, `Resumo: ${description}`, '', `Quem pode usar: ${permission}`, `Onde pode usar: ${whereLabel}`, `Limite: ${usageLimit}`, '', 'Como usar:', ...(usage.length ? usage.map((line) => `- ${line}`) : [`- ${commandToken}`]), '', 'Resposta pre-carregada em background para acelerar o IA Helper.'];
  return lines.join('\n');
};

const buildDeterministicQuestionAnswer = ({ question, record, commandPrefix = '/' }) => {
  const entry = record?.commandEntry && typeof record.commandEntry === 'object' ? record.commandEntry : {};
  const commandName = String(record?.commandName || '').trim();
  const commandToken = `${commandPrefix}${commandName}`;
  const usage = readCommandUsage(entry).map((line) => renderUsage(line, commandPrefix));
  const description = readCommandDescription(entry) || 'Sem descricao cadastrada.';
  const start = normalizeDisplayText(question);

  return [start ? `Pergunta: ${start}` : `Comando: ${commandToken}`, '', `Resumo: ${description}`, usage.length ? `Exemplo: ${usage[0]}` : `Exemplo: ${commandToken}`, `Para detalhes completos, use: ${commandPrefix}help ${commandName}`].join('\n');
};

const buildSyntheticEvent = ({ record, round = 0 }) => {
  const entry = record?.commandEntry && typeof record.commandEntry === 'object' ? record.commandEntry : {};
  const commandName = String(record?.commandName || '').trim();
  const usage = readCommandUsage(entry);
  const faq = readCommandFaqPatterns(entry);
  const phrasings = readCommandUserPhrasings(entry);

  const candidates = uniqueList(
    [
      ...phrasings,
      ...faq,
      ...usage,
      `como usar ${commandName}`,
      `o que faz ${commandName}`,
      `quando devo usar ${commandName}`,
      `me explica o comando ${commandName}`,
    ],
    18,
  );

  const picked = candidates.length ? candidates[round % candidates.length] : `como usar ${commandName}`;
  return {
    id: null,
    user_question: picked,
    normalized_question: normalizeText(picked),
    tool_suggested: record?.toolName || commandName,
    tool_executed: record?.toolName || commandName,
    success: true,
    confidence: 0.92,
  };
};

const buildHelpWarmupQuestions = ({ record, syntheticEvent }) => {
  const entry = record?.commandEntry && typeof record.commandEntry === 'object' ? record.commandEntry : {};
  const commandName = String(record?.commandName || '').trim();
  const usage = readCommandUsage(entry);
  const faq = readCommandFaqPatterns(entry);
  const phrasings = readCommandUserPhrasings(entry);

  return uniqueList(
    [
      syntheticEvent?.user_question || '',
      ...phrasings,
      ...faq,
      ...usage,
      `como usar /${commandName}`,
      `quero exemplo real de ${commandName}`,
      `o que eu recebo de resposta ao usar ${commandName}`,
    ],
    AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_QUESTIONS_PER_COMMAND,
  );
};

const saveAiHelpSeedCacheEntries = async ({ record, syntheticEvent, maxEntries = 3 }) => {
  const result = {
    helpCalls: 0,
    helpErrors: 0,
  };

  const commandName = String(record?.commandName || '').trim();
  const moduleKey = String(record?.moduleKey || '').trim();
  if (!commandName || !moduleKey) return result;

  const explainQuestion = `explicar comando ${commandName}`;
  const explainAnswer = buildDeterministicExplainAnswer({
    record,
    commandPrefix: '/',
  });

  try {
    await upsertAiHelpCachedResponse({
      moduleKey,
      scope: 'command_explain',
      question: explainQuestion,
      normalizedQuestion: explainQuestion,
      answer: explainAnswer,
      source: 'continuous_seed',
      commandName,
      metadata: {
        mode: 'continuous_learning',
        reason: 'command_explain_seed',
      },
    });
    result.helpCalls += 1;
  } catch (error) {
    result.helpErrors += 1;
    logger.warn('Falha ao persistir seed de command_explain no IA Helper continuo.', {
      action: 'ai_helper_continuous_learning_cache_seed_failed',
      module: moduleKey,
      command: commandName,
      error: error?.message,
    });
  }

  const questions = buildHelpWarmupQuestions({
    record,
    syntheticEvent,
  }).slice(0, Math.max(0, maxEntries - result.helpCalls));

  for (const question of questions) {
    try {
      await upsertAiHelpCachedResponse({
        moduleKey,
        scope: 'question',
        question,
        normalizedQuestion: question,
        answer: buildDeterministicQuestionAnswer({
          question,
          record,
          commandPrefix: '/',
        }),
        source: 'continuous_seed',
        commandName,
        metadata: {
          mode: 'continuous_learning',
          reason: 'question_seed',
        },
      });
      result.helpCalls += 1;
    } catch (error) {
      result.helpErrors += 1;
      logger.warn('Falha ao persistir seed de question no IA Helper continuo.', {
        action: 'ai_helper_continuous_learning_cache_question_seed_failed',
        module: moduleKey,
        command: commandName,
        question,
        error: error?.message,
      });
    }
  }

  return result;
};

const selectProactiveBatch = () => {
  const records = getAllToolRecords();
  if (!records.length) {
    proactiveCursorIndex = 0;
    proactiveRound = 0;
    proactiveRegistrySignature = '';
    return {
      records: [],
      batch: [],
      previousCursor: 0,
      nextCursor: 0,
      completedRound: false,
    };
  }

  const signature = computeRegistrySignature(records);
  if (signature !== proactiveRegistrySignature) {
    proactiveRegistrySignature = signature;
    proactiveCursorIndex = 0;
    proactiveRound = 0;
  }

  const previousCursor = proactiveCursorIndex;
  const safeBatchSize = Math.max(1, Math.min(AI_HELP_CONTINUOUS_LEARNING_BATCH_SIZE, records.length));
  const batch = [];
  for (let index = 0; index < safeBatchSize; index += 1) {
    const cursor = (proactiveCursorIndex + index) % records.length;
    batch.push(records[cursor]);
  }

  proactiveCursorIndex = (proactiveCursorIndex + safeBatchSize) % records.length;
  const completedRound = records.length > 0 && proactiveCursorIndex === 0;
  if (completedRound) proactiveRound += 1;

  return {
    records,
    batch,
    previousCursor,
    nextCursor: proactiveCursorIndex,
    completedRound,
  };
};

const processProactiveCommand = async ({ record, round = 0, helpCallBudget = Infinity }) => {
  const syntheticEvent = buildSyntheticEvent({
    record,
    round,
  });

  const result = {
    suggestionGenerated: 0,
    suggestionApplied: 0,
    suggestionChanged: 0,
    helpCalls: 0,
    helpErrors: 0,
  };

  const suggestionOutput = await generateCommandConfigEnrichmentSuggestion({
    learningEvent: syntheticEvent,
    toolRecord: record,
  });

  if (suggestionOutput?.suggestion) {
    const savedSuggestion = await saveCommandConfigEnrichmentSuggestion({
      moduleKey: record.moduleKey,
      commandName: record.commandName,
      sourceTool: record.toolName,
      sourceEventId: null,
      question: syntheticEvent.user_question,
      normalizedQuestion: syntheticEvent.normalized_question,
      suggestion: suggestionOutput.suggestion,
      confidence: suggestionOutput.confidence,
      modelName: suggestionOutput.modelName,
      source: suggestionOutput.source,
      status: 'pending',
    });

    if (savedSuggestion?.id) {
      result.suggestionGenerated += 1;
      const sourceValue = String(savedSuggestion.source || '');
      const shouldAutoApply = savedSuggestion.confidence >= AI_HELP_CONTINUOUS_LEARNING_MIN_AUTO_APPLY_CONFIDENCE && sourceValue.startsWith('llm');

      if (shouldAutoApply) {
        const applyResult = await applyCommandConfigEnrichmentSuggestion({
          suggestionId: savedSuggestion.id,
          reviewNotes: `auto_apply_proactive: confidence>=${AI_HELP_CONTINUOUS_LEARNING_MIN_AUTO_APPLY_CONFIDENCE}`,
        });
        if (applyResult?.applied) {
          result.suggestionApplied += 1;
          if (applyResult.changed) result.suggestionChanged += 1;
        }
      }
    }
  }

  if (helpCallBudget <= 0) {
    return result;
  }

  const cacheSeedResult = await saveAiHelpSeedCacheEntries({
    record,
    syntheticEvent,
    maxEntries: Math.max(1, helpCallBudget),
  });
  result.helpCalls += cacheSeedResult.helpCalls;
  result.helpErrors += cacheSeedResult.helpErrors;

  return result;
};

const processContinuousLearningBatch = async ({ reason = 'scheduler' } = {}) => {
  if (cycleInProgress) return;
  if (!AI_HELP_CONTINUOUS_LEARNING_ENABLED) return;

  cycleInProgress = true;
  const startedAt = __timeNowMs();

  try {
    const selected = selectProactiveBatch();
    if (!selected.batch.length) {
    logger.info('Worker de aprendizado continuo IA sem comandos no registry.', {
        action: 'ai_helper_continuous_learning_cycle_processed',
        reason,
        fetched_commands: 0,
        generated_suggestions: 0,
        applied_suggestions: 0,
        changed_suggestions: 0,
        help_calls: 0,
        help_errors: 0,
        duration_ms: __timeNowMs() - startedAt,
      });
      return;
    }

    let generatedSuggestions = 0;
    let appliedSuggestions = 0;
    let changedSuggestions = 0;
    let helpCalls = 0;
    let helpErrors = 0;
    let processedCommands = 0;

    for (const record of selected.batch) {
      if (!record) continue;
      const remainingHelpBudget = AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_CALLS_PER_CYCLE - helpCalls;
      if (remainingHelpBudget <= 0 && processedCommands > 0) {
        break;
      }

      try {
        const commandResult = await processProactiveCommand({
          record,
          round: proactiveRound,
          helpCallBudget: Math.max(0, remainingHelpBudget),
        });
        generatedSuggestions += commandResult.suggestionGenerated;
        appliedSuggestions += commandResult.suggestionApplied;
        changedSuggestions += commandResult.suggestionChanged;
        helpCalls += commandResult.helpCalls;
        helpErrors += commandResult.helpErrors;
        processedCommands += 1;
      } catch (error) {
        logger.warn('Falha ao processar comando no worker de aprendizado continuo IA.', {
          action: 'ai_helper_continuous_learning_command_failed',
          module: record?.moduleKey || null,
          command: record?.commandName || null,
          error: error?.message,
        });
      }
    }

    if (changedSuggestions > 0) {
      markToolCandidateCommandConfigCacheDirty();
    }

    logger.info('Ciclo do worker de aprendizado continuo IA concluido.', {
      action: 'ai_helper_continuous_learning_cycle_processed',
      reason,
      previous_cursor: selected.previousCursor,
      next_cursor: selected.nextCursor,
      completed_round: selected.completedRound,
      round: proactiveRound,
      registry_size: selected.records.length,
      fetched_commands: selected.batch.length,
      processed_commands: processedCommands,
      generated_suggestions: generatedSuggestions,
      applied_suggestions: appliedSuggestions,
      changed_suggestions: changedSuggestions,
      help_calls: helpCalls,
      help_errors: helpErrors,
      max_help_calls_per_cycle: AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_CALLS_PER_CYCLE,
      duration_ms: __timeNowMs() - startedAt,
    });
  } finally {
    cycleInProgress = false;
  }
};

export const startAiHelperContinuousLearningWorker = () => {
  if (schedulerStarted) return;

  if (!AI_HELP_CONTINUOUS_LEARNING_ENABLED) {
    logger.info('Worker de aprendizado continuo IA desativado.', {
      action: 'ai_helper_continuous_learning_worker_disabled',
      enabled: AI_HELP_CONTINUOUS_LEARNING_ENABLED,
    });
    return;
  }

  schedulerStarted = true;
  void processContinuousLearningBatch({ reason: 'startup' });

  schedulerHandle = setInterval(() => {
    void processContinuousLearningBatch({ reason: 'scheduler' });
  }, AI_HELP_CONTINUOUS_LEARNING_INTERVAL_MS);
  if (typeof schedulerHandle?.unref === 'function') {
    schedulerHandle.unref();
  }

  logger.info('Scheduler do worker de aprendizado continuo IA iniciado.', {
    action: 'ai_helper_continuous_learning_worker_scheduler_started',
    interval_ms: AI_HELP_CONTINUOUS_LEARNING_INTERVAL_MS,
    batch_size: AI_HELP_CONTINUOUS_LEARNING_BATCH_SIZE,
    min_auto_apply_confidence: AI_HELP_CONTINUOUS_LEARNING_MIN_AUTO_APPLY_CONFIDENCE,
    max_help_questions_per_command: AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_QUESTIONS_PER_COMMAND,
    max_help_calls_per_cycle: AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_CALLS_PER_CYCLE,
  });
};

export const stopAiHelperContinuousLearningWorker = () => {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  schedulerStarted = false;
};

export const runAiHelperContinuousLearningWorkerOnce = async (reason = 'manual') => {
  await processContinuousLearningBatch({
    reason,
  });
};

export const getAiHelperContinuousLearningWorkerConfig = () => ({
  enabled: AI_HELP_CONTINUOUS_LEARNING_ENABLED,
  intervalMs: AI_HELP_CONTINUOUS_LEARNING_INTERVAL_MS,
  batchSize: AI_HELP_CONTINUOUS_LEARNING_BATCH_SIZE,
  minAutoApplyConfidence: AI_HELP_CONTINUOUS_LEARNING_MIN_AUTO_APPLY_CONFIDENCE,
  maxHelpQuestionsPerCommand: AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_QUESTIONS_PER_COMMAND,
  maxHelpCallsPerCycle: AI_HELP_CONTINUOUS_LEARNING_MAX_HELP_CALLS_PER_CYCLE,
  startedAt: __timeNowIso(),
});
