import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { executeQuery, TABLES } from '../../../database/index.js';
import { normalizeJid } from '../../config/index.js';
import { toWhatsAppPhoneDigits } from './whatsappLoginLinkService.js';

const parseEnvInt = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

const GOOGLE_LINK_CHECK_CACHE_TTL_MS = parseEnvInt(process.env.WHATSAPP_GOOGLE_LINK_CHECK_CACHE_TTL_MS, 60_000, 1_000, 10 * 60_000);
const googleLinkCheckCache = new Map();
let googleLinkTableMissingLogged = false;

const normalizeCacheKey = ({ ownerJid = '', ownerPhone = '' }) => {
  const normalizedOwnerJid = normalizeJid(ownerJid) || '';
  const normalizedOwnerPhone = toWhatsAppPhoneDigits(ownerPhone || ownerJid) || '';
  return `${normalizedOwnerJid}|${normalizedOwnerPhone}`;
};

const getCachedGoogleLinkStatus = (cacheKey) => {
  const cached = googleLinkCheckCache.get(cacheKey);
  if (!cached) return null;
  if (Number(cached.expiresAt || 0) <= __timeNowMs()) {
    googleLinkCheckCache.delete(cacheKey);
    return null;
  }
  return Boolean(cached.linked);
};

const setCachedGoogleLinkStatus = (cacheKey, linked) => {
  googleLinkCheckCache.set(cacheKey, {
    linked: Boolean(linked),
    expiresAt: __timeNowMs() + GOOGLE_LINK_CHECK_CACHE_TTL_MS,
  });
};

export const isWhatsAppUserLinkedToGoogleWebAccount = async ({ ownerJid = '', ownerPhone = '' } = {}) => {
  const normalizedOwnerJid = normalizeJid(ownerJid) || '';
  const normalizedOwnerPhone = toWhatsAppPhoneDigits(ownerPhone || ownerJid) || '';
  if (!normalizedOwnerJid && !normalizedOwnerPhone) return false;

  const cacheKey = normalizeCacheKey({
    ownerJid: normalizedOwnerJid,
    ownerPhone: normalizedOwnerPhone,
  });
  const cached = getCachedGoogleLinkStatus(cacheKey);
  if (cached !== null) return cached;

  const whereClauses = [];
  const params = [];
  if (normalizedOwnerJid) {
    whereClauses.push('owner_jid = ?');
    params.push(normalizedOwnerJid);
  }
  if (normalizedOwnerPhone) {
    whereClauses.push('owner_phone = ?');
    params.push(normalizedOwnerPhone);
  }

  const rows = await executeQuery(
    `SELECT google_sub
       FROM ${TABLES.STICKER_WEB_GOOGLE_USER}
      WHERE ${whereClauses.join(' OR ')}
      LIMIT 1`,
    params,
  ).catch((error) => {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      if (!googleLinkTableMissingLogged) {
        googleLinkTableMissingLogged = true;
      }
      return [];
    }
    throw error;
  });

  const linked = Array.isArray(rows) && rows.length > 0;
  setCachedGoogleLinkStatus(cacheKey, linked);
  return linked;
};
