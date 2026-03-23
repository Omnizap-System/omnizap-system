import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';

import logger from '#logger';
import {
  forceSystemAdminGroupFailover,
  listSystemAdminAssignmentHistory,
  listSystemAdminAssignments,
  listSystemAdminSessions,
  setSystemAdminGroupPin,
  triggerSystemAdminManualRebalance,
} from '../system/systemController.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeBasePath = (value, fallback) => {
  const raw = String(value || '').trim() || fallback;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const withoutTrailingSlash = withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
  return withoutTrailingSlash || fallback;
};

const LEGACY_STICKER_API_BASE_PATH = normalizeBasePath(process.env.STICKER_API_BASE_PATH, '/api/sticker-packs');
const USER_API_BASE_PATH = normalizeBasePath(process.env.USER_API_BASE_PATH || process.env.AUTH_API_BASE_PATH, '/api');
const SYSTEM_ADMIN_API_BASE_PATH = normalizeBasePath(process.env.SYSTEM_ADMIN_API_BASE_PATH || `${USER_API_BASE_PATH}/admin`, `${USER_API_BASE_PATH}/admin`);
const SYSTEM_ADMIN_API_SESSION_PATH = `${SYSTEM_ADMIN_API_BASE_PATH}/session`;
const LEGACY_SYSTEM_ADMIN_API_BASE_PATH = `${LEGACY_STICKER_API_BASE_PATH}/admin`;
const LEGACY_SYSTEM_ADMIN_API_SESSION_PATH = `${LEGACY_SYSTEM_ADMIN_API_BASE_PATH}/session`;
const SYSTEM_ADMIN_MULTI_SESSION_API_PATH = `${SYSTEM_ADMIN_API_BASE_PATH}/multi-session`;
const LEGACY_SYSTEM_ADMIN_MULTI_SESSION_API_PATH = `${LEGACY_SYSTEM_ADMIN_API_BASE_PATH}/multi-session`;
const STICKER_LOGIN_WEB_PATH = normalizeBasePath(process.env.STICKER_LOGIN_WEB_PATH, '/login');
const STICKER_WEB_PATH = normalizeBasePath(process.env.STICKER_WEB_PATH, '/stickers');
const STICKER_ADMIN_WEB_PATH = `${STICKER_WEB_PATH}/admin`;
const USER_PROFILE_WEB_PATH = normalizeBasePath(process.env.USER_PROFILE_WEB_PATH, '/user');
const USER_SYSTEMADM_WEB_PATH = `${USER_PROFILE_WEB_PATH}/systemadm`;
const STICKER_ADMIN_REDIRECT_TO_USER = parseEnvBool(process.env.STICKER_ADMIN_REDIRECT_TO_USER, true);
const SITE_ORIGIN = String(process.env.SITE_ORIGIN || 'https://omnizap.shop')
  .trim()
  .replace(/\/+$/, '');

const USER_SYSTEMADM_TEMPLATE_PATH = path.join(process.cwd(), 'public', 'pages', 'user-systemadm.html');
const LEGACY_STICKER_ADMIN_TEMPLATE_PATH = path.join(process.cwd(), 'public', 'pages', 'stickers-admin.html');
const SYSTEM_ADMIN_OPS_TOKEN = String(
  process.env.SYSTEM_ADMIN_OPS_TOKEN || process.env.USER_INTERNAL_API_TOKEN || process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '',
).trim();

let stickerCatalogControllerPromise = null;
const loadStickerCatalogController = async () => {
  if (!stickerCatalogControllerPromise) {
    stickerCatalogControllerPromise = import('../sticker/stickerCatalogController.js');
  }
  return stickerCatalogControllerPromise;
};

const sendHtml = (req, res, html) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(html);
};

const sendJson = (req, res, statusCode, payload) => {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
};

const sendRedirect = (res, location) => {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
};

const hasPathPrefix = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);
const escapeHtmlAttribute = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const replaceDataAttribute = (html, attributeName, value) => String(html || '').replace(new RegExp(`(${attributeName}=")([^"]*)(")`, 'i'), `$1${escapeHtmlAttribute(value)}$3`);
const remapUrlPathname = (url, pathname) => {
  if (!url || !pathname) return url;
  try {
    const remappedUrl = new URL(String(url?.href || url));
    remappedUrl.pathname = pathname;
    return remappedUrl;
  } catch {
    return url;
  }
};

const mapAdminApiPathToLegacy = (pathname) => {
  if (hasPathPrefix(pathname, SYSTEM_ADMIN_API_BASE_PATH)) {
    const suffix = pathname.slice(SYSTEM_ADMIN_API_BASE_PATH.length);
    return `${LEGACY_SYSTEM_ADMIN_API_BASE_PATH}${suffix || ''}`;
  }
  if (hasPathPrefix(pathname, LEGACY_SYSTEM_ADMIN_API_BASE_PATH)) {
    return pathname;
  }
  return null;
};

const mapMultiSessionApiPath = (pathname) => {
  if (hasPathPrefix(pathname, SYSTEM_ADMIN_MULTI_SESSION_API_PATH)) {
    const suffix = pathname.slice(SYSTEM_ADMIN_MULTI_SESSION_API_PATH.length);
    return suffix || '/';
  }
  if (hasPathPrefix(pathname, LEGACY_SYSTEM_ADMIN_MULTI_SESSION_API_PATH)) {
    const suffix = pathname.slice(LEGACY_SYSTEM_ADMIN_MULTI_SESSION_API_PATH.length);
    return suffix || '/';
  }
  return null;
};

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

const extractBearerToken = (req) => {
  const authHeader = String(req?.headers?.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) return '';
  return authHeader.slice(7).trim();
};

const resolveOpsTokenFromRequest = (req) =>
  String(req?.headers?.['x-system-admin-token'] || req?.headers?.['x-internal-api-token'] || req?.headers?.['x-admin-token'] || '').trim() ||
  extractBearerToken(req);

const hasValidOpsToken = (req) => {
  if (!SYSTEM_ADMIN_OPS_TOKEN) return true;
  const requestToken = resolveOpsTokenFromRequest(req);
  if (!requestToken) return false;
  return constantTimeStringEqual(requestToken, SYSTEM_ADMIN_OPS_TOKEN);
};

const readJsonBody = async (req, { maxBytes = 64 * 1024 } = {}) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error('Payload excedeu limite permitido.');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('JSON invalido.');
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on('error', (error) => reject(error));
  });

const parseBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parsePositiveInt = (value, fallback = 200, min = 1, max = 5000) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const decodePathSegment = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const renderUserSystemAdminHtml = async () => {
  const template = await fs.readFile(USER_SYSTEMADM_TEMPLATE_PATH, 'utf8');
  const dataAttributes = {
    'data-api-base-path': USER_API_BASE_PATH,
    'data-login-path': STICKER_LOGIN_WEB_PATH,
    'data-stickers-path': STICKER_WEB_PATH,
  };

  let html = template;
  for (const [attributeName, value] of Object.entries(dataAttributes)) {
    html = replaceDataAttribute(html, attributeName, value);
  }

  return html;
};

const requireSystemAdminOpsAccess = (req, res) => {
  if (hasValidOpsToken(req)) return true;
  sendJson(req, res, 401, { error: 'Nao autorizado para operacoes de system admin.' });
  return false;
};

const normalizeMultiSessionSubPath = (value) => {
  const raw = String(value || '/').trim();
  if (!raw || raw === '/') return '/';
  return `/${raw
    .replace(/^\/+/g, '')
    .replace(/\/+$/g, '')}`;
};

const handleMultiSessionOpsRequest = async (req, res, { pathname, url }) => {
  if (!requireSystemAdminOpsAccess(req, res)) return true;

  const subPath = normalizeMultiSessionSubPath(pathname);
  const requestUrl = (() => {
    try {
      return new URL(String(url?.href || req.url || '/'), SITE_ORIGIN);
    } catch {
      return new URL(SITE_ORIGIN);
    }
  })();

  if (subPath === '/sessions') {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return true;
    }
    const payload = await listSystemAdminSessions({
      status: requestUrl.searchParams.get('status'),
      limit: parsePositiveInt(requestUrl.searchParams.get('limit'), 200, 1, 5000),
    });
    sendJson(req, res, 200, payload);
    return true;
  }

  if (subPath === '/assignments') {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return true;
    }
    const payload = await listSystemAdminAssignments({
      groupJid: requestUrl.searchParams.get('group_jid'),
      ownerSessionId: requestUrl.searchParams.get('owner_session_id'),
      includeExpired: parseBool(requestUrl.searchParams.get('include_expired'), false),
      limit: parsePositiveInt(requestUrl.searchParams.get('limit'), 200, 1, 5000),
    });
    sendJson(req, res, 200, payload);
    return true;
  }

  if (subPath === '/history') {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return true;
    }
    const payload = await listSystemAdminAssignmentHistory({
      groupJid: requestUrl.searchParams.get('group_jid'),
      limit: parsePositiveInt(requestUrl.searchParams.get('limit'), 100, 1, 5000),
    });
    sendJson(req, res, 200, payload);
    return true;
  }

  if (subPath === '/rebalance') {
    if (!['POST'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return true;
    }
    const payload = await triggerSystemAdminManualRebalance();
    sendJson(req, res, 200, payload);
    return true;
  }

  const groupActionMatch = subPath.match(/^\/groups\/([^/]+)\/(pin|unpin|failover)$/i);
  if (groupActionMatch) {
    if (!['POST'].includes(req.method || '')) {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return true;
    }

    const groupJid = decodePathSegment(groupActionMatch[1]);
    const action = String(groupActionMatch[2] || '').toLowerCase();
    const body = await readJsonBody(req).catch((error) => {
      const statusCode = Number(error?.statusCode || 400);
      sendJson(req, res, statusCode, { error: error?.message || 'Falha ao interpretar payload JSON.' });
      return null;
    });
    if (body === null) return true;

    if (action === 'pin' || action === 'unpin') {
      const pinned = action === 'pin';
      const payload = await setSystemAdminGroupPin({
        groupJid,
        pinned,
        sessionId: body?.session_id || body?.sessionId || null,
        reason: body?.reason || null,
        changedBy: 'system_admin_api',
        metadata: body?.metadata || null,
      });
      sendJson(req, res, 200, payload);
      return true;
    }

    if (action === 'failover') {
      const targetSessionId = String(body?.target_session_id || body?.targetSessionId || requestUrl.searchParams.get('target_session_id') || '')
        .trim()
        .slice(0, 64);
      if (!targetSessionId) {
        sendJson(req, res, 400, { error: 'target_session_id e obrigatorio.' });
        return true;
      }

      const payload = await forceSystemAdminGroupFailover({
        groupJid,
        targetSessionId,
        reason: body?.reason || 'admin_force_failover',
        changedBy: 'system_admin_api',
        metadata: body?.metadata || null,
      });
      sendJson(req, res, 200, payload);
      return true;
    }
  }

  sendJson(req, res, 404, { error: 'Endpoint de operacao multi-session nao encontrado.' });
  return true;
};

export const getSystemAdminRouteConfig = () => ({
  webPath: USER_SYSTEMADM_WEB_PATH,
  legacyWebPath: STICKER_ADMIN_WEB_PATH,
  apiAdminBasePath: SYSTEM_ADMIN_API_BASE_PATH,
  apiAdminSessionPath: SYSTEM_ADMIN_API_SESSION_PATH,
  apiAdminMultiSessionPath: SYSTEM_ADMIN_MULTI_SESSION_API_PATH,
  legacyApiAdminBasePath: LEGACY_SYSTEM_ADMIN_API_BASE_PATH,
  legacyApiAdminSessionPath: LEGACY_SYSTEM_ADMIN_API_SESSION_PATH,
  legacyApiAdminMultiSessionPath: LEGACY_SYSTEM_ADMIN_MULTI_SESSION_API_PATH,
});

export const maybeHandleSystemAdminRequest = async (req, res, { pathname, url }) => {
  if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(req.method || '')) return false;

  if (pathname === USER_SYSTEMADM_WEB_PATH || pathname === `${USER_SYSTEMADM_WEB_PATH}/`) {
    if (!['GET', 'HEAD'].includes(req.method || '')) return false;
    try {
      const html = await renderUserSystemAdminHtml();
      sendHtml(req, res, html);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(req, res, 404, { error: 'Template da pagina system admin nao encontrado.' });
        return true;
      }
      logger.error('Falha ao renderizar pagina system admin.', {
        action: 'user_system_admin_page_render_failed',
        path: pathname,
        error: error?.message,
      });
      sendJson(req, res, 500, { error: 'Falha interna ao renderizar pagina system admin.' });
    }
    return true;
  }

  if (pathname === STICKER_ADMIN_WEB_PATH || pathname === `${STICKER_ADMIN_WEB_PATH}/`) {
    if (!['GET', 'HEAD'].includes(req.method || '')) return false;
    if (STICKER_ADMIN_REDIRECT_TO_USER) {
      const requestUrl = new URL(req.url || `${STICKER_ADMIN_WEB_PATH}/`, SITE_ORIGIN);
      const userUrl = new URL(`${USER_SYSTEMADM_WEB_PATH}/`, SITE_ORIGIN);
      for (const [key, value] of requestUrl.searchParams.entries()) {
        userUrl.searchParams.append(key, value);
      }
      sendRedirect(res, `${userUrl.pathname}${userUrl.search}`);
      return true;
    }
    try {
      const html = await fs.readFile(LEGACY_STICKER_ADMIN_TEMPLATE_PATH, 'utf8');
      sendHtml(req, res, html);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(req, res, 404, { error: 'Template do painel admin nao encontrado.' });
        return true;
      }
      logger.error('Falha ao renderizar pagina admin legado.', {
        action: 'legacy_sticker_admin_page_render_failed',
        path: pathname,
        error: error?.message,
      });
      sendJson(req, res, 500, { error: 'Falha interna ao renderizar painel admin.' });
    }
    return true;
  }

  if (hasPathPrefix(pathname, SYSTEM_ADMIN_API_BASE_PATH) || hasPathPrefix(pathname, LEGACY_SYSTEM_ADMIN_API_BASE_PATH)) {
    const multiSessionPath = mapMultiSessionApiPath(pathname);
    if (multiSessionPath !== null) {
      try {
        return await handleMultiSessionOpsRequest(req, res, {
          pathname: multiSessionPath,
          url,
        });
      } catch (error) {
        logger.error('Falha ao processar endpoint operacional multi-sessao.', {
          action: 'system_admin_multi_session_endpoint_failed',
          method: req.method,
          path: pathname,
          error: error?.message,
        });
        sendJson(req, res, 500, { error: 'Falha interna ao processar operacao multi-sessao.' });
        return true;
      }
    }

    const legacyPathname = mapAdminApiPathToLegacy(pathname);
    if (!legacyPathname) return false;

    const controller = await loadStickerCatalogController();
    if (typeof controller?.maybeHandleStickerCatalogRequest !== 'function') return false;
    return controller.maybeHandleStickerCatalogRequest(req, res, {
      pathname: legacyPathname,
      url: remapUrlPathname(url, legacyPathname),
    });
  }

  return false;
};
