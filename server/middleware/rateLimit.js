import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { resolveClientIp } from '../http/clientIp.js';

const rateLimitBuckets = new Map();
let pruneAt = 0;

const parseNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

const pruneBuckets = (windowMs, nowMs) => {
  if (nowMs - pruneAt < windowMs) return;
  pruneAt = nowMs;

  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (nowMs - bucket.start > windowMs) {
      rateLimitBuckets.delete(key);
    }
  }
};

const sendTooManyRequests = (req, res, retryAfterSeconds) => {
  if (res.writableEnded) return;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Retry-After', String(Math.max(1, retryAfterSeconds)));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify({ error: 'Too Many Requests' }));
};

export const createRateLimit = ({ windowMs = 60_000, max = 60, keyPrefix = 'global' } = {}) => {
  const safeWindowMs = parseNumber(windowMs, 60_000, 1_000, 60 * 60 * 1000);
  const safeMax = parseNumber(max, 60, 1, 100_000);
  const safeKeyPrefix = String(keyPrefix || 'global').trim() || 'global';

  return (req, res) => {
    const nowMs = __timeNowMs();
    pruneBuckets(safeWindowMs, nowMs);

    const ip = resolveClientIp(req);
    const key = `${safeKeyPrefix}:${ip}`;
    const existing = rateLimitBuckets.get(key);

    if (!existing || nowMs - existing.start > safeWindowMs) {
      rateLimitBuckets.set(key, { start: nowMs, count: 1 });
      return true;
    }

    existing.count += 1;
    if (existing.count <= safeMax) return true;

    const retryAfterSeconds = Math.ceil((safeWindowMs - (nowMs - existing.start)) / 1000);
    sendTooManyRequests(req, res, retryAfterSeconds);
    return false;
  };
};

export const createAdminApiRateLimit = () => {
  const windowMs = parseNumber(process.env.ADMIN_RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 60 * 60 * 1000);
  const max = parseNumber(process.env.ADMIN_RATE_LIMIT_MAX, 30, 1, 100_000);
  return createRateLimit({
    windowMs,
    max,
    keyPrefix: 'admin_api',
  });
};
