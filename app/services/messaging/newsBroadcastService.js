import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import axios from 'axios';
import logger from '#logger';
import groupConfigStore from '../../store/groupConfigStore.js';
import { TABLES, findAll } from '../../../database/index.js';
import { getActiveSocket } from '../../config/index.js';
import getImageBuffer from '../../utils/http/getImageBufferModule.js';
import { sendAndStore } from './messagePersistenceService.js';

const DEFAULT_NEWS_API_URL = 'http://127.0.0.1:3001';
const DEFAULT_NEWS_API_ARTICLES_PATH = '/articles';
const DEFAULT_NEWS_API_ARTICLE_BY_ID_PATH = '/articles/:id';
const DEFAULT_NEWS_API_ARTICLE_BY_SLUG_PATH = '/articles/slug/:slug';
const DEFAULT_NEWS_API_TRENDS_PATH = '/trends';
const DEFAULT_NEWS_API_FRANCHISES_PATH = '/franchises';
const DEFAULT_NEWS_API_FRANCHISE_BY_SLUG_PATH = '/franchises/:slug';
const DEFAULT_NEWS_API_SOURCES_PATH = '/sources';
const DEFAULT_NEWS_API_SOURCE_BY_ID_PATH = '/sources/:sourceId';
const DEFAULT_NEWS_API_SEO_ENTITIES_PATH = '/seo/entities';
const DEFAULT_NEWS_API_SEO_BY_TYPE_SLUG_PATH = '/seo/:type/:slug';
const NEWS_API_URL = (process.env.NEWS_API_URL || DEFAULT_NEWS_API_URL).replace(/\/+$/, '');
const NEWS_API_ARTICLES_PATH = String(process.env.NEWS_API_ARTICLES_PATH || DEFAULT_NEWS_API_ARTICLES_PATH).trim() || DEFAULT_NEWS_API_ARTICLES_PATH;
const NEWS_API_ARTICLE_BY_ID_PATH = String(process.env.NEWS_API_ARTICLE_BY_ID_PATH || DEFAULT_NEWS_API_ARTICLE_BY_ID_PATH).trim() || DEFAULT_NEWS_API_ARTICLE_BY_ID_PATH;
const NEWS_API_ARTICLE_BY_SLUG_PATH = String(process.env.NEWS_API_ARTICLE_BY_SLUG_PATH || DEFAULT_NEWS_API_ARTICLE_BY_SLUG_PATH).trim() || DEFAULT_NEWS_API_ARTICLE_BY_SLUG_PATH;
const NEWS_API_TRENDS_PATH = String(process.env.NEWS_API_TRENDS_PATH || DEFAULT_NEWS_API_TRENDS_PATH).trim() || DEFAULT_NEWS_API_TRENDS_PATH;
const NEWS_API_FRANCHISES_PATH = String(process.env.NEWS_API_FRANCHISES_PATH || DEFAULT_NEWS_API_FRANCHISES_PATH).trim() || DEFAULT_NEWS_API_FRANCHISES_PATH;
const NEWS_API_FRANCHISE_BY_SLUG_PATH = String(process.env.NEWS_API_FRANCHISE_BY_SLUG_PATH || DEFAULT_NEWS_API_FRANCHISE_BY_SLUG_PATH).trim() || DEFAULT_NEWS_API_FRANCHISE_BY_SLUG_PATH;
const NEWS_API_SOURCES_PATH = String(process.env.NEWS_API_SOURCES_PATH || DEFAULT_NEWS_API_SOURCES_PATH).trim() || DEFAULT_NEWS_API_SOURCES_PATH;
const NEWS_API_SOURCE_BY_ID_PATH = String(process.env.NEWS_API_SOURCE_BY_ID_PATH || DEFAULT_NEWS_API_SOURCE_BY_ID_PATH).trim() || DEFAULT_NEWS_API_SOURCE_BY_ID_PATH;
const NEWS_API_SEO_ENTITIES_PATH = String(process.env.NEWS_API_SEO_ENTITIES_PATH || DEFAULT_NEWS_API_SEO_ENTITIES_PATH).trim() || DEFAULT_NEWS_API_SEO_ENTITIES_PATH;
const NEWS_API_SEO_BY_TYPE_SLUG_PATH = String(process.env.NEWS_API_SEO_BY_TYPE_SLUG_PATH || DEFAULT_NEWS_API_SEO_BY_TYPE_SLUG_PATH).trim() || DEFAULT_NEWS_API_SEO_BY_TYPE_SLUG_PATH;
const NEWS_API_LIMIT = Math.max(1, Math.min(500, Number(process.env.NEWS_API_LIMIT) || 120));
const NEWS_API_TIMEOUT_MS = Math.max(1000, Number(process.env.NEWS_API_TIMEOUT_MS) || 15000);
const NEWS_API_DETAILS_TIMEOUT_MS = Math.max(1000, Number(process.env.NEWS_API_DETAILS_TIMEOUT_MS) || NEWS_API_TIMEOUT_MS);
const NEWS_API_CONTEXT_TTL_MS = Math.max(30_000, Number(process.env.NEWS_API_CONTEXT_TTL_MS) || 180_000);
const NEWS_API_DETAILS_CACHE_TTL_MS = Math.max(60_000, Number(process.env.NEWS_API_DETAILS_CACHE_TTL_MS) || NEWS_API_CONTEXT_TTL_MS * 2);
const NEWS_API_CONTEXT_TOP = Math.max(5, Math.min(200, Number(process.env.NEWS_API_CONTEXT_TOP) || 40));
const NEWS_SMART_SELECTION_WINDOW = Math.max(5, Math.min(200, Number(process.env.NEWS_SMART_SELECTION_WINDOW) || 80));
const NEWS_SMART_SELECTION_ENABLED =
  String(process.env.NEWS_SMART_SELECTION_ENABLED || 'true')
    .trim()
    .toLowerCase() !== 'false';
const NEWS_CAPTION_CONTEXT_ENABLED =
  String(process.env.NEWS_CAPTION_CONTEXT_ENABLED || 'true')
    .trim()
    .toLowerCase() !== 'false';
const NEWS_API_LEGACY_FALLBACK =
  String(process.env.NEWS_API_LEGACY_FALLBACK || 'true')
    .trim()
    .toLowerCase() !== 'false';
const MIN_DELAY_MS = 60 * 1000;
const MAX_DELAY_MS = 120 * 1000;
const MAX_SENT_IDS = Number(process.env.NEWS_SENT_IDS_LIMIT || 500);
const LOOP_START_DELAY_MS = 5000;
const GROUP_UNAVAILABLE_ERROR_PATTERNS = ['item-not-found', 'not-authorized', 'not in group', 'group does not exist', 'recipient not found', 'recipient-unavailable'];

const groupLoops = new Map();
const newsContextState = {
  data: null,
  expiresAt: 0,
  inFlight: null,
};
const articleDetailsCache = new Map();
const sourceDetailsCache = new Map();
const franchiseDetailsCache = new Map();
const seoDetailsCache = new Map();

const getRandomDelayMs = () => {
  const min = MIN_DELAY_MS;
  const max = MAX_DELAY_MS;
  return Math.floor(min + Math.random() * (max - min + 1));
};

const parseConfigValue = (value) => {
  if (value === null || value === undefined) return {};
  if (Buffer.isBuffer(value)) {
    try {
      return JSON.parse(value.toString('utf8'));
    } catch (error) {
      logger.warn('Falha ao fazer parse do config (buffer).', { error: error.message });
      return {};
    }
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      logger.warn('Falha ao fazer parse do config (string).', { error: error.message });
      return {};
    }
  }
  if (typeof value === 'object') return value;
  return {};
};

const resolveNewsApiRequestUrl = (baseUrl, pathValue = '') => {
  const normalizedBase = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const normalizedPath = String(pathValue || '').trim();

  if (!normalizedPath) return normalizedBase;
  if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
  if (!normalizedBase) return normalizedPath;
  if (normalizedPath.startsWith('/')) return `${normalizedBase}${normalizedPath}`;
  return `${normalizedBase}/${normalizedPath}`;
};

const resolvePathTemplate = (template, params = {}) => {
  let resolved = String(template || '').trim();
  if (!resolved) return '';

  for (const [key, rawValue] of Object.entries(params || {})) {
    const value = String(rawValue ?? '').trim();
    if (!value) continue;
    resolved = resolved.replace(new RegExp(`:${key}\\b`, 'g'), encodeURIComponent(value));
  }

  return resolved;
};

const toFiniteNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeToken = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const normalizeStringList = (value) => {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return source.map((entry) => normalizeToken(entry)).filter(Boolean);
};

const toArrayItems = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  if (Array.isArray(data?.data)) return data.data;
  return [];
};

const getCachedEntry = (cache, key) => {
  if (!(cache instanceof Map)) return null;
  const entry = cache.get(key);
  if (!entry || typeof entry !== 'object') return null;
  const expiresAt = Number(entry.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= __timeNowMs()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

const setCachedEntry = (cache, key, value, ttlMs = NEWS_API_DETAILS_CACHE_TTL_MS) => {
  if (!(cache instanceof Map) || !key) return;
  cache.set(key, {
    value,
    expiresAt: __timeNowMs() + Math.max(1_000, Number(ttlMs) || NEWS_API_DETAILS_CACHE_TTL_MS),
  });
};

const requestNewsApi = async ({ path, timeoutMs = NEWS_API_TIMEOUT_MS, params = undefined }) => {
  const requestUrl = resolveNewsApiRequestUrl(NEWS_API_URL, path);
  const response = await axios.get(requestUrl, {
    timeout: timeoutMs,
    params,
  });
  return {
    data: response?.data,
    url: requestUrl,
  };
};

const requestNewsApiOptional = async ({ path, timeoutMs = NEWS_API_TIMEOUT_MS, params = undefined, label = 'news_api_optional' }) => {
  if (!path) return null;
  try {
    return await requestNewsApi({ path, timeoutMs, params });
  } catch (error) {
    logger.warn('Falha ao consultar endpoint auxiliar da API de noticias.', {
      label,
      path,
      error: error.message,
    });
    return null;
  }
};

const buildEmptyNewsContext = () => ({
  generatedAt: __timeNowIso(),
  trendingFranchiseSlugs: new Set(),
  franchiseStatsBySlug: new Map(),
  sourceStatsById: new Map(),
  seoEntitySlugsByType: new Map(),
});

const parseFranchiseEntries = (payload) => {
  const entries = [];
  const addEntries = (value) => {
    if (!Array.isArray(value)) return;
    value.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      entries.push(entry);
    });
  };

  addEntries(payload?.topFranchises);
  addEntries(payload?.ranking?.byMentions);
  addEntries(payload?.ranking?.byTrend);
  addEntries(toArrayItems(payload));

  return entries
    .map((entry) => {
      const slug = normalizeToken(entry.slug || entry.franchiseSlug || entry.name);
      if (!slug) return null;
      return {
        slug,
        name: String(entry.name || '').trim(),
        mentions: toFiniteNumber(entry.mentions || entry.count || entry.total, 0),
        maxTrendScore: toFiniteNumber(entry.maxTrendScore || entry.trendScore, 0),
        avgScore: toFiniteNumber(entry.avgScore || entry.score, 0),
      };
    })
    .filter(Boolean);
};

const parseSourceEntries = (payload) => {
  return toArrayItems(payload)
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const stats = entry.stats && typeof entry.stats === 'object' ? entry.stats : {};
      const sourceId = normalizeToken(entry.id || entry.sourceId || entry.source?.id);
      if (!sourceId) return null;
      return {
        id: sourceId,
        name: String(entry.name || entry.sourceName || entry.source?.name || '').trim(),
        avgScore: toFiniteNumber(entry.avgScore || stats.avgScore, 0),
        count: toFiniteNumber(entry.count || stats.count, 0),
        newCount: toFiniteNumber(entry.newCount || stats.newCount || stats.lifecycle?.new, 0),
      };
    })
    .filter(Boolean);
};

const parseSeoEntitySets = (payload) => {
  const byType = new Map();
  const items = payload?.items && typeof payload.items === 'object' ? payload.items : {};

  for (const [rawType, rawEntries] of Object.entries(items)) {
    const type = normalizeToken(rawType);
    if (!type || !Array.isArray(rawEntries)) continue;

    const slugs = new Set();
    rawEntries.slice(0, NEWS_API_CONTEXT_TOP).forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const slug = normalizeToken(entry.slug || entry.name);
      if (slug) {
        slugs.add(slug);
      }
    });

    if (slugs.size) {
      byType.set(type, slugs);
    }
  }

  return byType;
};

const buildNewsContextFromPayloads = ({ trendsPayload, franchisesPayload, sourcesPayload, seoPayload }) => {
  const context = buildEmptyNewsContext();
  const franchiseEntries = [...parseFranchiseEntries(trendsPayload), ...parseFranchiseEntries(franchisesPayload)];
  const sourceEntries = parseSourceEntries(sourcesPayload);
  const seoEntitySets = parseSeoEntitySets(seoPayload);

  for (const entry of franchiseEntries) {
    const existing = context.franchiseStatsBySlug.get(entry.slug);
    if (!existing) {
      context.franchiseStatsBySlug.set(entry.slug, { ...entry });
      continue;
    }
    context.franchiseStatsBySlug.set(entry.slug, {
      slug: entry.slug,
      name: entry.name || existing.name || '',
      mentions: Math.max(existing.mentions, entry.mentions),
      maxTrendScore: Math.max(existing.maxTrendScore, entry.maxTrendScore),
      avgScore: Math.max(existing.avgScore, entry.avgScore),
    });
  }

  const topFranchises = Array.from(context.franchiseStatsBySlug.values())
    .sort((a, b) => {
      if (b.mentions !== a.mentions) return b.mentions - a.mentions;
      if (b.maxTrendScore !== a.maxTrendScore) return b.maxTrendScore - a.maxTrendScore;
      return b.avgScore - a.avgScore;
    })
    .slice(0, NEWS_API_CONTEXT_TOP);
  topFranchises.forEach((entry) => context.trendingFranchiseSlugs.add(entry.slug));

  for (const entry of sourceEntries) {
    const existing = context.sourceStatsById.get(entry.id);
    if (!existing) {
      context.sourceStatsById.set(entry.id, { ...entry });
      continue;
    }
    context.sourceStatsById.set(entry.id, {
      id: entry.id,
      name: entry.name || existing.name || '',
      avgScore: Math.max(existing.avgScore, entry.avgScore),
      count: Math.max(existing.count, entry.count),
      newCount: Math.max(existing.newCount, entry.newCount),
    });
  }

  context.seoEntitySlugsByType = seoEntitySets;
  context.generatedAt = __timeNowIso();
  return context;
};

const getNewsContext = async () => {
  const now = __timeNowMs();
  if (newsContextState.data && newsContextState.expiresAt > now) {
    return newsContextState.data;
  }

  if (newsContextState.inFlight) {
    return newsContextState.inFlight;
  }

  const staleContext = newsContextState.data || buildEmptyNewsContext();

  newsContextState.inFlight = (async () => {
    const [trendsResponse, franchisesResponse, sourcesResponse, seoResponse] = await Promise.all([requestNewsApiOptional({ path: NEWS_API_TRENDS_PATH, timeoutMs: NEWS_API_TIMEOUT_MS, params: { top: NEWS_API_CONTEXT_TOP }, label: 'trends' }), requestNewsApiOptional({ path: NEWS_API_FRANCHISES_PATH, timeoutMs: NEWS_API_TIMEOUT_MS, params: { top: NEWS_API_CONTEXT_TOP, limit: NEWS_API_CONTEXT_TOP }, label: 'franchises' }), requestNewsApiOptional({ path: NEWS_API_SOURCES_PATH, timeoutMs: NEWS_API_TIMEOUT_MS, params: { top: NEWS_API_CONTEXT_TOP }, label: 'sources' }), requestNewsApiOptional({ path: NEWS_API_SEO_ENTITIES_PATH, timeoutMs: NEWS_API_TIMEOUT_MS, params: { top: NEWS_API_CONTEXT_TOP }, label: 'seo_entities' })]);

    const context = buildNewsContextFromPayloads({
      trendsPayload: trendsResponse?.data,
      franchisesPayload: franchisesResponse?.data,
      sourcesPayload: sourcesResponse?.data,
      seoPayload: seoResponse?.data,
    });

    newsContextState.data = context;
    newsContextState.expiresAt = __timeNowMs() + NEWS_API_CONTEXT_TTL_MS;
    return context;
  })()
    .catch((error) => {
      logger.warn('Falha ao construir contexto inteligente de noticias. Usando cache anterior.', {
        error: error.message,
      });
      return staleContext;
    })
    .finally(() => {
      newsContextState.inFlight = null;
    });

  return newsContextState.inFlight;
};

const loadEnabledGroupsFromDb = async () => {
  const enabledGroups = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const rows = await findAll(TABLES.GROUP_CONFIGS, limit, offset);
    if (!rows.length) break;

    for (const row of rows) {
      const config = parseConfigValue(row.config);
      if (config?.newsEnabled) {
        enabledGroups.push(row.id);
      }
    }

    offset += rows.length;
    if (rows.length < limit) break;
  }

  return enabledGroups;
};

const normalizeNewsItems = (data) => {
  return toArrayItems(data)
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const refined = item.refined && typeof item.refined === 'object' ? { ...item.refined } : {};

      const resolvedUrl = String(refined.url || item.url || '').trim();
      const resolvedCanonicalUrl = String(refined.canonicalUrl || item.canonicalUrl || '').trim();
      const resolvedId = String(item.id || refined.identityHash || item.identityHash || refined.contentHash || item.contentHash || resolvedCanonicalUrl || resolvedUrl || '').trim();
      const normalizedSourceId = normalizeToken(refined.sourceId || item.sourceId || '');
      const normalizedFranchiseSlug = normalizeToken(item.franchiseSlug || refined.franchiseSlug || '');
      const normalizedNewsSlug = normalizeToken(item.newsSlug || refined.newsSlug || '');

      if (!resolvedId) return null;

      return {
        id: resolvedId,
        timestamp: String(item.timestamp || refined.timestamp || refined.publishedAt || refined.firstSeenAt || item.publishedAt || '').trim() || null,
        newsSlug: normalizedNewsSlug || null,
        sourceId: normalizedSourceId || null,
        sourceName: String(refined.sourceName || item.sourceName || '').trim() || '',
        franchiseSlug: normalizedFranchiseSlug || null,
        franchiseName: String(item.franchiseName || refined.franchiseName || '').trim() || '',
        score: toFiniteNumber(item.score || refined.score, 0),
        trendScore: toFiniteNumber(item.trendScore || refined.trendScore || item.topicTrendScore || 0, 0),
        qualityScore: toFiniteNumber(item.qualityScore || refined.qualityScore || 0, 0),
        importanceScore: toFiniteNumber(item.importanceScore || refined.importanceScore || 0, 0),
        entities: item.entities && typeof item.entities === 'object' ? item.entities : refined.entities && typeof refined.entities === 'object' ? refined.entities : {},
        refined: {
          ...refined,
          name: String(refined.name || refined.title || item.name || item.title || '').trim() || '',
          summary: String(refined.summary || item.summary || '').trim() || '',
          url: resolvedUrl || resolvedCanonicalUrl,
          canonicalUrl: resolvedCanonicalUrl || resolvedUrl,
          image: String(refined.image || item.image || '').trim() || '',
          sourceId: normalizedSourceId || '',
          sourceName: String(refined.sourceName || item.sourceName || '').trim() || '',
          franchiseSlug: normalizedFranchiseSlug || '',
          franchiseName: String(item.franchiseName || refined.franchiseName || '').trim() || '',
          categories: Array.isArray(refined.categories) ? refined.categories : Array.isArray(item.categories) ? item.categories : [],
          categoriesNormalized: Array.isArray(refined.categoriesNormalized) ? refined.categoriesNormalized.map((entry) => normalizeToken(entry)).filter(Boolean) : Array.isArray(item.categoriesNormalized) ? item.categoriesNormalized.map((entry) => normalizeToken(entry)).filter(Boolean) : [],
        },
      };
    })
    .filter(Boolean);
};

const extractItemSourceId = (item) => normalizeToken(item?.sourceId || item?.refined?.sourceId || '');

const extractItemFranchiseSlug = (item) => normalizeToken(item?.franchiseSlug || item?.refined?.franchiseSlug || '');

const extractItemNewsSlug = (item) => normalizeToken(item?.newsSlug || item?.refined?.newsSlug || '');

const appendEntitySlug = (target, value) => {
  const normalized = normalizeToken(value);
  if (normalized) {
    target.add(normalized);
  }
};

const extractItemEntitySlugs = (item) => {
  const slugs = new Set();
  if (!item || typeof item !== 'object') return slugs;

  appendEntitySlug(slugs, extractItemFranchiseSlug(item));
  const categoriesNormalized = Array.isArray(item?.refined?.categoriesNormalized) ? item.refined.categoriesNormalized : [];
  categoriesNormalized.forEach((entry) => appendEntitySlug(slugs, entry));

  const entities = item?.entities && typeof item.entities === 'object' ? item.entities : {};
  for (const value of Object.values(entities)) {
    if (!Array.isArray(value)) continue;
    value.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      appendEntitySlug(slugs, entry.slug || entry.name);
    });
  }

  return slugs;
};

const getItemTimestampMs = (item) => {
  const raw = String(item?.timestamp || item?.refined?.publishedAt || item?.refined?.firstSeenAt || '').trim();
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortByTimestampAsc = (items) =>
  items.sort((a, b) => {
    const aTime = getItemTimestampMs(a);
    const bTime = getItemTimestampMs(b);
    return aTime - bTime;
  });

const sortByTimestampDesc = (items) =>
  items.sort((a, b) => {
    const aTime = getItemTimestampMs(a);
    const bTime = getItemTimestampMs(b);
    return bTime - aTime;
  });

const mergeNewsItem = (primaryItem, fallbackItem) => {
  const base = primaryItem && typeof primaryItem === 'object' ? primaryItem : null;
  const fallback = fallbackItem && typeof fallbackItem === 'object' ? fallbackItem : null;
  if (!base) return fallback;
  if (!fallback) return base;

  const mergedRefined = {
    ...(fallback.refined || {}),
    ...(base.refined || {}),
  };

  const merged = {
    ...fallback,
    ...base,
    id: String(base.id || fallback.id || '').trim() || null,
    timestamp: String(base.timestamp || fallback.timestamp || '').trim() || null,
    newsSlug: extractItemNewsSlug(base) || extractItemNewsSlug(fallback) || null,
    sourceId: extractItemSourceId(base) || extractItemSourceId(fallback) || null,
    sourceName: String(base.sourceName || fallback.sourceName || mergedRefined.sourceName || '').trim(),
    franchiseSlug: extractItemFranchiseSlug(base) || extractItemFranchiseSlug(fallback) || null,
    franchiseName: String(base.franchiseName || fallback.franchiseName || mergedRefined.franchiseName || '').trim(),
    score: Math.max(toFiniteNumber(base.score, 0), toFiniteNumber(fallback.score, 0)),
    trendScore: Math.max(toFiniteNumber(base.trendScore, 0), toFiniteNumber(fallback.trendScore, 0)),
    qualityScore: Math.max(toFiniteNumber(base.qualityScore, 0), toFiniteNumber(fallback.qualityScore, 0)),
    importanceScore: Math.max(toFiniteNumber(base.importanceScore, 0), toFiniteNumber(fallback.importanceScore, 0)),
    entities: Object.keys(base.entities || {}).length ? base.entities : fallback.entities || {},
    refined: {
      ...mergedRefined,
      name: String(base?.refined?.name || fallback?.refined?.name || '').trim(),
      summary: String(base?.refined?.summary || fallback?.refined?.summary || '').trim(),
      url: String(base?.refined?.url || fallback?.refined?.url || '').trim(),
      canonicalUrl: String(base?.refined?.canonicalUrl || fallback?.refined?.canonicalUrl || '').trim(),
      image: String(base?.refined?.image || fallback?.refined?.image || '').trim(),
      sourceId: extractItemSourceId(base) || extractItemSourceId(fallback) || '',
      sourceName: String(base?.refined?.sourceName || fallback?.refined?.sourceName || '').trim(),
      franchiseSlug: extractItemFranchiseSlug(base) || extractItemFranchiseSlug(fallback) || '',
      franchiseName: String(base?.refined?.franchiseName || fallback?.refined?.franchiseName || '').trim(),
      categoriesNormalized: Array.isArray(base?.refined?.categoriesNormalized) && base.refined.categoriesNormalized.length ? base.refined.categoriesNormalized : Array.isArray(fallback?.refined?.categoriesNormalized) ? fallback.refined.categoriesNormalized : [],
    },
  };

  return merged;
};

const extractSingleNewsItemFromPayload = (payload) => {
  if (payload?.item && typeof payload.item === 'object') {
    const normalizedFromItem = normalizeNewsItems([payload.item]);
    return normalizedFromItem[0] || null;
  }

  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  if (candidates.length > 0) {
    const normalizedCandidates = normalizeNewsItems(candidates);
    return normalizedCandidates[0] || null;
  }

  const normalized = normalizeNewsItems(payload);
  return normalized[0] || null;
};

const fetchArticleById = async (articleId) => {
  const normalizedId = String(articleId || '').trim();
  if (!normalizedId) return null;

  const cacheKey = `id:${normalizedId}`;
  const cached = getCachedEntry(articleDetailsCache, cacheKey);
  if (cached) return cached;

  const path = resolvePathTemplate(NEWS_API_ARTICLE_BY_ID_PATH, { id: normalizedId });
  if (!path || path.includes(':id')) return null;

  const response = await requestNewsApiOptional({
    path,
    timeoutMs: NEWS_API_DETAILS_TIMEOUT_MS,
    params: { limit: 1 },
    label: 'article_by_id',
  });

  const normalized = extractSingleNewsItemFromPayload(response?.data);
  if (normalized) {
    setCachedEntry(articleDetailsCache, cacheKey, normalized);
  }

  return normalized;
};

const fetchArticleBySlug = async (newsSlug) => {
  const normalizedSlug = normalizeToken(newsSlug);
  if (!normalizedSlug) return null;

  const cacheKey = `slug:${normalizedSlug}`;
  const cached = getCachedEntry(articleDetailsCache, cacheKey);
  if (cached) return cached;

  const path = resolvePathTemplate(NEWS_API_ARTICLE_BY_SLUG_PATH, { slug: normalizedSlug });
  if (!path || path.includes(':slug')) return null;

  const response = await requestNewsApiOptional({
    path,
    timeoutMs: NEWS_API_DETAILS_TIMEOUT_MS,
    params: { limit: 1 },
    label: 'article_by_slug',
  });

  const normalized = extractSingleNewsItemFromPayload(response?.data);
  if (normalized) {
    setCachedEntry(articleDetailsCache, cacheKey, normalized);
  }

  return normalized;
};

const enrichNewsItemIfNeeded = async (newsItem) => {
  if (!newsItem || typeof newsItem !== 'object') return newsItem;

  const hasSummary = Boolean(String(newsItem?.refined?.summary || '').trim());
  const hasImage = Boolean(String(newsItem?.refined?.image || '').trim());
  const hasSource = Boolean(extractItemSourceId(newsItem));
  const hasFranchise = Boolean(extractItemFranchiseSlug(newsItem));

  if (hasSummary && hasImage && hasSource && hasFranchise) {
    return newsItem;
  }

  const [byId, bySlug] = await Promise.all([fetchArticleById(newsItem.id), fetchArticleBySlug(extractItemNewsSlug(newsItem))]);

  return mergeNewsItem(mergeNewsItem(newsItem, byId), bySlug);
};

const fetchSourceDetails = async (sourceId) => {
  const normalizedSourceId = normalizeToken(sourceId);
  if (!normalizedSourceId) return null;

  const cached = getCachedEntry(sourceDetailsCache, normalizedSourceId);
  if (cached) return cached;

  const path = resolvePathTemplate(NEWS_API_SOURCE_BY_ID_PATH, { sourceId: normalizedSourceId });
  if (!path || path.includes(':sourceId')) return null;

  const response = await requestNewsApiOptional({
    path,
    timeoutMs: NEWS_API_DETAILS_TIMEOUT_MS,
    params: { limit: 1 },
    label: 'source_by_id',
  });

  const source = response?.data?.source;
  if (!source || typeof source !== 'object') return null;

  const parsed = {
    id: normalizeToken(source.id || normalizedSourceId),
    name: String(source.name || '').trim(),
  };

  setCachedEntry(sourceDetailsCache, normalizedSourceId, parsed);
  return parsed;
};

const fetchFranchiseDetails = async (franchiseSlug) => {
  const normalizedSlug = normalizeToken(franchiseSlug);
  if (!normalizedSlug) return null;

  const cached = getCachedEntry(franchiseDetailsCache, normalizedSlug);
  if (cached) return cached;

  const path = resolvePathTemplate(NEWS_API_FRANCHISE_BY_SLUG_PATH, { slug: normalizedSlug });
  if (!path || path.includes(':slug')) return null;

  const response = await requestNewsApiOptional({
    path,
    timeoutMs: NEWS_API_DETAILS_TIMEOUT_MS,
    params: { limit: 1 },
    label: 'franchise_by_slug',
  });

  const payload = response?.data;
  if (!payload || typeof payload !== 'object') return null;

  const parsed = {
    slug: normalizeToken(payload.slug || normalizedSlug),
    name: String(payload.name || '').trim(),
    mentions: toFiniteNumber(payload.total, 0),
  };

  setCachedEntry(franchiseDetailsCache, normalizedSlug, parsed);
  return parsed;
};

const fetchSeoEntityDetails = async ({ type, slug }) => {
  const normalizedType = normalizeToken(type);
  const normalizedSlug = normalizeToken(slug);
  if (!normalizedType || !normalizedSlug) return null;

  const cacheKey = `${normalizedType}:${normalizedSlug}`;
  const cached = getCachedEntry(seoDetailsCache, cacheKey);
  if (cached) return cached;

  const path = resolvePathTemplate(NEWS_API_SEO_BY_TYPE_SLUG_PATH, {
    type: normalizedType,
    slug: normalizedSlug,
  });
  if (!path || path.includes(':type') || path.includes(':slug')) return null;

  const response = await requestNewsApiOptional({
    path,
    timeoutMs: NEWS_API_DETAILS_TIMEOUT_MS,
    params: { limit: 1 },
    label: 'seo_by_type_slug',
  });

  const entity = response?.data?.entity;
  if (!entity || typeof entity !== 'object') return null;

  const parsed = {
    type: normalizeToken(entity.type || normalizedType),
    slug: normalizeToken(entity.slug || normalizedSlug),
    name: String(entity.name || '').trim(),
    count: toFiniteNumber(entity.count, 0),
  };

  setCachedEntry(seoDetailsCache, cacheKey, parsed);
  return parsed;
};

const fetchNewsItems = async () => {
  const articlesRequestUrl = resolveNewsApiRequestUrl(NEWS_API_URL, NEWS_API_ARTICLES_PATH);

  try {
    const response = await requestNewsApi({
      path: NEWS_API_ARTICLES_PATH,
      timeoutMs: NEWS_API_TIMEOUT_MS,
      params: { limit: NEWS_API_LIMIT },
    });
    return normalizeNewsItems(response.data);
  } catch (error) {
    if (!NEWS_API_LEGACY_FALLBACK || articlesRequestUrl === NEWS_API_URL) {
      logger.error('Erro ao buscar noticias da API.', {
        error: error.message,
        url: articlesRequestUrl,
      });
      return [];
    }

    logger.warn('Falha no endpoint de artigos paginado; tentando fallback legado.', {
      error: error.message,
      url: articlesRequestUrl,
      fallback_url: NEWS_API_URL,
    });

    try {
      const legacyResponse = await requestNewsApi({ path: '', timeoutMs: NEWS_API_TIMEOUT_MS });
      return normalizeNewsItems(legacyResponse.data);
    } catch (legacyError) {
      logger.error('Erro ao buscar noticias da API.', {
        error: legacyError.message,
        url: NEWS_API_URL,
      });
      return [];
    }
  }
};

const normalizeNewsFilters = (config = {}) => {
  const nested = config?.newsFilters && typeof config.newsFilters === 'object' ? config.newsFilters : {};

  return {
    includeSourceIds: new Set([...normalizeStringList(config.newsSources), ...normalizeStringList(config.newsSourceIds), ...normalizeStringList(nested.sources), ...normalizeStringList(nested.sourceIds)].filter(Boolean)),
    excludeSourceIds: new Set([...normalizeStringList(config.newsBlockedSources), ...normalizeStringList(config.newsExcludeSources), ...normalizeStringList(nested.excludeSources), ...normalizeStringList(nested.blockedSources)].filter(Boolean)),
    includeFranchiseSlugs: new Set([...normalizeStringList(config.newsFranchises), ...normalizeStringList(config.newsFranchiseSlugs), ...normalizeStringList(nested.franchises), ...normalizeStringList(nested.franchiseSlugs)].filter(Boolean)),
    excludeFranchiseSlugs: new Set([...normalizeStringList(config.newsBlockedFranchises), ...normalizeStringList(config.newsExcludeFranchises), ...normalizeStringList(nested.excludeFranchises), ...normalizeStringList(nested.blockedFranchises)].filter(Boolean)),
    includeEntitySlugs: new Set([...normalizeStringList(config.newsEntities), ...normalizeStringList(config.newsEntitySlugs), ...normalizeStringList(config.newsTags), ...normalizeStringList(nested.entities), ...normalizeStringList(nested.entitySlugs), ...normalizeStringList(nested.tags)].filter(Boolean)),
    excludeEntitySlugs: new Set([...normalizeStringList(config.newsBlockedEntities), ...normalizeStringList(config.newsExcludeEntities), ...normalizeStringList(config.newsBlockedTags), ...normalizeStringList(nested.excludeEntities), ...normalizeStringList(nested.blockedEntities), ...normalizeStringList(nested.excludeTags)].filter(Boolean)),
    onlyTrending: Boolean(config.newsOnlyTrending || nested.onlyTrending),
  };
};

const hasSetIntersection = (setA, setB) => {
  if (!(setA instanceof Set) || !(setB instanceof Set)) return false;
  if (setA.size === 0 || setB.size === 0) return false;

  const [smallest, largest] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const value of smallest.values()) {
    if (largest.has(value)) return true;
  }
  return false;
};

const itemMatchesNewsFilters = (newsItem, filters, context) => {
  if (!newsItem || typeof newsItem !== 'object') return false;
  const safeFilters = filters || normalizeNewsFilters();

  const sourceId = extractItemSourceId(newsItem);
  const franchiseSlug = extractItemFranchiseSlug(newsItem);
  const entitySlugs = extractItemEntitySlugs(newsItem);

  if (safeFilters.includeSourceIds.size > 0 && (!sourceId || !safeFilters.includeSourceIds.has(sourceId))) {
    return false;
  }
  if (sourceId && safeFilters.excludeSourceIds.has(sourceId)) {
    return false;
  }

  if (safeFilters.includeFranchiseSlugs.size > 0 && (!franchiseSlug || !safeFilters.includeFranchiseSlugs.has(franchiseSlug))) {
    return false;
  }
  if (franchiseSlug && safeFilters.excludeFranchiseSlugs.has(franchiseSlug)) {
    return false;
  }

  if (safeFilters.includeEntitySlugs.size > 0 && !hasSetIntersection(safeFilters.includeEntitySlugs, entitySlugs)) {
    return false;
  }
  if (safeFilters.excludeEntitySlugs.size > 0 && hasSetIntersection(safeFilters.excludeEntitySlugs, entitySlugs)) {
    return false;
  }

  if (safeFilters.onlyTrending) {
    if (!franchiseSlug) return false;
    if (!(context?.trendingFranchiseSlugs instanceof Set)) return false;
    if (!context.trendingFranchiseSlugs.has(franchiseSlug)) return false;
  }

  return true;
};

const computeNewsPriority = (newsItem, context) => {
  const sourceId = extractItemSourceId(newsItem);
  const franchiseSlug = extractItemFranchiseSlug(newsItem);
  const entitySlugs = extractItemEntitySlugs(newsItem);
  const timestampMs = getItemTimestampMs(newsItem);
  const ageHours = timestampMs > 0 ? Math.max(0, (__timeNowMs() - timestampMs) / (60 * 60 * 1000)) : 48;

  const baseScore = toFiniteNumber(newsItem?.score, 0);
  const trendScore = toFiniteNumber(newsItem?.trendScore, 0);
  const qualityScore = toFiniteNumber(newsItem?.qualityScore, 0);
  const importanceScore = toFiniteNumber(newsItem?.importanceScore, 0);
  const recencyScore = Math.max(0, 48 - Math.min(48, ageHours));

  const sourceStats = sourceId ? context?.sourceStatsById?.get(sourceId) : null;
  const sourceBoost = sourceStats ? Math.min(12, toFiniteNumber(sourceStats.avgScore, 0) / 10) : 0;

  const franchiseStats = franchiseSlug ? context?.franchiseStatsBySlug?.get(franchiseSlug) : null;
  const franchiseBoost = franchiseStats ? Math.min(18, toFiniteNumber(franchiseStats.mentions, 0) * 2 + toFiniteNumber(franchiseStats.maxTrendScore, 0)) : 0;
  const trendingBoost = franchiseSlug && context?.trendingFranchiseSlugs?.has(franchiseSlug) ? 12 : 0;

  let seoBoost = 0;
  if (context?.seoEntitySlugsByType instanceof Map && entitySlugs.size > 0) {
    for (const [type, seoSlugs] of context.seoEntitySlugsByType.entries()) {
      if (!(seoSlugs instanceof Set) || seoSlugs.size === 0) continue;
      if (!hasSetIntersection(entitySlugs, seoSlugs)) continue;
      seoBoost += type === 'anime' ? 8 : 4;
    }
  }

  return baseScore + trendScore + qualityScore * 0.2 + importanceScore * 0.3 + recencyScore + sourceBoost + franchiseBoost + trendingBoost + seoBoost;
};

const selectNextNewsItem = ({ unsentItems = [], config = {}, context = null }) => {
  const filters = normalizeNewsFilters(config);
  const filteredItems = unsentItems.filter((item) => itemMatchesNewsFilters(item, filters, context));
  if (filteredItems.length === 0) {
    return null;
  }

  if (!NEWS_SMART_SELECTION_ENABLED) {
    sortByTimestampAsc(filteredItems);
    return filteredItems[0] || null;
  }

  const recentPool = sortByTimestampDesc([...filteredItems]).slice(0, NEWS_SMART_SELECTION_WINDOW);
  const ranked = recentPool
    .map((item) => ({
      item,
      score: computeNewsPriority(item, context),
      timestampMs: getItemTimestampMs(item),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.timestampMs - a.timestampMs;
    });

  return ranked[0]?.item || null;
};

const buildNewsCaption = async (newsItem, context = null) => {
  const title = newsItem?.refined?.name || 'Notícia';
  const summary = (newsItem?.refined?.summary || '').trim();
  const url = newsItem?.refined?.url || newsItem?.refined?.canonicalUrl || '';
  const sourceId = extractItemSourceId(newsItem);
  const franchiseSlug = extractItemFranchiseSlug(newsItem);
  const fallbackTagSlug = normalizeToken(newsItem?.refined?.categoriesNormalized?.[0] || '');

  const sourceFromContext = sourceId ? context?.sourceStatsById?.get(sourceId) : null;
  const franchiseFromContext = franchiseSlug ? context?.franchiseStatsBySlug?.get(franchiseSlug) : null;

  const needsSourceDetail = sourceId && !String(newsItem?.sourceName || newsItem?.refined?.sourceName || sourceFromContext?.name || '').trim();
  const needsFranchiseDetail = franchiseSlug && !String(newsItem?.franchiseName || newsItem?.refined?.franchiseName || franchiseFromContext?.name || '').trim();

  const [sourceDetails, franchiseDetails, seoByFranchise, seoByTag] = await Promise.all([needsSourceDetail ? fetchSourceDetails(sourceId) : null, needsFranchiseDetail ? fetchFranchiseDetails(franchiseSlug) : null, franchiseSlug ? fetchSeoEntityDetails({ type: 'anime', slug: franchiseSlug }) : null, !franchiseSlug && fallbackTagSlug ? fetchSeoEntityDetails({ type: 'tag', slug: fallbackTagSlug }) : null]);

  const lines = [`📰 *${title}*`];
  if (NEWS_CAPTION_CONTEXT_ENABLED) {
    const sourceName = String(newsItem?.sourceName || newsItem?.refined?.sourceName || sourceFromContext?.name || sourceDetails?.name || '').trim();
    const franchiseName = String(newsItem?.franchiseName || newsItem?.refined?.franchiseName || franchiseFromContext?.name || franchiseDetails?.name || '').trim();
    const franchiseMentions = toFiniteNumber(franchiseFromContext?.mentions || franchiseDetails?.mentions || seoByFranchise?.count, 0);
    const isTrending = Boolean(franchiseSlug && context?.trendingFranchiseSlugs?.has(franchiseSlug));
    const metadataParts = [];

    if (sourceName) {
      metadataParts.push(`Fonte: ${sourceName}`);
    }

    if (franchiseName) {
      const label = isTrending ? 'Tendência' : 'Franquia';
      const mentionText = franchiseMentions > 0 ? ` (${franchiseMentions} menções)` : '';
      metadataParts.push(`${label}: ${franchiseName}${mentionText}`);
    } else if (seoByTag?.name) {
      const mentionText = seoByTag.count > 0 ? ` (${seoByTag.count} menções)` : '';
      metadataParts.push(`Tag: ${seoByTag.name}${mentionText}`);
    }

    if (metadataParts.length > 0) {
      lines.push('', `📌 ${metadataParts.slice(0, 2).join(' • ')}`);
    }
  }

  if (summary) {
    lines.push('', summary);
  }
  if (url) {
    lines.push('', `🔗 ${url}`);
  }
  return lines.join('\n').trim();
};

const trimSentIds = (ids) => {
  if (!Array.isArray(ids)) return [];
  if (!Number.isFinite(MAX_SENT_IDS) || MAX_SENT_IDS <= 0) return ids;
  if (ids.length <= MAX_SENT_IDS) return ids;
  return ids.slice(ids.length - MAX_SENT_IDS);
};

const toErrorFragments = (error) => {
  const candidates = [error?.message, error?.data, error?.output?.payload?.message, error?.output?.payload?.error, error?.output?.statusCode, error?.status, error?.cause?.message, error?.cause?.data];

  return candidates
    .filter((value) => value !== null && value !== undefined)
    .map((value) => {
      if (typeof value === 'string') return value.toLowerCase();
      if (typeof value === 'number') return String(value);
      try {
        return JSON.stringify(value).toLowerCase();
      } catch {
        return String(value).toLowerCase();
      }
    });
};

const isGroupUnavailableError = (error) => {
  const fragments = toErrorFragments(error);
  return fragments.some((fragment) => GROUP_UNAVAILABLE_ERROR_PATTERNS.some((pattern) => fragment.includes(pattern)));
};

const scheduleNextRun = (groupId, delayMs) => {
  const state = groupLoops.get(groupId);
  if (!state || state.stopped) return;
  if (state.timeoutId) clearTimeout(state.timeoutId);
  state.timeoutId = setTimeout(() => {
    processGroupNews(groupId);
  }, delayMs);
};

const stopGroupLoopInternal = (groupId) => {
  const state = groupLoops.get(groupId);
  if (!state) return;
  if (state.timeoutId) clearTimeout(state.timeoutId);
  state.stopped = true;
  groupLoops.delete(groupId);
};

const processGroupNews = async (groupId) => {
  const state = groupLoops.get(groupId);
  if (!state || state.stopped) return;
  if (state.inFlight) return;

  state.inFlight = true;
  let shouldSchedule = true;

  try {
    const config = await groupConfigStore.getGroupConfig(groupId);
    if (!config?.newsEnabled) {
      shouldSchedule = false;
      stopGroupLoopInternal(groupId);
      return;
    }

    const sock = getActiveSocket();
    if (!sock) {
      const now = __timeNowMs();
      if (!state.lastNotReadyLogAt || now - state.lastNotReadyLogAt > 60_000) {
        state.lastNotReadyLogAt = now;
        logger.debug('Socket nao disponivel para envio de noticias.', { groupId });
      }
      return;
    }

    const [allNews, newsContext] = await Promise.all([fetchNewsItems(), getNewsContext()]);
    if (allNews.length === 0) {
      return;
    }

    const sentIds = new Set(Array.isArray(config.newsSentIds) ? config.newsSentIds : []);
    const unsent = allNews.filter((item) => item?.id && !sentIds.has(item.id));

    if (unsent.length === 0) {
      return;
    }

    const selectedItem = selectNextNewsItem({
      unsentItems: unsent,
      config,
      context: newsContext,
    });
    if (!selectedItem) {
      const now = __timeNowMs();
      if (!state.lastNoMatchLogAt || now - state.lastNoMatchLogAt > 10 * 60_000) {
        state.lastNoMatchLogAt = now;
        logger.debug('Nenhuma noticia compativel com os filtros configurados para o grupo.', {
          groupId,
          unsent_count: unsent.length,
        });
      }
      return;
    }

    const nextItem = await enrichNewsItemIfNeeded(selectedItem);
    const caption = await buildNewsCaption(nextItem, newsContext);
    const imageUrl = nextItem?.refined?.image || '';
    let sent = false;

    try {
      if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
        let imageBuffer = null;
        try {
          imageBuffer = await getImageBuffer(imageUrl);
        } catch (error) {
          logger.warn('Falha ao baixar imagem da noticia. Enviando texto.', {
            groupId,
            error: error.message,
            imageUrl,
          });
        }

        if (imageBuffer) {
          try {
            await sendAndStore(sock, groupId, { image: imageBuffer, caption });
            sent = true;
          } catch (error) {
            if (isGroupUnavailableError(error)) {
              throw error;
            }
            logger.warn('Falha ao enviar imagem da noticia. Enviando texto.', {
              groupId,
              error: error.message,
            });
          }
        }
      }

      if (!sent) {
        await sendAndStore(sock, groupId, { text: caption });
      }

      sentIds.add(nextItem.id);
      const updatedSentIds = trimSentIds(Array.from(sentIds));
      await groupConfigStore.updateGroupConfig(groupId, {
        newsSentIds: updatedSentIds,
        newsLastSentAt: __timeNowIso(),
      });
    } catch (error) {
      if (isGroupUnavailableError(error)) {
        shouldSchedule = false;
        stopGroupLoopInternal(groupId);

        try {
          await groupConfigStore.updateGroupConfig(groupId, { newsEnabled: false });
        } catch (updateError) {
          logger.error('Falha ao desativar noticias para grupo indisponivel.', {
            groupId,
            error: updateError.message,
          });
        }

        logger.warn('Grupo indisponivel para envio de noticias. Envio automatico desativado.', {
          groupId,
          error: error.message,
        });
        return;
      }

      logger.error('Erro ao enviar noticia para grupo.', {
        groupId,
        error: error.message,
      });
    }
  } catch (error) {
    logger.error('Erro no processamento de noticias do grupo.', {
      groupId,
      error: error.message,
    });
  } finally {
    state.inFlight = false;
    if (shouldSchedule) {
      scheduleNextRun(groupId, getRandomDelayMs());
    }
  }
};

export const startNewsBroadcastForGroup = (groupId, options = {}) => {
  const existing = groupLoops.get(groupId);
  if (existing && !existing.stopped) {
    return;
  }

  const initialDelay = typeof options.initialDelayMs === 'number' ? options.initialDelayMs : LOOP_START_DELAY_MS;

  groupLoops.set(groupId, {
    timeoutId: null,
    inFlight: false,
    stopped: false,
  });

  scheduleNextRun(groupId, initialDelay);
};

export const stopNewsBroadcastForGroup = (groupId) => {
  stopGroupLoopInternal(groupId);
};

export const syncNewsBroadcastService = async () => {
  try {
    const enabledGroups = await loadEnabledGroupsFromDb();
    if (enabledGroups.length === 0) {
      logger.info('Nenhum grupo com noticias ativadas encontrado.');
      return;
    }

    enabledGroups.forEach((groupId) => {
      startNewsBroadcastForGroup(groupId);
    });

    logger.info('Serviço de noticias sincronizado.', {
      groups: enabledGroups.length,
    });
  } catch (error) {
    logger.error('Falha ao sincronizar serviço de noticias.', { error: error.message });
  }
};

export const initializeNewsBroadcastService = async () => syncNewsBroadcastService();

export const stopNewsBroadcastService = () => {
  const groupIds = Array.from(groupLoops.keys());
  if (!groupIds.length) {
    return;
  }

  groupIds.forEach((groupId) => stopGroupLoopInternal(groupId));
  logger.info('Servico de noticias parado.', { groups: groupIds.length });
};

export const getNewsStatusForGroup = async (groupId) => {
  const config = await groupConfigStore.getGroupConfig(groupId);
  const sentCount = Array.isArray(config.newsSentIds) ? config.newsSentIds.length : 0;
  return {
    enabled: Boolean(config.newsEnabled),
    sentCount,
    lastSentAt: config.newsLastSentAt || null,
  };
};
