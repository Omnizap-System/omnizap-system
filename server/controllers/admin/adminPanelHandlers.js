import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';

import { setAdminOverviewSnapshot } from '../../../app/observability/metrics.js';
import { parseAdminModeratorUpsertPayload, parseAdminSessionPasswordPayload } from '../../auth/validation/authSchemas.js';

export const createStickerCatalogAdminHandlers = ({ executeQuery, tables, logger, sendJson, readJsonBody, parseCookies, getCookieValuesFromRequest, appendSetCookie, buildCookieString, sanitizeText, normalizeGoogleSubject, normalizeEmail, normalizeJid, toIsoOrNull, toWhatsAppPhoneDigits, mapGoogleSessionResponseData, resolveGoogleWebSessionFromRequest, revokeGoogleWebSessionsByIdentity, getMarketplaceGlobalStatsCached, getSystemSummaryCached, getFeatureFlagsSnapshot, refreshFeatureFlags, listAdminBans, createAdminBanRecord, revokeAdminBanRecord, normalizeVisitPath, stickerWebPath, findStickerPackByPackKey, stickerPackService, buildManagedPackResponseData, sendManagedMutationStatus, sendManagedPackMutationStatus, deleteManagedPackWithCleanup, mapStickerPackWebManageError, cleanupOrphanStickerAssets, invalidateStickerCatalogDerivedCaches }) => {
  const TABLES = tables;
  const STICKER_WEB_PATH = String(stickerWebPath || '/stickers').trim() || '/stickers';

  const ADMIN_PANEL_EMAIL = String(process.env.ADM_EMAIL || '')
    .trim()
    .toLowerCase();
  const ADMIN_PANEL_PASSWORD = String(process.env.ADM_PANEL_PASSWORD || process.env.ADM_PANEL || '').trim();
  const ADMIN_PANEL_ENABLED = Boolean(ADMIN_PANEL_EMAIL && ADMIN_PANEL_PASSWORD);
  const ADMIN_PANEL_SESSION_TTL_MS = Math.max(10 * 60 * 1000, Number(process.env.ADM_PANEL_SESSION_TTL_MS) || 12 * 60 * 60 * 1000);
  const ADMIN_MODERATOR_PASSWORD_MIN_LENGTH = Math.max(6, Number(process.env.ADM_MODERATOR_PASSWORD_MIN_LENGTH) || 8);
  const ADMIN_PANEL_SESSION_COOKIE_NAME = 'omnizap_admin_panel_session';
  const SYSTEM_ADMIN_GRAFANA_TIME_FROM = sanitizeText(process.env.SYSTEM_ADMIN_GRAFANA_TIME_FROM || 'now-6h', 40, { allowEmpty: true }) || 'now-6h';
  const SYSTEM_ADMIN_GRAFANA_TIME_TO = sanitizeText(process.env.SYSTEM_ADMIN_GRAFANA_TIME_TO || 'now', 40, { allowEmpty: true }) || 'now';
  const SYSTEM_ADMIN_GRAFANA_REFRESH = sanitizeText(process.env.SYSTEM_ADMIN_GRAFANA_REFRESH || '10s', 20, { allowEmpty: true }) || '10s';

  const normalizeGrafanaBaseUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      const normalizedPathname = String(parsed.pathname || '/').replace(/\/+$/, '');
      parsed.search = '';
      parsed.hash = '';
      return `${parsed.origin}${normalizedPathname === '/' ? '' : normalizedPathname}`;
    } catch {
      return '';
    }
  };

  const normalizeGrafanaUid = (value) =>
    String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 120);

  const slugifyGrafanaDashboard = (value) => {
    const raw = String(value || '')
      .trim()
      .toLowerCase();
    const slug = raw
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90);
    return slug || 'dashboard';
  };

  const parseGrafanaDashboardDefinitions = () => {
    const raw = String(process.env.SYSTEM_ADMIN_GRAFANA_DASHBOARDS || '')
      .split(',')
      .map((item) => String(item || '').trim())
      .filter(Boolean);

    const parsed = raw
      .map((entry) => {
        const [uidPart, ...titleParts] = entry.split('|');
        const uid = normalizeGrafanaUid(uidPart);
        const title = sanitizeText(titleParts.join('|') || '', 90, { allowEmpty: true }) || '';
        return uid ? { uid, title } : null;
      })
      .filter(Boolean);

    if (parsed.length) return parsed;

    return [
      { uid: 'omnizap-system-admin', title: 'System Admin' },
      { uid: 'omnizap-overview', title: 'Overview' },
      { uid: 'omnizap-mysql', title: 'MySQL' },
    ];
  };

  const buildAdminGrafanaObservabilityLinks = () => {
    const baseUrl = normalizeGrafanaBaseUrl(process.env.SYSTEM_ADMIN_GRAFANA_URL || process.env.GRAFANA_PUBLIC_URL || '');
    if (!baseUrl) {
      return {
        enabled: false,
        base_url: null,
        dashboards: [],
      };
    }

    const base = new URL(`${baseUrl}/`);
    const definitions = parseGrafanaDashboardDefinitions();

    const dashboards = definitions
      .map((entry, index) => {
        const uid = normalizeGrafanaUid(entry?.uid || '');
        if (!uid) return null;
        const title = sanitizeText(entry?.title || '', 90, { allowEmpty: true }) || `Dashboard ${index + 1}`;
        const slug = slugifyGrafanaDashboard(title || uid);
        const viewUrl = new URL(`d/${encodeURIComponent(uid)}/${encodeURIComponent(slug)}`, base);
        viewUrl.searchParams.set('orgId', '1');
        viewUrl.searchParams.set('from', SYSTEM_ADMIN_GRAFANA_TIME_FROM);
        viewUrl.searchParams.set('to', SYSTEM_ADMIN_GRAFANA_TIME_TO);
        viewUrl.searchParams.set('refresh', SYSTEM_ADMIN_GRAFANA_REFRESH);

        const embedUrl = new URL(String(viewUrl));
        embedUrl.searchParams.set('kiosk', 'tv');

        return {
          uid,
          title,
          view_url: viewUrl.toString(),
          embed_url: embedUrl.toString(),
        };
      })
      .filter(Boolean);

    return {
      enabled: dashboards.length > 0,
      base_url: baseUrl,
      dashboards,
    };
  };
  const grafanaObservabilityLinks = buildAdminGrafanaObservabilityLinks();

  const adminPanelSessionMap = new Map();
  let adminPanelSessionPruneAt = 0;

  const constantTimeStringEqual = (a, b) => {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (left.length !== right.length) return false;
    try {
      return timingSafeEqual(left, right);
    } catch {
      return false;
    }
  };
  const normalizeAdminPanelRole = (value, fallback = 'owner') => {
    const normalized = String(value || '')
      .trim()
      .toLowerCase();
    if (normalized === 'moderator') return 'moderator';
    if (normalized === 'owner') return 'owner';
    return fallback;
  };
  const hashAdminModeratorPassword = (password) => {
    const normalized = String(password || '');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(normalized, salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
  };
  const verifyAdminModeratorPassword = (password, encodedHash) => {
    const raw = String(encodedHash || '').trim();
    if (!raw) return false;
    const parts = raw.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = String(parts[1] || '').trim();
    const expectedHex = String(parts[2] || '').trim();
    if (!salt || !expectedHex) return false;
    let expectedBuffer;
    try {
      expectedBuffer = Buffer.from(expectedHex, 'hex');
    } catch {
      return false;
    }
    if (!expectedBuffer.length) return false;
    const derived = scryptSync(String(password || ''), salt, expectedBuffer.length);
    try {
      return timingSafeEqual(expectedBuffer, derived);
    } catch {
      return false;
    }
  };
  const mapAdminModeratorRow = (row) => {
    if (!row || typeof row !== 'object') return null;
    return {
      google_sub: normalizeGoogleSubject(row.google_sub),
      email: normalizeEmail(row.email),
      owner_jid: normalizeJid(row.owner_jid) || null,
      name: sanitizeText(row.name || '', 120, { allowEmpty: true }) || null,
      created_by_google_sub: normalizeGoogleSubject(row.created_by_google_sub),
      created_by_email: normalizeEmail(row.created_by_email),
      updated_by_google_sub: normalizeGoogleSubject(row.updated_by_google_sub),
      updated_by_email: normalizeEmail(row.updated_by_email),
      last_login_at: toIsoOrNull(row.last_login_at),
      created_at: toIsoOrNull(row.created_at),
      updated_at: toIsoOrNull(row.updated_at),
      revoked_at: toIsoOrNull(row.revoked_at),
      active: !row.revoked_at,
    };
  };

  const listAdminModerators = async ({ activeOnly = false, limit = 200 } = {}) => {
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 200)));
    const rows = await executeQuery(
      `SELECT google_sub, email, owner_jid, name, created_by_google_sub, created_by_email, updated_by_google_sub, updated_by_email,
            last_login_at, created_at, updated_at, revoked_at
       FROM ${TABLES.STICKER_WEB_ADMIN_MODERATOR}
      ${activeOnly ? 'WHERE revoked_at IS NULL' : ''}
      ORDER BY updated_at DESC
      LIMIT ${safeLimit}`,
    );
    return (Array.isArray(rows) ? rows : []).map(mapAdminModeratorRow).filter(Boolean);
  };

  const findAdminModeratorByGoogleSub = async (googleSub, { activeOnly = false } = {}) => {
    const normalizedSub = normalizeGoogleSubject(googleSub);
    if (!normalizedSub) return null;
    const rows = await executeQuery(
      `SELECT *
       FROM ${TABLES.STICKER_WEB_ADMIN_MODERATOR}
      WHERE google_sub = ?
      ${activeOnly ? 'AND revoked_at IS NULL' : ''}
      LIMIT 1`,
      [normalizedSub],
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  };

  const resolveKnownGoogleUserForModerator = async ({ googleSub = '', email = '', ownerJid = '' } = {}) => {
    const normalizedSub = normalizeGoogleSubject(googleSub);
    const normalizedEmail = normalizeEmail(email);
    const normalizedOwnerJid = normalizeJid(ownerJid) || '';
    const clauses = [];
    const params = [];

    if (normalizedSub) {
      clauses.push('google_sub = ?');
      params.push(normalizedSub);
    }
    if (normalizedEmail) {
      clauses.push('email = ?');
      params.push(normalizedEmail);
    }
    if (normalizedOwnerJid) {
      clauses.push('owner_jid = ?');
      params.push(normalizedOwnerJid);
    }
    if (!clauses.length) return null;

    const rows = await executeQuery(
      `SELECT google_sub, email, owner_jid, name
       FROM ${TABLES.STICKER_WEB_GOOGLE_USER}
      WHERE ${clauses.join(' OR ')}
      ORDER BY COALESCE(last_seen_at, last_login_at, updated_at, created_at) DESC
      LIMIT 1`,
      params,
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    const resolvedGoogleSub = normalizeGoogleSubject(row.google_sub);
    const resolvedEmail = normalizeEmail(row.email);
    const resolvedOwnerJid = normalizeJid(row.owner_jid) || '';
    if (!resolvedGoogleSub || !resolvedEmail || !resolvedOwnerJid) return null;
    return {
      google_sub: resolvedGoogleSub,
      email: resolvedEmail,
      owner_jid: resolvedOwnerJid,
      name: sanitizeText(row.name || '', 120, { allowEmpty: true }) || null,
    };
  };

  const findActiveAdminModeratorForIdentity = async ({ googleSub = '', email = '', ownerJid = '' } = {}) => {
    const normalizedSub = normalizeGoogleSubject(googleSub);
    const normalizedEmail = normalizeEmail(email);
    const normalizedOwnerJid = normalizeJid(ownerJid) || '';
    const clauses = [];
    const params = [];
    if (normalizedSub) {
      clauses.push('google_sub = ?');
      params.push(normalizedSub);
    }
    if (normalizedEmail) {
      clauses.push('email = ?');
      params.push(normalizedEmail);
    }
    if (normalizedOwnerJid) {
      clauses.push('owner_jid = ?');
      params.push(normalizedOwnerJid);
    }
    if (!clauses.length) return null;

    const rows = await executeQuery(
      `SELECT *
       FROM ${TABLES.STICKER_WEB_ADMIN_MODERATOR}
      WHERE revoked_at IS NULL
        AND (${clauses.join(' OR ')})
      ORDER BY updated_at DESC
      LIMIT 1`,
      params,
    );
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  };

  const pruneModeratorAdminPanelSessions = ({ googleSub = '', email = '', ownerJid = '' } = {}) => {
    const normalizedSub = normalizeGoogleSubject(googleSub);
    const normalizedEmail = normalizeEmail(email);
    const normalizedOwnerJid = normalizeJid(ownerJid) || '';
    if (!normalizedSub && !normalizedEmail && !normalizedOwnerJid) return;

    for (const [token, session] of adminPanelSessionMap.entries()) {
      if (!session || normalizeAdminPanelRole(session.role, 'owner') !== 'moderator') continue;
      const sessionSub = normalizeGoogleSubject(session.googleSub);
      const sessionEmail = normalizeEmail(session.email);
      const sessionOwner = normalizeJid(session.ownerJid) || '';
      if ((normalizedSub && sessionSub === normalizedSub) || (normalizedEmail && sessionEmail === normalizedEmail) || (normalizedOwnerJid && sessionOwner === normalizedOwnerJid)) {
        adminPanelSessionMap.delete(token);
      }
    }
  };

  const upsertAdminModeratorRecord = async ({ googleSub = '', email = '', ownerJid = '', password = '', adminSession = null }) => {
    const cleanPassword = String(password || '').trim();
    if (cleanPassword.length < ADMIN_MODERATOR_PASSWORD_MIN_LENGTH) {
      const error = new Error(`Senha do moderador deve ter no minimo ${ADMIN_MODERATOR_PASSWORD_MIN_LENGTH} caracteres.`);
      error.statusCode = 400;
      throw error;
    }

    const knownUser = await resolveKnownGoogleUserForModerator({ googleSub, email, ownerJid });
    if (!knownUser?.google_sub) {
      const error = new Error('Somente usuarios Google logados no site podem virar moderadores.');
      error.statusCode = 400;
      throw error;
    }

    const existing = await findAdminModeratorByGoogleSub(knownUser.google_sub);
    const passwordHash = hashAdminModeratorPassword(cleanPassword);
    await executeQuery(
      `INSERT INTO ${TABLES.STICKER_WEB_ADMIN_MODERATOR}
      (google_sub, email, owner_jid, name, password_hash, created_by_google_sub, created_by_email, updated_by_google_sub, updated_by_email, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
      email = VALUES(email),
      owner_jid = VALUES(owner_jid),
      name = VALUES(name),
      password_hash = VALUES(password_hash),
      updated_by_google_sub = VALUES(updated_by_google_sub),
      updated_by_email = VALUES(updated_by_email),
      revoked_at = NULL`,
      [knownUser.google_sub, knownUser.email, knownUser.owner_jid, knownUser.name || null, passwordHash, normalizeGoogleSubject(adminSession?.googleSub) || null, normalizeEmail(adminSession?.email) || null, normalizeGoogleSubject(adminSession?.googleSub) || null, normalizeEmail(adminSession?.email) || null],
    );

    pruneModeratorAdminPanelSessions({
      googleSub: knownUser.google_sub,
      email: knownUser.email,
      ownerJid: knownUser.owner_jid,
    });

    const fresh = await findAdminModeratorByGoogleSub(knownUser.google_sub);
    return {
      created: !existing,
      moderator: mapAdminModeratorRow(fresh),
    };
  };

  const revokeAdminModeratorRecord = async (googleSub, adminSession = null) => {
    const normalizedSub = normalizeGoogleSubject(googleSub);
    if (!normalizedSub) {
      const error = new Error('google_sub invalido.');
      error.statusCode = 400;
      throw error;
    }

    await executeQuery(
      `UPDATE ${TABLES.STICKER_WEB_ADMIN_MODERATOR}
        SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()),
            updated_by_google_sub = ?,
            updated_by_email = ?
      WHERE google_sub = ?`,
      [normalizeGoogleSubject(adminSession?.googleSub) || null, normalizeEmail(adminSession?.email) || null, normalizedSub],
    );

    const fresh = await findAdminModeratorByGoogleSub(normalizedSub);
    if (!fresh) {
      const error = new Error('Moderador nao encontrado.');
      error.statusCode = 404;
      throw error;
    }

    pruneModeratorAdminPanelSessions({
      googleSub: normalizedSub,
      email: normalizeEmail(fresh.email),
      ownerJid: normalizeJid(fresh.owner_jid) || '',
    });

    return mapAdminModeratorRow(fresh);
  };

  const touchAdminModeratorLastLogin = async (moderatorRow, googleSession) => {
    const normalizedSub = normalizeGoogleSubject(moderatorRow?.google_sub || googleSession?.sub);
    if (!normalizedSub) return;
    await executeQuery(
      `UPDATE ${TABLES.STICKER_WEB_ADMIN_MODERATOR}
        SET email = ?,
            owner_jid = ?,
            name = ?,
            last_login_at = UTC_TIMESTAMP(),
            updated_by_google_sub = ?,
            updated_by_email = ?
      WHERE google_sub = ?`,
      [normalizeEmail(googleSession?.email || moderatorRow?.email) || null, normalizeJid(googleSession?.ownerJid || moderatorRow?.owner_jid) || null, sanitizeText(googleSession?.name || moderatorRow?.name || '', 120, { allowEmpty: true }) || null, normalizeGoogleSubject(googleSession?.sub || moderatorRow?.google_sub) || null, normalizeEmail(googleSession?.email || moderatorRow?.email) || null, normalizedSub],
    ).catch(() => {});
  };

  const pruneExpiredAdminPanelSessions = () => {
    const now = __timeNowMs();
    if (now - adminPanelSessionPruneAt < 30_000) return;
    adminPanelSessionPruneAt = now;
    for (const [token, session] of adminPanelSessionMap.entries()) {
      if (!session || Number(session.expiresAt || 0) <= now) {
        adminPanelSessionMap.delete(token);
      }
    }
  };

  const getAdminPanelSessionTokenFromRequest = (req) => {
    const direct = getCookieValuesFromRequest(req, ADMIN_PANEL_SESSION_COOKIE_NAME);
    if (direct.length > 0) return direct[0];
    const cookies = parseCookies(req);
    return String(cookies[ADMIN_PANEL_SESSION_COOKIE_NAME] || '').trim();
  };

  const clearAdminPanelSessionCookie = (req, res) => {
    appendSetCookie(
      res,
      buildCookieString(ADMIN_PANEL_SESSION_COOKIE_NAME, '', req, {
        maxAgeSeconds: 0,
      }),
    );
    // Also clear host-only variant (legacy cookie written without Domain).
    appendSetCookie(
      res,
      buildCookieString(ADMIN_PANEL_SESSION_COOKIE_NAME, '', req, {
        maxAgeSeconds: 0,
        domain: false,
      }),
    );
  };

  const createAdminPanelSession = (googleSession, { role = 'owner' } = {}) => {
    pruneExpiredAdminPanelSessions();
    const now = __timeNowMs();
    const normalizedRole = normalizeAdminPanelRole(role, 'owner');
    const token = randomUUID();
    const session = {
      token,
      role: normalizedRole,
      googleSub: normalizeGoogleSubject(googleSession?.sub),
      ownerJid: normalizeJid(googleSession?.ownerJid) || '',
      email: normalizeEmail(googleSession?.email),
      name: sanitizeText(googleSession?.name || '', 120, { allowEmpty: true }) || 'Administrador',
      picture: String(googleSession?.picture || '').trim() || '',
      createdAt: now,
      expiresAt: now + ADMIN_PANEL_SESSION_TTL_MS,
    };
    adminPanelSessionMap.set(token, session);
    return session;
  };

  const resolveAdminPanelSessionFromRequest = (req) => {
    if (!ADMIN_PANEL_ENABLED) return null;
    pruneExpiredAdminPanelSessions();
    const token = getAdminPanelSessionTokenFromRequest(req);
    if (!token) return null;
    const session = adminPanelSessionMap.get(token);
    if (!session) return null;
    if (Number(session.expiresAt || 0) <= __timeNowMs()) {
      adminPanelSessionMap.delete(token);
      return null;
    }
    return session;
  };

  const mapAdminPanelSessionResponseData = (session) =>
    session
      ? {
          authenticated: true,
          role: normalizeAdminPanelRole(session.role, 'owner'),
          capabilities: {
            can_manage_moderators: normalizeAdminPanelRole(session.role, 'owner') === 'owner',
          },
          user: {
            google_sub: session.googleSub,
            owner_jid: session.ownerJid,
            email: session.email,
            name: session.name,
            picture: session.picture || null,
          },
          expires_at: toIsoOrNull(session.expiresAt),
        }
      : {
          authenticated: false,
          role: null,
          capabilities: {
            can_manage_moderators: false,
          },
          user: null,
          expires_at: null,
        };

  const isOwnerGoogleSessionAllowed = (googleSession) => {
    if (!ADMIN_PANEL_ENABLED) return false;
    if (!googleSession?.sub || !googleSession?.ownerJid) return false;
    const email = normalizeEmail(googleSession.email);
    return Boolean(email && email === ADMIN_PANEL_EMAIL);
  };

  const resolveAdminPanelLoginEligibility = async (googleSession) => {
    if (!ADMIN_PANEL_ENABLED || !googleSession?.sub || !googleSession?.ownerJid) {
      return { eligible: false, role: '', moderator: null };
    }
    if (isOwnerGoogleSessionAllowed(googleSession)) {
      return { eligible: true, role: 'owner', moderator: null };
    }
    const moderator = await findActiveAdminModeratorForIdentity({
      googleSub: googleSession.sub,
      email: googleSession.email,
      ownerJid: googleSession.ownerJid,
    });
    if (!moderator) return { eligible: false, role: '', moderator: null };
    return { eligible: true, role: 'moderator', moderator };
  };

  const requireAdminPanelSession = (req, res) => {
    if (!ADMIN_PANEL_ENABLED) {
      sendJson(req, res, 404, { error: 'Painel admin desabilitado.' });
      return null;
    }
    const session = resolveAdminPanelSessionFromRequest(req);
    if (!session) {
      sendJson(req, res, 401, { error: 'Sessao admin invalida ou expirada.' });
      return null;
    }
    return session;
  };

  const requireOwnerAdminPanelSession = (req, res) => {
    const session = requireAdminPanelSession(req, res);
    if (!session) return null;
    if (normalizeAdminPanelRole(session.role, 'owner') !== 'owner') {
      sendJson(req, res, 403, { error: 'Somente o dono pode gerenciar moderadores.' });
      return null;
    }
    return session;
  };
  const safeParseJsonObject = (value) => {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
      const parsed = JSON.parse(String(value));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const sanitizeAuditActionText = (value, max = 96) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_:-]/g, '_')
      .slice(0, max);

  const createAdminActionAuditEvent = async ({ adminSession = null, action = '', targetType = '', targetId = '', status = 'success', details = null } = {}) => {
    const normalizedAction = sanitizeAuditActionText(action, 96);
    if (!normalizedAction) return false;
    const normalizedTargetType = sanitizeAuditActionText(targetType, 64) || null;
    const normalizedStatus = sanitizeAuditActionText(status, 32) || 'success';
    const detailsJson = details && typeof details === 'object' ? JSON.stringify(details) : null;
    const adminRole = normalizeAdminPanelRole(adminSession?.role, 'owner');
    const adminGoogleSub = normalizeGoogleSubject(adminSession?.googleSub) || null;
    const adminEmail = normalizeEmail(adminSession?.email) || null;
    const adminOwnerJid = normalizeJid(adminSession?.ownerJid) || null;

    try {
      await executeQuery(
        `INSERT INTO ${TABLES.ADMIN_ACTION_AUDIT}
        (
          id,
          admin_role,
          admin_google_sub,
          admin_email,
          admin_owner_jid,
          action,
          target_type,
          target_id,
          status,
          details
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), adminRole, adminGoogleSub, adminEmail, adminOwnerJid, normalizedAction, normalizedTargetType, sanitizeText(targetId || '', 255, { allowEmpty: true }) || null, normalizedStatus, detailsJson],
      );
      return true;
    } catch (error) {
      if (error?.code === 'ER_NO_SUCH_TABLE') return false;
      logger.warn('Falha ao registrar auditoria admin.', {
        action: 'admin_audit_insert_failed',
        error: error?.message,
        audit_action: normalizedAction,
      });
      return false;
    }
  };

  const listAdminAuditLog = async ({ limit = 80 } = {}) => {
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 80)));
    try {
      const rows = await executeQuery(
        `SELECT
          id,
          admin_role,
          admin_google_sub,
          admin_email,
          admin_owner_jid,
          action,
          target_type,
          target_id,
          status,
          details,
          created_at
       FROM ${TABLES.ADMIN_ACTION_AUDIT}
       ORDER BY created_at DESC
       LIMIT ${safeLimit}`,
      );

      return (Array.isArray(rows) ? rows : []).map((row) => ({
        id: String(row?.id || '').trim(),
        admin_role: normalizeAdminPanelRole(row?.admin_role, 'owner'),
        admin_google_sub: normalizeGoogleSubject(row?.admin_google_sub),
        admin_email: normalizeEmail(row?.admin_email) || null,
        admin_owner_jid: normalizeJid(row?.admin_owner_jid) || null,
        action: String(row?.action || '').trim(),
        target_type: String(row?.target_type || '').trim() || null,
        target_id: String(row?.target_id || '').trim() || null,
        status: String(row?.status || '').trim() || 'success',
        details: safeParseJsonObject(row?.details),
        created_at: toIsoOrNull(row?.created_at),
      }));
    } catch (error) {
      if (error?.code === 'ER_NO_SUCH_TABLE') return [];
      throw error;
    }
  };

  const listAdminFeatureFlagsDetailed = async ({ limit = 300 } = {}) => {
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 300)));
    try {
      const rows = await executeQuery(
        `SELECT
          flag_name,
          is_enabled,
          rollout_percent,
          description,
          updated_by,
          updated_at
       FROM ${TABLES.FEATURE_FLAG}
       ORDER BY flag_name ASC
       LIMIT ${safeLimit}`,
      );
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        flag_name: sanitizeText(row?.flag_name || '', 120, { allowEmpty: false }) || '',
        is_enabled: Number(row?.is_enabled || 0) === 1,
        rollout_percent: Math.max(0, Math.min(100, Number(row?.rollout_percent || 0))),
        description: sanitizeText(row?.description || '', 255, { allowEmpty: true }) || null,
        updated_by: sanitizeText(row?.updated_by || '', 120, { allowEmpty: true }) || null,
        updated_at: toIsoOrNull(row?.updated_at),
      }));
    } catch (error) {
      if (error?.code === 'ER_NO_SUCH_TABLE') {
        const fallback = await getFeatureFlagsSnapshot().catch(() => []);
        return (Array.isArray(fallback) ? fallback : []).map((entry) => ({
          flag_name: sanitizeText(entry?.flag_name || '', 120, { allowEmpty: false }) || '',
          is_enabled: Boolean(entry?.is_enabled),
          rollout_percent: Math.max(0, Math.min(100, Number(entry?.rollout_percent || 0))),
          description: null,
          updated_by: null,
          updated_at: null,
        }));
      }
      throw error;
    }
  };

  const upsertAdminFeatureFlagRecord = async ({ adminSession = null, flagName = '', isEnabled = false, rolloutPercent = 100, description = '' } = {}) => {
    const normalizedFlagName = sanitizeAuditActionText(flagName, 120);
    if (!normalizedFlagName) {
      const error = new Error('flag_name invalido.');
      error.statusCode = 400;
      throw error;
    }
    const normalizedRollout = Math.max(0, Math.min(100, Math.floor(Number(rolloutPercent) || 0)));
    const normalizedEnabled = isEnabled ? 1 : 0;
    const normalizedDescription = sanitizeText(description || '', 255, { allowEmpty: true }) || null;
    const updatedBy = normalizeEmail(adminSession?.email) || normalizeGoogleSubject(adminSession?.googleSub) || 'admin';

    await executeQuery(
      `INSERT INTO ${TABLES.FEATURE_FLAG}
      (flag_name, is_enabled, rollout_percent, description, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      is_enabled = VALUES(is_enabled),
      rollout_percent = VALUES(rollout_percent),
      description = COALESCE(VALUES(description), description),
      updated_by = VALUES(updated_by),
      updated_at = CURRENT_TIMESTAMP`,
      [normalizedFlagName, normalizedEnabled, normalizedRollout, normalizedDescription, sanitizeText(updatedBy, 120, { allowEmpty: true }) || null],
    );

    await refreshFeatureFlags({ force: true }).catch(() => {});
    const rows = await executeQuery(
      `SELECT flag_name, is_enabled, rollout_percent, description, updated_by, updated_at
       FROM ${TABLES.FEATURE_FLAG}
      WHERE flag_name = ?
      LIMIT 1`,
      [normalizedFlagName],
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return {
      flag_name: sanitizeText(row?.flag_name || normalizedFlagName, 120, { allowEmpty: false }) || normalizedFlagName,
      is_enabled: Number(row?.is_enabled || 0) === 1,
      rollout_percent: Math.max(0, Math.min(100, Number(row?.rollout_percent ?? normalizedRollout))),
      description: sanitizeText(row?.description || '', 255, { allowEmpty: true }) || null,
      updated_by: sanitizeText(row?.updated_by || '', 120, { allowEmpty: true }) || null,
      updated_at: toIsoOrNull(row?.updated_at) || __timeNowIso(),
    };
  };

  const getAdminMessageFlowDailyStats = async () => {
    try {
      const [row] = await executeQuery(
        `SELECT
         COUNT(*) AS messages_today,
         SUM(CASE WHEN processing_result = 'blocked_antilink' THEN 1 ELSE 0 END) AS spam_blocked_today,
         SUM(CASE WHEN processing_result = 'auth_required' THEN 1 ELSE 0 END) AS suspicious_today
       FROM ${TABLES.MESSAGE_ANALYSIS_EVENT}
       WHERE created_at >= UTC_DATE()`,
      );
      return {
        messages_today: Number(row?.messages_today || 0),
        spam_blocked_today: Number(row?.spam_blocked_today || 0),
        suspicious_today: Number(row?.suspicious_today || 0),
        available: true,
      };
    } catch (error) {
      if (error?.code === 'ER_NO_SUCH_TABLE') {
        return {
          messages_today: null,
          spam_blocked_today: null,
          suspicious_today: null,
          available: false,
        };
      }
      throw error;
    }
  };

  const listRecentModerationEvents = async ({ limit = 40 } = {}) => {
    const safeLimit = Math.max(1, Math.min(200, Number(limit || 40)));
    try {
      const rows = await executeQuery(
        `SELECT
          id,
          message_id,
          chat_id,
          sender_id,
          sender_name,
          processing_result,
          command_name,
          error_code,
          metadata,
          created_at
       FROM ${TABLES.MESSAGE_ANALYSIS_EVENT}
       WHERE processing_result IN ('blocked_antilink', 'auth_required')
       ORDER BY created_at DESC
       LIMIT ${safeLimit}`,
      );

      return (Array.isArray(rows) ? rows : []).map((row) => {
        const processingResult = String(row?.processing_result || '')
          .trim()
          .toLowerCase();
        const metadata = safeParseJsonObject(row?.metadata);
        const isAntiLink = processingResult === 'blocked_antilink';
        const title = isAntiLink ? 'Anti-link bloqueou mensagem' : 'Tentativa suspeita detectada';
        const severity = isAntiLink ? 'medium' : 'high';
        const sender = sanitizeText(row?.sender_name || row?.sender_id || '', 120, { allowEmpty: true }) || String(row?.sender_id || '').trim() || 'desconhecido';
        const chatId = String(row?.chat_id || '').trim() || 'chat_desconhecido';
        return {
          id: `mae:${row?.id || ''}`,
          event_type: isAntiLink ? 'anti_link' : 'suspicious',
          severity,
          title,
          subtitle: `${sender} em ${chatId}`,
          chat_id: chatId,
          sender_id: String(row?.sender_id || '').trim() || null,
          sender_name: sanitizeText(row?.sender_name || '', 120, { allowEmpty: true }) || null,
          message_id: String(row?.message_id || '').trim() || null,
          processing_result: processingResult,
          command_name: sanitizeText(row?.command_name || '', 64, { allowEmpty: true }) || null,
          error_code: sanitizeText(row?.error_code || '', 96, { allowEmpty: true }) || null,
          metadata,
          created_at: toIsoOrNull(row?.created_at),
        };
      });
    } catch (error) {
      if (error?.code === 'ER_NO_SUCH_TABLE') return [];
      throw error;
    }
  };

  const buildModerationQueueSnapshot = async ({ limit = 50 } = {}) => {
    const [analysisEvents, bans] = await Promise.all([listRecentModerationEvents({ limit: Math.max(10, limit) }), listAdminBans({ activeOnly: false, limit: Math.max(10, Math.floor(limit / 2)) })]);

    const banEvents = (Array.isArray(bans) ? bans : []).map((ban) => ({
      id: `ban:${ban?.id || ''}`,
      event_type: 'ban',
      severity: ban?.revoked_at ? 'low' : 'critical',
      title: ban?.revoked_at ? 'Ban revogado' : 'Conta bloqueada',
      subtitle:
        sanitizeText(ban?.email || ban?.owner_jid || ban?.google_sub || '', 160, {
          allowEmpty: true,
        }) || 'identidade indisponivel',
      ban_id: String(ban?.id || '').trim(),
      reason: sanitizeText(ban?.reason || '', 255, { allowEmpty: true }) || null,
      created_at: toIsoOrNull(ban?.created_at),
      revoked_at: toIsoOrNull(ban?.revoked_at),
      metadata: {
        google_sub: ban?.google_sub || null,
        email: ban?.email || null,
        owner_jid: ban?.owner_jid || null,
      },
    }));

    const combined = [...(Array.isArray(analysisEvents) ? analysisEvents : []), ...banEvents];
    combined.sort((left, right) => {
      const leftTs = Date.parse(String(left?.created_at || left?.revoked_at || 0)) || 0;
      const rightTs = Date.parse(String(right?.created_at || right?.revoked_at || 0)) || 0;
      return rightTs - leftTs;
    });
    return combined.slice(0, Math.max(1, Math.min(200, Number(limit || 50))));
  };

  const buildAdminSystemHealthSnapshot = ({ systemSummary = null, systemMeta = null } = {}) => {
    const hostCpu = Number(systemSummary?.host?.cpu_percent);
    const hostRam = Number(systemSummary?.host?.memory_percent);
    const latencyP95 = Number(systemSummary?.observability?.http_latency_p95_ms);
    const queuePending = Number(systemSummary?.observability?.queue_peak);
    const hasMetricsError = Boolean(systemMeta?.metrics_error);
    const hasPlatformError = Boolean(systemMeta?.platform_error);
    const dbStatus = hasPlatformError ? 'degraded' : hasMetricsError ? 'unknown' : 'ok';

    return {
      cpu_percent: Number.isFinite(hostCpu) ? hostCpu : null,
      ram_percent: Number.isFinite(hostRam) ? hostRam : null,
      http_latency_p95_ms: Number.isFinite(latencyP95) ? latencyP95 : null,
      queue_pending: Number.isFinite(queuePending) ? queuePending : null,
      db_status: dbStatus,
      db_total_queries: Number(systemSummary?.observability?.db_total ?? 0) || 0,
      db_slow_queries: Number(systemSummary?.observability?.db_slow ?? 0) || 0,
      bot_status: String(systemSummary?.bot?.connection_status || '').trim() || 'unknown',
      updated_at: toIsoOrNull(systemSummary?.updated_at),
    };
  };

  const buildAdminAlertSnapshot = ({ dashboardQuick = null, systemHealth = null, systemSummary = null, systemMeta = null } = {}) => {
    const alerts = [];
    const updatedAt = toIsoOrNull(systemSummary?.updated_at) || __timeNowIso();
    const pushAlert = (severity, code, title, message) => {
      alerts.push({
        id: `${code}:${severity}`,
        severity,
        code,
        title,
        message,
        created_at: updatedAt,
      });
    };

    const botStatus = String(systemSummary?.bot?.connection_status || '').toLowerCase();
    if (botStatus && botStatus !== 'online') {
      pushAlert('critical', 'bot_offline', 'Bot fora do ar', `Status atual: ${botStatus}.`);
    }

    if (Number.isFinite(systemHealth?.cpu_percent) && systemHealth.cpu_percent >= 90) {
      pushAlert('high', 'cpu_high', 'CPU alta', `Uso de CPU em ${systemHealth.cpu_percent.toFixed(1)}%.`);
    }
    if (Number.isFinite(systemHealth?.ram_percent) && systemHealth.ram_percent >= 90) {
      pushAlert('high', 'ram_high', 'RAM alta', `Uso de RAM em ${systemHealth.ram_percent.toFixed(1)}%.`);
    }
    if (Number.isFinite(systemHealth?.queue_pending) && systemHealth.queue_pending >= 100) {
      pushAlert('medium', 'queue_high', 'Fila pendente alta', `Backlog detectado (${Math.round(systemHealth.queue_pending)}).`);
    }
    if (Number.isFinite(dashboardQuick?.errors_5xx) && dashboardQuick.errors_5xx > 0) {
      pushAlert('medium', 'http_5xx', 'Erros HTTP 5xx detectados', `${Math.round(dashboardQuick.errors_5xx)} eventos 5xx desde o boot de métricas.`);
    }
    if (systemMeta?.platform_error) {
      pushAlert('high', 'db_platform_error', 'Erro de banco/plataforma', String(systemMeta.platform_error).slice(0, 200));
    }
    if (systemMeta?.metrics_error) {
      pushAlert('low', 'metrics_unavailable', 'Métricas indisponíveis', String(systemMeta.metrics_error).slice(0, 200));
    }

    return alerts;
  };

  const listAdminActiveGoogleWebSessions = async ({ limit = 200 } = {}) => {
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 200)));
    const rows = await executeQuery(
      `SELECT session_token, google_sub, owner_jid, owner_phone, email, name, picture_url, created_at, last_seen_at, expires_at
       FROM ${TABLES.STICKER_WEB_GOOGLE_SESSION}
      WHERE revoked_at IS NULL
        AND expires_at > UTC_TIMESTAMP()
      ORDER BY COALESCE(last_seen_at, created_at) DESC
      LIMIT ${safeLimit}`,
    );
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      session_token: String(row.session_token || '').trim(),
      google_sub: normalizeGoogleSubject(row.google_sub),
      owner_jid: normalizeJid(row.owner_jid) || null,
      owner_phone: toWhatsAppPhoneDigits(row.owner_phone || row.owner_jid) || null,
      email: normalizeEmail(row.email) || null,
      name: sanitizeText(row.name || '', 120, { allowEmpty: true }) || null,
      picture: String(row.picture_url || '').trim() || null,
      created_at: toIsoOrNull(row.created_at),
      last_seen_at: toIsoOrNull(row.last_seen_at),
      expires_at: toIsoOrNull(row.expires_at),
    }));
  };

  const listAdminKnownGoogleUsers = async ({ limit = 200 } = {}) => {
    const safeLimit = Math.max(1, Math.min(500, Number(limit || 200)));
    const rows = await executeQuery(
      `SELECT google_sub, owner_jid, owner_phone, email, name, picture_url, created_at, updated_at, last_login_at, last_seen_at
       FROM ${TABLES.STICKER_WEB_GOOGLE_USER}
      ORDER BY COALESCE(last_seen_at, last_login_at, updated_at, created_at) DESC
      LIMIT ${safeLimit}`,
    );
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      google_sub: normalizeGoogleSubject(row.google_sub),
      owner_jid: normalizeJid(row.owner_jid) || null,
      owner_phone: toWhatsAppPhoneDigits(row.owner_phone || row.owner_jid) || null,
      email: normalizeEmail(row.email) || null,
      name: sanitizeText(row.name || '', 120, { allowEmpty: true }) || null,
      picture: String(row.picture_url || '').trim() || null,
      created_at: toIsoOrNull(row.created_at),
      updated_at: toIsoOrNull(row.updated_at),
      last_login_at: toIsoOrNull(row.last_login_at),
      last_seen_at: toIsoOrNull(row.last_seen_at),
    }));
  };

  const getWebVisitSummary = async ({ rangeDays = 7, topPathsLimit = 10 } = {}) => {
    const safeRangeDays = Math.max(1, Math.min(90, Number(rangeDays || 7)));
    const safeTopPathsLimit = Math.max(1, Math.min(30, Number(topPathsLimit || 10)));

    try {
      const [countersRows, topPathsRows] = await Promise.all([
        executeQuery(
          `SELECT
            COUNT(*) AS total_events,
            SUM(CASE WHEN created_at >= (UTC_TIMESTAMP() - INTERVAL 1 DAY) THEN 1 ELSE 0 END) AS events_24h,
            SUM(CASE WHEN created_at >= (UTC_TIMESTAMP() - INTERVAL ${safeRangeDays} DAY) THEN 1 ELSE 0 END) AS events_range,
            COUNT(DISTINCT CASE WHEN created_at >= (UTC_TIMESTAMP() - INTERVAL ${safeRangeDays} DAY) THEN visitor_key END) AS unique_visitors_range,
            COUNT(DISTINCT CASE WHEN created_at >= (UTC_TIMESTAMP() - INTERVAL ${safeRangeDays} DAY) THEN session_key END) AS unique_sessions_range
         FROM ${TABLES.WEB_VISIT_EVENT}`,
        ),
        executeQuery(
          `SELECT page_path, COUNT(*) AS total
           FROM ${TABLES.WEB_VISIT_EVENT}
          WHERE created_at >= (UTC_TIMESTAMP() - INTERVAL ${safeRangeDays} DAY)
          GROUP BY page_path
          ORDER BY total DESC
          LIMIT ${safeTopPathsLimit}`,
        ),
      ]);

      const counters = Array.isArray(countersRows) ? countersRows[0] || {} : {};
      const topPaths = (Array.isArray(topPathsRows) ? topPathsRows : []).map((row) => ({
        page_path: normalizeVisitPath(row?.page_path || '/'),
        total: Number(row?.total || 0),
      }));

      return {
        range_days: safeRangeDays,
        total_events: Number(counters?.total_events || 0),
        events_24h: Number(counters?.events_24h || 0),
        events_range: Number(counters?.events_range || 0),
        unique_visitors_range: Number(counters?.unique_visitors_range || 0),
        unique_sessions_range: Number(counters?.unique_sessions_range || 0),
        top_paths: topPaths,
      };
    } catch (error) {
      if (error?.code === 'ER_NO_SUCH_TABLE') return null;
      throw error;
    }
  };

  const listAdminPacks = async (url) => {
    const q = sanitizeText(url?.searchParams?.get('q') || '', 120, { allowEmpty: true }) || '';
    const owner = normalizeJid(url?.searchParams?.get('owner_jid') || '') || '';
    const limit = Math.max(1, Math.min(200, Number(url?.searchParams?.get('limit') || 50)));
    const params = [];
    const where = ['p.deleted_at IS NULL'];
    if (q) {
      where.push('(p.pack_key LIKE ? OR p.name LIKE ? OR p.publisher LIKE ? OR p.owner_jid LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (owner) {
      where.push('p.owner_jid = ?');
      params.push(owner);
    }
    const rows = await executeQuery(
      `SELECT
        p.id,
        p.pack_key,
        p.owner_jid,
        p.name,
        p.publisher,
        p.visibility,
        p.status,
        p.pack_status,
        p.is_auto_pack,
        p.pack_theme_key,
        p.pack_volume,
        p.created_at,
        p.updated_at,
        p.cover_sticker_id,
        (SELECT COUNT(*) FROM ${TABLES.STICKER_PACK_ITEM} i WHERE i.pack_id = p.id) AS stickers_count,
        COALESCE(e.open_count, 0) AS open_count,
        COALESCE(e.like_count, 0) AS like_count,
        COALESCE(e.dislike_count, 0) AS dislike_count
       FROM ${TABLES.STICKER_PACK} p
       LEFT JOIN ${TABLES.STICKER_PACK_ENGAGEMENT} e ON e.pack_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY p.updated_at DESC
      LIMIT ${limit}`,
      params,
    );
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      id: String(row.id || ''),
      pack_key: String(row.pack_key || ''),
      owner_jid: normalizeJid(row.owner_jid) || null,
      name: String(row.name || ''),
      publisher: String(row.publisher || ''),
      visibility: String(row.visibility || ''),
      status: String(row.status || ''),
      pack_status: String(row.pack_status || 'ready'),
      is_auto_pack: Boolean(Number(row.is_auto_pack || 0)),
      pack_theme_key: String(row.pack_theme_key || '').trim() || null,
      pack_volume: Number.isFinite(Number(row.pack_volume)) ? Number(row.pack_volume) : null,
      created_at: toIsoOrNull(row.created_at),
      updated_at: toIsoOrNull(row.updated_at),
      cover_sticker_id: String(row.cover_sticker_id || '').trim() || null,
      stickers_count: Number(row.stickers_count || 0),
      open_count: Number(row.open_count || 0),
      like_count: Number(row.like_count || 0),
      dislike_count: Number(row.dislike_count || 0),
      web_url: `${STICKER_WEB_PATH}/${encodeURIComponent(String(row.pack_key || ''))}`,
    }));
  };

  const buildAdminOverviewPayload = async ({ adminSession = null } = {}) => {
    const [marketplaceStats, activeSessions, knownUsers, bans, packsCountRows, stickersCountRows, recentPacks, visitSummary, systemSummaryPayload, messageFlowDaily, moderationQueue, auditLog, featureFlags] = await Promise.all([
      getMarketplaceGlobalStatsCached().catch(() => null),
      listAdminActiveGoogleWebSessions({ limit: 80 }),
      listAdminKnownGoogleUsers({ limit: 120 }),
      listAdminBans({ activeOnly: true, limit: 120 }),
      executeQuery(`SELECT COUNT(*) AS total FROM ${TABLES.STICKER_PACK} WHERE deleted_at IS NULL`),
      executeQuery(`SELECT COUNT(*) AS total FROM ${TABLES.STICKER_ASSET}`),
      listAdminPacks({ searchParams: new URLSearchParams([['limit', '30']]) }),
      getWebVisitSummary({ rangeDays: 7, topPathsLimit: 10 }).catch(() => null),
      getSystemSummaryCached().catch(() => null),
      getAdminMessageFlowDailyStats().catch(() => ({
        messages_today: null,
        spam_blocked_today: null,
        suspicious_today: null,
        available: false,
      })),
      buildModerationQueueSnapshot({ limit: 80 }).catch(() => []),
      listAdminAuditLog({ limit: 120 }).catch(() => []),
      listAdminFeatureFlagsDetailed({ limit: 300 }).catch(() => []),
    ]);

    const systemSummary = systemSummaryPayload?.data || null;
    const systemMeta = systemSummaryPayload?.meta || null;
    const botsOnline = systemSummary?.bot?.connected ? 1 : 0;
    const errors5xx = Number(systemSummary?.observability?.http_5xx_total ?? 0);
    const dashboardQuick = {
      bots_online: botsOnline,
      messages_today: Number(messageFlowDaily?.messages_today ?? 0),
      spam_blocked_today: Number(messageFlowDaily?.spam_blocked_today ?? 0),
      uptime: String(systemSummary?.process?.uptime || '').trim() || 'n/d',
      errors_5xx: Number.isFinite(errors5xx) ? Math.max(0, errors5xx) : 0,
    };
    const systemHealth = buildAdminSystemHealthSnapshot({ systemSummary, systemMeta });
    const alerts = buildAdminAlertSnapshot({
      dashboardQuick,
      systemHealth,
      systemSummary,
      systemMeta,
    });

    const overviewPayload = {
      admin_session: mapAdminPanelSessionResponseData(adminSession),
      marketplace_stats: marketplaceStats,
      counters: {
        total_packs_any_status: Number(packsCountRows?.[0]?.total || 0),
        total_stickers_any_status: Number(stickersCountRows?.[0]?.total || 0),
        active_google_sessions: Number(activeSessions.length || 0),
        known_google_users: Number(knownUsers.length || 0),
        active_bans: Number(bans.length || 0),
        visit_events_24h: Number(visitSummary?.events_24h || 0),
        visit_events_7d: Number(visitSummary?.events_range || 0),
        unique_visitors_7d: Number(visitSummary?.unique_visitors_range || 0),
      },
      dashboard_quick: dashboardQuick,
      moderation_queue: moderationQueue,
      users_sessions: {
        active_sessions: activeSessions,
        users: knownUsers,
        blocked_accounts: bans,
      },
      system_health: systemHealth,
      audit_log: auditLog,
      feature_flags: featureFlags,
      alerts,
      operational_shortcuts: [
        {
          action: 'restart_worker',
          label: 'Reiniciar worker',
          description: 'Destrava filas em processamento e recoloca em pending.',
        },
        {
          action: 'clear_cache',
          label: 'Limpar cache',
          description: 'Invalida caches internos de catálogo, ranking e resumo.',
        },
        {
          action: 'reprocess_jobs',
          label: 'Reprocessar jobs',
          description: 'Agenda ciclos de classificação/curadoria no worker.',
        },
      ],
      active_sessions: activeSessions,
      users: knownUsers,
      bans,
      recent_packs: recentPacks,
      visit_metrics: visitSummary,
      system_summary: systemSummary,
      system_meta: systemMeta,
      observability_links: {
        grafana: grafanaObservabilityLinks,
      },
      message_flow_daily: messageFlowDaily,
      updated_at: __timeNowIso(),
    };

    setAdminOverviewSnapshot({
      overview: overviewPayload,
      source: 'admin_overview_payload',
    });

    return overviewPayload;
  };

  const findAdminPackContextByKey = async (rawPackKey) => {
    const packKey = sanitizeText(rawPackKey, 160, { allowEmpty: false });
    if (!packKey) return null;
    const basePack = await findStickerPackByPackKey(packKey);
    if (!basePack) return null;
    const ownerJid = normalizeJid(basePack.owner_jid) || '';
    if (!ownerJid) return null;
    const fullPack = await stickerPackService.getPackInfo({
      ownerJid,
      identifier: basePack.pack_key,
    });
    return { basePack, fullPack, ownerJid, packKey: basePack.pack_key };
  };

  const handleAdminPanelSessionRequest = async (req, res) => {
    if (!ADMIN_PANEL_ENABLED) {
      sendJson(req, res, 404, { error: 'Painel admin desabilitado.' });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const googleSession = await resolveGoogleWebSessionFromRequest(req);
      const adminSession = resolveAdminPanelSessionFromRequest(req);
      const eligibility = await resolveAdminPanelLoginEligibility(googleSession);
      sendJson(req, res, 200, {
        data: {
          google: mapGoogleSessionResponseData(googleSession),
          eligible_google_login: Boolean(eligibility.eligible),
          eligible_role: eligibility.role || null,
          session: mapAdminPanelSessionResponseData(adminSession),
        },
      });
      return;
    }

    if (req.method === 'DELETE') {
      const token = getAdminPanelSessionTokenFromRequest(req);
      const adminSession = resolveAdminPanelSessionFromRequest(req);
      if (token) adminPanelSessionMap.delete(token);
      clearAdminPanelSessionCookie(req, res);
      await createAdminActionAuditEvent({
        adminSession,
        action: 'admin_session_logout',
        targetType: 'admin_session',
        targetId: token || 'cookie_clear',
      });
      sendJson(req, res, 200, { data: { cleared: true } });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
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
      payload = parseAdminSessionPasswordPayload(payload);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Payload de sessao admin invalido.',
        code: error?.code || 'INVALID_PAYLOAD',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
      return;
    }

    const googleSession = await resolveGoogleWebSessionFromRequest(req);
    const eligibility = await resolveAdminPanelLoginEligibility(googleSession);
    if (!eligibility.eligible) {
      sendJson(req, res, 403, { error: 'Conta Google sem permissao para o painel admin.' });
      return;
    }
    const password = String(payload?.password || '').trim();
    let sessionRole;
    if (eligibility.role === 'owner') {
      if (!password || !constantTimeStringEqual(password, ADMIN_PANEL_PASSWORD)) {
        sendJson(req, res, 401, { error: 'Senha do painel admin invalida.' });
        return;
      }
      sessionRole = 'owner';
    } else if (eligibility.role === 'moderator') {
      const moderatorHash = String(eligibility?.moderator?.password_hash || '').trim();
      if (!password || !verifyAdminModeratorPassword(password, moderatorHash)) {
        sendJson(req, res, 401, { error: 'Senha do moderador invalida.' });
        return;
      }
      sessionRole = 'moderator';
      await touchAdminModeratorLastLogin(eligibility.moderator, googleSession).catch(() => {});
    } else {
      sendJson(req, res, 403, { error: 'Conta Google sem permissao para o painel admin.' });
      return;
    }

    const session = createAdminPanelSession(googleSession, { role: sessionRole });
    appendSetCookie(
      res,
      buildCookieString(ADMIN_PANEL_SESSION_COOKIE_NAME, session.token, req, {
        maxAgeSeconds: Math.floor(ADMIN_PANEL_SESSION_TTL_MS / 1000),
      }),
    );
    sendJson(req, res, 200, {
      data: {
        google: mapGoogleSessionResponseData(googleSession),
        eligible_google_login: true,
        eligible_role: sessionRole,
        session: mapAdminPanelSessionResponseData(session),
      },
    });
    await createAdminActionAuditEvent({
      adminSession: session,
      action: 'admin_session_login',
      targetType: 'admin_session',
      targetId: session.token,
      details: { role: sessionRole },
    });
  };

  const handleAdminOverviewRequest = async (req, res) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    const overview = await buildAdminOverviewPayload({ adminSession });
    sendJson(req, res, 200, { data: overview });
  };

  const handleAdminUsersRequest = async (req, res, url) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }
    const limit = Math.max(1, Math.min(500, Number(url?.searchParams?.get('limit') || 200)));
    const [activeSessions, users] = await Promise.all([listAdminActiveGoogleWebSessions({ limit }), listAdminKnownGoogleUsers({ limit })]);
    sendJson(req, res, 200, { data: { active_sessions: activeSessions, users } });
  };

  const handleAdminForceLogoutRequest = async (req, res) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
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

    let googleSub = normalizeGoogleSubject(payload?.google_sub || '');
    let email = normalizeEmail(payload?.email || '');
    let ownerJid = normalizeJid(payload?.owner_jid || '') || '';
    const sessionToken = sanitizeText(payload?.session_token || '', 36, { allowEmpty: true }) || '';

    if (sessionToken) {
      const rows = await executeQuery(
        `SELECT google_sub, email, owner_jid
         FROM ${TABLES.STICKER_WEB_GOOGLE_SESSION}
        WHERE session_token = ?
        LIMIT 1`,
        [sessionToken],
      ).catch(() => []);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row) {
        googleSub = normalizeGoogleSubject(row.google_sub || googleSub);
        email = normalizeEmail(row.email || email);
        ownerJid = normalizeJid(row.owner_jid || ownerJid) || ownerJid;
      }
    }

    if (!googleSub && !email && !ownerJid) {
      sendJson(req, res, 400, { error: 'Informe session_token, google_sub, email ou owner_jid.' });
      return;
    }

    const removed = await revokeGoogleWebSessionsByIdentity({
      googleSub,
      email,
      ownerJid,
    }).catch(() => 0);

    await createAdminActionAuditEvent({
      adminSession,
      action: 'force_logout',
      targetType: 'google_web_session',
      targetId: sessionToken || googleSub || email || ownerJid,
      details: {
        removed_sessions: Number(removed || 0),
        google_sub: googleSub || null,
        email: email || null,
        owner_jid: ownerJid || null,
      },
    });

    sendJson(req, res, 200, {
      data: {
        removed_sessions: Number(removed || 0),
        target: {
          session_token: sessionToken || null,
          google_sub: googleSub || null,
          email: email || null,
          owner_jid: ownerJid || null,
        },
      },
    });
  };

  const handleAdminFeatureFlagsRequest = async (req, res) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;

    if (req.method === 'GET' || req.method === 'HEAD') {
      const flags = await listAdminFeatureFlagsDetailed({ limit: 400 }).catch(() => []);
      sendJson(req, res, 200, { data: { flags } });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
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
      const flag = await upsertAdminFeatureFlagRecord({
        adminSession,
        flagName: payload?.flag_name,
        isEnabled: Boolean(payload?.is_enabled),
        rolloutPercent: payload?.rollout_percent,
        description: payload?.description,
      });
      await createAdminActionAuditEvent({
        adminSession,
        action: 'feature_flag_update',
        targetType: 'feature_flag',
        targetId: flag.flag_name,
        details: {
          is_enabled: flag.is_enabled,
          rollout_percent: flag.rollout_percent,
        },
      });
      sendJson(req, res, 200, { data: { flag } });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao atualizar feature flag.',
      });
    }
  };

  const handleAdminOpsActionRequest = async (req, res) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
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

    const action = sanitizeAuditActionText(payload?.action || '', 64);
    if (!action) {
      sendJson(req, res, 400, { error: 'Informe a ação operacional.' });
      return;
    }

    try {
      if (action === 'clear_cache') {
        invalidateStickerCatalogDerivedCaches();
        await createAdminActionAuditEvent({
          adminSession,
          action: 'ops_clear_cache',
          targetType: 'cache',
          targetId: 'global',
        });
        sendJson(req, res, 200, {
          data: {
            action,
            success: true,
            message: 'Caches internos invalidados com sucesso.',
            updated_at: __timeNowIso(),
          },
        });
        return;
      }

      if (action === 'restart_worker') {
        const [tasksResult, reprocessResult] = await Promise.all([
          executeQuery(
            `UPDATE ${TABLES.STICKER_WORKER_TASK_QUEUE}
              SET status = 'pending',
                  worker_token = NULL,
                  locked_at = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE status = 'processing'`,
          ).catch(() => ({ affectedRows: 0 })),
          executeQuery(
            `UPDATE ${TABLES.STICKER_ASSET_REPROCESS_QUEUE}
              SET status = 'pending',
                  worker_token = NULL,
                  locked_at = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE status = 'processing'`,
          ).catch(() => ({ affectedRows: 0 })),
        ]);

        const released = Number(tasksResult?.affectedRows || 0) + Number(reprocessResult?.affectedRows || 0);
        await createAdminActionAuditEvent({
          adminSession,
          action: 'ops_restart_worker',
          targetType: 'worker',
          targetId: 'queues',
          details: {
            released_tasks: released,
            task_queue: Number(tasksResult?.affectedRows || 0),
            reprocess_queue: Number(reprocessResult?.affectedRows || 0),
          },
        });
        sendJson(req, res, 200, {
          data: {
            action,
            success: true,
            released_processing_items: released,
            message: released > 0 ? 'Itens em processamento foram recolocados em pending.' : 'Nenhum item travado encontrado nas filas.',
            updated_at: __timeNowIso(),
          },
        });
        return;
      }

      if (action === 'reprocess_jobs') {
        const payloadJson = JSON.stringify({
          source: 'admin_panel',
          requested_by: normalizeEmail(adminSession?.email) || normalizeGoogleSubject(adminSession?.googleSub) || 'admin',
          requested_at: __timeNowIso(),
        });
        await executeQuery(
          `INSERT INTO ${TABLES.STICKER_WORKER_TASK_QUEUE}
          (task_type, payload, priority, scheduled_at, status, max_attempts)
         VALUES
          ('classification_cycle', ?, 10, UTC_TIMESTAMP(), 'pending', 5),
          ('curation_cycle', ?, 12, UTC_TIMESTAMP(), 'pending', 5)`,
          [payloadJson, payloadJson],
        );
        await createAdminActionAuditEvent({
          adminSession,
          action: 'ops_reprocess_jobs',
          targetType: 'worker',
          targetId: 'classification_cycle,curation_cycle',
        });
        sendJson(req, res, 200, {
          data: {
            action,
            success: true,
            enqueued_tasks: 2,
            message: 'Ciclos de classificação e curadoria foram agendados.',
            updated_at: __timeNowIso(),
          },
        });
        return;
      }

      sendJson(req, res, 400, { error: 'Ação operacional inválida.' });
    } catch (error) {
      sendJson(req, res, 500, { error: error?.message || 'Falha ao executar ação operacional.' });
    }
  };

  const handleAdminSearchRequest = async (req, res, url) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    const q = sanitizeText(url?.searchParams?.get('q') || '', 120, { allowEmpty: true }) || '';
    const limit = Math.max(1, Math.min(30, Number(url?.searchParams?.get('limit') || 12)));
    if (!q) {
      sendJson(req, res, 200, {
        data: {
          q: '',
          totals: { users: 0, sessions: 0, groups: 0, packs: 0 },
          results: { users: [], sessions: [], groups: [], packs: [] },
        },
      });
      return;
    }

    const like = `%${q}%`;

    const [usersRows, sessionsRows, groupsRows, packs] = await Promise.all([
      executeQuery(
        `SELECT google_sub, email, name, owner_jid, owner_phone, last_seen_at, last_login_at
         FROM ${TABLES.STICKER_WEB_GOOGLE_USER}
        WHERE google_sub LIKE ? OR email LIKE ? OR name LIKE ? OR owner_jid LIKE ? OR owner_phone LIKE ?
        ORDER BY COALESCE(last_seen_at, last_login_at, created_at) DESC
        LIMIT ${limit}`,
        [like, like, like, like, like],
      ).catch(() => []),
      executeQuery(
        `SELECT session_token, google_sub, email, name, owner_jid, owner_phone, last_seen_at, expires_at
         FROM ${TABLES.STICKER_WEB_GOOGLE_SESSION}
        WHERE revoked_at IS NULL
          AND expires_at > UTC_TIMESTAMP()
          AND (session_token LIKE ? OR google_sub LIKE ? OR email LIKE ? OR name LIKE ? OR owner_jid LIKE ? OR owner_phone LIKE ?)
        ORDER BY COALESCE(last_seen_at, created_at) DESC
        LIMIT ${limit}`,
        [like, like, like, like, like, like],
      ).catch(() => []),
      executeQuery(
        `SELECT
          gm.id,
          COALESCE(NULLIF(gm.subject, ''), ch.name, gm.id) AS subject,
          gm.owner_jid,
          gm.updated_at
       FROM ${TABLES.GROUPS_METADATA} gm
       LEFT JOIN ${TABLES.CHATS} ch ON ch.id = gm.id
       WHERE gm.id LIKE ? OR gm.subject LIKE ? OR ch.name LIKE ? OR gm.owner_jid LIKE ?
       ORDER BY gm.updated_at DESC
       LIMIT ${limit}`,
        [like, like, like, like],
      ).catch(() => []),
      listAdminPacks({
        searchParams: new URLSearchParams([
          ['q', q],
          ['limit', String(limit)],
        ]),
      }).catch(() => []),
    ]);

    const users = (Array.isArray(usersRows) ? usersRows : []).map((row) => ({
      google_sub: normalizeGoogleSubject(row?.google_sub),
      email: normalizeEmail(row?.email) || null,
      name: sanitizeText(row?.name || '', 120, { allowEmpty: true }) || null,
      owner_jid: normalizeJid(row?.owner_jid) || null,
      owner_phone: toWhatsAppPhoneDigits(row?.owner_phone || row?.owner_jid) || null,
      last_seen_at: toIsoOrNull(row?.last_seen_at),
      last_login_at: toIsoOrNull(row?.last_login_at),
    }));

    const sessions = (Array.isArray(sessionsRows) ? sessionsRows : []).map((row) => ({
      session_token: String(row?.session_token || '').trim() || null,
      google_sub: normalizeGoogleSubject(row?.google_sub),
      email: normalizeEmail(row?.email) || null,
      name: sanitizeText(row?.name || '', 120, { allowEmpty: true }) || null,
      owner_jid: normalizeJid(row?.owner_jid) || null,
      owner_phone: toWhatsAppPhoneDigits(row?.owner_phone || row?.owner_jid) || null,
      last_seen_at: toIsoOrNull(row?.last_seen_at),
      expires_at: toIsoOrNull(row?.expires_at),
    }));

    const groups = (Array.isArray(groupsRows) ? groupsRows : []).map((row) => ({
      id: String(row?.id || '').trim(),
      subject: sanitizeText(row?.subject || row?.id || '', 255, { allowEmpty: true }) || String(row?.id || '').trim(),
      owner_jid: normalizeJid(row?.owner_jid) || null,
      updated_at: toIsoOrNull(row?.updated_at),
    }));

    sendJson(req, res, 200, {
      data: {
        q,
        totals: {
          users: users.length,
          sessions: sessions.length,
          groups: groups.length,
          packs: Array.isArray(packs) ? packs.length : 0,
        },
        results: {
          users,
          sessions,
          groups,
          packs: Array.isArray(packs) ? packs : [],
        },
      },
    });
  };

  const toCsvValue = (value) => {
    const normalized = value === null || value === undefined ? '' : String(value);
    if (/[",\n;]/.test(normalized)) {
      return `"${normalized.replaceAll('"', '""')}"`;
    }
    return normalized;
  };

  const buildCsv = (rows = [], headers = []) => {
    const safeRows = Array.isArray(rows) ? rows : [];
    const safeHeaders = Array.isArray(headers) ? headers : [];
    const lines = [];
    lines.push(safeHeaders.map((header) => toCsvValue(header)).join(','));
    for (const row of safeRows) {
      lines.push(
        safeHeaders
          .map((header) => {
            const value = row && typeof row === 'object' ? row[header] : '';
            return toCsvValue(value);
          })
          .join(','),
      );
    }
    return `${lines.join('\n')}\n`;
  };

  const handleAdminExportRequest = async (req, res, url) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    const format = String(url?.searchParams?.get('format') || 'json')
      .trim()
      .toLowerCase();
    const type = String(url?.searchParams?.get('type') || 'metrics')
      .trim()
      .toLowerCase();

    const overview = await buildAdminOverviewPayload({ adminSession });
    const exportData =
      type === 'events'
        ? {
            moderation_queue: overview?.moderation_queue || [],
            audit_log: overview?.audit_log || [],
            blocked_accounts: overview?.users_sessions?.blocked_accounts || [],
          }
        : {
            dashboard_quick: overview?.dashboard_quick || null,
            counters: overview?.counters || null,
            system_health: overview?.system_health || null,
            alerts: overview?.alerts || [],
            feature_flags: overview?.feature_flags || [],
          };

    await createAdminActionAuditEvent({
      adminSession,
      action: 'export_data',
      targetType: 'admin_export',
      targetId: `${type}.${format}`,
      details: { type, format },
    });

    if (format !== 'csv') {
      sendJson(req, res, 200, {
        data: {
          type,
          format: 'json',
          exported_at: __timeNowIso(),
          payload: exportData,
        },
      });
      return;
    }

    let headers = [];
    let rows = [];

    if (type === 'events') {
      headers = ['section', 'id', 'event_type', 'severity', 'title', 'subtitle', 'status', 'created_at'];
      rows = [
        ...(Array.isArray(exportData?.moderation_queue) ? exportData.moderation_queue : []).map((item) => ({
          section: 'moderation_queue',
          id: item?.id || '',
          event_type: item?.event_type || '',
          severity: item?.severity || '',
          title: item?.title || '',
          subtitle: item?.subtitle || '',
          status: item?.revoked_at ? 'revoked' : item?.status || '',
          created_at: item?.created_at || item?.revoked_at || '',
        })),
        ...(Array.isArray(exportData?.audit_log) ? exportData.audit_log : []).map((item) => ({
          section: 'audit_log',
          id: item?.id || '',
          event_type: item?.action || '',
          severity: item?.status || '',
          title: item?.target_type || '',
          subtitle: item?.target_id || '',
          status: item?.status || '',
          created_at: item?.created_at || '',
        })),
        ...(Array.isArray(exportData?.blocked_accounts) ? exportData.blocked_accounts : []).map((item) => ({
          section: 'blocked_accounts',
          id: item?.id || '',
          event_type: 'ban',
          severity: item?.revoked_at ? 'low' : 'critical',
          title: item?.email || item?.owner_jid || item?.google_sub || '',
          subtitle: item?.reason || '',
          status: item?.revoked_at ? 'revoked' : 'active',
          created_at: item?.created_at || '',
        })),
      ];
    } else {
      headers = ['section', 'key', 'value'];
      const dashboard = exportData?.dashboard_quick || {};
      const counters = exportData?.counters || {};
      const health = exportData?.system_health || {};
      const alerts = Array.isArray(exportData?.alerts) ? exportData.alerts : [];
      const flags = Array.isArray(exportData?.feature_flags) ? exportData.feature_flags : [];
      rows = [
        ...Object.entries(dashboard).map(([key, value]) => ({
          section: 'dashboard_quick',
          key,
          value,
        })),
        ...Object.entries(counters).map(([key, value]) => ({ section: 'counters', key, value })),
        ...Object.entries(health).map(([key, value]) => ({ section: 'system_health', key, value })),
        ...alerts.map((alert, index) => ({
          section: 'alerts',
          key: `${index + 1}:${alert?.code || 'alert'}`,
          value: `${alert?.severity || ''} ${alert?.title || ''}`.trim(),
        })),
        ...flags.map((flag) => ({
          section: 'feature_flags',
          key: flag?.flag_name || '',
          value: `${flag?.is_enabled ? 'on' : 'off'} (${flag?.rollout_percent || 0}%)`,
        })),
      ];
    }

    const csv = buildCsv(rows, headers);
    const stamp = __timeNowIso().slice(0, 19).replace(/[:T]/g, '-');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="admin-${type}-${stamp}.csv"`);
    res.end(csv);
  };

  const handleAdminModeratorsRequest = async (req, res) => {
    const adminSession = requireOwnerAdminPanelSession(req, res);
    if (!adminSession) return;

    if (req.method === 'GET' || req.method === 'HEAD') {
      const moderators = await listAdminModerators({ activeOnly: false, limit: 500 });
      sendJson(req, res, 200, { data: { moderators } });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
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
      payload = parseAdminModeratorUpsertPayload(payload);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Payload de moderador invalido.',
        code: error?.code || 'INVALID_PAYLOAD',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
      return;
    }

    try {
      const result = await upsertAdminModeratorRecord({
        googleSub: payload?.google_sub,
        email: payload?.email,
        ownerJid: payload?.owner_jid,
        password: payload?.password,
        adminSession,
      });
      await createAdminActionAuditEvent({
        adminSession,
        action: result.created ? 'moderator_create' : 'moderator_update',
        targetType: 'moderator',
        targetId: result?.moderator?.google_sub || payload?.google_sub || '',
        details: { created: Boolean(result.created) },
      });
      sendJson(req, res, result.created ? 201 : 200, {
        data: {
          created: result.created,
          moderator: result.moderator,
        },
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao salvar moderador.',
      });
    }
  };

  const handleAdminModeratorDeleteRequest = async (req, res, googleSub) => {
    const adminSession = requireOwnerAdminPanelSession(req, res);
    if (!adminSession) return;
    if (req.method !== 'DELETE') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }
    try {
      const moderator = await revokeAdminModeratorRecord(googleSub, adminSession);
      await createAdminActionAuditEvent({
        adminSession,
        action: 'moderator_revoke',
        targetType: 'moderator',
        targetId: moderator?.google_sub || googleSub,
      });
      sendJson(req, res, 200, { data: { revoked: true, moderator } });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao remover moderador.',
      });
    }
  };

  const handleAdminPacksRequest = async (req, res, url) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }
    const packs = await listAdminPacks(url);
    sendJson(req, res, 200, { data: packs });
  };

  const handleAdminPackDetailsRequest = async (req, res, packKey) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }
    const context = await findAdminPackContextByKey(packKey);
    if (!context?.fullPack) {
      sendJson(req, res, 404, { error: 'Pack nao encontrado.' });
      return;
    }
    const data = await buildManagedPackResponseData(context.fullPack);
    sendJson(req, res, 200, { data });
  };

  const handleAdminPackDeleteRequest = async (req, res, packKey) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (req.method !== 'DELETE') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }
    const context = await findAdminPackContextByKey(packKey);
    const normalizedPackKey = sanitizeText(packKey, 160, { allowEmpty: false }) || String(packKey || '');
    if (!context?.fullPack) {
      sendManagedMutationStatus(req, res, 'already_deleted', {
        deleted: false,
        pack_key: normalizedPackKey,
        admin: true,
      });
      return;
    }
    const result = await deleteManagedPackWithCleanup({
      ownerJid: context.ownerJid,
      identifier: context.packKey,
      fallbackPack: context.fullPack,
    });
    await createAdminActionAuditEvent({
      adminSession,
      action: 'pack_delete',
      targetType: 'pack',
      targetId: result?.deletedPack?.pack_key || context.packKey || packKey,
      details: {
        removed_sticker_count: Number(result?.removedCount || 0),
        missing: Boolean(result?.missing),
      },
    });
    sendManagedMutationStatus(req, res, 'deleted', {
      admin: true,
      deleted: !result?.missing,
      pack_key: result?.deletedPack?.pack_key || context.packKey,
      id: result?.deletedPack?.id || context.fullPack?.id || null,
      deleted_at: toIsoOrNull(result?.deletedPack?.deleted_at || __timeNow()),
      removed_sticker_count: Number(result?.removedCount || 0),
    });
  };

  const handleAdminPackStickerDeleteRequest = async (req, res, packKey, stickerId) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (req.method !== 'DELETE') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }
    const context = await findAdminPackContextByKey(packKey);
    const normalizedStickerId = sanitizeText(stickerId, 36, { allowEmpty: false });
    if (!context?.fullPack) {
      sendManagedMutationStatus(req, res, 'already_deleted', {
        admin: true,
        pack_key: sanitizeText(packKey, 160, { allowEmpty: true }) || String(packKey || ''),
        sticker_id: normalizedStickerId || null,
      });
      return;
    }
    try {
      const result = await stickerPackService.removeStickerFromPack({
        ownerJid: context.ownerJid,
        identifier: context.packKey,
        selector: normalizedStickerId,
      });
      invalidateStickerCatalogDerivedCaches();
      if (normalizedStickerId) {
        await cleanupOrphanStickerAssets([normalizedStickerId], { reason: 'admin_remove_sticker' });
      }
      await createAdminActionAuditEvent({
        adminSession,
        action: 'pack_sticker_delete',
        targetType: 'sticker',
        targetId: normalizedStickerId || stickerId,
        details: {
          pack_key: context.packKey,
        },
      });
      await sendManagedPackMutationStatus(req, res, 'updated', result?.pack || context.fullPack, {
        admin: true,
        pack_key: context.packKey,
        removed_sticker_id: normalizedStickerId || null,
      });
    } catch (error) {
      const mapped = mapStickerPackWebManageError(error);
      sendJson(req, res, mapped.statusCode, { error: mapped.message, code: mapped.code });
    }
  };

  const handleAdminGlobalStickerDeleteRequest = async (req, res, stickerId) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (req.method !== 'DELETE') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }
    const normalizedStickerId = sanitizeText(stickerId, 36, { allowEmpty: false });
    if (!normalizedStickerId) {
      sendJson(req, res, 400, { error: 'sticker_id invalido.' });
      return;
    }

    const refs = await executeQuery(
      `SELECT p.pack_key, p.owner_jid
       FROM ${TABLES.STICKER_PACK_ITEM} i
       INNER JOIN ${TABLES.STICKER_PACK} p ON p.id = i.pack_id
      WHERE i.sticker_id = ?
        AND p.deleted_at IS NULL`,
      [normalizedStickerId],
    );

    let removedFromPacks = 0;
    let removeErrors = 0;
    for (const ref of Array.isArray(refs) ? refs : []) {
      try {
        const ownerJid = normalizeJid(ref.owner_jid) || '';
        const packKey = sanitizeText(ref.pack_key, 160, { allowEmpty: false });
        if (!ownerJid || !packKey) continue;
        await stickerPackService.removeStickerFromPack({
          ownerJid,
          identifier: packKey,
          selector: normalizedStickerId,
        });
        removedFromPacks += 1;
      } catch {
        removeErrors += 1;
      }
    }

    const cleanup = await cleanupOrphanStickerAssets([normalizedStickerId], {
      reason: 'admin_delete_sticker_global',
    });
    invalidateStickerCatalogDerivedCaches();
    await createAdminActionAuditEvent({
      adminSession,
      action: 'global_sticker_delete',
      targetType: 'sticker',
      targetId: normalizedStickerId,
      details: {
        removed_from_packs: removedFromPacks,
        remove_errors: removeErrors,
        cleanup_deleted: Number(cleanup?.deleted || 0),
      },
    });
    sendJson(req, res, 200, {
      data: {
        success: true,
        sticker_id: normalizedStickerId,
        removed_from_packs: removedFromPacks,
        remove_errors: removeErrors,
        cleanup,
        deleted: Number(cleanup?.deleted || 0) > 0,
      },
    });
  };

  const handleAdminBansRequest = async (req, res) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;

    if (req.method === 'GET' || req.method === 'HEAD') {
      const bans = await listAdminBans({ activeOnly: false, limit: 200 });
      sendJson(req, res, 200, { data: bans });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
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
      const result = await createAdminBanRecord({
        googleSub: payload?.google_sub,
        email: payload?.email,
        ownerJid: payload?.owner_jid,
        reason: payload?.reason,
        adminSession,
      });
      await createAdminActionAuditEvent({
        adminSession,
        action: result.created ? 'ban_create' : 'ban_existing',
        targetType: 'ban',
        targetId: result?.ban?.id || '',
        details: {
          google_sub: result?.ban?.google_sub || payload?.google_sub || null,
          email: result?.ban?.email || payload?.email || null,
          owner_jid: result?.ban?.owner_jid || payload?.owner_jid || null,
        },
      });
      sendJson(req, res, result.created ? 201 : 200, {
        data: {
          created: result.created,
          ban: result.ban,
        },
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao banir usuário.',
      });
    }
  };

  const handleAdminBanRevokeRequest = async (req, res, banId) => {
    const adminSession = requireAdminPanelSession(req, res);
    if (!adminSession) return;
    if (req.method !== 'DELETE') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }
    try {
      const ban = await revokeAdminBanRecord(banId);
      await createAdminActionAuditEvent({
        adminSession,
        action: 'ban_revoke',
        targetType: 'ban',
        targetId: ban?.id || banId,
      });
      sendJson(req, res, 200, { data: { revoked: true, ban } });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Falha ao revogar ban.',
      });
    }
  };

  return {
    handleAdminPanelSessionRequest,
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
  };
};
