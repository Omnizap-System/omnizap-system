import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import logger from '#logger';

const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const DEFAULT_GRAFANA_PROXY_BASE_PATH = '/api/grafana';
const DEFAULT_GRAFANA_PROXY_LEGACY_BASE_PATH = '/grafana';
const DEFAULT_GRAFANA_PROXY_TIMEOUT_MS = 15000;

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

const parseEnvBool = (value, fallback = true) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseEnvNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
};

const normalizeTargetUrl = (rawUrl) => {
  const raw = String(rawUrl || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = String(parsed.pathname || '/').replace(/\/+$/, '') || '/';
    return parsed;
  } catch {
    return null;
  }
};

const normalizeHeaderValue = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).join(', ');
  return String(value || '').trim();
};

const getDefaultTargetUrl = () => {
  const port = parseEnvNumber(process.env.GRAFANA_PORT, 3003);
  return `http://127.0.0.1:${port}`;
};

const joinUrlPath = (leftPath, rightPath) => {
  const left = String(leftPath || '').replace(/\/+$/, '');
  const right = String(rightPath || '').replace(/^\/+/, '');
  if (!left) return `/${right}`.replace(/\/{2,}/g, '/');
  if (!right) return left.startsWith('/') ? left : `/${left}`;
  const joined = `${left}/${right}`.replace(/\/{2,}/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
};

const buildUpstreamPath = ({ pathname, search = '', matchedBasePath, upstreamBasePath, canonicalBasePath }) => {
  const suffix = pathname === matchedBasePath ? '' : pathname.slice(matchedBasePath.length);
  const normalizedSuffix = suffix ? (suffix.startsWith('/') ? suffix : `/${suffix}`) : '';
  const canonicalPath = `${canonicalBasePath}${normalizedSuffix}` || canonicalBasePath;
  const path = joinUrlPath(upstreamBasePath === '/' ? '' : upstreamBasePath, canonicalPath);
  return `${path}${search || ''}`;
};

const getMatchedBasePath = (pathname, config) => {
  if (!config?.enabled) return null;
  if (startsWithPath(pathname, config.basePath)) return config.basePath;
  if (config.legacyBasePath && startsWithPath(pathname, config.legacyBasePath)) return config.legacyBasePath;
  return null;
};

const copyResponseHeaders = (res, upstreamHeaders = {}) => {
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    const lower = String(name || '').toLowerCase();
    if (!lower || HOP_BY_HOP_HEADERS.has(lower)) continue;
    res.setHeader(name, value);
  }
};

const buildUpstreamHeaders = (req, { matchedBasePath, target }) => {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (value === undefined) continue;
    const lower = String(name || '').toLowerCase();
    if (!lower || lower === 'host' || HOP_BY_HOP_HEADERS.has(lower)) continue;
    headers[lower] = value;
  }

  const incomingForwardedFor = normalizeHeaderValue(req.headers?.['x-forwarded-for']);
  const remoteAddress = String(req.socket?.remoteAddress || '').trim();
  const forwardedFor = [incomingForwardedFor, remoteAddress].filter(Boolean).join(', ');
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

  const forwardedProto = normalizeHeaderValue(req.headers?.['x-forwarded-proto']) || (req.socket?.encrypted ? 'https' : 'http');
  headers['x-forwarded-proto'] = forwardedProto;

  const incomingHost = normalizeHeaderValue(req.headers?.host);
  const forwardedHost = normalizeHeaderValue(req.headers?.['x-forwarded-host']) || incomingHost;
  if (forwardedHost) headers['x-forwarded-host'] = forwardedHost;

  headers['x-forwarded-prefix'] = matchedBasePath;
  headers.host = incomingHost || target.host;
  return headers;
};

const pipeToUpstream = ({ req, res, target, targetPathWithQuery, timeoutMs, headers }) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finalize = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    const transport = target.protocol === 'https:' ? https : http;
    const upstreamReq = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: targetPathWithQuery,
        headers,
      },
      (upstreamRes) => {
        res.statusCode = Number(upstreamRes.statusCode) || 502;
        if (upstreamRes.statusMessage) res.statusMessage = upstreamRes.statusMessage;
        copyResponseHeaders(res, upstreamRes.headers);

        if (String(req.method || '').toUpperCase() === 'HEAD') {
          upstreamRes.resume();
          upstreamRes.once('end', () => {
            if (!res.writableEnded) res.end();
            finalize();
          });
          upstreamRes.once('error', finalize);
          return;
        }

        upstreamRes.once('error', finalize);
        res.once('error', finalize);
        upstreamRes.pipe(res);
        upstreamRes.once('end', finalize);
      },
    );

    upstreamReq.setTimeout(timeoutMs, () => {
      upstreamReq.destroy(new Error(`Grafana proxy timeout (${timeoutMs}ms)`));
    });

    upstreamReq.once('error', finalize);
    req.once('error', (error) => upstreamReq.destroy(error));
    req.once('aborted', () => upstreamReq.destroy(new Error('Client aborted request')));

    if (['GET', 'HEAD'].includes(String(req.method || '').toUpperCase())) {
      upstreamReq.end();
      return;
    }

    req.pipe(upstreamReq);
  });

export const getGrafanaProxyRouterConfig = () => {
  const enabled = parseEnvBool(process.env.GRAFANA_PROXY_ENABLED, true);
  const basePath = normalizeBasePath(process.env.GRAFANA_PROXY_BASE_PATH, DEFAULT_GRAFANA_PROXY_BASE_PATH);
  const legacyBasePath = normalizeBasePath(process.env.GRAFANA_PROXY_LEGACY_BASE_PATH, DEFAULT_GRAFANA_PROXY_LEGACY_BASE_PATH);
  const timeoutMs = parseEnvNumber(process.env.GRAFANA_PROXY_TIMEOUT_MS, DEFAULT_GRAFANA_PROXY_TIMEOUT_MS);
  const target = normalizeTargetUrl(process.env.GRAFANA_PROXY_TARGET_URL || getDefaultTargetUrl());

  return {
    enabled: Boolean(enabled && target),
    basePath,
    legacyBasePath,
    timeoutMs,
    target,
  };
};

export const shouldHandleGrafanaProxyPath = (pathname, config = null) => Boolean(getMatchedBasePath(pathname, config || getGrafanaProxyRouterConfig()));

const sendProxyError = (req, res, message) => {
  if (res.writableEnded) return;
  res.statusCode = 502;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify({ error: message }));
};

export const maybeHandleGrafanaProxyRequest = async (req, res, { pathname, url, config = null } = {}) => {
  const resolvedConfig = config || getGrafanaProxyRouterConfig();
  const matchedBasePath = getMatchedBasePath(pathname, resolvedConfig);
  if (!matchedBasePath) return false;

  if (!resolvedConfig?.target) {
    sendProxyError(req, res, 'Grafana proxy indisponivel.');
    return true;
  }

  const targetPathWithQuery = buildUpstreamPath({
    pathname,
    search: url?.search || '',
    matchedBasePath,
    upstreamBasePath: resolvedConfig.target.pathname || '/',
    canonicalBasePath: resolvedConfig.basePath,
  });

  try {
    const headers = buildUpstreamHeaders(req, { matchedBasePath, target: resolvedConfig.target });
    await pipeToUpstream({
      req,
      res,
      target: resolvedConfig.target,
      targetPathWithQuery,
      timeoutMs: resolvedConfig.timeoutMs,
      headers,
    });
  } catch (error) {
    logger.warn('Falha ao encaminhar request para o Grafana.', {
      action: 'grafana_proxy_failed',
      path: pathname,
      method: req.method,
      target_path: targetPathWithQuery,
      error: error?.message,
    });
    sendProxyError(req, res, 'Grafana indisponivel no momento.');
  }

  return true;
};
