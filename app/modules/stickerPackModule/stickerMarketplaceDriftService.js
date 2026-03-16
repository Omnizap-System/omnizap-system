import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { listClassificationCategoryDistribution } from './stickerAssetClassificationRepository.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const REFRESH_MS = Math.max(30_000, Number(process.env.STICKER_DRIFT_REFRESH_MS) || 10 * 60 * 1000);
const DIVERGENCE_SENSITIVITY = clamp(Number(process.env.STICKER_DRIFT_SENSITIVITY || 1), 0.5, 2.5);

const BASE_WEIGHTS = Object.freeze({
  classification: 0.4,
  engagement: 0.3,
  quality: 0.2,
  diversity: 0.1,
});

let cache = {
  expiresAt: 0,
  weights: BASE_WEIGHTS,
  driftScore: 0,
  distribution7d: {},
  distribution30d: {},
};

const toProbabilityMap = (distribution) => {
  const total = Number(distribution?.total || 0);
  const categories = distribution?.categories instanceof Map ? distribution.categories : new Map();
  const map = new Map();
  if (!total || categories.size === 0) return map;

  for (const [category, count] of categories.entries()) {
    const probability = Number(count) / total;
    if (probability > 0) {
      map.set(category, probability);
    }
  }
  return map;
};

const computeL1Divergence = (left, right) => {
  const keys = new Set([...left.keys(), ...right.keys()]);
  if (!keys.size) return 0;

  let sumAbs = 0;
  for (const key of keys) {
    sumAbs += Math.abs((left.get(key) || 0) - (right.get(key) || 0));
  }

  return clamp(sumAbs / 2, 0, 1);
};

const normalizeWeights = (weights) => {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (!total || !Number.isFinite(total)) return BASE_WEIGHTS;
  return {
    classification: Number((weights.classification / total).toFixed(6)),
    engagement: Number((weights.engagement / total).toFixed(6)),
    quality: Number((weights.quality / total).toFixed(6)),
    diversity: Number((weights.diversity / total).toFixed(6)),
  };
};

const buildDynamicWeights = (driftScore) => {
  const adjustedDrift = clamp(driftScore * DIVERGENCE_SENSITIVITY, 0, 1);
  const classificationShift = clamp(BASE_WEIGHTS.classification - adjustedDrift * 0.1, 0.25, 0.45);
  const engagementShift = clamp(BASE_WEIGHTS.engagement + adjustedDrift * 0.08, 0.25, 0.42);
  const qualityShift = clamp(BASE_WEIGHTS.quality + adjustedDrift * 0.01, 0.15, 0.3);
  const diversityShift = clamp(BASE_WEIGHTS.diversity + adjustedDrift * 0.01, 0.08, 0.2);
  return normalizeWeights({
    classification: classificationShift,
    engagement: engagementShift,
    quality: qualityShift,
    diversity: diversityShift,
  });
};

export const getBaseMarketplaceWeights = () => BASE_WEIGHTS;

export const getMarketplaceDriftSnapshot = async ({ force = false } = {}) => {
  const now = __timeNowMs();
  if (!force && now < cache.expiresAt) {
    return cache;
  }

  const [distribution7d, distribution30d] = await Promise.all([listClassificationCategoryDistribution({ days: 7 }), listClassificationCategoryDistribution({ days: 30 })]);

  const probability7d = toProbabilityMap(distribution7d);
  const probability30d = toProbabilityMap(distribution30d);
  const driftScore = Number(computeL1Divergence(probability7d, probability30d).toFixed(6));
  const weights = buildDynamicWeights(driftScore);

  cache = {
    expiresAt: now + REFRESH_MS,
    weights,
    driftScore,
    distribution7d: Object.fromEntries(probability7d.entries()),
    distribution30d: Object.fromEntries(probability30d.entries()),
  };

  return cache;
};
