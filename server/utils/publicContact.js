const MAX_PHONE_DIGITS = 20;
const FALLBACK_WHATSAPP_SUPPORT_NUMBER = '5511999999999';

const PUBLIC_WHATSAPP_ENV_KEYS = [
  'WHATSAPP_PUBLIC_CONTACT_NUMBER',
  'WHATSAPP_SUPPORT_NUMBER',
  'EMAIL_BRAND_SUPPORT_PHONE',
  'EMAIL_WELCOME_BOT_PHONE',
  'WHATSAPP_BOT_NUMBER',
  'BOT_NUMBER',
  'BOT_PHONE_NUMBER',
  'PHONE_NUMBER',
  'OWNER_NUMBER',
];

export const normalizePhoneDigits = (value, maxLength = MAX_PHONE_DIGITS) =>
  String(value || '')
    .replace(/\D+/g, '')
    .slice(0, Math.max(1, Number(maxLength) || MAX_PHONE_DIGITS));

const isLikelyPhoneDigits = (value) => /^\d{10,15}$/.test(String(value || ''));

export const resolvePublicWhatsappNumber = ({ fallback = FALLBACK_WHATSAPP_SUPPORT_NUMBER } = {}) => {
  for (const envKey of PUBLIC_WHATSAPP_ENV_KEYS) {
    const digits = normalizePhoneDigits(process.env[envKey] || '');
    if (isLikelyPhoneDigits(digits)) return digits;
  }

  const fallbackDigits = normalizePhoneDigits(fallback || '');
  if (isLikelyPhoneDigits(fallbackDigits)) return fallbackDigits;
  return '';
};

export const formatWhatsappDisplay = (value) => {
  const digits = normalizePhoneDigits(value || '');
  if (!isLikelyPhoneDigits(digits)) return '';

  if (digits.startsWith('55') && digits.length === 12) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }

  if (digits.startsWith('55') && digits.length === 13) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }

  return `+${digits}`;
};

export const buildWhatsappUrl = (value, text = '') => {
  const digits = normalizePhoneDigits(value || '');
  if (!isLikelyPhoneDigits(digits)) return '';

  const normalizedText = String(text || '').trim();
  if (!normalizedText) return `https://wa.me/${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(normalizedText)}`;
};
