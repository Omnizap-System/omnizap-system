import logger from '#logger';
import { executeQuery, TABLES } from '../../../database/index.js';
import { getActiveSocket, getActiveSocketsBySession, getJidUser, getMultiSessionRuntimeConfig, isSocketOpen, normalizeJid, profilePictureUrlFromActiveSocket } from '../../../app/config/index.js';
import { getSystemMetrics } from '../../../app/utils/systemMetrics/systemMetricsModule.js';
import { createStickerCatalogSystemContext } from './stickerCatalogSystemContext.js';
import { createStickerCatalogNonCatalogHandlers } from '../sticker/nonCatalogHandlers.js';
import { sendJson, sendText, normalizeCatalogVisibility, normalizeVisitPath } from '../../http/httpRequestUtils.js';
import { fetchGitHubProjectSummary } from './githubController.js';
import { fetchPrometheusSummary } from './systemMetricsController.js';
import { buildBotContactInfo, buildSupportInfo, resolveCatalogBotPhone } from './contactController.js';
import { buildAdminMenu, buildAiMenu, buildAnimeMenu, buildMediaMenu, buildMenuCaption, buildQuoteMenu, buildStatsMenu, buildStickerMenu } from '../../../app/modules/menuModule/common.js';
import { trackWebVisitMetric } from './visitController.js';
import groupOwnershipService from '../../../app/services/multiSession/groupOwnershipService.js';
import sessionRegistryService from '../../../app/services/multiSession/sessionRegistryService.js';
import { runGroupAssignmentBalancerCycle } from '../../../app/services/multiSession/assignmentBalancerService.js';

const SYSTEM_SUMMARY_CACHE_SECONDS = Number(process.env.SYSTEM_SUMMARY_CACHE_SECONDS || 20);
const README_SUMMARY_CACHE_SECONDS = Number(process.env.README_SUMMARY_CACHE_SECONDS || 1800);
const README_MESSAGE_TYPE_SAMPLE_LIMIT = Number(process.env.README_MESSAGE_TYPE_SAMPLE_LIMIT || 25000);
const README_COMMAND_PREFIX = process.env.README_COMMAND_PREFIX || process.env.COMMAND_PREFIX || '/';
const GLOBAL_RANK_REFRESH_SECONDS = Number(process.env.GLOBAL_RANK_REFRESH_SECONDS || 600);
const MARKETPLACE_GLOBAL_STATS_CACHE_SECONDS = Number(process.env.MARKETPLACE_GLOBAL_STATS_CACHE_SECONDS || 45);
const GITHUB_PROJECT_CACHE_SECONDS = Number(process.env.GITHUB_PROJECT_CACHE_SECONDS || 300);

const SYSTEM_SUMMARY_CACHE = { expiresAt: 0, value: null, pending: null };
const README_SUMMARY_CACHE = { expiresAt: 0, value: null, pending: null };
const GLOBAL_RANK_CACHE = { expiresAt: 0, value: null, pending: null };
const MARKETPLACE_GLOBAL_STATS_CACHE = { expiresAt: 0, value: null, pending: null };

const resolveSocketReadyState = (activeSocket) => {
  const raw = activeSocket?.ws?.readyState;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const normalized = String(raw || '')
    .trim()
    .toLowerCase();
  if (normalized === 'open') return 1;
  if (normalized === 'connecting') return 0;
  if (normalized === 'closing') return 2;
  if (normalized === 'closed') return 3;
  return null;
};

const resolveActiveSocketBotJid = (sock) => {
  if (!sock) return '';
  const candidates = [sock?.user?.id, sock?.authState?.creds?.me?.id, sock?.authState?.creds?.me?.lid];
  for (const candidate of candidates) {
    const resolved = normalizeJid(candidate);
    if (resolved) return resolved;
  }
  return '';
};

export const systemContext = createStickerCatalogSystemContext({
  executeQuery,
  tables: TABLES,
  logger,
  getSystemMetrics,
  getActiveSocket,
  resolveSocketReadyState,
  resolveActiveSocketBotJid,
  resolveCatalogBotPhone,
  fetchPrometheusSummary,
  metricsEndpoint: process.env.METRICS_ENDPOINT,
  systemSummaryCache: SYSTEM_SUMMARY_CACHE,
  systemSummaryCacheSeconds: SYSTEM_SUMMARY_CACHE_SECONDS,
  readmeSummaryCache: README_SUMMARY_CACHE,
  readmeSummaryCacheSeconds: README_SUMMARY_CACHE_SECONDS,
  readmeMessageTypeSampleLimit: README_MESSAGE_TYPE_SAMPLE_LIMIT,
  readmeCommandPrefix: README_COMMAND_PREFIX,
  buildMenuCaption,
  buildStickerMenu,
  buildMediaMenu,
  buildQuoteMenu,
  buildAnimeMenu,
  buildAiMenu,
  buildStatsMenu,
  buildAdminMenu,
  profilePictureUrlFromActiveSocket,
  normalizeJid,
  getJidUser,
  globalRankCache: GLOBAL_RANK_CACHE,
  globalRankRefreshSeconds: GLOBAL_RANK_REFRESH_SECONDS,
  marketplaceGlobalStatsCache: MARKETPLACE_GLOBAL_STATS_CACHE,
  marketplaceGlobalStatsCacheSeconds: MARKETPLACE_GLOBAL_STATS_CACHE_SECONDS,
});

const { getSystemSummaryCached, getReadmeSummaryCached, resolveBotUserCandidates, sanitizeRankingPayloadByBot, getGlobalRankingSummaryCached, scheduleGlobalRankingPreload, getMarketplaceGlobalStatsCached } = systemContext;

const resolveVisitPathFromReferrer = (req) => {
  const rawReferrer = String(req?.headers?.referer || req?.headers?.referrer || '').trim();
  if (!rawReferrer) return '/';
  try {
    const parsed = new URL(rawReferrer);
    const requestHost = req.headers.host;
    if (requestHost && parsed.host && parsed.host.toLowerCase() !== requestHost.toLowerCase()) return '/';
    return normalizeVisitPath(parsed.pathname || '/');
  } catch {
    return '/';
  }
};

export const systemHandlers = createStickerCatalogNonCatalogHandlers({
  sendJson,
  sendText,
  logger,
  getSystemSummaryCached,
  systemSummaryCache: SYSTEM_SUMMARY_CACHE,
  systemSummaryCacheSeconds: SYSTEM_SUMMARY_CACHE_SECONDS,
  getReadmeSummaryCached,
  readmeSummaryCache: README_SUMMARY_CACHE,
  readmeSummaryCacheSeconds: README_SUMMARY_CACHE_SECONDS,
  getGlobalRankingSummaryCached,
  globalRankRefreshSeconds: GLOBAL_RANK_REFRESH_SECONDS,
  globalRankCache: GLOBAL_RANK_CACHE,
  sanitizeRankingPayloadByBot,
  getActiveSocket,
  resolveBotUserCandidates,
  getMarketplaceGlobalStatsCached,
  marketplaceGlobalStatsCacheSeconds: MARKETPLACE_GLOBAL_STATS_CACHE_SECONDS,
  marketplaceGlobalStatsCache: MARKETPLACE_GLOBAL_STATS_CACHE,
  githubRepoInfo: { fullName: process.env.GITHUB_REPOSITORY || 'Omnizap-System/omnizap' },
  githubProjectCacheSeconds: GITHUB_PROJECT_CACHE_SECONDS,
  fetchGitHubProjectSummary,
  buildSupportInfo,
  buildBotContactInfo,
  trackWebVisitMetric,
  resolveVisitPathFromReferrer,
  normalizeCatalogVisibility,
  stickerWebGoogleClientId: process.env.STICKER_WEB_GOOGLE_CLIENT_ID,
  homeBootstrapExposeContact: process.env.HOME_BOOTSTRAP_EXPOSE_CONTACT !== 'false',
  // Estas serão injetadas via bridge para evitar circular dependency
  getMarketplaceStatsCached: (vis) => globalThis.getMarketplaceStatsCachedBridge?.(vis),
  resolveGoogleWebSessionFromRequest: (req) => globalThis.resolveGoogleWebSessionFromRequestBridge?.(req),
  mapGoogleSessionResponseData: (sess, opts) => globalThis.mapGoogleSessionResponseDataBridge?.(sess, opts),
  isAuthenticatedGoogleSession: (sess) => Boolean(sess?.sub && (sess?.ownerJid || sess?.ownerPhone || sess?.email)),
});

const clampLimit = (value, fallback = 200, min = 1, max = 5_000) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const normalizeOptional = (value, maxLength = 255) => {
  const normalized = String(value || '')
    .trim()
    .slice(0, maxLength);
  return normalized || null;
};

const normalizeBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const toIso = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

const resolveSocketRuntimeState = (socket) => {
  const open = isSocketOpen(socket);
  const readyState = resolveSocketReadyState(socket);
  const botJid = resolveActiveSocketBotJid(socket);
  return {
    socket_open: open,
    socket_ready_state: readyState,
    socket_bot_jid: botJid || null,
  };
};

export const listSystemAdminSessions = async ({ status = null, limit = 200 } = {}) => {
  const runtimeConfig = getMultiSessionRuntimeConfig();
  const safeStatus = normalizeOptional(status, 24);
  const safeLimit = clampLimit(limit, 200, 1, 5_000);
  const registryRows = await sessionRegistryService.listSessions({
    status: safeStatus,
    limit: safeLimit,
  });

  const socketsBySession = getActiveSocketsBySession();
  const knownSessionIds = new Set();
  for (const sessionId of runtimeConfig.sessionIds || []) knownSessionIds.add(sessionId);
  for (const row of registryRows || []) {
    if (row?.sessionId) knownSessionIds.add(row.sessionId);
  }

  const selectedSessionIds = Array.from(knownSessionIds)
    .filter(Boolean)
    .slice(0, safeLimit);
  const registryBySession = new Map((registryRows || []).map((row) => [row.sessionId, row]));

  const sessions = selectedSessionIds.map((sessionId) => {
    const row = registryBySession.get(sessionId) || null;
    const socket = socketsBySession.get(sessionId) || null;
    const socketRuntime = resolveSocketRuntimeState(socket);

    return {
      session_id: sessionId,
      is_primary: sessionId === runtimeConfig.primarySessionId,
      configured: (runtimeConfig.sessionIds || []).includes(sessionId),
      configured_weight: Number(runtimeConfig.sessionWeights?.[sessionId] || 1),
      status: row?.status || (socketRuntime.socket_open ? 'online' : 'offline'),
      bot_jid: row?.botJid || socketRuntime.socket_bot_jid || null,
      capacity_weight: Number(row?.capacityWeight || runtimeConfig.sessionWeights?.[sessionId] || 1),
      current_score: Number(row?.currentScore || 0),
      last_heartbeat_at: toIso(row?.lastHeartbeatAt),
      last_connected_at: toIso(row?.lastConnectedAt),
      last_disconnected_at: toIso(row?.lastDisconnectedAt),
      updated_at: toIso(row?.updatedAt),
      metadata: row?.metadata || null,
      ...socketRuntime,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    primary_session_id: runtimeConfig.primarySessionId,
    configured_session_ids: runtimeConfig.sessionIds || [],
    sessions,
  };
};

export const listSystemAdminAssignments = async (
  {
    groupJid = null,
    ownerSessionId = null,
    includeExpired = false,
    limit = 200,
  } = {},
) => {
  const safeGroupJid = normalizeOptional(groupJid, 255);
  const safeOwnerSessionId = normalizeOptional(ownerSessionId, 64);
  const safeIncludeExpired = normalizeBoolean(includeExpired, false);
  const safeLimit = clampLimit(limit, 200, 1, 5_000);

  const assignments = await groupOwnershipService.listAssignments({
    groupJid: safeGroupJid,
    ownerSessionId: safeOwnerSessionId,
    includeExpired: safeIncludeExpired,
    limit: safeLimit,
  });

  return {
    generated_at: new Date().toISOString(),
    filters: {
      group_jid: safeGroupJid,
      owner_session_id: safeOwnerSessionId,
      include_expired: safeIncludeExpired,
      limit: safeLimit,
    },
    assignments: (assignments || []).map((assignment) => ({
      group_jid: assignment?.groupJid || null,
      owner_session_id: assignment?.ownerSessionId || null,
      lease_expires_at: toIso(assignment?.leaseExpiresAt),
      cooldown_until: toIso(assignment?.cooldownUntil),
      assignment_version: Number(assignment?.assignmentVersion || 1),
      pinned: assignment?.pinned === true,
      active: assignment?.active !== false,
      last_reason: assignment?.lastReason || null,
      created_at: toIso(assignment?.createdAt),
      updated_at: toIso(assignment?.updatedAt),
    })),
  };
};

export const setSystemAdminGroupPin = async (
  {
    groupJid,
    pinned,
    sessionId = null,
    reason = null,
    changedBy = 'admin_api',
    metadata = null,
  } = {},
) => {
  const outcome = await groupOwnershipService.setPinned({
    groupJid,
    pinned,
    sessionId,
    reason: reason || (pinned ? 'admin_pin_group' : 'admin_unpin_group'),
    changedBy,
    metadata,
  });

  return {
    updated: Boolean(outcome?.updated),
    reason: outcome?.reason || null,
    assignment_version: Number(outcome?.assignmentVersion || 0) || null,
    previous_owner_session_id: outcome?.previousOwnerSessionId || null,
    owner: outcome?.owner
      ? {
          group_jid: outcome.owner.groupJid,
          owner_session_id: outcome.owner.ownerSessionId,
          lease_expires_at: toIso(outcome.owner.leaseExpiresAt),
          cooldown_until: toIso(outcome.owner.cooldownUntil),
          assignment_version: Number(outcome.owner.assignmentVersion || 1),
          pinned: outcome.owner.pinned === true,
          last_reason: outcome.owner.lastReason || null,
        }
      : null,
  };
};

export const forceSystemAdminGroupFailover = async (
  {
    groupJid,
    targetSessionId,
    reason = 'admin_force_failover',
    changedBy = 'admin_api',
    metadata = null,
  } = {},
) => {
  const outcome = await groupOwnershipService.forceAssign({
    groupJid,
    sessionId: targetSessionId,
    reason,
    changedBy,
    metadata,
  });

  return {
    reassigned: Boolean(outcome?.reassigned),
    reason: outcome?.reason || null,
    assignment_version: Number(outcome?.assignmentVersion || 0) || null,
    previous_owner_session_id: outcome?.previousOwnerSessionId || null,
    owner: outcome?.owner
      ? {
          group_jid: outcome.owner.groupJid,
          owner_session_id: outcome.owner.ownerSessionId,
          lease_expires_at: toIso(outcome.owner.leaseExpiresAt),
          assignment_version: Number(outcome.owner.assignmentVersion || 1),
          pinned: outcome.owner.pinned === true,
          last_reason: outcome.owner.lastReason || null,
        }
      : null,
  };
};

export const triggerSystemAdminManualRebalance = async () => {
  const cycle = await runGroupAssignmentBalancerCycle();
  return {
    generated_at: new Date().toISOString(),
    cycle,
  };
};

export const listSystemAdminAssignmentHistory = async ({ groupJid = null, limit = 100 } = {}) => {
  const safeLimit = clampLimit(limit, 100, 1, 5_000);
  const safeGroupJid = normalizeOptional(groupJid, 255);
  const params = [];
  const where = [];
  if (safeGroupJid) {
    where.push('group_jid = ?');
    params.push(safeGroupJid);
  }

  const rows = await executeQuery(
    `SELECT id, group_jid, previous_session_id, new_session_id, change_reason, changed_by, assignment_version, metadata, created_at
       FROM ${TABLES.GROUP_ASSIGNMENT_HISTORY}
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT ${safeLimit}`,
    params,
  );

  return {
    generated_at: new Date().toISOString(),
    history: (Array.isArray(rows) ? rows : []).map((row) => ({
      id: Number(row?.id || 0),
      group_jid: row?.group_jid || null,
      previous_session_id: row?.previous_session_id || null,
      new_session_id: row?.new_session_id || null,
      change_reason: row?.change_reason || null,
      changed_by: row?.changed_by || null,
      assignment_version: Number(row?.assignment_version || 0) || null,
      metadata: row?.metadata || null,
      created_at: toIso(row?.created_at),
    })),
  };
};

export { scheduleGlobalRankingPreload };
