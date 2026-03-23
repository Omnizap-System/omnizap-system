import path from 'node:path';

import { maybeHandleMetricsRequest } from './metrics/metricsRouter.js';
import { maybeHandleHealthRequest, shouldHandleHealthPath } from './health/healthRouter.js';
import { getEmailAutomationRouterConfig, maybeHandleEmailAutomationRequest, shouldHandleEmailAutomationPath } from './email/emailAutomationRouter.js';
import { getPaymentsRouterConfig, maybeHandlePaymentsRequest, shouldHandlePaymentsPath } from './payments/paymentsRouter.js';
import { buildUserApiPaths, getUserRouterConfig, maybeHandleUserRequest, shouldHandleUserPath } from './user/userRouter.js';
import { getSystemAdminRouterConfig, maybeHandleSystemAdminRequest, shouldHandleSystemAdminPath } from './admin/systemAdminRouter.js';
import { getStickerSiteRouterConfig, maybeHandleStickerSiteRequest, shouldHandleStickerSitePath } from './sticker/stickerSiteRouter.js';
import { getStickerDataRouterConfig, maybeHandleStickerDataRequest, shouldHandleStickerDataPath } from './sticker/stickerDataRouter.js';
import { getStickerApiRouterConfig, maybeHandleStickerApiRequest, shouldHandleStickerApiPath } from './sticker/stickerApiRouter.js';
import { maybeHandleStaticPageRequest, shouldHandleStaticPagePath } from './static/staticPageRouter.js';
import { getGrafanaProxyRouterConfig, maybeHandleGrafanaProxyRequest, shouldHandleGrafanaProxyPath } from './observability/grafanaProxyRouter.js';

const startsWithPath = (pathname, prefix) => {
  if (!pathname || !prefix) return false;
  if (pathname === prefix) return true;
  return pathname.startsWith(`${prefix}/`);
};

const normalizeBasePath = (value, fallback) => {
  const raw = String(value || '').trim() || fallback;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const withoutTrailingSlash = withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
  return withoutTrailingSlash || fallback;
};

const sendNotFound = (req, res) => {
  if (res.writableEnded) return true;
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(JSON.stringify({ error: 'Not Found' }));
  return true;
};

let indexRouteConfigsPromise = null;

const loadUserConfigSafe = async () => {
  try {
    return await getUserRouterConfig();
  } catch {
    return {
      webPath: '/user',
      passwordResetWebPath: '/user/password-reset',
      apiBasePath: '/api',
      legacyApiBasePath: '/api/sticker-packs',
    };
  }
};

const loadSystemAdminConfigSafe = async () => {
  try {
    return await getSystemAdminRouterConfig();
  } catch {
    return {
      webPath: '/user/systemadm',
      legacyWebPath: '/stickers/admin',
      apiAdminBasePath: '/api/admin',
      apiAdminSessionPath: '/api/admin/session',
      legacyApiAdminBasePath: '/api/sticker-packs/admin',
      legacyApiAdminSessionPath: '/api/sticker-packs/admin/session',
    };
  }
};

const loadEmailAutomationConfigSafe = async () => {
  try {
    return await getEmailAutomationRouterConfig();
  } catch {
    return {
      apiBasePath: '/api/email',
    };
  }
};

const loadPaymentsConfigSafe = async () => {
  try {
    return await getPaymentsRouterConfig();
  } catch {
    return {
      apiBasePath: '/api/payments',
    };
  }
};

const loadStickerSiteConfigSafe = async () => {
  try {
    return await getStickerSiteRouterConfig();
  } catch {
    return {
      enabled: true,
      webPath: '/stickers',
      apiBasePath: '/api/sticker-packs',
      orphanApiPath: '/api/sticker-packs/orphan-stickers',
      dataPublicPath: '/data',
      dataPublicDir: path.resolve(process.cwd(), 'data'),
    };
  }
};

const loadStickerDataConfigSafe = async () => {
  try {
    return await getStickerDataRouterConfig();
  } catch {
    return {
      dataPublicPath: '/data',
      dataPublicDir: path.resolve(process.cwd(), 'data'),
    };
  }
};

const loadStickerApiConfigSafe = async () => {
  try {
    return await getStickerApiRouterConfig();
  } catch {
    return {
      apiBasePath: '/api/sticker-packs',
      marketplaceStatsPath: '/api/marketplace/stats',
    };
  }
};

const loadGrafanaProxyConfigSafe = async () => {
  try {
    return getGrafanaProxyRouterConfig();
  } catch {
    return {
      enabled: false,
      basePath: '/api/grafana',
      legacyBasePath: '/grafana',
      timeoutMs: 15000,
      target: null,
    };
  }
};

export const getIndexRouteConfigs = async () => {
  if (!indexRouteConfigsPromise) {
    indexRouteConfigsPromise = Promise.all([loadUserConfigSafe(), loadSystemAdminConfigSafe(), loadEmailAutomationConfigSafe(), loadPaymentsConfigSafe(), loadStickerSiteConfigSafe(), loadStickerDataConfigSafe(), loadStickerApiConfigSafe(), loadGrafanaProxyConfigSafe()]).then(([userConfig, systemAdminConfig, emailAutomationConfig, paymentsConfig, stickerSiteConfig, stickerDataConfig, stickerApiConfig, grafanaProxyConfig]) => ({
      userConfig,
      systemAdminConfig,
      emailAutomationConfig,
      paymentsConfig,
      grafanaProxyConfig,
      stickerConfig: {
        ...stickerSiteConfig,
        ...stickerDataConfig,
        ...stickerApiConfig,
      },
    }));
  }

  return indexRouteConfigsPromise;
};

const shouldHandleSystemAdminStep = (pathname, systemAdminConfig) => shouldHandleSystemAdminPath(pathname, systemAdminConfig);

const shouldHandleUserStep = (pathname, userConfig) => shouldHandleUserPath(pathname, userConfig);

const shouldHandleMetricsStep = (pathname, metricsPath) => startsWithPath(pathname, normalizeBasePath(metricsPath, '/metrics'));

export const routeRequest = async (req, res, { pathname, url, metricsPath = '/metrics', configs = null } = {}) => {
  const resolvedConfigs = configs || (await getIndexRouteConfigs());
  const userConfig = resolvedConfigs?.userConfig || null;
  const systemAdminConfig = resolvedConfigs?.systemAdminConfig || null;
  const emailAutomationConfig = resolvedConfigs?.emailAutomationConfig || null;
  const paymentsConfig = resolvedConfigs?.paymentsConfig || null;
  const grafanaProxyConfig = resolvedConfigs?.grafanaProxyConfig || null;
  const stickerConfig = resolvedConfigs?.stickerConfig || null;

  // 1) Metrics
  if (shouldHandleMetricsStep(pathname, metricsPath)) {
    const handled = await maybeHandleMetricsRequest(req, res, { pathname, metricsPath });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  // 2) Health checks
  if (shouldHandleHealthPath(pathname)) {
    const handled = await maybeHandleHealthRequest(req, res, { pathname });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  // 3) Email automation API
  if (shouldHandleEmailAutomationPath(pathname, emailAutomationConfig)) {
    const handled = await maybeHandleEmailAutomationRequest(req, res, { pathname, url });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  // 4) Payments API
  if (shouldHandlePaymentsPath(pathname, paymentsConfig)) {
    const handled = await maybeHandlePaymentsRequest(req, res, { pathname, url });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  // 5) Grafana proxy (/api/grafana e alias /grafana)
  if (shouldHandleGrafanaProxyPath(pathname, grafanaProxyConfig)) {
    const handled = await maybeHandleGrafanaProxyRequest(req, res, { pathname, url, config: grafanaProxyConfig });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  // 6) User
  const systemAdminCandidate = shouldHandleSystemAdminStep(pathname, systemAdminConfig);
  if (shouldHandleUserStep(pathname, userConfig)) {
    const handled = await maybeHandleUserRequest(req, res, { pathname, url });
    if (handled) return true;

    // Permite /user/systemadm continuar para o router de admin.
    if (!systemAdminCandidate) return sendNotFound(req, res);
  }

  // 7) System admin + legacy /stickers/admin
  if (systemAdminCandidate) {
    const handled = await maybeHandleSystemAdminRequest(req, res, { pathname, url });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  // 8) Sticker catalog apenas nos prefixes permitidos
  if (shouldHandleStickerSitePath(pathname, stickerConfig)) {
    const handled = await maybeHandleStickerSiteRequest(req, res, { pathname, url });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  if (shouldHandleStickerDataPath(pathname, stickerConfig)) {
    const handled = await maybeHandleStickerDataRequest(req, res, {
      pathname,
      config: {
        dataPublicPath: stickerConfig?.dataPublicPath,
        dataPublicDir: stickerConfig?.dataPublicDir,
      },
    });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  if (shouldHandleStickerApiPath(pathname, stickerConfig)) {
    const handled = await maybeHandleStickerApiRequest(req, res, {
      pathname,
      url,
      config: {
        apiBasePath: stickerConfig?.apiBasePath,
        marketplaceStatsPath: stickerConfig?.marketplaceStatsPath,
      },
    });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  // 9) Paginas estaticas (templates em public/pages)
  if (shouldHandleStaticPagePath(pathname)) {
    const handled = await maybeHandleStaticPageRequest(req, res, { pathname });
    if (handled) return true;
    return sendNotFound(req, res);
  }

  // 10) 404 global
  return sendNotFound(req, res);
};

export const getUserApiPathsFromConfig = (userConfig = null) => {
  const apiBasePath = userConfig?.apiBasePath || '/api';
  const paths = new Set(buildUserApiPaths(apiBasePath));
  const legacyApiBasePath = userConfig?.legacyApiBasePath || '/api/sticker-packs';
  for (const path of buildUserApiPaths(legacyApiBasePath, { legacyCompatible: true })) {
    paths.add(path);
  }
  return paths;
};
