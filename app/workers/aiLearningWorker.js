import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import OpenAI from 'openai';
import logger from '#logger';
import { insertLearnedKeywords, insertLearnedPatterns, listPendingLearningEvents, markLearningEventsProcessed } from '../services/ai/aiLearningRepository.js';
import { getAllToolRecords, getToolRegistryStats } from '../services/ai/moduleToolRegistryService.js';
import { markToolCandidateLearningCacheDirty } from '../services/ai/toolCandidateSelectorService.js';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_PATTERNS_PER_EVENT = 5;
const DEFAULT_MAX_KEYWORDS_PER_EVENT = 12;
const DEFAULT_CONFIG_SEED_ENABLED = true;
const DEFAULT_CONFIG_SEED_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CONFIG_SEED_MAX_PATTERNS_PER_TOOL = 24;
const DEFAULT_CONFIG_SEED_MAX_KEYWORDS_PER_TOOL = 40;
const CONFIG_SEED_EVENT_ID_BASE = 9_000_000_000;

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

const AI_LEARNING_WORKER_ENABLED = parseEnvBool(process.env.AI_LEARNING_WORKER_ENABLED, true);
const AI_LEARNING_WORKER_INTERVAL_MS = parseEnvInt(process.env.AI_LEARNING_WORKER_INTERVAL_MS, DEFAULT_INTERVAL_MS, 60_000, 24 * 60 * 60 * 1000);
const AI_LEARNING_WORKER_BATCH_SIZE = parseEnvInt(process.env.AI_LEARNING_WORKER_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 200);
const AI_LEARNING_WORKER_TIMEOUT_MS = parseEnvInt(process.env.AI_LEARNING_WORKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5_000, 60_000);
const AI_LEARNING_WORKER_MODEL = String(process.env.AI_LEARNING_WORKER_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
const AI_LEARNING_WORKER_MAX_PATTERNS = parseEnvInt(process.env.AI_LEARNING_WORKER_MAX_PATTERNS, DEFAULT_MAX_PATTERNS_PER_EVENT, 1, 12);
const AI_LEARNING_WORKER_MAX_KEYWORDS = parseEnvInt(process.env.AI_LEARNING_WORKER_MAX_KEYWORDS, DEFAULT_MAX_KEYWORDS_PER_EVENT, 3, 30);
const AI_LEARNING_WORKER_CONFIG_SEED_ENABLED = parseEnvBool(process.env.AI_LEARNING_WORKER_CONFIG_SEED_ENABLED, DEFAULT_CONFIG_SEED_ENABLED);
const AI_LEARNING_WORKER_CONFIG_SEED_INTERVAL_MS = parseEnvInt(process.env.AI_LEARNING_WORKER_CONFIG_SEED_INTERVAL_MS, DEFAULT_CONFIG_SEED_INTERVAL_MS, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const AI_LEARNING_WORKER_CONFIG_SEED_MAX_PATTERNS = parseEnvInt(process.env.AI_LEARNING_WORKER_CONFIG_SEED_MAX_PATTERNS, DEFAULT_CONFIG_SEED_MAX_PATTERNS_PER_TOOL, 4, 96);
const AI_LEARNING_WORKER_CONFIG_SEED_MAX_KEYWORDS = parseEnvInt(process.env.AI_LEARNING_WORKER_CONFIG_SEED_MAX_KEYWORDS, DEFAULT_CONFIG_SEED_MAX_KEYWORDS_PER_TOOL, 8, 140);

let schedulerHandle = null;
let schedulerStarted = false;
let cycleInProgress = false;
let cachedClient = null;
let lastConfigSeedSignature = '';
let nextConfigSeedAt = 0;

const hasOpenAiApiKey = () => Boolean(String(process.env.OPENAI_API_KEY || '').trim());

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/_.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ensureArray = (value) => (Array.isArray(value) ? value : []);

const readCommandUsage = (entry = {}) => {
  const usageV2 = ensureArray(entry?.usage);
  if (usageV2.length) return usageV2;
  const docsUsage = ensureArray(entry?.docs?.usage_examples);
  if (docsUsage.length) return docsUsage;
  return ensureArray(entry?.metodos_de_uso);
};

const readCommandDiscovery = (entry = {}) => {
  if (!entry?.discovery || typeof entry.discovery !== 'object' || Array.isArray(entry.discovery)) {
    return {};
  }
  return entry.discovery;
};

const readCommandFaqPatterns = (entry = {}) => {
  const discovery = readCommandDiscovery(entry);
  const source = ensureArray(discovery.faq_queries).length ? discovery.faq_queries : entry?.faq_patterns;
  return ensureArray(source);
};

const readCommandUserPhrasings = (entry = {}) => {
  const discovery = readCommandDiscovery(entry);
  const source = ensureArray(discovery.user_phrasings).length ? discovery.user_phrasings : entry?.user_phrasings;
  return ensureArray(source);
};

const readCommandKeywords = (entry = {}) => {
  const discovery = readCommandDiscovery(entry);
  const source = ensureArray(discovery.keywords).length ? discovery.keywords : entry?.capability_keywords;
  return ensureArray(source);
};

const readCommandCategory = (entry = {}) => String(entry?.category || entry?.categoria || '').trim();

const readCommandContexts = (entry = {}) => {
  const contextsV2 = ensureArray(entry?.contexts);
  if (contextsV2.length) return contextsV2;
  return ensureArray(entry?.local_de_uso);
};

const normalizeCommandToken = (value) => normalizeText(value).replace(/\s+/g, '').slice(0, 64);

const uniqueList = (items = []) =>
  Array.from(new Set((Array.isArray(items) ? items : []).map((item) => normalizeText(item))))
    .filter(Boolean)
    .map((item) => item.trim());

const uniqueTokenList = (items = []) => {
  const tokens = [];
  for (const value of Array.isArray(items) ? items : []) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    for (const token of normalized.split(/\s+/)) {
      if (!token || token.length < 3) continue;
      if (!tokens.includes(token)) tokens.push(token);
    }
  }
  return tokens;
};

const sanitizePattern = (value) => {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 512);
  return normalized || null;
};

const sanitizeKeyword = (value) => {
  const normalized = normalizeText(value).slice(0, 128);
  return normalized || null;
};

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const hashToolNameToUint32 = (value) => {
  const input = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
};

const toConfigSeedEventId = (toolName) => CONFIG_SEED_EVENT_ID_BASE + hashToolNameToUint32(toolName);

const extractTextFromAssistantMessage = (message = {}) => {
  if (typeof message?.content === 'string') return message.content.trim();
  if (!Array.isArray(message?.content)) return '';

  const parts = [];
  for (const chunk of message.content) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (typeof chunk.text === 'string') {
      parts.push(chunk.text.trim());
      continue;
    }
    if (chunk.type === 'text' && typeof chunk?.text?.value === 'string') {
      parts.push(chunk.text.value.trim());
    }
  }

  return parts.filter(Boolean).join('\n').trim();
};

const parseJsonSafe = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
};

const getOpenAIClient = () => {
  if (!cachedClient) {
    cachedClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: AI_LEARNING_WORKER_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return cachedClient;
};

const isWorkerReady = () => {
  if (!AI_LEARNING_WORKER_ENABLED) return false;
  if (AI_LEARNING_WORKER_CONFIG_SEED_ENABLED) return true;
  if (!hasOpenAiApiKey()) return false;
  return true;
};

const buildWorkerSystemPrompt = () => ['Voce recebe um comando existente e a pergunta real do usuario.', 'Sua tarefa e minerar variacoes semanticas para aprendizado.', 'Nunca invente novos comandos, nomes de tools ou parametros de execucao.', 'Retorne SOMENTE JSON valido no formato:', '{"alternative_phrases":[],"semantic_keywords":[],"intent_description":"","possible_intents":[],"confidence":0.0}', 'alternative_phrases: frases curtas no idioma do usuario.', 'semantic_keywords: termos importantes (sem comandos).', 'possible_intents: intencoes curtas e genericas.', 'confidence: numero de 0.0 a 1.0 para qualidade do aprendizado.'].join(' ');

const generateLearningArtifacts = async (event) => {
  const client = getOpenAIClient();
  const completion = await client.chat.completions.create({
    model: AI_LEARNING_WORKER_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: buildWorkerSystemPrompt(),
      },
      {
        role: 'user',
        content: [`Command: ${event.tool_executed}`, `User question: "${event.user_question}"`, `Normalized question: "${event.normalized_question}"`, '', `Generate up to ${AI_LEARNING_WORKER_MAX_PATTERNS} alternative user phrases,`, `up to ${AI_LEARNING_WORKER_MAX_KEYWORDS} semantic keywords,`, 'and a short intent description.'].join('\n'),
      },
    ],
  });

  const message = completion?.choices?.[0]?.message || {};
  const rawJson = extractTextFromAssistantMessage(message);
  const parsed = parseJsonSafe(rawJson) || {};

  const rawPatterns = uniqueList(parsed?.alternative_phrases || []).slice(0, AI_LEARNING_WORKER_MAX_PATTERNS);
  const rawKeywords = uniqueList(parsed?.semantic_keywords || []).slice(0, AI_LEARNING_WORKER_MAX_KEYWORDS);

  const patterns = rawPatterns.map((value) => sanitizePattern(value)).filter(Boolean);
  const keywords = rawKeywords.map((value) => sanitizeKeyword(value)).filter(Boolean);
  const possibleIntents = uniqueList(parsed?.possible_intents || []).slice(0, 6);
  const intentDescription = sanitizePattern(parsed?.intent_description || '');
  const confidence = clamp01(parsed?.confidence);

  return {
    patterns,
    keywords,
    possibleIntents,
    intentDescription,
    confidence,
    rawJson: rawJson.slice(0, 2000),
  };
};

const buildConfigSeedRowsFromRecord = (record = {}) => {
  const commandEntry = record?.commandEntry && typeof record.commandEntry === 'object' ? record.commandEntry : {};
  const toolName = normalizeCommandToken(record?.toolName);
  const commandName = normalizeCommandToken(record?.commandName || commandEntry?.name);
  if (!toolName || !commandName) {
    return {
      patternRows: [],
      keywordRows: [],
    };
  }

  const aliases = ensureArray(commandEntry?.aliases)
    .map((alias) => normalizeCommandToken(alias))
    .filter(Boolean);
  const usageHints = readCommandUsage(commandEntry);
  const faqPatterns = readCommandFaqPatterns(commandEntry);
  const userPhrasings = readCommandUserPhrasings(commandEntry);

  const seedPatternCandidates = uniqueList([...faqPatterns, ...userPhrasings, ...usageHints, `como usar ${commandName}`, `o que faz ${commandName}`, `comando ${commandName}`, ...aliases.map((alias) => `comando ${alias}`), ...aliases.map((alias) => `como usar ${alias}`)]).slice(0, AI_LEARNING_WORKER_CONFIG_SEED_MAX_PATTERNS);

  const category = readCommandCategory(commandEntry);
  const contexts = readCommandContexts(commandEntry);
  const keywordTokens = uniqueTokenList([...readCommandKeywords(commandEntry), ...faqPatterns, ...userPhrasings, ...usageHints, commandName, ...aliases, category, ...contexts]).slice(0, AI_LEARNING_WORKER_CONFIG_SEED_MAX_KEYWORDS);

  const sourceEventId = toConfigSeedEventId(toolName);
  const patternRows = seedPatternCandidates
    .map((pattern) => sanitizePattern(pattern))
    .filter(Boolean)
    .map((pattern) => ({
      pattern,
      tool: toolName,
      confidence: 0.62,
      sourceEventId,
    }));

  const keywordRows = keywordTokens
    .map((keyword) => sanitizeKeyword(keyword))
    .filter(Boolean)
    .map((keyword) => ({
      keyword,
      tool: toolName,
      weight: 0.68,
      sourceEventId,
    }));

  return {
    patternRows,
    keywordRows,
  };
};

const seedLearningFromCommandConfig = async ({ reason = 'scheduler' } = {}) => {
  if (!AI_LEARNING_WORKER_CONFIG_SEED_ENABLED) {
    return {
      executed: false,
      skipped: 'disabled',
      insertedPatterns: 0,
      insertedKeywords: 0,
      toolCount: 0,
      candidatePatterns: 0,
      candidateKeywords: 0,
    };
  }

  const nowMs = __timeNowMs();
  const registryStats = getToolRegistryStats();
  const registrySignature = String(registryStats?.signature || '');

  if (registrySignature && registrySignature === lastConfigSeedSignature && nextConfigSeedAt > nowMs) {
    return {
      executed: false,
      skipped: 'cooldown',
      insertedPatterns: 0,
      insertedKeywords: 0,
      toolCount: Number(registryStats?.toolCount || 0),
      candidatePatterns: 0,
      candidateKeywords: 0,
      nextRunAt: new Date(nextConfigSeedAt).toISOString(),
    };
  }

  const records = getAllToolRecords();
  if (!records.length) {
    lastConfigSeedSignature = registrySignature;
    nextConfigSeedAt = nowMs + AI_LEARNING_WORKER_CONFIG_SEED_INTERVAL_MS;
    return {
      executed: false,
      skipped: 'empty_registry',
      insertedPatterns: 0,
      insertedKeywords: 0,
      toolCount: 0,
      candidatePatterns: 0,
      candidateKeywords: 0,
    };
  }

  const allPatternRows = [];
  const allKeywordRows = [];
  for (const record of records) {
    const rows = buildConfigSeedRowsFromRecord(record);
    allPatternRows.push(...rows.patternRows);
    allKeywordRows.push(...rows.keywordRows);
  }

  const insertedPatterns = await insertLearnedPatterns(allPatternRows);
  const insertedKeywords = await insertLearnedKeywords(allKeywordRows);

  if (insertedPatterns > 0 || insertedKeywords > 0) {
    markToolCandidateLearningCacheDirty();
  }

  lastConfigSeedSignature = registrySignature;
  nextConfigSeedAt = nowMs + AI_LEARNING_WORKER_CONFIG_SEED_INTERVAL_MS;

  logger.info('Seed de aprendizado IA por commandConfig processado.', {
    action: 'ai_learning_config_seed_processed',
    reason,
    registry_signature: registrySignature || null,
    tool_count: records.length,
    candidate_patterns: allPatternRows.length,
    candidate_keywords: allKeywordRows.length,
    inserted_patterns: insertedPatterns,
    inserted_keywords: insertedKeywords,
    next_run_at: new Date(nextConfigSeedAt).toISOString(),
  });

  return {
    executed: true,
    skipped: null,
    insertedPatterns,
    insertedKeywords,
    toolCount: records.length,
    candidatePatterns: allPatternRows.length,
    candidateKeywords: allKeywordRows.length,
    nextRunAt: new Date(nextConfigSeedAt).toISOString(),
  };
};

const processLearningBatch = async ({ reason = 'scheduler' } = {}) => {
  if (cycleInProgress) return;
  if (!isWorkerReady()) return;

  cycleInProgress = true;
  try {
    const startedAt = __timeNowMs();
    logger.info('Worker de aprendizado IA iniciado.', {
      action: 'ai_learning_worker_started',
      reason,
      model: AI_LEARNING_WORKER_MODEL,
      batch_size: AI_LEARNING_WORKER_BATCH_SIZE,
    });

    let events = [];
    try {
      events = await listPendingLearningEvents({ limit: AI_LEARNING_WORKER_BATCH_SIZE });
    } catch (error) {
      logger.warn('Falha ao buscar eventos pendentes de aprendizado.', {
        action: 'ai_learning_batch_fetch_failed',
        error: error?.message,
      });
      return;
    }

    let configSeedResult = {
      executed: false,
      skipped: 'disabled',
      insertedPatterns: 0,
      insertedKeywords: 0,
      toolCount: 0,
    };
    try {
      configSeedResult = await seedLearningFromCommandConfig({ reason });
    } catch (error) {
      logger.warn('Falha ao executar seed de aprendizado IA por commandConfig.', {
        action: 'ai_learning_config_seed_failed',
        reason,
        error: error?.message,
      });
    }

    if (!events.length) {
      logger.info('Nenhum evento pendente para aprendizado IA.', {
        action: 'ai_learning_batch_processed',
        reason,
        fetched_events: 0,
        processed_events: 0,
        generated_patterns: configSeedResult.insertedPatterns,
        generated_keywords: configSeedResult.insertedKeywords,
        config_seed_enabled: AI_LEARNING_WORKER_CONFIG_SEED_ENABLED,
        config_seed_executed: configSeedResult.executed,
        config_seed_skipped: configSeedResult.skipped,
        config_seed_tool_count: configSeedResult.toolCount,
        duration_ms: __timeNowMs() - startedAt,
      });
      return;
    }

    if (!hasOpenAiApiKey()) {
      logger.warn('Eventos pendentes de aprendizado IA foram ignorados por ausencia de OPENAI_API_KEY.', {
        action: 'ai_learning_pending_events_skipped_no_api_key',
        reason,
        pending_events: events.length,
      });
      logger.info('Batch de aprendizado IA processado com seed de commandConfig e sem processamento LLM.', {
        action: 'ai_learning_batch_processed',
        reason,
        fetched_events: events.length,
        processed_events: 0,
        successful_events: 0,
        generated_patterns: configSeedResult.insertedPatterns,
        generated_keywords: configSeedResult.insertedKeywords,
        skipped_events_no_api_key: events.length,
        config_seed_enabled: AI_LEARNING_WORKER_CONFIG_SEED_ENABLED,
        config_seed_executed: configSeedResult.executed,
        config_seed_skipped: configSeedResult.skipped,
        config_seed_tool_count: configSeedResult.toolCount,
        duration_ms: __timeNowMs() - startedAt,
      });
      return;
    }

    const processedEventIds = [];
    let generatedPatterns = 0;
    let generatedKeywords = 0;
    let successfulEvents = 0;

    for (const event of events) {
      try {
        const artifacts = await generateLearningArtifacts(event);

        const patternRows = artifacts.patterns.map((pattern) => ({
          pattern,
          tool: event.tool_executed,
          confidence: artifacts.confidence || event.confidence || 0.5,
          sourceEventId: event.id,
        }));
        const keywordRows = artifacts.keywords.map((keyword) => ({
          keyword,
          tool: event.tool_executed,
          weight: artifacts.confidence || event.confidence || 0.7,
          sourceEventId: event.id,
        }));

        const insertedPatterns = await insertLearnedPatterns(patternRows);
        const insertedKeywords = await insertLearnedKeywords(keywordRows);

        generatedPatterns += insertedPatterns;
        generatedKeywords += insertedKeywords;
        successfulEvents += 1;
        processedEventIds.push(event.id);

        logger.info('Padroes de aprendizado IA gerados.', {
          action: 'ai_learning_patterns_generated',
          source_event_id: event.id,
          tool: event.tool_executed,
          generated_count: insertedPatterns,
          intent_description: artifacts.intentDescription || null,
          possible_intents: artifacts.possibleIntents,
        });
        logger.info('Keywords de aprendizado IA geradas.', {
          action: 'ai_learning_keywords_generated',
          source_event_id: event.id,
          tool: event.tool_executed,
          generated_count: insertedKeywords,
        });
      } catch (error) {
        logger.warn('Falha ao gerar aprendizado IA para evento.', {
          action: 'ai_learning_event_process_failed',
          source_event_id: event?.id || null,
          tool: event?.tool_executed || null,
          error: error?.message,
        });
      }
    }

    if (processedEventIds.length > 0) {
      await markLearningEventsProcessed(processedEventIds);
      markToolCandidateLearningCacheDirty();
    }

    logger.info('Batch de aprendizado IA processado.', {
      action: 'ai_learning_batch_processed',
      reason,
      fetched_events: events.length,
      processed_events: processedEventIds.length,
      successful_events: successfulEvents,
      generated_patterns: generatedPatterns + configSeedResult.insertedPatterns,
      generated_keywords: generatedKeywords + configSeedResult.insertedKeywords,
      generated_patterns_from_events: generatedPatterns,
      generated_keywords_from_events: generatedKeywords,
      generated_patterns_from_config_seed: configSeedResult.insertedPatterns,
      generated_keywords_from_config_seed: configSeedResult.insertedKeywords,
      config_seed_enabled: AI_LEARNING_WORKER_CONFIG_SEED_ENABLED,
      config_seed_executed: configSeedResult.executed,
      config_seed_skipped: configSeedResult.skipped,
      config_seed_tool_count: configSeedResult.toolCount,
      duration_ms: __timeNowMs() - startedAt,
    });
  } finally {
    cycleInProgress = false;
  }
};

export const startAiLearningWorker = () => {
  if (schedulerStarted) return;

  if (!isWorkerReady()) {
    logger.info('Worker de aprendizado IA desativado ou sem condicao minima de execucao.', {
      action: 'ai_learning_worker_disabled',
      enabled: AI_LEARNING_WORKER_ENABLED,
      has_openai_api_key: hasOpenAiApiKey(),
      config_seed_enabled: AI_LEARNING_WORKER_CONFIG_SEED_ENABLED,
    });
    return;
  }

  schedulerStarted = true;
  void processLearningBatch({ reason: 'startup' });

  schedulerHandle = setInterval(() => {
    void processLearningBatch({ reason: 'scheduler' });
  }, AI_LEARNING_WORKER_INTERVAL_MS);
  if (typeof schedulerHandle?.unref === 'function') {
    schedulerHandle.unref();
  }

  logger.info('Scheduler do worker de aprendizado IA iniciado.', {
    action: 'ai_learning_worker_scheduler_started',
    interval_ms: AI_LEARNING_WORKER_INTERVAL_MS,
    batch_size: AI_LEARNING_WORKER_BATCH_SIZE,
    model: AI_LEARNING_WORKER_MODEL,
    config_seed_enabled: AI_LEARNING_WORKER_CONFIG_SEED_ENABLED,
    config_seed_interval_ms: AI_LEARNING_WORKER_CONFIG_SEED_INTERVAL_MS,
  });
};

export const stopAiLearningWorker = () => {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  schedulerStarted = false;
};

export const runAiLearningWorkerOnce = async (reason = 'manual') => {
  await processLearningBatch({ reason });
};

export const getAiLearningWorkerConfig = () => ({
  enabled: AI_LEARNING_WORKER_ENABLED,
  intervalMs: AI_LEARNING_WORKER_INTERVAL_MS,
  batchSize: AI_LEARNING_WORKER_BATCH_SIZE,
  model: AI_LEARNING_WORKER_MODEL,
  timeoutMs: AI_LEARNING_WORKER_TIMEOUT_MS,
  maxPatternsPerEvent: AI_LEARNING_WORKER_MAX_PATTERNS,
  maxKeywordsPerEvent: AI_LEARNING_WORKER_MAX_KEYWORDS,
  configSeedEnabled: AI_LEARNING_WORKER_CONFIG_SEED_ENABLED,
  configSeedIntervalMs: AI_LEARNING_WORKER_CONFIG_SEED_INTERVAL_MS,
  configSeedMaxPatternsPerTool: AI_LEARNING_WORKER_CONFIG_SEED_MAX_PATTERNS,
  configSeedMaxKeywordsPerTool: AI_LEARNING_WORKER_CONFIG_SEED_MAX_KEYWORDS,
  hasApiKey: Boolean(process.env.OPENAI_API_KEY),
});
