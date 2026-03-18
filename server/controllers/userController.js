import fs from 'node:fs/promises';
import path from 'node:path';

import logger from '#logger';
import { DEFAULT_LEGACY_STICKER_API_BASE_PATH, DEFAULT_USER_API_BASE_PATH, isUserApiPath, normalizeBasePath, resolveLegacyUserApiPath } from '../routes/user/userApiPaths.js';

const LEGACY_STICKER_API_BASE_PATH = normalizeBasePath(process.env.STICKER_API_BASE_PATH, DEFAULT_LEGACY_STICKER_API_BASE_PATH);
const USER_API_BASE_PATH = normalizeBasePath(process.env.USER_API_BASE_PATH || process.env.AUTH_API_BASE_PATH, DEFAULT_USER_API_BASE_PATH);
const STICKER_LOGIN_WEB_PATH = normalizeBasePath(process.env.STICKER_LOGIN_WEB_PATH, '/login');
const USER_PROFILE_WEB_PATH = normalizeBasePath(process.env.USER_PROFILE_WEB_PATH, '/user');
const USER_PASSWORD_RESET_WEB_PATH = normalizeBasePath(process.env.USER_PASSWORD_RESET_WEB_PATH, '/user/password-reset');
const USER_DASHBOARD_TEMPLATE_PATH = path.join(process.cwd(), 'public', 'pages', 'user.html');
const USER_PASSWORD_RESET_TEMPLATE_PATH = path.join(process.cwd(), 'public', 'pages', 'user-password-reset.html');

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

const isSupportedUserApiPath = (pathname) => isUserApiPath(pathname, USER_API_BASE_PATH) || isUserApiPath(pathname, LEGACY_STICKER_API_BASE_PATH, { legacyCompatible: true });

const mapUserApiPathToLegacy = (pathname) =>
  resolveLegacyUserApiPath(pathname, {
    apiBasePath: USER_API_BASE_PATH,
    legacyApiBasePath: LEGACY_STICKER_API_BASE_PATH,
    legacyCompatible: true,
  }) ||
  resolveLegacyUserApiPath(pathname, {
    apiBasePath: LEGACY_STICKER_API_BASE_PATH,
    legacyApiBasePath: LEGACY_STICKER_API_BASE_PATH,
    legacyCompatible: true,
  });

const renderUserDashboardHtml = async ({ passwordReset = false } = {}) => {
  const templatePath = passwordReset ? USER_PASSWORD_RESET_TEMPLATE_PATH : USER_DASHBOARD_TEMPLATE_PATH;
  const template = await fs.readFile(templatePath, 'utf8');
  const dataAttributes = {
    'data-api-base-path': USER_API_BASE_PATH,
    'data-login-path': STICKER_LOGIN_WEB_PATH,
    'data-panel-path': USER_PROFILE_WEB_PATH,
    'data-password-reset-web-path': USER_PASSWORD_RESET_WEB_PATH,
  };

  let html = template;
  for (const [attributeName, value] of Object.entries(dataAttributes)) {
    html = replaceDataAttribute(html, attributeName, value);
  }

  return html;
};

let stickerCatalogControllerPromise = null;
const loadStickerCatalogController = async () => {
  if (!stickerCatalogControllerPromise) {
    stickerCatalogControllerPromise = import('./sticker/stickerCatalogController.js');
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

export const getUserRouteConfig = () => ({
  webPath: USER_PROFILE_WEB_PATH,
  loginPath: STICKER_LOGIN_WEB_PATH,
  passwordResetWebPath: USER_PASSWORD_RESET_WEB_PATH,
  apiBasePath: USER_API_BASE_PATH,
  legacyApiBasePath: LEGACY_STICKER_API_BASE_PATH,
});

export const maybeHandleUserRequest = async (req, res, { pathname, url }) => {
  if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(req.method || '')) return false;

  const isUserHomePath = pathname === USER_PROFILE_WEB_PATH || pathname === `${USER_PROFILE_WEB_PATH}/`;
  const isPasswordResetPath = hasPathPrefix(pathname, USER_PASSWORD_RESET_WEB_PATH);

  if (isUserHomePath || isPasswordResetPath) {
    if (!['GET', 'HEAD'].includes(req.method || '')) return false;
    try {
      const html = await renderUserDashboardHtml({ passwordReset: isPasswordResetPath });
      sendHtml(req, res, html);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(req, res, 404, { error: 'Template da pagina de usuario nao encontrado.' });
        return true;
      }
      logger.error('Falha ao renderizar pagina de usuario.', {
        action: 'user_page_render_failed',
        path: pathname,
        error: error?.message,
      });
      sendJson(req, res, 500, { error: 'Falha interna ao renderizar pagina de usuario.' });
    }
    return true;
  }

  if (isSupportedUserApiPath(pathname)) {
    const routedPathname = mapUserApiPathToLegacy(pathname) || pathname;

    const controller = await loadStickerCatalogController();
    if (typeof controller?.maybeHandleStickerCatalogRequest !== 'function') return false;
    return controller.maybeHandleStickerCatalogRequest(req, res, {
      pathname: routedPathname,
      url: remapUrlPathname(url, routedPathname),
    });
  }

  return false;
};
