const MAX_PHONE_DIGITS = 20;
const DEFAULT_FALLBACK_NUMBER = '5511999999999';

const BOT_PHONE_ENV_KEYS = ['WHATSAPP_BOT_NUMBER', 'WHATSAPP_SUPPORT_NUMBER', 'BOT_NUMBER', 'BOT_PHONE_NUMBER', 'PHONE_NUMBER'];
const SUPPORT_PHONE_ENV_KEYS = ['WHATSAPP_SUPPORT_NUMBER', 'WHATSAPP_ADMIN_NUMBER', 'WHATSAPP_PUBLIC_CONTACT_NUMBER', 'EMAIL_BRAND_SUPPORT_PHONE', 'OWNER_NUMBER'];
const ADMIN_PHONE_ENV_KEYS = ['WHATSAPP_ADMIN_NUMBER', 'WHATSAPP_ADMIN_JID', 'USER_ADMIN', 'OWNER_NUMBER', 'WHATSAPP_SUPPORT_NUMBER', 'WHATSAPP_PUBLIC_CONTACT_NUMBER'];
const ADMIN_IDENTITY_ENV_KEYS = ['WHATSAPP_ADMIN_JID', 'USER_ADMIN', 'WHATSAPP_ADMIN_NUMBER'];

export const normalizePhoneDigits = (value, maxLength = MAX_PHONE_DIGITS) =>
  String(value || '')
    .replace(/\D+/g, '')
    .slice(0, Math.max(1, Number(maxLength) || MAX_PHONE_DIGITS));

export const isLikelyWhatsAppPhone = (value) => /^\d{10,15}$/.test(normalizePhoneDigits(value, 20));

const resolvePhoneFromEnvKeys = (keys, { fallback = '' } = {}) => {
  for (const envKey of keys) {
    const digits = normalizePhoneDigits(process.env[envKey] || '');
    if (isLikelyWhatsAppPhone(digits)) return digits;
  }

  const fallbackDigits = normalizePhoneDigits(fallback || '');
  if (isLikelyWhatsAppPhone(fallbackDigits)) return fallbackDigits;
  return '';
};

export const resolveBotPhoneFromEnv = ({ fallback = DEFAULT_FALLBACK_NUMBER } = {}) => resolvePhoneFromEnvKeys(BOT_PHONE_ENV_KEYS, { fallback });

export const resolveSupportPhoneFromEnv = ({ fallback = DEFAULT_FALLBACK_NUMBER } = {}) => resolvePhoneFromEnvKeys(SUPPORT_PHONE_ENV_KEYS, { fallback });

export const resolveAdminPhoneFromEnv = ({ fallback = DEFAULT_FALLBACK_NUMBER } = {}) => resolvePhoneFromEnvKeys(ADMIN_PHONE_ENV_KEYS, { fallback });

export const resolveAdminIdentityRawFromEnv = ({ fallback = '' } = {}) => {
  for (const envKey of ADMIN_IDENTITY_ENV_KEYS) {
    const value = String(process.env[envKey] || '').trim();
    if (value) return value;
  }
  return String(fallback || '').trim();
};
