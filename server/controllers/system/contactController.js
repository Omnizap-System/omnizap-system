import logger from '#logger';
import { getActiveSocket, getAdminPhone, getAdminRawValue, getJidUser, resolveAdminJid, resolveBotJid, extractUserIdInfo, resolveUserId } from '../../../app/config/index.js';

const PACK_COMMAND_PREFIX = String(process.env.COMMAND_PREFIX || '/').trim() || '/';

const normalizePhoneDigits = (value) => String(value || '').replace(/\D+/g, '');

const isPlausibleWhatsAppPhone = (value) => {
  const digits = normalizePhoneDigits(value);
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
};

const resolveActiveSocketBotJid = (activeSocket) => {
  if (!activeSocket) return '';
  const candidates = [activeSocket?.user?.id, activeSocket?.authState?.creds?.me?.id, activeSocket?.authState?.creds?.me?.lid];
  for (const candidate of candidates) {
    const resolved = resolveBotJid(candidate) || '';
    if (resolved) return resolved;
  }
  return '';
};

export const resolveCatalogBotPhone = () => {
  const activeSocket = getActiveSocket();
  const botJid = resolveActiveSocketBotJid(activeSocket);
  const jidUser = botJid ? getJidUser(botJid) : null;
  const fromSocket = normalizePhoneDigits(jidUser || '');

  if (fromSocket && fromSocket.length >= 10) {
    return fromSocket;
  }

  const envCandidates = [process.env.WHATSAPP_BOT_NUMBER, process.env.WHATSAPP_PUBLIC_CONTACT_NUMBER, process.env.BOT_NUMBER, process.env.PHONE_NUMBER, process.env.BOT_PHONE_NUMBER, process.env.USER_ADMIN];

  for (const candidate of envCandidates) {
    const digits = normalizePhoneDigits(candidate || '');
    if (digits && digits.length >= 10 && digits.length <= 15) {
      return digits;
    }
  }

  logger.warn('Nao foi possivel resolver o numero do bot para contato.', {
    action: 'resolve_bot_phone_failed',
    socketActive: !!activeSocket,
    botJid: botJid || null,
  });

  return '';
};

const resolveSupportAdminPhone = async () => {
  const adminRaw = String(getAdminRawValue() || '').trim();

  if (adminRaw) {
    try {
      const resolvedFromLidMap = await resolveUserId(extractUserIdInfo(adminRaw));
      const resolvedPhoneFromLidMap = isPlausibleWhatsAppPhone(getJidUser(resolvedFromLidMap || ''));
      if (resolvedPhoneFromLidMap) return resolvedPhoneFromLidMap;
    } catch {
      // Ignore and fallback to other admin sources.
    }
  }

  try {
    const resolvedAdminJid = await resolveAdminJid();
    const resolvedPhone = isPlausibleWhatsAppPhone(getJidUser(resolvedAdminJid || ''));
    if (resolvedPhone) return resolvedPhone;
  } catch {
    // Ignore and fallback to static admin phone sources.
  }

  const rawPhone = isPlausibleWhatsAppPhone(getJidUser(adminRaw) || adminRaw);
  if (rawPhone) return rawPhone;

  const adminPhone = isPlausibleWhatsAppPhone(getAdminPhone() || '');
  if (adminPhone) return adminPhone;

  const candidates = [process.env.WHATSAPP_PUBLIC_CONTACT_NUMBER, process.env.WHATSAPP_SUPPORT_NUMBER, process.env.OWNER_NUMBER, process.env.USER_ADMIN];

  for (const candidate of candidates) {
    const digits = isPlausibleWhatsAppPhone(getJidUser(candidate || '') || candidate);
    if (digits) return digits;
  }

  return '';
};

export const buildSupportInfo = async () => {
  const phone = await resolveSupportAdminPhone();
  if (!phone) return null;
  const text = String(process.env.STICKER_SUPPORT_WHATSAPP_TEXT || 'Olá! Preciso de suporte no catálogo OmniZap.').trim();
  return {
    phone,
    text,
    url: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`,
  };
};

export const buildBotContactInfo = () => {
  const phone = String(resolveCatalogBotPhone() || '').replace(/\D+/g, '');
  if (!phone) return null;
  const loginText = String(process.env.WHATSAPP_LOGIN_TRIGGER || 'iniciar').trim() || 'iniciar';
  const menuText = `${PACK_COMMAND_PREFIX}menu`;
  const buildUrl = (text) => `https://api.whatsapp.com/send/?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(String(text || '').trim())}&type=custom_url&app_absent=0`;

  return {
    phone,
    login_text: loginText,
    menu_text: menuText,
    urls: {
      login: buildUrl(loginText),
      menu: buildUrl(menuText),
    },
  };
};
