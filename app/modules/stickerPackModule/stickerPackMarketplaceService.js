import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
const parseEnvList = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const VERIFIED_PUBLISHERS = new Set(parseEnvList(process.env.STICKER_CREATOR_VERIFIED_PUBLISHERS).map((entry) => entry.toLowerCase()));
const NSFW_EXPLICIT_THRESHOLD = Number.isFinite(Number(process.env.STICKER_NSFW_EXPLICIT_THRESHOLD)) ? Number(process.env.STICKER_NSFW_EXPLICIT_THRESHOLD) : 0.78;
const NSFW_SUGGESTIVE_THRESHOLD = Number.isFinite(Number(process.env.STICKER_NSFW_SUGGESTIVE_THRESHOLD)) ? Number(process.env.STICKER_NSFW_SUGGESTIVE_THRESHOLD) : 0.4;
const AGE_DECAY_DAYS = Math.max(1, Number(process.env.STICKER_PACK_AGE_DECAY_DAYS) || 45);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const safeNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeTag = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const buildVectorNorm = (vector) =>
  Math.sqrt(
    Object.values(vector || {})
      .map((value) => safeNumber(value))
      .reduce((sum, current) => sum + current * current, 0),
  );

const cosineSimilarity = (left, right) => {
  if (!left || !right) return 0;
  const leftKeys = Object.keys(left);
  if (!leftKeys.length || !Object.keys(right).length) return 0;

  const leftNorm = buildVectorNorm(left);
  const rightNorm = buildVectorNorm(right);
  if (leftNorm <= 0 || rightNorm <= 0) return 0;

  let dot = 0;
  for (const key of leftKeys) {
    dot += safeNumber(left[key]) * safeNumber(right[key]);
  }
  return clamp(dot / (leftNorm * rightNorm), 0, 1);
};

const resolveNsfwLevel = (packClassification) => {
  const nsfw = packClassification?.nsfw || {};
  const maxScore = safeNumber(nsfw.max_score);
  const avgScore = safeNumber(nsfw.avg_score);
  const flagged = safeNumber(nsfw.flagged_items) > 0;
  const reference = Math.max(maxScore, avgScore);
  if (reference >= NSFW_EXPLICIT_THRESHOLD) return 'explicit';
  if (reference >= NSFW_SUGGESTIVE_THRESHOLD || flagged) return 'suggestive';
  return 'safe';
};

const computeEngagementScore = (engagement) => {
  const opens = safeNumber(engagement?.open_count);
  const likes = safeNumber(engagement?.like_count);
  const dislikes = safeNumber(engagement?.dislike_count);
  if (!opens && !likes && !dislikes) return 0;
  const positive = likes * 2 + opens * 0.15;
  const negative = dislikes * 1.25;
  const raw = positive - negative;
  return Number(clamp(raw / 100, 0, 1.2).toFixed(6));
};

const computeTrendScore = (interactionStats, { horizonHours = 24, baselineDays = 7 } = {}) => {
  const openHorizon = safeNumber(interactionStats?.open_horizon);
  const openBaseline = safeNumber(interactionStats?.open_baseline);
  const horizonPer24h = horizonHours > 0 ? openHorizon * (24 / horizonHours) : openHorizon;
  const baselineDaily = baselineDays > 0 ? openBaseline / baselineDays : openBaseline;
  const denominator = Math.max(0.5, baselineDaily);
  const trend = horizonPer24h / denominator;
  return Number(clamp(trend, 0, 20).toFixed(6));
};

const computeQualityScore = ({ items = [], itemClassifications = [] }) => {
  if (!items.length) return 0;
  let sum = 0;

  for (const item of items) {
    const width = safeNumber(item?.asset?.width);
    const height = safeNumber(item?.asset?.height);
    const bytes = safeNumber(item?.asset?.size_bytes);
    const area = width > 0 && height > 0 ? width * height : 0;
    const areaScore = area > 0 ? clamp(area / (512 * 512), 0.2, 1) : 0.45;
    const sizeScore = bytes > 0 ? clamp(bytes / (18 * 1024), 0.25, 1) : 0.5;
    sum += areaScore * 0.65 + sizeScore * 0.35;
  }

  const baseQuality = sum / items.length;
  const classificationPenalty =
    itemClassifications.length > 0
      ? itemClassifications.reduce((acc, classification) => {
          const scores = classification?.all_scores || {};
          return acc + safeNumber(scores['blurry image']) * 0.3 + safeNumber(scores['low quality compressed image']) * 0.35;
        }, 0) / itemClassifications.length
      : 0;

  return Number(clamp(baseQuality - classificationPenalty, 0, 1).toFixed(6));
};

const computeDiversityScore = ({ tags = [], itemClassifications = [] }) => {
  if (!itemClassifications.length) return tags.length > 0 ? 0.45 : 0.25;

  const uniqueTags = new Set((Array.isArray(tags) ? tags : []).map((tag) => normalizeTag(tag)).filter(Boolean));
  let pairCount = 0;
  let similaritySum = 0;

  for (let i = 0; i < itemClassifications.length; i += 1) {
    for (let j = i + 1; j < itemClassifications.length; j += 1) {
      pairCount += 1;
      similaritySum += cosineSimilarity(itemClassifications[i]?.all_scores || {}, itemClassifications[j]?.all_scores || {});
    }
  }

  const avgSimilarity = pairCount > 0 ? similaritySum / pairCount : 0.5;
  const diversityFromSimilarity = clamp(1 - avgSimilarity, 0, 1);
  const diversityFromTags = clamp(uniqueTags.size / Math.max(3, Math.min(12, itemClassifications.length)), 0, 1);
  return Number((diversityFromSimilarity * 0.7 + diversityFromTags * 0.3).toFixed(6));
};

const computeCohesionScore = (itemClassifications = []) => {
  if (!Array.isArray(itemClassifications) || itemClassifications.length <= 1) return 1;
  let pairCount = 0;
  let similaritySum = 0;

  for (let i = 0; i < itemClassifications.length; i += 1) {
    for (let j = i + 1; j < itemClassifications.length; j += 1) {
      pairCount += 1;
      similaritySum += cosineSimilarity(itemClassifications[i]?.all_scores || {}, itemClassifications[j]?.all_scores || {});
    }
  }

  if (!pairCount) return 1;
  return Number(clamp(similaritySum / pairCount, 0, 1).toFixed(6));
};

const computeDuplicatePenalty = ({ itemClassifications = [], duplicateRate = 0 }) => {
  if (!itemClassifications.length) return 0;
  const vectors = itemClassifications.map((entry) => entry?.all_scores || {});
  let nearDuplicates = 0;
  let pairCount = 0;

  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      pairCount += 1;
      if (cosineSimilarity(vectors[i], vectors[j]) >= 0.985) {
        nearDuplicates += 1;
      }
    }
  }

  const semanticDuplicateRate = pairCount > 0 ? nearDuplicates / pairCount : 0;
  return Number(clamp(semanticDuplicateRate * 0.7 + safeNumber(duplicateRate) * 0.3, 0, 1).toFixed(6));
};

export const computePackSignals = ({ pack, engagement, packClassification, itemClassifications = [], interactionStats = null, duplicateRate = 0, scoringWeights = null, ageDecayDays = AGE_DECAY_DAYS }) => {
  const resolvedWeights = {
    classification: clamp(safeNumber(scoringWeights?.classification, 0.4), 0.1, 0.7),
    engagement: clamp(safeNumber(scoringWeights?.engagement, 0.3), 0.1, 0.7),
    quality: clamp(safeNumber(scoringWeights?.quality, 0.2), 0.05, 0.6),
    diversity: clamp(safeNumber(scoringWeights?.diversity, 0.1), 0.05, 0.4),
  };

  const classificationConfidence = clamp(safeNumber(packClassification?.confidence), 0, 1);
  const qualityScore = computeQualityScore({ items: pack?.items || [], itemClassifications });
  const engagementScore = computeEngagementScore(engagement);
  const diversityScore = computeDiversityScore({
    tags: packClassification?.tags || [],
    itemClassifications,
  });
  const cohesionScore = computeCohesionScore(itemClassifications);
  const duplicatePenalty = computeDuplicatePenalty({ itemClassifications, duplicateRate });
  const trendScore = computeTrendScore(interactionStats);
  const nsfwLevel = resolveNsfwLevel(packClassification);
  const sensitiveContent = nsfwLevel !== 'safe';
  const packScoreRaw = classificationConfidence * resolvedWeights.classification + engagementScore * resolvedWeights.engagement + qualityScore * resolvedWeights.quality + diversityScore * resolvedWeights.diversity - duplicatePenalty * 0.25;
  const packScore = Number(clamp(packScoreRaw, 0, 1.5).toFixed(6));
  const referenceDate = pack?.updated_at || pack?.created_at || null;
  const ageMs = referenceDate ? __timeNowMs() - Date.parse(referenceDate) : 0;
  const ageDays = Number.isFinite(ageMs) && ageMs > 0 ? ageMs / (24 * 60 * 60 * 1000) : 0;
  const decayWindow = Math.max(1, Number(ageDecayDays) || AGE_DECAY_DAYS);
  const ageDecayFactor = Number(Math.exp(-ageDays / decayWindow).toFixed(6));
  const rankingScore = Number((packScore * ageDecayFactor + trendScore * 0.08 + cohesionScore * 0.05).toFixed(6));

  return {
    classification_confidence: Number(classificationConfidence.toFixed(6)),
    quality_score: qualityScore,
    engagement_score: engagementScore,
    diversity_score: diversityScore,
    cohesion_score: cohesionScore,
    duplicate_penalty: duplicatePenalty,
    trend_score: trendScore,
    pack_score: packScore,
    ranking_score: rankingScore,
    age_decay_factor: ageDecayFactor,
    age_decay_days: decayWindow,
    trending_now: trendScore >= 1.4,
    nsfw_level: nsfwLevel,
    sensitive_content: sensitiveContent,
    scoring_weights: resolvedWeights,
  };
};

const sortByScoreDesc = (list, field) => [...list].sort((left, right) => safeNumber(right?.signals?.[field]) - safeNumber(left?.signals?.[field]));

const sortByUpdatedDesc = (list) =>
  [...list].sort((left, right) => {
    const leftTime = Date.parse(left?.pack?.updated_at || 0);
    const rightTime = Date.parse(right?.pack?.updated_at || 0);
    return rightTime - leftTime;
  });

export const buildIntentCollections = (entries, { limit = 18 } = {}) => {
  const safeLimit = Math.max(4, Math.min(50, Number(limit) || 18));
  const safeOnly = entries.filter((entry) => entry?.signals?.nsfw_level === 'safe');
  const all = entries;
  const pick = (list) => list.slice(0, safeLimit);

  return {
    em_alta: pick(sortByScoreDesc(safeOnly, 'ranking_score')),
    novos: pick(sortByUpdatedDesc(safeOnly)),
    crescendo_agora: pick(
      sortByScoreDesc(
        all.filter((entry) => entry?.signals?.trending_now),
        'trend_score',
      ),
    ),
    mais_curtidos: pick([...safeOnly].sort((a, b) => safeNumber(b?.engagement?.like_count) - safeNumber(a?.engagement?.like_count))),
    melhor_avaliados: pick([...safeOnly].sort((a, b) => safeNumber(b?.engagement?.like_count) - safeNumber(b?.engagement?.dislike_count) - (safeNumber(a?.engagement?.like_count) - safeNumber(a?.engagement?.dislike_count)))),
  };
};

export const buildCreatorRanking = (entries, { limit = 50 } = {}) => {
  const safeLimit = Math.max(5, Math.min(200, Number(limit) || 50));
  const grouped = new Map();

  for (const entry of entries) {
    const publisher = String(entry?.pack?.publisher || '').trim() || 'Unknown';
    const key = publisher.toLowerCase();
    const current = grouped.get(key) || {
      publisher,
      verified: VERIFIED_PUBLISHERS.has(key),
      packs_count: 0,
      total_likes: 0,
      total_opens: 0,
      avg_pack_score: 0,
      top_pack: null,
    };
    current.packs_count += 1;
    current.total_likes += safeNumber(entry?.engagement?.like_count);
    current.total_opens += safeNumber(entry?.engagement?.open_count);
    current.avg_pack_score += safeNumber(entry?.signals?.pack_score);
    if (!current.top_pack || safeNumber(entry?.signals?.pack_score) > safeNumber(current?.top_pack?.signals?.pack_score)) {
      current.top_pack = entry;
    }
    grouped.set(key, current);
  }

  const ranking = Array.from(grouped.values())
    .map((entry) => ({
      ...entry,
      avg_pack_score: Number((entry.avg_pack_score / Math.max(1, entry.packs_count)).toFixed(6)),
    }))
    .sort((left, right) => {
      const leftScore = left.avg_pack_score * 0.45 + left.total_likes * 0.0008 + left.total_opens * 0.00015;
      const rightScore = right.avg_pack_score * 0.45 + right.total_likes * 0.0008 + right.total_opens * 0.00015;
      return rightScore - leftScore;
    })
    .slice(0, safeLimit);

  return ranking;
};

export const buildViewerTagAffinity = ({ viewerEntries = [], packClassificationById = new Map() }) => {
  const affinity = new Map();
  for (const viewerEntry of viewerEntries) {
    const summary = packClassificationById.get(viewerEntry.pack_id);
    const tags = Array.isArray(summary?.tags) ? summary.tags : [];
    const weight = Math.max(1, safeNumber(viewerEntry.interactions));
    for (const rawTag of tags) {
      const tag = normalizeTag(rawTag);
      if (!tag) continue;
      affinity.set(tag, (affinity.get(tag) || 0) + weight);
    }
  }
  return affinity;
};

export const buildPersonalizedRecommendations = ({ entries = [], viewerAffinity = new Map(), excludePackIds = new Set(), limit = 18 }) => {
  const safeLimit = Math.max(4, Math.min(50, Number(limit) || 18));
  const ranked = [];
  for (const entry of entries) {
    const packId = entry?.pack?.id;
    if (!packId || excludePackIds.has(packId)) continue;
    if (entry?.signals?.nsfw_level !== 'safe') continue;

    const tags = Array.isArray(entry?.packClassification?.tags) ? entry.packClassification.tags : [];
    const affinityBoost = tags.reduce((sum, rawTag) => sum + safeNumber(viewerAffinity.get(normalizeTag(rawTag))), 0);
    const score = safeNumber(entry?.signals?.pack_score) * 0.7 + affinityBoost * 0.04 + safeNumber(entry?.signals?.trend_score) * 0.2;
    ranked.push({ entry, score });
  }

  ranked.sort((left, right) => right.score - left.score);
  return ranked.slice(0, safeLimit).map((item) => item.entry);
};
