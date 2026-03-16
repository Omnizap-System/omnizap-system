import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { URL, URLSearchParams } from 'node:url';

import { executeQuery, pool, TABLES } from '../../../database/index.js';
import { normalizeJid, resolveBotJid, getActiveSocket, profilePictureUrlFromActiveSocket, extractUserIdInfo, resolveUserId } from '../../../app/config/index.js';
import { resolveWhatsAppOwnerJidFromLoginPayload, toWhatsAppOwnerJid, toWhatsAppPhoneDigits } from '../../../app/services/auth/whatsappLoginLinkService.js';
import logger from '#logger';
import { listStickerPacksForCatalog, findStickerPackByPackKey, listStickerPacksByOwner, bumpStickerPackVersion, findStickerPackByOwnerAndIdentifier, softDeleteStickerPack, updateStickerPackFields } from '../../../app/modules/stickerPackModule/stickerPackRepository.js';
import { listStickerPackItems, countStickerPackItemRefsByStickerId, createStickerPackItem, getStickerPackItemByStickerId, removeStickerPackItemByStickerId, removeStickerPackItemsByPackId } from '../../../app/modules/stickerPackModule/stickerPackItemRepository.js';
import { listClassifiedStickerAssetsWithoutPack, listStickerAssetsWithoutPack, deleteStickerAssetById, findStickerAssetsByIds } from '../../../app/modules/stickerPackModule/stickerAssetRepository.js';
import { deleteStickerAssetClassificationByAssetId, findStickerClassificationByAssetId, listStickerClassificationsByAssetIds } from '../../../app/modules/stickerPackModule/stickerAssetClassificationRepository.js';
import { decoratePackClassificationSummary, decorateStickerClassification, getPackClassificationSummaryByAssetIds } from '../../../app/modules/stickerPackModule/stickerClassificationService.js';
import { getEmptyStickerPackEngagement, getStickerPackEngagementByPackId, incrementStickerPackDislike, incrementStickerPackLike, incrementStickerPackOpen, listStickerPackEngagementByPackIds } from '../../../app/modules/stickerPackModule/stickerPackEngagementRepository.js';
import { createStickerPackInteractionEvent, listStickerPackInteractionStatsByPackIds, listViewerRecentPackIds } from '../../../app/modules/stickerPackModule/stickerPackInteractionEventRepository.js';
import { buildCreatorRanking, buildIntentCollections, buildPersonalizedRecommendations, buildViewerTagAffinity, computePackSignals } from '../../../app/modules/stickerPackModule/stickerPackMarketplaceService.js';
import { listStickerPackScoreSnapshotsByPackIds } from '../../../app/modules/stickerPackModule/stickerPackScoreSnapshotRepository.js';
import { createCatalogApiRouter } from '../../routes/sticker/catalogRouter.js';
import { normalizeGoogleSubject } from '../../auth/googleWebAuth/googleWebAuthRuntime.js';
import { createStickerCatalogAuthContext } from '../../auth/stickerCatalogAuthContext.js';
import { appendSetCookie, buildCookieString, getCookieValuesFromRequest, normalizeBasePath, normalizeCatalogVisibility, normalizeVisitPath, parseCookies, readJsonBody, resolveRequestRemoteIp, sendJson, sendText, toIsoOrNull, withTimeout } from '../../http/httpRequestUtils.js';
import { getSiteRoutingConfig, maybeRedirectToCanonicalHost, toSiteAbsoluteUrl } from '../../http/siteRoutingUtils.js';
import { handlePublicDataAssetRequest, listDataImageFiles, toPublicDataUrlFromStoragePath } from '../system/storageController.js';
import { buildSupportInfo, resolveCatalogBotPhone } from '../system/contactController.js';
import { trackWebVisitMetric } from '../system/visitController.js';
import { systemContext, systemHandlers } from '../system/systemController.js';

const { handleSystemSummaryRequest, handleReadmeSummaryRequest, handleReadmeMarkdownRequest, handleGlobalRankingSummaryRequest, handleMarketplaceGlobalStatsRequest, handleGitHubProjectSummaryRequest, handleSupportInfoRequest, handleBotContactInfoRequest, handleHomeBootstrapRequest } = systemHandlers;
const { getSystemSummaryCached, getMarketplaceGlobalStatsCached } = systemContext;

import { queueAutomatedEmail, queueWelcomeEmail } from '../../email/emailAutomationService.js';
import { createStickerCatalogAdminBanContext, createStickerCatalogAdminHandlersContext } from '../admin/stickerCatalogAdminContext.js';
import { createStickerCatalogSeoContext } from '../seo/stickerCatalogSeoContext.js';
import { getMarketplaceDriftSnapshot } from '../../../app/modules/stickerPackModule/stickerMarketplaceDriftService.js';
import { getStickerAssetExternalUrl, getStickerStorageConfig, readStickerAssetBuffer, saveStickerAssetFromBuffer } from '../../../app/modules/stickerPackModule/stickerStorageService.js';
import { convertToWebp } from '../../../app/modules/stickerModule/convertToWebp.js';
import { sanitizeText } from '../../../app/modules/stickerPackModule/stickerPackUtils.js';
import stickerPackService from '../../../app/modules/stickerPackModule/stickerPackServiceRuntime.js';
import { STICKER_PACK_ERROR_CODES, StickerPackError } from '../../../app/modules/stickerPackModule/stickerPackErrors.js';
import { getFeatureFlagsSnapshot, isFeatureEnabled, refreshFeatureFlags } from '../../../app/services/infra/featureFlagService.js';

const parseEnvBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeCatalogSortParam = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'new') return 'recent';
  if (normalized === 'liked') return 'likes';
  if (normalized === 'popular') return 'trending';
  if (['recent', 'likes', 'downloads', 'trending', 'comments'].includes(normalized)) return normalized;
  return 'popular';
};

export const stripWebpExtension = (value) =>
  String(value || '')
    .trim()
    .replace(/\.webp$/i, '');

const clampInt = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
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
const serializePackOwnerLimit = (value) => (Number.isFinite(value) ? Math.max(1, Number(value) || 1) : null);

const STICKER_CATALOG_ENABLED = Boolean(process.env.STICKER_CATALOG_ENABLED !== 'false');
const STICKER_WEB_PATH = normalizeBasePath(process.env.STICKER_WEB_PATH, '/stickers');
const STICKER_API_BASE_PATH = normalizeBasePath(process.env.STICKER_API_BASE_PATH, '/api/sticker-packs');
const USER_API_BASE_PATH = normalizeBasePath(process.env.USER_API_BASE_PATH || process.env.AUTH_API_BASE_PATH, '/api');
const STICKER_ORPHAN_API_PATH = `${STICKER_API_BASE_PATH}/orphan-stickers`;
const STICKER_CREATE_WEB_PATH = `${STICKER_WEB_PATH}/create`;
const STICKER_LOGIN_WEB_PATH = normalizeBasePath(process.env.STICKER_LOGIN_WEB_PATH, '/login');
const USER_PROFILE_WEB_PATH = normalizeBasePath(process.env.USER_PROFILE_WEB_PATH, '/user');
const USER_PASSWORD_RESET_WEB_PATH = normalizeBasePath(process.env.USER_PASSWORD_RESET_WEB_PATH, '/user/password-reset');
const PASSWORD_RECOVERY_SESSION_AUTH_METHOD = 'password_recovery_session';
const PASSWORD_RECOVERY_SESSION_TTL_SECONDS = clampInt(process.env.WEB_PASSWORD_RECOVERY_SESSION_TTL_SECONDS, 15 * 60, 60, 24 * 60 * 60);
const STICKER_DATA_PUBLIC_PATH = normalizeBasePath(process.env.STICKER_DATA_PUBLIC_PATH, '/data');
const STICKER_DATA_PUBLIC_DIR = path.resolve(process.env.STICKER_DATA_PUBLIC_DIR || path.join(process.cwd(), 'data'));
const STICKER_WEB_ASSET_VERSION =
  sanitizeText(process.env.STICKER_WEB_ASSET_VERSION || process.env.OMNIZAP_BUILD_ID || '', 64, {
    allowEmpty: true,
  }) || '';
const CATALOG_PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const CATALOG_TEMPLATE_PATH = path.join(CATALOG_PUBLIC_DIR, 'pages', 'stickers.html');
const CREATE_PACK_TEMPLATE_PATH = path.join(CATALOG_PUBLIC_DIR, 'pages', 'stickers-create.html');
const CATALOG_STYLES_FILE_PATH = path.join(CATALOG_PUBLIC_DIR, 'css', 'styles.css');
const CATALOG_SCRIPT_FILE_PATH = path.join(CATALOG_PUBLIC_DIR, 'js', 'catalog.js');
const DEFAULT_LIST_LIMIT = clampInt(process.env.STICKER_WEB_LIST_LIMIT, 16, 1, 60);
const MAX_LIST_LIMIT = clampInt(process.env.STICKER_WEB_LIST_MAX_LIMIT, 60, 1, 100);
const DEFAULT_ORPHAN_LIST_LIMIT = clampInt(process.env.STICKER_ORPHAN_LIST_LIMIT, 120, 1, 300);
const MAX_ORPHAN_LIST_LIMIT = clampInt(process.env.STICKER_ORPHAN_LIST_MAX_LIMIT, 300, 1, 500);
const DEFAULT_DATA_LIST_LIMIT = clampInt(process.env.STICKER_DATA_LIST_LIMIT, 50, 1, 200);
const MAX_DATA_LIST_LIMIT = clampInt(process.env.STICKER_DATA_LIST_MAX_LIMIT, 200, 1, 500);
const MAX_DATA_SCAN_FILES = clampInt(process.env.STICKER_DATA_SCAN_MAX_FILES, 10000, 100, 50000);
const ASSET_CACHE_SECONDS = clampInt(process.env.STICKER_WEB_ASSET_CACHE_SECONDS, 60 * 60 * 24 * 30, 60 * 60, 60 * 60 * 24 * 365);
const STATIC_TEXT_CACHE_SECONDS = clampInt(process.env.STICKER_WEB_STATIC_TEXT_CACHE_SECONDS, 60 * 60, 60, 60 * 60 * 24 * 30);
const IMMUTABLE_ASSET_CACHE_SECONDS = clampInt(process.env.STICKER_WEB_IMMUTABLE_ASSET_CACHE_SECONDS, 60 * 60 * 24 * 365, 60 * 60, 60 * 60 * 24 * 365);
const STICKER_WEB_WHATSAPP_MESSAGE_TEMPLATE = String(process.env.STICKER_WEB_WHATSAPP_MESSAGE_TEMPLATE || '/pack send {{pack_key}}').trim() || '/pack send {{pack_key}}';
const PACK_COMMAND_PREFIX = String(process.env.COMMAND_PREFIX || '/').trim() || '/';
const PACK_CREATE_NAME_REGEX = '^[\\s\\S]+$';
const PACK_CREATE_MAX_NAME_LENGTH = 120;
const PACK_CREATE_MAX_PUBLISHER_LENGTH = 120;
const PACK_CREATE_MAX_DESCRIPTION_LENGTH = 1024;
const PACK_CREATE_MAX_ITEMS = Math.max(1, Number(process.env.STICKER_PACK_MAX_ITEMS) || 30);
const PACK_CREATE_MAX_PACKS_PER_OWNER = parseMaxPacksPerOwnerLimit(process.env.STICKER_PACK_MAX_PACKS_PER_OWNER, 50);
const PACK_WEB_EDIT_TOKEN_TTL_MS = Math.max(60_000, Number(process.env.STICKER_WEB_EDIT_TOKEN_TTL_MS) || 6 * 60 * 60 * 1000);
const STICKER_WEB_GOOGLE_CLIENT_ID = String(process.env.STICKER_WEB_GOOGLE_CLIENT_ID || '').trim();
const STICKER_WEB_GOOGLE_AUTH_REQUIRED = Boolean(process.env.STICKER_WEB_GOOGLE_AUTH_REQUIRED !== 'false' && (process.env.STICKER_WEB_GOOGLE_AUTH_REQUIRED === 'true' || STICKER_WEB_GOOGLE_CLIENT_ID));
const STICKER_WEB_GOOGLE_SESSION_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.STICKER_WEB_GOOGLE_SESSION_TTL_MS) || 7 * 24 * 60 * 60 * 1000);
const STICKER_CATALOG_ONLY_CLASSIFIED = Boolean(process.env.STICKER_CATALOG_ONLY_CLASSIFIED !== 'false');
const USER_INTERNAL_API_TOKEN = String(process.env.USER_INTERNAL_API_TOKEN || process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim();
const USER_INTERNAL_READ_REQUIRE_AUTH = Boolean(process.env.USER_INTERNAL_READ_REQUIRE_AUTH !== 'false');
const USER_CONTACT_ENDPOINT_REQUIRE_AUTH = Boolean(process.env.USER_CONTACT_ENDPOINT_REQUIRE_AUTH !== 'false');
const HOME_BOOTSTRAP_EXPOSE_CONTACT = Boolean(process.env.HOME_BOOTSTRAP_EXPOSE_CONTACT !== 'false');
const ADMIN_PANEL_EMAIL =
  String(process.env.ADM_EMAIL || '')
    .trim()
    .toLowerCase() || '';
const GLOBAL_RANK_REFRESH_SECONDS = clampInt(process.env.GLOBAL_RANK_REFRESH_SECONDS, 600, 60, 3600);
const CATALOG_LIST_CACHE_SECONDS = clampInt(process.env.STICKER_CATALOG_LIST_CACHE_SECONDS, 90, 15, 900);
const CATALOG_CREATOR_RANKING_CACHE_SECONDS = clampInt(process.env.STICKER_CATALOG_CREATOR_RANKING_CACHE_SECONDS, 120, 15, 900);
const CATALOG_PACK_PAYLOAD_CACHE_SECONDS = clampInt(process.env.STICKER_CATALOG_PACK_PAYLOAD_CACHE_SECONDS, 300, 30, 1800);
const MARKETPLACE_GLOBAL_STATS_API_PATH = '/api/marketplace/stats';
const MARKETPLACE_GLOBAL_STATS_CACHE_SECONDS = clampInt(process.env.MARKETPLACE_GLOBAL_STATS_CACHE_SECONDS, 45, 30, 60);
const HOME_MARKETPLACE_STATS_CACHE_SECONDS = clampInt(process.env.HOME_MARKETPLACE_STATS_CACHE_SECONDS, 45, 10, 300);
const SYSTEM_SUMMARY_CACHE_SECONDS = clampInt(process.env.SYSTEM_SUMMARY_CACHE_SECONDS, 20, 5, 120);
const README_SUMMARY_CACHE_SECONDS = clampInt(process.env.README_SUMMARY_CACHE_SECONDS, 60 * 30, 60, 60 * 60 * 6);
const README_MESSAGE_TYPE_SAMPLE_LIMIT = clampInt(process.env.README_MESSAGE_TYPE_SAMPLE_LIMIT, 25000, 500, 250000);
const README_COMMAND_PREFIX = String(process.env.README_COMMAND_PREFIX || PACK_COMMAND_PREFIX).trim() || PACK_COMMAND_PREFIX;
const SITE_ORIGIN = getSiteRoutingConfig().origin;
const SITEMAP_MAX_PACKS = clampInt(process.env.STICKER_SITEMAP_MAX_PACKS, 45000, 100, 50000);
const SITEMAP_CACHE_SECONDS = clampInt(process.env.STICKER_SITEMAP_CACHE_SECONDS, 180, 30, 3600);
const SEO_DISCOVERY_LINK_LIMIT = clampInt(process.env.STICKER_SEO_DISCOVERY_LINK_LIMIT, 60, 10, 200);
const SEO_DISCOVERY_CACHE_SECONDS = clampInt(process.env.STICKER_SEO_DISCOVERY_CACHE_SECONDS, 180, 30, 3600);
const PACK_PAGE_ROUTE_EXCLUSIONS = new Set(['profile', 'perfil', 'creators', 'criadores']);
const NSFW_STICKER_PLACEHOLDER_URL = String(process.env.NSFW_STICKER_PLACEHOLDER_URL || 'https://iili.io/qfhwS6u.jpg').trim();
const { maxStickerBytes: MAX_STICKER_UPLOAD_BYTES } = getStickerStorageConfig();
const MAX_STICKER_SOURCE_UPLOAD_BYTES = Math.max(MAX_STICKER_UPLOAD_BYTES, Number(process.env.STICKER_WEB_UPLOAD_SOURCE_MAX_BYTES) || 20 * 1024 * 1024);
const ALLOWED_WEB_UPLOAD_VIDEO_MIMETYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);
const webPackEditTokenMap = new Map();
const WEB_SESSION_COOKIE_NAME = 'omnizap_sid';
const PACK_WEB_STATUS_VALUES = new Set(['draft', 'uploading', 'processing', 'published', 'failed']);
const PACK_WEB_UPLOAD_STATUS_VALUES = new Set(['pending', 'processing', 'done', 'failed']);
const WEB_UPLOAD_ERROR_MESSAGE_MAX = 255;
const WEB_UPLOAD_MAX_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.STICKER_WEB_UPLOAD_CONCURRENCY) || 3));
const WEB_DRAFT_CLEANUP_TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.STICKER_WEB_DRAFT_CLEANUP_TTL_MS) || 24 * 60 * 60 * 1000);
const WEB_DRAFT_CLEANUP_RUN_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.STICKER_WEB_DRAFT_CLEANUP_RUN_INTERVAL_MS) || 15 * 60 * 1000);
const WEB_UPLOAD_ID_MAX_LENGTH = 120;
const WEB_VISITOR_COOKIE_TTL_SECONDS = clampInt(process.env.WEB_VISITOR_COOKIE_TTL_SECONDS, 60 * 60 * 24 * 365, 60 * 60, 60 * 60 * 24 * 3650);
const WEB_SESSION_COOKIE_TTL_SECONDS = clampInt(process.env.WEB_SESSION_COOKIE_TTL_SECONDS, 60 * 60 * 24 * 30, 30 * 60, 60 * 60 * 24 * 365);
const STICKER_PREVIEW_SIDE_PX = clampInt(process.env.STICKER_PREVIEW_SIDE_PX, 112, 96, 512);
const STICKER_PREVIEW_QUALITY = clampInt(process.env.STICKER_PREVIEW_QUALITY, 20, 10, 80);
const STICKER_PREVIEW_TIMEOUT_MS = clampInt(process.env.STICKER_PREVIEW_TIMEOUT_MS, 2500, 500, 12000);
const STICKER_PREVIEW_CACHE_TTL_MS = clampInt(process.env.STICKER_PREVIEW_CACHE_TTL_MS, 6 * 60 * 60 * 1000, 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const STICKER_PREVIEW_CACHE_MAX_ITEMS = clampInt(process.env.STICKER_PREVIEW_CACHE_MAX_ITEMS, 2000, 100, 20000);
const STICKER_PREVIEW_TEMP_DIR = path.join(process.cwd(), 'temp', 'stickers', 'web-preview');
const staleDraftCleanupState = {
  running: false,
  lastRunAt: 0,
};

const hasPathPrefix = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);
const isPackPubliclyVisible = (pack) => {
  const visibility = String(pack?.visibility || '').toLowerCase();
  if (visibility !== 'public' && visibility !== 'unlisted') return false;
  if (String(pack?.status || 'published') !== 'published') return false;

  const packStatus = String(pack?.pack_status || 'ready').toLowerCase();
  if (packStatus === 'ready') return true;
  return packStatus === 'building' && Number(pack?.is_auto_pack || 0) === 1;
};
const HOME_MARKETPLACE_STATS_CACHE = new Map();
const CATALOG_LIST_CACHE = new Map();
const CATALOG_CREATOR_RANKING_CACHE = new Map();
const CATALOG_PACK_PAYLOAD_CACHE = new Map();
const STICKER_PREVIEW_CACHE = new Map();
const GLOBAL_RANK_CACHE = { expiresAt: 0, value: null, pending: null };
const SYSTEM_SUMMARY_CACHE = { expiresAt: 0, value: null, pending: null };
const README_SUMMARY_CACHE = { expiresAt: 0, value: null, pending: null };

const buildCacheKey = (parts) => JSON.stringify(parts);

const getCacheBucket = (cacheMap, key) => {
  let bucket = cacheMap.get(key);
  if (!bucket) {
    bucket = {
      expiresAt: 0,
      value: null,
      pending: null,
    };
    cacheMap.set(key, bucket);
  }
  return bucket;
};

const getCachedSnapshot = async ({ cacheMap, key, ttlSeconds, staleWhileRefresh = true, staleOnError = true, load }) => {
  const bucket = getCacheBucket(cacheMap, key);
  const now = __timeNowMs();
  const hasValue = bucket.value !== null;
  const hasFreshValue = hasValue && now < bucket.expiresAt;

  if (hasFreshValue) {
    return bucket.value;
  }

  if (!bucket.pending) {
    bucket.pending = Promise.resolve()
      .then(load)
      .then((value) => {
        bucket.value = value;
        bucket.expiresAt = __timeNowMs() + ttlSeconds * 1000;
        return value;
      })
      .finally(() => {
        bucket.pending = null;
      });
  }

  if (hasValue && staleWhileRefresh) {
    return bucket.value;
  }

  try {
    return await bucket.pending;
  } catch (error) {
    if (hasValue && staleOnError) return bucket.value;
    throw error;
  }
};

const canUseRankingSnapshotRead = async (subjectKey = 'catalog') =>
  isFeatureEnabled('enable_ranking_snapshot_read', {
    fallback: true,
    subjectKey,
  });

const logPackWebFlow = (level, phase, payload = {}) => {
  const method = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : logger.info.bind(logger);
  method(`Fluxo web de criação/publicação de pack: ${phase}`, {
    action: `sticker_pack_web_${phase}`,
    phase,
    ...payload,
  });
};

const normalizePackWebStatus = (value, fallback = 'draft') => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return PACK_WEB_STATUS_VALUES.has(normalized) ? normalized : fallback;
};

const normalizePackWebUploadStatus = (value, fallback = 'pending') => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return PACK_WEB_UPLOAD_STATUS_VALUES.has(normalized) ? normalized : fallback;
};

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');
const normalizeEmail = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 255);
const constantTimeStringEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  try {
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
};

const extractBearerTokenFromRequest = (req) => {
  const authHeader = String(req?.headers?.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) return '';
  return authHeader.slice(7).trim();
};

const resolveInternalApiTokenFromRequest = (req) => {
  const explicit = String(req?.headers?.['x-internal-api-token'] || '').trim();
  if (explicit) return explicit;
  const adminHeader = String(req?.headers?.['x-admin-token'] || '').trim();
  if (adminHeader) return adminHeader;
  return extractBearerTokenFromRequest(req);
};

const hasValidInternalApiToken = (req) => {
  if (!USER_INTERNAL_API_TOKEN) return false;
  const requestToken = resolveInternalApiTokenFromRequest(req);
  if (!requestToken) return false;
  return constantTimeStringEqual(requestToken, USER_INTERNAL_API_TOKEN);
};

const isAuthenticatedGoogleSession = (session) => Boolean(session?.sub && (session?.ownerJid || session?.ownerPhone || session?.email));

const resolveSupportAdminPhone = async () => {
  try {
    const support = await buildSupportInfo();
    return toWhatsAppPhoneDigits(support?.phone || '') || '';
  } catch {
    return '';
  }
};

const isAdminGoogleSession = async (session) => {
  if (!isAuthenticatedGoogleSession(session)) return false;

  const sessionEmail = normalizeEmail(session?.email || '');
  if (ADMIN_PANEL_EMAIL && sessionEmail && sessionEmail === ADMIN_PANEL_EMAIL) {
    return true;
  }

  const adminPhone = await resolveSupportAdminPhone().catch(() => '');
  if (!adminPhone) return false;
  return toWhatsAppPhoneDigits(session?.ownerPhone || session?.ownerJid || '') === adminPhone || toWhatsAppPhoneDigits(session?.ownerJid || '') === adminPhone;
};

const requireInternalUserApiReadAccess = async (req, res) => {
  if (!USER_INTERNAL_READ_REQUIRE_AUTH) return true;

  if (hasValidInternalApiToken(req)) return true;

  const session = await resolveGoogleWebSessionFromRequest(req).catch(() => null);
  if (await isAdminGoogleSession(session)) return true;

  sendJson(req, res, 401, { error: 'Nao autorizado.' });
  return false;
};

const requireContactUserApiReadAccess = async (req, res, session = null) => {
  if (!USER_CONTACT_ENDPOINT_REQUIRE_AUTH) return true;
  if (hasValidInternalApiToken(req)) return true;
  if (isAuthenticatedGoogleSession(session)) return true;
  sendJson(req, res, 401, { error: 'Sessao obrigatoria para consultar contato.' });
  return false;
};

const clampUploadErrorMessage = (message) =>
  String(message || '')
    .trim()
    .slice(0, WEB_UPLOAD_ERROR_MESSAGE_MAX) || null;

const runSqlTransaction = async (handler) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const normalizeWebUploadId = (value) =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '')
    .slice(0, WEB_UPLOAD_ID_MAX_LENGTH);

const normalizeStickerHashHex = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-f0-9]/g, '');
  return normalized.length === 64 ? normalized : '';
};

const normalizePackWebUploadRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    pack_id: row.pack_id,
    upload_id: row.upload_id,
    sticker_hash: row.sticker_hash,
    source_mimetype: row.source_mimetype || null,
    upload_status: normalizePackWebUploadStatus(row.upload_status, 'pending'),
    sticker_id: row.sticker_id || null,
    error_code: row.error_code || null,
    error_message: row.error_message || null,
    attempt_count: Number(row.attempt_count || 0),
    last_attempt_at: row.last_attempt_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
};

const listPackWebUploads = async (packId, connection = null) => {
  const rows = await executeQuery(
    `SELECT *
     FROM ${TABLES.STICKER_PACK_WEB_UPLOAD}
     WHERE pack_id = ?
     ORDER BY updated_at ASC, created_at ASC`,
    [packId],
    connection,
  );
  return rows.map((row) => normalizePackWebUploadRow(row));
};

const findPackWebUploadByUploadId = async (packId, uploadId, connection = null) => {
  if (!packId || !uploadId) return null;
  const rows = await executeQuery(
    `SELECT *
     FROM ${TABLES.STICKER_PACK_WEB_UPLOAD}
     WHERE pack_id = ? AND upload_id = ?
     LIMIT 1`,
    [packId, uploadId],
    connection,
  );
  return normalizePackWebUploadRow(rows?.[0] || null);
};

const findPackWebUploadByStickerHash = async (packId, stickerHash, connection = null) => {
  if (!packId || !stickerHash) return null;
  const rows = await executeQuery(
    `SELECT *
     FROM ${TABLES.STICKER_PACK_WEB_UPLOAD}
     WHERE pack_id = ? AND sticker_hash = ?
     LIMIT 1`,
    [packId, stickerHash],
    connection,
  );
  return normalizePackWebUploadRow(rows?.[0] || null);
};

const createPackWebUpload = async (entry, connection = null) => {
  await executeQuery(
    `INSERT INTO ${TABLES.STICKER_PACK_WEB_UPLOAD}
      (id, pack_id, upload_id, sticker_hash, source_mimetype, upload_status, sticker_id, error_code, error_message, attempt_count, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.pack_id, entry.upload_id, entry.sticker_hash, entry.source_mimetype ?? null, normalizePackWebUploadStatus(entry.upload_status, 'pending'), entry.sticker_id ?? null, entry.error_code ?? null, clampUploadErrorMessage(entry.error_message), Math.max(0, Number(entry.attempt_count || 0)), entry.last_attempt_at ?? null],
    connection,
  );
  return findPackWebUploadByUploadId(entry.pack_id, entry.upload_id, connection);
};

const updatePackWebUpload = async (uploadIdPk, fields, connection = null) => {
  const clauses = [];
  const params = [];
  const mappings = {
    upload_status: (value) => normalizePackWebUploadStatus(value, 'pending'),
    sticker_id: (value) => value ?? null,
    error_code: (value) => (value ? String(value).trim().slice(0, 64) : null),
    error_message: (value) => clampUploadErrorMessage(value),
    source_mimetype: (value) => (value ? String(value).trim().slice(0, 64) : null),
    attempt_count: (value) => Math.max(0, Number(value || 0)),
    last_attempt_at: (value) => value ?? null,
  };

  for (const [field, mapValue] of Object.entries(mappings)) {
    if (!(field in fields)) continue;
    clauses.push(`${field} = ?`);
    params.push(mapValue(fields[field]));
  }

  if (!clauses.length) return null;
  clauses.push('updated_at = CURRENT_TIMESTAMP');

  await executeQuery(
    `UPDATE ${TABLES.STICKER_PACK_WEB_UPLOAD}
     SET ${clauses.join(', ')}
     WHERE id = ?`,
    [...params, uploadIdPk],
    connection,
  );

  const rows = await executeQuery(`SELECT * FROM ${TABLES.STICKER_PACK_WEB_UPLOAD} WHERE id = ? LIMIT 1`, [uploadIdPk], connection);
  return normalizePackWebUploadRow(rows?.[0] || null);
};

const setStickerPackStatus = async (packId, status, connection = null) => {
  const normalizedStatus = normalizePackWebStatus(status, 'draft');
  await executeQuery(
    `UPDATE ${TABLES.STICKER_PACK}
     SET status = ?,
         version = version + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NULL`,
    [normalizedStatus, packId],
    connection,
  );
  return normalizedStatus;
};

const lockStickerPackByPackKey = async (packKey, connection) => {
  const rows = await executeQuery(
    `SELECT *
     FROM ${TABLES.STICKER_PACK}
     WHERE pack_key = ? AND deleted_at IS NULL
     LIMIT 1
     FOR UPDATE`,
    [packKey],
    connection,
  );
  return rows?.[0] || null;
};

const getPackConsistencySnapshot = async (packId, coverStickerId = null, connection = null) => {
  const [itemsRow] = await executeQuery(
    `SELECT
       COUNT(*) AS sticker_count,
       SUM(CASE WHEN sticker_id = ? THEN 1 ELSE 0 END) AS cover_matches
     FROM ${TABLES.STICKER_PACK_ITEM}
     WHERE pack_id = ?`,
    [coverStickerId || '', packId],
    connection,
  );

  const [uploadRow] = await executeQuery(
    `SELECT
       COUNT(*) AS total_uploads,
       SUM(CASE WHEN upload_status = 'done' THEN 1 ELSE 0 END) AS done_uploads,
       SUM(CASE WHEN upload_status = 'failed' THEN 1 ELSE 0 END) AS failed_uploads,
       SUM(CASE WHEN upload_status = 'processing' THEN 1 ELSE 0 END) AS processing_uploads,
       SUM(CASE WHEN upload_status = 'pending' THEN 1 ELSE 0 END) AS pending_uploads
     FROM ${TABLES.STICKER_PACK_WEB_UPLOAD}
     WHERE pack_id = ?`,
    [packId],
    connection,
  );

  return {
    sticker_count: Number(itemsRow?.sticker_count || 0),
    cover_set: Boolean(coverStickerId),
    cover_valid: Boolean(coverStickerId) && Number(itemsRow?.cover_matches || 0) > 0,
    total_uploads: Number(uploadRow?.total_uploads || 0),
    done_uploads: Number(uploadRow?.done_uploads || 0),
    failed_uploads: Number(uploadRow?.failed_uploads || 0),
    processing_uploads: Number(uploadRow?.processing_uploads || 0),
    pending_uploads: Number(uploadRow?.pending_uploads || 0),
  };
};

const buildPackPublishStateData = async (pack, { includeUploads = true, connection = null } = {}) => {
  const snapshot = await getPackConsistencySnapshot(pack.id, pack.cover_sticker_id, connection);
  const uploads = includeUploads ? await listPackWebUploads(pack.id, connection) : [];

  return {
    pack_key: pack.pack_key,
    status: normalizePackWebStatus(pack.status, 'draft'),
    visibility: pack.visibility,
    cover_sticker_id: pack.cover_sticker_id || null,
    consistency: {
      sticker_count: snapshot.sticker_count,
      cover_set: snapshot.cover_set,
      cover_valid: snapshot.cover_valid,
      total_uploads: snapshot.total_uploads,
      done_uploads: snapshot.done_uploads,
      failed_uploads: snapshot.failed_uploads,
      processing_uploads: snapshot.processing_uploads,
      pending_uploads: snapshot.pending_uploads,
      can_publish: snapshot.sticker_count >= 1 && snapshot.failed_uploads === 0 && snapshot.processing_uploads === 0 && snapshot.pending_uploads === 0 && snapshot.cover_valid,
    },
    uploads: uploads.map((entry) => ({
      upload_id: entry.upload_id,
      sticker_hash: entry.sticker_hash,
      status: entry.upload_status,
      sticker_id: entry.sticker_id || null,
      error_code: entry.error_code || null,
      error_message: entry.error_message || null,
      attempt_count: Number(entry.attempt_count || 0),
      updated_at: toIsoOrNull(entry.updated_at),
    })),
    updated_at: toIsoOrNull(pack.updated_at),
    published: normalizePackWebStatus(pack.status, 'draft') === 'published',
  };
};

const maybeCleanupStaleDraftPacks = async () => {
  if (staleDraftCleanupState.running) return;
  if (__timeNowMs() - staleDraftCleanupState.lastRunAt < WEB_DRAFT_CLEANUP_RUN_INTERVAL_MS) return;

  staleDraftCleanupState.running = true;
  staleDraftCleanupState.lastRunAt = __timeNowMs();

  try {
    const rows = await executeQuery(
      `SELECT p.id, p.pack_key
       FROM ${TABLES.STICKER_PACK} p
       LEFT JOIN ${TABLES.STICKER_PACK_ITEM} i ON i.pack_id = p.id
       WHERE p.deleted_at IS NULL
         AND p.status = 'draft'
         AND p.updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? SECOND)
       GROUP BY p.id, p.pack_key
       HAVING COUNT(i.id) = 0
       LIMIT 200`,
      [Math.floor(WEB_DRAFT_CLEANUP_TTL_MS / 1000)],
    );

    if (!rows.length) return;

    await executeQuery(
      `UPDATE ${TABLES.STICKER_PACK}
       SET deleted_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           version = version + 1
       WHERE id IN (${rows.map(() => '?').join(', ')})`,
      rows.map((row) => row.id),
    );

    logPackWebFlow('info', 'cleanup_draft_deleted', {
      deleted_count: rows.length,
      ttl_ms: WEB_DRAFT_CLEANUP_TTL_MS,
    });
  } catch (error) {
    logPackWebFlow('warn', 'cleanup_draft_failed', {
      error: error?.message,
    });
  } finally {
    staleDraftCleanupState.running = false;
  }
};

const triggerStaleDraftCleanup = () => {
  maybeCleanupStaleDraftPacks().catch(() => {});
};

let revokeGoogleWebSessionsByIdentityBridge = async () => 0;

const adminBanContext = createStickerCatalogAdminBanContext({
  executeQuery,
  tables: TABLES,
  sanitizeText,
  normalizeGoogleSubject,
  normalizeEmail,
  normalizeJid,
  toIsoOrNull,
  revokeGoogleWebSessionsByIdentity: (payload) => revokeGoogleWebSessionsByIdentityBridge(payload),
});

const { listAdminBans, createAdminBanRecord, revokeAdminBanRecord, assertGoogleIdentityNotBanned } = adminBanContext;

const sendAsset = (req, res, buffer, mimetype = 'image/webp', cacheControlOverride = '') => {
  const maxAgeSeconds = Math.max(60 * 60 * 24, ASSET_CACHE_SECONDS);
  const staleWhileRevalidateSeconds = Math.min(60 * 60 * 24 * 7, Math.max(300, maxAgeSeconds));
  res.statusCode = 200;
  res.setHeader('Content-Type', mimetype);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', cacheControlOverride || `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(buffer);
};

const CATALOG_STYLES_WEB_PATH = `${STICKER_WEB_PATH}/assets/styles.css`;
const CATALOG_SCRIPT_WEB_PATH = `${STICKER_WEB_PATH}/assets/catalog.js`;
const resolveActiveSocketBotJid = (activeSocket) => {
  if (!activeSocket) return '';
  const candidates = [activeSocket?.user?.id, activeSocket?.authState?.creds?.me?.id, activeSocket?.authState?.creds?.me?.lid];
  for (const candidate of candidates) {
    const resolved = resolveBotJid(candidate) || '';
    if (resolved) return resolved;
  }
  return '';
};

const buildPackWhatsAppText = (pack) => STICKER_WEB_WHATSAPP_MESSAGE_TEMPLATE.replaceAll('{{pack_key}}', String(pack?.pack_key || '')).replaceAll('{{pack_name}}', String(pack?.name || ''));

const buildPackWhatsAppInfo = (pack) => {
  const phone = resolveCatalogBotPhone();
  if (!phone) return null;

  const text = buildPackWhatsAppText(pack);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;

  return {
    phone,
    text,
    url,
  };
};

const saveWebPackEditToken = ({ packId, ownerJid }) => {
  if (!packId || !ownerJid) return null;
  const token = randomUUID();
  webPackEditTokenMap.set(token, {
    packId,
    ownerJid,
    expiresAt: __timeNowMs() + PACK_WEB_EDIT_TOKEN_TTL_MS,
  });
  return token;
};

const resolveWebPackEditToken = (token) => {
  const normalized = String(token || '').trim();
  if (!normalized) return null;
  const entry = webPackEditTokenMap.get(normalized);
  if (!entry) return null;
  if (entry.expiresAt <= __timeNowMs()) {
    webPackEditTokenMap.delete(normalized);
    return null;
  }
  return entry;
};

const decodeStickerBase64Payload = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const dataUrlMatch = raw.match(/^data:([^;]+);base64,([\s\S]+)$/i);
  const base64Value = dataUrlMatch ? dataUrlMatch[2] : raw;
  const mimetype = dataUrlMatch
    ? String(dataUrlMatch[1] || '')
        .trim()
        .toLowerCase()
    : 'image/webp';
  const cleaned = base64Value.replace(/\s+/g, '');
  if (!cleaned) return null;

  const buffer = Buffer.from(cleaned, 'base64');
  if (!buffer.length) return null;
  return {
    buffer,
    mimetype,
  };
};

const isLikelyWebpBuffer = (buffer) => Buffer.isBuffer(buffer) && buffer.length >= 16 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';

const resolveExtensionFromMimetype = (mimetype) => {
  const normalized = String(mimetype || '')
    .trim()
    .toLowerCase();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/avif') return 'avif';
  if (normalized === 'image/heic') return 'heic';
  if (normalized === 'image/heif') return 'heif';
  if (normalized === 'image/bmp') return 'bmp';
  if (normalized === 'image/tiff') return 'tiff';
  if (normalized === 'image/x-icon') return 'ico';
  if (normalized === 'video/webm') return 'webm';
  if (normalized === 'video/quicktime') return 'mov';
  if (normalized === 'video/x-m4v') return 'm4v';
  if (normalized === 'video/mp4') return 'mp4';
  if (normalized === 'image/webp') return 'webp';
  return 'bin';
};

const isPreviewVariantRequested = (url) => {
  const variant = String(url?.searchParams?.get('variant') || url?.searchParams?.get('mode') || '')
    .trim()
    .toLowerCase();
  if (['preview', 'thumb', 'thumbnail', 'small'].includes(variant)) return true;

  const previewFlag = String(url?.searchParams?.get('preview') || '')
    .trim()
    .toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(previewFlag);
};

const getStickerPreviewFromCache = (cacheKey) => {
  const entry = STICKER_PREVIEW_CACHE.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= __timeNowMs()) {
    STICKER_PREVIEW_CACHE.delete(cacheKey);
    return null;
  }
  return entry.buffer;
};

const saveStickerPreviewToCache = (cacheKey, buffer) => {
  if (!cacheKey || !Buffer.isBuffer(buffer) || !buffer.length) return;
  if (STICKER_PREVIEW_CACHE.size >= STICKER_PREVIEW_CACHE_MAX_ITEMS) {
    const overflow = STICKER_PREVIEW_CACHE.size - STICKER_PREVIEW_CACHE_MAX_ITEMS + 1;
    const keys = STICKER_PREVIEW_CACHE.keys();
    for (let index = 0; index < overflow; index += 1) {
      const next = keys.next();
      if (next.done) break;
      STICKER_PREVIEW_CACHE.delete(next.value);
    }
  }
  STICKER_PREVIEW_CACHE.set(cacheKey, {
    buffer,
    expiresAt: __timeNowMs() + STICKER_PREVIEW_CACHE_TTL_MS,
  });
};

const runPreviewFfmpeg = (args, timeoutMs = STICKER_PREVIEW_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(
      () => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Processo já encerrado.
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Processo já encerrado.
          }
        }, 1200);
      },
      Math.max(400, Number(timeoutMs || STICKER_PREVIEW_TIMEOUT_MS)),
    );

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk || '')}`.slice(-16 * 1024);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const timeoutError = new Error('preview_ffmpeg_timeout');
        timeoutError.code = 'ETIMEDOUT';
        timeoutError.stderr = stderr;
        reject(timeoutError);
        return;
      }
      if (code !== 0) {
        const processError = new Error(`preview_ffmpeg_failed_code_${code}`);
        processError.code = code;
        processError.stderr = stderr;
        reject(processError);
        return;
      }
      resolve();
    });
  });

const generateStickerPreviewBuffer = async ({ sourceBuffer, mimetype = 'image/webp', cacheKey = '' } = {}) => {
  if (!Buffer.isBuffer(sourceBuffer) || !sourceBuffer.length) return null;
  if (cacheKey) {
    const cached = getStickerPreviewFromCache(cacheKey);
    if (cached) return cached;
  }

  const uniqueId = randomUUID();
  const extension = resolveExtensionFromMimetype(mimetype || 'image/webp');
  const inputPath = path.join(STICKER_PREVIEW_TEMP_DIR, `${uniqueId}.in.${extension}`);
  const outputPath = path.join(STICKER_PREVIEW_TEMP_DIR, `${uniqueId}.preview.webp`);

  try {
    await fs.mkdir(STICKER_PREVIEW_TEMP_DIR, { recursive: true });
    await fs.writeFile(inputPath, sourceBuffer);
    const side = Math.max(96, Math.min(512, Number(STICKER_PREVIEW_SIDE_PX || 112)));
    const quality = Math.max(10, Math.min(80, Number(STICKER_PREVIEW_QUALITY || 20)));
    const filter = `scale=if(gte(iw,ih),${side},-1):if(gte(iw,ih),-1,${side}):flags=lanczos`;
    await runPreviewFfmpeg(['-y', '-i', inputPath, '-vf', filter, '-frames:v', '1', '-vcodec', 'libwebp', '-lossless', '0', '-q:v', String(quality), '-compression_level', '6', '-preset', 'picture', '-an', outputPath], STICKER_PREVIEW_TIMEOUT_MS);
    const previewBuffer = await fs.readFile(outputPath);
    if (cacheKey && previewBuffer.length) {
      saveStickerPreviewToCache(cacheKey, previewBuffer);
    }
    return previewBuffer.length ? previewBuffer : null;
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
};

const convertUploadMediaToWebp = async ({ ownerJid, buffer, mimetype }) => {
  const normalizedMimetype =
    String(mimetype || '')
      .trim()
      .toLowerCase() || 'image/webp';
  const isVideo = normalizedMimetype.startsWith('video/');
  const isImage = normalizedMimetype.startsWith('image/');

  if (!isVideo && !isImage) {
    throw new StickerPackError(STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Formato não suportado. Envie imagem ou vídeo.');
  }

  if (isLikelyWebpBuffer(buffer) && buffer.length <= MAX_STICKER_UPLOAD_BYTES) {
    return { buffer, mimetype: 'image/webp' };
  }

  if (isVideo && !ALLOWED_WEB_UPLOAD_VIDEO_MIMETYPES.has(normalizedMimetype) && normalizedMimetype !== 'video/mp4') {
    throw new StickerPackError(STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'Formato de vídeo não suportado. Use mp4/webm/mov/m4v.');
  }

  const uniqueId = randomUUID();
  const inputPath = path.join(process.cwd(), 'temp', 'stickers', 'web-create', `${uniqueId}.${resolveExtensionFromMimetype(normalizedMimetype)}`);

  await fs.mkdir(path.dirname(inputPath), { recursive: true });
  await fs.writeFile(inputPath, buffer);

  const conversionProfiles = isVideo
    ? [
        { videoMaxDurationSeconds: 8, videoFps: 10, videoQuality: 55, videoCompressionLevel: 6 },
        { videoMaxDurationSeconds: 6, videoFps: 9, videoQuality: 50, videoCompressionLevel: 6 },
        { videoMaxDurationSeconds: 4, videoFps: 8, videoQuality: 44, videoCompressionLevel: 6 },
        { videoMaxDurationSeconds: 3, videoFps: 8, videoQuality: 38, videoCompressionLevel: 6 },
        { videoMaxDurationSeconds: 2, videoFps: 7, videoQuality: 34, videoCompressionLevel: 6 },
        { videoMaxDurationSeconds: 1, videoFps: 6, videoQuality: 30, videoCompressionLevel: 6 },
      ]
    : [{ stretch: true }, { stretch: false }];

  let lastError = null;
  try {
    for (const profile of conversionProfiles) {
      let outputPath = null;
      try {
        outputPath = await convertToWebp(inputPath, isVideo ? 'video' : 'image', ownerJid, randomUUID(), {
          ...profile,
          maxOutputSizeBytes: MAX_STICKER_UPLOAD_BYTES,
        });
        const converted = await fs.readFile(outputPath);
        if (!isLikelyWebpBuffer(converted) || converted.length > MAX_STICKER_UPLOAD_BYTES) {
          throw new Error('WEBP convertido excedeu o limite final.');
        }
        return { buffer: converted, mimetype: 'image/webp' };
      } catch (error) {
        lastError = error;
      } finally {
        if (outputPath) {
          await fs.unlink(outputPath).catch(() => {});
        }
      }
    }
  } finally {
    await fs.unlink(inputPath).catch(() => {});
  }

  throw new StickerPackError(STICKER_PACK_ERROR_CODES.INVALID_INPUT, `Não foi possível converter a mídia para sticker no limite de ${Math.round(MAX_STICKER_UPLOAD_BYTES / 1024)}KB.`, lastError);
};

const PACK_TAG_MARKER_REGEX = /\[pack-tags:([^\]]+)\]/i;
const AUTO_PACK_MARKER_REGEX = /\[(?:auto-theme|auto-tag):[^\]]+\]/gi;
const AUTO_PACK_MARKER_TEST_REGEX = /\[(?:auto-theme|auto-tag):[^\]]+\]/i;
const AUTO_PACK_COLLECTOR_MARKER = '[auto-pack:collector]';
const AUTO_PACK_COLLECTOR_LEGACY_TEXT = 'coleção automática de figurinhas criadas pelo usuário.';
const AUTO_PACK_DESCRIPTION_PREFIX_REGEX = /^curadoria automática por tema\.\s*tema:\s*[^.]+\.?\s*(?:score\s*=\s*-?\d+(?:\.\d+)?\.?\s*)?/i;
const AUTO_PACK_SCORE_FRAGMENT_REGEX = /\bscore\s*=\s*-?\d+(?:\.\d+)?\.?/gi;
const normalizePackTag = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const mergeUniqueTags = (...groups) => {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      const normalized = normalizePackTag(entry);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged;
};

const parsePackDescriptionMetadata = (description) => {
  const raw = String(description || '').trim();
  if (!raw) return { cleanDescription: null, tags: [] };

  const marker = raw.match(PACK_TAG_MARKER_REGEX);
  const markerTags = marker?.[1]
    ? marker[1]
        .split(',')
        .map((entry) => normalizePackTag(entry))
        .filter(Boolean)
    : [];
  let cleanDescription = raw.replace(PACK_TAG_MARKER_REGEX, '').trim() || null;
  const hasAutoPackMarker = AUTO_PACK_MARKER_TEST_REGEX.test(cleanDescription || '');
  if (cleanDescription) {
    cleanDescription = cleanDescription.replace(AUTO_PACK_MARKER_REGEX, '').trim() || null;
  }
  if (cleanDescription && hasAutoPackMarker) {
    cleanDescription =
      cleanDescription
        .replace(AUTO_PACK_DESCRIPTION_PREFIX_REGEX, '')
        .replace(AUTO_PACK_SCORE_FRAGMENT_REGEX, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s.:-]+/, '')
        .trim() || null;
  }

  return {
    cleanDescription,
    tags: mergeUniqueTags(markerTags).slice(0, 8),
  };
};

const isCollectorAutoPack = (pack) => {
  if (!pack || typeof pack !== 'object') return false;
  const description = String(pack.description || '').toLowerCase();
  return description.includes(AUTO_PACK_COLLECTOR_MARKER) || description.includes(AUTO_PACK_COLLECTOR_LEGACY_TEXT);
};

const isThemeCurationAutoPack = (pack) => {
  if (!pack || typeof pack !== 'object') return false;
  const name = String(pack.name || '').trim();
  if (/^\[auto\]/i.test(name)) return true;

  const description = String(pack.description || '').toLowerCase();
  if (description.includes('[auto-theme:') || description.includes('[auto-tag:')) return true;

  return Boolean(String(pack.pack_theme_key || '').trim());
};

const shouldHidePackFromMyProfileDefault = (pack, { includeAutoPacks = false } = {}) => {
  if (!pack || typeof pack !== 'object') return false;
  if (includeAutoPacks) return false;
  if (isCollectorAutoPack(pack)) return false;
  if (isThemeCurationAutoPack(pack)) return true;
  return pack.is_auto_pack === true || Number(pack.is_auto_pack || 0) === 1;
};

const buildPackDescriptionWithTags = (description, tags = []) => {
  const cleanDescription = sanitizeText(description || '', PACK_CREATE_MAX_DESCRIPTION_LENGTH, { allowEmpty: true }) || '';
  const normalizedTags = mergeUniqueTags(tags).slice(0, 8);
  const marker = normalizedTags.length ? `[pack-tags:${normalizedTags.join(',')}]` : '';
  const combined = `${marker}${marker && cleanDescription ? ' ' : ''}${cleanDescription}`.trim();
  return combined || null;
};

const buildPackApiUrl = (packKey) => `${STICKER_API_BASE_PATH}/${encodeURIComponent(packKey)}`;
const buildPackWebUrl = (packKey) => `${STICKER_WEB_PATH}/${encodeURIComponent(packKey)}`;
const buildStickerAssetUrl = (packKey, stickerId) => `${STICKER_API_BASE_PATH}/${encodeURIComponent(packKey)}/stickers/${encodeURIComponent(stickerId)}.webp`;
const buildStickerAssetPreviewUrl = (packKey, stickerId, versionToken = '') => {
  const params = new URLSearchParams();
  params.set('variant', 'preview');
  params.set('sz', String(STICKER_PREVIEW_SIDE_PX));
  params.set('q', String(STICKER_PREVIEW_QUALITY));
  const normalizedVersion = String(versionToken || '').trim();
  if (normalizedVersion) params.set('v', normalizedVersion);
  return `${buildStickerAssetUrl(packKey, stickerId)}?${params.toString()}`;
};
const buildDataAssetApiBaseUrl = () => `${STICKER_API_BASE_PATH}/data-files`;

const mapPackSummary = (pack, engagement = null, signals = null) => {
  const safeEngagement = engagement || getEmptyStickerPackEngagement();
  const metadata = parsePackDescriptionMetadata(pack.description);
  const stickerCount = Number(pack.sticker_count || 0);
  const coverVersionToken = toIsoOrNull(pack.updated_at) || toIsoOrNull(pack.created_at) || '';
  return {
    id: pack.id,
    pack_key: pack.pack_key,
    name: pack.name,
    publisher: pack.publisher,
    description: metadata.cleanDescription,
    visibility: pack.visibility,
    status: normalizePackWebStatus(pack.status, 'published'),
    sticker_count: stickerCount,
    is_complete: stickerCount >= PACK_CREATE_MAX_ITEMS,
    cover_sticker_id: pack.cover_sticker_id || null,
    cover_url: pack.cover_sticker_id ? buildStickerAssetUrl(pack.pack_key, pack.cover_sticker_id) : null,
    cover_preview_url: pack.cover_sticker_id ? buildStickerAssetPreviewUrl(pack.pack_key, pack.cover_sticker_id, coverVersionToken) : null,
    api_url: buildPackApiUrl(pack.pack_key),
    web_url: buildPackWebUrl(pack.pack_key),
    whatsapp: buildPackWhatsAppInfo(pack),
    created_at: toIsoOrNull(pack.created_at),
    updated_at: toIsoOrNull(pack.updated_at),
    engagement: {
      open_count: Number(safeEngagement.open_count || 0),
      like_count: Number(safeEngagement.like_count || 0),
      dislike_count: Number(safeEngagement.dislike_count || 0),
      score: Number(safeEngagement.score || 0) || Number(safeEngagement.like_count || 0) - Number(safeEngagement.dislike_count || 0),
      updated_at: toIsoOrNull(safeEngagement.updated_at),
    },
    signals: signals || null,
    manual_tags: metadata.tags,
  };
};

const NSFW_HINT_TOKENS = ['nsfw', 'adult', 'explicit', 'suggestive', 'sexual', 'porn', 'nud', 'gore', '18', 'bikini', 'lingerie', 'underwear', 'swimsuit'];
const normalizeNsfwToken = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-');

const hasNsfwHint = (value) => {
  const normalized = normalizeNsfwToken(value);
  if (!normalized) return false;
  return NSFW_HINT_TOKENS.some((token) => normalized.includes(token));
};

const hasNsfwHintsInList = (values) => {
  const list = Array.isArray(values) ? values : [];
  return list.some((entry) => hasNsfwHint(entry));
};

const isClassificationMarkedNsfw = (classification) => {
  if (!classification || typeof classification !== 'object') return false;
  if (classification.is_nsfw === true) return true;

  const nsfw = classification.nsfw || {};
  if (Number(nsfw.flagged_items || 0) > 0) return true;
  if (Number(nsfw.max_score || 0) >= 0.12) return true;
  if (Number(nsfw.avg_score || 0) >= 0.08) return true;

  if (hasNsfwHint(classification.category || classification.majority_category || '')) return true;
  if (hasNsfwHintsInList(classification.tags)) return true;
  return false;
};

const isSignalMarkedNsfw = (signals) => {
  const level = String(signals?.nsfw_level || '')
    .trim()
    .toLowerCase();
  if (signals?.sensitive_content === true) return true;
  if (!level) return false;
  return level !== 'safe';
};

const isPackSummaryMarkedNsfw = (packSummary) => {
  if (!packSummary || typeof packSummary !== 'object') return false;
  if (packSummary.is_nsfw === true) return true;
  if (isSignalMarkedNsfw(packSummary.signals)) return true;
  if (isClassificationMarkedNsfw(packSummary.classification)) return true;
  if (hasNsfwHint(packSummary.name || '')) return true;
  if (hasNsfwHint(packSummary.description || '')) return true;
  if (hasNsfwHintsInList(packSummary.tags) || hasNsfwHintsInList(packSummary.manual_tags)) return true;
  return false;
};

const mapPackDetails = (pack, items, { byAssetClassification = new Map(), packClassification = null, engagement = null, signals = null, hideSensitiveAssets = false } = {}) => {
  const coverStickerId = pack.cover_sticker_id || items[0]?.sticker_id || null;
  const metadata = parsePackDescriptionMetadata(pack.description);
  const decoratedClassification = decoratePackClassificationSummary(packClassification);
  const mergedTags = mergeUniqueTags(decoratedClassification?.tags || [], metadata.tags);
  const summary = mapPackSummary(
    {
      ...pack,
      description: metadata.cleanDescription,
      cover_sticker_id: coverStickerId,
      sticker_count: items.length,
    },
    engagement,
    signals,
  );
  const packPreview = {
    ...summary,
    classification: {
      ...(decoratedClassification || {}),
      tags: mergedTags,
    },
    tags: mergedTags,
  };
  const packIsNsfw = isPackSummaryMarkedNsfw(packPreview);
  const safeSummary = hideSensitiveAssets && packIsNsfw ? { ...summary, cover_url: null, cover_preview_url: null } : summary;

  return {
    ...safeSummary,
    is_nsfw: packIsNsfw,
    items: items.map((item) => {
      const decoratedItemClassification = decorateStickerClassification(byAssetClassification.get(item.sticker_id) || null);
      const itemIsNsfw = isClassificationMarkedNsfw(decoratedItemClassification);
      const hideAsset = hideSensitiveAssets && (packIsNsfw || itemIsNsfw);
      const previewVersionToken = String(item?.asset?.id || item?.asset?.size_bytes || item?.created_at || pack?.updated_at || '').trim();
      return {
        // `tags` facilita renderização direta no front sem precisar reprocessar score.
        id: item.id,
        sticker_id: item.sticker_id,
        position: Number(item.position || 0),
        emojis: Array.isArray(item.emojis) ? item.emojis : [],
        accessibility_label: item.accessibility_label || null,
        created_at: toIsoOrNull(item.created_at),
        asset_url: hideAsset ? null : buildStickerAssetUrl(pack.pack_key, item.sticker_id),
        asset_preview_url: hideAsset ? null : buildStickerAssetPreviewUrl(pack.pack_key, item.sticker_id, previewVersionToken),
        tags: decoratedItemClassification?.tags || [],
        is_nsfw: itemIsNsfw,
        asset: item.asset
          ? {
              id: item.asset.id,
              mimetype: item.asset.mimetype || 'image/webp',
              is_animated: Boolean(item.asset.is_animated),
              width: item.asset.width !== null && item.asset.width !== undefined ? Number(item.asset.width) : null,
              height: item.asset.height !== null && item.asset.height !== undefined ? Number(item.asset.height) : null,
              size_bytes: item.asset.size_bytes !== null && item.asset.size_bytes !== undefined ? Number(item.asset.size_bytes) : 0,
              classification: decoratedItemClassification,
            }
          : null,
      };
    }),
    classification: {
      ...(decoratedClassification || {}),
      tags: mergedTags,
    },
    tags: mergedTags,
  };
};

const mapOrphanStickerAsset = (asset, classification = null, { hideSensitiveAssets = false } = {}) => {
  const decoratedClassification = decorateStickerClassification(classification || null);
  const isNsfw = isClassificationMarkedNsfw(decoratedClassification);
  return {
    id: asset.id,
    owner_jid: asset.owner_jid,
    sha256: asset.sha256,
    mimetype: asset.mimetype || 'image/webp',
    is_animated: Boolean(asset.is_animated),
    width: asset.width !== null && asset.width !== undefined ? Number(asset.width) : null,
    height: asset.height !== null && asset.height !== undefined ? Number(asset.height) : null,
    size_bytes: asset.size_bytes !== null && asset.size_bytes !== undefined ? Number(asset.size_bytes) : 0,
    created_at: toIsoOrNull(asset.created_at),
    url: hideSensitiveAssets && isNsfw ? null : toPublicDataUrlFromStoragePath(asset.storage_path),
    classification: decoratedClassification,
    tags: decoratedClassification?.tags || [],
    is_nsfw: isNsfw,
  };
};

const toSummaryEntry = (entry, { hideSensitiveCover = false } = {}) => {
  const summary = {
    ...mapPackSummary(entry.pack, entry.engagement, entry.signals),
    classification: entry.packClassification,
    tags: mergeUniqueTags(entry.packClassification?.tags || [], parsePackDescriptionMetadata(entry.pack?.description).tags),
  };
  const isNsfw = isPackSummaryMarkedNsfw(summary);
  const safeSummary = hideSensitiveCover && isNsfw ? { ...summary, cover_url: null, cover_preview_url: null } : summary;
  return {
    ...safeSummary,
    is_nsfw: isNsfw,
  };
};

const classifyPackIntent = (entry) => {
  if (entry?.signals?.trending_now) return 'crescendo_agora';
  if (entry?.signals?.pack_score >= 0.65) return 'em_alta';
  if (Number(entry?.engagement?.like_count || 0) >= 12) return 'mais_curtidos';
  return 'novos';
};

const normalizeViewerKey = (raw) =>
  String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:@-]+/g, '')
    .slice(0, 120);

const resolveActorKeysFromRequest = (req, url) => {
  const searchParams = url?.searchParams || new URLSearchParams();
  const cookies = parseCookies(req);
  const normalizeHeaderValue = (value) => (Array.isArray(value) ? value[0] : value);
  const firstKey = (...values) => {
    for (const value of values) {
      const normalized = normalizeViewerKey(value);
      if (normalized) return normalized;
    }
    return '';
  };

  const sessionKey = firstKey(searchParams.get('session_key'), searchParams.get('sid'), cookies.omnizap_sid, cookies.session_key, normalizeHeaderValue(req.headers['x-session-key']), normalizeHeaderValue(req.headers['x-client-session']));

  let actorKey = firstKey(searchParams.get('viewer_key'), searchParams.get('actor_key'), cookies.omnizap_vid, cookies.viewer_key, cookies.visitor_key, normalizeHeaderValue(req.headers['x-viewer-key']), normalizeHeaderValue(req.headers['x-visitor-key']), sessionKey);

  if (!actorKey) {
    const remoteIp = String(resolveRequestRemoteIp(req) || '').trim();
    const userAgent = String(req.headers['user-agent'] || '')
      .trim()
      .slice(0, 300);
    if (remoteIp || userAgent) {
      actorKey = createHash('sha256').update(`${remoteIp}|${userAgent}`).digest('hex').slice(0, 64);
    }
  }

  return {
    actorKey: firstKey(actorKey),
    sessionKey: firstKey(sessionKey),
    source: firstKey(searchParams.get('source'), searchParams.get('client_source'), normalizeHeaderValue(req.headers['x-client-source']), normalizeHeaderValue(req.headers['x-source'])) || 'web',
  };
};

const hydrateMarketplaceEntries = async (packs, { includeItems = true, driftSnapshot = null } = {}) => {
  const packIds = packs.map((pack) => pack.id);
  const engagementByPackId = await listStickerPackEngagementByPackIds(packIds);
  const interactionStatsByPackId = await listStickerPackInteractionStatsByPackIds(packIds);
  const useSnapshot = await canUseRankingSnapshotRead(`hydrate:${packIds.length}:${includeItems ? 1 : 0}`);
  const snapshotByPackId = useSnapshot ? await listStickerPackScoreSnapshotsByPackIds(packIds).catch(() => new Map()) : new Map();

  const entries = [];
  const packClassificationById = new Map();

  for (const pack of packs) {
    const items = includeItems ? await listStickerPackItems(pack.id) : [];
    const stickerIds = items.map((item) => item.sticker_id);
    const [packClassification, itemClassifications] = await Promise.all([getPackClassificationSummaryByAssetIds(stickerIds), stickerIds.length ? listStickerClassificationsByAssetIds(stickerIds) : Promise.resolve([])]);
    const byAssetClassification = new Map(itemClassifications.map((classification) => [classification.asset_id, classification]));
    const orderedClassifications = stickerIds.map((stickerId) => byAssetClassification.get(stickerId)).filter(Boolean);
    const engagement = engagementByPackId.get(pack.id) || getEmptyStickerPackEngagement();
    const interactionStats = interactionStatsByPackId.get(pack.id) || null;
    const packMetadata = parsePackDescriptionMetadata(pack.description);
    const decoratedClassification = decoratePackClassificationSummary(packClassification);
    const mergedPackTags = mergeUniqueTags(decoratedClassification?.tags || [], packMetadata.tags);
    const snapshot = snapshotByPackId.get(pack.id);
    const signals = snapshot?.signals
      ? {
          ...snapshot.signals,
          ranking_score: Number(snapshot?.signals?.ranking_score || 0),
          pack_score: Number(snapshot?.signals?.pack_score || 0),
          trend_score: Number(snapshot?.signals?.trend_score || 0),
          nsfw_level: String(snapshot?.signals?.nsfw_level || 'safe'),
          sensitive_content: Boolean(snapshot?.signals?.sensitive_content),
        }
      : computePackSignals({
          pack: { ...pack, items },
          engagement,
          packClassification,
          itemClassifications: orderedClassifications,
          interactionStats,
          scoringWeights: driftSnapshot?.weights || null,
        });

    const entry = {
      pack,
      items,
      engagement,
      packClassification: {
        ...(decoratedClassification || {}),
        tags: mergedPackTags,
      },
      signals,
      interactionStats,
    };
    entries.push(entry);
    packClassificationById.set(pack.id, entry.packClassification);
  }

  return { entries, packClassificationById };
};

const isStickerClassified = (classification) => {
  if (!classification || typeof classification !== 'object') return false;
  if (classification.category) return true;
  if (classification.is_nsfw) return true;
  if (classification.all_scores && Object.keys(classification.all_scores).length > 0) return true;
  return false;
};

const isPackClassified = (classificationSummary) => Boolean(classificationSummary && Number(classificationSummary.classified_items || 0) > 0);

const normalizeCategoryToken = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const parseCategoryFilters = (rawValue) => {
  const raw = String(rawValue || '').trim();
  if (!raw) return [];

  const parts = raw
    .split(',')
    .map((part) => normalizeCategoryToken(part))
    .filter(Boolean);

  return Array.from(new Set(parts)).slice(0, 20);
};

const hasAnyCategory = (tags, categories) => {
  if (!Array.isArray(categories) || !categories.length) return true;
  const normalized = new Set((Array.isArray(tags) ? tags : []).map((entry) => normalizeCategoryToken(entry)));
  return categories.some((category) => normalized.has(category));
};

const getEntryStickerCount = (entry) => Math.max(0, Number(entry?.pack?.sticker_count || 0));
const compareEntriesByPackCompleteness = (left, right) => {
  const leftCount = getEntryStickerCount(left);
  const rightCount = getEntryStickerCount(right);
  const leftIsComplete = leftCount >= PACK_CREATE_MAX_ITEMS ? 1 : 0;
  const rightIsComplete = rightCount >= PACK_CREATE_MAX_ITEMS ? 1 : 0;
  if (rightIsComplete !== leftIsComplete) return rightIsComplete - leftIsComplete;
  if (rightCount !== leftCount) return rightCount - leftCount;
  const leftHasCover = left?.pack?.cover_sticker_id ? 1 : 0;
  const rightHasCover = right?.pack?.cover_sticker_id ? 1 : 0;
  return rightHasCover - leftHasCover;
};

const resolveClassificationTags = (classification) => decorateStickerClassification(classification || null)?.tags || [];

const listClassifiedOrphanAssetsByCategories = async ({ search = '', categories = [], limit = 120, offset = 0 }) => {
  const safeLimit = Math.max(1, Math.min(MAX_ORPHAN_LIST_LIMIT, Number(limit) || DEFAULT_ORPHAN_LIST_LIMIT));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const normalizedCategories = Array.isArray(categories) ? categories.filter(Boolean) : [];
  const scanBatchSize = Math.max(safeLimit, 180);

  let cursorOffset = 0;
  let matchedCount = 0;
  const pageAssets = [];

  while (true) {
    const { assets, hasMore } = await listClassifiedStickerAssetsWithoutPack({
      search,
      limit: scanBatchSize,
      offset: cursorOffset,
    });

    if (!assets.length) break;

    const classifications = await listStickerClassificationsByAssetIds(assets.map((asset) => asset.id));
    const byAssetId = new Map(classifications.map((entry) => [entry.asset_id, entry]));

    for (const asset of assets) {
      const tags = resolveClassificationTags(byAssetId.get(asset.id));
      if (!hasAnyCategory(tags, normalizedCategories)) continue;

      const currentIndex = matchedCount;
      matchedCount += 1;

      if (currentIndex >= safeOffset && pageAssets.length < safeLimit) {
        pageAssets.push(asset);
      }
    }

    cursorOffset += assets.length;
    if (!hasMore) break;
  }

  return {
    assets: pageAssets,
    total: matchedCount,
    hasMore: safeOffset + safeLimit < matchedCount,
  };
};

export const extractPackKeyFromWebPath = (pathname) => {
  if (!hasPathPrefix(pathname, STICKER_WEB_PATH)) return null;

  const suffix = pathname.slice(STICKER_WEB_PATH.length);
  if (!suffix || suffix === '/') return null;

  const [firstSegment] = suffix.split('/').filter(Boolean);
  if (!firstSegment) return null;

  try {
    return decodeURIComponent(firstSegment);
  } catch {
    return null;
  }
};

const seoContext = createStickerCatalogSeoContext({
  executeQuery,
  tables: TABLES,
  listStickerPacksForCatalog,
  logger,
  sendJson,
  toSiteAbsoluteUrl,
  isPackPubliclyVisible,
  buildPackWebUrl,
  config: {
    stickerWebPath: STICKER_WEB_PATH,
    stickerApiBasePath: STICKER_API_BASE_PATH,
    stickerOrphanApiPath: STICKER_ORPHAN_API_PATH,
    stickerLoginWebPath: STICKER_LOGIN_WEB_PATH,
    stickerCreateWebPath: STICKER_CREATE_WEB_PATH,
    stickerDataPublicPath: STICKER_DATA_PUBLIC_PATH,
    defaultListLimit: DEFAULT_LIST_LIMIT,
    defaultOrphanListLimit: DEFAULT_ORPHAN_LIST_LIMIT,
    catalogTemplatePath: CATALOG_TEMPLATE_PATH,
    createPackTemplatePath: CREATE_PACK_TEMPLATE_PATH,
    catalogStylesFilePath: CATALOG_STYLES_FILE_PATH,
    catalogScriptFilePath: CATALOG_SCRIPT_FILE_PATH,
    stickerWebAssetVersion: STICKER_WEB_ASSET_VERSION,
    catalogStylesWebPath: CATALOG_STYLES_WEB_PATH,
    catalogScriptWebPath: CATALOG_SCRIPT_WEB_PATH,
    nsfwStickerPlaceholderUrl: NSFW_STICKER_PLACEHOLDER_URL,
    packCommandPrefix: PACK_COMMAND_PREFIX,
    staticTextCacheSeconds: STATIC_TEXT_CACHE_SECONDS,
    immutableAssetCacheSeconds: IMMUTABLE_ASSET_CACHE_SECONDS,
    sitemapMaxPacks: SITEMAP_MAX_PACKS,
    sitemapCacheSeconds: SITEMAP_CACHE_SECONDS,
    seoDiscoveryLinkLimit: SEO_DISCOVERY_LINK_LIMIT,
    seoDiscoveryCacheSeconds: SEO_DISCOVERY_CACHE_SECONDS,
  },
});

const { handleCatalogStaticAssetRequest, renderCatalogHtml, renderPackSeoHtml, renderPackNotFoundHtml, renderCreatePackHtml, handleSitemapRequest } = seoContext;
const handleListRequest = async (req, res, url) => {
  const q = sanitizeText(url.searchParams.get('q') || '', 120, { allowEmpty: true }) || '';
  const visibility = normalizeCatalogVisibility(url.searchParams.get('visibility'));
  const sort = normalizeCatalogSortParam(url.searchParams.get('sort'));
  const categories = parseCategoryFilters(url.searchParams.get('categories'));
  const intent = sanitizeText(url.searchParams.get('intent') || '', 32, { allowEmpty: true }) || '';
  const includeSensitive = parseEnvBool(url.searchParams.get('include_sensitive'), true);
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
  const normalizedIntent = normalizeCategoryToken(intent).replace(/-/g, '_');
  const googleSession = await resolveGoogleWebSessionFromRequest(req);
  const hasNsfwAccess = Boolean(googleSession?.sub && googleSession?.ownerJid);
  const cacheKey = buildCacheKey(['list', q, visibility, sort, categories.join(','), normalizedIntent, includeSensitive ? 1 : 0, limit, offset, hasNsfwAccess ? 1 : 0]);
  const payload = await getCachedSnapshot({
    cacheMap: CATALOG_LIST_CACHE,
    key: cacheKey,
    ttlSeconds: CATALOG_LIST_CACHE_SECONDS,
    staleWhileRefresh: true,
    staleOnError: true,
    load: async () => {
      const batchLimit = Math.max(limit, Math.min(MAX_LIST_LIMIT, 24));
      const maxPagesToScan = 8;
      const seenPackIds = new Set();
      const collectedEntries = [];
      const driftSnapshot = await getMarketplaceDriftSnapshot();
      let sourceHasMore = true;
      let cursorOffset = offset;
      let pagesScanned = 0;

      while (collectedEntries.length < limit && sourceHasMore && pagesScanned < maxPagesToScan) {
        pagesScanned += 1;
        const { packs, hasMore } = await listStickerPacksForCatalog({
          visibility,
          search: q,
          limit: batchLimit,
          offset: cursorOffset,
        });
        sourceHasMore = hasMore;
        cursorOffset += batchLimit;
        if (!packs.length) break;

        const { entries } = await hydrateMarketplaceEntries(packs, { driftSnapshot });
        const entriesClassified = STICKER_CATALOG_ONLY_CLASSIFIED ? entries.filter((entry) => isPackClassified(entry.packClassification)) : entries;
        const entriesByCategory = categories.length ? entriesClassified.filter((entry) => hasAnyCategory(entry.packClassification?.tags || [], categories)) : entriesClassified;
        const entriesBySensitivity = includeSensitive ? entriesByCategory : entriesByCategory.filter((entry) => entry.signals?.nsfw_level === 'safe');
        const entriesByIntent = intent ? entriesBySensitivity.filter((entry) => classifyPackIntent(entry) === normalizedIntent) : entriesBySensitivity;
        const sortedEntries = [...entriesByIntent].sort((left, right) => {
          const completenessDelta = compareEntriesByPackCompleteness(left, right);
          if (completenessDelta !== 0) return completenessDelta;
          if (sort === 'recent') {
            return Date.parse(right?.pack?.created_at || right?.pack?.updated_at || 0) - Date.parse(left?.pack?.created_at || left?.pack?.updated_at || 0);
          }
          if (sort === 'likes') {
            return Number(right?.engagement?.like_count || 0) - Number(left?.engagement?.like_count || 0);
          }
          if (sort === 'downloads') {
            return Number(right?.engagement?.open_count || 0) - Number(left?.engagement?.open_count || 0);
          }
          if (sort === 'comments') {
            const commentDelta = Number(right?.engagement?.comment_count || 0) - Number(left?.engagement?.comment_count || 0);
            if (commentDelta !== 0) return commentDelta;
            return Number(right?.engagement?.like_count || 0) - Number(left?.engagement?.like_count || 0);
          }
          if (sort === 'trending') {
            const trendDelta = Number(right?.signals?.trend_score || 0) - Number(left?.signals?.trend_score || 0);
            if (trendDelta !== 0) return trendDelta;
          }
          const leftScore = Number(left?.signals?.ranking_score || 0);
          const rightScore = Number(right?.signals?.ranking_score || 0);
          if (rightScore !== leftScore) return rightScore - leftScore;
          return Date.parse(right?.pack?.updated_at || 0) - Date.parse(left?.pack?.updated_at || 0);
        });

        for (const entry of sortedEntries) {
          if (!entry?.pack?.id) continue;
          if (seenPackIds.has(entry.pack.id)) continue;
          seenPackIds.add(entry.pack.id);
          collectedEntries.push(entry);
          if (collectedEntries.length >= limit) break;
        }
      }

      return {
        data: collectedEntries.map((entry) => toSummaryEntry(entry, { hideSensitiveCover: !hasNsfwAccess })),
        pagination: {
          limit,
          offset,
          has_more: sourceHasMore,
          next_offset: sourceHasMore ? cursorOffset : null,
        },
        filters: {
          q,
          visibility,
          sort,
          categories,
          intent: intent || null,
          include_sensitive: includeSensitive,
        },
      };
    },
  });

  sendJson(req, res, 200, payload);
};

const handleIntentCollectionsRequest = async (req, res, url) => {
  const visibility = normalizeCatalogVisibility(url.searchParams.get('visibility'));
  const q = sanitizeText(url.searchParams.get('q') || '', 120, { allowEmpty: true }) || '';
  const categories = parseCategoryFilters(url.searchParams.get('categories'));
  const limit = clampInt(url.searchParams.get('limit'), 18, 4, 50);
  const googleSession = await resolveGoogleWebSessionFromRequest(req);
  const hasNsfwAccess = Boolean(googleSession?.sub && googleSession?.ownerJid);

  const { packs } = await listStickerPacksForCatalog({
    visibility,
    search: q,
    limit: Math.max(limit * 3, 40),
    offset: 0,
  });
  const driftSnapshot = await getMarketplaceDriftSnapshot();
  const { entries } = await hydrateMarketplaceEntries(packs, { driftSnapshot });
  const entriesClassified = STICKER_CATALOG_ONLY_CLASSIFIED ? entries.filter((entry) => isPackClassified(entry.packClassification)) : entries;
  const entriesByCategory = categories.length ? entriesClassified.filter((entry) => hasAnyCategory(entry.packClassification?.tags || [], categories)) : entriesClassified;
  const intents = buildIntentCollections(entriesByCategory, { limit });

  sendJson(req, res, 200, {
    data: {
      em_alta: intents.em_alta.map((entry) => toSummaryEntry(entry, { hideSensitiveCover: !hasNsfwAccess })),
      novos: intents.novos.map((entry) => toSummaryEntry(entry, { hideSensitiveCover: !hasNsfwAccess })),
      crescendo_agora: intents.crescendo_agora.map((entry) => toSummaryEntry(entry, { hideSensitiveCover: !hasNsfwAccess })),
      mais_curtidos: intents.mais_curtidos.map((entry) => toSummaryEntry(entry, { hideSensitiveCover: !hasNsfwAccess })),
      melhor_avaliados: intents.melhor_avaliados.map((entry) => toSummaryEntry(entry, { hideSensitiveCover: !hasNsfwAccess })),
    },
    filters: {
      visibility,
      q,
      categories,
      limit,
    },
  });
};

const resolveMarketplaceVisibilityValues = (visibility) => (visibility === 'all' ? ['public', 'unlisted'] : visibility === 'unlisted' ? ['unlisted'] : ['public']);

const getHomeMarketplaceStatsCacheBucket = (visibility) => {
  const key = normalizeCatalogVisibility(visibility);
  let bucket = HOME_MARKETPLACE_STATS_CACHE.get(key);
  if (!bucket) {
    bucket = {
      expiresAt: 0,
      value: null,
      pending: null,
    };
    HOME_MARKETPLACE_STATS_CACHE.set(key, bucket);
  }
  return bucket;
};

const buildMarketplaceStatsSnapshot = async (visibility) => {
  const normalizedVisibility = normalizeCatalogVisibility(visibility);
  const visibilityValues = resolveMarketplaceVisibilityValues(normalizedVisibility);
  const placeholders = visibilityValues.map(() => '?').join(', ');

  const [packStatsRow] = await executeQuery(
    `SELECT
       COUNT(DISTINCT p.id) AS packs_total,
       COUNT(i.sticker_id) AS stickers_total,
       COUNT(DISTINCT p.publisher) AS creators_total
     FROM sticker_pack p
     LEFT JOIN sticker_pack_item i ON i.pack_id = p.id
     WHERE p.deleted_at IS NULL
       AND p.status = 'published'
       AND COALESCE(p.pack_status, 'ready') = 'ready'
       AND p.visibility IN (${placeholders})`,
    visibilityValues,
  );

  const [downloadsRow] = await executeQuery(
    `SELECT COALESCE(SUM(e.open_count), 0) AS downloads_total
     FROM sticker_pack_engagement e
     INNER JOIN sticker_pack p ON p.id = e.pack_id
     WHERE p.deleted_at IS NULL
       AND p.status = 'published'
       AND COALESCE(p.pack_status, 'ready') = 'ready'
       AND p.visibility IN (${placeholders})`,
    visibilityValues,
  );

  return {
    data: {
      packs_total: Number(packStatsRow?.packs_total || 0),
      stickers_total: Number(packStatsRow?.stickers_total || 0),
      creators_total: Number(packStatsRow?.creators_total || 0),
      downloads_total: Number(downloadsRow?.downloads_total || 0),
    },
    filters: {
      visibility: normalizedVisibility,
    },
  };
};

const getMarketplaceStatsCached = async (visibility) => {
  const normalizedVisibility = normalizeCatalogVisibility(visibility);
  const bucket = getHomeMarketplaceStatsCacheBucket(normalizedVisibility);
  const now = __timeNowMs();
  const hasValue = Boolean(bucket.value);

  if (hasValue && now < bucket.expiresAt) {
    return bucket.value;
  }

  if (!bucket.pending) {
    bucket.pending = withTimeout(buildMarketplaceStatsSnapshot(normalizedVisibility), 5000)
      .then((data) => {
        bucket.value = data;
        bucket.expiresAt = __timeNowMs() + HOME_MARKETPLACE_STATS_CACHE_SECONDS * 1000;
        return data;
      })
      .finally(() => {
        bucket.pending = null;
      });
  }

  if (hasValue) return bucket.value;
  return bucket.pending;
};

const handleMarketplaceStatsRequest = async (req, res, url) => {
  const visibility = normalizeCatalogVisibility(url.searchParams.get('visibility'));
  const cacheBucket = getHomeMarketplaceStatsCacheBucket(visibility);
  try {
    const payload = await getMarketplaceStatsCached(visibility);
    sendJson(req, res, 200, {
      ...payload,
      meta: {
        cache_seconds: HOME_MARKETPLACE_STATS_CACHE_SECONDS,
      },
    });
  } catch (error) {
    logger.warn('Falha ao montar stats da home do marketplace.', {
      action: 'home_marketplace_stats_error',
      error: error?.message,
      visibility,
    });
    if (cacheBucket.value) {
      sendJson(req, res, 200, {
        ...cacheBucket.value,
        meta: {
          cache_seconds: HOME_MARKETPLACE_STATS_CACHE_SECONDS,
          stale: true,
          error: error?.message || 'fallback_cache',
        },
      });
      return;
    }
    sendJson(req, res, 503, { error: 'Stats do marketplace indisponíveis no momento.' });
  }
};

const handleCreatePackConfigRequest = async (req, res) => {
  triggerStaleDraftCleanup();
  sendJson(req, res, 200, {
    data: {
      command_prefix: PACK_COMMAND_PREFIX,
      limits: {
        pack_name_max_length: PACK_CREATE_MAX_NAME_LENGTH,
        publisher_max_length: PACK_CREATE_MAX_PUBLISHER_LENGTH,
        description_max_length: PACK_CREATE_MAX_DESCRIPTION_LENGTH,
        stickers_per_pack: PACK_CREATE_MAX_ITEMS,
        packs_per_owner: serializePackOwnerLimit(PACK_CREATE_MAX_PACKS_PER_OWNER),
        packs_per_owner_unlimited: !Number.isFinite(PACK_CREATE_MAX_PACKS_PER_OWNER),
        sticker_upload_max_bytes: MAX_STICKER_UPLOAD_BYTES,
        sticker_upload_source_max_bytes: MAX_STICKER_SOURCE_UPLOAD_BYTES,
      },
      rules: {
        pack_name_regex: PACK_CREATE_NAME_REGEX,
        pack_name_hint: 'Nome livre (espaços e emojis são permitidos).',
        visibility_values: ['public', 'unlisted', 'private'],
        owner_phone_required: !STICKER_WEB_GOOGLE_AUTH_REQUIRED,
        owner_phone_hint: STICKER_WEB_GOOGLE_AUTH_REQUIRED ? 'Login Google obrigatório para criar packs nesta página.' : 'Informe o número de celular com DDD para vincular o pack ao criador.',
        suggested_tags: ['anime', 'meme', 'game', 'texto', 'nsfw', 'dark', 'cartoon', 'foto-real', 'cyberpunk'],
      },
      auth: {
        google: {
          enabled: Boolean(STICKER_WEB_GOOGLE_CLIENT_ID),
          required: Boolean(STICKER_WEB_GOOGLE_AUTH_REQUIRED),
          client_id: STICKER_WEB_GOOGLE_CLIENT_ID || null,
          session_ttl_ms: STICKER_WEB_GOOGLE_SESSION_TTL_MS,
        },
      },
      examples: {
        create: `${PACK_COMMAND_PREFIX}pack create meupack | publisher="Seu Nome" | desc="Descrição"`,
        add_sticker: `${PACK_COMMAND_PREFIX}pack add <pack>`,
        set_description: `${PACK_COMMAND_PREFIX}pack setdesc <pack> "Nova descrição"`,
      },
      links: {
        stickers: `${STICKER_WEB_PATH}/`,
        create: `${STICKER_CREATE_WEB_PATH}/`,
        api_base: STICKER_API_BASE_PATH,
        create_api: `${STICKER_API_BASE_PATH}/create`,
        google_auth_session_api: `${STICKER_API_BASE_PATH}/auth/google/session`,
        upload_api_template: `${STICKER_API_BASE_PATH}/:pack_key/stickers-upload`,
        finalize_api_template: `${STICKER_API_BASE_PATH}/:pack_key/finalize`,
        publish_state_api_template: `${STICKER_API_BASE_PATH}/:pack_key/publish-state`,
      },
      publish_flow: {
        statuses: ['draft', 'uploading', 'processing', 'published', 'failed'],
        upload_queue_concurrency: WEB_UPLOAD_MAX_CONCURRENCY,
        finalize_required: true,
      },
    },
  });
};

const buildOwnerLookupJids = (value) => {
  const normalized = normalizeJid(value) || '';
  if (!normalized || !normalized.includes('@')) return [];
  const lookup = new Set([normalized]);
  const phoneDigits = toWhatsAppPhoneDigits(normalized);
  if (!phoneDigits) return Array.from(lookup);
  lookup.add(normalizeJid(`${phoneDigits}@s.whatsapp.net`) || '');
  lookup.add(normalizeJid(`${phoneDigits}@c.us`) || '');
  lookup.add(normalizeJid(`${phoneDigits}@hosted`) || '');
  return Array.from(lookup).filter(Boolean);
};

const appendMyProfileOwnerCandidate = (candidateSet, lookupSet, value) => {
  const normalized = normalizeJid(value) || '';
  if (!normalized || !normalized.includes('@')) return;

  candidateSet.add(normalized);
  for (const lookupJid of buildOwnerLookupJids(normalized)) {
    lookupSet.add(lookupJid);
  }

  const phoneOwner = toWhatsAppOwnerJid(value);
  if (phoneOwner) {
    candidateSet.add(phoneOwner);
    for (const lookupJid of buildOwnerLookupJids(phoneOwner)) {
      lookupSet.add(lookupJid);
    }
  }
};

const buildPhoneSet = (...values) => {
  const set = new Set();
  for (const value of values) {
    const digits = toWhatsAppPhoneDigits(value);
    if (digits) set.add(digits);
  }
  return set;
};

const resolveMyProfileOwnerCandidates = async (session) => {
  const candidates = new Set();
  const lookupByJid = new Set();
  const lidCandidates = new Set();
  const appendCandidate = (value) => appendMyProfileOwnerCandidate(candidates, lookupByJid, value);
  const trustedPhones = new Set();
  const blockedJids = new Set();
  const blockedPhones = new Set();
  const normalizedSub = normalizeGoogleSubject(session?.sub);
  const normalizedEmail = normalizeEmail(session?.email);
  const normalizedSessionOwnerJid = normalizeJid(session?.ownerJid || '') || '';
  const normalizedSessionOwnerPhone = toWhatsAppPhoneDigits(session?.ownerPhone || session?.ownerJid) || '';

  appendCandidate(session?.ownerJid);
  appendCandidate(toWhatsAppOwnerJid(session?.ownerPhone || session?.ownerJid));
  for (const phone of buildPhoneSet(session?.ownerPhone, session?.ownerJid)) {
    trustedPhones.add(phone);
  }

  const activeSocket = getActiveSocket();
  const botJid = normalizeJid(resolveActiveSocketBotJid(activeSocket) || '');
  if (botJid) {
    blockedJids.add(botJid);
    for (const phone of buildPhoneSet(botJid)) {
      blockedPhones.add(phone);
    }
  }

  const legacyGoogleOwner = buildGoogleOwnerJid(session?.sub);
  if (legacyGoogleOwner) appendCandidate(legacyGoogleOwner);

  const sessionResolved = await resolveUserId(extractUserIdInfo(session?.ownerJid || session?.ownerPhone || null)).catch(() => null);
  if (sessionResolved) {
    appendCandidate(sessionResolved);
    for (const phone of buildPhoneSet(sessionResolved)) {
      trustedPhones.add(phone);
    }
  }

  const identityClauses = [];
  const identityParams = [];
  if (normalizedSub) {
    identityClauses.push('google_sub = ?');
    identityParams.push(normalizedSub);
  }
  if (normalizedEmail) {
    identityClauses.push('email = ?');
    identityParams.push(normalizedEmail);
  }
  if (normalizedSessionOwnerJid) {
    identityClauses.push('owner_jid = ?');
    identityParams.push(normalizedSessionOwnerJid);
  }
  if (normalizedSessionOwnerPhone) {
    identityClauses.push('owner_phone = ?');
    identityParams.push(normalizedSessionOwnerPhone);
  }

  if (identityClauses.length) {
    try {
      const userRows = await executeQuery(
        `SELECT owner_jid, owner_phone
           FROM ${TABLES.STICKER_WEB_GOOGLE_USER}
          WHERE ${identityClauses.join(' OR ')}
          ORDER BY COALESCE(last_seen_at, last_login_at, updated_at, created_at) DESC
          LIMIT 10`,
        identityParams,
      );

      for (const row of Array.isArray(userRows) ? userRows : []) {
        appendCandidate(row?.owner_jid || '');
        appendCandidate(row?.owner_phone || '');
        for (const phone of buildPhoneSet(row?.owner_jid, row?.owner_phone)) {
          trustedPhones.add(phone);
        }
        const mappedResolved = await resolveUserId(extractUserIdInfo(row?.owner_jid || row?.owner_phone || null)).catch(() => null);
        if (mappedResolved) appendCandidate(mappedResolved);
      }

      const sessionRows = await executeQuery(
        `SELECT owner_jid, owner_phone
           FROM ${TABLES.STICKER_WEB_GOOGLE_SESSION}
          WHERE revoked_at IS NULL
            AND expires_at > UTC_TIMESTAMP()
            AND (${identityClauses.join(' OR ')})
          ORDER BY COALESCE(last_seen_at, created_at) DESC
          LIMIT 20`,
        identityParams,
      ).catch(() => []);

      for (const row of Array.isArray(sessionRows) ? sessionRows : []) {
        appendCandidate(row?.owner_jid || '');
        appendCandidate(row?.owner_phone || '');
        for (const phone of buildPhoneSet(row?.owner_jid, row?.owner_phone)) {
          trustedPhones.add(phone);
        }
      }
    } catch (error) {
      logger.warn('Falha ao resolver owners para perfil web.', {
        action: 'sticker_pack_my_profile_owner_candidates_failed',
        google_sub: normalizedSub,
        email: normalizedEmail,
        error: error?.message,
      });
    }
  }

  for (const ownerJid of Array.from(candidates)) {
    const identity = extractUserIdInfo(ownerJid);
    if (identity?.lid) lidCandidates.add(identity.lid);
    if (!identity?.lid && !identity?.jid) continue;
    const resolved = await resolveUserId(identity).catch(() => null);
    if (!resolved) continue;
    appendCandidate(resolved);
    const resolvedIdentity = extractUserIdInfo(resolved);
    if (resolvedIdentity?.lid) lidCandidates.add(resolvedIdentity.lid);
  }

  const lookupValues = Array.from(lookupByJid).filter(Boolean);
  for (let offset = 0; offset < lookupValues.length; offset += 200) {
    const chunk = lookupValues.slice(offset, offset + 200);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const lookupParams = [...chunk, ...chunk];
    const rows = await executeQuery(
      `SELECT lid, jid
         FROM ${TABLES.LID_MAP}
        WHERE jid IN (${placeholders})
           OR lid IN (${placeholders})
        ORDER BY last_seen DESC
        LIMIT 500`,
      lookupParams,
    ).catch(() => []);

    for (const row of Array.isArray(rows) ? rows : []) {
      appendCandidate(row?.jid || '');
      const resolvedLid = normalizeJid(row?.lid || '');
      if (resolvedLid) lidCandidates.add(resolvedLid);
    }

    const packOwnerRows = await executeQuery(
      `SELECT DISTINCT p.owner_jid
         FROM ${TABLES.STICKER_PACK} p
         INNER JOIN ${TABLES.LID_MAP} lm
                 ON lm.lid = p.owner_jid
        WHERE p.deleted_at IS NULL
          AND (
            lm.jid IN (${placeholders})
            OR lm.lid IN (${placeholders})
          )
        LIMIT 500`,
      lookupParams,
    ).catch(() => []);

    for (const row of Array.isArray(packOwnerRows) ? packOwnerRows : []) {
      const packOwnerLid = normalizeJid(row?.owner_jid || '');
      if (!packOwnerLid) continue;
      appendCandidate(packOwnerLid);
      lidCandidates.add(packOwnerLid);
    }
  }

  for (const lid of lidCandidates) {
    const resolved = await resolveUserId(extractUserIdInfo(lid)).catch(() => null);
    if (resolved) {
      appendCandidate(resolved);
      appendCandidate(lid);
    }
  }

  const filtered = [];
  for (const candidate of Array.from(candidates)) {
    const normalized = normalizeJid(candidate) || '';
    if (!normalized || !normalized.includes('@')) continue;
    if (blockedJids.has(normalized)) continue;

    const directPhone = toWhatsAppPhoneDigits(normalized);
    if (directPhone && blockedPhones.has(directPhone)) continue;

    const isGoogleOwner = normalized.endsWith('@google.oauth');
    if (trustedPhones.size === 0) {
      filtered.push(normalized);
      continue;
    }

    if (directPhone) {
      if (!trustedPhones.has(directPhone)) continue;
      filtered.push(normalized);
      continue;
    }

    const resolved = await resolveUserId(extractUserIdInfo(normalized)).catch(() => null);
    const resolvedPhone = toWhatsAppPhoneDigits(resolved || '');
    if (resolvedPhone) {
      if (!trustedPhones.has(resolvedPhone) || blockedPhones.has(resolvedPhone)) continue;
      filtered.push(normalized);
      continue;
    }

    if (isGoogleOwner) {
      filtered.push(normalized);
    }
  }

  return Array.from(new Set(filtered));
};

const authContext = createStickerCatalogAuthContext({
  executeQuery,
  runSqlTransaction,
  tables: TABLES,
  logger,
  sendJson,
  readJsonBody,
  parseCookies,
  getCookieValuesFromRequest,
  appendSetCookie,
  buildCookieString,
  normalizeEmail,
  normalizeJid,
  sanitizeText,
  toIsoOrNull,
  toWhatsAppPhoneDigits,
  resolveWhatsAppOwnerJidFromLoginPayload,
  assertGoogleIdentityNotBanned,
  queueAutomatedEmail,
  queueWelcomeEmail,
  resolveRequestRemoteIp,
  toSiteAbsoluteUrl,
  listStickerPacksByOwner,
  listStickerPackEngagementByPackIds,
  mapPackSummary,
  isPackPubliclyVisible,
  resolveMyProfileOwnerCandidates,
  shouldHidePackFromMyProfileDefault,
  parseEnvBool,
  clampInt,
  userPasswordResetWebPath: USER_PASSWORD_RESET_WEB_PATH,
  userProfileWebPath: USER_PROFILE_WEB_PATH,
  passwordRecoverySessionAuthMethod: PASSWORD_RECOVERY_SESSION_AUTH_METHOD,
  passwordRecoverySessionTtlSeconds: PASSWORD_RECOVERY_SESSION_TTL_SECONDS,
  webSessionCookieName: WEB_SESSION_COOKIE_NAME,
  notAllowedErrorCode: STICKER_PACK_ERROR_CODES.NOT_ALLOWED,
  stickerWebGoogleClientId: STICKER_WEB_GOOGLE_CLIENT_ID,
  stickerWebGoogleAuthRequired: STICKER_WEB_GOOGLE_AUTH_REQUIRED,
  stickerWebGoogleSessionTtlMs: STICKER_WEB_GOOGLE_SESSION_TTL_MS,
  stickerApiBasePath: STICKER_API_BASE_PATH,
  stickerWebPath: STICKER_WEB_PATH,
  stickerLoginWebPath: STICKER_LOGIN_WEB_PATH,
  siteOrigin: SITE_ORIGIN,
});

const { upsertGoogleWebUserRecord, resolveGoogleWebSessionFromRequest, mapGoogleSessionResponseData, handleGoogleAuthSessionRequest, revokeGoogleWebSessionsByIdentity, buildGoogleOwnerJid, handleTermsAcceptanceRequest, handlePasswordAuthRequest, handlePasswordRecoveryRequest, handlePasswordRecoveryVerifyRequest, handlePasswordRecoverySessionCreateRequest, handlePasswordRecoverySessionStatusRequest, handlePasswordRecoverySessionRequest, handlePasswordRecoverySessionVerifyRequest, handlePasswordLoginRequest, handleMyProfileRequest } = authContext;

// Configuração de pontes para o systemController resolver dependências circulares
globalThis.getMarketplaceStatsCachedBridge = (visibility) => getMarketplaceStatsCached(visibility);
globalThis.resolveGoogleWebSessionFromRequestBridge = (req) => resolveGoogleWebSessionFromRequest(req);
globalThis.mapGoogleSessionResponseDataBridge = (sess, opts) => mapGoogleSessionResponseData(sess, opts);
globalThis.getActiveSocketBridge = () => getActiveSocket();
globalThis.profilePictureUrlFromActiveSocketBridge = (jid, type, timeout) => profilePictureUrlFromActiveSocket(jid, type, timeout);

revokeGoogleWebSessionsByIdentityBridge = revokeGoogleWebSessionsByIdentity;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const invalidateStickerCatalogDerivedCaches = () => {
  GLOBAL_RANK_CACHE.expiresAt = 0;
  GLOBAL_RANK_CACHE.value = null;
  GLOBAL_RANK_CACHE.pending = null;
  HOME_MARKETPLACE_STATS_CACHE.clear();
  CATALOG_LIST_CACHE.clear();
  CATALOG_CREATOR_RANKING_CACHE.clear();
  CATALOG_PACK_PAYLOAD_CACHE.clear();
  SYSTEM_SUMMARY_CACHE.expiresAt = 0;
  SYSTEM_SUMMARY_CACHE.value = null;
  SYSTEM_SUMMARY_CACHE.pending = null;
  README_SUMMARY_CACHE.expiresAt = 0;
  README_SUMMARY_CACHE.value = null;
  README_SUMMARY_CACHE.pending = null;
};

const sendManagedMutationStatus = (req, res, status, extra = {}, statusCode = 200) => {
  sendJson(req, res, statusCode, {
    data: {
      success: true,
      status,
      ...extra,
    },
  });
};

const sendManagedPackMutationStatus = async (req, res, status, pack, extra = {}, statusCode = 200) => {
  if (!pack) {
    sendManagedMutationStatus(req, res, status, extra, statusCode);
    return;
  }
  const managed = await buildManagedPackResponseData(pack);
  sendJson(req, res, statusCode, {
    data: {
      success: true,
      status,
      ...extra,
      ...managed,
    },
  });
};

const cleanupOrphanStickerAssets = async (assetIds, { reason = 'manage_mutation' } = {}) => {
  const normalizedIds = Array.from(new Set((Array.isArray(assetIds) ? assetIds : []).map((id) => String(id || '').trim()).filter(Boolean)));
  if (!normalizedIds.length) return { checked: 0, deleted: 0, skipped: 0, errors: 0 };

  const assets = await findStickerAssetsByIds(normalizedIds).catch(() => []);
  const byId = new Map((Array.isArray(assets) ? assets : []).map((asset) => [asset.id, asset]));
  const summary = { checked: 0, deleted: 0, skipped: 0, errors: 0 };

  for (const assetId of normalizedIds) {
    summary.checked += 1;
    try {
      const result = await runSqlTransaction(async (connection) => {
        const refs = await countStickerPackItemRefsByStickerId(assetId, connection);
        if (refs > 0) return { deleted: false, refs, alreadyGone: false };
        await deleteStickerAssetClassificationByAssetId(assetId, connection);
        const deletedRows = await deleteStickerAssetById(assetId, connection);
        return { deleted: deletedRows > 0, refs, alreadyGone: deletedRows === 0 };
      });

      if (!result.deleted) {
        summary.skipped += 1;
        continue;
      }

      summary.deleted += 1;
      const asset = byId.get(assetId);
      if (asset?.storage_path) {
        await fs.unlink(asset.storage_path).catch((error) => {
          if (error?.code === 'ENOENT') return;
          logger.warn('Falha ao remover arquivo físico de sticker órfão.', {
            action: 'sticker_orphan_asset_file_delete_failed',
            asset_id: assetId,
            storage_path: asset.storage_path,
            reason,
            error: error?.message,
          });
        });
      }
    } catch (error) {
      summary.errors += 1;
      logger.warn('Falha ao limpar asset órfão após mutação de pack.', {
        action: 'sticker_orphan_asset_cleanup_failed',
        asset_id: assetId,
        reason,
        error: error?.message,
      });
    }
  }

  return summary;
};

const deleteManagedPackWithCleanup = async ({ ownerJid, identifier, fallbackPack = null }) => {
  const transactionResult = await runSqlTransaction(async (connection) => {
    const pack =
      (await findStickerPackByOwnerAndIdentifier(ownerJid, fallbackPack?.id || identifier, {
        connection,
      })) || (fallbackPack?.pack_key && fallbackPack?.pack_key !== identifier ? await findStickerPackByOwnerAndIdentifier(ownerJid, identifier, { connection }) : null);

    if (!pack) {
      return {
        missing: true,
        deletedPack: null,
        removedStickerIds: [],
        removedCount: 0,
      };
    }

    const items = await listStickerPackItems(pack.id, connection);
    const removedStickerIds = items.map((item) => item?.sticker_id).filter(Boolean);
    await removeStickerPackItemsByPackId(pack.id, connection);
    const deletedPack = await softDeleteStickerPack(pack.id, connection);

    return {
      missing: false,
      deletedPack,
      removedStickerIds,
      removedCount: items.length,
    };
  });

  if (!transactionResult.missing && transactionResult.removedStickerIds.length) {
    await cleanupOrphanStickerAssets(transactionResult.removedStickerIds, {
      reason: 'delete_pack',
    });
  }

  invalidateStickerCatalogDerivedCaches();
  return transactionResult;
};

const mapStickerPackWebManageError = (error) => {
  if (!(error instanceof StickerPackError)) {
    return {
      statusCode: 500,
      code: STICKER_PACK_ERROR_CODES.INTERNAL_ERROR,
      message: error?.message || 'Falha interna ao gerenciar pack.',
    };
  }

  if (error.code === STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND) {
    return { statusCode: 404, code: error.code, message: error.message || 'Pack nao encontrado.' };
  }
  if (error.code === STICKER_PACK_ERROR_CODES.STICKER_NOT_FOUND) {
    return {
      statusCode: 404,
      code: error.code,
      message: error.message || 'Sticker nao encontrado.',
    };
  }
  if (error.code === STICKER_PACK_ERROR_CODES.NOT_ALLOWED) {
    return {
      statusCode: 403,
      code: error.code,
      message: error.message || 'Operacao nao permitida.',
    };
  }
  if (error.code === STICKER_PACK_ERROR_CODES.PACK_LIMIT_REACHED) {
    return {
      statusCode: 429,
      code: error.code,
      message: error.message || 'Limite de packs atingido.',
    };
  }
  if (error.code === STICKER_PACK_ERROR_CODES.INVALID_INPUT) {
    return { statusCode: 400, code: error.code, message: error.message || 'Dados invalidos.' };
  }
  return {
    statusCode: 400,
    code: error.code,
    message: error.message || 'Falha ao gerenciar pack.',
  };
};

const requireGoogleWebSessionForManagement = async (req, res) => {
  const session = await resolveGoogleWebSessionFromRequest(req);
  if (!session?.ownerJid) {
    sendJson(req, res, 401, {
      error: 'Login Google obrigatorio para gerenciar packs.',
      code: STICKER_PACK_ERROR_CODES.NOT_ALLOWED,
    });
    return null;
  }
  return session;
};

const loadOwnedPackForWebManagement = async (req, res, packKey, { allowMissing = false } = {}) => {
  const session = await requireGoogleWebSessionForManagement(req, res);
  if (!session) return null;

  const normalizedPackKey = sanitizeText(packKey, 160, { allowEmpty: false });
  if (!normalizedPackKey) {
    sendJson(req, res, 400, {
      error: 'pack_key invalido.',
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return null;
  }

  const ownerCandidatesRaw = await resolveMyProfileOwnerCandidates(session).catch(() => []);
  const ownerCandidates = Array.from(new Set([normalizeJid(session.ownerJid) || '', ...ownerCandidatesRaw].filter(Boolean)));
  const fallbackOwnerJid = ownerCandidates[0] || normalizeJid(session.ownerJid) || '';

  for (const ownerJid of ownerCandidates) {
    try {
      const pack = await stickerPackService.getPackInfo({
        ownerJid,
        identifier: normalizedPackKey,
      });
      return { session, ownerJid, ownerCandidates, packKey: normalizedPackKey, pack };
    } catch (error) {
      if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND) {
        continue;
      }
      const mapped = mapStickerPackWebManageError(error);
      sendJson(req, res, mapped.statusCode, {
        error: mapped.message,
        code: mapped.code,
      });
      return null;
    }
  }

  if (allowMissing) {
    return {
      session,
      ownerJid: fallbackOwnerJid,
      ownerCandidates,
      packKey: normalizedPackKey,
      pack: null,
      missing: true,
    };
  }

  sendJson(req, res, 404, {
    error: 'Pack nao encontrado para este usuario.',
    code: STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND,
  });
  return null;
};

const buildManagedPackAnalytics = async (pack) => {
  const engagement = await getStickerPackEngagementByPackId(pack.id);
  const interactionStatsByPack = await listStickerPackInteractionStatsByPackIds([pack.id]);
  const interaction = interactionStatsByPack.get(pack.id) || {
    open_horizon: 0,
    open_baseline: 0,
    like_horizon: 0,
    like_baseline: 0,
    dislike_horizon: 0,
    dislike_baseline: 0,
  };
  return {
    downloads: Number(engagement?.open_count || 0),
    likes: Number(engagement?.like_count || 0),
    dislikes: Number(engagement?.dislike_count || 0),
    score: Number(engagement?.score || 0) || Number(engagement?.like_count || 0) - Number(engagement?.dislike_count || 0),
    engagement: {
      open_count: Number(engagement?.open_count || 0),
      like_count: Number(engagement?.like_count || 0),
      dislike_count: Number(engagement?.dislike_count || 0),
      updated_at: toIsoOrNull(engagement?.updated_at || null),
    },
    interaction_window: {
      open_horizon: Number(interaction.open_horizon || 0),
      open_baseline: Number(interaction.open_baseline || 0),
      like_horizon: Number(interaction.like_horizon || 0),
      like_baseline: Number(interaction.like_baseline || 0),
      dislike_horizon: Number(interaction.dislike_horizon || 0),
      dislike_baseline: Number(interaction.dislike_baseline || 0),
    },
  };
};

const buildManagedPackResponseData = async (pack) => {
  const items = Array.isArray(pack?.items) ? pack.items : [];
  const stickerIds = items.map((item) => item.sticker_id).filter(Boolean);

  const [classifications, packClassification, analytics, publishState] = await Promise.all([stickerIds.length ? listStickerClassificationsByAssetIds(stickerIds) : Promise.resolve([]), pack?.classification || (stickerIds.length ? getPackClassificationSummaryByAssetIds(stickerIds).catch(() => null) : null), buildManagedPackAnalytics(pack), buildPackPublishStateData(pack, { includeUploads: true })]);

  const byAssetClassification = new Map((Array.isArray(classifications) ? classifications : []).map((entry) => [entry.asset_id, entry]));

  return {
    pack: mapPackDetails(pack, items, {
      byAssetClassification,
      packClassification: packClassification || null,
      engagement: analytics.engagement,
      signals: null,
    }),
    publish_state: publishState,
    analytics,
  };
};

const sendManagedPackResponse = async (req, res, pack) => {
  const data = await buildManagedPackResponseData(pack);
  sendJson(req, res, 200, { data });
};

const parseTagListInput = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',');
  return [];
};

const handleManagedPackRequest = async (req, res, packKey) => {
  if (!['GET', 'HEAD', 'PATCH', 'DELETE'].includes(req.method || '')) {
    sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
    return;
  }

  const isMutableMethod = req.method === 'PATCH' || req.method === 'DELETE';
  const context = await loadOwnedPackForWebManagement(req, res, packKey, {
    allowMissing: isMutableMethod,
  });
  if (!context) return;
  const { packKey: normalizedPackKey } = context;

  if (req.method === 'GET' || req.method === 'HEAD') {
    await sendManagedPackResponse(req, res, context.pack);
    return;
  }

  if (req.method === 'DELETE') {
    if (context.missing || !context.pack) {
      sendManagedMutationStatus(req, res, 'already_deleted', {
        deleted: false,
        pack_key: normalizedPackKey,
      });
      return;
    }

    try {
      const result = await deleteManagedPackWithCleanup({
        ownerJid: context.ownerJid,
        identifier: normalizedPackKey,
        fallbackPack: context.pack,
      });
      if (result?.missing) {
        sendManagedMutationStatus(req, res, 'already_deleted', {
          deleted: false,
          pack_key: normalizedPackKey,
        });
        return;
      }

      sendManagedMutationStatus(req, res, 'deleted', {
        deleted: true,
        pack_key: result?.deletedPack?.pack_key || normalizedPackKey,
        id: result?.deletedPack?.id || context.pack?.id || null,
        deleted_at: toIsoOrNull(result?.deletedPack?.deleted_at || __timeNow()),
        removed_sticker_count: Number(result?.removedCount || 0),
      });
    } catch (error) {
      const mapped = mapStickerPackWebManageError(error);
      sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
    }
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(req, res, Number(error?.statusCode || 400), {
      error: error?.message || 'Body inválido.',
    });
    return;
  }

  try {
    if (context.missing || !context.pack) {
      sendManagedMutationStatus(req, res, 'already_deleted', {
        updated: false,
        pack_key: normalizedPackKey,
      });
      return;
    }

    let updatedPack = context.pack;
    let changed = false;

    if (hasOwn(payload, 'name')) {
      const nextName = sanitizeText(payload?.name, PACK_CREATE_MAX_NAME_LENGTH, {
        allowEmpty: false,
      });
      const currentName = sanitizeText(updatedPack?.name, PACK_CREATE_MAX_NAME_LENGTH, {
        allowEmpty: false,
      });
      if (!nextName) {
        updatedPack = await stickerPackService.renamePack({
          ownerJid: context.ownerJid,
          identifier: normalizedPackKey,
          name: payload.name,
        });
      } else if (nextName !== currentName) {
        updatedPack = await stickerPackService.renamePack({
          ownerJid: context.ownerJid,
          identifier: normalizedPackKey,
          name: payload.name,
        });
        changed = true;
      }
    }

    if (hasOwn(payload, 'publisher')) {
      const nextPublisher = sanitizeText(payload?.publisher, PACK_CREATE_MAX_PUBLISHER_LENGTH, {
        allowEmpty: false,
      });
      const currentPublisher = sanitizeText(updatedPack?.publisher, PACK_CREATE_MAX_PUBLISHER_LENGTH, { allowEmpty: false });
      if (!nextPublisher) {
        updatedPack = await stickerPackService.setPackPublisher({
          ownerJid: context.ownerJid,
          identifier: normalizedPackKey,
          publisher: payload.publisher,
        });
      } else if (nextPublisher !== currentPublisher) {
        updatedPack = await stickerPackService.setPackPublisher({
          ownerJid: context.ownerJid,
          identifier: normalizedPackKey,
          publisher: payload.publisher,
        });
        changed = true;
      }
    }

    if (hasOwn(payload, 'visibility')) {
      const nextVisibility = String(payload?.visibility || '')
        .trim()
        .toLowerCase();
      const currentVisibility = String(updatedPack?.visibility || '')
        .trim()
        .toLowerCase();
      if (!nextVisibility) {
        updatedPack = await stickerPackService.setPackVisibility({
          ownerJid: context.ownerJid,
          identifier: normalizedPackKey,
          visibility: payload.visibility,
        });
      } else if (nextVisibility !== currentVisibility) {
        updatedPack = await stickerPackService.setPackVisibility({
          ownerJid: context.ownerJid,
          identifier: normalizedPackKey,
          visibility: payload.visibility,
        });
        changed = true;
      }
    }

    if (hasOwn(payload, 'description') || hasOwn(payload, 'tags')) {
      const currentMeta = parsePackDescriptionMetadata(updatedPack?.description);
      const nextDescription = hasOwn(payload, 'description') ? String(payload?.description || '') : String(currentMeta.cleanDescription || '');
      const nextTags = hasOwn(payload, 'tags') ? parseTagListInput(payload?.tags) : currentMeta.tags;
      const descriptionWithTags = buildPackDescriptionWithTags(nextDescription, nextTags);
      const currentDescriptionWithTags = buildPackDescriptionWithTags(currentMeta.cleanDescription || '', currentMeta.tags);
      if (String(descriptionWithTags || '') !== String(currentDescriptionWithTags || '')) {
        updatedPack = await stickerPackService.setPackDescription({
          ownerJid: context.ownerJid,
          identifier: normalizedPackKey,
          description: descriptionWithTags || '',
        });
        changed = true;
      }
    }

    if (changed) invalidateStickerCatalogDerivedCaches();
    await sendManagedPackMutationStatus(req, res, changed ? 'updated' : 'unchanged', updatedPack, {
      updated: changed,
      pack_key: normalizedPackKey,
    });
  } catch (error) {
    if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND) {
      sendManagedMutationStatus(req, res, 'already_deleted', {
        updated: false,
        pack_key: normalizedPackKey,
      });
      return;
    }
    const mapped = mapStickerPackWebManageError(error);
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
  }
};

const handleManagedPackCloneRequest = async (req, res, packKey) => {
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
    return;
  }
  const context = await loadOwnedPackForWebManagement(req, res, packKey);
  if (!context) return;

  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(req, res, Number(error?.statusCode || 400), {
      error: error?.message || 'Body inválido.',
    });
    return;
  }

  const baseName =
    sanitizeText(context.pack?.name || 'Pack', PACK_CREATE_MAX_NAME_LENGTH, {
      allowEmpty: false,
    }) || 'Pack';
  const requestedName = sanitizeText(payload?.new_name || '', PACK_CREATE_MAX_NAME_LENGTH, {
    allowEmpty: true,
  });
  const newName = requestedName || `${baseName} (copia)`;

  try {
    const cloned = await stickerPackService.clonePack({
      ownerJid: context.ownerJid,
      identifier: context.packKey,
      newName,
    });
    invalidateStickerCatalogDerivedCaches();
    sendJson(req, res, 201, {
      data: {
        pack: mapPackSummary(cloned),
      },
    });
  } catch (error) {
    const mapped = mapStickerPackWebManageError(error);
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
  }
};

const handleManagedPackCoverRequest = async (req, res, packKey) => {
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
    return;
  }
  const context = await loadOwnedPackForWebManagement(req, res, packKey, { allowMissing: true });
  if (!context) return;
  if (context.missing || !context.pack) {
    sendManagedMutationStatus(req, res, 'already_deleted', {
      pack_key: context.packKey || String(packKey || ''),
    });
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(req, res, Number(error?.statusCode || 400), {
      error: error?.message || 'Body inválido.',
    });
    return;
  }

  try {
    const updated = await stickerPackService.setPackCover({
      ownerJid: context.ownerJid,
      identifier: context.packKey,
      stickerId: payload?.sticker_id,
    });
    invalidateStickerCatalogDerivedCaches();
    await sendManagedPackMutationStatus(req, res, 'updated', updated, {
      pack_key: context.packKey,
    });
  } catch (error) {
    if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND) {
      sendManagedMutationStatus(req, res, 'already_deleted', { pack_key: context.packKey });
      return;
    }
    if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.STICKER_NOT_FOUND) {
      const fresh = await stickerPackService.getPackInfo({ ownerJid: context.ownerJid, identifier: context.packKey }).catch(() => context.pack);
      await sendManagedPackMutationStatus(req, res, 'already_deleted', fresh, {
        pack_key: context.packKey,
        sticker_id: sanitizeText(payload?.sticker_id, 36, { allowEmpty: true }) || null,
      });
      return;
    }
    const mapped = mapStickerPackWebManageError(error);
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
  }
};

const handleManagedPackReorderRequest = async (req, res, packKey) => {
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
    return;
  }
  const context = await loadOwnedPackForWebManagement(req, res, packKey, { allowMissing: true });
  if (!context) return;
  if (context.missing || !context.pack) {
    sendManagedMutationStatus(req, res, 'already_deleted', {
      pack_key: context.packKey || String(packKey || ''),
    });
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(req, res, Number(error?.statusCode || 400), {
      error: error?.message || 'Body inválido.',
    });
    return;
  }

  const requestedOrderIds = Array.isArray(payload?.order_sticker_ids) ? payload.order_sticker_ids : [];
  const currentItems = Array.isArray(context.pack?.items) ? context.pack.items : [];
  if (currentItems.length < 2) {
    await sendManagedPackMutationStatus(req, res, 'noop', context.pack, {
      pack_key: context.packKey,
      reason: 'pack_has_less_than_two_stickers',
    });
    return;
  }
  if (!requestedOrderIds.length) {
    await sendManagedPackMutationStatus(req, res, 'noop', context.pack, {
      pack_key: context.packKey,
      reason: 'empty_order_payload',
    });
    return;
  }

  try {
    const updated = await stickerPackService.reorderPackItems({
      ownerJid: context.ownerJid,
      identifier: context.packKey,
      orderStickerIds: requestedOrderIds,
    });
    invalidateStickerCatalogDerivedCaches();
    await sendManagedPackMutationStatus(req, res, 'updated', updated, {
      pack_key: context.packKey,
    });
  } catch (error) {
    if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND) {
      sendManagedMutationStatus(req, res, 'already_deleted', { pack_key: context.packKey });
      return;
    }
    if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.INVALID_INPUT) {
      const fresh = await stickerPackService.getPackInfo({ ownerJid: context.ownerJid, identifier: context.packKey }).catch(() => context.pack);
      await sendManagedPackMutationStatus(req, res, 'noop', fresh, {
        pack_key: context.packKey,
        reason: 'invalid_or_stale_order',
      });
      return;
    }
    const mapped = mapStickerPackWebManageError(error);
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
  }
};

const handleManagedPackStickerDeleteRequest = async (req, res, packKey, stickerId) => {
  if (req.method !== 'DELETE') {
    sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
    return;
  }
  const context = await loadOwnedPackForWebManagement(req, res, packKey, { allowMissing: true });
  if (!context) return;
  if (context.missing || !context.pack) {
    sendManagedMutationStatus(req, res, 'already_deleted', {
      pack_key: context.packKey || String(packKey || ''),
      sticker_id: sanitizeText(stickerId, 36, { allowEmpty: true }) || null,
    });
    return;
  }

  try {
    const result = await stickerPackService.removeStickerFromPack({
      ownerJid: context.ownerJid,
      identifier: context.packKey,
      selector: stickerId,
    });
    invalidateStickerCatalogDerivedCaches();
    const removedStickerId = result?.removed?.sticker_id || sanitizeText(stickerId, 36, { allowEmpty: true }) || null;
    if (removedStickerId) {
      await cleanupOrphanStickerAssets([removedStickerId], { reason: 'remove_sticker' });
    }
    await sendManagedPackMutationStatus(req, res, 'updated', result?.pack || context.pack, {
      pack_key: context.packKey,
      removed_sticker_id: removedStickerId,
    });
  } catch (error) {
    if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND) {
      sendManagedMutationStatus(req, res, 'already_deleted', {
        pack_key: context.packKey,
        sticker_id: sanitizeText(stickerId, 36, { allowEmpty: true }) || null,
      });
      return;
    }
    if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.STICKER_NOT_FOUND) {
      const fresh = await stickerPackService.getPackInfo({ ownerJid: context.ownerJid, identifier: context.packKey }).catch(() => context.pack);
      await sendManagedPackMutationStatus(req, res, 'already_deleted', fresh, {
        pack_key: context.packKey,
        sticker_id: sanitizeText(stickerId, 36, { allowEmpty: true }) || null,
      });
      return;
    }
    const mapped = mapStickerPackWebManageError(error);
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
  }
};

const handleManagedPackStickerCreateRequest = async (req, res, packKey) => {
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
    return;
  }
  const context = await loadOwnedPackForWebManagement(req, res, packKey, { allowMissing: true });
  if (!context) return;
  if (context.missing || !context.pack) {
    sendManagedMutationStatus(req, res, 'already_deleted', {
      pack_key: context.packKey || String(packKey || ''),
    });
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(req, {
      maxBytes: Math.max(256 * 1024, Math.round(MAX_STICKER_SOURCE_UPLOAD_BYTES * 1.6)),
    });
  } catch (error) {
    sendJson(req, res, Number(error?.statusCode || 400), {
      error: error?.message || 'Body inválido.',
    });
    return;
  }

  const decoded = decodeStickerBase64Payload(payload?.sticker_base64 || payload?.sticker_data_url || '');
  if (!decoded?.buffer) {
    sendJson(req, res, 400, {
      error: 'Envie sticker_base64 ou sticker_data_url.',
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return;
  }
  if (decoded.buffer.length > MAX_STICKER_SOURCE_UPLOAD_BYTES) {
    sendJson(req, res, 400, {
      error: `Arquivo excede limite de ${Math.round(MAX_STICKER_SOURCE_UPLOAD_BYTES / (1024 * 1024))}MB.`,
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return;
  }

  let uploadedAssetId = '';
  try {
    const normalizedUpload = await convertUploadMediaToWebp({
      ownerJid: context.ownerJid,
      buffer: decoded.buffer,
      mimetype: decoded.mimetype || 'image/webp',
    });
    const asset = await saveStickerAssetFromBuffer({
      ownerJid: context.ownerJid,
      buffer: normalizedUpload.buffer,
      mimetype: normalizedUpload.mimetype || 'image/webp',
    });
    uploadedAssetId = String(asset?.id || '').trim();

    let updatedPack = await stickerPackService.addStickerToPack({
      ownerJid: context.ownerJid,
      identifier: context.packKey,
      asset: { id: uploadedAssetId },
      emojis: [],
      accessibilityLabel: null,
    });

    if (payload?.set_cover === true) {
      updatedPack = await stickerPackService.setPackCover({
        ownerJid: context.ownerJid,
        identifier: context.packKey,
        stickerId: uploadedAssetId,
      });
    }

    invalidateStickerCatalogDerivedCaches();

    sendJson(req, res, 201, {
      data: {
        success: true,
        status: 'updated',
        added_sticker_id: uploadedAssetId,
        ...(await buildManagedPackResponseData(updatedPack)),
      },
    });
  } catch (error) {
    if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND) {
      sendManagedMutationStatus(req, res, 'already_deleted', { pack_key: context.packKey });
      return;
    }
    if (uploadedAssetId) {
      await cleanupOrphanStickerAssets([uploadedAssetId], {
        reason: 'add_sticker_error_recovery',
      }).catch(() => {});
    }
    const mapped = mapStickerPackWebManageError(error);
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
  }
};

const handleManagedPackStickerReplaceRequest = async (req, res, packKey, stickerId) => {
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
    return;
  }
  const context = await loadOwnedPackForWebManagement(req, res, packKey, { allowMissing: true });
  if (!context) return;
  if (context.missing || !context.pack) {
    sendManagedMutationStatus(req, res, 'already_deleted', {
      pack_key: context.packKey || String(packKey || ''),
      sticker_id: sanitizeText(stickerId, 36, { allowEmpty: true }) || null,
    });
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(req, {
      maxBytes: Math.max(256 * 1024, Math.round(MAX_STICKER_SOURCE_UPLOAD_BYTES * 1.6)),
    });
  } catch (error) {
    sendJson(req, res, Number(error?.statusCode || 400), {
      error: error?.message || 'Body inválido.',
    });
    return;
  }

  const decoded = decodeStickerBase64Payload(payload?.sticker_base64 || payload?.sticker_data_url || '');
  if (!decoded?.buffer) {
    sendJson(req, res, 400, {
      error: 'Envie sticker_base64 ou sticker_data_url.',
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return;
  }
  if (decoded.buffer.length > MAX_STICKER_SOURCE_UPLOAD_BYTES) {
    sendJson(req, res, 400, {
      error: `Arquivo excede limite de ${Math.round(MAX_STICKER_SOURCE_UPLOAD_BYTES / (1024 * 1024))}MB.`,
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return;
  }

  const normalizedStickerId = sanitizeText(stickerId, 36, { allowEmpty: false });
  if (!normalizedStickerId) {
    sendJson(req, res, 400, {
      error: 'sticker_id invalido.',
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return;
  }

  let uploadedAssetId = '';
  try {
    const originalPack = await stickerPackService.getPackInfo({
      ownerJid: context.ownerJid,
      identifier: context.packKey,
    });
    const originalItems = Array.isArray(originalPack?.items) ? originalPack.items : [];
    const oldItem = originalItems.find((item) => item?.sticker_id === normalizedStickerId);
    if (!oldItem) {
      await sendManagedPackMutationStatus(req, res, 'already_deleted', originalPack, {
        pack_key: context.packKey,
        sticker_id: normalizedStickerId,
      });
      return;
    }

    const normalizedUpload = await convertUploadMediaToWebp({
      ownerJid: context.ownerJid,
      buffer: decoded.buffer,
      mimetype: decoded.mimetype || 'image/webp',
    });
    const asset = await saveStickerAssetFromBuffer({
      ownerJid: context.ownerJid,
      buffer: normalizedUpload.buffer,
      mimetype: normalizedUpload.mimetype || 'image/webp',
    });
    uploadedAssetId = String(asset?.id || '').trim();

    if (uploadedAssetId && uploadedAssetId === normalizedStickerId) {
      await sendManagedPackMutationStatus(req, res, 'unchanged', originalPack, {
        pack_key: context.packKey,
        replaced_sticker_id: normalizedStickerId,
        new_sticker_id: uploadedAssetId,
      });
      return;
    }

    const swapResult = await runSqlTransaction(async (connection) => {
      const packRow = await findStickerPackByOwnerAndIdentifier(context.ownerJid, context.packKey, {
        connection,
      });
      if (!packRow) return { status: 'pack_missing' };

      const liveOldItem = await getStickerPackItemByStickerId(packRow.id, normalizedStickerId, connection);
      if (!liveOldItem) return { status: 'old_sticker_missing' };

      const duplicateTarget = uploadedAssetId ? await getStickerPackItemByStickerId(packRow.id, uploadedAssetId, connection) : null;
      if (duplicateTarget) {
        return { status: 'duplicate_target' };
      }

      const removed = await removeStickerPackItemByStickerId(packRow.id, normalizedStickerId, connection);
      if (!removed) return { status: 'old_sticker_missing' };

      await createStickerPackItem(
        {
          id: randomUUID(),
          pack_id: packRow.id,
          sticker_id: uploadedAssetId,
          position: Number(removed.position || liveOldItem.position || oldItem.position || 1),
          emojis: Array.isArray(liveOldItem.emojis) ? liveOldItem.emojis : Array.isArray(oldItem.emojis) ? oldItem.emojis : [],
          accessibility_label: liveOldItem.accessibility_label ?? oldItem.accessibility_label ?? null,
        },
        connection,
      );

      if (String(packRow.cover_sticker_id || '') === normalizedStickerId) {
        await updateStickerPackFields(
          packRow.id,
          {
            cover_sticker_id: uploadedAssetId,
          },
          connection,
        );
      } else {
        await bumpStickerPackVersion(packRow.id, connection);
      }

      return { status: 'updated', pack_id: packRow.id };
    });

    if (swapResult?.status === 'pack_missing') {
      await cleanupOrphanStickerAssets(uploadedAssetId ? [uploadedAssetId] : [], {
        reason: 'replace_sticker_pack_missing',
      });
      sendManagedMutationStatus(req, res, 'already_deleted', {
        pack_key: context.packKey,
        sticker_id: normalizedStickerId,
      });
      return;
    }

    if (swapResult?.status === 'old_sticker_missing') {
      const fresh = await stickerPackService.getPackInfo({ ownerJid: context.ownerJid, identifier: context.packKey }).catch(() => originalPack);
      await cleanupOrphanStickerAssets(uploadedAssetId ? [uploadedAssetId] : [], {
        reason: 'replace_sticker_old_missing',
      });
      await sendManagedPackMutationStatus(req, res, 'already_deleted', fresh, {
        pack_key: context.packKey,
        sticker_id: normalizedStickerId,
      });
      return;
    }

    if (swapResult?.status === 'duplicate_target') {
      const fresh = await stickerPackService.getPackInfo({ ownerJid: context.ownerJid, identifier: context.packKey }).catch(() => originalPack);
      await sendManagedPackMutationStatus(req, res, 'noop', fresh, {
        pack_key: context.packKey,
        reason: 'duplicate_target_sticker',
        sticker_id: normalizedStickerId,
        new_sticker_id: uploadedAssetId || null,
      });
      return;
    }

    invalidateStickerCatalogDerivedCaches();
    const finalPack = await stickerPackService.getPackInfo({
      ownerJid: context.ownerJid,
      identifier: context.packKey,
    });
    await cleanupOrphanStickerAssets([normalizedStickerId], {
      reason: 'replace_sticker_old_cleanup',
    });
    sendJson(req, res, 200, {
      data: {
        success: true,
        status: 'updated',
        replaced_sticker_id: normalizedStickerId,
        new_sticker_id: uploadedAssetId || null,
        ...(await buildManagedPackResponseData(finalPack)),
      },
    });
  } catch (error) {
    if (error instanceof StickerPackError && error.code === STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND) {
      sendManagedMutationStatus(req, res, 'already_deleted', {
        pack_key: context.packKey,
        sticker_id: normalizedStickerId,
      });
      return;
    }
    if (uploadedAssetId) {
      await cleanupOrphanStickerAssets([uploadedAssetId], {
        reason: 'replace_sticker_error_recovery',
      }).catch(() => {});
    }
    const mapped = mapStickerPackWebManageError(error);
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
  }
};

const handleManagedPackAnalyticsRequest = async (req, res, packKey) => {
  if (!['GET', 'HEAD'].includes(req.method || '')) {
    sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
    return;
  }
  const context = await loadOwnedPackForWebManagement(req, res, packKey);
  if (!context) return;

  try {
    const analytics = await buildManagedPackAnalytics(context.pack);
    const publishState = await buildPackPublishStateData(context.pack, { includeUploads: true });
    sendJson(req, res, 200, {
      data: {
        pack_key: context.packKey,
        analytics,
        publish_state: publishState,
      },
    });
  } catch (error) {
    const mapped = mapStickerPackWebManageError(error);
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
  }
};

const normalizeCreatePackName = (value) => sanitizeText(value, PACK_CREATE_MAX_NAME_LENGTH, { allowEmpty: true }) || '';

const mapStickerPackCreateError = (error) => {
  if (!(error instanceof StickerPackError)) {
    return {
      statusCode: 500,
      code: STICKER_PACK_ERROR_CODES.INTERNAL_ERROR,
      message: 'Falha interna ao criar pack.',
    };
  }

  if (error.code === STICKER_PACK_ERROR_CODES.INVALID_INPUT) {
    return {
      statusCode: 400,
      code: error.code,
      message: error.message || 'Dados de entrada inválidos para criar pack.',
    };
  }

  if (error.code === STICKER_PACK_ERROR_CODES.PACK_LIMIT_REACHED) {
    return {
      statusCode: 429,
      code: error.code,
      message: error.message || 'Limite de packs atingido para este usuário.',
    };
  }

  return {
    statusCode: 400,
    code: error.code,
    message: error.message || 'Não foi possível criar o pack.',
  };
};

const handleCreatePackRequest = async (req, res) => {
  triggerStaleDraftCleanup();
  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    const statusCode = Number(error?.statusCode || 400);
    sendJson(req, res, statusCode, { error: error?.message || 'Body inválido.' });
    return;
  }

  const name = normalizeCreatePackName(payload?.name);
  if (!name) {
    sendJson(req, res, 400, {
      error: 'Nome inválido. Informe um nome de pack (espaços e emojis são permitidos).',
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return;
  }

  const publisher = sanitizeText(payload?.publisher || 'OmniZap Creator', PACK_CREATE_MAX_PUBLISHER_LENGTH, { allowEmpty: false });
  const description = sanitizeText(payload?.description || '', PACK_CREATE_MAX_DESCRIPTION_LENGTH, {
    allowEmpty: true,
  });
  const manualTags = mergeUniqueTags(Array.isArray(payload?.tags) ? payload.tags : []).slice(0, 8);
  const persistedDescription = buildPackDescriptionWithTags(description, manualTags);
  const visibility = String(payload?.visibility || 'public')
    .trim()
    .toLowerCase();
  const googleSession = await resolveGoogleWebSessionFromRequest(req);
  if (!googleSession?.ownerJid || !googleSession?.sub) {
    sendJson(req, res, 401, {
      error: 'Sessão expirada ou ausente. Faça login novamente para criar packs.',
      code: STICKER_PACK_ERROR_CODES.NOT_ALLOWED,
    });
    return;
  }

  try {
    await assertGoogleIdentityNotBanned({
      sub: googleSession.sub,
      email: googleSession.email,
      ownerJid: googleSession.ownerJid,
    });
  } catch (error) {
    sendJson(req, res, Number(error?.statusCode || 403), {
      error: error?.message || 'Conta sem permissão para criar packs.',
      code: STICKER_PACK_ERROR_CODES.NOT_ALLOWED,
    });
    return;
  }

  const googleCreator = {
    ownerJid: googleSession.ownerJid,
    sub: googleSession.sub,
    email: googleSession.email,
    name: googleSession.name,
    picture: googleSession.picture,
  };

  if (googleCreator?.sub && googleCreator?.ownerJid) {
    await upsertGoogleWebUserRecord({
      sub: googleCreator.sub,
      ownerJid: googleCreator.ownerJid,
      email: googleCreator.email,
      name: googleCreator.name,
      picture: googleCreator.picture,
    }).catch((error) => {
      logger.warn('Falha ao persistir usuário Google web durante criação de pack.', {
        action: 'sticker_pack_google_web_user_upsert_create_pack_failed',
        error: error?.message,
      });
    });
  }

  const ownerJid = googleCreator.ownerJid;

  try {
    logPackWebFlow('info', 'create_pack_start', {
      owner_jid: ownerJid,
      google_sub: googleCreator?.sub || null,
      requested_visibility: visibility,
      name,
    });
    const created = await stickerPackService.createPack({
      ownerJid,
      name,
      publisher,
      description: persistedDescription,
      visibility,
      status: 'draft',
    });
    const editToken = saveWebPackEditToken({ packId: created.id, ownerJid });
    logPackWebFlow('info', 'create_pack_success', {
      owner_jid: ownerJid,
      pack_id: created.id,
      pack_key: created.pack_key,
      status: created.status || 'draft',
      visibility: created.visibility,
    });

    sendJson(req, res, 201, {
      data: mapPackSummary(created),
      meta: {
        owner_jid: ownerJid,
        edit_token: editToken,
        edit_token_expires_in_ms: PACK_WEB_EDIT_TOKEN_TTL_MS,
        google_auth: googleCreator
          ? {
              provider: 'google',
              email: googleCreator.email,
              name: googleCreator.name,
              sub: googleCreator.sub,
            }
          : null,
        limits: {
          stickers_per_pack: PACK_CREATE_MAX_ITEMS,
          packs_per_owner: serializePackOwnerLimit(PACK_CREATE_MAX_PACKS_PER_OWNER),
          packs_per_owner_unlimited: !Number.isFinite(PACK_CREATE_MAX_PACKS_PER_OWNER),
        },
      },
    });
  } catch (error) {
    const mapped = mapStickerPackCreateError(error);
    logPackWebFlow('warn', 'create_pack_failed', {
      owner_jid: ownerJid,
      google_sub: googleCreator?.sub || null,
      name,
      visibility,
      error: error?.message,
      error_code: error?.code,
    });
    logger.warn('Falha ao criar pack via API web.', {
      action: 'sticker_catalog_create_pack_failed',
      owner_jid: ownerJid,
      google_sub: googleCreator?.sub || null,
      name,
      visibility,
      error: error?.message,
      error_code: error?.code,
    });
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
  }
};

const handleUploadStickerToPackRequest = async (req, res, packKey) => {
  triggerStaleDraftCleanup();
  const pack = await findStickerPackByPackKey(packKey);
  if (!pack) {
    sendJson(req, res, 404, {
      error: 'Pack nao encontrado.',
      code: STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND,
    });
    return;
  }

  let payload = {};
  try {
    payload = await readJsonBody(req, {
      maxBytes: Math.max(256 * 1024, Math.round(MAX_STICKER_SOURCE_UPLOAD_BYTES * 1.6)),
    });
  } catch (error) {
    sendJson(req, res, Number(error?.statusCode || 400), {
      error: error?.message || 'Body inválido.',
    });
    return;
  }

  const editToken = resolveWebPackEditToken(payload?.edit_token);
  if (!editToken || editToken.packId !== pack.id || editToken.ownerJid !== pack.owner_jid) {
    sendJson(req, res, 403, {
      error: 'Token de edição inválido para este pack.',
      code: STICKER_PACK_ERROR_CODES.NOT_ALLOWED,
    });
    return;
  }

  const decoded = decodeStickerBase64Payload(payload?.sticker_base64 || payload?.sticker_data_url || '');
  if (!decoded?.buffer) {
    sendJson(req, res, 400, {
      error: 'Envie sticker_base64 ou sticker_data_url no payload.',
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return;
  }

  if (decoded.buffer.length > MAX_STICKER_SOURCE_UPLOAD_BYTES) {
    sendJson(req, res, 400, {
      error: `Arquivo excede limite de ${Math.round(MAX_STICKER_SOURCE_UPLOAD_BYTES / (1024 * 1024))}MB.`,
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return;
  }

  const computedStickerHash = sha256Hex(decoded.buffer);
  const payloadStickerHash = normalizeStickerHashHex(payload?.sticker_hash);
  if (payloadStickerHash && payloadStickerHash !== computedStickerHash) {
    sendJson(req, res, 400, {
      error: 'sticker_hash nao corresponde ao arquivo enviado.',
      code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    });
    return;
  }

  const uploadId = normalizeWebUploadId(payload?.upload_id) || `h-${computedStickerHash.slice(0, 24)}`;
  const stickerHash = payloadStickerHash || computedStickerHash;

  logPackWebFlow('info', 'upload_start', {
    pack_key: pack.pack_key,
    pack_id: pack.id,
    owner_jid: pack.owner_jid,
    upload_id: uploadId,
    sticker_hash: stickerHash,
    source_bytes: decoded.buffer.length,
    source_mimetype: decoded.mimetype || 'image/webp',
  });

  let reservedUpload = null;
  let idempotentDoneResponse = null;
  let packStatusForResponse = normalizePackWebStatus(pack.status, 'draft');

  try {
    await runSqlTransaction(async (connection) => {
      const lockedPackRow = await lockStickerPackByPackKey(pack.pack_key, connection);
      if (!lockedPackRow) {
        throw new StickerPackError(STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND, 'Pack nao encontrado.');
      }
      if (String(lockedPackRow.id) !== String(pack.id) || String(lockedPackRow.owner_jid) !== String(pack.owner_jid)) {
        throw new StickerPackError(STICKER_PACK_ERROR_CODES.NOT_ALLOWED, 'Pack inválido para edição.');
      }

      let existingUpload = await findPackWebUploadByUploadId(pack.id, uploadId, connection);
      if (existingUpload && existingUpload.sticker_hash !== stickerHash) {
        throw new StickerPackError(STICKER_PACK_ERROR_CODES.INVALID_INPUT, 'upload_id já foi usado para outro arquivo neste pack.');
      }

      if (!existingUpload) {
        existingUpload = await findPackWebUploadByStickerHash(pack.id, stickerHash, connection);
      }

      const currentPackStatus = normalizePackWebStatus(lockedPackRow.status, 'draft');
      if (existingUpload?.upload_status === 'done' && existingUpload.sticker_id) {
        const snapshot = await getPackConsistencySnapshot(pack.id, lockedPackRow.cover_sticker_id, connection);
        idempotentDoneResponse = {
          data: {
            pack_key: pack.pack_key,
            sticker_id: existingUpload.sticker_id,
            sticker_count: snapshot.sticker_count,
            asset_url: buildStickerAssetUrl(pack.pack_key, existingUpload.sticker_id),
            idempotent: true,
            upload_id: existingUpload.upload_id,
            sticker_hash: existingUpload.sticker_hash,
            pack_status: currentPackStatus,
          },
        };
        return;
      }

      if (currentPackStatus === 'published') {
        throw new StickerPackError(STICKER_PACK_ERROR_CODES.NOT_ALLOWED, 'Pack já foi publicado. Crie um novo pack para enviar novos stickers.');
      }

      if (currentPackStatus === 'processing') {
        throw new StickerPackError(STICKER_PACK_ERROR_CODES.NOT_ALLOWED, 'Pack está em finalização. Aguarde e tente novamente.');
      }

      if (!existingUpload) {
        reservedUpload = await createPackWebUpload(
          {
            id: randomUUID(),
            pack_id: pack.id,
            upload_id: uploadId,
            sticker_hash: stickerHash,
            source_mimetype: decoded.mimetype || 'image/webp',
            upload_status: 'processing',
            attempt_count: 1,
            last_attempt_at: __timeNow(),
          },
          connection,
        );
      } else {
        reservedUpload = await updatePackWebUpload(
          existingUpload.id,
          {
            upload_status: 'processing',
            source_mimetype: decoded.mimetype || existingUpload.source_mimetype || 'image/webp',
            error_code: null,
            error_message: null,
            attempt_count: Math.max(1, Number(existingUpload.attempt_count || 0) + 1),
            last_attempt_at: __timeNow(),
          },
          connection,
        );
      }

      packStatusForResponse = currentPackStatus === 'failed' ? 'uploading' : 'uploading';
      if (currentPackStatus !== 'uploading') {
        await setStickerPackStatus(pack.id, 'uploading', connection);
        packStatusForResponse = 'uploading';
      }
    });

    if (idempotentDoneResponse) {
      logPackWebFlow('info', 'upload_success', {
        pack_key: pack.pack_key,
        pack_id: pack.id,
        owner_jid: pack.owner_jid,
        upload_id: uploadId,
        sticker_hash: stickerHash,
        idempotent: true,
      });
      sendJson(req, res, 200, idempotentDoneResponse);
      return;
    }

    const normalizedUpload = await convertUploadMediaToWebp({
      ownerJid: pack.owner_jid,
      buffer: decoded.buffer,
      mimetype: decoded.mimetype || 'image/webp',
    });
    const asset = await saveStickerAssetFromBuffer({
      ownerJid: pack.owner_jid,
      buffer: normalizedUpload.buffer,
      mimetype: normalizedUpload.mimetype || 'image/webp',
    });

    let updatedPack;
    try {
      updatedPack = await stickerPackService.addStickerToPack({
        ownerJid: pack.owner_jid,
        identifier: pack.pack_key,
        asset: { id: asset.id },
        emojis: [],
        accessibilityLabel: null,
      });
    } catch (error) {
      if (error?.code !== STICKER_PACK_ERROR_CODES.DUPLICATE_STICKER) {
        throw error;
      }
      updatedPack = await stickerPackService.getPackInfo({
        ownerJid: pack.owner_jid,
        identifier: pack.pack_key,
      });
    }

    if (payload?.set_cover === true) {
      updatedPack = await stickerPackService.setPackCover({
        ownerJid: pack.owner_jid,
        identifier: pack.pack_key,
        stickerId: asset.id,
      });
    }

    let responseStickerCount = Number(updatedPack?.sticker_count || 0);
    await runSqlTransaction(async (connection) => {
      const lockedPackRow = await lockStickerPackByPackKey(pack.pack_key, connection);
      if (!lockedPackRow) {
        throw new StickerPackError(STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND, 'Pack nao encontrado.');
      }

      const uploadRow = (reservedUpload?.id && normalizePackWebUploadRow((await executeQuery(`SELECT * FROM ${TABLES.STICKER_PACK_WEB_UPLOAD} WHERE id = ? LIMIT 1`, [reservedUpload.id], connection))?.[0])) || (await findPackWebUploadByUploadId(pack.id, uploadId, connection)) || (await findPackWebUploadByStickerHash(pack.id, stickerHash, connection));

      if (!uploadRow) {
        throw new StickerPackError(STICKER_PACK_ERROR_CODES.INTERNAL_ERROR, 'Registro de upload não encontrado para finalizar.');
      }

      await updatePackWebUpload(
        uploadRow.id,
        {
          upload_status: 'done',
          sticker_id: asset.id,
          error_code: null,
          error_message: null,
          source_mimetype: decoded.mimetype || 'image/webp',
        },
        connection,
      );

      if (normalizePackWebStatus(lockedPackRow.status, 'draft') !== 'published') {
        await setStickerPackStatus(pack.id, 'uploading', connection);
        packStatusForResponse = 'uploading';
      } else {
        packStatusForResponse = 'published';
      }

      const snapshot = await getPackConsistencySnapshot(pack.id, payload?.set_cover === true ? asset.id : lockedPackRow.cover_sticker_id, connection);
      responseStickerCount = snapshot.sticker_count;
    });

    logPackWebFlow('info', 'upload_success', {
      pack_key: pack.pack_key,
      pack_id: pack.id,
      owner_jid: pack.owner_jid,
      upload_id: uploadId,
      sticker_hash: stickerHash,
      sticker_id: asset.id,
      pack_status: packStatusForResponse,
    });

    sendJson(req, res, 201, {
      data: {
        pack_key: pack.pack_key,
        sticker_id: asset.id,
        sticker_count: responseStickerCount,
        asset_url: buildStickerAssetUrl(pack.pack_key, asset.id),
        upload_id: uploadId,
        sticker_hash: stickerHash,
        idempotent: false,
        pack_status: packStatusForResponse,
      },
    });
  } catch (error) {
    if (reservedUpload?.id) {
      await runSqlTransaction(async (connection) => {
        const currentUpload = (await findPackWebUploadByUploadId(pack.id, uploadId, connection)) || (await findPackWebUploadByStickerHash(pack.id, stickerHash, connection));
        if (currentUpload) {
          await updatePackWebUpload(
            currentUpload.id,
            {
              upload_status: 'failed',
              error_code: String(error?.code || 'UPLOAD_FAILED').slice(0, 64),
              error_message: error?.message || 'Falha no upload do sticker.',
              source_mimetype: decoded?.mimetype || currentUpload.source_mimetype || 'image/webp',
            },
            connection,
          );
        }
        await setStickerPackStatus(pack.id, 'draft', connection);
      }).catch((updateError) => {
        logPackWebFlow('warn', 'upload_failed_mark_failed', {
          pack_key: pack.pack_key,
          pack_id: pack.id,
          upload_id: uploadId,
          sticker_hash: stickerHash,
          original_error: error?.message,
          update_error: updateError?.message,
        });
      });
    }

    logPackWebFlow('warn', 'upload_failed', {
      pack_key: pack.pack_key,
      pack_id: pack.id,
      owner_jid: pack.owner_jid,
      upload_id: uploadId,
      sticker_hash: stickerHash,
      error: error?.message,
      error_code: error?.code,
    });
    const mapped = mapStickerPackCreateError(error);
    sendJson(req, res, mapped.statusCode, {
      error: mapped.message,
      code: mapped.code,
    });
  }
};

const handlePackPublishStateRequest = async (req, res, packKey, url = null) => {
  const pack = await findStickerPackByPackKey(packKey);
  if (!pack) {
    sendJson(req, res, 404, {
      error: 'Pack nao encontrado.',
      code: STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND,
    });
    return;
  }

  let payload = {};
  if (req.method === 'POST') {
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Body inválido.',
      });
      return;
    }
  }

  const editTokenValue = (req.method === 'GET' || req.method === 'HEAD' ? String(url?.searchParams?.get('edit_token') || '') : '') || String(payload?.edit_token || '');
  const editToken = resolveWebPackEditToken(editTokenValue);
  if (!editToken || editToken.packId !== pack.id || editToken.ownerJid !== pack.owner_jid) {
    sendJson(req, res, 403, {
      error: 'Token de edição inválido para este pack.',
      code: STICKER_PACK_ERROR_CODES.NOT_ALLOWED,
    });
    return;
  }

  const packState = await buildPackPublishStateData(pack, { includeUploads: true });
  sendJson(req, res, 200, {
    data: packState,
    pack: mapPackSummary({ ...pack, sticker_count: packState.consistency.sticker_count }),
  });
};

const handleFinalizePackRequest = async (req, res, packKey) => {
  triggerStaleDraftCleanup();

  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(req, res, Number(error?.statusCode || 400), {
      error: error?.message || 'Body inválido.',
    });
    return;
  }

  const pack = await findStickerPackByPackKey(packKey);
  if (!pack) {
    sendJson(req, res, 404, {
      error: 'Pack nao encontrado.',
      code: STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND,
    });
    return;
  }

  const editToken = resolveWebPackEditToken(payload?.edit_token);
  if (!editToken || editToken.packId !== pack.id || editToken.ownerJid !== pack.owner_jid) {
    sendJson(req, res, 403, {
      error: 'Token de edição inválido para este pack.',
      code: STICKER_PACK_ERROR_CODES.NOT_ALLOWED,
    });
    return;
  }

  logPackWebFlow('info', 'finalize_start', {
    pack_key: pack.pack_key,
    pack_id: pack.id,
    owner_jid: pack.owner_jid,
  });

  let finalizeResult = {
    canPublish: false,
    packStatus: normalizePackWebStatus(pack.status, 'draft'),
    reason: 'unknown',
  };

  try {
    await runSqlTransaction(async (connection) => {
      const lockedPackRow = await lockStickerPackByPackKey(pack.pack_key, connection);
      if (!lockedPackRow) {
        throw new StickerPackError(STICKER_PACK_ERROR_CODES.PACK_NOT_FOUND, 'Pack nao encontrado.');
      }

      const currentStatus = normalizePackWebStatus(lockedPackRow.status, 'draft');
      if (currentStatus === 'published') {
        finalizeResult = {
          canPublish: true,
          packStatus: 'published',
          reason: 'already_published',
        };
        return;
      }

      await setStickerPackStatus(pack.id, 'processing', connection);

      const snapshot = await getPackConsistencySnapshot(pack.id, lockedPackRow.cover_sticker_id, connection);
      const canPublish = snapshot.sticker_count >= 1 && snapshot.failed_uploads === 0 && snapshot.processing_uploads === 0 && snapshot.pending_uploads === 0 && snapshot.cover_valid;

      if (canPublish) {
        await setStickerPackStatus(pack.id, 'published', connection);
        finalizeResult = {
          canPublish: true,
          packStatus: 'published',
          reason: 'published',
        };
        return;
      }

      await setStickerPackStatus(pack.id, 'draft', connection);
      finalizeResult = {
        canPublish: false,
        packStatus: 'draft',
        reason: snapshot.failed_uploads > 0 ? 'failed_uploads' : snapshot.processing_uploads > 0 ? 'uploads_processing' : snapshot.pending_uploads > 0 ? 'uploads_pending' : !snapshot.cover_valid ? 'cover_missing' : snapshot.sticker_count < 1 ? 'not_enough_stickers' : 'inconsistent',
      };
    });
  } catch (error) {
    await runSqlTransaction(async (connection) => {
      const lockedPackRow = await lockStickerPackByPackKey(pack.pack_key, connection).catch(() => null);
      if (lockedPackRow) {
        await setStickerPackStatus(pack.id, 'failed', connection);
      }
    }).catch(() => null);

    logPackWebFlow('error', 'finalize_failed', {
      pack_key: pack.pack_key,
      pack_id: pack.id,
      owner_jid: pack.owner_jid,
      error: error?.message,
      error_code: error?.code,
    });

    const mapped = mapStickerPackCreateError(error);
    sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
    return;
  }

  const freshPack = (await findStickerPackByPackKey(pack.pack_key)) || pack;
  const packState = await buildPackPublishStateData(freshPack, { includeUploads: true });

  if (finalizeResult.canPublish) {
    logPackWebFlow('info', 'finalize_success', {
      pack_key: pack.pack_key,
      pack_id: pack.id,
      owner_jid: pack.owner_jid,
      pack_status: 'published',
      sticker_count: packState?.consistency?.sticker_count || 0,
    });

    sendJson(req, res, 200, {
      data: {
        pack: mapPackSummary({ ...freshPack, sticker_count: packState.consistency.sticker_count }),
        publish_state: packState,
      },
    });
    return;
  }

  logPackWebFlow('warn', 'finalize_failed', {
    pack_key: pack.pack_key,
    pack_id: pack.id,
    owner_jid: pack.owner_jid,
    reason: finalizeResult.reason,
    pack_status: finalizeResult.packStatus,
    consistency: packState.consistency,
  });

  sendJson(req, res, 409, {
    error: 'Pack ainda não está consistente para publicação.',
    code: STICKER_PACK_ERROR_CODES.INVALID_INPUT,
    data: {
      pack: mapPackSummary({ ...freshPack, sticker_count: packState.consistency.sticker_count }),
      publish_state: packState,
      reason: finalizeResult.reason,
    },
  });
};

const handleCreatorRankingRequest = async (req, res, url) => {
  const visibility = normalizeCatalogVisibility(url.searchParams.get('visibility'));
  const q = sanitizeText(url.searchParams.get('q') || '', 120, { allowEmpty: true }) || '';
  const limit = clampInt(url.searchParams.get('limit'), 50, 5, 200);
  const googleSession = await resolveGoogleWebSessionFromRequest(req);
  const hasNsfwAccess = Boolean(googleSession?.sub && googleSession?.ownerJid);
  const cacheKey = buildCacheKey(['creator_ranking', visibility, q, limit, hasNsfwAccess ? 1 : 0]);
  const payload = await getCachedSnapshot({
    cacheMap: CATALOG_CREATOR_RANKING_CACHE,
    key: cacheKey,
    ttlSeconds: CATALOG_CREATOR_RANKING_CACHE_SECONDS,
    staleWhileRefresh: true,
    staleOnError: true,
    load: async () => {
      const { packs } = await listStickerPacksForCatalog({
        visibility,
        search: q,
        limit: 120,
        offset: 0,
      });
      const driftSnapshot = await getMarketplaceDriftSnapshot();
      const { entries } = await hydrateMarketplaceEntries(packs, { driftSnapshot });
      const ranking = buildCreatorRanking(STICKER_CATALOG_ONLY_CLASSIFIED ? entries.filter((entry) => isPackClassified(entry.packClassification)) : entries, { limit });

      return {
        data: ranking.map((creator) => ({
          creator_score: Number((Number(creator.avg_pack_score || 0) * 0.45 + Number(creator.total_likes || 0) * 0.0008 + Number(creator.total_opens || 0) * 0.00015).toFixed(6)),
          publisher: creator.publisher,
          verified: Boolean(creator.verified),
          badges: creator.verified ? ['verified_creator'] : [],
          stats: {
            packs_count: Number(creator.packs_count || 0),
            total_likes: Number(creator.total_likes || 0),
            total_opens: Number(creator.total_opens || 0),
            avg_pack_score: Number(creator.avg_pack_score || 0),
          },
          top_pack: creator.top_pack ? toSummaryEntry(creator.top_pack, { hideSensitiveCover: !hasNsfwAccess }) : null,
        })),
        filters: {
          visibility,
          q,
          limit,
        },
      };
    },
  });

  sendJson(req, res, 200, payload);
};

const handleRecommendationsRequest = async (req, res, url) => {
  const visibility = normalizeCatalogVisibility(url.searchParams.get('visibility'));
  const q = sanitizeText(url.searchParams.get('q') || '', 120, { allowEmpty: true }) || '';
  const categories = parseCategoryFilters(url.searchParams.get('categories'));
  const limit = clampInt(url.searchParams.get('limit'), 18, 4, 50);
  const viewerKey = normalizeViewerKey(url.searchParams.get('viewer_key'));
  const googleSession = await resolveGoogleWebSessionFromRequest(req);
  const hasNsfwAccess = Boolean(googleSession?.sub && googleSession?.ownerJid);

  const { packs } = await listStickerPacksForCatalog({
    visibility,
    search: q,
    limit: Math.max(limit * 4, 80),
    offset: 0,
  });
  const driftSnapshot = await getMarketplaceDriftSnapshot();
  const { entries, packClassificationById } = await hydrateMarketplaceEntries(packs, {
    driftSnapshot,
  });
  const entriesClassified = STICKER_CATALOG_ONLY_CLASSIFIED ? entries.filter((entry) => isPackClassified(entry.packClassification)) : entries;
  const entriesByCategory = categories.length ? entriesClassified.filter((entry) => hasAnyCategory(entry.packClassification?.tags || [], categories)) : entriesClassified;

  const viewerRecentPackIds = viewerKey ? await listViewerRecentPackIds(viewerKey, { days: 45, limit: 160 }) : [];
  const viewerAffinity = buildViewerTagAffinity({
    viewerEntries: viewerRecentPackIds,
    packClassificationById,
  });
  const personalized = buildPersonalizedRecommendations({
    entries: entriesByCategory,
    viewerAffinity,
    excludePackIds: new Set(viewerRecentPackIds.map((entry) => entry.pack_id)),
    limit,
  });
  const fallback = buildIntentCollections(entriesByCategory, { limit }).em_alta;
  const result = personalized.length ? personalized : fallback;

  sendJson(req, res, 200, {
    data: result.map((entry) => toSummaryEntry(entry, { hideSensitiveCover: !hasNsfwAccess })),
    meta: {
      personalized: Boolean(personalized.length),
      viewer_key_present: Boolean(viewerKey),
      inferred_affinity_tags: Array.from(viewerAffinity.entries())
        .sort((left, right) => Number(right[1]) - Number(left[1]))
        .slice(0, 8)
        .map(([tag]) => tag),
    },
    filters: {
      visibility,
      q,
      categories,
      limit,
    },
  });
};

const handleOrphanStickerListRequest = async (req, res, url) => {
  const q = sanitizeText(url.searchParams.get('q') || '', 140, { allowEmpty: true }) || '';
  const categories = parseCategoryFilters(url.searchParams.get('categories'));
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_ORPHAN_LIST_LIMIT, 1, MAX_ORPHAN_LIST_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const googleSession = await resolveGoogleWebSessionFromRequest(req);
  const hasNsfwAccess = Boolean(googleSession?.sub && googleSession?.ownerJid);

  const { assets, hasMore, total } = categories.length
    ? await listClassifiedOrphanAssetsByCategories({ search: q, categories, limit, offset })
    : await (STICKER_CATALOG_ONLY_CLASSIFIED ? listClassifiedStickerAssetsWithoutPack : listStickerAssetsWithoutPack)({
        search: q,
        limit,
        offset,
      });
  const classifications = await listStickerClassificationsByAssetIds(assets.map((asset) => asset.id));
  const byAssetId = new Map(classifications.map((entry) => [entry.asset_id, entry]));
  const filteredAssets = STICKER_CATALOG_ONLY_CLASSIFIED ? assets.filter((asset) => isStickerClassified(byAssetId.get(asset.id))) : assets;
  const filteredByCategories = categories.length ? filteredAssets.filter((asset) => hasAnyCategory(resolveClassificationTags(byAssetId.get(asset.id)), categories)) : filteredAssets;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  sendJson(req, res, 200, {
    data: filteredByCategories.map((asset) =>
      mapOrphanStickerAsset(asset, byAssetId.get(asset.id) || null, {
        hideSensitiveAssets: !hasNsfwAccess,
      }),
    ),
    pagination: {
      limit,
      offset,
      page: currentPage,
      total,
      total_pages: totalPages,
      has_more: hasMore,
      next_offset: hasMore ? offset + limit : null,
    },
    filters: {
      q,
      categories,
    },
  });
};

const handleDataFileListRequest = async (req, res, url) => {
  const q = sanitizeText(url.searchParams.get('q') || '', 140, { allowEmpty: true }) || '';
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_DATA_LIST_LIMIT, 1, MAX_DATA_LIST_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
  const normalizedQuery = q.toLowerCase();

  const allFiles = await listDataImageFiles();
  const filteredFiles = normalizedQuery ? allFiles.filter((item) => item.name.toLowerCase().includes(normalizedQuery) || item.relative_path.toLowerCase().includes(normalizedQuery)) : allFiles;

  const page = filteredFiles.slice(offset, offset + limit);
  const hasMore = offset + limit < filteredFiles.length;

  sendJson(req, res, 200, {
    data: page,
    pagination: {
      limit,
      offset,
      has_more: hasMore,
      next_offset: hasMore ? offset + limit : null,
      total: filteredFiles.length,
    },
    filters: {
      q,
    },
    meta: {
      root: STICKER_DATA_PUBLIC_DIR,
      public_path: STICKER_DATA_PUBLIC_PATH,
      api_base: buildDataAssetApiBaseUrl(),
    },
  });
};

const fetchPublicPackPayload = async (normalizedPackKey) => {
  const safePackKey = sanitizeText(normalizedPackKey, 160, { allowEmpty: false });
  if (!safePackKey) return null;
  const cacheKey = buildCacheKey(['public_pack_payload', safePackKey]);

  return getCachedSnapshot({
    cacheMap: CATALOG_PACK_PAYLOAD_CACHE,
    key: cacheKey,
    ttlSeconds: CATALOG_PACK_PAYLOAD_CACHE_SECONDS,
    staleWhileRefresh: true,
    staleOnError: true,
    load: async () => {
      const pack = await findStickerPackByPackKey(normalizedPackKey);
      if (!pack || !isPackPubliclyVisible(pack)) return null;

      const items = await listStickerPackItems(pack.id);
      const stickerIds = items.map((item) => item.sticker_id);
      const [classifications, packClassification, engagement] = await Promise.all([listStickerClassificationsByAssetIds(stickerIds), getPackClassificationSummaryByAssetIds(stickerIds), getStickerPackEngagementByPackId(pack.id)]);

      if (STICKER_CATALOG_ONLY_CLASSIFIED && !isPackClassified(packClassification)) {
        return null;
      }

      const [interactionStatsByPack, driftSnapshot, snapshotByPackId] = await Promise.all([
        listStickerPackInteractionStatsByPackIds([pack.id]),
        getMarketplaceDriftSnapshot(),
        canUseRankingSnapshotRead(`pack_payload:${pack.id}`)
          .then((enabled) => (enabled ? listStickerPackScoreSnapshotsByPackIds([pack.id]) : new Map()))
          .catch(() => new Map()),
      ]);
      const byAssetClassification = new Map(classifications.map((entry) => [entry.asset_id, entry]));
      const orderedClassifications = stickerIds.map((stickerId) => byAssetClassification.get(stickerId)).filter(Boolean);
      const snapshot = snapshotByPackId.get(pack.id);
      const signals = snapshot?.signals
        ? snapshot.signals
        : computePackSignals({
            pack: { ...pack, items },
            engagement,
            packClassification,
            itemClassifications: orderedClassifications,
            interactionStats: interactionStatsByPack.get(pack.id) || null,
            scoringWeights: driftSnapshot.weights,
          });

      return {
        pack,
        items,
        byAssetClassification,
        packClassification,
        engagement,
        signals,
      };
    },
  });
};

const handleDetailsRequest = async (req, res, packKey, url) => {
  const normalizedPackKey = sanitizeText(packKey, 160, { allowEmpty: false });
  const categories = parseCategoryFilters(url.searchParams.get('categories'));
  if (!normalizedPackKey) {
    sendJson(req, res, 400, { error: 'pack_key invalido.' });
    return;
  }
  const googleSession = await resolveGoogleWebSessionFromRequest(req);
  const hasNsfwAccess = Boolean(googleSession?.sub && googleSession?.ownerJid);

  const packPayload = await fetchPublicPackPayload(normalizedPackKey);
  if (!packPayload) {
    sendJson(req, res, 404, { error: 'Pack nao encontrado.' });
    return;
  }

  const { pack, items, byAssetClassification, packClassification, engagement, signals } = packPayload;
  const visibleItems = STICKER_CATALOG_ONLY_CLASSIFIED ? items.filter((item) => isStickerClassified(byAssetClassification.get(item.sticker_id))) : items;
  const visibleItemsByCategories = categories.length ? visibleItems.filter((item) => hasAnyCategory(resolveClassificationTags(byAssetClassification.get(item.sticker_id)), categories)) : visibleItems;

  sendJson(req, res, 200, {
    data: mapPackDetails(pack, visibleItemsByCategories, {
      byAssetClassification,
      packClassification,
      engagement,
      signals,
      hideSensitiveAssets: !hasNsfwAccess,
    }),
  });
};

const handleAssetRequest = async (req, res, packKey, stickerToken, url) => {
  const normalizedPackKey = sanitizeText(packKey, 160, { allowEmpty: false });
  const normalizedStickerId = sanitizeText(stripWebpExtension(stickerToken), 36, {
    allowEmpty: false,
  });
  const previewVariant = isPreviewVariantRequested(url);

  if (!normalizedPackKey || !normalizedStickerId) {
    sendJson(req, res, 400, { error: 'Parametros invalidos.' });
    return;
  }

  const pack = await findStickerPackByPackKey(normalizedPackKey);
  if (!pack || !isPackPubliclyVisible(pack)) {
    sendJson(req, res, 404, { error: 'Pack nao encontrado.' });
    return;
  }

  const items = await listStickerPackItems(pack.id);
  const item = items.find((entry) => entry.sticker_id === normalizedStickerId);
  const stickerIds = items.map((entry) => entry.sticker_id).filter(Boolean);

  if (!item?.asset) {
    sendJson(req, res, 404, { error: 'Sticker nao encontrado.' });
    return;
  }

  try {
    const buffer = await readStickerAssetBuffer(item.asset);
    const classification = await findStickerClassificationByAssetId(normalizedStickerId).catch(() => null);
    const packClassification = stickerIds.length ? await getPackClassificationSummaryByAssetIds(stickerIds).catch(() => null) : null;
    if (STICKER_CATALOG_ONLY_CLASSIFIED && !isStickerClassified(classification)) {
      sendJson(req, res, 404, { error: 'Sticker nao encontrado.' });
      return;
    }
    const decorated = classification ? decorateStickerClassification(classification) : null;
    const packMetadata = parsePackDescriptionMetadata(pack.description);
    const decoratedPackClassification = decoratePackClassificationSummary(packClassification);
    const packMarkedNsfw = isPackSummaryMarkedNsfw({
      name: pack.name || '',
      description: packMetadata.cleanDescription || '',
      classification: decoratedPackClassification,
      tags: mergeUniqueTags(decoratedPackClassification?.tags || [], packMetadata.tags),
      manual_tags: packMetadata.tags,
    });
    const stickerMarkedNsfw = isClassificationMarkedNsfw(decorated);
    if (packMarkedNsfw || stickerMarkedNsfw) {
      const googleSession = await resolveGoogleWebSessionFromRequest(req);
      const hasNsfwAccess = Boolean(googleSession?.sub && googleSession?.ownerJid);
      if (!hasNsfwAccess) {
        sendJson(req, res, 403, {
          error: 'Conteudo sensivel disponivel apenas para usuarios logados.',
        });
        return;
      }
    }

    const externalAssetUrl = previewVariant
      ? null
      : await getStickerAssetExternalUrl(item.asset, {
          secure: true,
          expiresInSeconds: Math.max(60, Math.min(3600, Number(process.env.STICKER_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS) || 300)),
        }).catch(() => null);
    if (!previewVariant && externalAssetUrl) {
      res.statusCode = 302;
      res.setHeader('Location', externalAssetUrl);
      res.setHeader('Cache-Control', 'private, max-age=45');
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end();
      return;
    }

    if (decorated) {
      res.setHeader('X-Sticker-Category', String(decorated?.category || 'unknown'));
      res.setHeader('X-Sticker-NSFW', decorated?.is_nsfw ? '1' : '0');
      if (Array.isArray(decorated?.tags) && decorated.tags.length) {
        res.setHeader('X-Sticker-Tags', decorated.tags.join(','));
      }
    }
    if (previewVariant) {
      const previewCacheKey = [normalizedPackKey, normalizedStickerId, Number(item.asset?.size_bytes || 0), STICKER_PREVIEW_SIDE_PX, STICKER_PREVIEW_QUALITY].join(':');
      const previewBuffer = await generateStickerPreviewBuffer({
        sourceBuffer: buffer,
        mimetype: item.asset?.mimetype || 'image/webp',
        cacheKey: previewCacheKey,
      }).catch((previewError) => {
        logger.warn('Falha ao gerar preview de sticker para catálogo.', {
          action: 'sticker_catalog_preview_generate_failed',
          pack_key: normalizedPackKey,
          sticker_id: normalizedStickerId,
          error: previewError?.message,
        });
        return null;
      });
      if (previewBuffer && previewBuffer.length) {
        res.setHeader('X-Sticker-Preview', '1');
        sendAsset(req, res, previewBuffer, 'image/webp', `public, max-age=${IMMUTABLE_ASSET_CACHE_SECONDS}, immutable`);
        return;
      }
    }
    sendAsset(req, res, buffer, item.asset.mimetype || 'image/webp');
  } catch (error) {
    logger.warn('Falha ao ler asset de sticker para rota web.', {
      action: 'sticker_catalog_asset_read_failed',
      pack_key: normalizedPackKey,
      sticker_id: normalizedStickerId,
      error: error?.message,
    });
    sendJson(req, res, 404, { error: 'Arquivo de sticker indisponivel.' });
  }
};

const findPublicPackByKey = async (rawPackKey) => {
  const normalizedPackKey = sanitizeText(rawPackKey, 160, { allowEmpty: false });
  if (!normalizedPackKey) return null;
  const pack = await findStickerPackByPackKey(normalizedPackKey);
  if (!pack || !isPackPubliclyVisible(pack)) return null;
  return pack;
};

const handlePackInteractionRequest = async (req, res, packKey, interaction, url) => {
  const pack = await findPublicPackByKey(packKey);
  if (!pack) {
    sendJson(req, res, 404, { error: 'Pack nao encontrado.' });
    return;
  }

  let engagement;
  if (interaction === 'open') {
    engagement = await incrementStickerPackOpen(pack.id);
  } else if (interaction === 'like') {
    engagement = await incrementStickerPackLike(pack.id);
  } else if (interaction === 'dislike') {
    engagement = await incrementStickerPackDislike(pack.id);
  } else {
    sendJson(req, res, 400, { error: 'Interacao invalida.' });
    return;
  }

  const actor = resolveActorKeysFromRequest(req, url);
  await createStickerPackInteractionEvent({
    packId: pack.id,
    interaction,
    actorKey: actor.actorKey,
    sessionKey: actor.sessionKey,
    source: actor.source,
  }).catch(() => null);

  sendJson(req, res, 200, {
    data: {
      pack_key: pack.pack_key,
      interaction,
      engagement: {
        open_count: Number(engagement.open_count || 0),
        like_count: Number(engagement.like_count || 0),
        dislike_count: Number(engagement.dislike_count || 0),
        score: Number(engagement.score || 0),
        updated_at: toIsoOrNull(engagement.updated_at),
      },
    },
  });
};

const { handleAdminPanelSessionRequest, handleAdminOverviewRequest, handleAdminUsersRequest, handleAdminForceLogoutRequest, handleAdminFeatureFlagsRequest, handleAdminOpsActionRequest, handleAdminSearchRequest, handleAdminExportRequest, handleAdminModeratorsRequest, handleAdminModeratorDeleteRequest, handleAdminPacksRequest, handleAdminPackDetailsRequest, handleAdminPackDeleteRequest, handleAdminPackStickerDeleteRequest, handleAdminGlobalStickerDeleteRequest, handleAdminBansRequest, handleAdminBanRevokeRequest } = createStickerCatalogAdminHandlersContext({
  executeQuery,
  tables: TABLES,
  logger,
  sendJson,
  readJsonBody,
  parseCookies,
  getCookieValuesFromRequest,
  appendSetCookie,
  buildCookieString,
  sanitizeText,
  normalizeGoogleSubject,
  normalizeEmail,
  normalizeJid,
  toIsoOrNull,
  toWhatsAppPhoneDigits,
  mapGoogleSessionResponseData,
  resolveGoogleWebSessionFromRequest,
  revokeGoogleWebSessionsByIdentity,
  getMarketplaceGlobalStatsCached,
  getSystemSummaryCached,
  getFeatureFlagsSnapshot,
  refreshFeatureFlags,
  listAdminBans,
  createAdminBanRecord,
  revokeAdminBanRecord,
  normalizeVisitPath,
  stickerWebPath: STICKER_WEB_PATH,
  findStickerPackByPackKey,
  stickerPackService,
  buildManagedPackResponseData,
  sendManagedMutationStatus,
  sendManagedPackMutationStatus,
  deleteManagedPackWithCleanup,
  mapStickerPackWebManageError,
  cleanupOrphanStickerAssets,
  invalidateStickerCatalogDerivedCaches,
});

const catalogApiRouter = createCatalogApiRouter({
  apiBasePath: STICKER_API_BASE_PATH,
  orphanApiPath: STICKER_ORPHAN_API_PATH,
  sendJson,
  handlers: {
    handleCreatePackRequest,
    handleGoogleAuthSessionRequest,
    handleTermsAcceptanceRequest,
    handlePasswordLoginRequest,
    handlePasswordAuthRequest,
    handlePasswordRecoveryRequest,
    handlePasswordRecoveryVerifyRequest,
    handlePasswordRecoverySessionCreateRequest,
    handlePasswordRecoverySessionStatusRequest,
    handlePasswordRecoverySessionRequest,
    handlePasswordRecoverySessionVerifyRequest,
    handleMyProfileRequest,
    handleAdminPanelSessionRequest,
    handleListRequest,
    handleIntentCollectionsRequest,
    handleCreatorRankingRequest,
    handleRecommendationsRequest,
    handleMarketplaceStatsRequest,
    handleHomeBootstrapRequest,
    handleCreatePackConfigRequest,
    handleOrphanStickerListRequest,
    handleDataFileListRequest,
    handleSystemSummaryRequest,
    handleGitHubProjectSummaryRequest,
    handleGlobalRankingSummaryRequest,
    handleReadmeSummaryRequest,
    handleReadmeMarkdownRequest,
    handleSupportInfoRequest,
    handleBotContactInfoRequest,
    handleAdminOverviewRequest,
    handleAdminUsersRequest,
    handleAdminForceLogoutRequest,
    handleAdminFeatureFlagsRequest,
    handleAdminOpsActionRequest,
    handleAdminSearchRequest,
    handleAdminExportRequest,
    handleAdminModeratorsRequest,
    handleAdminModeratorDeleteRequest,
    handleAdminPacksRequest,
    handleAdminPackDetailsRequest,
    handleAdminPackDeleteRequest,
    handleAdminPackStickerDeleteRequest,
    handleAdminGlobalStickerDeleteRequest,
    handleAdminBansRequest,
    handleAdminBanRevokeRequest,
    handleDetailsRequest,
    handlePackInteractionRequest,
    handleManagedPackRequest,
    handleManagedPackCloneRequest,
    handleManagedPackCoverRequest,
    handleManagedPackReorderRequest,
    handleManagedPackAnalyticsRequest,
    handleManagedPackStickerCreateRequest,
    handleManagedPackStickerDeleteRequest,
    handleManagedPackStickerReplaceRequest,
    handlePackPublishStateRequest,
    handleFinalizePackRequest,
    handleUploadStickerToPackRequest,
    handleAssetRequest,
  },
});

const handleCatalogApiRequest = async (req, res, pathname, url) => catalogApiRouter({ req, res, pathname, url });

const handleCatalogPageRequest = async (req, res, pathname) => {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  void trackWebVisitMetric(req, res, {
    pagePath: normalizedPath || STICKER_WEB_PATH,
    source: 'catalog_page',
  }).catch((error) => {
    logger.warn('Falha ao registrar visita de página do catálogo.', {
      action: 'web_visit_track_catalog_page_failed',
      error: error?.message,
      page_path: normalizedPath || STICKER_WEB_PATH,
    });
  });

  if (normalizedPath === STICKER_CREATE_WEB_PATH) {
    try {
      const googleSession = await resolveGoogleWebSessionFromRequest(req);
      if (!googleSession?.ownerJid) {
        const requestUrl = new URL(req.url || `${STICKER_CREATE_WEB_PATH}/`, SITE_ORIGIN);
        const nextPath = `${requestUrl.pathname}${requestUrl.search}`;
        const loginRedirectUrl = new URL(`${STICKER_LOGIN_WEB_PATH}/`, SITE_ORIGIN);
        loginRedirectUrl.searchParams.set('next', nextPath);

        res.statusCode = 302;
        res.setHeader('Location', `${loginRedirectUrl.pathname}${loginRedirectUrl.search}`);
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }

      const html = await renderCreatePackHtml();
      sendText(req, res, 200, html, 'text/html; charset=utf-8');
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(req, res, 404, { error: 'Template da criacao de packs nao encontrado.' });
        return;
      }
      logger.error('Falha ao renderizar pagina de criacao de packs.', {
        action: 'sticker_catalog_create_page_render_failed',
        path: pathname,
        error: error?.message,
      });
      sendJson(req, res, 500, { error: 'Falha interna ao renderizar criacao de packs.' });
      return;
    }
  }

  const initialPackKey = extractPackKeyFromWebPath(pathname);
  const initialPackKeyNormalized = String(initialPackKey || '')
    .trim()
    .toLowerCase();
  const shouldRenderPackSeoPage = Boolean(initialPackKey && !PACK_PAGE_ROUTE_EXCLUSIONS.has(initialPackKeyNormalized));

  if (shouldRenderPackSeoPage) {
    const safePackKey = sanitizeText(initialPackKey, 160, { allowEmpty: false });
    if (!safePackKey) {
      const notFoundHtml = renderPackNotFoundHtml(initialPackKey);
      sendText(req, res, 404, notFoundHtml, 'text/html; charset=utf-8');
      return;
    }

    try {
      const packPayload = await fetchPublicPackPayload(safePackKey);
      if (!packPayload) {
        const notFoundHtml = renderPackNotFoundHtml(safePackKey);
        sendText(req, res, 404, notFoundHtml, 'text/html; charset=utf-8');
        return;
      }

      const googleSession = await resolveGoogleWebSessionFromRequest(req);
      const hasNsfwAccess = Boolean(googleSession?.sub && googleSession?.ownerJid);
      const packSummary = toSummaryEntry(
        {
          pack: packPayload.pack,
          engagement: packPayload.engagement,
          signals: packPayload.signals,
          packClassification: packPayload.packClassification,
        },
        { hideSensitiveCover: !hasNsfwAccess },
      );
      const html = renderPackSeoHtml({ packSummary });
      sendText(req, res, 200, html, 'text/html; charset=utf-8');
      return;
    } catch (error) {
      logger.error('Falha ao renderizar pagina SEO de pack.', {
        action: 'sticker_catalog_pack_seo_page_render_failed',
        path: pathname,
        pack_key: safePackKey,
        error: error?.message,
      });
      const notFoundHtml = renderPackNotFoundHtml(safePackKey);
      sendText(req, res, 404, notFoundHtml, 'text/html; charset=utf-8');
      return;
    }
  }

  try {
    const html = await renderCatalogHtml({ initialPackKey: '' });
    sendText(req, res, 200, html, 'text/html; charset=utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(req, res, 404, { error: 'Template do catalogo nao encontrado.' });
      return;
    }

    logger.error('Falha ao renderizar pagina do catalogo de sticker packs.', {
      action: 'sticker_catalog_page_render_failed',
      path: pathname,
      error: error?.message,
      stack: error?.stack,
    });
    sendJson(req, res, 500, { error: `Falha interna ao renderizar catalogo: ${error?.message}` });
  }
};

export const isStickerCatalogEnabled = () => STICKER_CATALOG_ENABLED;
export const getStickerCatalogConfig = () => ({
  stickerCatalogEnabled: STICKER_CATALOG_ENABLED,
  stickerWebPath: STICKER_WEB_PATH,
  stickerApiBasePath: STICKER_API_BASE_PATH,
  stickerOrphanApiPath: STICKER_ORPHAN_API_PATH,
  stickerCreateWebPath: STICKER_CREATE_WEB_PATH,
  stickerLoginWebPath: STICKER_LOGIN_WEB_PATH,
  userProfileWebPath: USER_PROFILE_WEB_PATH,
  userPasswordResetWebPath: USER_PASSWORD_RESET_WEB_PATH,
  stickerDataPublicPath: STICKER_DATA_PUBLIC_PATH,
  stickerDataPublicDir: STICKER_DATA_PUBLIC_DIR,
  stickerWebAssetVersion: STICKER_WEB_ASSET_VERSION,
  catalogTemplatePath: CATALOG_TEMPLATE_PATH,
  createPackTemplatePath: CREATE_PACK_TEMPLATE_PATH,
  catalogStylesFilePath: CATALOG_STYLES_FILE_PATH,
  catalogScriptFilePath: CATALOG_SCRIPT_FILE_PATH,
  defaultListLimit: DEFAULT_LIST_LIMIT,
  maxListLimit: MAX_LIST_LIMIT,
  defaultOrphanListLimit: DEFAULT_ORPHAN_LIST_LIMIT,
  maxOrphanListLimit: MAX_ORPHAN_LIST_LIMIT,
  defaultDataListLimit: DEFAULT_DATA_LIST_LIMIT,
  maxDataListLimit: MAX_DATA_LIST_LIMIT,
  maxDataScanFiles: MAX_DATA_SCAN_FILES,
  assetCacheSeconds: ASSET_CACHE_SECONDS,
  staticTextCacheSeconds: STATIC_TEXT_CACHE_SECONDS,
  immutableAssetCacheSeconds: IMMUTABLE_ASSET_CACHE_SECONDS,
  stickerWebWhatsappMessageTemplate: STICKER_WEB_WHATSAPP_MESSAGE_TEMPLATE,
  packCommandPrefix: PACK_COMMAND_PREFIX,
  packCreateNameRegex: PACK_CREATE_NAME_REGEX,
  packCreateMaxNameLength: PACK_CREATE_MAX_NAME_LENGTH,
  packCreateMaxPublisherLength: PACK_CREATE_MAX_PUBLISHER_LENGTH,
  packCreateMaxDescriptionLength: PACK_CREATE_MAX_DESCRIPTION_LENGTH,
  packCreateMaxItems: PACK_CREATE_MAX_ITEMS,
  packCreateMaxPacksPerOwner: PACK_CREATE_MAX_PACKS_PER_OWNER,
  packWebEditTokenTtlMs: PACK_WEB_EDIT_TOKEN_TTL_MS,
  stickerWebGoogleClientId: STICKER_WEB_GOOGLE_CLIENT_ID,
  stickerWebGoogleAuthRequired: STICKER_WEB_GOOGLE_AUTH_REQUIRED,
  stickerWebGoogleSessionTtlMs: STICKER_WEB_GOOGLE_SESSION_TTL_MS,
  stickerCatalogOnlyClassified: STICKER_CATALOG_ONLY_CLASSIFIED,
  metricsEndpoint: process.env.METRICS_ENDPOINT,
  metricsToken: process.env.METRICS_TOKEN,
  metricsSummaryTimeoutMs: process.env.STICKER_SYSTEM_METRICS_TIMEOUT_MS,
  githubRepository: process.env.GITHUB_REPOSITORY,
  githubToken: process.env.GITHUB_TOKEN,
  githubProjectCacheSeconds: Number(process.env.GITHUB_PROJECT_CACHE_SECONDS || 300),
  userInternalApiToken: USER_INTERNAL_API_TOKEN,
  userInternalReadRequireAuth: USER_INTERNAL_READ_REQUIRE_AUTH,
  userContactEndpointRequireAuth: USER_CONTACT_ENDPOINT_REQUIRE_AUTH,
  homeBootstrapExposeContact: HOME_BOOTSTRAP_EXPOSE_CONTACT,
  adminPanelEmail: ADMIN_PANEL_EMAIL,
  globalRankRefreshSeconds: GLOBAL_RANK_REFRESH_SECONDS,
  catalogListCacheSeconds: CATALOG_LIST_CACHE_SECONDS,
  catalogCreatorRankingCacheSeconds: CATALOG_CREATOR_RANKING_CACHE_SECONDS,
  catalogPackPayloadCacheSeconds: CATALOG_PACK_PAYLOAD_CACHE_SECONDS,
  marketplaceGlobalStatsCacheSeconds: MARKETPLACE_GLOBAL_STATS_CACHE_SECONDS,
  homeMarketplaceStatsCacheSeconds: HOME_MARKETPLACE_STATS_CACHE_SECONDS,
  systemSummaryCacheSeconds: SYSTEM_SUMMARY_CACHE_SECONDS,
  readmeSummaryCacheSeconds: README_SUMMARY_CACHE_SECONDS,
  readmeMessageTypeSampleLimit: README_MESSAGE_TYPE_SAMPLE_LIMIT,
  readmeCommandPrefix: README_COMMAND_PREFIX,
  siteOrigin: SITE_ORIGIN,
  sitemapMaxPacks: SITEMAP_MAX_PACKS,
  sitemapCacheSeconds: SITEMAP_CACHE_SECONDS,
  seoDiscoveryLinkLimit: SEO_DISCOVERY_LINK_LIMIT,
  seoDiscoveryCacheSeconds: SEO_DISCOVERY_CACHE_SECONDS,
  nsfwStickerPlaceholderUrl: NSFW_STICKER_PLACEHOLDER_URL,
  maxStickerUploadBytes: MAX_STICKER_UPLOAD_BYTES,
  maxStickerSourceUploadBytes: MAX_STICKER_SOURCE_UPLOAD_BYTES,
  webVisitorCookieTtlSeconds: WEB_VISITOR_COOKIE_TTL_SECONDS,
  webSessionCookieTtlSeconds: WEB_SESSION_COOKIE_TTL_SECONDS,
  stickerPreviewSidePx: STICKER_PREVIEW_SIDE_PX,
  stickerPreviewQuality: STICKER_PREVIEW_QUALITY,
  stickerPreviewTimeoutMs: STICKER_PREVIEW_TIMEOUT_MS,
  stickerPreviewCacheTtlMs: STICKER_PREVIEW_CACHE_TTL_MS,
  stickerPreviewCacheMaxItems: STICKER_PREVIEW_CACHE_MAX_ITEMS,
  catalogStylesWebPath: CATALOG_STYLES_WEB_PATH,
  catalogScriptWebPath: CATALOG_SCRIPT_WEB_PATH,
});

/**
 * Manipula rotas web/API de catalogo de sticker packs.
 *
 * @param {import('node:http').IncomingMessage} req Requisicao HTTP.
 * @param {import('node:http').ServerResponse} res Resposta HTTP.
 * @param {{ pathname: string, url: URL }} context Contexto parseado da URL.
 * @returns {Promise<boolean>} `true` quando a rota foi tratada.
 */
export async function maybeHandleStickerCatalogRequest(req, res, { pathname, url }) {
  if (!STICKER_CATALOG_ENABLED) return false;
  if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(req.method || '')) return false;
  if (maybeRedirectToCanonicalHost(req, res, url)) return true;

  if (pathname === '/sitemap.xml') {
    if (!['GET', 'HEAD'].includes(req.method || '')) return false;
    try {
      return await handleSitemapRequest(req, res);
    } catch (error) {
      logger.error('Falha ao gerar sitemap dinamico.', {
        action: 'sticker_catalog_sitemap_failed',
        error: error?.message,
      });
      sendJson(req, res, 500, { error: 'Falha ao gerar sitemap.' });
      return true;
    }
  }

  if (hasPathPrefix(pathname, STICKER_DATA_PUBLIC_PATH)) {
    if (!['GET', 'HEAD'].includes(req.method || '')) return false;
    return handlePublicDataAssetRequest(req, res, pathname);
  }

  if (hasPathPrefix(pathname, STICKER_WEB_PATH)) {
    if (!['GET', 'HEAD'].includes(req.method || '')) return false;
    const handledStaticAsset = await handleCatalogStaticAssetRequest(req, res, pathname);
    if (handledStaticAsset) return true;

    await handleCatalogPageRequest(req, res, pathname);
    return true;
  }

  if (pathname === MARKETPLACE_GLOBAL_STATS_API_PATH) {
    if (!['GET', 'HEAD'].includes(req.method || '')) return false;
    try {
      await handleMarketplaceGlobalStatsRequest(req, res);
    } catch (error) {
      logger.error('Erro ao processar API global do marketplace.', {
        action: 'marketplace_global_stats_api_error',
        path: pathname,
        error: error?.message,
      });
      sendJson(req, res, 500, { error: 'Falha interna ao processar a requisicao.' });
    }
    return true;
  }

  const handleUserApiReadRoute = async (handler, action, { access = 'public' } = {}) => {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return true;
    }

    let resolvedSession = null;
    if (access === 'internal') {
      const allowed = await requireInternalUserApiReadAccess(req, res);
      if (!allowed) return true;
    } else if (access === 'contact') {
      resolvedSession = await resolveGoogleWebSessionFromRequest(req).catch(() => null);
      const allowed = await requireContactUserApiReadAccess(req, res, resolvedSession);
      if (!allowed) return true;
    }

    try {
      await handler({ session: resolvedSession });
    } catch (error) {
      logger.error('Erro ao processar rota utilitaria da API de usuario.', {
        action,
        path: pathname,
        error: error?.message,
      });
      sendJson(req, res, 500, { error: 'Falha interna ao processar a requisicao.' });
    }
    return true;
  };

  if (pathname === `${USER_API_BASE_PATH}/home-bootstrap`) {
    return handleUserApiReadRoute(() => handleHomeBootstrapRequest(req, res, url), 'user_home_bootstrap_api_error');
  }

  if (pathname === `${USER_API_BASE_PATH}/system-summary`) {
    return handleUserApiReadRoute(() => handleSystemSummaryRequest(req, res), 'user_system_summary_api_error', { access: 'internal' });
  }

  if (pathname === `${USER_API_BASE_PATH}/project-summary`) {
    return handleUserApiReadRoute(() => handleGitHubProjectSummaryRequest(req, res), 'user_project_summary_api_error', { access: 'internal' });
  }

  if (pathname === `${USER_API_BASE_PATH}/global-ranking-summary`) {
    return handleUserApiReadRoute(() => handleGlobalRankingSummaryRequest(req, res), 'user_global_ranking_summary_api_error');
  }

  if (pathname === `${USER_API_BASE_PATH}/readme-markdown`) {
    return handleUserApiReadRoute(() => handleReadmeMarkdownRequest(req, res), 'user_readme_markdown_api_error', { access: 'internal' });
  }

  if (pathname === `${USER_API_BASE_PATH}/support`) {
    return handleUserApiReadRoute(() => handleSupportInfoRequest(req, res), 'user_support_api_error', { access: 'contact' });
  }

  if (pathname === `${USER_API_BASE_PATH}/bot-contact`) {
    return handleUserApiReadRoute(() => handleBotContactInfoRequest(req, res), 'user_bot_contact_api_error');
  }

  if (hasPathPrefix(pathname, STICKER_API_BASE_PATH)) {
    try {
      return await handleCatalogApiRequest(req, res, pathname, url);
    } catch (error) {
      logger.error('Erro ao processar API de sticker packs.', {
        action: 'sticker_catalog_api_error',
        path: pathname,
        error: error?.message,
      });
      sendJson(req, res, 500, { error: 'Falha interna ao processar a requisicao.' });
      return true;
    }
  }

  return false;
}
