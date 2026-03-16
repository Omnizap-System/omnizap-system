import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { createHash } from 'node:crypto';

import OpenAI from 'openai';

import { executeQuery, TABLES } from '../../../database/index.js';
import logger from '#logger';
import { findStickerClassificationByAssetId, updateStickerClassificationSemanticCluster } from './stickerAssetClassificationRepository.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const ENABLE_SEMANTIC_CLUSTERING = parseEnvBool(process.env.ENABLE_SEMANTIC_CLUSTERING, false);
const OPENAI_TIMEOUT_MS = Math.max(1_000, Number(process.env.SEMANTIC_CLUSTER_OPENAI_TIMEOUT_MS) || 10_000);
const EMBEDDING_MODEL = String(process.env.SEMANTIC_CLUSTER_EMBEDDING_MODEL || 'text-embedding-3-small').trim() || 'text-embedding-3-small';
const SLUG_MODEL = String(process.env.SEMANTIC_CLUSTER_SLUG_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
const SIMILARITY_THRESHOLD = Number.isFinite(Number(process.env.SEMANTIC_CLUSTER_SIMILARITY_THRESHOLD)) ? Math.max(0.5, Math.min(0.99, Number(process.env.SEMANTIC_CLUSTER_SIMILARITY_THRESHOLD))) : 0.87;
const MAX_CLUSTER_SCAN = Math.max(100, Math.min(20_000, Number(process.env.SEMANTIC_CLUSTER_MAX_SCAN) || 5_000));
const MAX_SUGGESTIONS_PER_ASSET = Math.max(1, Math.min(20, Number(process.env.SEMANTIC_CLUSTER_MAX_SUGGESTIONS_PER_ASSET) || 8));
const CLUSTERING_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SEMANTIC_CLUSTER_CONCURRENCY) || 2));
const RESOLUTION_CACHE_TTL_MS = Math.max(5_000, Number(process.env.SEMANTIC_CLUSTER_MEMORY_CACHE_TTL_MS) || 5 * 60 * 1000);
const SEMANTIC_CLUSTER_REPROCESS_EXISTING = parseEnvBool(process.env.SEMANTIC_CLUSTER_REPROCESS_EXISTING, false);

let cachedClient = null;
const inMemorySuggestionCache = new Map();
const inMemoryClusterById = new Map();
let inMemoryClusterList = {
  expiresAt: 0,
  items: [],
};
let clusterListPending = null;

const pendingTasksByAssetId = new Map();
let queueDrainScheduled = false;
let queueRunning = 0;

const normalizeSuggestion = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 512);

const normalizeSlug = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!normalized) return '';
  return normalized.split('_').filter(Boolean).slice(0, 2).join('_');
};

const fallbackSlugFromSuggestion = (suggestionText) => {
  const normalized = normalizeSuggestion(suggestionText);
  if (!normalized) return 'misc_theme';
  const slug = normalizeSlug(normalized);
  return slug || 'misc_theme';
};

const hashSuggestion = (normalizedSuggestion) =>
  createHash('sha256')
    .update(String(normalizedSuggestion || ''), 'utf8')
    .digest('hex');

const serializeEmbedding = (embedding = []) => {
  const vector = Array.isArray(embedding) ? embedding : [];
  const clean = vector.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!clean.length) return { dim: 0, buffer: Buffer.alloc(0) };
  const buffer = Buffer.allocUnsafe(clean.length * 4);
  for (let index = 0; index < clean.length; index += 1) {
    buffer.writeFloatLE(clean[index], index * 4);
  }
  return { dim: clean.length, buffer };
};

const parseEmbedding = (raw, dim = 0) => {
  if (!Buffer.isBuffer(raw) || raw.length < 4) return [];
  const vectorSize = Math.floor(raw.length / 4);
  const size = dim > 0 ? Math.min(dim, vectorSize) : vectorSize;
  if (size <= 0) return [];
  const output = new Array(size);
  for (let index = 0; index < size; index += 1) {
    output[index] = raw.readFloatLE(index * 4);
  }
  return output;
};

const cosineSimilarity = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) return 0;
  const size = Math.min(left.length, right.length);
  if (size <= 0) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < size; index += 1) {
    const leftValue = Number(left[index] || 0);
    const rightValue = Number(right[index] || 0);
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))));
};

const resolveOpenAIClient = () => {
  if (cachedClient) return cachedClient;
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  cachedClient = new OpenAI({
    apiKey,
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: 0,
  });
  return cachedClient;
};

const shouldRunSemanticClustering = () => ENABLE_SEMANTIC_CLUSTERING && Boolean(resolveOpenAIClient());

const getSuggestionCacheRow = async (normalizedSuggestion) => {
  const normalized = normalizeSuggestion(normalizedSuggestion);
  if (!normalized) return null;

  const rows = await executeQuery(
    `SELECT suggestion_hash, normalized_text, semantic_cluster_id, canonical_slug, embedding_dim, embedding, last_similarity
     FROM ${TABLES.SEMANTIC_THEME_SUGGESTION_CACHE}
     WHERE normalized_text = ?
     LIMIT 1`,
    [normalized],
  );
  const row = rows?.[0] || null;
  if (!row) return null;

  return {
    suggestion_hash: row.suggestion_hash,
    normalized_text: row.normalized_text,
    semantic_cluster_id: Number(row.semantic_cluster_id || 0) || null,
    canonical_slug: row.canonical_slug || null,
    embedding: parseEmbedding(row.embedding, Number(row.embedding_dim || 0)),
    last_similarity: Number.isFinite(Number(row.last_similarity)) ? Number(row.last_similarity) : null,
  };
};

const upsertSuggestionCacheRow = async ({ suggestionText, normalizedText, semanticClusterId, canonicalSlug, embedding = [], similarity = null }) => {
  const normalized = normalizeSuggestion(normalizedText || suggestionText);
  if (!normalized || !semanticClusterId) return false;
  const suggestionHash = hashSuggestion(normalized);
  const { dim, buffer } = serializeEmbedding(embedding);
  if (dim <= 0 || !buffer.length) return false;

  await executeQuery(
    `INSERT INTO ${TABLES.SEMANTIC_THEME_SUGGESTION_CACHE}
      (suggestion_hash, suggestion_text, normalized_text, semantic_cluster_id, canonical_slug, embedding_dim, embedding, last_similarity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      suggestion_text = VALUES(suggestion_text),
      normalized_text = VALUES(normalized_text),
      semantic_cluster_id = VALUES(semantic_cluster_id),
      canonical_slug = VALUES(canonical_slug),
      embedding_dim = VALUES(embedding_dim),
      embedding = VALUES(embedding),
      last_similarity = VALUES(last_similarity),
      updated_at = CURRENT_TIMESTAMP`,
    [suggestionHash, String(suggestionText || normalized).slice(0, 512), normalized, semanticClusterId, canonicalSlug || null, dim, buffer, similarity !== null && Number.isFinite(Number(similarity)) ? Number(Number(similarity).toFixed(6)) : null],
  );
  return true;
};

const listSemanticClusters = async () => {
  const now = __timeNowMs();
  if (inMemoryClusterList.expiresAt > now && Array.isArray(inMemoryClusterList.items)) {
    return inMemoryClusterList.items;
  }
  if (clusterListPending) return clusterListPending;

  clusterListPending = executeQuery(
    `SELECT id, canonical_slug, embedding_dim, embedding
     FROM ${TABLES.SEMANTIC_THEME_CLUSTER}
     ORDER BY id DESC
     LIMIT ${Math.max(1, MAX_CLUSTER_SCAN)}`,
    [],
  )
    .then((rows) => {
      const parsed = (Array.isArray(rows) ? rows : [])
        .map((row) => ({
          id: Number(row.id || 0),
          canonical_slug: row.canonical_slug || null,
          embedding: parseEmbedding(row.embedding, Number(row.embedding_dim || 0)),
        }))
        .filter((row) => row.id > 0 && Array.isArray(row.embedding) && row.embedding.length > 0);
      inMemoryClusterList = {
        expiresAt: __timeNowMs() + RESOLUTION_CACHE_TTL_MS,
        items: parsed,
      };
      for (const cluster of parsed) {
        inMemoryClusterById.set(cluster.id, cluster);
      }
      return parsed;
    })
    .finally(() => {
      clusterListPending = null;
    });

  return clusterListPending;
};

const createSemanticCluster = async ({ canonicalSlug, embedding }) => {
  const slug = normalizeSlug(canonicalSlug) || 'misc_theme';
  const { dim, buffer } = serializeEmbedding(embedding);
  if (!buffer.length || dim <= 0) {
    throw new Error('embedding_invalid_for_cluster');
  }

  const result = await executeQuery(
    `INSERT INTO ${TABLES.SEMANTIC_THEME_CLUSTER}
      (canonical_slug, embedding_dim, embedding)
     VALUES (?, ?, ?)`,
    [slug, dim, buffer],
  );
  const clusterId = Number(result?.insertId || 0);
  if (!clusterId) {
    throw new Error('cluster_insert_failed');
  }

  const created = {
    id: clusterId,
    canonical_slug: slug,
    embedding: Array.isArray(embedding) ? embedding : [],
  };
  inMemoryClusterById.set(clusterId, created);
  inMemoryClusterList = {
    expiresAt: 0,
    items: [],
  };
  return created;
};

const generateEmbedding = async (text) => {
  const client = resolveOpenAIClient();
  if (!client) return null;

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const vector = response?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length) return null;
  const clean = vector.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  return clean.length ? clean : null;
};

const generateCanonicalSlug = async (suggestionText) => {
  const fallback = fallbackSlugFromSuggestion(suggestionText);
  const client = resolveOpenAIClient();
  if (!client) return fallback;

  try {
    const completion = await client.chat.completions.create({
      model: SLUG_MODEL,
      temperature: 0,
      max_tokens: 32,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Normalize short theme phrases into a canonical 1-2 word lowercase slug with underscores. Return JSON: {"slug":"..."}',
        },
        {
          role: 'user',
          content: String(suggestionText || ''),
        },
      ],
    });
    const content = String(completion?.choices?.[0]?.message?.content || '').trim();
    if (!content) return fallback;
    const parsed = JSON.parse(content);
    const slug = normalizeSlug(parsed?.slug);
    return slug || fallback;
  } catch {
    return fallback;
  }
};

const resolveClusterBySimilarity = async (embedding, threshold = SIMILARITY_THRESHOLD) => {
  const clusters = await listSemanticClusters();
  if (!clusters.length) return null;

  let best = null;
  for (const cluster of clusters) {
    const similarity = cosineSimilarity(embedding, cluster.embedding);
    if (similarity < threshold) continue;
    if (!best || similarity > best.similarity) {
      best = {
        id: cluster.id,
        canonical_slug: cluster.canonical_slug,
        similarity,
      };
    }
  }
  return best;
};

const resolveSemanticCluster = async (suggestionText) => {
  const normalizedSuggestion = normalizeSuggestion(suggestionText);
  if (!normalizedSuggestion) return null;
  if (!shouldRunSemanticClustering()) return null;

  const memoryCached = inMemorySuggestionCache.get(normalizedSuggestion);
  if (memoryCached && memoryCached.expiresAt > __timeNowMs()) {
    return memoryCached.value;
  }

  const dbCached = await getSuggestionCacheRow(normalizedSuggestion);
  if (dbCached?.semantic_cluster_id) {
    const payload = {
      semantic_cluster_id: dbCached.semantic_cluster_id,
      semantic_cluster_slug: normalizeSlug(dbCached.canonical_slug),
      similarity: dbCached.last_similarity,
      created: false,
      source: 'cache',
      suggestion: normalizedSuggestion,
    };
    inMemorySuggestionCache.set(normalizedSuggestion, {
      expiresAt: __timeNowMs() + RESOLUTION_CACHE_TTL_MS,
      value: payload,
    });
    return payload;
  }

  const embedding = await generateEmbedding(normalizedSuggestion);
  if (!embedding?.length) return null;

  const matched = await resolveClusterBySimilarity(embedding, SIMILARITY_THRESHOLD);
  if (matched?.id) {
    const payload = {
      semantic_cluster_id: matched.id,
      semantic_cluster_slug: normalizeSlug(matched.canonical_slug) || null,
      similarity: Number(matched.similarity.toFixed(6)),
      created: false,
      source: 'similarity',
      suggestion: normalizedSuggestion,
    };

    await upsertSuggestionCacheRow({
      suggestionText,
      normalizedText: normalizedSuggestion,
      semanticClusterId: payload.semantic_cluster_id,
      canonicalSlug: payload.semantic_cluster_slug,
      embedding,
      similarity: payload.similarity,
    });
    inMemorySuggestionCache.set(normalizedSuggestion, {
      expiresAt: __timeNowMs() + RESOLUTION_CACHE_TTL_MS,
      value: payload,
    });
    return payload;
  }

  const canonicalSlug = await generateCanonicalSlug(normalizedSuggestion);
  const createdCluster = await createSemanticCluster({
    canonicalSlug,
    embedding,
  });
  const payload = {
    semantic_cluster_id: createdCluster.id,
    semantic_cluster_slug: normalizeSlug(createdCluster.canonical_slug) || canonicalSlug,
    similarity: 1,
    created: true,
    source: 'new_cluster',
    suggestion: normalizedSuggestion,
  };
  await upsertSuggestionCacheRow({
    suggestionText,
    normalizedText: normalizedSuggestion,
    semanticClusterId: payload.semantic_cluster_id,
    canonicalSlug: payload.semantic_cluster_slug,
    embedding,
    similarity: 1,
  });
  inMemorySuggestionCache.set(normalizedSuggestion, {
    expiresAt: __timeNowMs() + RESOLUTION_CACHE_TTL_MS,
    value: payload,
  });
  return payload;
};

const pickPrimaryCluster = (matches) => {
  if (!Array.isArray(matches) || !matches.length) return null;
  const tally = new Map();
  for (const match of matches) {
    const id = Number(match?.semantic_cluster_id || 0);
    if (!id) continue;
    const current = tally.get(id) || {
      semantic_cluster_id: id,
      semantic_cluster_slug: normalizeSlug(match?.semantic_cluster_slug || '') || null,
      count: 0,
      best_similarity: -1,
    };
    current.count += 1;
    current.best_similarity = Math.max(current.best_similarity, Number(match?.similarity || 0));
    if (!current.semantic_cluster_slug && match?.semantic_cluster_slug) {
      current.semantic_cluster_slug = normalizeSlug(match.semantic_cluster_slug);
    }
    tally.set(id, current);
  }

  const ranked = Array.from(tally.values()).sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    if (right.best_similarity !== left.best_similarity) return right.best_similarity - left.best_similarity;
    return left.semantic_cluster_id - right.semantic_cluster_id;
  });
  return ranked[0] || null;
};

const sanitizeSuggestions = (values = []) => {
  const suggestions = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeSuggestion(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    suggestions.push(normalized);
    if (suggestions.length >= MAX_SUGGESTIONS_PER_ASSET) break;
  }
  return suggestions;
};

const resolveSuggestionsToPrimaryCluster = async ({ suggestions = [], fallbackText = '' } = {}) => {
  const normalizedSuggestions = sanitizeSuggestions(suggestions);
  if (!normalizedSuggestions.length && fallbackText) {
    normalizedSuggestions.push(normalizeSuggestion(fallbackText));
  }
  if (!normalizedSuggestions.length) return null;

  const matches = [];
  for (const suggestion of normalizedSuggestions) {
    const resolved = await resolveSemanticCluster(suggestion);
    if (resolved?.semantic_cluster_id) {
      matches.push(resolved);
    }
  }
  if (!matches.length) return null;

  const primary = pickPrimaryCluster(matches);
  if (!primary?.semantic_cluster_id) return null;

  return {
    semantic_cluster_id: primary.semantic_cluster_id,
    semantic_cluster_slug: primary.semantic_cluster_slug || fallbackSlugFromSuggestion(normalizedSuggestions[0] || ''),
    matches,
  };
};

const scheduleQueueDrain = () => {
  if (queueDrainScheduled) return;
  queueDrainScheduled = true;
  setImmediate(() => {
    queueDrainScheduled = false;
    void drainSemanticClusterQueue();
  });
};

const processSemanticClusterTask = async (task) => {
  const assetId = String(task?.assetId || '').trim();
  if (!assetId || !shouldRunSemanticClustering()) return;

  try {
    const current = await findStickerClassificationByAssetId(assetId);
    if (!current) return;
    if (current.semantic_cluster_id && !SEMANTIC_CLUSTER_REPROCESS_EXISTING && !task?.force) {
      return;
    }

    const result = await resolveSuggestionsToPrimaryCluster({
      suggestions: task?.suggestions || current.llm_pack_suggestions || [],
      fallbackText: task?.fallbackText || current.category || '',
    });
    if (!result?.semantic_cluster_id) return;

    await updateStickerClassificationSemanticCluster(assetId, {
      semanticClusterId: result.semantic_cluster_id,
      semanticClusterSlug: result.semantic_cluster_slug,
    });
  } catch (error) {
    logger.warn('Falha ao processar clusterização semântica de sugestão LLM.', {
      action: 'semantic_theme_cluster_task_failed',
      asset_id: assetId,
      error: error?.message,
    });
  }
};

const drainSemanticClusterQueue = async () => {
  while (queueRunning < CLUSTERING_CONCURRENCY && pendingTasksByAssetId.size > 0) {
    const firstEntry = pendingTasksByAssetId.entries().next().value;
    if (!firstEntry) break;
    const [assetId, task] = firstEntry;
    pendingTasksByAssetId.delete(assetId);
    queueRunning += 1;
    void processSemanticClusterTask(task)
      .catch(() => {})
      .finally(() => {
        queueRunning = Math.max(0, queueRunning - 1);
        scheduleQueueDrain();
      });
  }
};

export const enqueueSemanticClusterResolution = ({ assetId, suggestions = [], fallbackText = '', force = false } = {}) => {
  const normalizedAssetId = String(assetId || '').trim();
  if (!normalizedAssetId || !ENABLE_SEMANTIC_CLUSTERING) return false;

  pendingTasksByAssetId.set(normalizedAssetId, {
    assetId: normalizedAssetId,
    suggestions: sanitizeSuggestions(suggestions),
    fallbackText: String(fallbackText || '')
      .trim()
      .slice(0, 255),
    force: Boolean(force),
  });
  scheduleQueueDrain();
  return true;
};

export const semanticClusterConfig = {
  enabled: ENABLE_SEMANTIC_CLUSTERING,
  similarity_threshold: SIMILARITY_THRESHOLD,
  embedding_model: EMBEDDING_MODEL,
  slug_model: SLUG_MODEL,
  max_cluster_scan: MAX_CLUSTER_SCAN,
  queue_concurrency: CLUSTERING_CONCURRENCY,
};

export const isSemanticClusteringEnabled = () => ENABLE_SEMANTIC_CLUSTERING;
