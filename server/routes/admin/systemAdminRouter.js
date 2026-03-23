let systemAdminControllerPromise = null;

const loadSystemAdminController = async () => {
  if (!systemAdminControllerPromise) {
    systemAdminControllerPromise = import('../../controllers/admin/systemAdminController.js');
  }
  return systemAdminControllerPromise;
};

const normalizeBasePath = (value, fallback) => {
  const raw = String(value || '').trim() || fallback;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const withoutTrailingSlash = withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
  return withoutTrailingSlash || fallback;
};

const startsWithPath = (pathname, prefix) => {
  if (!pathname || !prefix) return false;
  if (pathname === prefix) return true;
  return pathname.startsWith(`${prefix}/`);
};

const DEFAULT_USER_SYSTEM_ADMIN_WEB_PATH = '/user/systemadm';
const DEFAULT_LEGACY_STICKER_ADMIN_WEB_PATH = '/stickers/admin';
const DEFAULT_SYSTEM_ADMIN_API_BASE_PATH = '/api/admin';
const DEFAULT_SYSTEM_ADMIN_API_SESSION_PATH = '/api/admin/session';
const DEFAULT_SYSTEM_ADMIN_API_MULTI_SESSION_PATH = '/api/admin/multi-session';
const DEFAULT_LEGACY_STICKER_ADMIN_API_BASE_PATH = '/api/sticker-packs/admin';
const DEFAULT_LEGACY_STICKER_ADMIN_API_SESSION_PATH = '/api/sticker-packs/admin/session';
const DEFAULT_LEGACY_STICKER_ADMIN_API_MULTI_SESSION_PATH = '/api/sticker-packs/admin/multi-session';

export const getSystemAdminRouterConfig = async () => {
  const controller = await loadSystemAdminController();
  const legacyConfig = (typeof controller?.getSystemAdminRouteConfig === 'function' ? controller.getSystemAdminRouteConfig() : null) || {};
  return {
    webPath: normalizeBasePath(legacyConfig.webPath, DEFAULT_USER_SYSTEM_ADMIN_WEB_PATH),
    legacyWebPath: normalizeBasePath(legacyConfig.legacyWebPath, DEFAULT_LEGACY_STICKER_ADMIN_WEB_PATH),
    apiAdminBasePath: normalizeBasePath(legacyConfig.apiAdminBasePath, DEFAULT_SYSTEM_ADMIN_API_BASE_PATH),
    apiAdminSessionPath: normalizeBasePath(legacyConfig.apiAdminSessionPath, DEFAULT_SYSTEM_ADMIN_API_SESSION_PATH),
    apiAdminMultiSessionPath: normalizeBasePath(legacyConfig.apiAdminMultiSessionPath, DEFAULT_SYSTEM_ADMIN_API_MULTI_SESSION_PATH),
    legacyApiAdminBasePath: normalizeBasePath(legacyConfig.legacyApiAdminBasePath, DEFAULT_LEGACY_STICKER_ADMIN_API_BASE_PATH),
    legacyApiAdminSessionPath: normalizeBasePath(legacyConfig.legacyApiAdminSessionPath, DEFAULT_LEGACY_STICKER_ADMIN_API_SESSION_PATH),
    legacyApiAdminMultiSessionPath: normalizeBasePath(legacyConfig.legacyApiAdminMultiSessionPath, DEFAULT_LEGACY_STICKER_ADMIN_API_MULTI_SESSION_PATH),
  };
};

export const shouldHandleSystemAdminPath = (pathname, systemAdminConfig = null) => {
  const resolvedConfig = systemAdminConfig || {
    webPath: DEFAULT_USER_SYSTEM_ADMIN_WEB_PATH,
    legacyWebPath: DEFAULT_LEGACY_STICKER_ADMIN_WEB_PATH,
    apiAdminBasePath: DEFAULT_SYSTEM_ADMIN_API_BASE_PATH,
    apiAdminSessionPath: DEFAULT_SYSTEM_ADMIN_API_SESSION_PATH,
    apiAdminMultiSessionPath: DEFAULT_SYSTEM_ADMIN_API_MULTI_SESSION_PATH,
    legacyApiAdminBasePath: DEFAULT_LEGACY_STICKER_ADMIN_API_BASE_PATH,
    legacyApiAdminSessionPath: DEFAULT_LEGACY_STICKER_ADMIN_API_SESSION_PATH,
    legacyApiAdminMultiSessionPath: DEFAULT_LEGACY_STICKER_ADMIN_API_MULTI_SESSION_PATH,
  };

  if (startsWithPath(pathname, resolvedConfig.webPath)) return true;
  if (startsWithPath(pathname, resolvedConfig.legacyWebPath)) return true;
  if (startsWithPath(pathname, resolvedConfig.apiAdminBasePath)) return true;
  if (startsWithPath(pathname, resolvedConfig.legacyApiAdminBasePath)) return true;
  return false;
};

export const maybeHandleSystemAdminRequest = async (req, res, { pathname, url }) => {
  const controller = await loadSystemAdminController();
  if (typeof controller?.maybeHandleSystemAdminRequest !== 'function') return false;
  return controller.maybeHandleSystemAdminRequest(req, res, { pathname, url });
};
