import helmet from 'helmet';

import logger from '#logger';

const parseEnvBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseEnvList = (value) =>
  String(value || '')
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);

const toHttpOrigin = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.origin;
  } catch {
    return '';
  }
};

const HELMET_CSP_ENFORCE = parseEnvBool(process.env.HELMET_CONTENT_SECURITY_POLICY_ENABLED, true);
const BACKEND_BUILD_ID = String(process.env.OMNIZAP_BUILD_ID || '')
  .trim()
  .slice(0, 80);
const FRAME_SRC_EXTRA = Array.from(
  new Set(
    [
      ...parseEnvList(process.env.HELMET_CSP_FRAME_SRC_EXTRA),
      process.env.SYSTEM_ADMIN_GRAFANA_URL,
      process.env.GRAFANA_PUBLIC_URL,
    ]
      .map((item) => toHttpOrigin(item))
      .filter(Boolean),
  ),
);

const HELMET_CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'self'"],
  formAction: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com', 'https://cdn.tailwindcss.com'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
  connectSrc: ["'self'", 'https://accounts.google.com', 'https://oauth2.googleapis.com', 'https://api.github.com'],
  frameSrc: ["'self'", 'https://accounts.google.com', ...FRAME_SRC_EXTRA],
  workerSrc: ["'self'", 'blob:'],
  manifestSrc: ["'self'"],
};

const serializeCspDirectives = (directives = {}) =>
  Object.entries(directives)
    .map(([directive, values]) => {
      const kebabDirective = String(directive || '')
        .trim()
        .replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      if (!kebabDirective) return '';
      const normalizedValues = Array.isArray(values) ? values.map((value) => String(value || '').trim()).filter(Boolean) : [];
      return normalizedValues.length ? `${kebabDirective} ${normalizedValues.join(' ')}` : kebabDirective;
    })
    .filter(Boolean)
    .join('; ');

const FALLBACK_CSP_HEADER = serializeCspDirectives(HELMET_CSP_DIRECTIVES);

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: HELMET_CSP_DIRECTIVES,
    reportOnly: !HELMET_CSP_ENFORCE,
  },
  crossOriginEmbedderPolicy: false,
  // Mantemos permissões explícitas para browser APIs sensíveis.
  permissionsPolicy: {
    features: {
      geolocation: [],
      microphone: [],
      camera: [],
    },
  },
});

const applyFallbackHeaders = (res) => {
  if (!res.getHeader('X-Content-Type-Options')) res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!res.getHeader('X-Frame-Options')) res.setHeader('X-Frame-Options', 'DENY');
  if (!res.getHeader('Referrer-Policy')) res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!res.getHeader('Permissions-Policy')) res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (FALLBACK_CSP_HEADER && !res.getHeader('Content-Security-Policy') && !res.getHeader('Content-Security-Policy-Report-Only')) {
    const cspHeaderName = HELMET_CSP_ENFORCE ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
    res.setHeader(cspHeaderName, FALLBACK_CSP_HEADER);
  }
  if (BACKEND_BUILD_ID && !res.getHeader('X-Omnizap-Build')) res.setHeader('X-Omnizap-Build', BACKEND_BUILD_ID);
};

export const applySecurityHeaders = (req, res) => {
  try {
    const maybePromise = helmetMiddleware(req, res, () => {});
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((error) => {
        logger.warn('Falha ao aplicar helmet middleware.', {
          action: 'helmet_apply_failed',
          error: error?.message,
        });
      });
    }
  } catch (error) {
    logger.warn('Falha ao aplicar headers do helmet. Aplicando fallback.', {
      action: 'helmet_apply_failed',
      error: error?.message,
    });
  }

  applyFallbackHeaders(res);
};
