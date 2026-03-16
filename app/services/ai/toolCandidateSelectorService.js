import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import natural from 'natural';
import winkBm25TextSearch from 'wink-bm25-text-search';
import logger from '#logger';
import { getAllToolRecords, getToolRegistryStats } from './moduleToolRegistryService.js';
import { getLearnedKnowledgeVersion, listLearnedKeywords, listLearnedPatterns } from './aiLearningRepository.js';
import { getCommandConfigEnrichmentVersion, listAppliedCommandConfigEnrichmentStates } from './commandConfigEnrichmentRepository.js';

const DEFAULT_TOOL_SELECTION_MAX_CANDIDATES = 8;
const DEFAULT_TOOL_SELECTION_MIN_SCORE = 0.2;
const DEFAULT_TOOL_SELECTION_FALLBACK_POPULAR_LIMIT = 5;
const DEFAULT_TOOL_SELECTION_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TOOL_SELECTION_CACHE_MAX_ENTRIES = 800;
const DEFAULT_TOOL_SELECTION_LEARNED_REFRESH_MS = 60_000;
const DEFAULT_TOOL_SELECTION_LEARNED_MAX_ROWS = 10_000;
const DEFAULT_TOOL_SELECTION_ENRICHMENT_REFRESH_MS = 120_000;
const DEFAULT_TOOL_SELECTION_ENRICHMENT_MAX_ROWS = 10_000;
const MIN_BM25_DOCS = 3;

const BM25_WEIGHT = 0.35;
const KEYWORD_MATCH_WEIGHT = 0.25;
const LEARNED_PATTERNS_WEIGHT = 0.2;
const FUZZY_MATCH_WEIGHT = 0.1;
const TOOL_POPULARITY_WEIGHT = 0.1;

const BM25_FIELD_WEIGHTS = {
  descricao: 3,
  capability_keywords: 2,
  faq_patterns: 2,
  user_phrasings: 3,
};

const tokenizer = new natural.WordTokenizer();
const queryCache = new Map();
const STOPWORDS = new Set(['a', 'as', 'o', 'os', 'ao', 'aos', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'sem', 'e', 'ou', 'um', 'uma', 'uns', 'umas', 'que', 'como', 'me', 'te', 'se', 'eu', 'voce', 'vc', 'bot', 'ajuda', 'help']);

let cachedIndexSnapshot = null;
let cachedIndexSignature = '';
let learnedRefreshPromise = null;
let commandConfigRefreshPromise = null;

let learnedKnowledgeCache = {
  loaded: false,
  version: '0:0',
  lastLoadedAt: 0,
  nextRefreshAt: 0,
  keywordsByTool: new Map(),
  patternsByTool: new Map(),
};

let commandConfigEnrichmentCache = {
  loaded: false,
  version: '0:0:0',
  lastLoadedAt: 0,
  nextRefreshAt: 0,
  overlayByModuleCommand: new Map(),
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

const TOOL_SELECTION_MAX_CANDIDATES = parseEnvInt(process.env.TOOL_SELECTION_MAX_CANDIDATES, DEFAULT_TOOL_SELECTION_MAX_CANDIDATES, 1, 32);
const TOOL_SELECTION_MIN_SCORE = parseEnvFloat(process.env.TOOL_SELECTION_MIN_SCORE, DEFAULT_TOOL_SELECTION_MIN_SCORE, 0, 1);
const TOOL_SELECTION_FALLBACK_POPULAR_LIMIT = parseEnvInt(process.env.TOOL_SELECTION_FALLBACK_POPULAR_LIMIT, DEFAULT_TOOL_SELECTION_FALLBACK_POPULAR_LIMIT, 1, 20);
const TOOL_SELECTION_CACHE_TTL_MS = parseEnvInt(process.env.TOOL_SELECTION_CACHE_TTL_MS, DEFAULT_TOOL_SELECTION_CACHE_TTL_MS, 5_000, 24 * 60 * 60 * 1000);
const TOOL_SELECTION_CACHE_MAX_ENTRIES = parseEnvInt(process.env.TOOL_SELECTION_CACHE_MAX_ENTRIES, DEFAULT_TOOL_SELECTION_CACHE_MAX_ENTRIES, 50, 10_000);
const TOOL_SELECTION_LEARNED_REFRESH_MS = parseEnvInt(process.env.TOOL_SELECTION_LEARNED_REFRESH_MS, DEFAULT_TOOL_SELECTION_LEARNED_REFRESH_MS, 5_000, 30 * 60 * 1000);
const TOOL_SELECTION_LEARNED_MAX_ROWS = parseEnvInt(process.env.TOOL_SELECTION_LEARNED_MAX_ROWS, DEFAULT_TOOL_SELECTION_LEARNED_MAX_ROWS, 100, 50_000);
const TOOL_SELECTION_ENRICHMENT_REFRESH_MS = parseEnvInt(process.env.TOOL_SELECTION_ENRICHMENT_REFRESH_MS, DEFAULT_TOOL_SELECTION_ENRICHMENT_REFRESH_MS, 5_000, 30 * 60 * 1000);
const TOOL_SELECTION_ENRICHMENT_MAX_ROWS = parseEnvInt(process.env.TOOL_SELECTION_ENRICHMENT_MAX_ROWS, DEFAULT_TOOL_SELECTION_ENRICHMENT_MAX_ROWS, 100, 50_000);

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/_.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const unique = (items = []) => Array.from(new Set((Array.isArray(items) ? items : []).filter(Boolean)));

const tokenizeText = (value) => {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  try {
    const tokens = tokenizer.tokenize(normalized);
    if (Array.isArray(tokens) && tokens.length > 0) {
      return tokens.map((token) => normalizeText(token)).filter((token) => token.length >= 2 && !STOPWORDS.has(token));
    }
  } catch {
    // Fallback simples quando tokenizacao da lib falha.
  }

  return normalized.split(/\s+/).filter((token) => token.length >= 2 && !STOPWORDS.has(token));
};

const roundScore = (value) => Number((Number(value) || 0).toFixed(4));

const computeTokenOverlapScore = (queryTokens = [], docTokenSet = new Set()) => {
  const normalizedTokens = unique(queryTokens);
  if (!normalizedTokens.length || !docTokenSet.size) return 0;

  let hits = 0;
  for (const token of normalizedTokens) {
    if (docTokenSet.has(token)) hits += 1;
  }

  return clamp01(hits / normalizedTokens.length);
};

const computeFuzzyScore = (queryText, phrases = []) => {
  const normalizedQuery = normalizeText(queryText);
  if (!normalizedQuery) return 0;

  let best = 0;
  for (const phrase of phrases) {
    const normalizedPhrase = normalizeText(phrase);
    if (!normalizedPhrase) continue;
    const score = Number(natural.JaroWinklerDistance(normalizedQuery, normalizedPhrase)) || 0;
    if (score > best) best = score;
  }
  return clamp01(best);
};

const toSafeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const resolveLearningSignals = (commandEntry = {}) => {
  const usageCount = Math.max(0, toSafeNumber(commandEntry.tool_usage_count, 0));
  const successRate = clamp01(toSafeNumber(commandEntry.tool_success_rate, 0.5));
  const suggestionPriority = clamp01(toSafeNumber(commandEntry.suggestion_priority, 0) / 100);
  return {
    usageCount,
    successRate,
    suggestionPriority,
  };
};

const computePopularityScore = (learningSignals = {}) => {
  const usageScore = clamp01(Math.log1p(Math.max(0, learningSignals.usageCount || 0)) / 8);
  const successScore = clamp01(learningSignals.successRate);
  const priorityScore = clamp01(learningSignals.suggestionPriority);
  return clamp01(usageScore * 0.5 + successScore * 0.35 + priorityScore * 0.15);
};

const buildDocumentFields = (record) => {
  const commandEntry = record?.commandEntry || {};
  const descricao = normalizeText(commandEntry?.descricao || '');
  const capabilityKeywords = unique(commandEntry?.capability_keywords || []).join(' ');
  const faqPatterns = unique(commandEntry?.faq_patterns || []).join(' ');
  const userPhrasings = unique(commandEntry?.user_phrasings || []).join(' ');

  const aliases = unique(record?.aliases || []);
  const commandTerms = unique([record?.commandName, ...aliases]).join(' ');
  const staticKeywordText = normalizeText([capabilityKeywords, commandTerms, faqPatterns].join(' '));
  const staticKeywordTokens = new Set(tokenizeText(staticKeywordText));
  const matchPhrases = unique([record?.commandName, ...aliases, commandEntry?.descricao, ...(Array.isArray(commandEntry?.user_phrasings) ? commandEntry.user_phrasings : []), ...(Array.isArray(commandEntry?.faq_patterns) ? commandEntry.faq_patterns : [])]);

  return {
    descricao,
    capability_keywords: normalizeText(capabilityKeywords),
    faq_patterns: normalizeText(faqPatterns),
    user_phrasings: normalizeText(userPhrasings),
    staticKeywordTokens,
    matchPhrases,
  };
};

const ensureCacheSize = () => {
  if (queryCache.size <= TOOL_SELECTION_CACHE_MAX_ENTRIES) return;
  const overflow = queryCache.size - TOOL_SELECTION_CACHE_MAX_ENTRIES;
  const iterator = queryCache.keys();
  for (let i = 0; i < overflow; i += 1) {
    const next = iterator.next();
    if (next.done) break;
    queryCache.delete(next.value);
  }
};

const pruneCache = (nowMs = __timeNowMs()) => {
  for (const [cacheKey, cacheEntry] of queryCache.entries()) {
    if (!cacheEntry || cacheEntry.expiresAt <= nowMs) {
      queryCache.delete(cacheKey);
    }
  }
};

const buildCacheKey = ({ message, limit, minScore, signature, learnedVersion, commandConfigVersion }) => `${signature}|${learnedVersion}|${commandConfigVersion}|${limit}|${roundScore(minScore)}|${normalizeText(message)}`;

const extractBm25Scores = (bm25Engine, queryText) => {
  const rawResults = bm25Engine?.search?.(queryText);
  const results = Array.isArray(rawResults) ? rawResults : [];
  if (!results.length) return new Map();

  let maxScore = 0;
  for (const [, score] of results) {
    const numeric = Math.max(0, toSafeNumber(score, 0));
    if (numeric > maxScore) maxScore = numeric;
  }
  if (!maxScore) return new Map();

  const normalizedScores = new Map();
  for (const [toolName, score] of results) {
    const normalized = clamp01(toSafeNumber(score, 0) / maxScore);
    normalizedScores.set(
      String(toolName || '')
        .trim()
        .toLowerCase(),
      normalized,
    );
  }
  return normalizedScores;
};

const buildOrGetIndexSnapshot = () => {
  const registryStats = getToolRegistryStats();
  const signature = String(registryStats?.signature || '');

  if (cachedIndexSnapshot && cachedIndexSignature === signature) {
    return cachedIndexSnapshot;
  }

  const records = getAllToolRecords();
  const bm25Engine = winkBm25TextSearch();
  bm25Engine.defineConfig({
    fldWeights: BM25_FIELD_WEIGHTS,
    bm25Params: { k1: 1.2, b: 0.75 },
    ovFldNames: ['descricao', 'capability_keywords', 'faq_patterns', 'user_phrasings'],
  });
  bm25Engine.definePrepTasks([tokenizeText]);

  const entries = [];
  for (const record of records) {
    const fields = buildDocumentFields(record);
    const learningSignals = resolveLearningSignals(record.commandEntry || {});
    const popularityScore = computePopularityScore(learningSignals);
    entries.push({
      ...record,
      ...fields,
      learningSignals,
      popularityScore,
    });
    bm25Engine.addDoc(
      {
        descricao: fields.descricao,
        capability_keywords: fields.capability_keywords,
        faq_patterns: fields.faq_patterns,
        user_phrasings: fields.user_phrasings,
      },
      record.toolName,
    );
  }

  let bm25Ready = false;
  if (entries.length >= MIN_BM25_DOCS) {
    try {
      bm25Engine.consolidate();
      bm25Ready = true;
    } catch (error) {
      logger.warn('Falha ao consolidar indice BM25 de tools. Fallback lexical sera usado.', {
        action: 'tool_candidate_index_bm25_consolidate_failed',
        error: error?.message,
        tool_count: entries.length,
      });
    }
  }

  const popularEntries = [...entries].sort((left, right) => {
    if (right.popularityScore !== left.popularityScore) {
      return right.popularityScore - left.popularityScore;
    }
    return left.toolName.localeCompare(right.toolName);
  });

  cachedIndexSnapshot = {
    signature,
    builtAt: __timeNowIso(),
    bm25Ready,
    bm25Engine,
    entries,
    popularEntries,
  };
  cachedIndexSignature = signature;
  pruneCache();

  logger.info('Indice de selecao dinamica de tools atualizado.', {
    action: 'tool_candidate_index_ready',
    tool_count: entries.length,
    bm25_ready: bm25Ready,
    registry_signature: signature || null,
  });

  return cachedIndexSnapshot;
};

const computeKeywordMatchScore = ({ queryTokens = [], staticKeywordTokens = new Set(), learnedKeywordMap = new Map() }) => {
  const staticOverlap = computeTokenOverlapScore(queryTokens, staticKeywordTokens);

  let learnedScore = 0;
  if (learnedKeywordMap.size > 0) {
    let totalWeight = 0;
    let matchedWeight = 0;
    for (const [keyword, weight] of learnedKeywordMap.entries()) {
      const safeWeight = Math.max(0, Number(weight) || 0);
      totalWeight += safeWeight;
      if (queryTokens.includes(keyword)) {
        matchedWeight += safeWeight;
      }
    }
    learnedScore = totalWeight > 0 ? clamp01(matchedWeight / totalWeight) : 0;
  }

  return clamp01(staticOverlap * 0.65 + learnedScore * 0.35);
};

const computeLearnedPatternsScore = ({ queryText, queryTokens = [], learnedPatterns = [] }) => {
  if (!Array.isArray(learnedPatterns) || learnedPatterns.length === 0) return 0;

  let best = 0;
  for (const item of learnedPatterns) {
    const pattern = normalizeText(item?.pattern || '');
    if (!pattern) continue;

    const confidence = clamp01(item?.confidence);
    const patternTokens = item?.tokens instanceof Set ? item.tokens : new Set(tokenizeText(pattern));
    const fuzzy = Number(natural.JaroWinklerDistance(normalizeText(queryText), pattern)) || 0;
    const overlap = computeTokenOverlapScore(queryTokens, patternTokens);
    const raw = clamp01(fuzzy * 0.7 + overlap * 0.3);
    const weighted = clamp01(raw * (0.5 + confidence * 0.5));
    if (weighted > best) best = weighted;
  }

  return best;
};

const buildLearnedKnowledgeMaps = ({ patterns = [], keywords = [] }) => {
  const keywordsByTool = new Map();
  const keywordDedup = new Map();

  for (const row of keywords) {
    const tool = normalizeText(row?.tool);
    const keyword = normalizeText(row?.keyword);
    if (!tool || !keyword) continue;

    const dedupKey = `${tool}::${keyword}`;
    const weight = clamp01(row?.weight) || 0.5;
    const current = keywordDedup.get(dedupKey) || 0;
    if (weight > current) {
      keywordDedup.set(dedupKey, weight);
    }
  }

  for (const [dedupKey, weight] of keywordDedup.entries()) {
    const [tool, keyword] = dedupKey.split('::');
    if (!tool || !keyword) continue;
    const toolMap = keywordsByTool.get(tool) || new Map();
    toolMap.set(keyword, Math.max(weight, toolMap.get(keyword) || 0));
    keywordsByTool.set(tool, toolMap);
  }

  const patternsByTool = new Map();
  const patternDedup = new Map();

  for (const row of patterns) {
    const tool = normalizeText(row?.tool);
    const pattern = String(row?.pattern || '').trim();
    if (!tool || !pattern) continue;

    const dedupKey = `${tool}::${normalizeText(pattern)}`;
    const confidence = clamp01(row?.confidence) || 0.5;
    const current = patternDedup.get(dedupKey);
    if (!current || confidence > current.confidence) {
      patternDedup.set(dedupKey, {
        pattern,
        confidence,
        tokens: new Set(tokenizeText(pattern)),
      });
    }
  }

  for (const [dedupKey, value] of patternDedup.entries()) {
    const [tool] = dedupKey.split('::');
    if (!tool) continue;
    const list = patternsByTool.get(tool) || [];
    list.push(value);
    patternsByTool.set(tool, list);
  }

  return {
    keywordsByTool,
    patternsByTool,
  };
};

const buildModuleCommandKey = (moduleKey, commandName) => `${normalizeText(moduleKey)}:${normalizeText(commandName)}`;

const buildCommandConfigOverlayMaps = (states = []) => {
  const overlayByModuleCommand = new Map();
  for (const state of states) {
    const key = buildModuleCommandKey(state?.module_key, state?.command_name);
    if (!key || key === ':') continue;

    const overlay = state?.overlay && typeof state.overlay === 'object' ? state.overlay : {};
    const capabilityKeywords = unique(overlay?.capability_keywords || []);
    const faqPatterns = unique(overlay?.faq_patterns || []);
    const userPhrasings = unique(overlay?.user_phrasings || []);
    const methodHints = unique(overlay?.metodos_de_uso_sugeridos || []);
    const descricaoSugerida = String(overlay?.descricao_sugerida || '').trim();

    const overlayKeywordTokens = new Set(tokenizeText([capabilityKeywords.join(' '), faqPatterns.join(' '), userPhrasings.join(' ')].join(' ')));
    const overlayMatchPhrases = unique([descricaoSugerida, ...capabilityKeywords, ...faqPatterns, ...userPhrasings, ...methodHints]);

    overlayByModuleCommand.set(key, {
      capabilityKeywords,
      faqPatterns,
      userPhrasings,
      methodHints,
      descricaoSugerida,
      overlayKeywordTokens,
      overlayMatchPhrases,
      version: Number(state?.version || 0),
      confidence: clamp01(state?.confidence),
    });
  }

  return {
    overlayByModuleCommand,
  };
};

const refreshLearnedKnowledgeCache = async ({ force = false } = {}) => {
  const nowMs = __timeNowMs();
  if (!force && learnedKnowledgeCache.loaded && learnedKnowledgeCache.nextRefreshAt > nowMs && learnedKnowledgeCache.version) {
    return learnedKnowledgeCache;
  }

  if (learnedRefreshPromise) {
    return learnedRefreshPromise;
  }

  learnedRefreshPromise = (async () => {
    const versionInfo = await getLearnedKnowledgeVersion();
    const nextVersion = String(versionInfo?.version || '0:0');

    if (!force && learnedKnowledgeCache.loaded && learnedKnowledgeCache.version === nextVersion) {
      learnedKnowledgeCache = {
        ...learnedKnowledgeCache,
        nextRefreshAt: nowMs + TOOL_SELECTION_LEARNED_REFRESH_MS,
      };
      return learnedKnowledgeCache;
    }

    const [patterns, keywords] = await Promise.all([listLearnedPatterns({ limit: TOOL_SELECTION_LEARNED_MAX_ROWS }), listLearnedKeywords({ limit: TOOL_SELECTION_LEARNED_MAX_ROWS })]);

    const maps = buildLearnedKnowledgeMaps({ patterns, keywords });
    learnedKnowledgeCache = {
      loaded: true,
      version: nextVersion,
      lastLoadedAt: nowMs,
      nextRefreshAt: nowMs + TOOL_SELECTION_LEARNED_REFRESH_MS,
      keywordsByTool: maps.keywordsByTool,
      patternsByTool: maps.patternsByTool,
    };

    logger.info('Cache de conhecimento aprendido para tool selector atualizado.', {
      action: 'tool_candidate_learning_cache_refreshed',
      version: nextVersion,
      pattern_count: patterns.length,
      keyword_count: keywords.length,
      tools_with_patterns: maps.patternsByTool.size,
      tools_with_keywords: maps.keywordsByTool.size,
    });

    return learnedKnowledgeCache;
  })();

  try {
    return await learnedRefreshPromise;
  } finally {
    learnedRefreshPromise = null;
  }
};

const refreshCommandConfigEnrichmentCache = async ({ force = false } = {}) => {
  const nowMs = __timeNowMs();
  if (!force && commandConfigEnrichmentCache.loaded && commandConfigEnrichmentCache.nextRefreshAt > nowMs && commandConfigEnrichmentCache.version) {
    return commandConfigEnrichmentCache;
  }

  if (commandConfigRefreshPromise) {
    return commandConfigRefreshPromise;
  }

  commandConfigRefreshPromise = (async () => {
    const versionInfo = await getCommandConfigEnrichmentVersion();
    const nextVersion = String(versionInfo?.version || '0:0:0');

    if (!force && commandConfigEnrichmentCache.loaded && commandConfigEnrichmentCache.version === nextVersion) {
      commandConfigEnrichmentCache = {
        ...commandConfigEnrichmentCache,
        nextRefreshAt: nowMs + TOOL_SELECTION_ENRICHMENT_REFRESH_MS,
      };
      return commandConfigEnrichmentCache;
    }

    const states = await listAppliedCommandConfigEnrichmentStates({
      limit: TOOL_SELECTION_ENRICHMENT_MAX_ROWS,
    });
    const maps = buildCommandConfigOverlayMaps(states);

    commandConfigEnrichmentCache = {
      loaded: true,
      version: nextVersion,
      lastLoadedAt: nowMs,
      nextRefreshAt: nowMs + TOOL_SELECTION_ENRICHMENT_REFRESH_MS,
      overlayByModuleCommand: maps.overlayByModuleCommand,
    };

    logger.info('Cache de enriquecimento aplicado de commandConfig atualizado.', {
      action: 'tool_candidate_command_config_cache_refreshed',
      version: nextVersion,
      state_count: states.length,
      enriched_commands: maps.overlayByModuleCommand.size,
    });

    return commandConfigEnrichmentCache;
  })();

  try {
    return await commandConfigRefreshPromise;
  } finally {
    commandConfigRefreshPromise = null;
  }
};

const buildSelectionFromEntries = ({ rankedEntries = [], fallbackUsed = false, selectionTimeMs = 0, cacheHit = false, limit = TOOL_SELECTION_MAX_CANDIDATES }) => {
  const limited = rankedEntries.slice(0, Math.max(1, limit));
  return {
    tools: limited.map((entry) => entry.tool),
    fallbackUsed,
    cacheHit,
    selectionTimeMs,
    selectedCount: limited.length,
    candidateTools: limited.map((entry) => ({
      toolName: entry.toolName,
      commandName: entry.commandName,
      moduleKey: entry.moduleKey,
      score: roundScore(entry.finalScore),
      bm25Score: roundScore(entry.bm25Score),
      keywordMatchScore: roundScore(entry.keywordMatchScore),
      learnedPatternsScore: roundScore(entry.learnedPatternsScore),
      fuzzyScore: roundScore(entry.fuzzyScore),
      popularityScore: roundScore(entry.popularityScore),
      commandConfigOverlayVersion: Number(entry.commandConfigOverlayVersion || 0),
      usageCount: Number(entry.learningSignals?.usageCount || 0),
      successRate: roundScore(entry.learningSignals?.successRate),
    })),
  };
};

export const selectCandidateTools = async (userMessage, limit = TOOL_SELECTION_MAX_CANDIDATES) => {
  const startNs = process.hrtime.bigint();
  const safeLimit = Math.max(1, Math.min(32, Number(limit) || TOOL_SELECTION_MAX_CANDIDATES));
  const minScore = TOOL_SELECTION_MIN_SCORE;
  const snapshot = buildOrGetIndexSnapshot();
  const [learnedKnowledge, commandConfigKnowledge] = await Promise.all([refreshLearnedKnowledgeCache(), refreshCommandConfigEnrichmentCache()]);

  if (!snapshot.entries.length) {
    return {
      tools: [],
      fallbackUsed: false,
      cacheHit: false,
      selectionTimeMs: 0,
      selectedCount: 0,
      candidateTools: [],
    };
  }

  const normalizedMessage = normalizeText(userMessage);
  const nowMs = __timeNowMs();
  pruneCache(nowMs);
  const cacheKey = buildCacheKey({
    message: normalizedMessage,
    limit: safeLimit,
    minScore,
    signature: snapshot.signature,
    learnedVersion: learnedKnowledge.version,
    commandConfigVersion: commandConfigKnowledge.version,
  });

  const cached = queryCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    const cacheResult = {
      ...cached.result,
      cacheHit: true,
    };
    logger.info('Selecao dinamica de tools em cache.', {
      action: 'tool_candidate_selection',
      selection_time_ms: cacheResult.selectionTimeMs,
      candidate_tools: cacheResult.candidateTools,
      fallback_used: cacheResult.fallbackUsed,
      cache_hit: true,
      limit: safeLimit,
      min_score: minScore,
    });
    return cacheResult;
  }

  const queryTokens = tokenizeText(normalizedMessage);
  const bm25Scores = snapshot.bm25Ready && normalizedMessage ? extractBm25Scores(snapshot.bm25Engine, normalizedMessage) : new Map();

  const ranked = snapshot.entries
    .map((entry) => {
      const bm25Score = bm25Scores.get(entry.toolName) || 0;
      const learnedKeywordMap = learnedKnowledge.keywordsByTool.get(entry.toolName) || new Map();
      const learnedPatterns = learnedKnowledge.patternsByTool.get(entry.toolName) || [];
      const moduleCommandKey = buildModuleCommandKey(entry.moduleKey, entry.commandName);
      const commandConfigOverlay = commandConfigKnowledge.overlayByModuleCommand.get(moduleCommandKey) || null;

      const effectiveStaticKeywordTokens = commandConfigOverlay ? new Set([...entry.staticKeywordTokens, ...commandConfigOverlay.overlayKeywordTokens]) : entry.staticKeywordTokens;
      const effectiveMatchPhrases = commandConfigOverlay ? unique([...entry.matchPhrases, ...commandConfigOverlay.overlayMatchPhrases]) : entry.matchPhrases;

      const keywordMatchScore = computeKeywordMatchScore({
        queryTokens,
        staticKeywordTokens: effectiveStaticKeywordTokens,
        learnedKeywordMap,
      });
      const learnedPatternsScore = computeLearnedPatternsScore({
        queryText: normalizedMessage,
        queryTokens,
        learnedPatterns,
      });
      const fuzzyScore = computeFuzzyScore(normalizedMessage, effectiveMatchPhrases);
      const finalScore = clamp01(bm25Score * BM25_WEIGHT + keywordMatchScore * KEYWORD_MATCH_WEIGHT + learnedPatternsScore * LEARNED_PATTERNS_WEIGHT + fuzzyScore * FUZZY_MATCH_WEIGHT + entry.popularityScore * TOOL_POPULARITY_WEIGHT);
      return {
        ...entry,
        bm25Score,
        keywordMatchScore,
        learnedPatternsScore,
        fuzzyScore,
        commandConfigOverlayVersion: Number(commandConfigOverlay?.version || 0),
        finalScore,
      };
    })
    .sort((left, right) => {
      if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore;
      if (right.popularityScore !== left.popularityScore) {
        return right.popularityScore - left.popularityScore;
      }
      return left.toolName.localeCompare(right.toolName);
    });

  const aboveThreshold = ranked.filter((entry) => entry.finalScore >= minScore);
  const fallbackUsed = aboveThreshold.length === 0;
  const selectedEntries = fallbackUsed
    ? snapshot.popularEntries.slice(0, Math.min(safeLimit, TOOL_SELECTION_FALLBACK_POPULAR_LIMIT)).map((entry) => ({
        ...entry,
        bm25Score: 0,
        keywordMatchScore: 0,
        learnedPatternsScore: 0,
        fuzzyScore: 0,
        finalScore: entry.popularityScore,
      }))
    : aboveThreshold.slice(0, safeLimit);

  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  const selection = buildSelectionFromEntries({
    rankedEntries: selectedEntries,
    fallbackUsed,
    selectionTimeMs: Number(elapsedMs.toFixed(3)),
    cacheHit: false,
    limit: safeLimit,
  });

  queryCache.set(cacheKey, {
    expiresAt: nowMs + TOOL_SELECTION_CACHE_TTL_MS,
    result: selection,
  });
  ensureCacheSize();

  logger.info('Selecao dinamica de tools concluida.', {
    action: 'tool_candidate_selection',
    selection_time_ms: selection.selectionTimeMs,
    candidate_tools: selection.candidateTools,
    selected_count: selection.selectedCount,
    fallback_used: selection.fallbackUsed,
    cache_hit: false,
    limit: safeLimit,
    min_score: minScore,
  });

  return selection;
};

export const getCandidateTools = async (userMessage, limit = TOOL_SELECTION_MAX_CANDIDATES) => {
  const selection = await selectCandidateTools(userMessage, limit);
  return selection.tools;
};

export const getToolCandidateSelectorConfig = () => ({
  maxCandidates: TOOL_SELECTION_MAX_CANDIDATES,
  minScore: TOOL_SELECTION_MIN_SCORE,
  fallbackPopularLimit: TOOL_SELECTION_FALLBACK_POPULAR_LIMIT,
  cacheTtlMs: TOOL_SELECTION_CACHE_TTL_MS,
  cacheMaxEntries: TOOL_SELECTION_CACHE_MAX_ENTRIES,
  learnedRefreshMs: TOOL_SELECTION_LEARNED_REFRESH_MS,
  learnedMaxRows: TOOL_SELECTION_LEARNED_MAX_ROWS,
  commandConfigRefreshMs: TOOL_SELECTION_ENRICHMENT_REFRESH_MS,
  commandConfigMaxRows: TOOL_SELECTION_ENRICHMENT_MAX_ROWS,
  scoreWeights: {
    bm25: BM25_WEIGHT,
    keywordMatch: KEYWORD_MATCH_WEIGHT,
    learnedPatterns: LEARNED_PATTERNS_WEIGHT,
    fuzzy: FUZZY_MATCH_WEIGHT,
    popularity: TOOL_POPULARITY_WEIGHT,
  },
});

export const warmupToolCandidateSelector = async () => {
  buildOrGetIndexSnapshot();
  await Promise.all([refreshLearnedKnowledgeCache({ force: true }), refreshCommandConfigEnrichmentCache({ force: true })]);
};

export const markToolCandidateLearningCacheDirty = () => {
  learnedKnowledgeCache = {
    ...learnedKnowledgeCache,
    nextRefreshAt: 0,
  };
  commandConfigEnrichmentCache = {
    ...commandConfigEnrichmentCache,
    nextRefreshAt: 0,
  };
  queryCache.clear();
};

export const markToolCandidateCommandConfigCacheDirty = () => {
  commandConfigEnrichmentCache = {
    ...commandConfigEnrichmentCache,
    nextRefreshAt: 0,
  };
  queryCache.clear();
};

export const resetToolCandidateSelectorCacheForTests = () => {
  queryCache.clear();
  cachedIndexSnapshot = null;
  cachedIndexSignature = '';
  learnedKnowledgeCache = {
    loaded: false,
    version: '0:0',
    lastLoadedAt: 0,
    nextRefreshAt: 0,
    keywordsByTool: new Map(),
    patternsByTool: new Map(),
  };
  commandConfigEnrichmentCache = {
    loaded: false,
    version: '0:0:0',
    lastLoadedAt: 0,
    nextRefreshAt: 0,
    overlayByModuleCommand: new Map(),
  };
  learnedRefreshPromise = null;
  commandConfigRefreshPromise = null;
};
