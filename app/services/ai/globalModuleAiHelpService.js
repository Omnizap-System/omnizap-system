import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import fs from 'node:fs/promises';
import path from 'node:path';

import logger from '#logger';
import { adminAiHelpWrapper } from '../../modules/adminModule/adminAiHelpService.js';
import { aiAiHelpWrapper } from '../../modules/aiModule/aiAiHelpService.js';
import { gameAiHelpWrapper } from '../../modules/gameModule/gameAiHelpService.js';
import { menuAiHelpWrapper } from '../../modules/menuModule/menuAiHelpService.js';
import { playAiHelpWrapper } from '../../modules/playModule/playAiHelpService.js';
import { quoteAiHelpWrapper } from '../../modules/quoteModule/quoteAiHelpService.js';
import { rpgPokemonAiHelpWrapper } from '../../modules/rpgPokemonModule/rpgPokemonAiHelpService.js';
import { statsAiHelpWrapper } from '../../modules/statsModule/statsAiHelpService.js';
import { stickerAiHelpWrapper } from '../../modules/stickerModule/stickerAiHelpService.js';
import { stickerPackAiHelpWrapper } from '../../modules/stickerPackModule/stickerPackAiHelpService.js';
import { systemMetricsAiHelpWrapper } from '../../modules/systemMetricsModule/systemMetricsAiHelpService.js';
import { tiktokAiHelpWrapper } from '../../modules/tiktokModule/tiktokAiHelpService.js';
import { userAiHelpWrapper } from '../../modules/userModule/userAiHelpService.js';
import { waifuPicsAiHelpWrapper } from '../../modules/waifuPicsModule/waifuPicsAiHelpService.js';
import { getAiHelpCachedResponse, listAiHelpCachedResponses, upsertAiHelpCachedResponse } from './aiHelpResponseCacheRepository.js';
import { maybeResolveAndExecuteToolCall } from './globalToolCallingService.js';
import { getConversationSession, setConversationSessionIntent } from '../../store/conversationSessionStore.js';

const GLOBAL_HELP_WRAPPERS = [menuAiHelpWrapper, stickerAiHelpWrapper, stickerPackAiHelpWrapper, playAiHelpWrapper, aiAiHelpWrapper, quoteAiHelpWrapper, waifuPicsAiHelpWrapper, statsAiHelpWrapper, systemMetricsAiHelpWrapper, gameAiHelpWrapper, userAiHelpWrapper, rpgPokemonAiHelpWrapper, tiktokAiHelpWrapper, adminAiHelpWrapper];

const GLOBAL_HELP_CACHE_MODULE_KEY = 'global';
const GLOBAL_HELP_CACHE_SCOPE_QUESTION = 'question';
const GLOBAL_HELP_CACHE_SCOPE_COMMAND = 'command';
const DEFAULT_GLOBAL_DB_CACHE_FUZZY_LIMIT = 120;
const DEFAULT_GLOBAL_DB_CACHE_FUZZY_THRESHOLD = 0.82;
const DEFAULT_GLOBAL_HELP_CONFIDENCE_THRESHOLD = 0.46;
const DEFAULT_GLOBAL_HELP_LLM_FALLBACK_THRESHOLD = 0.31;
const GLOBAL_HELP_FEEDBACK_CACHE_VERSION = 1;
const DEFAULT_GLOBAL_HELP_FEEDBACK_SESSION_TTL_MS = 20 * 60 * 1000;
const DEFAULT_GLOBAL_HELP_OFFLINE_FAQ_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_WEIGHT = 0.45;
const OVERLAP_WEIGHT = 0.25;
const FUZZY_WEIGHT = 0.2;
const FEEDBACK_WEIGHT = 0.1;

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

const GLOBAL_HELP_DB_CACHE_FUZZY_LIMIT = parseEnvInt(process.env.GLOBAL_HELP_DB_CACHE_FUZZY_LIMIT, DEFAULT_GLOBAL_DB_CACHE_FUZZY_LIMIT, 20, 400);
const GLOBAL_HELP_DB_CACHE_FUZZY_THRESHOLD = parseEnvFloat(process.env.GLOBAL_HELP_DB_CACHE_FUZZY_THRESHOLD, DEFAULT_GLOBAL_DB_CACHE_FUZZY_THRESHOLD, 0.5, 0.99);
const GLOBAL_HELP_CONFIDENCE_THRESHOLD = parseEnvFloat(process.env.GLOBAL_HELP_CONFIDENCE_THRESHOLD, DEFAULT_GLOBAL_HELP_CONFIDENCE_THRESHOLD, 0.2, 0.95);
const GLOBAL_HELP_LLM_FALLBACK_THRESHOLD = parseEnvFloat(process.env.GLOBAL_HELP_LLM_FALLBACK_THRESHOLD, DEFAULT_GLOBAL_HELP_LLM_FALLBACK_THRESHOLD, 0.1, 0.9);
const GLOBAL_HELP_ENABLE_WRAPPER_LLM_FALLBACK = parseEnvBool(process.env.GLOBAL_HELP_ENABLE_WRAPPER_LLM_FALLBACK, true);
const GLOBAL_HELP_FEEDBACK_FILE_PATH = path.resolve(process.cwd(), String(process.env.GLOBAL_HELP_FEEDBACK_FILE || 'data/cache/global-ai-feedback.json'));
const GLOBAL_HELP_FEEDBACK_SESSION_TTL_MS = parseEnvInt(process.env.GLOBAL_HELP_FEEDBACK_SESSION_TTL_MS, DEFAULT_GLOBAL_HELP_FEEDBACK_SESSION_TTL_MS, 60_000, 12 * 60 * 60 * 1000);
const GLOBAL_HELP_OFFLINE_FAQ_ENABLED = parseEnvBool(process.env.GLOBAL_HELP_OFFLINE_FAQ_ENABLED, true);
const GLOBAL_HELP_OFFLINE_FAQ_INTERVAL_MS = parseEnvInt(process.env.GLOBAL_HELP_OFFLINE_FAQ_INTERVAL_MS, DEFAULT_GLOBAL_HELP_OFFLINE_FAQ_INTERVAL_MS, 30 * 60 * 1000, 72 * 60 * 60 * 1000);

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/_.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenizeText = (value) => normalizeText(value).split(/\s+/).filter(Boolean);

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const limitArray = (value, size = 6) => (Array.isArray(value) ? value : []).filter(Boolean).slice(0, Math.max(0, size));

const ensureArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const ensureObject = (value) => (value && typeof value === 'object' ? value : {});
const pickFirstText = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
};
const pickFirstBoolean = (...values) => {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return false;
};

const readEntryDescription = (entry = {}) => pickFirstText(entry?.description, entry?.docs?.summary, entry?.descricao);

const readEntryUsage = (entry = {}) => {
  const usageV2 = ensureArray(entry?.usage);
  if (usageV2.length) return usageV2;
  const docsUsage = ensureArray(entry?.docs?.usage_examples);
  if (docsUsage.length) return docsUsage;
  return ensureArray(entry?.metodos_de_uso);
};

const readEntryPermission = (entry = {}) => pickFirstText(entry?.permission, entry?.permissao_necessaria);

const readEntryContexts = (entry = {}) => {
  const contextsV2 = ensureArray(entry?.contexts);
  if (contextsV2.length) return contextsV2;
  return ensureArray(entry?.local_de_uso);
};

const readEntryUsageLimit = (entry = {}) => pickFirstText(entry?.limits?.usage_description, entry?.limite_de_uso);

const readEntryCategory = (entry = {}) => pickFirstText(entry?.category, entry?.categoria);

const readEntryDiscovery = (entry = {}) => ensureObject(entry?.discovery);

const readEntryKeywords = (entry = {}) => {
  const discovery = readEntryDiscovery(entry);
  const source = discovery.keywords?.length ? discovery.keywords : entry?.capability_keywords;
  return ensureArray(source);
};

const readEntryFaqQueries = (entry = {}) => {
  const discovery = readEntryDiscovery(entry);
  const source = discovery.faq_queries?.length ? discovery.faq_queries : entry?.faq_patterns;
  return ensureArray(source);
};

const readEntryUserPhrasings = (entry = {}) => {
  const discovery = readEntryDiscovery(entry);
  const source = discovery.user_phrasings?.length ? discovery.user_phrasings : entry?.user_phrasings;
  return ensureArray(source);
};

const readEntrySuggestionPriority = (entry = {}) => {
  const discovery = readEntryDiscovery(entry);
  const raw = discovery.suggestion_priority !== undefined ? discovery.suggestion_priority : entry?.suggestion_priority;
  return toFiniteNumber(raw, 100);
};

const readEntryRequirements = (entry = {}) => {
  const requirements = ensureObject(entry?.requirements);
  const requirementsLegacy = ensureObject(requirements?.legacy);
  const preConditions = ensureObject(entry?.pre_condicoes);

  return {
    require_group: pickFirstBoolean(requirements.require_group, requirements.requer_grupo, requirementsLegacy.require_group, requirementsLegacy.requer_grupo, preConditions.requer_grupo),
    require_group_admin: pickFirstBoolean(requirements.require_group_admin, requirements.requer_admin, requirementsLegacy.require_group_admin, requirementsLegacy.requer_admin, preConditions.requer_admin),
    require_bot_owner: pickFirstBoolean(requirements.require_bot_owner, requirements.requer_admin_principal, requirementsLegacy.require_bot_owner, requirementsLegacy.requer_admin_principal, preConditions.requer_admin_principal),
    require_google_login: pickFirstBoolean(requirements.require_google_login, requirements.requer_google_login, requirementsLegacy.require_google_login, requirementsLegacy.requer_google_login, preConditions.requer_google_login),
    require_nsfw_enabled: pickFirstBoolean(requirements.require_nsfw_enabled, requirements.requer_nsfw, requirementsLegacy.require_nsfw_enabled, requirementsLegacy.requer_nsfw, preConditions.requer_nsfw),
    require_media: pickFirstBoolean(requirements.require_media, requirements.requer_midia, requirementsLegacy.require_media, requirementsLegacy.requer_midia, preConditions.requer_midia),
    require_reply_message: pickFirstBoolean(requirements.require_reply_message, requirements.requer_mensagem_respondida, requirementsLegacy.require_reply_message, requirementsLegacy.requer_mensagem_respondida, preConditions.requer_mensagem_respondida),
  };
};

const formatPermissionLabel = (permission) => String(permission || 'nao definido').trim();

const formatWhereLabel = (contexts = []) => {
  if (!Array.isArray(contexts) || contexts.length === 0) return 'nao definido';
  return contexts.join(', ');
};

const renderUsage = (method, commandPrefix = '/') => String(method || '').replaceAll('<prefix>', String(commandPrefix || '/'));

const levenshteinDistance = (left, right) => {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a) return b.length;
  if (!b) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }

  return matrix[a.length][b.length];
};

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const uniqueTokens = (tokens = []) => Array.from(new Set((Array.isArray(tokens) ? tokens : []).filter(Boolean)));

const computeStringSimilarity = (left, right) => {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length, 1);
  return clamp01(1 - distance / maxLength);
};

const computeTokenOverlapRatio = (leftTokens = [], rightTokens = []) => {
  const left = uniqueTokens(leftTokens);
  const rightSet = new Set(uniqueTokens(rightTokens));
  if (!left.length || !rightSet.size) return 0;
  let hits = 0;
  for (const token of left) {
    if (rightSet.has(token)) hits += 1;
  }
  return clamp01(hits / left.length);
};

const stringifyFeedbackCommand = (value) => normalizeText(value).replace(/^\/+/, '');

const createEmptyFeedbackStore = () => ({
  version: GLOBAL_HELP_FEEDBACK_CACHE_VERSION,
  updatedAt: null,
  byCommand: {},
});

let feedbackStoreCache = null;
let feedbackLoadPromise = null;
let feedbackWriteChain = Promise.resolve();
let offlineFaqSchedulerStarted = false;
let offlineFaqSchedulerHandle = null;

const withFeedbackWrite = async (writer) => {
  feedbackWriteChain = feedbackWriteChain
    .then(async () => {
      await fs.mkdir(path.dirname(GLOBAL_HELP_FEEDBACK_FILE_PATH), { recursive: true });
      return writer();
    })
    .catch((error) => {
      logger.warn('Falha ao persistir feedback global de ajuda.', {
        action: 'global_help_feedback_write_failed',
        error: error?.message,
      });
    });
  return feedbackWriteChain;
};

const ensureFeedbackStoreLoaded = async () => {
  if (feedbackStoreCache) return feedbackStoreCache;
  if (feedbackLoadPromise) return feedbackLoadPromise;

  feedbackLoadPromise = (async () => {
    try {
      const raw = await fs.readFile(GLOBAL_HELP_FEEDBACK_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        feedbackStoreCache = createEmptyFeedbackStore();
        return feedbackStoreCache;
      }
      feedbackStoreCache = {
        ...createEmptyFeedbackStore(),
        ...parsed,
        byCommand: parsed.byCommand && typeof parsed.byCommand === 'object' ? parsed.byCommand : {},
      };
      return feedbackStoreCache;
    } catch {
      feedbackStoreCache = createEmptyFeedbackStore();
      return feedbackStoreCache;
    } finally {
      feedbackLoadPromise = null;
    }
  })();

  return feedbackLoadPromise;
};

const persistFeedbackStore = async () => {
  const store = await ensureFeedbackStoreLoaded();
  store.updatedAt = __timeNowIso();
  await withFeedbackWrite(async () => {
    await fs.writeFile(GLOBAL_HELP_FEEDBACK_FILE_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  });
};

const ensureFeedbackCommandEntry = (store, commandName) => {
  const safeName = stringifyFeedbackCommand(commandName);
  if (!safeName) return null;
  const current = store.byCommand[safeName] && typeof store.byCommand[safeName] === 'object' ? store.byCommand[safeName] : null;

  if (current) {
    current.success_count = Number(current.success_count || 0);
    current.miss_count = Number(current.miss_count || 0);
    current.last_updated_at = current.last_updated_at || null;
    return current;
  }

  const created = {
    success_count: 0,
    miss_count: 0,
    last_updated_at: null,
  };
  store.byCommand[safeName] = created;
  return created;
};

const computeFeedbackScore = (feedbackStore, commandName) => {
  const safeName = stringifyFeedbackCommand(commandName);
  if (!safeName || !feedbackStore?.byCommand || typeof feedbackStore.byCommand !== 'object') return 0;

  const stats = feedbackStore.byCommand[safeName];
  if (!stats || typeof stats !== 'object') return 0;

  const success = Number(stats.success_count || 0);
  const miss = Number(stats.miss_count || 0);
  const total = Math.max(0, success + miss);
  if (!total) return 0;

  const precision = (success + 1) / (total + 2);
  const evidenceWeight = Math.min(1, total / 10);
  return clamp01(precision * evidenceWeight);
};

const formatPreConditions = (requirements = {}) => {
  const lines = [];
  if (requirements.require_group) lines.push('- Requer ser executado em grupo.');
  if (requirements.require_group_admin) lines.push('- Requer permissao de admin do grupo.');
  if (requirements.require_bot_owner) lines.push('- Requer admin principal do bot.');
  if (requirements.require_google_login) lines.push('- Pode requerer login vinculado ao site.');
  if (requirements.require_nsfw_enabled) lines.push('- Requer NSFW ativo quando aplicavel.');
  if (requirements.require_media) lines.push('- Requer midia anexada/citada quando aplicavel.');
  if (requirements.require_reply_message) lines.push('- Requer resposta/citacao de mensagem quando aplicavel.');
  return lines;
};

const buildGlobalCommandCacheKey = (commandName) => `explicar comando ${stringifyFeedbackCommand(commandName)}`;

const computeCachedQuestionMatchScore = (questionNormalized, candidateQuestion) => {
  const left = normalizeText(questionNormalized);
  const right = normalizeText(candidateQuestion);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftTokens = tokenizeText(left);
  const rightTokens = tokenizeText(right);
  const overlap = computeTokenOverlapRatio(leftTokens, rightTokens);
  const contains = left.includes(right) || right.includes(left) ? 1 : 0;
  const similarity = computeStringSimilarity(left, right);
  return clamp01(contains * 0.45 + overlap * 0.35 + similarity * 0.2);
};

const isLikelyGenericBotQuestion = (normalizedQuestion) => /\b(o que (voce|vc|o bot) faz|como funciona|me ajuda|quais comandos|menu)\b/.test(String(normalizedQuestion || ''));

const resolveGlobalCommandTarget = (command) => {
  const normalized = String(command || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  for (const wrapper of GLOBAL_HELP_WRAPPERS) {
    const canonical = wrapper.resolveCommandName(normalized);
    if (canonical) {
      return {
        moduleKey: wrapper.moduleKey,
        wrapper,
        commandName: canonical,
      };
    }
  }

  return null;
};

const detectCommandTargetFromText = (text, commandPrefix = '/') => {
  const prefix = String(commandPrefix || '/').trim() || '/';
  const tokens = tokenizeText(text);
  for (const token of tokens) {
    const cleaned = token.startsWith(prefix) ? token.slice(prefix.length) : token;
    if (!cleaned) continue;
    const target = resolveGlobalCommandTarget(cleaned);
    if (target) return target;
  }

  return null;
};

const collectKnownTokens = () => {
  const tokens = [];
  for (const wrapper of GLOBAL_HELP_WRAPPERS) {
    const entries = wrapper.listEnabledCommands();
    for (const entry of entries) {
      const canonical = normalizeText(entry?.name).replace(/^\/+/, '');
      if (!canonical) continue;
      tokens.push({
        token: canonical,
        canonical,
        moduleKey: wrapper.moduleKey,
      });

      const aliases = Array.isArray(entry?.aliases) ? entry.aliases : [];
      for (const alias of aliases) {
        const normalizedAlias = normalizeText(alias);
        if (!normalizedAlias) continue;
        tokens.push({
          token: normalizedAlias,
          canonical,
          moduleKey: wrapper.moduleKey,
        });
      }
    }
  }
  return tokens;
};

const collectCommandSearchRecords = () => {
  const records = [];

  for (const wrapper of GLOBAL_HELP_WRAPPERS) {
    const entries = wrapper.listEnabledCommands();
    for (const entry of entries) {
      const commandName = normalizeText(entry?.name);
      if (!commandName) continue;

      const aliases = ensureArray(entry.aliases)
        .map((value) => normalizeText(value))
        .filter(Boolean);
      const capabilityKeywords = readEntryKeywords(entry)
        .map((value) => normalizeText(value))
        .filter(Boolean);
      const faqPatterns = readEntryFaqQueries(entry)
        .map((value) => normalizeText(value))
        .filter(Boolean);
      const userPhrasings = readEntryUserPhrasings(entry)
        .map((value) => normalizeText(value))
        .filter(Boolean);
      const description = readEntryDescription(entry);

      records.push({
        moduleKey: wrapper.moduleKey,
        wrapper,
        commandName,
        entry,
        aliases,
        capabilityKeywords,
        faqPatterns,
        userPhrasings,
        description: normalizeText(description),
        descriptionTokens: tokenizeText(description),
        category: normalizeText(readEntryCategory(entry)),
        suggestionPriority: readEntrySuggestionPriority(entry),
      });
    }
  }

  return records;
};

const repeatPush = (target, values, factor = 1) => {
  const safeFactor = Math.max(1, Number.parseInt(String(factor ?? 1), 10) || 1);
  const safeValues = Array.isArray(values) ? values : [];
  for (let i = 0; i < safeFactor; i += 1) {
    target.push(...safeValues.filter(Boolean));
  }
};

const buildRecordDocumentTokens = (record) => {
  const tokens = [];
  const commandTokens = tokenizeText(record.commandName);
  const aliasesTokens = record.aliases.flatMap((value) => tokenizeText(value));
  const capabilityTokens = record.capabilityKeywords.flatMap((value) => tokenizeText(value));
  const faqTokens = record.faqPatterns.flatMap((value) => tokenizeText(value));
  const phrasingTokens = record.userPhrasings.flatMap((value) => tokenizeText(value));
  const descriptionTokens = Array.isArray(record.descriptionTokens) ? record.descriptionTokens : [];
  const categoryTokens = tokenizeText(record.category);

  repeatPush(tokens, commandTokens, 6);
  repeatPush(tokens, aliasesTokens, 4);
  repeatPush(tokens, capabilityTokens, 3);
  repeatPush(tokens, faqTokens, 2);
  repeatPush(tokens, phrasingTokens, 2);
  repeatPush(tokens, descriptionTokens, 1);
  repeatPush(tokens, categoryTokens, 1);

  return tokens.filter(Boolean);
};

const buildSearchIndex = (records) => {
  const docs = [];
  const docFrequency = new Map();
  let totalDocLength = 0;

  for (const record of records) {
    const documentTokens = buildRecordDocumentTokens(record);
    const tf = new Map();
    for (const token of documentTokens) {
      tf.set(token, Number(tf.get(token) || 0) + 1);
    }
    const unique = new Set(documentTokens);
    for (const token of unique) {
      docFrequency.set(token, Number(docFrequency.get(token) || 0) + 1);
    }

    const docLength = documentTokens.length;
    totalDocLength += docLength;
    docs.push({
      ...record,
      documentTokens,
      tokenFrequency: tf,
      tokenSet: unique,
      docLength,
    });
  }

  const avgDocLength = docs.length ? totalDocLength / docs.length : 1;
  return {
    docs,
    docFrequency,
    docCount: docs.length,
    avgDocLength: avgDocLength || 1,
  };
};

const computeBm25Score = (doc, queryTokens, searchIndex) => {
  const tokens = uniqueTokens(queryTokens);
  if (!tokens.length || !searchIndex.docCount) return 0;
  let score = 0;

  for (const token of tokens) {
    const tf = Number(doc.tokenFrequency.get(token) || 0);
    if (!tf) continue;
    const df = Number(searchIndex.docFrequency.get(token) || 0);
    const idf = Math.log(1 + (searchIndex.docCount - df + 0.5) / (df + 0.5));
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.docLength / searchIndex.avgDocLength));
    score += idf * ((tf * (BM25_K1 + 1)) / Math.max(1e-9, denominator));
  }

  return Math.max(0, score);
};

const computeOverlapScore = (doc, questionNormalized, queryTokens, commandPrefix = '/') => {
  const overlapByTokens = computeTokenOverlapRatio(queryTokens, doc.documentTokens);
  const prefix = String(commandPrefix || '/').trim() || '/';
  const explicitCommand = questionNormalized.includes(`${prefix}${doc.commandName}`) ? 1 : 0;
  const exactCommand = queryTokens.includes(doc.commandName) ? 1 : 0;
  return clamp01(Math.max(overlapByTokens, explicitCommand, exactCommand * 0.9));
};

const computeFuzzyScore = (doc, questionNormalized, queryTokens) => {
  const commandSimilarity = computeStringSimilarity(questionNormalized, doc.commandName);
  const aliasSimilarity = doc.aliases.reduce((best, alias) => Math.max(best, computeStringSimilarity(questionNormalized, alias)), 0);

  const commandTokens = uniqueTokens([...tokenizeText(doc.commandName), ...doc.aliases.flatMap((alias) => tokenizeText(alias))]);
  const tokenSimilarities = [];
  for (const qToken of uniqueTokens(queryTokens)) {
    let best = 0;
    for (const cToken of commandTokens) {
      best = Math.max(best, computeStringSimilarity(qToken, cToken));
      if (best >= 1) break;
    }
    tokenSimilarities.push(best);
  }
  const tokenAverage = tokenSimilarities.length ? tokenSimilarities.reduce((acc, value) => acc + value, 0) / tokenSimilarities.length : 0;

  return clamp01(Math.max(commandSimilarity, aliasSimilarity, tokenAverage));
};

const rankCommandRecords = async ({ questionNormalized, commandPrefix = '/' } = {}) => {
  const records = collectCommandSearchRecords();
  const queryTokens = tokenizeText(questionNormalized);
  if (!records.length || !queryTokens.length) return [];

  const feedbackStore = await ensureFeedbackStoreLoaded();
  const searchIndex = buildSearchIndex(records);
  const rankedRaw = searchIndex.docs.map((doc) => ({
    ...doc,
    bm25Raw: computeBm25Score(doc, queryTokens, searchIndex),
    overlapScore: computeOverlapScore(doc, questionNormalized, queryTokens, commandPrefix),
    fuzzyScore: computeFuzzyScore(doc, questionNormalized, queryTokens),
    feedbackScore: computeFeedbackScore(feedbackStore, doc.commandName),
    legacyScore: scoreCommandRecord(doc, questionNormalized, queryTokens, commandPrefix),
  }));

  const maxBm25 = Math.max(1e-9, ...rankedRaw.map((item) => item.bm25Raw));

  return rankedRaw
    .map((item) => {
      const bm25Score = clamp01(item.bm25Raw / maxBm25);
      const finalScore = BM25_WEIGHT * bm25Score + OVERLAP_WEIGHT * item.overlapScore + FUZZY_WEIGHT * item.fuzzyScore + FEEDBACK_WEIGHT * item.feedbackScore;

      return {
        ...item,
        bm25Score,
        finalScore: clamp01(finalScore),
      };
    })
    .sort((a, b) => {
      if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
      if (b.legacyScore !== a.legacyScore) return b.legacyScore - a.legacyScore;
      if (b.suggestionPriority !== a.suggestionPriority) return b.suggestionPriority - a.suggestionPriority;
      return a.commandName.localeCompare(b.commandName);
    });
};

const scoreCommandRecord = (record, questionNormalized, questionTokens, commandPrefix = '/') => {
  let score = 0;
  const prefix = String(commandPrefix || '/').trim() || '/';

  if (questionNormalized.includes(`${prefix}${record.commandName}`)) {
    score += 90;
  }
  if (questionTokens.includes(record.commandName)) {
    score += 70;
  }

  for (const alias of record.aliases) {
    if (questionTokens.includes(alias)) {
      score += 55;
      break;
    }
  }

  let capabilityHits = 0;
  for (const keyword of record.capabilityKeywords) {
    if (questionNormalized.includes(keyword)) capabilityHits += 1;
  }
  score += Math.min(72, capabilityHits * 24);

  let faqHits = 0;
  for (const pattern of record.faqPatterns) {
    if (questionNormalized.includes(pattern)) faqHits += 1;
  }
  score += Math.min(60, faqHits * 30);

  let phrasingHits = 0;
  for (const phrasing of record.userPhrasings) {
    if (questionNormalized.includes(phrasing)) phrasingHits += 1;
  }
  score += Math.min(48, phrasingHits * 16);

  const descriptionOverlap = record.descriptionTokens.filter((token) => questionTokens.includes(token));
  score += Math.min(12, descriptionOverlap.length * 2);

  if (record.category && questionTokens.includes(record.category)) {
    score += 18;
  }

  const priorityBoost = Math.max(0, Math.min(20, Math.floor(record.suggestionPriority / 10)));
  score += priorityBoost;

  return score;
};

const buildDeterministicCommandAnswer = ({ entry, commandName, commandPrefix = '/', suggestions = [], intro }) => {
  const usage = readEntryUsage(entry).map((method) => renderUsage(method, commandPrefix));
  const description = readEntryDescription(entry) || 'Sem descricao cadastrada.';
  const permissionLabel = formatPermissionLabel(readEntryPermission(entry));
  const whereLabel = formatWhereLabel(readEntryContexts(entry));
  const limitLabel = readEntryUsageLimit(entry) || 'nao informado';
  const preconditions = formatPreConditions(readEntryRequirements(entry));

  const lines = [intro || `🤖 Posso te orientar sobre *${commandPrefix}${commandName}*.`, `📝 ${description}`, '', `👤 *Quem pode usar:* ${permissionLabel}`, `📍 *Onde pode usar:* ${whereLabel}`, `⏱️ *Limite:* ${limitLabel}`, '', '*Como usar:*', ...(usage.length ? usage.map((line) => `- ${line}`) : [`- ${commandPrefix}${commandName}`]), ...(preconditions.length ? ['', '*Pre-condicoes:*', ...preconditions] : []), '', '🔒 Esta resposta e apenas orientacao; nenhum comando foi executado.'];

  const normalizedSuggestions = limitArray(
    suggestions.map((value) => String(value || '').trim()).filter((value) => value && value !== `${commandPrefix}${commandName}`),
    3,
  );
  if (normalizedSuggestions.length) {
    lines.push('');
    lines.push(`Sugestoes relacionadas: ${normalizedSuggestions.join(', ')}`);
  }

  return lines.join('\n');
};

const explainTargetWithFallback = async ({ target, context = {}, intro, suggestions = [] }) => {
  const commandPrefix = context.commandPrefix || '/';
  const entry = typeof target?.wrapper?.getCommandEntry === 'function' ? target.wrapper.getCommandEntry(target.commandName) : null;

  if (entry) {
    return {
      ok: true,
      source: 'deterministic',
      moduleKey: target.moduleKey,
      commandName: target.commandName,
      text: buildDeterministicCommandAnswer({
        entry,
        commandName: target.commandName,
        commandPrefix,
        intro,
        suggestions,
      }),
    };
  }

  if (typeof target?.wrapper?.explicarComando === 'function') {
    try {
      const explanation = await target.wrapper.explicarComando(target.commandName, context);
      return {
        ...explanation,
        ok: Boolean(explanation?.ok),
        source: explanation?.source || 'module',
        moduleKey: target.moduleKey,
        commandName: explanation?.commandName || target.commandName,
        text: String(explanation?.text || '').trim() || `Nao consegui montar a explicacao para ${commandPrefix}${target.commandName}.`,
      };
    } catch (error) {
      logger.warn('Falha ao explicar comando pelo wrapper global.', {
        action: 'global_command_explain_wrapper_failed',
        module: target.moduleKey,
        command: target.commandName,
        error: error?.message,
      });
    }
  }

  return {
    ok: false,
    source: 'none',
    moduleKey: target.moduleKey,
    commandName: target.commandName,
    text: `Nao consegui gerar a ajuda para ${commandPrefix}${target.commandName} agora.`,
  };
};

const buildConversationFallbackText = ({ commandPrefix = '/', suggestions = [] }) => {
  const normalizedSuggestions = limitArray(
    suggestions
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map((value) => (value.startsWith(commandPrefix) ? value : `${commandPrefix}${value}`)),
    5,
  );

  return ['Ainda nao identifiquei exatamente o comando que voce precisa.', `Voce pode perguntar direto, por exemplo: "${commandPrefix}help <comando>" ou "como usar sticker".`, normalizedSuggestions.length ? `Sugestoes rapidas: ${normalizedSuggestions.join(', ')}` : `Use ${commandPrefix}menu para ver os comandos gerais e ${commandPrefix}menuadm para comandos administrativos.`].join('\n');
};

const buildCachedGlobalResponse = ({ row, intentType = 'cached', sourceOverride = null, suggestions = [] } = {}) => {
  const safeText = String(row?.answer_text || '').trim();
  if (!safeText) return null;

  return {
    ok: true,
    source: sourceOverride || row?.source || 'db_cache',
    moduleKey: row?.module_key || null,
    commandName: row?.command_name || null,
    intentType,
    suggestions: limitArray(suggestions, 5),
    text: safeText,
  };
};

const lookupGlobalCacheByQuestion = async ({ rawQuestion, normalizedQuestion, scope }) => {
  const exact = await getAiHelpCachedResponse({
    moduleKey: GLOBAL_HELP_CACHE_MODULE_KEY,
    scope,
    question: rawQuestion,
    normalizedQuestion,
    updateUsage: true,
  });

  if (exact?.answer_text) {
    return {
      row: exact,
      cacheKind: 'exact',
      score: 1,
    };
  }

  const candidates = await listAiHelpCachedResponses({
    moduleKey: GLOBAL_HELP_CACHE_MODULE_KEY,
    scope,
    limit: GLOBAL_HELP_DB_CACHE_FUZZY_LIMIT,
  });
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const ranked = candidates
    .map((row) => ({
      row,
      score: computeCachedQuestionMatchScore(normalizedQuestion, row?.normalized_question),
    }))
    .filter((item) => item.score >= GLOBAL_HELP_DB_CACHE_FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;
  return {
    row: ranked[0].row,
    cacheKind: 'fuzzy',
    score: ranked[0].score,
  };
};

const saveGlobalCacheAnswer = async ({ scope = GLOBAL_HELP_CACHE_SCOPE_QUESTION, question, answer, commandName = null, source = 'deterministic', intentType = null, confidence = null, suggestions = [], metadata = null } = {}) => {
  const rawQuestion = String(question || '').trim();
  const rawAnswer = String(answer || '').trim();
  if (!rawQuestion || !rawAnswer) return false;

  const safeSource =
    String(source || 'deterministic')
      .trim()
      .slice(0, 32) || 'deterministic';
  return upsertAiHelpCachedResponse({
    moduleKey: GLOBAL_HELP_CACHE_MODULE_KEY,
    scope,
    question: rawQuestion,
    normalizedQuestion: normalizeText(rawQuestion),
    answer: rawAnswer,
    source: safeSource,
    commandName: commandName || null,
    metadata: {
      intentType: intentType || null,
      confidence: typeof confidence === 'number' ? confidence : null,
      suggestions: limitArray(suggestions, 5),
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
    },
  });
};

const maybeUseWrapperQuestionFallback = async ({ target, rawQuestion, context = {} } = {}) => {
  if (!GLOBAL_HELP_ENABLE_WRAPPER_LLM_FALLBACK) return null;
  if (typeof target?.wrapper?.responderPergunta !== 'function') return null;

  try {
    const response = await target.wrapper.responderPergunta(rawQuestion, context);
    const safeText = String(response?.text || '').trim();
    if (!safeText) return null;
    return {
      ok: Boolean(response?.ok ?? true),
      source: response?.source || 'module_question_fallback',
      moduleKey: target.moduleKey,
      commandName: response?.commandName || target.commandName || null,
      text: safeText,
    };
  } catch (error) {
    logger.warn('Falha no fallback de pergunta via wrapper do modulo.', {
      action: 'global_wrapper_question_fallback_failed',
      module: target?.moduleKey || null,
      command: target?.commandName || null,
      error: error?.message,
    });
    return null;
  }
};

const runGlobalOfflineFaqGeneration = async ({ reason = 'scheduler', force = true } = {}) => {
  const outputs = [];
  for (const wrapper of GLOBAL_HELP_WRAPPERS) {
    if (typeof wrapper?.gerarFaqAutomatica !== 'function') continue;
    try {
      const result = await wrapper.gerarFaqAutomatica({
        commandPrefix: '/',
        force,
        reason: `global_${reason}`,
      });
      outputs.push({
        moduleKey: wrapper.moduleKey,
        ok: Boolean(result?.ok),
        commandCount: Number(result?.commandCount || 0),
        faqCount: Number(result?.faqCount || 0),
      });
    } catch (error) {
      logger.warn('Falha ao gerar FAQ offline global por modulo.', {
        action: 'global_offline_faq_module_failed',
        module: wrapper?.moduleKey || null,
        error: error?.message,
      });
      outputs.push({
        moduleKey: wrapper?.moduleKey || null,
        ok: false,
        commandCount: 0,
        faqCount: 0,
      });
    }
  }
  return outputs;
};

const ensureGlobalOfflineFaqScheduler = () => {
  if (!GLOBAL_HELP_OFFLINE_FAQ_ENABLED || offlineFaqSchedulerStarted) return;
  offlineFaqSchedulerStarted = true;

  const run = async () => {
    try {
      await runGlobalOfflineFaqGeneration({ reason: 'scheduler', force: true });
    } catch (error) {
      logger.warn('Falha no scheduler de FAQ offline global.', {
        action: 'global_offline_faq_scheduler_failed',
        error: error?.message,
      });
    }
  };

  run();
  offlineFaqSchedulerHandle = setInterval(run, GLOBAL_HELP_OFFLINE_FAQ_INTERVAL_MS);
  if (typeof offlineFaqSchedulerHandle?.unref === 'function') {
    offlineFaqSchedulerHandle.unref();
  }
};

const getTopDiscoverySuggestions = async ({ questionNormalized = '', commandPrefix = '/', limit = 5 } = {}) => {
  const ranked = await rankCommandRecords({
    questionNormalized,
    commandPrefix,
  });

  const suggestions = [];
  for (const item of ranked) {
    const token = `${commandPrefix}${item.commandName}`;
    if (!suggestions.includes(token)) suggestions.push(token);
    if (suggestions.length >= limit) break;
  }
  return suggestions;
};

const buildFallbackUnknownSuggestion = (rawCommand, { commandPrefix = '/' } = {}) => {
  for (const wrapper of GLOBAL_HELP_WRAPPERS) {
    try {
      const suggestion = wrapper.buildUnknownCommandSuggestion(rawCommand, { commandPrefix });
      if (suggestion) return suggestion;
    } catch (error) {
      logger.warn('Falha ao gerar sugestao de comando desconhecido por modulo.', {
        action: 'global_unknown_suggestion_wrapper_failed',
        module: wrapper.moduleKey,
        rawCommand,
        error: error?.message,
      });
    }
  }
  return null;
};

export const buildGlobalUnknownCommandSuggestion = (rawCommand, { commandPrefix = '/' } = {}) => {
  const normalized = normalizeText(rawCommand).replace(/^\/+/, '');
  if (!normalized) return null;

  const tokens = collectKnownTokens();
  const ranked = tokens
    .map((item) => ({
      ...item,
      distance: levenshteinDistance(normalized, item.token),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8);

  const bestDistance = ranked[0]?.distance;
  const tolerance = Math.max(2, Math.floor(normalized.length * 0.45));
  if (!Number.isFinite(bestDistance) || bestDistance > tolerance) {
    return buildFallbackUnknownSuggestion(rawCommand, { commandPrefix });
  }

  const suggestions = [];
  for (const item of ranked) {
    const suggestion = `${commandPrefix}${item.canonical}`;
    if (!suggestions.includes(suggestion)) suggestions.push(suggestion);
    if (suggestions.length >= 4) break;
  }

  if (!suggestions.length) {
    return buildFallbackUnknownSuggestion(rawCommand, { commandPrefix });
  }

  return [`❓ O comando *${rawCommand}* nao foi encontrado.`, `Talvez voce quis usar: ${suggestions.join(', ')}.`, `Use ${commandPrefix}menu para comandos gerais e ${commandPrefix}menuadm para comandos administrativos.`].join('\n');
};

export const explicarComandoGlobal = async (command, context = {}) => {
  ensureGlobalOfflineFaqScheduler();
  const commandPrefix = context.commandPrefix || '/';
  const target = resolveGlobalCommandTarget(command);

  if (!target) {
    return {
      ok: false,
      moduleKey: null,
      commandName: null,
      source: 'none',
      text: buildGlobalUnknownCommandSuggestion(command, { commandPrefix }) || `Nao encontrei esse comando. Use ${commandPrefix}menu para listar comandos.`,
    };
  }

  const cacheCommandQuestion = buildGlobalCommandCacheKey(target.commandName);
  const normalizedCacheCommandQuestion = normalizeText(cacheCommandQuestion);
  const cachedCommandAnswer = await lookupGlobalCacheByQuestion({
    rawQuestion: cacheCommandQuestion,
    normalizedQuestion: normalizedCacheCommandQuestion,
    scope: GLOBAL_HELP_CACHE_SCOPE_COMMAND,
  });
  if (cachedCommandAnswer?.row?.answer_text) {
    const fromCache = buildCachedGlobalResponse({
      row: cachedCommandAnswer.row,
      intentType: 'cached_command_explain',
      sourceOverride: cachedCommandAnswer.cacheKind === 'exact' ? 'db_global_command_exact' : 'db_global_command_fuzzy',
    });
    if (fromCache) return fromCache;
  }

  const answer = await explainTargetWithFallback({
    target,
    context,
    intro: `📘 Aqui esta a explicacao do comando *${commandPrefix}${target.commandName}*.`,
  });

  if (answer?.text) {
    await saveGlobalCacheAnswer({
      scope: GLOBAL_HELP_CACHE_SCOPE_COMMAND,
      question: cacheCommandQuestion,
      answer: answer.text,
      commandName: target.commandName,
      source: answer.source || 'deterministic',
      intentType: 'command_explain',
      confidence: 1,
    });
  }

  return answer;
};

export const responderPerguntaGlobal = async (question, context = {}) => {
  ensureGlobalOfflineFaqScheduler();
  const commandPrefix = context.commandPrefix || '/';
  const rawQuestion = String(question || '').trim();
  const normalizedQuestion = normalizeText(rawQuestion);

  if (!normalizedQuestion) {
    return {
      ok: false,
      source: 'none',
      moduleKey: null,
      commandName: null,
      intentType: 'empty_question',
      suggestions: [],
      text: `Envie sua pergunta ou use ${commandPrefix}menu para ver os comandos.`,
    };
  }

  const cachedQuestionAnswer = await lookupGlobalCacheByQuestion({
    rawQuestion,
    normalizedQuestion,
    scope: GLOBAL_HELP_CACHE_SCOPE_QUESTION,
  });
  if (cachedQuestionAnswer?.row?.answer_text) {
    const fromCache = buildCachedGlobalResponse({
      row: cachedQuestionAnswer.row,
      intentType: 'cached_question',
      sourceOverride: cachedQuestionAnswer.cacheKind === 'exact' ? 'db_global_question_exact' : 'db_global_question_fuzzy',
    });
    if (fromCache) return fromCache;
  }

  const forcedTarget = resolveGlobalCommandTarget(context.forceCommandName);
  if (forcedTarget) {
    const forcedAnswer = await explainTargetWithFallback({
      target: forcedTarget,
      context,
      intro: `📎 Continuando sua duvida anterior sobre *${commandPrefix}${forcedTarget.commandName}*:`,
    });
    const forcedSuggestions = await getTopDiscoverySuggestions({
      questionNormalized: normalizedQuestion,
      commandPrefix,
      limit: 3,
    });
    const result = {
      ...forcedAnswer,
      intentType: 'followup_forced',
      suggestions: forcedSuggestions,
    };
    await saveGlobalCacheAnswer({
      scope: GLOBAL_HELP_CACHE_SCOPE_QUESTION,
      question: rawQuestion,
      answer: result.text,
      commandName: result.commandName,
      source: result.source || 'deterministic',
      intentType: result.intentType,
      confidence: 1,
      suggestions: result.suggestions,
    });
    return result;
  }

  const explicitTarget = detectCommandTargetFromText(rawQuestion, commandPrefix);
  if (explicitTarget) {
    const explicitAnswer = await explainTargetWithFallback({
      target: explicitTarget,
      context,
      intro: `✅ Identifiquei que voce falou do comando *${commandPrefix}${explicitTarget.commandName}*:`,
    });
    const explicitSuggestions = await getTopDiscoverySuggestions({
      questionNormalized: normalizedQuestion,
      commandPrefix,
      limit: 3,
    });
    const result = {
      ...explicitAnswer,
      intentType: 'explicit_command',
      suggestions: explicitSuggestions,
    };
    await saveGlobalCacheAnswer({
      scope: GLOBAL_HELP_CACHE_SCOPE_QUESTION,
      question: rawQuestion,
      answer: result.text,
      commandName: result.commandName,
      source: result.source || 'deterministic',
      intentType: result.intentType,
      confidence: 1,
      suggestions: result.suggestions,
    });
    return result;
  }

  const ranked = await rankCommandRecords({
    questionNormalized: normalizedQuestion,
    commandPrefix,
  });
  const topMatch = ranked[0] || null;
  const followupHintPattern = /^(e|tambem|tambem\?|tamb[eé]m|isso|como|explica|detalha|detalhe|funciona)\b/i;
  if ((!topMatch || topMatch.finalScore < GLOBAL_HELP_LLM_FALLBACK_THRESHOLD) && context.previousCommandName && followupHintPattern.test(rawQuestion)) {
    const previousTarget = resolveGlobalCommandTarget(context.previousCommandName);
    if (previousTarget) {
      const previousAnswer = await explainTargetWithFallback({
        target: previousTarget,
        context,
        intro: `📎 Pelo contexto anterior, voce pode estar falando de *${commandPrefix}${previousTarget.commandName}*:`,
      });
      const previousSuggestions = await getTopDiscoverySuggestions({
        questionNormalized: normalizedQuestion,
        commandPrefix,
        limit: 3,
      });
      const result = {
        ...previousAnswer,
        intentType: 'followup_previous_command',
        suggestions: previousSuggestions,
      };
      await saveGlobalCacheAnswer({
        scope: GLOBAL_HELP_CACHE_SCOPE_QUESTION,
        question: rawQuestion,
        answer: result.text,
        commandName: result.commandName,
        source: result.source || 'deterministic',
        intentType: result.intentType,
        confidence: 0.9,
        suggestions: result.suggestions,
      });
      return result;
    }
  }

  if (topMatch && topMatch.finalScore >= GLOBAL_HELP_CONFIDENCE_THRESHOLD) {
    const target = {
      moduleKey: topMatch.moduleKey,
      wrapper: topMatch.wrapper,
      commandName: topMatch.commandName,
    };
    const relatedSuggestions = ranked
      .slice(1)
      .map((item) => `${commandPrefix}${item.commandName}`)
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 3);
    const keywordAnswer = await explainTargetWithFallback({
      target,
      context,
      intro: `🔎 Pela sua pergunta, o melhor comando parece ser *${commandPrefix}${topMatch.commandName}*:`,
      suggestions: relatedSuggestions,
    });

    const result = {
      ...keywordAnswer,
      intentType: 'keyword_match',
      confidence: topMatch.finalScore,
      suggestions: relatedSuggestions,
    };
    await saveGlobalCacheAnswer({
      scope: GLOBAL_HELP_CACHE_SCOPE_QUESTION,
      question: rawQuestion,
      answer: result.text,
      commandName: result.commandName,
      source: result.source || 'deterministic',
      intentType: result.intentType,
      confidence: result.confidence,
      suggestions: result.suggestions,
      metadata: {
        ranking: {
          bm25: topMatch.bm25Score,
          overlap: topMatch.overlapScore,
          fuzzy: topMatch.fuzzyScore,
          feedback: topMatch.feedbackScore,
        },
      },
    });
    return result;
  }

  const toolCallOutcome = await maybeResolveAndExecuteToolCall({
    question: rawQuestion,
    context: {
      ...context,
      commandPrefix,
      suggestions: ranked
        .slice(0, 5)
        .map((item) => `${commandPrefix}${item.commandName}`)
        .filter((value, index, array) => array.indexOf(value) === index),
      topMatchScore: topMatch?.finalScore || 0,
    },
  });
  if (toolCallOutcome?.handled) {
    return {
      ok: Boolean(toolCallOutcome.ok),
      source: toolCallOutcome.source || 'tool_call',
      moduleKey: toolCallOutcome.moduleKey || null,
      commandName: toolCallOutcome.commandName || null,
      intentType: toolCallOutcome.intentType || 'tool_call',
      suggestions: [],
      suppressReply: Boolean(toolCallOutcome.suppressReply),
      text: String(toolCallOutcome.text || '').trim(),
      metadata: toolCallOutcome.metadata && typeof toolCallOutcome.metadata === 'object' ? toolCallOutcome.metadata : {},
    };
  }

  if (topMatch && topMatch.finalScore >= GLOBAL_HELP_LLM_FALLBACK_THRESHOLD) {
    const target = {
      moduleKey: topMatch.moduleKey,
      wrapper: topMatch.wrapper,
      commandName: topMatch.commandName,
    };
    const wrapperFallback = await maybeUseWrapperQuestionFallback({
      target,
      rawQuestion,
      context,
    });
    const lowConfidenceSuggestions = ranked
      .slice(0, 4)
      .map((item) => `${commandPrefix}${item.commandName}`)
      .filter((value, index, array) => array.indexOf(value) === index);

    if (wrapperFallback?.text) {
      const result = {
        ...wrapperFallback,
        intentType: 'low_confidence_wrapper_fallback',
        confidence: topMatch.finalScore,
        suggestions: lowConfidenceSuggestions,
      };
      await saveGlobalCacheAnswer({
        scope: GLOBAL_HELP_CACHE_SCOPE_QUESTION,
        question: rawQuestion,
        answer: result.text,
        commandName: result.commandName,
        source: result.source || 'module_question_fallback',
        intentType: result.intentType,
        confidence: result.confidence,
        suggestions: result.suggestions,
      });
      return result;
    }

    const deterministicLowConfidence = await explainTargetWithFallback({
      target,
      context,
      intro: `🔎 Tenho uma sugestao provavel para voce: *${commandPrefix}${topMatch.commandName}*.`,
      suggestions: lowConfidenceSuggestions.slice(1),
    });
    const result = {
      ...deterministicLowConfidence,
      intentType: 'low_confidence_deterministic',
      confidence: topMatch.finalScore,
      suggestions: lowConfidenceSuggestions,
    };
    await saveGlobalCacheAnswer({
      scope: GLOBAL_HELP_CACHE_SCOPE_QUESTION,
      question: rawQuestion,
      answer: result.text,
      commandName: result.commandName,
      source: result.source || 'deterministic',
      intentType: result.intentType,
      confidence: result.confidence,
      suggestions: result.suggestions,
    });
    return result;
  }

  const fallbackSuggestions = await getTopDiscoverySuggestions({
    questionNormalized: normalizedQuestion,
    commandPrefix,
    limit: 5,
  });

  const fallbackResult = {
    ok: true,
    source: 'deterministic_fallback',
    moduleKey: null,
    commandName: null,
    intentType: 'fallback',
    suggestions: fallbackSuggestions,
    text: buildConversationFallbackText({
      commandPrefix,
      suggestions: fallbackSuggestions,
    }),
  };
  await saveGlobalCacheAnswer({
    scope: GLOBAL_HELP_CACHE_SCOPE_QUESTION,
    question: rawQuestion,
    answer: fallbackResult.text,
    commandName: null,
    source: fallbackResult.source,
    intentType: fallbackResult.intentType,
    confidence: topMatch?.finalScore || 0,
    suggestions: fallbackResult.suggestions,
    metadata: {
      genericQuestion: isLikelyGenericBotQuestion(normalizedQuestion),
    },
  });
  return fallbackResult;
};

export const registerGlobalHelpCommandExecution = async ({ chatId, userId, isGroupMessage = false, executedCommand = '' } = {}) => {
  const safeExecutedCommand = stringifyFeedbackCommand(executedCommand);
  if (!safeExecutedCommand) return { ok: false, reason: 'invalid_command' };

  const scope = isGroupMessage ? 'group' : 'private';
  const session = getConversationSession({
    chatId,
    userId,
    scope,
    ttlMs: GLOBAL_HELP_FEEDBACK_SESSION_TTL_MS,
  });
  const suggestedCommand = stringifyFeedbackCommand(session?.lastIntent?.commandName);
  if (!suggestedCommand) {
    return { ok: false, reason: 'no_previous_suggestion' };
  }

  const feedbackStore = await ensureFeedbackStoreLoaded();
  const entry = ensureFeedbackCommandEntry(feedbackStore, suggestedCommand);
  if (!entry) return { ok: false, reason: 'feedback_entry_failed' };

  if (safeExecutedCommand === suggestedCommand) {
    entry.success_count = Number(entry.success_count || 0) + 1;
  } else {
    entry.miss_count = Number(entry.miss_count || 0) + 1;
  }
  entry.last_updated_at = __timeNowIso();
  await persistFeedbackStore();

  setConversationSessionIntent({
    chatId,
    userId,
    scope,
    intent: null,
    ttlMs: GLOBAL_HELP_FEEDBACK_SESSION_TTL_MS,
  });

  return {
    ok: true,
    matched: safeExecutedCommand === suggestedCommand,
    suggestedCommand,
    executedCommand: safeExecutedCommand,
  };
};

export const gerarFaqGlobalOffline = async ({ reason = 'manual', force = true } = {}) => {
  ensureGlobalOfflineFaqScheduler();
  const modules = await runGlobalOfflineFaqGeneration({ reason, force });
  return {
    ok: true,
    modules,
  };
};

export const getGlobalHelpDeterministicConfig = () => ({
  cacheModuleKey: GLOBAL_HELP_CACHE_MODULE_KEY,
  cacheQuestionScope: GLOBAL_HELP_CACHE_SCOPE_QUESTION,
  cacheCommandScope: GLOBAL_HELP_CACHE_SCOPE_COMMAND,
  dbCacheFuzzyLimit: GLOBAL_HELP_DB_CACHE_FUZZY_LIMIT,
  dbCacheFuzzyThreshold: GLOBAL_HELP_DB_CACHE_FUZZY_THRESHOLD,
  confidenceThreshold: GLOBAL_HELP_CONFIDENCE_THRESHOLD,
  llmFallbackThreshold: GLOBAL_HELP_LLM_FALLBACK_THRESHOLD,
  enableWrapperLlmFallback: GLOBAL_HELP_ENABLE_WRAPPER_LLM_FALLBACK,
  offlineFaqEnabled: GLOBAL_HELP_OFFLINE_FAQ_ENABLED,
  offlineFaqIntervalMs: GLOBAL_HELP_OFFLINE_FAQ_INTERVAL_MS,
  weights: {
    bm25: BM25_WEIGHT,
    overlap: OVERLAP_WEIGHT,
    fuzzy: FUZZY_WEIGHT,
    feedback: FEEDBACK_WEIGHT,
  },
});

export const resolveGlobalCommandModule = (command) => {
  const target = resolveGlobalCommandTarget(command);
  if (!target) {
    return {
      moduleKey: null,
      commandName: null,
    };
  }
  return {
    moduleKey: target.moduleKey,
    commandName: target.commandName,
  };
};

export const resolveGlobalCommandAiHelpWrapper = (command) => {
  const target = resolveGlobalCommandTarget(command);
  if (!target) return null;
  return {
    moduleKey: target.moduleKey,
    commandName: target.commandName,
    wrapper: target.wrapper,
  };
};
