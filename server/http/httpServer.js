import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import http from 'node:http';

import logger from '#logger';
import { getMetricsServerConfig, isMetricsEnabled, recordHttpRequest, resolveRouteGroup } from '../../app/observability/metrics.js';
import { applyCachePolicy } from '../middleware/cachePolicy.js';
import { applySensitiveRouteRateLimit } from '../middleware/endpointRateLimit.js';
import { applySecurityHeaders } from '../middleware/securityHeaders.js';
import { shouldHandleGrafanaProxyPath } from '../routes/observability/grafanaProxyRouter.js';
import { getIndexRouteConfigs, routeRequest } from '../routes/indexRouter.js';
import { parseRequestUrl, normalizeRequestId } from './requestContext.js';

let server = null;
let serverStarted = false;

const sanitizePathForLogs = (pathname) => {
  const rawPath = String(pathname || '').trim();
  if (!rawPath) return null;

  const marker = '/auth/password/recovery/session/';
  const lower = rawPath.toLowerCase();
  const markerIndex = lower.indexOf(marker);
  if (markerIndex < 0) return rawPath;

  const tokenStart = markerIndex + marker.length;
  const suffix = rawPath.slice(tokenStart);
  const nextSlashIndex = suffix.indexOf('/');
  if (nextSlashIndex < 0) {
    const rawSegment = String(suffix || '')
      .trim()
      .toLowerCase();
    if (rawSegment === 'request' || rawSegment === 'verify') {
      return rawPath;
    }
    return `${rawPath.slice(0, tokenStart)}[redacted]`;
  }
  return `${rawPath.slice(0, tokenStart)}[redacted]${suffix.slice(nextSlashIndex)}`;
};

export const startHttpServer = () => {
  if (!isMetricsEnabled() || serverStarted) return;

  const { host, port, path: metricsPath } = getMetricsServerConfig();

  server = http.createServer(async (req, res) => {
    const requestStartedAt = __timeNowMs();
    const requestId = normalizeRequestId(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', requestId);

    const parsedUrl = parseRequestUrl(req, host, port);
    const pathname = parsedUrl.pathname;

    let routeConfigs = null;
    try {
      routeConfigs = await getIndexRouteConfigs();
    } catch (error) {
      logger.error('Erro ao carregar configuracao de rotas.', {
        error: error?.message,
      });
    }

    let routeGroup = resolveRouteGroup({
      pathname,
      metricsPath,
      catalogConfig: routeConfigs?.stickerConfig || null,
      userConfig: routeConfigs?.userConfig || null,
      systemAdminConfig: routeConfigs?.systemAdminConfig || null,
    });
    const isGrafanaProxyRequest = shouldHandleGrafanaProxyPath(pathname, routeConfigs?.grafanaProxyConfig || null);

    res.once('finish', () => {
      recordHttpRequest({
        durationMs: __timeNowMs() - requestStartedAt,
        method: req.method,
        statusCode: res.statusCode,
        routeGroup,
      });
    });

    try {
      if (!isGrafanaProxyRequest) {
        applySecurityHeaders(req, res);
        applyCachePolicy(req, res, { pathname });
        const allowedByRateLimit = await applySensitiveRouteRateLimit(req, res, { pathname });
        if (!allowedByRateLimit) return;
      }

      await routeRequest(req, res, {
        pathname,
        url: parsedUrl,
        metricsPath,
        configs: routeConfigs,
      });

      routeGroup = resolveRouteGroup({
        pathname,
        metricsPath,
        catalogConfig: routeConfigs?.stickerConfig || null,
        userConfig: routeConfigs?.userConfig || null,
        systemAdminConfig: routeConfigs?.systemAdminConfig || null,
      });
    } catch (error) {
      logger.error('Falha ao processar request HTTP.', {
        path: sanitizePathForLogs(pathname),
        method: req.method,
        error: error?.message,
      });

      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  });

  server.listen(port, host, () => {
    serverStarted = true;
    logger.info('Servidor HTTP iniciado', {
      host,
      port,
      metrics_path: metricsPath,
    });

    getIndexRouteConfigs()
      .then(({ userConfig, systemAdminConfig, stickerConfig }) => {
        if (userConfig?.webPath) {
          logger.info('Rotas web de usuario habilitadas', {
            web_path: userConfig.webPath,
            api_base_path: userConfig.apiBasePath,
            host,
            port,
          });
        }

        if (systemAdminConfig?.webPath) {
          logger.info('Rotas system admin habilitadas', {
            web_path: systemAdminConfig.webPath,
            legacy_web_path: systemAdminConfig.legacyWebPath,
            api_admin_base_path: systemAdminConfig.apiAdminBasePath,
            host,
            port,
          });
        }

        if (stickerConfig?.enabled && stickerConfig?.webPath) {
          logger.info('Catalogo web de sticker packs habilitado', {
            web_path: stickerConfig.webPath,
            api_base_path: stickerConfig.apiBasePath,
            orphan_api_path: stickerConfig.orphanApiPath,
            data_public_path: stickerConfig.dataPublicPath,
            data_public_dir: stickerConfig.dataPublicDir,
            host,
            port,
          });
        }
      })
      .catch((error) => {
        logger.warn('Nao foi possivel carregar configuracao das rotas na inicializacao.', {
          error: error?.message,
        });
      });
  });

  server.on('error', (error) => {
    logger.error('Falha ao iniciar servidor HTTP', { error: error?.message });
  });
};

export const stopHttpServer = async () => {
  if (!serverStarted || !server) return;

  const current = server;
  server = null;
  serverStarted = false;
  await new Promise((resolve, reject) => {
    current.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};
