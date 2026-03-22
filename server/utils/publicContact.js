import { isLikelyWhatsAppPhone, normalizePhoneDigits, resolveSupportPhoneFromEnv } from '../../utils/whatsapp/contactEnv.js';

const FALLBACK_WHATSAPP_SUPPORT_NUMBER = '5511999999999';

export { normalizePhoneDigits };

export const resolvePublicWhatsappNumber = ({ fallback = FALLBACK_WHATSAPP_SUPPORT_NUMBER } = {}) => resolveSupportPhoneFromEnv({ fallback });

export const formatWhatsappDisplay = (value) => {
  const digits = normalizePhoneDigits(value || '');
  if (!isLikelyWhatsAppPhone(digits)) return '';

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
  if (!isLikelyWhatsAppPhone(digits)) return '';

  const normalizedText = String(text || '').trim();
  if (!normalizedText) return `https://wa.me/${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(normalizedText)}`;
};
