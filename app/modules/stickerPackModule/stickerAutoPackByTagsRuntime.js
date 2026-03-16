import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { getActiveSocket } from '../../config/index.js';
import { normalizeJid, resolveBotJid } from '../../config/index.js';
import { recordStickerAutoPackCycle } from '../../observability/metrics.js';
import stickerPackService from './stickerPackServiceRuntime.js';
import { countClassifiedStickerAssetsWithoutPack, listClassifiedStickerAssetsForCuration } from './stickerAssetRepository.js';
import { listClipImageEmbeddingsByImageHashes, listStickerClassificationsByAssetIds } from './stickerAssetClassificationRepository.js';
import { decorateStickerClassification, submitStickerClassificationFeedback } from './stickerClassificationService.js';
import { findStickerPackById, listStickerAutoPacksForCuration, listStickerPacksByOwner, softDeleteStickerPack, updateStickerPackFields } from './stickerPackRepository.js';
import { listStickerPackItems, listStickerPackItemsByPackIds, removeStickerPackItemsByPackId } from './stickerPackItemRepository.js';
import { listStickerPackEngagementByPackIds } from './stickerPackEngagementRepository.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};
const parseMaxPacksPerOwnerLimit = (value, fallback = 50) => {
  if (value === undefined || value === null || value === '') {
    return Math.max(1, Number(fallback) || 50);
  }
  const normalized = String(value).trim().toLowerCase();
  if (['0', '-1', 'inf', 'infinity', 'unlimited', 'sem-limite'].includes(normalized)) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Number(normalized);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.max(1, Math.floor(parsed));
  }
  return Math.max(1, Number(fallback) || 50);
};

const AUTO_ENABLED = parseEnvBool(process.env.STICKER_AUTO_PACK_BY_TAGS_ENABLED, true);
const STARTUP_DELAY_MS = Math.max(1_000, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_STARTUP_DELAY_MS) || 20_000);
const LEGACY_INTERVAL_MS = Number(process.env.STICKER_AUTO_PACK_BY_TAGS_INTERVAL_MS);
const INTERVAL_MIN_MS_RAW = Number(process.env.STICKER_AUTO_PACK_BY_TAGS_INTERVAL_MIN_MS);
const INTERVAL_MAX_MS_RAW = Number(process.env.STICKER_AUTO_PACK_BY_TAGS_INTERVAL_MAX_MS);
const DEFAULT_INTERVAL_MIN_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MAX_MS = 10 * 60_000;
const INTERVAL_MIN_MS = Number.isFinite(INTERVAL_MIN_MS_RAW) ? Math.max(60_000, Math.min(3_600_000, INTERVAL_MIN_MS_RAW)) : DEFAULT_INTERVAL_MIN_MS;
const INTERVAL_MAX_MS_FROM_ENV = Number.isFinite(INTERVAL_MAX_MS_RAW) ? Math.max(60_000, Math.min(3_600_000, INTERVAL_MAX_MS_RAW)) : DEFAULT_INTERVAL_MAX_MS;
const INTERVAL_MAX_MS = Math.max(INTERVAL_MIN_MS, INTERVAL_MAX_MS_FROM_ENV);
const LEGACY_FIXED_INTERVAL_MS = Number.isFinite(LEGACY_INTERVAL_MS) && LEGACY_INTERVAL_MS > 0 ? Math.max(60_000, Math.min(3_600_000, LEGACY_INTERVAL_MS)) : null;
const EFFECTIVE_INTERVAL_MIN_MS = LEGACY_FIXED_INTERVAL_MS || INTERVAL_MIN_MS;
const EFFECTIVE_INTERVAL_MAX_MS = LEGACY_FIXED_INTERVAL_MS || INTERVAL_MAX_MS;
const TARGET_PACK_SIZE = Math.max(5, Math.min(30, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_TARGET_SIZE) || 30));
const MIN_GROUP_SIZE = Math.max(3, Math.min(100, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MIN_GROUP_SIZE) || 8));
const MAX_TAG_GROUPS = Math.max(0, Math.min(500, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_GROUPS) || 0));
const ENABLE_SEMANTIC_CLUSTERING = parseEnvBool(process.env.ENABLE_SEMANTIC_CLUSTERING, false);
const MAX_SCAN_ASSETS = Math.max(0, Math.min(250_000, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_SCAN_ASSETS) || 0));
const MAX_ADDITIONS_PER_CYCLE = Math.max(10, Math.min(2000, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_ADDITIONS_PER_CYCLE) || 300));
const AUTO_PACK_VISIBILITY =
  String(process.env.STICKER_AUTO_PACK_BY_TAGS_VISIBILITY || 'public')
    .trim()
    .toLowerCase() || 'public';
const AUTO_PUBLISHER = String(process.env.STICKER_AUTO_PACK_BY_TAGS_PUBLISHER || 'OmniZap Auto').trim() || 'OmniZap Auto';
const TOP_TAGS_PER_ASSET = Math.max(1, Math.min(5, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_TOP_TAGS_PER_ASSET) || 3));
const SCAN_PASSES = Math.max(1, Math.min(9, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_SCAN_PASSES) || 3));
const SCAN_PASS_JITTER_PERCENT = Math.max(0, Math.min(35, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_SCAN_PASS_JITTER_PERCENT) || 15));
const STABILITY_Z_SCORE = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_STABILITY_Z_SCORE)) ? Math.max(0, Math.min(3.5, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_STABILITY_Z_SCORE))) : 1.282;
const MIN_ASSET_ACCEPTANCE_RATE = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MIN_ASSET_ACCEPTANCE_RATE)) ? Math.max(0, Math.min(1, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MIN_ASSET_ACCEPTANCE_RATE))) : 0.5;
const MIN_THEME_DOMINANCE_RATIO = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MIN_THEME_DOMINANCE_RATIO)) ? Math.max(0, Math.min(1, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MIN_THEME_DOMINANCE_RATIO))) : 0.55;
const SCORE_STDDEV_PENALTY = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_SCORE_STDDEV_PENALTY)) ? Math.max(0, Math.min(1.2, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_SCORE_STDDEV_PENALTY))) : 0.18;
const NSFW_THRESHOLD = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_NSFW_THRESHOLD)) ? Number(process.env.STICKER_AUTO_PACK_BY_TAGS_NSFW_THRESHOLD) : 0.7;
const NSFW_SUGGESTIVE_THRESHOLD = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_NSFW_SUGGESTIVE_THRESHOLD)) ? Number(process.env.STICKER_AUTO_PACK_BY_TAGS_NSFW_SUGGESTIVE_THRESHOLD) : 0.4;
const NSFW_EXPLICIT_THRESHOLD = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_NSFW_EXPLICIT_THRESHOLD)) ? Number(process.env.STICKER_AUTO_PACK_BY_TAGS_NSFW_EXPLICIT_THRESHOLD) : 0.78;
const MIN_ASSET_EDGE = Math.max(32, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MIN_ASSET_EDGE) || 192);
const MIN_ASSET_AREA = Math.max(32 * 32, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MIN_ASSET_AREA) || 192 * 192);
const MIN_ASSET_BYTES = Math.max(512, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MIN_ASSET_BYTES) || 6 * 1024);
const MAX_BLURRY_SCORE = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_BLURRY_SCORE)) ? Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_BLURRY_SCORE) : 0.82;
const MAX_LOW_QUALITY_SCORE = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_LOW_QUALITY_SCORE)) ? Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_LOW_QUALITY_SCORE) : 0.82;
const REBUILD_ENABLED = parseEnvBool(process.env.STICKER_AUTO_PACK_BY_TAGS_REBUILD_ENABLED, true);
const INCLUDE_PACKED_WHEN_REBUILD_DISABLED = parseEnvBool(process.env.STICKER_AUTO_PACK_BY_TAGS_INCLUDE_PACKED_WHEN_REBUILD_DISABLED, false);
const MAX_REMOVALS_PER_CYCLE = Math.max(0, Math.min(500, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_REMOVALS_PER_CYCLE) || 120));
const DEDUPE_SIMILARITY_THRESHOLD = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_DEDUPE_SIMILARITY_THRESHOLD)) ? Number(process.env.STICKER_AUTO_PACK_BY_TAGS_DEDUPE_SIMILARITY_THRESHOLD) : 0.985;
const COHESION_REBUILD_THRESHOLD = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_COHESION_REBUILD_THRESHOLD)) ? Number(process.env.STICKER_AUTO_PACK_BY_TAGS_COHESION_REBUILD_THRESHOLD) : 0.56;
const MOVE_OUT_THEME_SCORE_THRESHOLD = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MOVE_OUT_THRESHOLD)) ? Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MOVE_OUT_THRESHOLD) : 0.22;
const MOVE_IN_THEME_SCORE_THRESHOLD = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MOVE_IN_THRESHOLD)) ? Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MOVE_IN_THRESHOLD) : 0.12;
const ENTROPY_THRESHOLD = Number.isFinite(Number(process.env.ENTROPY_THRESHOLD)) ? Number(process.env.ENTROPY_THRESHOLD) : 2.5;
const ENTROPY_NORMALIZED_THRESHOLD = Number.isFinite(Number(process.env.ENTROPY_NORMALIZED_THRESHOLD)) ? Math.max(0, Math.min(1, Number(process.env.ENTROPY_NORMALIZED_THRESHOLD))) : 0.76;
const ENTROPY_WEIGHT = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ENTROPY_WEIGHT)) ? Math.max(0, Math.min(1.5, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ENTROPY_WEIGHT))) : 0.09;
const AMBIGUOUS_FLAG_PENALTY = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_AMBIGUOUS_FLAG_PENALTY)) ? Math.max(0, Math.min(0.5, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_AMBIGUOUS_FLAG_PENALTY))) : 0.06;
const ADAPTIVE_BONUS_WEIGHT = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ADAPTIVE_BONUS_WEIGHT)) ? Math.max(0, Math.min(1.2, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ADAPTIVE_BONUS_WEIGHT))) : 0.18;
const MARGIN_BONUS_WEIGHT = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MARGIN_BONUS_WEIGHT)) ? Math.max(0, Math.min(1.2, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MARGIN_BONUS_WEIGHT))) : 0.12;
const SIMILAR_IMAGES_PENALTY_WEIGHT = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_SIMILAR_IMAGES_PENALTY_WEIGHT)) ? Math.max(0, Math.min(1.2, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_SIMILAR_IMAGES_PENALTY_WEIGHT))) : 0.08;
const LLM_TRAIT_WEIGHT = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_LLM_TRAIT_WEIGHT)) ? Math.max(0, Math.min(0.6, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_LLM_TRAIT_WEIGHT))) : 0.1;
const ASSET_QUALITY_W1 = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ASSET_QUALITY_W1)) ? Math.max(0, Math.min(2, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ASSET_QUALITY_W1))) : 0.34;
const ASSET_QUALITY_W2 = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ASSET_QUALITY_W2)) ? Math.max(0, Math.min(2, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ASSET_QUALITY_W2))) : 0.24;
const ASSET_QUALITY_W3 = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ASSET_QUALITY_W3)) ? Math.max(0, Math.min(2, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ASSET_QUALITY_W3))) : 0.18;
const ASSET_QUALITY_W4 = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ASSET_QUALITY_W4)) ? Math.max(0, Math.min(2, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_ASSET_QUALITY_W4))) : 0.24;
const AFFINITY_WEIGHT_CAP = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_AFFINITY_CAP)) ? Math.max(0, Math.min(1, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_AFFINITY_CAP))) : 0.85;
const ENABLE_AFFINITY_LOG_SCALING = parseEnvBool(process.env.STICKER_AUTO_PACK_BY_TAGS_ENABLE_AFFINITY_LOG_SCALING, true);
const AFFINITY_LOG_SCALE = Number.isFinite(Number(process.env.STICKER_AUTO_PACK_BY_TAGS_AFFINITY_LOG_SCALE)) ? Math.max(0.1, Math.min(20, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_AFFINITY_LOG_SCALE))) : 4;
const REVIEW_SAMPLE_PERCENT = Math.max(0, Math.min(100, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_RECHECK_SAMPLE_PERCENT) || 5));
const REVIEW_VERSION_TARGET = String(process.env.STICKER_AUTO_PACK_BY_TAGS_REVIEW_CLASSIFICATION_VERSION || '').trim();
const CURATION_OWNERS_POOL_RAW = String(process.env.CURATION_OWNERS_POOL || process.env.STICKER_AUTO_PACK_CURATION_OWNERS_POOL || '').trim();
const MAX_PACKS_PER_OWNER = parseMaxPacksPerOwnerLimit(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_PACKS_PER_OWNER || process.env.STICKER_PACK_MAX_PACKS_PER_OWNER, 50);
const HARD_MIN_GROUP_SIZE = Math.max(3, Math.min(TARGET_PACK_SIZE, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_HARD_MIN_GROUP_SIZE) || 12));
const SEMANTIC_CLUSTER_MIN_SIZE_FOR_PACK = Math.max(HARD_MIN_GROUP_SIZE, Math.min(TARGET_PACK_SIZE, Number(process.env.SEMANTIC_CLUSTER_MIN_SIZE_FOR_PACK) || HARD_MIN_GROUP_SIZE));
const EFFECTIVE_HARD_MIN_GROUP_SIZE = ENABLE_SEMANTIC_CLUSTERING ? Math.max(HARD_MIN_GROUP_SIZE, SEMANTIC_CLUSTER_MIN_SIZE_FOR_PACK) : HARD_MIN_GROUP_SIZE;
const HARD_MIN_PACK_ITEMS = Math.max(1, Math.min(TARGET_PACK_SIZE, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_HARD_MIN_PACK_ITEMS) || 12));
const READY_PACK_MIN_ITEMS = Math.max(HARD_MIN_PACK_ITEMS, Math.min(TARGET_PACK_SIZE, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_READY_MIN_ITEMS) || 20));
const MAX_PACKS_PER_THEME = Math.max(1, Math.min(10, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_MAX_PACKS_PER_THEME) || 1));
const GLOBAL_AUTO_PACK_LIMIT = Math.max(10, Math.min(10_000, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_GLOBAL_PACK_LIMIT) || 300));
const DYNAMIC_GROUP_LIMIT_BASE = Math.max(3, Math.min(500, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_DYNAMIC_GROUP_LIMIT_BASE) || 30));
const RETRO_CONSOLIDATION_ENABLED = parseEnvBool(process.env.STICKER_AUTO_PACK_BY_TAGS_RETRO_CONSOLIDATION_ENABLED, true);
const RETRO_CONSOLIDATION_THEME_LIMIT = Math.max(1, Math.min(2000, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_RETRO_CONSOLIDATION_THEME_LIMIT) || 1000));
const RETRO_CONSOLIDATION_MUTATION_LIMIT = Math.max(10, Math.min(10_000, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_RETRO_CONSOLIDATION_MUTATION_LIMIT) || 2000));
const PRIORITIZE_COMPLETION = parseEnvBool(process.env.STICKER_AUTO_PACK_BY_TAGS_PRIORITIZE_COMPLETION, true);
const COMPLETION_TRANSFER_ENABLED = parseEnvBool(process.env.STICKER_AUTO_PACK_BY_TAGS_COMPLETION_TRANSFER_ENABLED, true);
const COMPLETION_TRANSFER_MIN_DONOR_ITEMS = Math.max(1, Math.min(TARGET_PACK_SIZE - 1, Number(process.env.STICKER_AUTO_PACK_BY_TAGS_COMPLETION_TRANSFER_MIN_DONOR_ITEMS) || Math.max(2, Math.min(TARGET_PACK_SIZE - 1, 8))));
const ENABLE_GLOBAL_OPTIMIZATION = parseEnvBool(process.env.ENABLE_GLOBAL_OPTIMIZATION, true);
const OPTIMIZATION_CYCLES = Math.max(1, Math.min(8, Number(process.env.OPTIMIZATION_CYCLES) || 3));
const OPTIMIZATION_EPSILON = Number.isFinite(Number(process.env.OPTIMIZATION_EPSILON)) ? Math.max(0.000001, Math.min(0.5, Number(process.env.OPTIMIZATION_EPSILON))) : 0.001;
const OPTIMIZATION_STABLE_CYCLES = Math.max(1, Math.min(5, Number(process.env.OPTIMIZATION_STABLE_CYCLES) || 2));
const TRANSFER_THRESHOLD = Number.isFinite(Number(process.env.TRANSFER_THRESHOLD)) ? Math.max(-0.2, Math.min(1, Number(process.env.TRANSFER_THRESHOLD))) : 0.02;
const MERGE_THRESHOLD = Number.isFinite(Number(process.env.MERGE_THRESHOLD)) ? Math.max(0, Math.min(1, Number(process.env.MERGE_THRESHOLD))) : 0.75;
const MIN_PACK_SIZE = Math.max(1, Math.min(TARGET_PACK_SIZE, Number(process.env.MIN_PACK_SIZE) || 8));
const AUTO_ARCHIVE_BELOW_PERCENTILE = Number.isFinite(Number(process.env.AUTO_ARCHIVE_BELOW_PERCENTILE)) ? Math.max(0, Math.min(100, Number(process.env.AUTO_ARCHIVE_BELOW_PERCENTILE))) : 20;
const SYSTEM_REDUNDANCY_LAMBDA = Number.isFinite(Number(process.env.SYSTEM_REDUNDANCY_LAMBDA)) ? Math.max(0, Math.min(2, Number(process.env.SYSTEM_REDUNDANCY_LAMBDA))) : 0.2;
const MATRIX_ALPHA = Number.isFinite(Number(process.env.STICKER_MATRIX_ALPHA)) ? Math.max(0, Math.min(3, Number(process.env.STICKER_MATRIX_ALPHA))) : 0.38;
const MATRIX_BETA = Number.isFinite(Number(process.env.STICKER_MATRIX_BETA)) ? Math.max(0, Math.min(3, Number(process.env.STICKER_MATRIX_BETA))) : 0.27;
const MATRIX_GAMMA = Number.isFinite(Number(process.env.STICKER_MATRIX_GAMMA)) ? Math.max(0, Math.min(3, Number(process.env.STICKER_MATRIX_GAMMA))) : 0.23;
const MATRIX_DELTA = Number.isFinite(Number(process.env.STICKER_MATRIX_DELTA)) ? Math.max(0, Math.min(3, Number(process.env.STICKER_MATRIX_DELTA))) : 0.18;
const PACK_QUALITY_W1 = Number.isFinite(Number(process.env.PACK_QUALITY_W1)) ? Math.max(0, Math.min(3, Number(process.env.PACK_QUALITY_W1))) : 0.32;
const PACK_QUALITY_W2 = Number.isFinite(Number(process.env.PACK_QUALITY_W2)) ? Math.max(0, Math.min(3, Number(process.env.PACK_QUALITY_W2))) : 0.24;
const PACK_QUALITY_W3 = Number.isFinite(Number(process.env.PACK_QUALITY_W3)) ? Math.max(0, Math.min(3, Number(process.env.PACK_QUALITY_W3))) : 0.16;
const PACK_QUALITY_W4 = Number.isFinite(Number(process.env.PACK_QUALITY_W4)) ? Math.max(0, Math.min(3, Number(process.env.PACK_QUALITY_W4))) : 0.14;
const PACK_QUALITY_W5 = Number.isFinite(Number(process.env.PACK_QUALITY_W5)) ? Math.max(0, Math.min(3, Number(process.env.PACK_QUALITY_W5))) : 0.09;
const PACK_QUALITY_W6 = Number.isFinite(Number(process.env.PACK_QUALITY_W6)) ? Math.max(0, Math.min(3, Number(process.env.PACK_QUALITY_W6))) : 0.07;
const MIGRATION_CANDIDATE_LIMIT = Number.isFinite(Number(process.env.MIGRATION_CANDIDATE_LIMIT)) ? Math.max(4, Math.min(64, Number(process.env.MIGRATION_CANDIDATE_LIMIT))) : 16;
const TRANSFER_CANDIDATE_SIMILARITY_FLOOR = Number.isFinite(Number(process.env.TRANSFER_CANDIDATE_SIMILARITY_FLOOR)) ? Math.max(0, Math.min(1, Number(process.env.TRANSFER_CANDIDATE_SIMILARITY_FLOOR))) : 0.35;
const INTER_PACK_SIMILARITY_THRESHOLD = Number.isFinite(Number(process.env.INTER_PACK_SIMILARITY_THRESHOLD)) ? Math.max(0, Math.min(1, Number(process.env.INTER_PACK_SIMILARITY_THRESHOLD))) : 0.85;
const PACK_TIER_QUALITY_W1 = Number.isFinite(Number(process.env.PACK_TIER_QUALITY_W1)) ? Math.max(0, Math.min(1, Number(process.env.PACK_TIER_QUALITY_W1))) : 0.4;
const PACK_TIER_QUALITY_W2 = Number.isFinite(Number(process.env.PACK_TIER_QUALITY_W2)) ? Math.max(0, Math.min(1, Number(process.env.PACK_TIER_QUALITY_W2))) : 0.25;
const PACK_TIER_QUALITY_W3 = Number.isFinite(Number(process.env.PACK_TIER_QUALITY_W3)) ? Math.max(0, Math.min(1, Number(process.env.PACK_TIER_QUALITY_W3))) : 0.15;
const PACK_TIER_QUALITY_W4 = Number.isFinite(Number(process.env.PACK_TIER_QUALITY_W4)) ? Math.max(0, Math.min(1, Number(process.env.PACK_TIER_QUALITY_W4))) : 0.1;
const PACK_TIER_QUALITY_W5 = Number.isFinite(Number(process.env.PACK_TIER_QUALITY_W5)) ? Math.max(0, Math.min(1, Number(process.env.PACK_TIER_QUALITY_W5))) : 0.1;
const AUTO_PACK_PROFILE = String(process.env.AUTO_PACK_PROFILE || 'BALANCED')
  .trim()
  .toUpperCase();
const IS_AGGRESSIVE_PROFILE = AUTO_PACK_PROFILE === 'AGGRESSIVE';
const AGGRESSIVE_MIGRATION_THRESHOLD = Number.isFinite(Number(process.env.AGGRESSIVE_MIGRATION_THRESHOLD)) ? Math.max(-0.1, Math.min(1, Number(process.env.AGGRESSIVE_MIGRATION_THRESHOLD))) : 0.01;
const ARCHIVE_LOW_SCORE_PACKS = parseEnvBool(process.env.ARCHIVE_LOW_SCORE_PACKS, IS_AGGRESSIVE_PROFILE);
const GLOBAL_ENERGY_W1 = Number.isFinite(Number(process.env.GLOBAL_ENERGY_W1)) ? Math.max(0, Math.min(2, Number(process.env.GLOBAL_ENERGY_W1))) : 0.4;
const GLOBAL_ENERGY_W2 = Number.isFinite(Number(process.env.GLOBAL_ENERGY_W2)) ? Math.max(0, Math.min(2, Number(process.env.GLOBAL_ENERGY_W2))) : 0.25;
const GLOBAL_ENERGY_W3 = Number.isFinite(Number(process.env.GLOBAL_ENERGY_W3)) ? Math.max(0, Math.min(2, Number(process.env.GLOBAL_ENERGY_W3))) : 0.1;
const GLOBAL_ENERGY_W4 = Number.isFinite(Number(process.env.GLOBAL_ENERGY_W4)) ? Math.max(0, Math.min(2, Number(process.env.GLOBAL_ENERGY_W4))) : 0.15;
const GLOBAL_ENERGY_W5 = Number.isFinite(Number(process.env.GLOBAL_ENERGY_W5)) ? Math.max(0, Math.min(2, Number(process.env.GLOBAL_ENERGY_W5))) : 0.1;
const PACK_TIER_GOLD_THRESHOLD = Number.isFinite(Number(process.env.PACK_TIER_GOLD_THRESHOLD)) ? Math.max(0, Math.min(2, Number(process.env.PACK_TIER_GOLD_THRESHOLD))) : 0.8;
const PACK_TIER_SILVER_THRESHOLD = Number.isFinite(Number(process.env.PACK_TIER_SILVER_THRESHOLD)) ? Math.max(0, Math.min(PACK_TIER_GOLD_THRESHOLD, Number(process.env.PACK_TIER_SILVER_THRESHOLD))) : 0.65;
const PACK_TIER_BRONZE_THRESHOLD = Number.isFinite(Number(process.env.PACK_TIER_BRONZE_THRESHOLD)) ? Math.max(0, Math.min(PACK_TIER_SILVER_THRESHOLD, Number(process.env.PACK_TIER_BRONZE_THRESHOLD))) : 0.5;

const EFFECTIVE_MIN_ASSET_ACCEPTANCE_RATE = IS_AGGRESSIVE_PROFILE ? Math.max(0.3, MIN_ASSET_ACCEPTANCE_RATE * 0.82) : MIN_ASSET_ACCEPTANCE_RATE;
const EFFECTIVE_MIN_THEME_DOMINANCE_RATIO = IS_AGGRESSIVE_PROFILE ? Math.max(0.35, MIN_THEME_DOMINANCE_RATIO * 0.82) : MIN_THEME_DOMINANCE_RATIO;
const EFFECTIVE_SCORE_STDDEV_PENALTY = IS_AGGRESSIVE_PROFILE ? Math.max(0.05, SCORE_STDDEV_PENALTY * 0.82) : SCORE_STDDEV_PENALTY;
const EFFECTIVE_TRANSFER_THRESHOLD = IS_AGGRESSIVE_PROFILE ? Math.min(TRANSFER_THRESHOLD, AGGRESSIVE_MIGRATION_THRESHOLD) : TRANSFER_THRESHOLD;
const EFFECTIVE_MERGE_THRESHOLD = IS_AGGRESSIVE_PROFILE ? Math.max(MERGE_THRESHOLD, 0.85) : MERGE_THRESHOLD;
const EFFECTIVE_INTER_PACK_SIMILARITY_THRESHOLD = Math.max(EFFECTIVE_MERGE_THRESHOLD, INTER_PACK_SIMILARITY_THRESHOLD);
const EFFECTIVE_AUTO_ARCHIVE_BELOW_PERCENTILE = ARCHIVE_LOW_SCORE_PACKS && IS_AGGRESSIVE_PROFILE ? Math.max(AUTO_ARCHIVE_BELOW_PERCENTILE, 35) : AUTO_ARCHIVE_BELOW_PERCENTILE;
const EFFECTIVE_PRIORITIZE_COMPLETION = PRIORITIZE_COMPLETION || IS_AGGRESSIVE_PROFILE;
const EFFECTIVE_COMPLETION_TRANSFER_ENABLED = COMPLETION_TRANSFER_ENABLED || IS_AGGRESSIVE_PROFILE;
const EFFECTIVE_MIGRATION_CANDIDATE_LIMIT = IS_AGGRESSIVE_PROFILE ? Math.max(MIGRATION_CANDIDATE_LIMIT, 24) : MIGRATION_CANDIDATE_LIMIT;
const EFFECTIVE_TRANSFER_CANDIDATE_SIMILARITY_FLOOR = IS_AGGRESSIVE_PROFILE ? Math.max(0.15, TRANSFER_CANDIDATE_SIMILARITY_FLOOR * 0.72) : TRANSFER_CANDIDATE_SIMILARITY_FLOOR;

const EXPLICIT_OWNER = String(process.env.STICKER_AUTO_PACK_OWNER_JID || process.env.USER_ADMIN || '').trim();

const LABEL_TO_TAG = {
  'anime illustration': 'anime',
  'video game screenshot': 'game',
  'real life photo': 'foto-real',
  'nsfw content': 'nsfw',
  cartoon: 'cartoon',
};

const TECHNICAL_TAGS = new Set(['low-quality-compressed-image', 'blurry-image', 'text-only-image', 'sticker-style-image', 'whatsapp-sticker-style', 'telegram-sticker-style']);

const normalizeTag = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const toNumericClusterId = (value) => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
};

const isSemanticClusterSubthemeTag = (value) => /^cluster-\d+$/.test(normalizeTag(value));

const toTagFromLabel = (label) => {
  const key = String(label || '')
    .trim()
    .toLowerCase();
  return LABEL_TO_TAG[key] || normalizeTag(key);
};

const toPackTitleTag = (tag) =>
  String(tag || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Outros';

const resolveOwnerJid = () => {
  const sock = getActiveSocket?.();
  const botJid = resolveBotJid(sock?.user?.id || '');
  if (botJid) return botJid;

  if (EXPLICIT_OWNER) {
    if (EXPLICIT_OWNER.includes('@')) return normalizeJid(EXPLICIT_OWNER);
    const digits = EXPLICIT_OWNER.replace(/\D+/g, '');
    if (digits) return normalizeJid(`${digits}@s.whatsapp.net`);
  }

  return null;
};

const normalizeOwnerCandidate = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return normalizeJid(raw);
  const digits = raw.replace(/\D+/g, '');
  return digits ? normalizeJid(`${digits}@s.whatsapp.net`) : '';
};

const parseOwnerPool = (raw) =>
  Array.from(
    new Set(
      String(raw || '')
        .split(/[,\n;]+/)
        .map((entry) => normalizeOwnerCandidate(entry))
        .filter(Boolean),
    ),
  );

const resolveCurationOwnerPool = () => {
  const poolFromEnv = parseOwnerPool(CURATION_OWNERS_POOL_RAW);
  const resolvedPrimary = resolveOwnerJid();
  const owners = [...poolFromEnv];
  if (resolvedPrimary && !owners.includes(resolvedPrimary)) {
    owners.unshift(resolvedPrimary);
  }
  return Array.from(new Set(owners.filter(Boolean)));
};

const buildThemeKey = (theme, subtheme = '') => {
  const normalizedTheme = normalizeTag(theme);
  const normalizedSubtheme = normalizeTag(subtheme);
  if (!normalizedTheme) return '';
  return normalizedSubtheme ? `${normalizedTheme}:${normalizedSubtheme}` : normalizedTheme;
};
const parseThemeKey = (raw) => {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase();
  if (!normalized) return { theme: '', subtheme: '' };
  const [theme = '', subtheme = ''] = normalized.split(':', 2);
  return {
    theme: normalizeTag(theme),
    subtheme: normalizeTag(subtheme),
  };
};

const sanitizeDisplaySubtheme = (subtheme) => {
  const normalized = normalizeTag(subtheme);
  if (!normalized) return '';
  if (isSemanticClusterSubthemeTag(normalized)) return '';
  return normalized;
};

const buildAutoPackName = (theme, subtheme, index) => {
  const base = `[AUTO] ${toPackTitleTag(theme)}${subtheme ? ` • ${toPackTitleTag(subtheme)}` : ''}`;
  return `${base} • Vol. ${index}`;
};
const buildAutoPackMarker = (themeKey) => `[auto-theme:${themeKey}]`;
const buildAutoPackDescription = ({ theme, subtheme, themeKey, groupScore }) => `${buildAutoPackMarker(themeKey)} Curadoria automática por tema. Tema: ${theme}${subtheme ? ` / ${subtheme}` : ''}. score=${Number(groupScore || 0).toFixed(4)}.`;

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

const normalizeAffinityWeight = (value) => {
  const raw = clampNumber(Number(value || 0), 0, 1);
  const capped = Math.min(raw, AFFINITY_WEIGHT_CAP);
  if (!ENABLE_AFFINITY_LOG_SCALING) return capped;
  return Math.log1p(capped * AFFINITY_LOG_SCALE) / Math.log1p(AFFINITY_LOG_SCALE);
};

const normalizeEntropy = ({ entropy = 0, entropyNormalized = null, topLabelCount = 0 }) => {
  const explicit = Number(entropyNormalized);
  if (Number.isFinite(explicit)) return clampNumber(explicit, 0, 1);

  const safeEntropy = Math.max(0, Number(entropy || 0));
  if (!safeEntropy) return 0;

  const kFromLabels = Math.max(0, Number(topLabelCount || 0));
  if (kFromLabels > 1) {
    const maxEntropy = Math.log(kFromLabels);
    if (maxEntropy > 0) {
      return clampNumber(safeEntropy / maxEntropy, 0, 1);
    }
  }

  return clampNumber(safeEntropy / Math.max(0.000001, ENTROPY_THRESHOLD), 0, 1);
};

const deterministicUnitInterval = (seed) => {
  let hash = 2166136261;
  const input = String(seed || '');
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
};

const resolvePassScoreWeight = (assetId, passIndex) => {
  const amplitude = SCAN_PASS_JITTER_PERCENT / 100;
  if (amplitude <= 0) return 1;
  const deterministicNoise = deterministicUnitInterval(`${assetId}:${passIndex}`) * 2 - 1;
  return clampNumber(1 + deterministicNoise * amplitude, 0.65, 1.35);
};

const sumArray = (values) => values.reduce((sum, value) => sum + Number(value || 0), 0);

const meanArray = (values) => {
  if (!Array.isArray(values) || !values.length) return 0;
  return sumArray(values) / values.length;
};

const varianceArray = (values) => {
  if (!Array.isArray(values) || values.length <= 1) return 0;
  const mean = meanArray(values);
  return (
    values.reduce((sum, value) => {
      const delta = Number(value || 0) - mean;
      return sum + delta * delta;
    }, 0) / values.length
  );
};

const percentileValue = (values, percentile) => {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = [...values].map((value) => Number(value || 0)).sort((left, right) => left - right);
  const p = clampNumber(percentile, 0, 100) / 100;
  const idx = Math.floor((sorted.length - 1) * p);
  return Number(sorted[Math.max(0, Math.min(sorted.length - 1, idx))] || 0);
};

const accumulateVector = (target, source, weight = 1) => {
  if (!source || typeof source !== 'object') return;
  const w = Number(weight || 1);
  if (!Number.isFinite(w) || w <= 0) return;
  for (const [key, rawValue] of Object.entries(source)) {
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) continue;
    target[key] = (target[key] || 0) + numeric * w;
  }
};

const scaleVector = (vector, denominator) => {
  const d = Number(denominator || 0);
  if (!Number.isFinite(d) || d <= 0) return {};
  const scaled = {};
  for (const [key, value] of Object.entries(vector || {})) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    scaled[key] = numeric / d;
  }
  return scaled;
};

const buildStickerFeatureVector = (classification) => {
  if (!classification || typeof classification !== 'object') return {};
  const vector = {};
  accumulateVector(vector, classification.all_scores || {}, 1);
  for (const topLabel of getTopLabelEntries(classification)) {
    const mapped = toTagFromLabel(topLabel.label);
    if (!mapped) continue;
    vector[`top:${mapped}`] = Math.max(vector[`top:${mapped}`] || 0, Number(topLabel.score || 0));
  }
  for (const trait of getLlmTraitTokens(classification)) {
    vector[`trait:${trait}`] = Math.max(vector[`trait:${trait}`] || 0, 0.12);
  }
  if (classification.category) {
    const normalized = toTagFromLabel(classification.category);
    if (normalized) {
      vector[`cat:${normalized}`] = Number(classification.confidence || 0);
    }
  }
  if (classification.is_nsfw) {
    vector['cat:nsfw'] = Math.max(vector['cat:nsfw'] || 0, Number(classification.nsfw_score || 0));
  }
  return vector;
};

const buildPackCentroidVector = (stickerIds, classificationByAssetId) => {
  const sum = {};
  let count = 0;
  for (const stickerId of stickerIds) {
    const classification = classificationByAssetId.get(stickerId);
    if (!classification) continue;
    accumulateVector(sum, buildStickerFeatureVector(classification), 1);
    count += 1;
  }
  return scaleVector(sum, Math.max(1, count));
};

const dominantTagRatio = (stickerIds, classificationByAssetId) => {
  const votes = new Map();
  let total = 0;
  for (const stickerId of stickerIds) {
    const classification = classificationByAssetId.get(stickerId);
    if (!classification) continue;
    const topTag = buildTopTags(classification).find((entry) => entry?.tag && !TECHNICAL_TAGS.has(entry.tag))?.tag;
    if (!topTag) continue;
    votes.set(topTag, (votes.get(topTag) || 0) + 1);
    total += 1;
  }
  if (total <= 0) return 0;
  const best = Math.max(0, ...votes.values());
  return best / total;
};

const computeStickerPackMatrixScore = ({ stickerId, packStickerIds, classificationByAssetId, centroidVector }) => {
  const classification = classificationByAssetId.get(stickerId);
  if (!classification) return 0;
  const stickerVector = buildStickerFeatureVector(classification);
  const others = packStickerIds.filter((entryId) => entryId !== stickerId);
  const semanticSimilarity = cosineSimilarity(stickerVector, centroidVector);

  let cohesion = semanticSimilarity;
  if (others.length) {
    const sample = others.slice(0, 10);
    const sims = sample.map((otherId) => {
      const otherClassification = classificationByAssetId.get(otherId);
      return cosineSimilarity(stickerVector, buildStickerFeatureVector(otherClassification));
    });
    cohesion = meanArray(sims);
  }

  const confidence = Number(classification.confidence || 0);
  const themeStrength = Number(buildTopTags(classification)[0]?.score || 0);
  const entropyStability =
    1 -
    normalizeEntropy({
      entropy: classification.entropy,
      entropyNormalized: classification.entropy_normalized,
      topLabelCount: Array.isArray(classification.top_labels) ? classification.top_labels.length : 0,
    });
  const affinityWeight = normalizeAffinityWeight(classification.affinity_weight);
  const impactOnGroupScore = confidence * 0.4 + themeStrength * 0.35 + entropyStability * 0.15 + affinityWeight * 0.1;

  let duplicationPenalty = 0;
  if (others.length) {
    const dupHits = others.reduce((acc, otherId) => {
      const otherClassification = classificationByAssetId.get(otherId);
      const sim = cosineSimilarity(stickerVector, buildStickerFeatureVector(otherClassification));
      return acc + (sim >= DEDUPE_SIMILARITY_THRESHOLD ? 1 : 0);
    }, 0);
    duplicationPenalty = dupHits / Math.max(1, others.length);
  }

  const matrixScore = MATRIX_ALPHA * semanticSimilarity + MATRIX_BETA * cohesion + MATRIX_GAMMA * impactOnGroupScore - MATRIX_DELTA * duplicationPenalty;

  return clampNumber(matrixScore, 0, 1.6);
};

const computePackEngagementScore = (engagement) => {
  const opens = Math.max(0, Number(engagement?.open_count || 0));
  const likes = Math.max(0, Number(engagement?.like_count || 0));
  const dislikes = Math.max(0, Number(engagement?.dislike_count || 0));
  if (!opens && !likes && !dislikes) return 0;
  const positive = likes * 2 + opens * 0.15;
  const negative = dislikes * 1.25;
  return clampNumber((positive - negative) / 100, 0, 1.2);
};

const normalizeZScoreToUnit = (value) => clampNumber(0.5 + Number(value || 0) / 6, 0, 1);

const buildNormalizedZScoreMap = (valueByKey = new Map()) => {
  const entries = Array.from(valueByKey.entries());
  if (!entries.length) return new Map();
  const values = entries.map(([, value]) => Number(value || 0));
  const mean = meanArray(values);
  const variance = varianceArray(values);
  const stddev = variance > 0 ? Math.sqrt(variance) : 0;
  const normalized = new Map();
  for (const [key, value] of entries) {
    const numeric = Number(value || 0);
    const zScore = stddev > 0 ? (numeric - mean) / stddev : 0;
    normalized.set(key, Number(normalizeZScoreToUnit(zScore).toFixed(6)));
  }
  return normalized;
};

const computePackCohesionScore = (profile) => clampNumber(Number(profile?.semanticCohesion || 0) * 0.7 + Number(profile?.topicDominance || 0) * 0.3, 0, 1);

const computePackObjectiveScore = ({ profile, engagementScore = 0 }) => {
  const meanAssetQuality = clampNumber(Number(profile?.meanAssetQuality || 0), 0, 1);
  const cohesionScore = computePackCohesionScore(profile);
  const volumeScore = clampNumber(Number(profile?.volumeScore || 0), 0, 1);
  const engagementComponent = clampNumber(Number(engagementScore || 0), 0, 1);

  return clampNumber(GLOBAL_ENERGY_W1 * meanAssetQuality + GLOBAL_ENERGY_W2 * cohesionScore + GLOBAL_ENERGY_W3 * volumeScore + GLOBAL_ENERGY_W4 * engagementComponent, 0, 2);
};

const computePackOfficialQualityScore = ({ profile, engagementZscore = 0 }) => {
  const meanAssetQuality = clampNumber(Number(profile?.meanAssetQuality || 0), 0, 1);
  const cohesionScore = computePackCohesionScore(profile);
  const completionRatio = clampNumber(Number(profile?.volumeScore || 0), 0, 1);
  const stabilityIndex = clampNumber(1 - Math.max(0, Number(profile?.internalVariance || 0)), 0, 1);
  const engagementComponent = clampNumber(Number(engagementZscore || 0), 0, 1);
  const raw = PACK_TIER_QUALITY_W1 * meanAssetQuality + PACK_TIER_QUALITY_W2 * cohesionScore + PACK_TIER_QUALITY_W3 * engagementComponent + PACK_TIER_QUALITY_W4 * completionRatio + PACK_TIER_QUALITY_W5 * stabilityIndex;
  return clampNumber(raw, 0, 1.2);
};

const buildPackPairKey = (leftPackId, rightPackId) => {
  const left = String(leftPackId || '');
  const right = String(rightPackId || '');
  return left < right ? `${left}::${right}` : `${right}::${left}`;
};

const computePackSemanticSimilarity = (leftProfile, rightProfile) => clampNumber(cosineSimilarity(leftProfile?.centroidVector || {}, rightProfile?.centroidVector || {}), 0, 1);

const buildInterPackSimilarityMatrix = (profiles) => {
  const profileList = Array.from(profiles instanceof Map ? profiles.values() : []).filter((profile) => Array.isArray(profile?.stickerIds) && profile.stickerIds.length > 0);
  const matrix = new Map();
  let sum = 0;
  let count = 0;

  for (let i = 0; i < profileList.length; i += 1) {
    for (let j = i + 1; j < profileList.length; j += 1) {
      const left = profileList[i];
      const right = profileList[j];
      const similarity = computePackSemanticSimilarity(left, right);
      matrix.set(buildPackPairKey(left.packId, right.packId), similarity);
      sum += similarity;
      count += 1;
    }
  }

  return {
    matrix,
    pair_count: count,
    similarity_mean: Number((count > 0 ? sum / count : 0).toFixed(6)),
  };
};

const computeMeanNormalizedEntropy = (stickerIds, classificationByAssetId) => {
  if (!Array.isArray(stickerIds) || !stickerIds.length) return 0;
  let total = 0;
  let count = 0;
  for (const stickerId of stickerIds) {
    const classification = classificationByAssetId.get(stickerId);
    if (!classification) continue;
    total += normalizeEntropy({
      entropy: classification.entropy,
      entropyNormalized: classification.entropy_normalized,
      topLabelCount: Array.isArray(classification.top_labels) ? classification.top_labels.length : 0,
    });
    count += 1;
  }
  return count > 0 ? total / count : 0;
};

const computePackEnergyDelta = ({ baseEnergySnapshot, profiles, profileScores, changes }) => {
  const updates = changes instanceof Map ? changes : new Map();
  if (!updates.size) {
    return {
      deltaEnergy: 0,
      nextSnapshot: baseEnergySnapshot,
    };
  }

  const changedIds = Array.from(updates.keys());
  const changedSet = new Set(changedIds);
  const unchangedIds = Array.from(profiles.keys()).filter((packId) => !changedSet.has(packId));

  let qualityDelta = 0;
  for (const packId of changedIds) {
    const oldScore = Number(profileScores.get(packId) || 0);
    const newScore = Number(updates.get(packId)?.score || 0);
    qualityDelta += newScore - oldScore;
  }

  let overlapDelta = 0;
  for (const packId of changedIds) {
    const oldProfile = profiles.get(packId);
    const newProfile = updates.get(packId)?.profile || oldProfile;
    for (const otherId of unchangedIds) {
      const otherProfile = profiles.get(otherId);
      overlapDelta += computePackOverlap(newProfile, otherProfile) - computePackOverlap(oldProfile, otherProfile);
    }
  }
  for (let index = 0; index < changedIds.length; index += 1) {
    const leftId = changedIds[index];
    const leftOld = profiles.get(leftId);
    const leftNew = updates.get(leftId)?.profile || leftOld;
    for (let j = index + 1; j < changedIds.length; j += 1) {
      const rightId = changedIds[j];
      const rightOld = profiles.get(rightId);
      const rightNew = updates.get(rightId)?.profile || rightOld;
      overlapDelta += computePackOverlap(leftNew, rightNew) - computePackOverlap(leftOld, rightOld);
    }
  }

  const qualitySum = Number(baseEnergySnapshot?.qualitySum || 0) + qualityDelta;
  const overlapPairs = Math.max(0, Number(baseEnergySnapshot?.overlapPairs || 0));
  const overlapSum = Number(baseEnergySnapshot?.overlapSum || 0) + overlapDelta;
  const redundancy = overlapPairs > 0 ? overlapSum / overlapPairs : 0;
  const redundancyPenalty = SYSTEM_REDUNDANCY_LAMBDA * GLOBAL_ENERGY_W5 * redundancy;
  const energy = qualitySum - redundancyPenalty;
  const deltaEnergy = energy - Number(baseEnergySnapshot?.energy || 0);

  return {
    deltaEnergy: Number(deltaEnergy.toFixed(6)),
    nextSnapshot: {
      qualitySum: Number(qualitySum.toFixed(6)),
      overlapSum: Number(overlapSum.toFixed(6)),
      overlapPairs,
      redundancy: Number(redundancy.toFixed(6)),
      redundancyPenalty: Number(redundancyPenalty.toFixed(6)),
      energy: Number(energy.toFixed(6)),
      profileScores,
    },
  };
};

const computePackProfile = ({ packId, stickerIds, themeKey, classificationByAssetId }) => {
  const cleanStickerIds = Array.from(new Set((Array.isArray(stickerIds) ? stickerIds : []).filter(Boolean)));
  const centroidVector = buildPackCentroidVector(cleanStickerIds, classificationByAssetId);
  const matrixScores = cleanStickerIds.map((stickerId) =>
    computeStickerPackMatrixScore({
      stickerId,
      packStickerIds: cleanStickerIds,
      classificationByAssetId,
      centroidVector,
    }),
  );
  const meanStickerScore = meanArray(matrixScores);
  const semanticCohesion =
    cleanStickerIds.length <= 1
      ? 1
      : meanArray(
          cleanStickerIds.map((stickerId) => {
            const classification = classificationByAssetId.get(stickerId);
            return cosineSimilarity(buildStickerFeatureVector(classification), centroidVector);
          }),
        );
  const parsedThemeKey = parseThemeKey(themeKey);
  const meanAssetQuality = meanArray(
    cleanStickerIds.map((stickerId) => {
      const classification = classificationByAssetId.get(stickerId);
      if (!classification) return 0;
      const topTags = buildTopTags(classification);
      return computeAssetQualityForTheme({
        classification,
        theme: parsedThemeKey.theme,
        subtheme: parsedThemeKey.subtheme,
        topTags,
      }).assetQuality;
    }),
  );
  const topicDominance = dominantTagRatio(cleanStickerIds, classificationByAssetId);
  const volumeScore = clampNumber(cleanStickerIds.length / Math.max(1, TARGET_PACK_SIZE), 0, 1);
  const internalVariance = varianceArray(matrixScores);

  let duplicatePairs = 0;
  let pairCount = 0;
  for (let i = 0; i < cleanStickerIds.length; i += 1) {
    for (let j = i + 1; j < cleanStickerIds.length; j += 1) {
      pairCount += 1;
      const leftClassification = classificationByAssetId.get(cleanStickerIds[i]);
      const rightClassification = classificationByAssetId.get(cleanStickerIds[j]);
      const sim = cosineSimilarity(buildStickerFeatureVector(leftClassification), buildStickerFeatureVector(rightClassification));
      if (sim >= DEDUPE_SIMILARITY_THRESHOLD) duplicatePairs += 1;
    }
  }
  const duplicationRatio = pairCount > 0 ? duplicatePairs / pairCount : 0;

  const qualityRaw = PACK_QUALITY_W1 * meanStickerScore + PACK_QUALITY_W2 * semanticCohesion + PACK_QUALITY_W3 * topicDominance + PACK_QUALITY_W4 * volumeScore - PACK_QUALITY_W5 * internalVariance - PACK_QUALITY_W6 * duplicationRatio;
  const packQuality = clampNumber(qualityRaw, 0, 2.5);

  return {
    packId,
    themeKey,
    stickerIds: cleanStickerIds,
    centroidVector,
    packQuality: Number(packQuality.toFixed(6)),
    meanAssetQuality: Number(meanAssetQuality.toFixed(6)),
    meanStickerScore: Number(meanStickerScore.toFixed(6)),
    semanticCohesion: Number(semanticCohesion.toFixed(6)),
    topicDominance: Number(topicDominance.toFixed(6)),
    volumeScore: Number(volumeScore.toFixed(6)),
    internalVariance: Number(internalVariance.toFixed(6)),
    duplicationRatio: Number(duplicationRatio.toFixed(6)),
  };
};

const computePackOverlap = (leftProfile, rightProfile) => {
  const leftTags = new Set(
    String(leftProfile?.themeKey || '')
      .split(':')
      .filter(Boolean),
  );
  const rightTags = new Set(
    String(rightProfile?.themeKey || '')
      .split(':')
      .filter(Boolean),
  );
  const intersection = Array.from(leftTags).filter((tag) => rightTags.has(tag)).length;
  const union = new Set([...leftTags, ...rightTags]).size;
  const jaccard = union > 0 ? intersection / union : 0;
  const centroidSimilarity = computePackSemanticSimilarity(leftProfile, rightProfile);
  return clampNumber(centroidSimilarity * 0.65 + jaccard * 0.35, 0, 1);
};

const parseFloat32EmbeddingBuffer = (rawBuffer, expectedDim = 0) => {
  if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length < 4) return null;
  const total = Math.floor(rawBuffer.length / 4);
  if (total <= 0) return null;
  const size = expectedDim > 0 && expectedDim <= total ? expectedDim : total;
  const vector = new Array(size);
  for (let index = 0; index < size; index += 1) {
    vector[index] = rawBuffer.readFloatLE(index * 4);
  }
  return vector;
};

const cosineSimilarityDense = (leftVector, rightVector) => {
  if (!Array.isArray(leftVector) || !Array.isArray(rightVector) || !leftVector.length || !rightVector.length) return 0;
  const size = Math.min(leftVector.length, rightVector.length);
  if (size <= 0) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < size; index += 1) {
    const leftValue = Number(leftVector[index] || 0);
    const rightValue = Number(rightVector[index] || 0);
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))));
};

const getTopLabelEntries = (classification) => {
  if (!Array.isArray(classification?.top_labels)) return [];
  return classification.top_labels
    .map((entry) => ({
      label: String(entry?.label || '').trim(),
      score: Number(entry?.score),
    }))
    .filter((entry) => entry.label && Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
};

const getLlmTraitTokens = (classification) => {
  const tokens = [];
  const addToken = (value, prefix = '') => {
    const normalized = normalizeTag(value);
    if (!normalized) return;
    const token = prefix ? `${prefix}:${normalized}` : normalized;
    if (!tokens.includes(token)) tokens.push(token);
  };

  for (const item of Array.isArray(classification?.llm_subtags) ? classification.llm_subtags : []) {
    addToken(item, 'sub');
  }
  for (const item of Array.isArray(classification?.llm_style_traits) ? classification.llm_style_traits : []) {
    addToken(item, 'style');
  }
  for (const item of Array.isArray(classification?.llm_emotions) ? classification.llm_emotions : []) {
    addToken(item, 'emo');
  }
  return tokens;
};

const getTagScoreEntries = (classification) => {
  if (!classification || typeof classification !== 'object') return [];
  const byTag = new Map();

  const register = (tag, score) => {
    const normalizedTag = normalizeTag(tag);
    const numericScore = Number(score);
    if (!normalizedTag) return;
    if (!Number.isFinite(numericScore)) return;
    byTag.set(normalizedTag, Math.max(byTag.get(normalizedTag) || 0, numericScore));
  };

  for (const [label, score] of Object.entries(classification.all_scores || {})) {
    register(toTagFromLabel(label), score);
  }

  if (classification.category) {
    register(toTagFromLabel(classification.category), Number(classification.confidence || 0));
  }

  for (const entry of getTopLabelEntries(classification)) {
    register(toTagFromLabel(entry.label), Number(entry.score || 0));
  }

  if (classification.is_nsfw) {
    register('nsfw', Math.max(Number(classification.nsfw_score || 0), 0.7));
  }

  for (const trait of getLlmTraitTokens(classification)) {
    register(trait, 0.12);
  }

  return Array.from(byTag.entries())
    .map(([tag, score]) => [tag, Number(Number(score).toFixed(6))])
    .sort((left, right) => right[1] - left[1]);
};

const vectorNorm = (vector) =>
  Math.sqrt(
    Object.values(vector || {})
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .reduce((sum, value) => sum + value * value, 0),
  );

const cosineSimilarity = (left, right) => {
  if (!left || !right) return 0;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (!leftKeys.length || !rightKeys.length) return 0;

  const leftNorm = vectorNorm(left);
  const rightNorm = vectorNorm(right);
  if (leftNorm <= 0 || rightNorm <= 0) return 0;

  let dot = 0;
  for (const key of leftKeys) {
    const leftValue = Number(left[key]);
    const rightValue = Number(right[key]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) continue;
    dot += leftValue * rightValue;
  }
  return Math.max(0, Math.min(1, dot / (leftNorm * rightNorm)));
};

const getScoreByTag = (classification, tag) => {
  const normalizedTag = normalizeTag(tag);
  if (!normalizedTag) return 0;
  const entries = getTagScoreEntries(classification);
  const found = entries.find(([entryTag]) => entryTag === normalizedTag);
  return Number(found?.[1] || 0);
};

const buildTopTags = (classification) => {
  const decorated = decorateStickerClassification(classification || null);
  const decoratedTags = Array.isArray(decorated?.tags) ? decorated.tags.map((tag) => normalizeTag(tag)).filter(Boolean) : [];
  const ranked = getTagScoreEntries(classification)
    .filter(([tag]) => !TECHNICAL_TAGS.has(tag))
    .map(([tag, score]) => ({ tag, score }));

  const tags = [];
  for (const entry of ranked) {
    if (tags.some((item) => item.tag === entry.tag)) continue;
    tags.push(entry);
    if (tags.length >= TOP_TAGS_PER_ASSET) break;
  }

  for (const tag of decoratedTags) {
    if (TECHNICAL_TAGS.has(tag)) continue;
    if (tags.some((item) => item.tag === tag)) continue;
    tags.push({ tag, score: Number(classification?.confidence || 0) });
    if (tags.length >= TOP_TAGS_PER_ASSET) break;
  }

  for (const topLabel of getTopLabelEntries(classification)) {
    const mappedTag = toTagFromLabel(topLabel.label);
    if (!mappedTag || TECHNICAL_TAGS.has(mappedTag)) continue;
    if (tags.some((item) => item.tag === mappedTag)) continue;
    tags.push({ tag: mappedTag, score: Number(topLabel.score || 0) });
    if (tags.length >= TOP_TAGS_PER_ASSET) break;
  }

  return tags.slice(0, TOP_TAGS_PER_ASSET);
};

const evaluateQualityGate = (asset, classification) => {
  const width = Number(asset?.width || 0);
  const height = Number(asset?.height || 0);
  const sizeBytes = Number(asset?.size_bytes || 0);
  const area = width > 0 && height > 0 ? width * height : 0;
  const blurryScore = getScoreByTag(classification, 'blurry-image');
  const lowQualityScore = getScoreByTag(classification, 'low-quality-compressed-image');

  if ((width && width < MIN_ASSET_EDGE) || (height && height < MIN_ASSET_EDGE)) {
    return { accepted: false, reason: 'min_edge', qualityScore: 0 };
  }
  if (area && area < MIN_ASSET_AREA) {
    return { accepted: false, reason: 'min_area', qualityScore: 0 };
  }
  if (sizeBytes && sizeBytes < MIN_ASSET_BYTES) {
    return { accepted: false, reason: 'min_size_bytes', qualityScore: 0 };
  }
  if (blurryScore > MAX_BLURRY_SCORE) {
    return { accepted: false, reason: 'blurry', qualityScore: 0 };
  }
  if (lowQualityScore > MAX_LOW_QUALITY_SCORE) {
    return { accepted: false, reason: 'low_quality', qualityScore: 0 };
  }

  const qualityPenalty = Math.min(0.6, blurryScore * 0.35 + lowQualityScore * 0.35);
  const qualityScore = Number(Math.max(0.2, 1 - qualityPenalty).toFixed(6));
  return { accepted: true, reason: null, qualityScore };
};

const withThemeInTopTags = (topTags, theme, scoreHint = 0) => {
  const normalizedTheme = normalizeTag(theme);
  if (!normalizedTheme) return Array.isArray(topTags) ? topTags.slice(0, TOP_TAGS_PER_ASSET) : [];

  const list = [];
  const seen = new Set();
  const seed = {
    tag: normalizedTheme,
    score: Number(Number(clampNumber(Number(scoreHint || 0), 0, 1.2)).toFixed(6)),
  };
  for (const entry of [seed, ...(Array.isArray(topTags) ? topTags : [])]) {
    const tag = normalizeTag(entry?.tag || entry);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    list.push({
      tag,
      score: Number(Number(entry?.score || 0).toFixed(6)),
    });
  }

  if (!list.length) return [{ tag: normalizedTheme, score: seed.score }];
  list.sort((left, right) => {
    if (left.tag === normalizedTheme) return -1;
    if (right.tag === normalizedTheme) return 1;
    return Number(right.score || 0) - Number(left.score || 0);
  });
  return list.slice(0, TOP_TAGS_PER_ASSET);
};

const deriveThemeFromClassification = (classification) => {
  const topTags = buildTopTags(classification);
  const nsfwScore = Number(classification?.nsfw_score || 0);
  const isNsfw = classification?.is_nsfw === true || nsfwScore >= NSFW_THRESHOLD || nsfwScore >= NSFW_SUGGESTIVE_THRESHOLD;
  if (isNsfw) {
    const nsfwLevel = nsfwScore >= NSFW_EXPLICIT_THRESHOLD ? 'explicit' : 'suggestive';
    return {
      theme: `nsfw-${nsfwLevel}`,
      subtheme: topTags.find((entry) => entry.tag !== 'nsfw')?.tag || '',
      topTags,
      nsfwScore,
      nsfwLevel,
    };
  }

  const semanticClusterId = toNumericClusterId(classification?.semantic_cluster_id);
  const semanticClusterSlug = normalizeTag(classification?.semantic_cluster_slug || '');
  const categoryTag = classification?.category ? toTagFromLabel(classification.category) : '';
  const fallbackPrimary = topTags.find((entry) => entry.tag !== 'nsfw')?.tag || '';

  if (ENABLE_SEMANTIC_CLUSTERING && semanticClusterId) {
    const primary = semanticClusterSlug || categoryTag || fallbackPrimary || `cluster-${semanticClusterId}`;
    const secondary = topTags.find((entry) => entry.tag !== primary && entry.tag !== 'nsfw')?.tag || '';
    const semanticThemeKey = buildThemeKey(primary, `cluster-${semanticClusterId}`);
    const semanticTopTags = withThemeInTopTags(topTags, primary, Math.max(Number(classification?.confidence || 0), Number(topTags.find((entry) => entry.tag === primary)?.score || 0), MOVE_IN_THEME_SCORE_THRESHOLD));
    return {
      theme: primary,
      subtheme: secondary,
      topTags: semanticTopTags,
      nsfwScore,
      nsfwLevel: 'safe',
      semanticClusterId,
      semanticThemeKey,
    };
  }

  const primary = (ENABLE_SEMANTIC_CLUSTERING ? categoryTag : '') || fallbackPrimary;
  const secondary = topTags.find((entry) => entry.tag !== primary && entry.tag !== 'nsfw')?.tag || '';
  const fallbackTopTags = withThemeInTopTags(topTags, primary, Math.max(Number(classification?.confidence || 0), Number(topTags.find((entry) => entry.tag === primary)?.score || 0), MOVE_IN_THEME_SCORE_THRESHOLD));
  return {
    theme: primary,
    subtheme: secondary,
    topTags: fallbackTopTags,
    nsfwScore,
    nsfwLevel: 'safe',
  };
};

const dedupeCandidatesByEmbedding = (candidates, { embeddingByImageHash = new Map() } = {}) => {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return { deduped: Array.isArray(candidates) ? candidates : [], duplicateRate: 0, dropped: 0 };
  }

  const deduped = [];
  let dropped = 0;
  for (const candidate of candidates) {
    const candidateImageHash = String(candidate?.classification?.image_hash || '')
      .trim()
      .toLowerCase();
    const candidateDense = candidateImageHash ? embeddingByImageHash.get(candidateImageHash) : null;
    const candidateSparse = candidate?.classification?.all_scores || {};
    const isDuplicate = deduped.some((entry) => {
      const entryImageHash = String(entry?.classification?.image_hash || '')
        .trim()
        .toLowerCase();
      const entryDense = entryImageHash ? embeddingByImageHash.get(entryImageHash) : null;
      if (candidateDense && entryDense) {
        return cosineSimilarityDense(candidateDense, entryDense) >= DEDUPE_SIMILARITY_THRESHOLD;
      }
      const entrySparse = entry?.classification?.all_scores || {};
      return cosineSimilarity(candidateSparse, entrySparse) >= DEDUPE_SIMILARITY_THRESHOLD;
    });

    if (isDuplicate) {
      dropped += 1;
      continue;
    }
    deduped.push(candidate);
  }

  const duplicateRate = candidates.length > 0 ? dropped / candidates.length : 0;
  return {
    deduped,
    duplicateRate: Number(duplicateRate.toFixed(6)),
    dropped,
  };
};

const computeAssetQualityForTheme = ({ classification, theme, subtheme, topTags = [] }) => {
  const confidence = Number(classification?.confidence || 0);
  const affinityWeight = normalizeAffinityWeight(classification?.affinity_weight);
  const entropyNormalized = normalizeEntropy({
    entropy: classification?.entropy,
    entropyNormalized: classification?.entropy_normalized,
    topLabelCount: Array.isArray(classification?.top_labels) ? classification.top_labels.length : 0,
  });
  const topLabels = getTopLabelEntries(classification);
  const topLabelThemeScore = topLabels.reduce((sum, entry) => {
    const mapped = toTagFromLabel(entry.label);
    if (mapped === theme || (subtheme && mapped === subtheme)) {
      return sum + Number(entry.score || 0);
    }
    return sum;
  }, 0);
  const rankedThemeScore = Number((Array.isArray(topTags) ? topTags : []).find((entry) => entry.tag === theme)?.score || 0);
  const thematicAlignment = clampNumber(Math.max(rankedThemeScore, topLabelThemeScore), 0, 1.2);
  const assetQuality = ASSET_QUALITY_W1 * confidence + ASSET_QUALITY_W2 * (1 - entropyNormalized) + ASSET_QUALITY_W3 * affinityWeight + ASSET_QUALITY_W4 * thematicAlignment;

  return {
    confidence,
    affinityWeight,
    entropyNormalized,
    thematicAlignment,
    assetQuality,
  };
};

const scoreCandidate = ({ classification, theme, subtheme, topTags, qualityScore }) => {
  const { affinityWeight, entropyNormalized, assetQuality } = computeAssetQualityForTheme({
    classification,
    theme,
    subtheme,
    topTags,
  });
  const confidenceMargin = Math.max(0, Number(classification?.confidence_margin || 0));
  const ambiguityPenalty = (classification?.ambiguous ? AMBIGUOUS_FLAG_PENALTY : 0) + entropyNormalized * ENTROPY_WEIGHT;

  const similarImages = Array.isArray(classification?.similar_images) ? classification.similar_images : [];
  const maxSimilarity = similarImages.reduce((max, entry) => {
    const value = Number(entry?.similarity || 0);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
  const similarImagesPenalty = maxSimilarity * SIMILAR_IMAGES_PENALTY_WEIGHT;

  const adaptiveBonus = affinityWeight * ADAPTIVE_BONUS_WEIGHT;
  const marginBonus = confidenceMargin * MARGIN_BONUS_WEIGHT;
  const finalScore = assetQuality * 0.65 + Number(qualityScore || 0) * 0.2 + adaptiveBonus + marginBonus - ambiguityPenalty - similarImagesPenalty;
  return Number(clampNumber(finalScore, 0, 1.2).toFixed(6));
};

const collectCuratableCandidates = async ({ includePacked = true, includeUnpacked = true } = {}) => {
  if (!includePacked && !includeUnpacked) {
    return {
      grouped: new Map(),
      stats: {
        assets_scanned: 0,
        assets_unique_scanned: 0,
        assets_rejected_quality: 0,
        assets_rejected_no_theme: 0,
        assets_grouped: 0,
        review_sample_percent: REVIEW_SAMPLE_PERCENT,
        review_version_target: REVIEW_VERSION_TARGET || null,
        review_mode: 'disabled',
        assets_total_seen: 0,
        assets_version_mismatch_scanned: 0,
        reject_reason_counts: {},
        include_packed: false,
        include_unpacked: false,
        scan_passes_requested: SCAN_PASSES,
        scan_passes_effective: 0,
      },
    };
  }

  const grouped = new Map();
  const pageLimit = 400;
  const passCount = Math.max(1, SCAN_PASSES);
  const effectiveCapPerPass = MAX_SCAN_ASSETS > 0 ? MAX_SCAN_ASSETS : Number.POSITIVE_INFINITY;
  const globalSeenAssetIds = new Set();
  const assetStatsById = new Map();

  const stats = {
    assets_scanned: 0,
    assets_unique_scanned: 0,
    assets_rejected_quality: 0,
    assets_rejected_no_theme: 0,
    assets_grouped: 0,
    review_sample_percent: REVIEW_SAMPLE_PERCENT,
    review_version_target: REVIEW_VERSION_TARGET || null,
    review_mode: MAX_SCAN_ASSETS === 0 ? 'full_scan' : 'bounded_scan',
    assets_total_seen: 0,
    assets_version_mismatch_scanned: 0,
    reject_reason_counts: {},
    include_packed: Boolean(includePacked),
    include_unpacked: Boolean(includeUnpacked),
    scan_passes_requested: SCAN_PASSES,
    scan_passes_effective: passCount,
    scan_pass_jitter_percent: SCAN_PASS_JITTER_PERCENT,
    stability_z_score: STABILITY_Z_SCORE,
    min_asset_acceptance_rate: EFFECTIVE_MIN_ASSET_ACCEPTANCE_RATE,
    min_theme_dominance_ratio: EFFECTIVE_MIN_THEME_DOMINANCE_RATIO,
    score_stddev_penalty: EFFECTIVE_SCORE_STDDEV_PENALTY,
    pass_assets_scanned: [],
    pass_assets_unique: [],
  };

  const ensureAssetStats = (asset, classification) => {
    let current = assetStatsById.get(asset.id);
    if (!current) {
      current = {
        asset,
        classification,
        acceptedCount: 0,
        themes: new Map(),
      };
      assetStatsById.set(asset.id, current);
    }
    return current;
  };

  const ensureThemeStats = (assetStats, { themeKey, theme, subtheme }) => {
    let current = assetStats.themes.get(themeKey);
    if (!current) {
      current = {
        themeKey,
        theme,
        subtheme,
        votes: 0,
        scoreSum: 0,
        scoreSqSum: 0,
        qualitySum: 0,
        confidenceSum: 0,
        themeScoreSum: 0,
        nsfwScoreSum: 0,
        entropySum: 0,
        confidenceMarginSum: 0,
        affinityWeightSum: 0,
        ambiguityVotes: 0,
        similarPenaltySum: 0,
        subthemeVotes: new Map(),
        topTagVotes: new Map(),
      };
      assetStats.themes.set(themeKey, current);
    }
    return current;
  };

  const registerCandidate = ({ asset, classification, passIndex, theme, subtheme, themeKey, topTags, qualityScore, themeScore, score, nsfwScore, nsfwLevel, entropy, confidenceMargin, affinityWeight, ambiguous, similarPenalty }) => {
    const assetStats = ensureAssetStats(asset, classification);
    const themeStats = ensureThemeStats(assetStats, { themeKey, theme, subtheme });
    const passWeight = resolvePassScoreWeight(asset.id, passIndex);
    const weightedScore = clampNumber(score * passWeight, 0, 1.2);

    themeStats.votes += 1;
    themeStats.scoreSum += weightedScore;
    themeStats.scoreSqSum += weightedScore * weightedScore;
    themeStats.qualitySum += Number(qualityScore || 0);
    themeStats.confidenceSum += Number(classification?.confidence || 0);
    themeStats.themeScoreSum += Number(themeScore || 0);
    themeStats.nsfwScoreSum += Number(nsfwScore || 0);
    themeStats.entropySum += Number(entropy || 0);
    themeStats.confidenceMarginSum += Number(confidenceMargin || 0);
    themeStats.affinityWeightSum += Number(affinityWeight || 0);
    themeStats.similarPenaltySum += Number(similarPenalty || 0);
    if (ambiguous) themeStats.ambiguityVotes += 1;
    if (subtheme) {
      themeStats.subthemeVotes.set(subtheme, (themeStats.subthemeVotes.get(subtheme) || 0) + 1);
    }
    for (const tagEntry of Array.isArray(topTags) ? topTags : []) {
      const tag = normalizeTag(tagEntry?.tag || tagEntry);
      if (!tag) continue;
      themeStats.topTagVotes.set(tag, (themeStats.topTagVotes.get(tag) || 0) + 1);
    }

    assetStats.acceptedCount += 1;
    assetStats.classification = classification;
    assetStats.asset = asset;
    assetStats.lastNsfwLevel = nsfwLevel;
  };

  const processAssetsPage = async ({ page, passIndex, passSeenIds, scannedInPass }) => {
    const assets = Array.isArray(page?.assets) ? page.assets : [];
    if (!assets.length) return { processedRows: 0, scannedUnique: 0, done: true };

    const classifications = await listStickerClassificationsByAssetIds(assets.map((asset) => asset.id));
    const byAssetId = new Map(classifications.map((entry) => [entry.asset_id, entry]));
    let scannedUnique = 0;

    for (const asset of assets) {
      if (!asset?.id || passSeenIds.has(asset.id)) continue;
      if (scannedInPass + scannedUnique >= effectiveCapPerPass) {
        return { processedRows: assets.length, scannedUnique, done: true };
      }

      passSeenIds.add(asset.id);
      scannedUnique += 1;
      stats.assets_scanned += 1;
      globalSeenAssetIds.add(asset.id);
      stats.assets_unique_scanned = globalSeenAssetIds.size;
      stats.assets_total_seen = globalSeenAssetIds.size;

      const classification = byAssetId.get(asset.id);
      if (!classification) {
        stats.reject_reason_counts.missing_classification = (stats.reject_reason_counts.missing_classification || 0) + 1;
        continue;
      }

      if (REVIEW_VERSION_TARGET && String(classification.classification_version || '').trim() !== REVIEW_VERSION_TARGET) {
        stats.assets_version_mismatch_scanned += 1;
      }

      const quality = evaluateQualityGate(asset, classification);
      if (!quality.accepted) {
        const reason = quality.reason || 'unknown';
        stats.assets_rejected_quality += 1;
        stats.reject_reason_counts[reason] = (stats.reject_reason_counts[reason] || 0) + 1;
        continue;
      }

      const { theme, subtheme, topTags, nsfwScore, nsfwLevel, semanticThemeKey = '' } = deriveThemeFromClassification(classification);
      if (!theme) {
        stats.assets_rejected_no_theme += 1;
        continue;
      }

      const themeKey = semanticThemeKey || buildThemeKey(theme, subtheme);
      const themeScore = Number(topTags.find((entry) => entry.tag === theme)?.score || 0);
      if (themeScore < MOVE_IN_THEME_SCORE_THRESHOLD) {
        stats.reject_reason_counts.low_theme_match = (stats.reject_reason_counts.low_theme_match || 0) + 1;
        continue;
      }

      const score = scoreCandidate({
        classification,
        theme,
        subtheme,
        topTags,
        qualityScore: quality.qualityScore,
      });
      const entropyNormalized = normalizeEntropy({
        entropy: classification?.entropy,
        entropyNormalized: classification?.entropy_normalized,
        topLabelCount: Array.isArray(classification?.top_labels) ? classification.top_labels.length : 0,
      });
      const similarImages = Array.isArray(classification?.similar_images) ? classification.similar_images : [];
      const maxSimilarity = similarImages.reduce((max, entry) => {
        const value = Number(entry?.similarity || 0);
        return Number.isFinite(value) ? Math.max(max, value) : max;
      }, 0);
      registerCandidate({
        asset,
        classification,
        passIndex,
        theme,
        subtheme,
        themeKey,
        topTags,
        qualityScore: quality.qualityScore,
        themeScore,
        score,
        nsfwScore,
        nsfwLevel,
        entropy: entropyNormalized,
        confidenceMargin: Number(classification?.confidence_margin || 0),
        affinityWeight: normalizeAffinityWeight(classification?.affinity_weight),
        ambiguous: classification?.ambiguous === true || classification?.ambiguous === 1 || entropyNormalized > ENTROPY_NORMALIZED_THRESHOLD,
        similarPenalty: maxSimilarity * SIMILAR_IMAGES_PENALTY_WEIGHT,
      });
    }

    return {
      processedRows: assets.length,
      scannedUnique,
      done: !page?.hasMore || scannedInPass + scannedUnique >= effectiveCapPerPass,
    };
  };

  const runSingleScanPass = async (passIndex) => {
    let scannedInPass = 0;
    let offset = 0;
    let versionOffset = 0;
    const passSeenIds = new Set();

    if (REVIEW_VERSION_TARGET) {
      while (scannedInPass < effectiveCapPerPass) {
        const remaining = Number.isFinite(effectiveCapPerPass) ? Math.max(0, effectiveCapPerPass - scannedInPass) : pageLimit;
        const limit = Math.max(1, Math.min(pageLimit, remaining || pageLimit));
        const page = await listClassifiedStickerAssetsForCuration({
          limit,
          offset: versionOffset,
          includePacked,
          includeUnpacked,
          onlyVersionMismatch: REVIEW_VERSION_TARGET,
        });
        const result = await processAssetsPage({
          page,
          passIndex,
          passSeenIds,
          scannedInPass,
        });
        scannedInPass += result.scannedUnique;
        if (!result.processedRows || result.done) break;
        versionOffset += result.processedRows;
      }
    }

    while (scannedInPass < effectiveCapPerPass) {
      const remaining = Number.isFinite(effectiveCapPerPass) ? Math.max(0, effectiveCapPerPass - scannedInPass) : pageLimit;
      const limit = Math.max(1, Math.min(pageLimit, remaining || pageLimit));
      const page = await listClassifiedStickerAssetsForCuration({
        limit,
        offset,
        includePacked,
        includeUnpacked,
      });
      const result = await processAssetsPage({
        page,
        passIndex,
        passSeenIds,
        scannedInPass,
      });
      scannedInPass += result.scannedUnique;
      if (!result.processedRows || result.done) break;
      offset += result.processedRows;
    }

    return {
      scannedInPass,
      uniqueSeenInPass: passSeenIds.size,
    };
  };

  for (let passIndex = 0; passIndex < passCount; passIndex += 1) {
    const passResult = await runSingleScanPass(passIndex);
    stats.pass_assets_scanned.push(passResult.scannedInPass);
    stats.pass_assets_unique.push(passResult.uniqueSeenInPass);
  }

  const meanPassScan = stats.pass_assets_scanned.reduce((sum, value) => sum + Number(value || 0), 0) / Math.max(1, stats.pass_assets_scanned.length);
  stats.assets_scanned_avg_per_pass = Number(meanPassScan.toFixed(2));
  stats.assets_unique_scanned = globalSeenAssetIds.size;

  for (const assetStats of assetStatsById.values()) {
    const themeEntries = Array.from(assetStats.themes.values());
    if (!themeEntries.length) continue;

    const dominantTheme = themeEntries.slice().sort((left, right) => {
      if (right.votes !== left.votes) return right.votes - left.votes;
      const leftMean = left.scoreSum / Math.max(1, left.votes);
      const rightMean = right.scoreSum / Math.max(1, right.votes);
      if (rightMean !== leftMean) return rightMean - leftMean;
      return right.themeScoreSum - left.themeScoreSum;
    })[0];

    if (!dominantTheme || dominantTheme.votes <= 0) continue;

    const acceptedVotes = Number(dominantTheme.votes || 0);
    const totalThemeVotes = themeEntries.reduce((sum, entry) => sum + Number(entry.votes || 0), 0);
    const acceptanceRate = acceptedVotes / Math.max(1, passCount);
    const dominanceRatio = acceptedVotes / Math.max(1, totalThemeVotes);
    if (acceptanceRate < EFFECTIVE_MIN_ASSET_ACCEPTANCE_RATE) {
      stats.reject_reason_counts.low_acceptance_rate = (stats.reject_reason_counts.low_acceptance_rate || 0) + 1;
      continue;
    }
    if (dominanceRatio < EFFECTIVE_MIN_THEME_DOMINANCE_RATIO) {
      stats.reject_reason_counts.unstable_theme_vote = (stats.reject_reason_counts.unstable_theme_vote || 0) + 1;
      continue;
    }

    const meanScore = dominantTheme.scoreSum / acceptedVotes;
    const variance = Math.max(0, dominantTheme.scoreSqSum / acceptedVotes - meanScore * meanScore);
    const stdDev = Math.sqrt(variance);
    const stdError = stdDev / Math.sqrt(Math.max(1, acceptedVotes));
    const lowerBoundScore = meanScore - STABILITY_Z_SCORE * stdError;
    const avgQuality = dominantTheme.qualitySum / acceptedVotes;
    const avgConfidence = dominantTheme.confidenceSum / acceptedVotes;
    const avgThemeScore = dominantTheme.themeScoreSum / acceptedVotes;
    const avgNsfwScore = dominantTheme.nsfwScoreSum / acceptedVotes;
    const avgEntropy = dominantTheme.entropySum / acceptedVotes;
    const avgConfidenceMargin = dominantTheme.confidenceMarginSum / acceptedVotes;
    const avgAffinityWeight = dominantTheme.affinityWeightSum / acceptedVotes;
    const avgSimilarPenalty = dominantTheme.similarPenaltySum / acceptedVotes;
    const ambiguousRatio = dominantTheme.ambiguityVotes / acceptedVotes;
    const stabilityFactor = Math.sqrt(clampNumber(acceptanceRate, 0, 1));
    const harmonicSignal = 3 / (1 / Math.max(0.01, avgQuality) + 1 / Math.max(0.01, avgThemeScore) + 1 / Math.max(0.01, avgConfidence));
    const robustScoreRaw = lowerBoundScore * 0.46 + meanScore * 0.16 + avgThemeScore * 0.14 + avgConfidence * 0.08 + harmonicSignal * 0.16 + avgConfidenceMargin * MARGIN_BONUS_WEIGHT * 0.45 + avgAffinityWeight * ADAPTIVE_BONUS_WEIGHT * 0.4 - Math.min(0.42, avgEntropy * ENTROPY_WEIGHT) - ambiguousRatio * AMBIGUOUS_FLAG_PENALTY - avgSimilarPenalty * 0.5;
    const stabilityMultiplier = 0.72 + stabilityFactor * 0.28;
    const variancePenalty = Math.max(0.4, 1 - Math.min(0.55, stdDev * EFFECTIVE_SCORE_STDDEV_PENALTY));
    const robustScore = clampNumber(robustScoreRaw * stabilityMultiplier * variancePenalty, 0, 1.2);

    const dominantSubtheme = Array.from(dominantTheme.subthemeVotes.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || dominantTheme.subtheme || '';
    const topTags = buildTopTags(assetStats.classification);
    if (!topTags.some((entry) => entry?.tag === dominantTheme.theme)) {
      topTags.unshift({ tag: dominantTheme.theme, score: avgThemeScore });
    }
    if (dominantSubtheme && !topTags.some((entry) => entry?.tag === dominantSubtheme)) {
      topTags.splice(1, 0, { tag: dominantSubtheme, score: avgThemeScore * 0.85 });
    }

    const themeKey = buildThemeKey(dominantTheme.theme, dominantSubtheme);
    const list = grouped.get(themeKey) || [];
    list.push({
      asset: assetStats.asset,
      classification: assetStats.classification,
      theme: dominantTheme.theme,
      subtheme: dominantSubtheme,
      themeKey,
      topTags: topTags.slice(0, TOP_TAGS_PER_ASSET),
      qualityScore: Number(avgQuality.toFixed(6)),
      themeScore: Number(avgThemeScore.toFixed(6)),
      score: Number(robustScore.toFixed(6)),
      nsfwScore: Number(avgNsfwScore.toFixed(6)),
      nsfwLevel: assetStats.lastNsfwLevel || 'safe',
      acceptanceRate: Number(acceptanceRate.toFixed(6)),
      dominanceRatio: Number(dominanceRatio.toFixed(6)),
      scoreStdDev: Number(stdDev.toFixed(6)),
      scoreMean: Number(meanScore.toFixed(6)),
      scoreLowerBound: Number(lowerBoundScore.toFixed(6)),
      stabilityFactor: Number(stabilityFactor.toFixed(6)),
      harmonicSignal: Number(harmonicSignal.toFixed(6)),
      passVotes: acceptedVotes,
      avgEntropy: Number(avgEntropy.toFixed(6)),
      avgConfidenceMargin: Number(avgConfidenceMargin.toFixed(6)),
      avgAffinityWeight: Number(avgAffinityWeight.toFixed(6)),
      ambiguousRatio: Number(ambiguousRatio.toFixed(6)),
    });
    grouped.set(themeKey, list);
    stats.assets_grouped += 1;
  }

  const imageHashes = Array.from(
    new Set(
      Array.from(grouped.values())
        .flat()
        .map((candidate) =>
          String(candidate?.classification?.image_hash || '')
            .trim()
            .toLowerCase(),
        )
        .filter((hash) => hash.length === 64),
    ),
  );
  const embeddingByImageHash = new Map();
  if (imageHashes.length) {
    const rows = await listClipImageEmbeddingsByImageHashes(imageHashes);
    for (const row of rows) {
      const imageHash = String(row?.image_hash || '')
        .trim()
        .toLowerCase();
      if (!imageHash) continue;
      const embedding = parseFloat32EmbeddingBuffer(row?.embedding, Number(row?.embedding_dim || 0));
      if (!embedding?.length) continue;
      embeddingByImageHash.set(imageHash, embedding);
    }
  }

  let dedupeDropped = 0;
  for (const [groupKey, list] of grouped.entries()) {
    const { deduped, duplicateRate, dropped } = dedupeCandidatesByEmbedding(list, {
      embeddingByImageHash,
    });
    dedupeDropped += dropped;
    stats.reject_reason_counts.duplicate_embedding = (stats.reject_reason_counts.duplicate_embedding || 0) + dropped;

    const normalizedList = deduped.map((candidate) => ({
      ...candidate,
      duplicateRate,
    }));
    normalizedList.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(right.asset?.created_at || '').localeCompare(String(left.asset?.created_at || ''));
    });
    grouped.set(groupKey, normalizedList);
  }

  stats.assets_deduped = dedupeDropped;
  stats.assets_unique_scanned = globalSeenAssetIds.size;
  stats.assets_total_seen = globalSeenAssetIds.size;

  return { grouped, stats };
};

const computeGroupMetrics = (themeKey, candidates) => {
  const first = candidates[0] || {};
  const theme = first.theme || parseThemeKey(themeKey).theme || '';
  const subtheme = first.subtheme || parseThemeKey(themeKey).subtheme || '';
  const size = candidates.length;
  if (!size) {
    return {
      theme,
      subtheme,
      themeKey,
      groupScore: 0,
      cohesion: 0,
      avgConfidence: 0,
      avgQuality: 0,
    };
  }

  const avgConfidence = candidates.reduce((sum, candidate) => sum + Number(candidate.classification?.confidence || 0), 0) / size;
  const avgEntropy =
    candidates.reduce(
      (sum, candidate) =>
        sum +
        normalizeEntropy({
          entropy: candidate.classification?.entropy,
          entropyNormalized: candidate.classification?.entropy_normalized,
          topLabelCount: Array.isArray(candidate.classification?.top_labels) ? candidate.classification.top_labels.length : 0,
        }),
      0,
    ) / size;
  const avgMargin = candidates.reduce((sum, candidate) => sum + Number(candidate.classification?.confidence_margin || 0), 0) / size;
  const avgAffinity = candidates.reduce((sum, candidate) => sum + normalizeAffinityWeight(candidate.classification?.affinity_weight), 0) / size;
  const avgQuality = candidates.reduce((sum, candidate) => sum + Number(candidate.qualityScore || 0), 0) / size;
  const avgDuplicateRate = candidates.reduce((sum, candidate) => sum + Number(candidate.duplicateRate || 0), 0) / size;
  let semanticSimilaritySum = 0;
  let semanticPairs = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      semanticPairs += 1;
      semanticSimilaritySum += cosineSimilarity(candidates[i]?.classification?.all_scores || {}, candidates[j]?.classification?.all_scores || {});
    }
  }
  const semanticCohesion = semanticPairs > 0 ? semanticSimilaritySum / semanticPairs : 1;
  const cooccurrence = new Map();
  for (const candidate of candidates) {
    const localSecondary = (candidate.topTags || []).map((entry) => entry.tag).find((tag) => tag && tag !== theme && tag !== 'nsfw');
    if (!localSecondary) continue;
    cooccurrence.set(localSecondary, (cooccurrence.get(localSecondary) || 0) + 1);
  }
  const bestCooccurrence = Math.max(0, ...cooccurrence.values());
  const topicalCohesion = size ? bestCooccurrence / size : 0;
  const cohesion = topicalCohesion * 0.45 + semanticCohesion * 0.55;
  const traitVotes = new Map();
  for (const candidate of candidates) {
    for (const token of getLlmTraitTokens(candidate.classification)) {
      traitVotes.set(token, (traitVotes.get(token) || 0) + 1);
    }
  }
  const strongestTraitRatio = size ? Math.max(0, ...Array.from(traitVotes.values()).map((value) => value / size)) : 0;
  const semanticBoost = strongestTraitRatio * LLM_TRAIT_WEIGHT;
  const subthemeFromCooccurrence = Array.from(cooccurrence.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || subtheme;
  const volumeBoost = Math.min(1, size / Math.max(MIN_GROUP_SIZE, TARGET_PACK_SIZE));
  const duplicatePenalty = Math.max(0.65, 1 - avgDuplicateRate * 0.8);
  const entropyPenalty = Math.min(0.35, avgEntropy * ENTROPY_WEIGHT);
  const marginBoost = Math.max(0, avgMargin * MARGIN_BONUS_WEIGHT);
  const affinityBoost = Math.max(0, avgAffinity * ADAPTIVE_BONUS_WEIGHT);
  const groupScore = Number((avgConfidence * (0.55 + cohesion * 0.45 + semanticBoost) * avgQuality * (0.75 + volumeBoost * 0.25 + marginBoost) * duplicatePenalty * (1 + affinityBoost) * Math.max(0.45, 1 - entropyPenalty)).toFixed(6));

  return {
    theme,
    subtheme: subthemeFromCooccurrence,
    themeKey,
    groupScore,
    cohesion: Number(cohesion.toFixed(6)),
    topical_cohesion: Number(topicalCohesion.toFixed(6)),
    semantic_cohesion: Number(semanticCohesion.toFixed(6)),
    semantic_boost: Number(semanticBoost.toFixed(6)),
    avg_entropy: Number(avgEntropy.toFixed(6)),
    avg_confidence_margin: Number(avgMargin.toFixed(6)),
    avg_affinity_weight: Number(avgAffinity.toFixed(6)),
    avgConfidence: Number(avgConfidence.toFixed(6)),
    avgQuality: Number(avgQuality.toFixed(6)),
    duplicateRate: Number(avgDuplicateRate.toFixed(6)),
  };
};

const buildCurationPlan = ({ grouped, stats }) => {
  const rawGroups = Array.from(grouped.entries())
    .map(([themeKey, candidates]) => {
      const metrics = computeGroupMetrics(themeKey, candidates);
      return { ...metrics, candidates };
    })
    .filter((group) => group.theme && group.candidates.length >= EFFECTIVE_HARD_MIN_GROUP_SIZE)
    .sort((left, right) => {
      if (right.groupScore !== left.groupScore) return right.groupScore - left.groupScore;
      return right.candidates.length - left.candidates.length;
    });

  let curatedGroups = rawGroups;
  if (MAX_TAG_GROUPS > 0) {
    curatedGroups = curatedGroups.slice(0, MAX_TAG_GROUPS);
  }

  return {
    groups: curatedGroups,
    stats: {
      ...stats,
      hard_min_group_size: EFFECTIVE_HARD_MIN_GROUP_SIZE,
      hard_min_group_size_base: HARD_MIN_GROUP_SIZE,
      semantic_clustering_enabled: ENABLE_SEMANTIC_CLUSTERING,
      semantic_cluster_min_size_for_pack: SEMANTIC_CLUSTER_MIN_SIZE_FOR_PACK,
      groups_filtered_hard_min: Math.max(0, Number(grouped?.size || 0) - rawGroups.length),
      groups_formed: curatedGroups.length,
    },
  };
};

const extractThemeKeyFromPack = (pack) => {
  const direct = normalizeTag(pack?.pack_theme_key || '');
  if (direct) {
    const parsedDirect = parseThemeKey(pack.pack_theme_key);
    return buildThemeKey(parsedDirect.theme, parsedDirect.subtheme) || direct;
  }

  const description = String(pack?.description || '');
  const themeMarker = description.match(/\[auto-theme:([^\]]+)\]/i);
  const legacyTagMarker = description.match(/\[auto-tag:([^\]]+)\]/i);
  const markerValue = themeMarker?.[1] || legacyTagMarker?.[1] || '';
  if (!markerValue) return '';
  const parsed = parseThemeKey(markerValue);
  const themeKey = buildThemeKey(parsed.theme, parsed.subtheme);
  return themeKey || normalizeTag(markerValue);
};

const extractVolumeFromPack = (pack) => {
  const directVolume = Number(pack?.pack_volume || 0);
  if (Number.isInteger(directVolume) && directVolume > 0) return directVolume;

  const name = String(pack?.name || '');
  const match = name.match(/vol\.\s*(\d+)/i);
  const parsed = Number(match?.[1] || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

const sortAutoThemePacks = (packs) =>
  [...(Array.isArray(packs) ? packs : [])].sort((left, right) => {
    const leftVol = extractVolumeFromPack(left);
    const rightVol = extractVolumeFromPack(right);
    if (leftVol !== rightVol) return leftVol - rightVol;
    return String(left.id || '').localeCompare(String(right.id || ''));
  });

const buildAutoPackIndex = (packs) => {
  const byTheme = new Map();
  const byId = new Map();
  for (const pack of Array.isArray(packs) ? packs : []) {
    if (!pack?.id) continue;
    byId.set(pack.id, pack);
    const themeKey = extractThemeKeyFromPack(pack);
    if (!themeKey) continue;
    const list = byTheme.get(themeKey) || [];
    list.push(pack);
    byTheme.set(themeKey, list);
  }

  for (const [themeKey, list] of byTheme.entries()) {
    byTheme.set(themeKey, sortAutoThemePacks(list));
  }

  return { byTheme, byId };
};

const buildOwnerCapacityState = async (ownerPool) => {
  const hasOwnerPackLimit = Number.isFinite(MAX_PACKS_PER_OWNER);
  const ownerPackScanLimit = hasOwnerPackLimit ? Math.max(100, MAX_PACKS_PER_OWNER + 20) : 1000;
  const states = [];
  for (const ownerJid of ownerPool) {
    try {
      const packs = hasOwnerPackLimit ? await listStickerPacksByOwner(ownerJid, { limit: ownerPackScanLimit }) : [];
      states.push({
        ownerJid,
        totalPacks: hasOwnerPackLimit ? (Array.isArray(packs) ? packs.length : 0) : 0,
      });
    } catch (error) {
      logger.warn('Falha ao calcular capacidade de owner para auto-curadoria.', {
        action: 'sticker_auto_pack_by_tags_owner_capacity_failed',
        owner_jid: ownerJid,
        error: error?.message,
      });
      states.push({
        ownerJid,
        totalPacks: hasOwnerPackLimit ? MAX_PACKS_PER_OWNER : 0,
      });
    }
  }

  return states.map((entry) => ({
    ...entry,
    available: hasOwnerPackLimit ? Math.max(0, MAX_PACKS_PER_OWNER - Math.max(0, Number(entry.totalPacks || 0))) : Number.POSITIVE_INFINITY,
  }));
};

const pickOwnerWithCapacity = (ownerStates) => {
  const candidates = (Array.isArray(ownerStates) ? ownerStates : [])
    .filter((entry) => Number(entry.available || 0) > 0)
    .sort((left, right) => {
      if (left.available !== right.available) return right.available - left.available;
      if (left.totalPacks !== right.totalPacks) return left.totalPacks - right.totalPacks;
      return String(left.ownerJid || '').localeCompare(String(right.ownerJid || ''));
    });
  return candidates[0] || null;
};

const chunkArray = (list, size) => {
  const safeSize = Math.max(1, Number(size) || 1);
  const chunks = [];
  for (let index = 0; index < list.length; index += safeSize) {
    chunks.push(list.slice(index, index + safeSize));
  }
  return chunks;
};

const countPackItems = (itemsByPackId, packId) => Number(itemsByPackId.get(packId)?.length || 0);

const deleteAutoPackWithItems = async (packId, itemsByPackId) => {
  await removeStickerPackItemsByPackId(packId);
  await softDeleteStickerPack(packId);
  itemsByPackId.set(packId, []);
};

const runRetroConsolidationCycle = async ({ ownerPool }) => {
  if (!RETRO_CONSOLIDATION_ENABLED) {
    return {
      enabled: false,
      processed_themes: 0,
      merged_themes: 0,
      deleted_packs: 0,
      moved_stickers: 0,
      trimmed_stickers: 0,
      mutations: 0,
      theme_limit_reached: false,
      mutation_limit_reached: false,
    };
  }

  const autoPacks = await listStickerAutoPacksForCuration({
    ownerJids: ownerPool,
    includeArchived: false,
    limit: 5000,
  });
  if (!autoPacks.length) {
    return {
      enabled: true,
      processed_themes: 0,
      merged_themes: 0,
      deleted_packs: 0,
      moved_stickers: 0,
      trimmed_stickers: 0,
      mutations: 0,
      theme_limit_reached: false,
      mutation_limit_reached: false,
    };
  }

  const packIds = autoPacks.map((pack) => pack.id).filter(Boolean);
  const allItems = packIds.length ? await listStickerPackItemsByPackIds(packIds) : [];
  const itemsByPackId = new Map();
  for (const item of allItems) {
    const list = itemsByPackId.get(item.pack_id) || [];
    list.push(item);
    itemsByPackId.set(item.pack_id, list);
  }

  const packsByTheme = new Map();
  for (const pack of autoPacks) {
    const themeKey = extractThemeKeyFromPack(pack);
    if (!themeKey) continue;
    const list = packsByTheme.get(themeKey) || [];
    list.push(pack);
    packsByTheme.set(themeKey, list);
  }

  let processedThemes = 0;
  let mergedThemes = 0;
  let deletedPacks = 0;
  let movedStickers = 0;
  let trimmedStickers = 0;
  let mutations = 0;
  let themeLimitReached = false;
  let mutationLimitReached = false;

  const themeEntries = Array.from(packsByTheme.entries()).sort((left, right) => right[1].length - left[1].length);

  for (const [themeKey, themePacksRaw] of themeEntries) {
    if (processedThemes >= RETRO_CONSOLIDATION_THEME_LIMIT) {
      themeLimitReached = true;
      break;
    }
    if (mutations >= RETRO_CONSOLIDATION_MUTATION_LIMIT) {
      mutationLimitReached = true;
      break;
    }
    processedThemes += 1;

    const themePacks = sortAutoThemePacks(themePacksRaw).sort((left, right) => {
      const leftCount = countPackItems(itemsByPackId, left.id);
      const rightCount = countPackItems(itemsByPackId, right.id);
      if (rightCount !== leftCount) return rightCount - leftCount;
      return extractVolumeFromPack(left) - extractVolumeFromPack(right);
    });
    if (!themePacks.length) continue;

    const smallPacks = themePacks.filter((pack) => countPackItems(itemsByPackId, pack.id) < HARD_MIN_PACK_ITEMS);
    const overflowPacks = themePacks.slice(MAX_PACKS_PER_THEME);
    const needsReadinessCorrection = themePacks.some((pack) => {
      const count = countPackItems(itemsByPackId, pack.id);
      const packStatus = String(pack?.pack_status || 'ready').toLowerCase();
      return packStatus === 'ready' && count < READY_PACK_MIN_ITEMS;
    });
    if (!smallPacks.length && !overflowPacks.length && !needsReadinessCorrection) continue;

    const anchorPack = themePacks[0];
    const anchorItemsInitial = itemsByPackId.get(anchorPack.id) || [];
    const donorPacks = themePacks.filter((pack) => pack.id !== anchorPack.id && (smallPacks.some((entry) => entry.id === pack.id) || overflowPacks.some((entry) => entry.id === pack.id)));

    const desiredAnchorIds = Array.from(new Set([...anchorItemsInitial.map((item) => item.sticker_id).filter(Boolean), ...donorPacks.flatMap((pack) => (itemsByPackId.get(pack.id) || []).map((item) => item.sticker_id).filter(Boolean))])).slice(0, TARGET_PACK_SIZE);
    const desiredAnchorSet = new Set(desiredAnchorIds);

    let anchorItems = itemsByPackId.get(anchorPack.id) || (await listStickerPackItems(anchorPack.id));
    const anchorCurrentSet = new Set(anchorItems.map((item) => item.sticker_id).filter(Boolean));

    for (const item of anchorItems) {
      if (mutations >= RETRO_CONSOLIDATION_MUTATION_LIMIT) break;
      if (desiredAnchorSet.has(item.sticker_id)) continue;
      try {
        await stickerPackService.removeStickerFromPack({
          ownerJid: anchorPack.owner_jid,
          identifier: anchorPack.id,
          selector: item.sticker_id,
        });
        mutations += 1;
        trimmedStickers += 1;
      } catch (error) {
        logger.warn('Falha ao podar sticker excedente durante consolidação retroativa.', {
          action: 'sticker_auto_pack_retro_trim_failed',
          pack_id: anchorPack.id,
          sticker_id: item.sticker_id,
          theme_key: themeKey,
          error: error?.message,
          error_code: error?.code,
        });
      }
    }

    anchorItems = await listStickerPackItems(anchorPack.id);
    itemsByPackId.set(anchorPack.id, anchorItems);
    anchorCurrentSet.clear();
    for (const item of anchorItems) anchorCurrentSet.add(item.sticker_id);

    for (const stickerId of desiredAnchorIds) {
      if (mutations >= RETRO_CONSOLIDATION_MUTATION_LIMIT) break;
      if (anchorCurrentSet.has(stickerId)) continue;
      try {
        await stickerPackService.addStickerToPack({
          ownerJid: anchorPack.owner_jid,
          identifier: anchorPack.id,
          asset: { id: stickerId },
          emojis: [],
          accessibilityLabel: `Auto-theme ${themeKey}`,
          expectedErrorCodes: ['PACK_LIMIT_REACHED'],
        });
        mutations += 1;
        movedStickers += 1;
        anchorCurrentSet.add(stickerId);
      } catch (error) {
        if (error?.code === 'PACK_LIMIT_REACHED') break;
        if (error?.code === 'DUPLICATE_STICKER') continue;
        logger.warn('Falha ao mover sticker para pack âncora na consolidação retroativa.', {
          action: 'sticker_auto_pack_retro_move_failed',
          pack_id: anchorPack.id,
          sticker_id: stickerId,
          theme_key: themeKey,
          error: error?.message,
          error_code: error?.code,
        });
      }
    }

    anchorItems = await listStickerPackItems(anchorPack.id);
    itemsByPackId.set(anchorPack.id, anchorItems);
    const anchorOrder = anchorItems.map((item) => item.sticker_id);
    const finalDesiredOrder = desiredAnchorIds.filter((stickerId) => anchorOrder.includes(stickerId));
    const needsReorder = finalDesiredOrder.length > 1 && (finalDesiredOrder.length !== anchorOrder.length || finalDesiredOrder.some((stickerId, index) => anchorOrder[index] !== stickerId));
    if (needsReorder) {
      try {
        await stickerPackService.reorderPackItems({
          ownerJid: anchorPack.owner_jid,
          identifier: anchorPack.id,
          orderStickerIds: finalDesiredOrder,
        });
        anchorItems = await listStickerPackItems(anchorPack.id);
        itemsByPackId.set(anchorPack.id, anchorItems);
      } catch (error) {
        logger.warn('Falha ao reordenar pack âncora na consolidação retroativa.', {
          action: 'sticker_auto_pack_retro_reorder_failed',
          pack_id: anchorPack.id,
          theme_key: themeKey,
          error: error?.message,
          error_code: error?.code,
        });
      }
    }

    for (const donor of donorPacks) {
      if (mutations >= RETRO_CONSOLIDATION_MUTATION_LIMIT) break;
      try {
        await deleteAutoPackWithItems(donor.id, itemsByPackId);
        mutations += 1;
        deletedPacks += 1;
      } catch (error) {
        logger.warn('Falha ao excluir pack doador na consolidação retroativa.', {
          action: 'sticker_auto_pack_retro_delete_donor_failed',
          pack_id: donor.id,
          theme_key: themeKey,
          error: error?.message,
        });
      }
    }

    anchorItems = itemsByPackId.get(anchorPack.id) || (await listStickerPackItems(anchorPack.id));
    const anchorCount = anchorItems.length;
    if (anchorCount < HARD_MIN_PACK_ITEMS) {
      if (mutations < RETRO_CONSOLIDATION_MUTATION_LIMIT) {
        try {
          await deleteAutoPackWithItems(anchorPack.id, itemsByPackId);
          mutations += 1;
          deletedPacks += 1;
        } catch (error) {
          logger.warn('Falha ao excluir pack âncora abaixo do mínimo na consolidação retroativa.', {
            action: 'sticker_auto_pack_retro_delete_anchor_failed',
            pack_id: anchorPack.id,
            theme_key: themeKey,
            error: error?.message,
          });
        }
      } else {
        mutationLimitReached = true;
      }
      continue;
    }

    const parsedTheme = parseThemeKey(themeKey);
    const resolvedTheme = parsedTheme.theme || normalizeTag(anchorPack.pack_theme_key || '') || 'outros';
    const resolvedSubtheme = sanitizeDisplaySubtheme(parsedTheme.subtheme);
    const packStatus = anchorCount >= READY_PACK_MIN_ITEMS ? 'ready' : 'building';
    await updateAutoPackMetadata(anchorPack.id, {
      name: buildAutoPackName(resolvedTheme, resolvedSubtheme, 1),
      description: buildAutoPackDescription({
        theme: resolvedTheme,
        subtheme: resolvedSubtheme,
        themeKey,
        groupScore: 0,
      }),
      themeKey,
      volume: 1,
      pack_status: packStatus,
      status: packStatus === 'ready' ? 'published' : 'draft',
      cover_sticker_id: anchorItems[0]?.sticker_id || null,
    });
    mergedThemes += 1;
  }

  return {
    enabled: true,
    processed_themes: processedThemes,
    merged_themes: mergedThemes,
    deleted_packs: deletedPacks,
    moved_stickers: movedStickers,
    trimmed_stickers: trimmedStickers,
    mutations,
    theme_limit_reached: themeLimitReached,
    mutation_limit_reached: mutationLimitReached,
  };
};

const optimizePackEcosystem = ({ operations, itemsByPackId, classificationByAssetId, packEngagementByPackId = new Map() }) => {
  if (!ENABLE_GLOBAL_OPTIMIZATION) {
    return {
      enabled: false,
      cycles_effective: 0,
      transfer_moves: 0,
      merge_moves: 0,
      matrix_merge_moves: 0,
      archived_packs: 0,
      tier_gold: 0,
      tier_silver: 0,
      tier_bronze: 0,
      energy_initial: 0,
      energy_final: 0,
      energy_gain: 0,
      cycle_gains: [],
      stable_gain_cycles: 0,
      tier_mean_asset_quality: { gold: 0, silver: 0, bronze: 0 },
      tier_archive: 0,
      interpack_similarity_mean: 0,
      entropy_mean_global: 0,
    };
  }

  const scopedOps = (Array.isArray(operations) ? operations : []).filter((op) => op?.type === 'reconcile_volume' && op?.existingPackId).sort((left, right) => String(left.sort_key || '').localeCompare(String(right.sort_key || '')));

  if (!scopedOps.length) {
    return {
      enabled: true,
      cycles_effective: 0,
      transfer_moves: 0,
      merge_moves: 0,
      matrix_merge_moves: 0,
      archived_packs: 0,
      tier_gold: 0,
      tier_silver: 0,
      tier_bronze: 0,
      energy_initial: 0,
      energy_final: 0,
      energy_gain: 0,
      cycle_gains: [],
      stable_gain_cycles: 0,
      tier_mean_asset_quality: { gold: 0, silver: 0, bronze: 0 },
      tier_archive: 0,
      interpack_similarity_mean: 0,
      entropy_mean_global: 0,
    };
  }

  const stateByPackId = new Map(
    scopedOps.map((op) => {
      const initialItems = itemsByPackId.get(op.existingPackId) || [];
      const stickers = new Set(initialItems.map((item) => item?.sticker_id).filter(Boolean));
      return [
        op.existingPackId,
        {
          packId: op.existingPackId,
          op,
          themeKey: String(op.themeKey || ''),
          stickers,
          tier: 'BRONZE',
        },
      ];
    }),
  );

  const computeProfiles = () => {
    const profiles = new Map();
    for (const [packId, state] of stateByPackId.entries()) {
      profiles.set(
        packId,
        computePackProfile({
          packId,
          stickerIds: Array.from(state.stickers),
          themeKey: state.themeKey,
          classificationByAssetId,
        }),
      );
    }
    return profiles;
  };

  const getEngagementScore = (packId) => computePackEngagementScore(packEngagementByPackId.get(packId));
  const engagementScoreByPackId = new Map(Array.from(stateByPackId.keys()).map((packId) => [packId, Number(getEngagementScore(packId) || 0)]));
  const engagementZscoreByPackId = buildNormalizedZScoreMap(engagementScoreByPackId);
  const getEngagementZscore = (packId) => Number(engagementZscoreByPackId.get(packId) || 0);

  const scoreProfile = (profile) =>
    computePackObjectiveScore({
      profile,
      engagementScore: Number(getEngagementScore(profile?.packId) || 0),
    });
  const scoreQualityProfile = (profile) =>
    computePackOfficialQualityScore({
      profile,
      engagementZscore: getEngagementZscore(profile?.packId),
    });

  const buildProfileScoreMap = (profiles) => {
    const map = new Map();
    for (const [packId, profile] of profiles.entries()) {
      map.set(packId, Number(scoreProfile(profile).toFixed(6)));
    }
    return map;
  };

  const buildQualityScoreMap = (profiles) => {
    const map = new Map();
    for (const [packId, profile] of profiles.entries()) {
      map.set(packId, Number(scoreQualityProfile(profile).toFixed(6)));
    }
    return map;
  };

  const computeSystemEnergy = (profiles, profileScores = buildProfileScoreMap(profiles)) => {
    const profileList = Array.from(profiles.values());
    const qualitySum = sumArray(profileList.map((entry) => Number(profileScores.get(entry.packId) || 0)));
    let overlapSum = 0;
    let overlapPairs = 0;
    for (let i = 0; i < profileList.length; i += 1) {
      for (let j = i + 1; j < profileList.length; j += 1) {
        overlapSum += computePackOverlap(profileList[i], profileList[j]);
        overlapPairs += 1;
      }
    }
    const redundancy = overlapPairs > 0 ? overlapSum / overlapPairs : 0;
    const redundancyPenalty = SYSTEM_REDUNDANCY_LAMBDA * GLOBAL_ENERGY_W5 * redundancy;
    const energy = qualitySum - redundancyPenalty;
    return {
      qualitySum: Number(qualitySum.toFixed(6)),
      overlapSum: Number(overlapSum.toFixed(6)),
      overlapPairs,
      redundancy: Number(redundancy.toFixed(6)),
      redundancyPenalty: Number(redundancyPenalty.toFixed(6)),
      energy: Number(energy.toFixed(6)),
      profileScores,
    };
  };

  const assignTiers = (profiles, qualityScores) => {
    let gold = 0;
    let silver = 0;
    let bronze = 0;
    let archive = 0;
    for (const [packId] of profiles.entries()) {
      const state = stateByPackId.get(packId);
      if (!state) continue;
      const score = Number(qualityScores.get(packId) || 0);
      state.qualityScore = score;
      if (score >= PACK_TIER_GOLD_THRESHOLD) {
        state.tier = 'GOLD';
        gold += 1;
      } else if (score >= PACK_TIER_SILVER_THRESHOLD) {
        state.tier = 'SILVER';
        silver += 1;
      } else if (score >= PACK_TIER_BRONZE_THRESHOLD) {
        state.tier = 'BRONZE';
        bronze += 1;
      } else {
        state.tier = 'ARCHIVE';
        archive += 1;
      }
    }
    return { gold, silver, bronze, archive };
  };

  const computeTierMeanAssetQuality = () => {
    const totals = new Map([
      ['GOLD', { sum: 0, count: 0 }],
      ['SILVER', { sum: 0, count: 0 }],
      ['BRONZE', { sum: 0, count: 0 }],
    ]);

    for (const state of stateByPackId.values()) {
      const tier = ['GOLD', 'SILVER', 'BRONZE'].includes(state.tier) ? state.tier : 'BRONZE';
      const parsedTheme = parseThemeKey(state.themeKey);
      for (const stickerId of state.stickers) {
        const classification = classificationByAssetId.get(stickerId);
        if (!classification) continue;
        const topTags = buildTopTags(classification);
        const quality = computeAssetQualityForTheme({
          classification,
          theme: parsedTheme.theme,
          subtheme: parsedTheme.subtheme,
          topTags,
        });
        const bucket = totals.get(tier);
        bucket.sum += Number(quality.assetQuality || 0);
        bucket.count += 1;
      }
    }

    const meanByTier = {};
    for (const [tier, bucket] of totals.entries()) {
      const mean = bucket.count ? bucket.sum / bucket.count : 0;
      meanByTier[tier.toLowerCase()] = Number(mean.toFixed(6));
    }
    return meanByTier;
  };

  const collectStickerIds = () => {
    const ids = new Set();
    for (const state of stateByPackId.values()) {
      for (const stickerId of state.stickers) {
        if (stickerId) ids.add(stickerId);
      }
    }
    return Array.from(ids);
  };

  let profiles = computeProfiles();
  let profileScores = buildProfileScoreMap(profiles);
  let qualityScores = buildQualityScoreMap(profiles);
  let energySnapshot = computeSystemEnergy(profiles, profileScores);
  const energyInitial = energySnapshot.energy;
  let transferMoves = 0;
  let mergeMoves = 0;
  let matrixMergeMoves = 0;
  let archivedPacks = 0;
  let cyclesEffective = 0;
  const cycleGains = [];
  let stableGainCycles = 0;
  let tierSnapshot = assignTiers(profiles, qualityScores);
  let interPackSimilaritySnapshot = buildInterPackSimilarityMatrix(profiles);

  for (let cycle = 0; cycle < OPTIMIZATION_CYCLES; cycle += 1) {
    cyclesEffective += 1;
    const cycleStartEnergy = energySnapshot.energy;
    let cycleTransfers = 0;
    let cycleMerges = 0;
    let cycleArchives = 0;

    const packStates = Array.from(stateByPackId.values());
    const orderedSources = [...packStates].sort((left, right) => {
      const leftQuality = Number(qualityScores.get(left.packId) || 0);
      const rightQuality = Number(qualityScores.get(right.packId) || 0);
      if (leftQuality !== rightQuality) return leftQuality - rightQuality;
      if (right.stickers.size !== left.stickers.size) return right.stickers.size - left.stickers.size;
      return String(left.packId || '').localeCompare(String(right.packId || ''));
    });

    for (const source of orderedSources) {
      const sourceStickerIds = Array.from(source.stickers);
      for (const stickerId of sourceStickerIds) {
        if (!source.stickers.has(stickerId)) continue;
        if (source.stickers.size <= 1) break;

        const sourceProfile = profiles.get(source.packId);
        const sourceScore = Number(profileScores.get(source.packId) || 0);
        const sourceQuality = Number(qualityScores.get(source.packId) || 0);
        if (!sourceProfile || !Number.isFinite(sourceScore) || !Number.isFinite(sourceQuality)) continue;

        const recipientCandidates = packStates
          .filter((recipient) => recipient.packId !== source.packId && !recipient.stickers.has(stickerId) && recipient.stickers.size < TARGET_PACK_SIZE)
          .map((recipient) => {
            const recipientProfile = profiles.get(recipient.packId);
            const recipientScore = Number(profileScores.get(recipient.packId) || 0);
            const recipientQuality = Number(qualityScores.get(recipient.packId) || 0);
            if (!recipientProfile || !Number.isFinite(recipientScore) || !Number.isFinite(recipientQuality)) {
              return null;
            }
            const semanticSimilarity = computePackSemanticSimilarity(sourceProfile, recipientProfile);
            const sameTheme = source.themeKey && recipient.themeKey && source.themeKey === recipient.themeKey;
            if (!sameTheme && semanticSimilarity < EFFECTIVE_TRANSFER_CANDIDATE_SIMILARITY_FLOOR) {
              return null;
            }
            const candidateRank = semanticSimilarity * 0.85 + (sameTheme ? 0.15 : 0) + Math.max(0, recipientQuality - sourceQuality) * 0.1;
            return {
              recipient,
              recipientScore,
              recipientQuality,
              candidateRank,
            };
          })
          .filter(Boolean)
          .sort((left, right) => right.candidateRank - left.candidateRank)
          .slice(0, EFFECTIVE_MIGRATION_CANDIDATE_LIMIT);

        let bestMove = null;
        for (const candidate of recipientCandidates) {
          const sourceNext = new Set(source.stickers);
          sourceNext.delete(stickerId);
          if (sourceNext.size === 0) continue;

          const recipientNext = new Set(candidate.recipient.stickers);
          recipientNext.add(stickerId);

          const sourceNextProfile = computePackProfile({
            packId: source.packId,
            stickerIds: Array.from(sourceNext),
            themeKey: source.themeKey,
            classificationByAssetId,
          });
          const recipientNextProfile = computePackProfile({
            packId: candidate.recipient.packId,
            stickerIds: Array.from(recipientNext),
            themeKey: candidate.recipient.themeKey,
            classificationByAssetId,
          });

          const sourceNextScore = Number(scoreProfile(sourceNextProfile).toFixed(6));
          const recipientNextScore = Number(scoreProfile(recipientNextProfile).toFixed(6));
          const sourceNextQuality = Number(scoreQualityProfile(sourceNextProfile).toFixed(6));
          const recipientNextQuality = Number(scoreQualityProfile(recipientNextProfile).toFixed(6));

          const changes = new Map([
            [source.packId, { profile: sourceNextProfile, score: sourceNextScore }],
            [candidate.recipient.packId, { profile: recipientNextProfile, score: recipientNextScore }],
          ]);
          const deltaPreview = computePackEnergyDelta({
            baseEnergySnapshot: energySnapshot,
            profiles,
            profileScores,
            changes,
          });
          if (!bestMove || deltaPreview.deltaEnergy > bestMove.deltaEnergy) {
            bestMove = {
              recipient: candidate.recipient,
              sourceNext,
              recipientNext,
              sourceNextProfile,
              recipientNextProfile,
              sourceNextScore,
              recipientNextScore,
              sourceNextQuality,
              recipientNextQuality,
              deltaEnergy: deltaPreview.deltaEnergy,
              nextSnapshot: deltaPreview.nextSnapshot,
            };
          }
        }

        if (bestMove && bestMove.deltaEnergy > EFFECTIVE_TRANSFER_THRESHOLD) {
          source.stickers = bestMove.sourceNext;
          bestMove.recipient.stickers = bestMove.recipientNext;
          profiles.set(source.packId, bestMove.sourceNextProfile);
          profiles.set(bestMove.recipient.packId, bestMove.recipientNextProfile);
          profileScores.set(source.packId, bestMove.sourceNextScore);
          profileScores.set(bestMove.recipient.packId, bestMove.recipientNextScore);
          qualityScores.set(source.packId, bestMove.sourceNextQuality);
          qualityScores.set(bestMove.recipient.packId, bestMove.recipientNextQuality);
          energySnapshot = {
            ...bestMove.nextSnapshot,
            profileScores,
          };
          cycleTransfers += 1;
          transferMoves += 1;
        }
      }
    }

    profiles = computeProfiles();
    profileScores = buildProfileScoreMap(profiles);
    qualityScores = buildQualityScoreMap(profiles);
    energySnapshot = computeSystemEnergy(profiles, profileScores);

    interPackSimilaritySnapshot = buildInterPackSimilarityMatrix(profiles);
    const packStatesForMerge = Array.from(stateByPackId.values());
    for (let i = 0; i < packStatesForMerge.length; i += 1) {
      for (let j = i + 1; j < packStatesForMerge.length; j += 1) {
        const left = packStatesForMerge[i];
        const right = packStatesForMerge[j];
        if (!left.stickers.size || !right.stickers.size) continue;

        const pairKey = buildPackPairKey(left.packId, right.packId);
        const similarity = Number(interPackSimilaritySnapshot.matrix.get(pairKey) || 0);
        if (similarity < EFFECTIVE_INTER_PACK_SIMILARITY_THRESHOLD) continue;

        const leftQuality = Number(qualityScores.get(left.packId) || 0);
        const rightQuality = Number(qualityScores.get(right.packId) || 0);
        if (leftQuality === rightQuality) continue;
        const recipient = leftQuality > rightQuality ? left : right;
        const donor = recipient.packId === left.packId ? right : left;

        const recipientProfile = profiles.get(recipient.packId);
        const donorProfile = profiles.get(donor.packId);
        if (!recipientProfile || !donorProfile) continue;

        const mergedIds = Array.from(new Set([...recipient.stickers, ...donor.stickers]));
        const mergedProfileRaw = computePackProfile({
          packId: recipient.packId,
          stickerIds: mergedIds,
          themeKey: recipient.themeKey,
          classificationByAssetId,
        });

        let keptIds = mergedIds;
        if (mergedIds.length > TARGET_PACK_SIZE) {
          const scored = mergedIds
            .map((stickerId) => ({
              stickerId,
              score: computeStickerPackMatrixScore({
                stickerId,
                packStickerIds: mergedIds,
                classificationByAssetId,
                centroidVector: mergedProfileRaw.centroidVector,
              }),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, TARGET_PACK_SIZE);
          keptIds = scored.map((entry) => entry.stickerId);
        }

        const mergedProfile = computePackProfile({
          packId: recipient.packId,
          stickerIds: keptIds,
          themeKey: recipient.themeKey,
          classificationByAssetId,
        });
        const donorNextProfile = computePackProfile({
          packId: donor.packId,
          stickerIds: [],
          themeKey: donor.themeKey,
          classificationByAssetId,
        });
        const mergedScore = Number(scoreProfile(mergedProfile).toFixed(6));
        const donorNextScore = Number(scoreProfile(donorNextProfile).toFixed(6));
        const mergedQuality = Number(scoreQualityProfile(mergedProfile).toFixed(6));
        const donorNextQuality = Number(scoreQualityProfile(donorNextProfile).toFixed(6));

        const changes = new Map([
          [recipient.packId, { profile: mergedProfile, score: mergedScore }],
          [donor.packId, { profile: donorNextProfile, score: donorNextScore }],
        ]);
        const deltaPreview = computePackEnergyDelta({
          baseEnergySnapshot: energySnapshot,
          profiles,
          profileScores,
          changes,
        });
        if (deltaPreview.deltaEnergy <= EFFECTIVE_TRANSFER_THRESHOLD) continue;

        recipient.stickers = new Set(keptIds);
        donor.stickers = new Set();
        profiles.set(recipient.packId, mergedProfile);
        profiles.set(donor.packId, donorNextProfile);
        profileScores.set(recipient.packId, mergedScore);
        profileScores.set(donor.packId, donorNextScore);
        qualityScores.set(recipient.packId, mergedQuality);
        qualityScores.set(donor.packId, donorNextQuality);
        energySnapshot = {
          ...deltaPreview.nextSnapshot,
          profileScores,
        };
        cycleMerges += 1;
        mergeMoves += 1;
        matrixMergeMoves += 1;
      }
    }

    profiles = computeProfiles();
    profileScores = buildProfileScoreMap(profiles);
    qualityScores = buildQualityScoreMap(profiles);
    energySnapshot = computeSystemEnergy(profiles, profileScores);

    if (ARCHIVE_LOW_SCORE_PACKS) {
      const qualityValues = Array.from(qualityScores.values()).filter((value) => Number.isFinite(value));
      const archiveCut = percentileValue(qualityValues, EFFECTIVE_AUTO_ARCHIVE_BELOW_PERCENTILE);
      for (const state of stateByPackId.values()) {
        if (!state.stickers.size) continue;
        if (state.stickers.size >= MIN_PACK_SIZE) continue;
        const qualityScore = Number(qualityScores.get(state.packId) || 0);
        if (qualityScore > archiveCut) continue;

        const nextProfile = computePackProfile({
          packId: state.packId,
          stickerIds: [],
          themeKey: state.themeKey,
          classificationByAssetId,
        });
        const nextScore = Number(scoreProfile(nextProfile).toFixed(6));
        const nextQuality = Number(scoreQualityProfile(nextProfile).toFixed(6));
        const changes = new Map([[state.packId, { profile: nextProfile, score: nextScore }]]);
        const deltaPreview = computePackEnergyDelta({
          baseEnergySnapshot: energySnapshot,
          profiles,
          profileScores,
          changes,
        });
        if (deltaPreview.deltaEnergy <= EFFECTIVE_TRANSFER_THRESHOLD) continue;

        state.stickers = new Set();
        profiles.set(state.packId, nextProfile);
        profileScores.set(state.packId, nextScore);
        qualityScores.set(state.packId, nextQuality);
        energySnapshot = {
          ...deltaPreview.nextSnapshot,
          profileScores,
        };
        cycleArchives += 1;
        archivedPacks += 1;
      }
    }

    profiles = computeProfiles();
    profileScores = buildProfileScoreMap(profiles);
    qualityScores = buildQualityScoreMap(profiles);
    tierSnapshot = assignTiers(profiles, qualityScores);
    const nextEnergySnapshot = computeSystemEnergy(profiles, profileScores);
    interPackSimilaritySnapshot = buildInterPackSimilarityMatrix(profiles);
    const gain = nextEnergySnapshot.energy - cycleStartEnergy;
    cycleGains.push(Number(gain.toFixed(6)));
    energySnapshot = nextEnergySnapshot;
    if (Math.abs(gain) < OPTIMIZATION_EPSILON) {
      stableGainCycles += 1;
    } else {
      stableGainCycles = 0;
    }

    if (stableGainCycles >= OPTIMIZATION_STABLE_CYCLES) {
      break;
    }

    if (Math.abs(gain) < OPTIMIZATION_EPSILON && cycleTransfers === 0 && cycleMerges === 0 && cycleArchives === 0) {
      break;
    }
  }

  for (const state of stateByPackId.values()) {
    const op = state.op;
    if (!op) continue;
    const finalStickerIds = Array.from(state.stickers);
    const finalProfile = computePackProfile({
      packId: state.packId,
      stickerIds: finalStickerIds,
      themeKey: state.themeKey,
      classificationByAssetId,
    });
    const ordered = finalStickerIds
      .map((stickerId) => ({
        stickerId,
        score: computeStickerPackMatrixScore({
          stickerId,
          packStickerIds: finalStickerIds,
          classificationByAssetId,
          centroidVector: finalProfile.centroidVector,
        }),
      }))
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.stickerId);

    op.desiredAssetIds = ordered.slice(0, TARGET_PACK_SIZE);
    op.fillAssetIds = [];
    op.qualityTier = state.tier === 'ARCHIVE' ? 'BRONZE' : state.tier;
    const currentItems = itemsByPackId.get(state.packId) || [];
    const currentSet = new Set(currentItems.map((item) => item?.sticker_id).filter(Boolean));
    const desiredSet = new Set(op.desiredAssetIds);
    const removedByOptimization = Array.from(currentSet).filter((stickerId) => !desiredSet.has(stickerId));
    if (removedByOptimization.length) {
      op.forceRemoveAssetIds = Array.from(new Set([...(Array.isArray(op.forceRemoveAssetIds) ? op.forceRemoveAssetIds : []), ...removedByOptimization]));
    }
    if (state.tier === 'ARCHIVE') {
      op.desiredAssetIds = [];
      op.fillAssetIds = [];
      op.type = 'archive_volume';
    } else if (!op.desiredAssetIds.length) {
      op.type = 'archive_volume';
    }
  }

  const entropyMeanGlobal = Number(computeMeanNormalizedEntropy(collectStickerIds(), classificationByAssetId).toFixed(6));

  return {
    enabled: true,
    cycles_effective: cyclesEffective,
    transfer_moves: transferMoves,
    merge_moves: mergeMoves,
    matrix_merge_moves: matrixMergeMoves,
    archived_packs: archivedPacks,
    tier_gold: tierSnapshot.gold,
    tier_silver: tierSnapshot.silver,
    tier_bronze: tierSnapshot.bronze,
    tier_archive: tierSnapshot.archive,
    energy_initial: Number(energyInitial.toFixed(6)),
    energy_final: Number(energySnapshot.energy.toFixed(6)),
    energy_gain: Number((energySnapshot.energy - energyInitial).toFixed(6)),
    cycle_gains: cycleGains,
    stable_gain_cycles: stableGainCycles,
    tier_mean_asset_quality: computeTierMeanAssetQuality(),
    interpack_similarity_mean: Number(interPackSimilaritySnapshot.similarity_mean || 0),
    entropy_mean_global: entropyMeanGlobal,
  };
};

const buildCurationExecutionPlan = async ({ curatedGroups, ownerPool, enableAdditions }) => {
  const autoPacks = await listStickerAutoPacksForCuration({
    ownerJids: ownerPool,
    includeArchived: true,
    limit: 5000,
  });
  const autoPackIndex = buildAutoPackIndex(autoPacks);
  const ownerStates = await buildOwnerCapacityState(ownerPool);

  const packIds = autoPacks.map((pack) => pack.id).filter(Boolean);
  const engagementByPackId = packIds.length ? await listStickerPackEngagementByPackIds(packIds) : new Map();
  const allItems = packIds.length ? await listStickerPackItemsByPackIds(packIds) : [];
  const itemsByPackId = new Map();
  for (const item of allItems) {
    const list = itemsByPackId.get(item.pack_id) || [];
    list.push(item);
    itemsByPackId.set(item.pack_id, list);
  }

  const classificationByAssetId = new Map();
  const operations = [];
  let plannedCreates = 0;
  let reuseOnlyMode = false;
  let overflowVolumesSkipped = 0;
  let completionPriorityGroups = 0;
  let plannedCompletionTransfers = 0;
  const staticGroupLimit = MAX_TAG_GROUPS > 0 ? MAX_TAG_GROUPS : Number.POSITIVE_INFINITY;
  const dynamicGroupLimit = Math.max(3, DYNAMIC_GROUP_LIMIT_BASE - autoPackIndex.byTheme.size);
  const effectiveGroupLimit = Math.max(0, Math.min(curatedGroups.length, staticGroupLimit, dynamicGroupLimit));
  const effectiveCuratedGroups = curatedGroups.slice(0, effectiveGroupLimit);
  const groupsSkippedByDynamicLimit = Math.max(0, curatedGroups.length - effectiveCuratedGroups.length);
  let creationBlockedByGlobalCap = 0;

  for (const group of effectiveCuratedGroups) {
    for (const candidate of group.candidates) {
      if (candidate?.asset?.id && candidate?.classification) {
        classificationByAssetId.set(candidate.asset.id, candidate.classification);
      }
    }

    const currentThemePacks = sortAutoThemePacks(autoPackIndex.byTheme.get(group.themeKey) || []);
    const rankedThemePacks = [...currentThemePacks].sort((left, right) => {
      const leftArchived = String(left?.pack_status || 'ready').toLowerCase() === 'archived' ? 1 : 0;
      const rightArchived = String(right?.pack_status || 'ready').toLowerCase() === 'archived' ? 1 : 0;
      if (leftArchived !== rightArchived) return leftArchived - rightArchived;
      const leftCount = Number(itemsByPackId.get(left.id)?.length || 0);
      const rightCount = Number(itemsByPackId.get(right.id)?.length || 0);
      if (rightCount !== leftCount) return rightCount - leftCount;
      return extractVolumeFromPack(left) - extractVolumeFromPack(right);
    });
    const retainedThemePacks = rankedThemePacks.slice(0, MAX_PACKS_PER_THEME);
    const packCountById = new Map(retainedThemePacks.map((pack) => [pack.id, Number(itemsByPackId.get(pack.id)?.length || 0)]));
    const packItemsById = new Map(retainedThemePacks.map((pack) => [pack.id, new Set((itemsByPackId.get(pack.id) || []).map((item) => item.sticker_id).filter(Boolean))]));
    const incompleteExistingCount = retainedThemePacks.reduce((sum, pack) => {
      const count = Number(packCountById.get(pack.id) || 0);
      return sum + (count < TARGET_PACK_SIZE ? 1 : 0);
    }, 0);
    const prioritizeGroupCompletion = EFFECTIVE_PRIORITIZE_COMPLETION && enableAdditions && incompleteExistingCount > 0;
    const completionPriorityPacks = prioritizeGroupCompletion
      ? [...retainedThemePacks].sort((left, right) => {
          const leftCount = Number(packCountById.get(left.id) || 0);
          const rightCount = Number(packCountById.get(right.id) || 0);
          if (rightCount !== leftCount) return rightCount - leftCount;
          return extractVolumeFromPack(left) - extractVolumeFromPack(right);
        })
      : [];
    const volumeCandidateChunks = chunkArray(group.candidates.map((candidate) => candidate.asset.id).filter(Boolean), TARGET_PACK_SIZE);
    const groupFillAssetIds = group.candidates.map((candidate) => candidate.asset.id).filter(Boolean);

    const ownerCreateCapacity = ownerStates.reduce((sum, owner) => sum + Math.max(0, Number(owner.available || 0)), 0);
    const hasIncompleteExisting = incompleteExistingCount > 0;
    const themeCreateCapacity = Math.max(0, MAX_PACKS_PER_THEME - retainedThemePacks.length);
    const globalCreateCapacity = Math.max(0, GLOBAL_AUTO_PACK_LIMIT - (autoPacks.length + plannedCreates));
    const maxCreatableForGroup = enableAdditions && !hasIncompleteExisting ? Math.max(0, Math.min(ownerCreateCapacity, themeCreateCapacity, globalCreateCapacity)) : 0;
    if (enableAdditions && !hasIncompleteExisting && themeCreateCapacity > 0 && globalCreateCapacity <= 0) {
      creationBlockedByGlobalCap += 1;
    }
    const maxTotalVolumes = retainedThemePacks.length + maxCreatableForGroup;
    let targetVolumeCount = Math.min(volumeCandidateChunks.length, Math.max(0, maxTotalVolumes));
    if (prioritizeGroupCompletion) {
      targetVolumeCount = Math.max(targetVolumeCount, retainedThemePacks.length);
      completionPriorityGroups += 1;
    }

    if (volumeCandidateChunks.length > targetVolumeCount) {
      reuseOnlyMode = true;
      overflowVolumesSkipped += volumeCandidateChunks.length - targetVolumeCount;
    }

    const targetChunks = volumeCandidateChunks.slice(0, targetVolumeCount);
    const groupOpStartIndex = operations.length;
    const selectedExistingPackIds = new Set();

    for (let volumeIndex = 0; volumeIndex < targetVolumeCount; volumeIndex += 1) {
      const volume = volumeIndex + 1;
      const existingPack = prioritizeGroupCompletion ? completionPriorityPacks[volumeIndex] || retainedThemePacks.find((pack) => extractVolumeFromPack(pack) === volume) || retainedThemePacks[volumeIndex] || null : retainedThemePacks.find((pack) => extractVolumeFromPack(pack) === volume) || retainedThemePacks[volumeIndex] || null;
      if (existingPack?.id) {
        selectedExistingPackIds.add(existingPack.id);
      }

      let createOwnerJid = null;
      if (!existingPack && enableAdditions) {
        if (autoPacks.length + plannedCreates >= GLOBAL_AUTO_PACK_LIMIT) {
          reuseOnlyMode = true;
          creationBlockedByGlobalCap += 1;
        } else {
          const selectedOwner = pickOwnerWithCapacity(ownerStates);
          if (selectedOwner) {
            createOwnerJid = selectedOwner.ownerJid;
            selectedOwner.available = Math.max(0, Number(selectedOwner.available || 0) - 1);
            selectedOwner.totalPacks = Number(selectedOwner.totalPacks || 0) + 1;
            plannedCreates += 1;
          } else {
            reuseOnlyMode = true;
          }
        }
      }

      operations.push({
        type: 'reconcile_volume',
        sort_key: `${group.themeKey}#${String(volume).padStart(6, '0')}`,
        theme: group.theme,
        subtheme: group.subtheme,
        themeKey: group.themeKey,
        volume,
        groupScore: group.groupScore,
        cohesion: group.cohesion,
        desiredAssetIds: targetChunks[volumeIndex] || [],
        fillAssetIds: groupFillAssetIds,
        existingPackId: existingPack?.id || null,
        ownerJid: existingPack?.owner_jid || createOwnerJid || null,
        ownerCandidates: existingPack ? [existingPack.owner_jid].filter(Boolean) : [createOwnerJid, ...ownerPool.filter((owner) => owner && owner !== createOwnerJid)].filter(Boolean),
      });
    }

    for (const pack of currentThemePacks) {
      if (selectedExistingPackIds.has(pack.id)) continue;
      const volume = extractVolumeFromPack(pack);

      operations.push({
        type: 'archive_volume',
        sort_key: `${group.themeKey}#${String(volume).padStart(6, '0')}#archive`,
        theme: group.theme,
        subtheme: group.subtheme,
        themeKey: group.themeKey,
        volume,
        groupScore: group.groupScore,
        cohesion: group.cohesion,
        desiredAssetIds: [],
        existingPackId: pack.id,
        ownerJid: pack.owner_jid,
        ownerCandidates: [pack.owner_jid].filter(Boolean),
      });
    }

    if (prioritizeGroupCompletion && EFFECTIVE_COMPLETION_TRANSFER_ENABLED && retainedThemePacks.length > 1) {
      const groupOps = operations.slice(groupOpStartIndex).filter((entry) => entry.type === 'reconcile_volume' && entry.existingPackId);
      const recipientOps = [...groupOps].sort((left, right) => {
        const leftCount = Number(packCountById.get(left.existingPackId) || 0);
        const rightCount = Number(packCountById.get(right.existingPackId) || 0);
        if (rightCount !== leftCount) return rightCount - leftCount;
        return Number(left.volume || 0) - Number(right.volume || 0);
      });
      const donorOps = [...groupOps].sort((left, right) => {
        const leftCount = Number(packCountById.get(left.existingPackId) || 0);
        const rightCount = Number(packCountById.get(right.existingPackId) || 0);
        if (leftCount !== rightCount) return leftCount - rightCount;
        return Number(left.volume || 0) - Number(right.volume || 0);
      });

      let groupTransfers = 0;
      for (const recipientOp of recipientOps) {
        const recipientPackId = recipientOp.existingPackId;
        const recipientCount = Number(packCountById.get(recipientPackId) || 0);
        if (recipientCount <= 0) continue;
        const recipientDesired = new Set((Array.isArray(recipientOp.desiredAssetIds) ? recipientOp.desiredAssetIds : []).filter(Boolean));
        if (!recipientDesired.size) continue;

        for (const assetId of recipientDesired) {
          for (const donorOp of donorOps) {
            const donorPackId = donorOp.existingPackId;
            if (!donorPackId || donorPackId === recipientPackId) continue;

            const donorCount = Number(packCountById.get(donorPackId) || 0);
            if (donorCount >= recipientCount) continue;
            if (donorCount < COMPLETION_TRANSFER_MIN_DONOR_ITEMS) continue;

            const donorItems = packItemsById.get(donorPackId);
            if (!donorItems || !donorItems.has(assetId)) continue;

            donorOp.forceRemoveAssetIds = Array.from(new Set([...(Array.isArray(donorOp.forceRemoveAssetIds) ? donorOp.forceRemoveAssetIds : []), assetId]));
            donorOp.desiredAssetIds = (Array.isArray(donorOp.desiredAssetIds) ? donorOp.desiredAssetIds : []).filter((id) => id !== assetId);
            donorOp.fillAssetIds = (Array.isArray(donorOp.fillAssetIds) ? donorOp.fillAssetIds : []).filter((id) => id !== assetId);
            packCountById.set(donorPackId, Math.max(0, donorCount - 1));
            groupTransfers += 1;
            break;
          }
        }
      }

      plannedCompletionTransfers += groupTransfers;
    }
  }

  operations.sort((left, right) => String(left.sort_key || '').localeCompare(String(right.sort_key || '')));
  const optimizationAssetIds = new Set();
  for (const op of operations) {
    if (op?.existingPackId && op?.type === 'reconcile_volume') {
      const currentItems = itemsByPackId.get(op.existingPackId) || [];
      for (const item of currentItems) {
        if (item?.sticker_id) optimizationAssetIds.add(item.sticker_id);
      }
    }
    for (const assetId of Array.isArray(op?.desiredAssetIds) ? op.desiredAssetIds : []) {
      if (assetId) optimizationAssetIds.add(assetId);
    }
  }

  const missingClassificationAssetIds = Array.from(optimizationAssetIds).filter((assetId) => !classificationByAssetId.has(assetId));
  for (const batch of chunkArray(missingClassificationAssetIds, 400)) {
    const rows = await listStickerClassificationsByAssetIds(batch);
    for (const row of rows) {
      if (row?.asset_id) classificationByAssetId.set(row.asset_id, row);
    }
  }

  const optimizationStats = optimizePackEcosystem({
    operations,
    itemsByPackId,
    classificationByAssetId,
    packEngagementByPackId: engagementByPackId,
  });

  return {
    operations,
    itemsByPackId,
    classificationByAssetId,
    autoPackIndex,
    stats: {
      owner_pool_size: ownerPool.length,
      owner_available_total: ownerStates.some((owner) => !Number.isFinite(Number(owner.available))) ? 'unlimited' : ownerStates.reduce((sum, owner) => sum + Math.max(0, Number(owner.available || 0)), 0),
      planned_creates: plannedCreates,
      completion_priority_groups: completionPriorityGroups,
      completion_transfers_planned: plannedCompletionTransfers,
      reuse_only_mode: reuseOnlyMode,
      overflow_volumes_skipped: overflowVolumesSkipped,
      hard_min_pack_items: HARD_MIN_PACK_ITEMS,
      max_packs_per_theme: MAX_PACKS_PER_THEME,
      global_auto_pack_limit: GLOBAL_AUTO_PACK_LIMIT,
      creation_blocked_global_cap: creationBlockedByGlobalCap,
      group_limit_static: Number.isFinite(staticGroupLimit) ? staticGroupLimit : null,
      group_limit_dynamic: dynamicGroupLimit,
      groups_input: curatedGroups.length,
      groups_effective: effectiveCuratedGroups.length,
      groups_skipped_dynamic: groupsSkippedByDynamicLimit,
      existing_auto_packs: autoPacks.length,
      auto_pack_items_indexed: allItems.length,
      optimization_scope_assets: optimizationAssetIds.size,
      optimization_missing_classifications: missingClassificationAssetIds.length,
      optimization_classifications_available: classificationByAssetId.size,
      optimization_enabled: optimizationStats.enabled,
      optimization_cycles_effective: optimizationStats.cycles_effective,
      optimization_transfer_moves: optimizationStats.transfer_moves,
      optimization_merge_moves: optimizationStats.merge_moves,
      optimization_matrix_merge_moves: optimizationStats.matrix_merge_moves,
      optimization_archived_packs: optimizationStats.archived_packs,
      optimization_tier_gold: optimizationStats.tier_gold,
      optimization_tier_silver: optimizationStats.tier_silver,
      optimization_tier_bronze: optimizationStats.tier_bronze,
      optimization_tier_archive: optimizationStats.tier_archive,
      optimization_energy_initial: optimizationStats.energy_initial,
      optimization_energy_final: optimizationStats.energy_final,
      optimization_energy_gain: optimizationStats.energy_gain,
      optimization_cycle_gains: optimizationStats.cycle_gains,
      optimization_stable_gain_cycles: optimizationStats.stable_gain_cycles,
      optimization_tier_mean_asset_quality: optimizationStats.tier_mean_asset_quality,
      optimization_interpack_similarity_mean: optimizationStats.interpack_similarity_mean,
      optimization_entropy_mean_global: optimizationStats.entropy_mean_global,
    },
  };
};

const updateAutoPackMetadata = async (packId, payload) => {
  const normalizedPackStatus =
    String(payload?.pack_status || 'building')
      .trim()
      .toLowerCase() || 'building';
  const resolvedWebStatus = String(payload?.status || (normalizedPackStatus === 'ready' ? 'published' : 'draft'))
    .trim()
    .toLowerCase();
  const fields = {
    name: payload.name,
    publisher: AUTO_PUBLISHER,
    description: payload.description,
    visibility: AUTO_PACK_VISIBILITY,
    status: resolvedWebStatus,
    pack_status: normalizedPackStatus,
    pack_theme_key: payload.themeKey,
    pack_volume: payload.volume,
    is_auto_pack: 1,
    last_rebalanced_at: __timeNow(),
  };
  if ('cover_sticker_id' in payload) {
    fields.cover_sticker_id = payload.cover_sticker_id ?? null;
  }
  return updateStickerPackFields(packId, fields);
};

const createAutoPackVolume = async ({ ownerJid, theme, subtheme, themeKey, groupScore, volume }) => {
  return stickerPackService.createPack({
    ownerJid,
    name: buildAutoPackName(theme, subtheme, volume),
    publisher: AUTO_PUBLISHER,
    description: buildAutoPackDescription({ theme, subtheme, themeKey, groupScore }),
    visibility: AUTO_PACK_VISIBILITY,
    status: 'draft',
    packStatus: 'building',
    packThemeKey: themeKey,
    packVolume: volume,
    isAutoPack: true,
    lastRebalancedAt: __timeNow(),
  });
};

const getThemeScoreForPack = (classification, theme) => getScoreByTag(classification, theme);

const reconcileAutoPackVolume = async ({ op, enableAdditions, enableRebuild, budgets, itemsByPackId, classificationByAssetId }) => {
  let pack = op.existingPackId ? await findStickerPackById(op.existingPackId) : null;

  if (!pack && op.type === 'reconcile_volume') {
    const ownerCandidates = Array.from(new Set((Array.isArray(op.ownerCandidates) ? op.ownerCandidates : [op.ownerJid]).filter(Boolean)));
    if (!enableAdditions || !ownerCandidates.length || budgets.added >= MAX_ADDITIONS_PER_CYCLE) {
      return {
        status: 'skipped_no_pack',
        created: 0,
        added: 0,
        removed: 0,
        duplicateSkips: 0,
        packLimitSkips: 0,
      };
    }

    let ownerFullCount = 0;
    for (const ownerCandidate of ownerCandidates) {
      try {
        pack = await createAutoPackVolume({
          ownerJid: ownerCandidate,
          theme: op.theme,
          subtheme: op.subtheme,
          themeKey: op.themeKey,
          groupScore: op.groupScore,
          volume: op.volume,
        });
        break;
      } catch (error) {
        if (error?.code === 'PACK_LIMIT_REACHED') {
          ownerFullCount += 1;
          continue;
        }
        throw error;
      }
    }

    if (!pack) {
      if (ownerFullCount > 0) {
        return {
          status: 'owner_full',
          created: 0,
          added: 0,
          removed: 0,
          duplicateSkips: 0,
          packLimitSkips: ownerFullCount,
        };
      }
      return {
        status: 'skipped_missing_pack',
        created: 0,
        added: 0,
        removed: 0,
        duplicateSkips: 0,
        packLimitSkips: 0,
      };
    }
  }

  if (!pack) {
    return {
      status: 'skipped_missing_pack',
      created: 0,
      added: 0,
      removed: 0,
      duplicateSkips: 0,
      packLimitSkips: 0,
    };
  }

  const desiredPrimaryIds = Array.from(new Set((Array.isArray(op.desiredAssetIds) ? op.desiredAssetIds : []).filter(Boolean)));
  const fillPoolIds = Array.from(new Set((Array.isArray(op.fillAssetIds) ? op.fillAssetIds : []).filter(Boolean))).filter((assetId) => !desiredPrimaryIds.includes(assetId));
  const plannedIds = desiredPrimaryIds.slice();
  if (plannedIds.length < TARGET_PACK_SIZE) {
    for (const assetId of fillPoolIds) {
      if (plannedIds.length >= TARGET_PACK_SIZE) break;
      plannedIds.push(assetId);
    }
  }
  const desiredSet = new Set(plannedIds);
  let removed = 0;
  let added = 0;
  let duplicateSkips = 0;
  let packLimitSkips = 0;
  const created = op.existingPackId ? 0 : 1;
  const feedbackPromises = [];
  const queueFeedback = ({ classification, accepted, assetId }) => {
    const imageHash = String(classification?.image_hash || '')
      .trim()
      .toLowerCase();
    if (!imageHash) return;
    feedbackPromises.push(
      submitStickerClassificationFeedback({
        imageHash,
        theme: op.themeKey || op.theme,
        accepted,
        assetId,
      }),
    );
  };

  await updateAutoPackMetadata(pack.id, {
    name: buildAutoPackName(op.theme, op.subtheme, op.volume),
    description: buildAutoPackDescription({
      theme: op.theme,
      subtheme: op.subtheme,
      themeKey: op.themeKey,
      groupScore: op.groupScore,
    }),
    themeKey: op.themeKey,
    volume: op.volume,
    pack_status: 'building',
    cover_sticker_id: pack.cover_sticker_id || null,
  });

  let currentItems = itemsByPackId.get(pack.id) || (await listStickerPackItems(pack.id));
  const currentById = new Map(currentItems.map((item) => [item.sticker_id, item]));
  const forceRemoveSet = new Set((Array.isArray(op.forceRemoveAssetIds) ? op.forceRemoveAssetIds : []).filter(Boolean));

  const shouldRebuildVolume = enableRebuild || op.type === 'archive_volume' || Number(op.cohesion || 0) < COHESION_REBUILD_THRESHOLD || forceRemoveSet.size > 0;
  if (shouldRebuildVolume && budgets.removed < MAX_REMOVALS_PER_CYCLE) {
    for (const item of currentItems) {
      if (budgets.removed >= MAX_REMOVALS_PER_CYCLE) break;
      if (desiredSet.has(item.sticker_id)) continue;

      const classification = classificationByAssetId.get(item.sticker_id);
      const themeScore = getThemeScoreForPack(classification, op.theme);
      const forcedMoveOut = forceRemoveSet.has(item.sticker_id);
      if (!forcedMoveOut && !enableRebuild && op.type !== 'archive_volume' && themeScore >= MOVE_OUT_THEME_SCORE_THRESHOLD) {
        continue;
      }

      try {
        await stickerPackService.removeStickerFromPack({
          ownerJid: pack.owner_jid,
          identifier: pack.id,
          selector: item.sticker_id,
        });
        budgets.removed += 1;
        removed += 1;
        currentById.delete(item.sticker_id);
        queueFeedback({
          classification,
          accepted: false,
          assetId: item.sticker_id,
        });
      } catch (error) {
        logger.warn('Falha ao remover sticker no rebalance de auto-pack por tags.', {
          action: 'sticker_auto_pack_by_tags_rebalance_remove_failed',
          pack_id: pack.id,
          asset_id: item.sticker_id,
          theme_key: op.themeKey,
          error: error?.message,
          error_code: error?.code,
        });
      }
    }

    currentItems = await listStickerPackItems(pack.id);
    itemsByPackId.set(pack.id, currentItems);
    currentById.clear();
    for (const item of currentItems) currentById.set(item.sticker_id, item);
  }

  if (enableAdditions && budgets.added < MAX_ADDITIONS_PER_CYCLE && plannedIds.length) {
    const hasPendingCandidates = plannedIds.some((assetId) => !currentById.has(assetId));
    let availableSlots = Math.max(0, TARGET_PACK_SIZE - currentById.size);

    if (availableSlots <= 0) {
      if (hasPendingCandidates) {
        packLimitSkips += 1;
      }
    } else {
      for (const assetId of plannedIds) {
        if (budgets.added >= MAX_ADDITIONS_PER_CYCLE) break;
        if (currentById.has(assetId)) continue;
        if (availableSlots <= 0) {
          packLimitSkips += 1;
          break;
        }

        try {
          await stickerPackService.addStickerToPack({
            ownerJid: pack.owner_jid,
            identifier: pack.id,
            asset: { id: assetId },
            emojis: [],
            accessibilityLabel: `Auto-theme ${op.theme}${op.subtheme ? `/${op.subtheme}` : ''}`,
            expectedErrorCodes: ['PACK_LIMIT_REACHED'],
          });
          budgets.added += 1;
          added += 1;
          availableSlots = Math.max(0, availableSlots - 1);
          queueFeedback({
            classification: classificationByAssetId.get(assetId),
            accepted: true,
            assetId,
          });
        } catch (error) {
          if (error?.code === 'DUPLICATE_STICKER') {
            duplicateSkips += 1;
            continue;
          }
          if (error?.code === 'PACK_LIMIT_REACHED') {
            packLimitSkips += 1;
            break;
          }

          logger.warn('Falha ao adicionar sticker em auto-pack por tags.', {
            action: 'sticker_auto_pack_by_tags_add_failed',
            theme: op.theme,
            subtheme: op.subtheme || null,
            theme_key: op.themeKey,
            pack_id: pack.id,
            asset_id: assetId,
            error: error?.message,
            error_code: error?.code,
          });
        }
      }
    }

    currentItems = await listStickerPackItems(pack.id);
    itemsByPackId.set(pack.id, currentItems);
    currentById.clear();
    for (const item of currentItems) currentById.set(item.sticker_id, item);
  }

  const finalDesiredOrder = plannedIds.filter((assetId) => currentById.has(assetId));
  const currentOrder = currentItems.map((item) => item.sticker_id);
  const desiredReorderSet = new Set(finalDesiredOrder);
  const projectedOrder = [...finalDesiredOrder, ...currentOrder.filter((assetId) => !desiredReorderSet.has(assetId))];
  const needsReorder = projectedOrder.length > 1 && projectedOrder.length === currentOrder.length && projectedOrder.some((assetId, index) => currentOrder[index] !== assetId);

  if (needsReorder) {
    try {
      await stickerPackService.reorderPackItems({
        ownerJid: pack.owner_jid,
        identifier: pack.id,
        orderStickerIds: finalDesiredOrder,
      });
      currentItems = await listStickerPackItems(pack.id);
      itemsByPackId.set(pack.id, currentItems);
    } catch (error) {
      logger.warn('Falha ao reordenar auto-pack por tags.', {
        action: 'sticker_auto_pack_by_tags_reorder_failed',
        pack_id: pack.id,
        theme_key: op.themeKey,
        error: error?.message,
        error_code: error?.code,
      });
    }
  }

  const finalItems = itemsByPackId.get(pack.id) || (await listStickerPackItems(pack.id));
  const finalCount = finalItems.length;
  const finalCover = finalItems[0]?.sticker_id || null;
  const finalDesiredPresentCount = finalItems.filter((item) => desiredSet.has(item.sticker_id)).length;
  const allDesiredPresent = finalDesiredPresentCount === plannedIds.length;
  const hasExtraItems = finalItems.some((item) => !desiredSet.has(item.sticker_id));
  const allowExtraItemsForReady = !enableRebuild && op.type === 'reconcile_volume';
  const meetsHardMinimum = finalCount >= HARD_MIN_PACK_ITEMS;
  const meetsReadyMinimum = finalCount >= READY_PACK_MIN_ITEMS;
  const packStatus = finalCount === 0 ? 'archived' : allDesiredPresent && (allowExtraItemsForReady || !hasExtraItems) && meetsReadyMinimum ? 'ready' : meetsHardMinimum ? 'building' : 'archived';

  const shouldDeletePack = packStatus === 'archived' && (op.type === 'archive_volume' || finalCount < HARD_MIN_PACK_ITEMS);
  if (shouldDeletePack) {
    try {
      await deleteAutoPackWithItems(pack.id, itemsByPackId);
      if (feedbackPromises.length) {
        await Promise.allSettled(feedbackPromises);
      }
      return {
        status: 'archived',
        pack: null,
        created,
        added,
        removed,
        deleted: 1,
        duplicateSkips,
        packLimitSkips,
        finalCount: 0,
      };
    } catch (error) {
      logger.warn('Falha ao excluir auto-pack arquivado durante consolidação.', {
        action: 'sticker_auto_pack_delete_archived_failed',
        pack_id: pack.id,
        theme_key: op.themeKey,
        error: error?.message,
      });
    }
  }

  const updated = await updateAutoPackMetadata(pack.id, {
    name: buildAutoPackName(op.theme, op.subtheme, op.volume),
    description: buildAutoPackDescription({
      theme: op.theme,
      subtheme: op.subtheme,
      themeKey: op.themeKey,
      groupScore: op.groupScore,
    }),
    themeKey: op.themeKey,
    volume: op.volume,
    pack_status: packStatus,
    cover_sticker_id: finalCover,
  });

  if (feedbackPromises.length) {
    await Promise.allSettled(feedbackPromises);
  }

  itemsByPackId.set(pack.id, finalItems);
  return {
    status: packStatus,
    pack: updated,
    created,
    added,
    removed,
    deleted: 0,
    duplicateSkips,
    packLimitSkips,
    finalCount,
  };
};

let cycleHandle = null;
let startupHandle = null;
let running = false;
let schedulerEnabled = false;

const clearCycleHandle = () => {
  if (!cycleHandle) return;
  clearTimeout(cycleHandle);
  cycleHandle = null;
};

const countClassifiedWithoutPackSafely = async ({ phase = 'unknown' } = {}) => {
  try {
    return await countClassifiedStickerAssetsWithoutPack();
  } catch (error) {
    logger.warn('Falha ao contar assets classificados sem pack.', {
      action: 'sticker_auto_pack_by_tags_without_pack_count_failed',
      phase,
      error: error?.message,
    });
    return null;
  }
};

const resolveNextCycleDelayMs = () => {
  if (EFFECTIVE_INTERVAL_MAX_MS <= EFFECTIVE_INTERVAL_MIN_MS) {
    return EFFECTIVE_INTERVAL_MIN_MS;
  }

  return EFFECTIVE_INTERVAL_MIN_MS + Math.floor(Math.random() * (EFFECTIVE_INTERVAL_MAX_MS - EFFECTIVE_INTERVAL_MIN_MS + 1));
};

const scheduleNextCycle = () => {
  if (!schedulerEnabled) return;
  clearCycleHandle();

  const safeDelay = Math.max(1_000, resolveNextCycleDelayMs());
  cycleHandle = setTimeout(() => {
    cycleHandle = null;
    if (!schedulerEnabled) return;
    scheduleNextCycle();
    void runStickerAutoPackByTagsCycle().catch((error) => {
      logger.error('Falha ao executar ciclo agendado do auto-pack por tags.', {
        action: 'sticker_auto_pack_by_tags_cycle_schedule_failed',
        error: error?.message,
        stack: error?.stack,
      });
    });
  }, safeDelay);

  if (typeof cycleHandle.unref === 'function') {
    cycleHandle.unref();
  }
};

export const runStickerAutoPackByTagsCycle = async ({ enableAdditions = true, enableRebuild = REBUILD_ENABLED } = {}) => {
  if (running) {
    return {
      executed: false,
      reason: 'already_running',
      added_stickers: 0,
    };
  }
  if (!AUTO_ENABLED) {
    return {
      executed: false,
      reason: 'disabled',
      added_stickers: 0,
    };
  }

  const ownerPool = resolveCurationOwnerPool();
  if (!ownerPool.length) {
    logger.warn('Auto-pack por tags: owner_jid indisponível, ciclo ignorado.', {
      action: 'sticker_auto_pack_by_tags_owner_missing',
    });
    return {
      executed: false,
      reason: 'owner_missing',
      added_stickers: 0,
    };
  }

  running = true;
  const startedAt = __timeNowMs();
  const budgets = { added: 0, removed: 0 };
  let createdPacks = 0;
  let processedGroups = 0;
  let processedVolumes = 0;
  let duplicateSkips = 0;
  let packLimitSkips = 0;
  let readyPacks = 0;
  let buildingPacks = 0;
  let archivedPacks = 0;
  let ownerFullSkips = 0;
  let deletedPacks = 0;
  let consolidationStats = {
    enabled: RETRO_CONSOLIDATION_ENABLED,
    processed_themes: 0,
    merged_themes: 0,
    deleted_packs: 0,
    moved_stickers: 0,
    trimmed_stickers: 0,
    mutations: 0,
    theme_limit_reached: false,
    mutation_limit_reached: false,
  };
  const classifiedWithoutPackBefore = await countClassifiedWithoutPackSafely({
    phase: 'before_cycle',
  });
  const finalizeCycleResult = async (payload) => {
    const withoutPackBefore = Number.isFinite(classifiedWithoutPackBefore) ? Number(classifiedWithoutPackBefore) : null;
    if (!Number.isFinite(withoutPackBefore)) {
      return {
        ...payload,
        without_pack_before: null,
        without_pack_after: null,
        without_pack_delta: null,
      };
    }

    const classifiedWithoutPackAfter = await countClassifiedWithoutPackSafely({
      phase: 'after_cycle',
    });
    const withoutPackAfter = Number.isFinite(classifiedWithoutPackAfter) ? Number(classifiedWithoutPackAfter) : null;
    const withoutPackDelta = Number.isFinite(withoutPackAfter) ? withoutPackBefore - withoutPackAfter : null;

    return {
      ...payload,
      without_pack_before: withoutPackBefore,
      without_pack_after: withoutPackAfter,
      without_pack_delta: Number.isFinite(withoutPackDelta) ? withoutPackDelta : null,
    };
  };

  try {
    if (enableAdditions) {
      consolidationStats = await runRetroConsolidationCycle({ ownerPool });
    } else {
      consolidationStats = {
        ...consolidationStats,
        enabled: false,
      };
    }
    const includePackedForCycle = enableRebuild || INCLUDE_PACKED_WHEN_REBUILD_DISABLED;
    const curationInput = await collectCuratableCandidates({
      includePacked: includePackedForCycle,
      includeUnpacked: true,
    });
    const { groups: curatedGroups, stats } = buildCurationPlan(curationInput);

    if (!curatedGroups.length) {
      const idleResult = await finalizeCycleResult({
        executed: true,
        reason: 'idle',
        added_stickers: 0,
        removed_stickers: 0,
        created_packs: 0,
        pack_limit_skips: 0,
        processed_groups: 0,
        processed_volumes: 0,
        duration_ms: __timeNowMs() - startedAt,
      });
      logger.debug('Auto-pack por tags: nenhum grupo elegível neste ciclo.', {
        action: 'sticker_auto_pack_by_tags_idle',
        without_pack_before: idleResult.without_pack_before,
        without_pack_after: idleResult.without_pack_after,
        without_pack_delta: idleResult.without_pack_delta,
        retro_consolidation: consolidationStats,
        ...stats,
      });
      return idleResult;
    }

    const planner = await buildCurationExecutionPlan({
      curatedGroups,
      ownerPool,
      enableAdditions,
    });
    processedGroups = Number(planner?.stats?.groups_effective || curatedGroups.length || 0);

    for (const op of planner.operations) {
      const result = await reconcileAutoPackVolume({
        op,
        enableAdditions,
        enableRebuild,
        budgets,
        itemsByPackId: planner.itemsByPackId,
        classificationByAssetId: planner.classificationByAssetId,
      });

      processedVolumes += 1;
      createdPacks += Number(result?.created || 0);
      duplicateSkips += Number(result?.duplicateSkips || 0);
      packLimitSkips += Number(result?.packLimitSkips || 0);
      deletedPacks += Number(result?.deleted || 0);
      if (result?.status === 'owner_full') {
        ownerFullSkips += 1;
      }
      if (result?.status === 'ready') readyPacks += 1;
      if (result?.status === 'building') buildingPacks += 1;
      if (result?.status === 'archived') archivedPacks += 1;
    }

    const scanReferenceCount = Math.max(1, Number(stats.assets_unique_scanned || stats.assets_total_seen || stats.assets_scanned || 0));
    const rejectionReferenceCount = Math.max(1, Number(stats.assets_scanned || 0));
    const duplicateRate = Number(stats.assets_deduped || 0) / scanReferenceCount;
    const rejectedCount = Number(stats.assets_rejected_quality || 0) + Number(stats.assets_rejected_no_theme || 0);
    const rejectionRate = rejectedCount / rejectionReferenceCount;
    const fillRate = budgets.added / Math.max(1, processedVolumes * TARGET_PACK_SIZE);

    recordStickerAutoPackCycle({
      durationMs: __timeNowMs() - startedAt,
      assetsScanned: Number(stats.assets_scanned || 0),
      assetsAdded: budgets.added,
      duplicateRate,
      rejectionRate,
      fillRate,
    });

    const cycleResult = await finalizeCycleResult({
      executed: true,
      reason: 'ok',
      added_stickers: Number(budgets.added || 0),
      removed_stickers: Number(budgets.removed || 0),
      created_packs: Number(createdPacks || 0),
      pack_limit_skips: Number(packLimitSkips || 0),
      processed_groups: Number(processedGroups || 0),
      processed_volumes: Number(processedVolumes || 0),
      duration_ms: __timeNowMs() - startedAt,
    });

    logger.info('Auto-pack por tags executado.', {
      action: 'sticker_auto_pack_by_tags_cycle',
      owner_jid: ownerPool[0],
      owner_pool: ownerPool,
      processed_groups: processedGroups,
      processed_volumes: processedVolumes,
      created_packs: createdPacks,
      added_stickers: budgets.added,
      removed_stickers: budgets.removed,
      deleted_packs: deletedPacks,
      ready_packs_touched: readyPacks,
      building_packs_touched: buildingPacks,
      archived_packs_touched: archivedPacks,
      owner_full_skips: ownerFullSkips,
      rebuild_enabled_cycle: Boolean(enableRebuild),
      additions_enabled_cycle: Boolean(enableAdditions),
      include_packed_cycle: Boolean(includePackedForCycle),
      include_unpacked_cycle: true,
      cohesion_rebuild_threshold: Number(COHESION_REBUILD_THRESHOLD.toFixed(6)),
      duplicate_skips: duplicateSkips,
      pack_limit_skips: packLimitSkips,
      duration_ms: __timeNowMs() - startedAt,
      duplicate_rate: Number(duplicateRate.toFixed(6)),
      rejection_rate: Number(rejectionRate.toFixed(6)),
      pack_fill_rate: Number(fillRate.toFixed(6)),
      without_pack_before: cycleResult.without_pack_before,
      without_pack_after: cycleResult.without_pack_after,
      without_pack_delta: cycleResult.without_pack_delta,
      min_group_size: MIN_GROUP_SIZE,
      target_pack_size: TARGET_PACK_SIZE,
      max_additions_per_cycle: MAX_ADDITIONS_PER_CYCLE,
      max_removals_per_cycle: MAX_REMOVALS_PER_CYCLE,
      move_out_theme_score_threshold: Number(MOVE_OUT_THEME_SCORE_THRESHOLD.toFixed(6)),
      move_in_theme_score_threshold: Number(MOVE_IN_THEME_SCORE_THRESHOLD.toFixed(6)),
      ready_pack_min_items: READY_PACK_MIN_ITEMS,
      hard_min_group_size: EFFECTIVE_HARD_MIN_GROUP_SIZE,
      hard_min_group_size_base: HARD_MIN_GROUP_SIZE,
      hard_min_pack_items: HARD_MIN_PACK_ITEMS,
      semantic_clustering_enabled: ENABLE_SEMANTIC_CLUSTERING,
      semantic_cluster_min_size_for_pack: SEMANTIC_CLUSTER_MIN_SIZE_FOR_PACK,
      max_packs_per_theme: MAX_PACKS_PER_THEME,
      global_auto_pack_limit: GLOBAL_AUTO_PACK_LIMIT,
      dynamic_group_limit_base: DYNAMIC_GROUP_LIMIT_BASE,
      retro_consolidation_enabled: RETRO_CONSOLIDATION_ENABLED,
      retro_consolidation_theme_limit: RETRO_CONSOLIDATION_THEME_LIMIT,
      retro_consolidation_mutation_limit: RETRO_CONSOLIDATION_MUTATION_LIMIT,
      retro_consolidation: consolidationStats,
      ...planner.stats,
      ...stats,
    });
    return cycleResult;
  } catch (error) {
    logger.error('Falha no ciclo do auto-pack por tags.', {
      action: 'sticker_auto_pack_by_tags_cycle_failed',
      error: error?.message,
      stack: error?.stack,
    });
    return finalizeCycleResult({
      executed: true,
      reason: 'failed',
      added_stickers: Number(budgets.added || 0),
      removed_stickers: Number(budgets.removed || 0),
      created_packs: Number(createdPacks || 0),
      pack_limit_skips: Number(packLimitSkips || 0),
      processed_groups: Number(processedGroups || 0),
      processed_volumes: Number(processedVolumes || 0),
      duration_ms: __timeNowMs() - startedAt,
    });
  } finally {
    running = false;
  }
};

export const startStickerAutoPackByTagsBackground = () => {
  if (startupHandle || cycleHandle || schedulerEnabled) return;

  if (!AUTO_ENABLED) {
    logger.info('Auto-pack por tags desabilitado.', {
      action: 'sticker_auto_pack_by_tags_disabled',
    });
    return;
  }
  schedulerEnabled = true;

  logger.info('Iniciando auto-pack por tags em background.', {
    action: 'sticker_auto_pack_by_tags_start',
    startup_delay_ms: STARTUP_DELAY_MS,
    interval_min_ms: EFFECTIVE_INTERVAL_MIN_MS,
    interval_max_ms: EFFECTIVE_INTERVAL_MAX_MS,
    scheduler_mode: 'timer_non_chained_random_window',
    interval_source: LEGACY_FIXED_INTERVAL_MS ? 'legacy_fixed_interval_ms' : 'interval_window',
    target_pack_size: TARGET_PACK_SIZE,
    min_group_size: MIN_GROUP_SIZE,
    hard_min_group_size: EFFECTIVE_HARD_MIN_GROUP_SIZE,
    hard_min_group_size_base: HARD_MIN_GROUP_SIZE,
    hard_min_pack_items: HARD_MIN_PACK_ITEMS,
    semantic_clustering_enabled: ENABLE_SEMANTIC_CLUSTERING,
    semantic_cluster_min_size_for_pack: SEMANTIC_CLUSTER_MIN_SIZE_FOR_PACK,
    ready_pack_min_items: READY_PACK_MIN_ITEMS,
    max_packs_per_theme: MAX_PACKS_PER_THEME,
    global_auto_pack_limit: GLOBAL_AUTO_PACK_LIMIT,
    dynamic_group_limit_base: DYNAMIC_GROUP_LIMIT_BASE,
    max_groups: MAX_TAG_GROUPS,
    max_scan_assets: MAX_SCAN_ASSETS,
    max_additions_per_cycle: MAX_ADDITIONS_PER_CYCLE,
    max_packs_per_owner: Number.isFinite(MAX_PACKS_PER_OWNER) ? MAX_PACKS_PER_OWNER : 'unlimited',
    retro_consolidation_enabled: RETRO_CONSOLIDATION_ENABLED,
    retro_consolidation_theme_limit: RETRO_CONSOLIDATION_THEME_LIMIT,
    retro_consolidation_mutation_limit: RETRO_CONSOLIDATION_MUTATION_LIMIT,
    auto_pack_profile: AUTO_PACK_PROFILE,
    aggressive_profile: IS_AGGRESSIVE_PROFILE,
    prioritize_completion: EFFECTIVE_PRIORITIZE_COMPLETION,
    completion_transfer_enabled: EFFECTIVE_COMPLETION_TRANSFER_ENABLED,
    completion_transfer_min_donor_items: COMPLETION_TRANSFER_MIN_DONOR_ITEMS,
    archive_low_score_packs: ARCHIVE_LOW_SCORE_PACKS,
    visibility: AUTO_PACK_VISIBILITY,
    top_tags_per_asset: TOP_TAGS_PER_ASSET,
    scan_passes: SCAN_PASSES,
    scan_pass_jitter_percent: SCAN_PASS_JITTER_PERCENT,
    stability_z_score: STABILITY_Z_SCORE,
    min_asset_acceptance_rate: EFFECTIVE_MIN_ASSET_ACCEPTANCE_RATE,
    min_theme_dominance_ratio: EFFECTIVE_MIN_THEME_DOMINANCE_RATIO,
    score_stddev_penalty: EFFECTIVE_SCORE_STDDEV_PENALTY,
    nsfw_threshold: NSFW_THRESHOLD,
    nsfw_suggestive_threshold: NSFW_SUGGESTIVE_THRESHOLD,
    nsfw_explicit_threshold: NSFW_EXPLICIT_THRESHOLD,
    rebuild_enabled: REBUILD_ENABLED,
    include_packed_when_rebuild_disabled: INCLUDE_PACKED_WHEN_REBUILD_DISABLED,
    max_removals_per_cycle: MAX_REMOVALS_PER_CYCLE,
    dedupe_similarity_threshold: DEDUPE_SIMILARITY_THRESHOLD,
    global_optimization_enabled: ENABLE_GLOBAL_OPTIMIZATION,
    optimization_cycles: OPTIMIZATION_CYCLES,
    optimization_epsilon: OPTIMIZATION_EPSILON,
    optimization_stable_cycles: OPTIMIZATION_STABLE_CYCLES,
    transfer_threshold: EFFECTIVE_TRANSFER_THRESHOLD,
    merge_threshold: EFFECTIVE_MERGE_THRESHOLD,
    migration_candidate_limit: EFFECTIVE_MIGRATION_CANDIDATE_LIMIT,
    transfer_candidate_similarity_floor: EFFECTIVE_TRANSFER_CANDIDATE_SIMILARITY_FLOOR,
    inter_pack_similarity_threshold: EFFECTIVE_INTER_PACK_SIMILARITY_THRESHOLD,
    entropy_threshold: ENTROPY_THRESHOLD,
    entropy_normalized_threshold: ENTROPY_NORMALIZED_THRESHOLD,
    entropy_weight: ENTROPY_WEIGHT,
    ambiguous_flag_penalty: AMBIGUOUS_FLAG_PENALTY,
    adaptive_bonus_weight: ADAPTIVE_BONUS_WEIGHT,
    margin_bonus_weight: MARGIN_BONUS_WEIGHT,
    affinity_weight_cap: AFFINITY_WEIGHT_CAP,
    affinity_log_scaling: ENABLE_AFFINITY_LOG_SCALING,
    affinity_log_scale: AFFINITY_LOG_SCALE,
    similar_images_penalty_weight: SIMILAR_IMAGES_PENALTY_WEIGHT,
    llm_trait_weight: LLM_TRAIT_WEIGHT,
    asset_quality_weights: {
      w1: ASSET_QUALITY_W1,
      w2: ASSET_QUALITY_W2,
      w3: ASSET_QUALITY_W3,
      w4: ASSET_QUALITY_W4,
    },
    global_energy_weights: {
      w1: GLOBAL_ENERGY_W1,
      w2: GLOBAL_ENERGY_W2,
      w3: GLOBAL_ENERGY_W3,
      w4: GLOBAL_ENERGY_W4,
      w5: GLOBAL_ENERGY_W5,
    },
    pack_tier_thresholds: {
      gold: PACK_TIER_GOLD_THRESHOLD,
      silver: PACK_TIER_SILVER_THRESHOLD,
      bronze: PACK_TIER_BRONZE_THRESHOLD,
    },
    min_pack_size: MIN_PACK_SIZE,
    auto_archive_below_percentile: EFFECTIVE_AUTO_ARCHIVE_BELOW_PERCENTILE,
    system_redundancy_lambda: SYSTEM_REDUNDANCY_LAMBDA,
    matrix_weights: {
      alpha: MATRIX_ALPHA,
      beta: MATRIX_BETA,
      gamma: MATRIX_GAMMA,
      delta: MATRIX_DELTA,
    },
    pack_quality_weights: {
      w1: PACK_QUALITY_W1,
      w2: PACK_QUALITY_W2,
      w3: PACK_QUALITY_W3,
      w4: PACK_QUALITY_W4,
      w5: PACK_QUALITY_W5,
      w6: PACK_QUALITY_W6,
    },
    pack_tier_quality_weights: {
      mean_asset_quality: PACK_TIER_QUALITY_W1,
      cohesion_score: PACK_TIER_QUALITY_W2,
      engagement_zscore: PACK_TIER_QUALITY_W3,
      completion_ratio: PACK_TIER_QUALITY_W4,
      stability_index: PACK_TIER_QUALITY_W5,
    },
    quality_gate: {
      min_asset_edge: MIN_ASSET_EDGE,
      min_asset_area: MIN_ASSET_AREA,
      min_asset_bytes: MIN_ASSET_BYTES,
      max_blurry_score: MAX_BLURRY_SCORE,
      max_low_quality_score: MAX_LOW_QUALITY_SCORE,
    },
  });

  startupHandle = setTimeout(() => {
    startupHandle = null;
    if (!schedulerEnabled) return;
    scheduleNextCycle();
    void runStickerAutoPackByTagsCycle().catch((error) => {
      logger.error('Falha ao executar ciclo inicial do auto-pack por tags.', {
        action: 'sticker_auto_pack_by_tags_initial_cycle_failed',
        error: error?.message,
        stack: error?.stack,
      });
    });
  }, STARTUP_DELAY_MS);

  if (typeof startupHandle.unref === 'function') {
    startupHandle.unref();
  }
};

export const stopStickerAutoPackByTagsBackground = () => {
  schedulerEnabled = false;

  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }

  clearCycleHandle();
};
