import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { getJidServer, getJidUser, normalizeJid } from '../../config/index.js';

const WHATSAPP_USER_SERVERS = new Set(['s.whatsapp.net', 'c.us', 'hosted']);
const DEFAULT_LOGIN_BASE_URL = 'https://omnizap.shop';
const SIGNING_SECRET = String(process.env.WHATSAPP_LOGIN_LINK_SECRET || '').trim();
const SIGNED_LINKS_ENABLED = Boolean(SIGNING_SECRET);
const REQUIRE_SIGNATURE = parseEnvBool(process.env.WHATSAPP_LOGIN_REQUIRE_SIGNATURE, SIGNED_LINKS_ENABLED);
const LOGIN_TTL_SECONDS = Math.max(60, Number(process.env.WHATSAPP_LOGIN_LINK_TTL_SECONDS) || 15 * 60);
const LOGIN_PATH = normalizeLoginPath(process.env.WHATSAPP_LOGIN_PATH || '/login/');

function parseEnvBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizeLoginPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '/login/';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function sanitizeTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function buildSignaturePayload(phoneDigits, tsSeconds) {
  return `${phoneDigits}.${tsSeconds}`;
}

function buildHintSignature(phoneDigits, tsSeconds) {
  if (!SIGNED_LINKS_ENABLED) return '';
  return createHmac('sha256', SIGNING_SECRET).update(buildSignaturePayload(phoneDigits, tsSeconds)).digest('hex');
}

function safeHexCompare(left, right) {
  const leftHex = String(left || '')
    .trim()
    .toLowerCase();
  const rightHex = String(right || '')
    .trim()
    .toLowerCase();
  if (!leftHex || !rightHex || leftHex.length !== rightHex.length) return false;

  try {
    const leftBuffer = Buffer.from(leftHex, 'hex');
    const rightBuffer = Buffer.from(rightHex, 'hex');
    if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function resolveLoginBaseUrl(explicitBaseUrl = '') {
  const candidates = [explicitBaseUrl, process.env.WHATSAPP_LOGIN_BASE_URL, process.env.SITE_ORIGIN, process.env.PUBLIC_WEB_BASE_URL, DEFAULT_LOGIN_BASE_URL];

  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      return `${url.origin}`;
    } catch (error) {
      void error;
    }
  }

  return DEFAULT_LOGIN_BASE_URL;
}

export const toWhatsAppPhoneDigits = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  if (raw.includes('@')) {
    const normalizedJid = normalizeJid(raw);
    const server = getJidServer(normalizedJid);
    if (!WHATSAPP_USER_SERVERS.has(server)) return '';
    const jidUser = String(getJidUser(normalizedJid) || '').split(':')[0];
    const digits = normalizePhoneDigits(jidUser);
    return digits.length >= 10 && digits.length <= 15 ? digits : '';
  }

  const digits = normalizePhoneDigits(raw);
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
};

export const toWhatsAppOwnerJid = (value) => {
  const digits = toWhatsAppPhoneDigits(value);
  if (!digits) return '';
  return normalizeJid(`${digits}@s.whatsapp.net`) || '';
};

export const buildWhatsAppLoginHint = (value, { nowMs = __timeNowMs() } = {}) => {
  const phoneDigits = toWhatsAppPhoneDigits(value);
  if (!phoneDigits) return null;

  const tsSeconds = Math.floor(nowMs / 1000);
  const hint = {
    wa: phoneDigits,
    wa_ts: String(tsSeconds),
  };

  const signature = buildHintSignature(phoneDigits, tsSeconds);
  if (signature) hint.wa_sig = signature;

  return hint;
};

export const buildWhatsAppGoogleLoginUrl = ({ userId, baseUrl } = {}) => {
  const hint = buildWhatsAppLoginHint(userId);
  if (!hint) return '';

  const root = resolveLoginBaseUrl(baseUrl);
  const url = new URL(LOGIN_PATH, root);
  url.searchParams.set('wa', hint.wa);
  url.searchParams.set('wa_ts', hint.wa_ts);
  if (hint.wa_sig) url.searchParams.set('wa_sig', hint.wa_sig);
  return url.toString();
};

export const extractWhatsAppLoginHint = (payload = {}) => {
  const source = payload && typeof payload === 'object' ? payload : {};
  const nested = source.whatsapp_login && typeof source.whatsapp_login === 'object' ? source.whatsapp_login : {};
  return {
    wa: String(source.wa ?? source.whatsapp_phone ?? source.owner_phone ?? nested.wa ?? nested.phone ?? '').trim(),
    wa_ts: String(source.wa_ts ?? source.whatsapp_ts ?? source.owner_phone_ts ?? nested.wa_ts ?? nested.ts ?? '').trim(),
    wa_sig: String(source.wa_sig ?? source.whatsapp_sig ?? source.owner_phone_sig ?? nested.wa_sig ?? nested.sig ?? '').trim(),
  };
};

export const resolveWhatsAppOwnerJidFromLoginPayload = (payload, { nowMs = __timeNowMs() } = {}) => {
  const hint = extractWhatsAppLoginHint(payload);
  const hasPayload = Boolean(hint.wa || hint.wa_ts || hint.wa_sig);
  if (!hasPayload) {
    return {
      hasPayload: false,
      ownerJid: '',
      verified: false,
      signed: false,
      reason: '',
    };
  }

  const phoneDigits = toWhatsAppPhoneDigits(hint.wa);
  const ownerJid = toWhatsAppOwnerJid(phoneDigits);
  if (!ownerJid) {
    return {
      hasPayload: true,
      ownerJid: '',
      verified: false,
      signed: false,
      reason: 'invalid_phone',
    };
  }

  if (!SIGNED_LINKS_ENABLED) {
    return {
      hasPayload: true,
      ownerJid,
      verified: false,
      signed: false,
      reason: '',
    };
  }

  const tsSeconds = sanitizeTimestamp(hint.wa_ts);
  const hasSignature = Boolean(hint.wa_sig);

  if (!tsSeconds || !hasSignature) {
    if (REQUIRE_SIGNATURE) {
      return {
        hasPayload: true,
        ownerJid: '',
        verified: false,
        signed: false,
        reason: 'missing_signature',
      };
    }
    return {
      hasPayload: true,
      ownerJid,
      verified: false,
      signed: false,
      reason: '',
    };
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - tsSeconds) > LOGIN_TTL_SECONDS) {
    return {
      hasPayload: true,
      ownerJid: '',
      verified: false,
      signed: true,
      reason: 'expired',
    };
  }

  const expectedSignature = buildHintSignature(phoneDigits, tsSeconds);
  if (!safeHexCompare(expectedSignature, hint.wa_sig)) {
    return {
      hasPayload: true,
      ownerJid: '',
      verified: false,
      signed: true,
      reason: 'invalid_signature',
    };
  }

  return {
    hasPayload: true,
    ownerJid,
    verified: true,
    signed: true,
    reason: '',
  };
};
