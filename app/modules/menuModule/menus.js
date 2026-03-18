import logger from '#logger';
import { buildAnimeMenu, buildAiMenu, buildMediaMenu, buildMenuCaption, buildQuoteMenu, buildStatsMenu, buildStickerMenu, buildAdminMenu } from './common.js';
import { resolveDynamicMenuText } from './menuDynamicService.js';
import getImageBuffer from '../../utils/http/getImageBufferModule.js';
import { sendAndStore } from '../../services/messaging/messagePersistenceService.js';

const MENU_IMAGE_ENV = 'IMAGE_MENU';
const sanitizeLogValue = (value) =>
  String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const sendMenuImage = async (sock, remoteJid, messageInfo, expirationMessage, caption) => {
  const safeCaption = String(caption || '').trim() || 'Menu indisponível no momento.';
  const imageUrl = process.env[MENU_IMAGE_ENV];
  if (!imageUrl) {
    logger.warn('IMAGE_MENU environment variable not set. Sending plain-text menu fallback.', {
      action: 'menu_image_env_missing',
    });
    await sendAndStore(sock, remoteJid, { text: safeCaption }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  try {
    const imageBuffer = await getImageBuffer(imageUrl);
    await sendAndStore(
      sock,
      remoteJid,
      {
        image: imageBuffer,
        caption: safeCaption,
      },
      { quoted: messageInfo, ephemeralExpiration: expirationMessage },
    );
  } catch (error) {
    logger.error('Error fetching menu image.', {
      error: sanitizeLogValue(error?.message) || 'unknown_error',
    });
    await sendAndStore(sock, remoteJid, { text: safeCaption }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
  }
};

export async function handleMenuCommand(sock, remoteJid, messageInfo, expirationMessage, senderName, commandPrefix, args = []) {
  const dynamicCaption = await resolveDynamicMenuText({
    args,
    senderName,
    commandPrefix,
    remoteJid,
  });
  if (dynamicCaption) {
    await sendMenuImage(sock, remoteJid, messageInfo, expirationMessage, dynamicCaption.trim());
    return;
  }

  const category = args?.[0]?.toLowerCase();
  const categoryMap = new Map([
    ['figurinhas', (prefix) => buildStickerMenu(prefix)],
    ['sticker', (prefix) => buildStickerMenu(prefix)],
    ['stickers', (prefix) => buildStickerMenu(prefix)],
    ['midia', (prefix) => buildMediaMenu(prefix)],
    ['media', (prefix) => buildMediaMenu(prefix)],
    ['quote', (prefix) => buildQuoteMenu(prefix)],
    ['quotes', (prefix) => buildQuoteMenu(prefix)],
    ['ia', (prefix) => buildAiMenu(prefix)],
    ['ai', (prefix) => buildAiMenu(prefix)],
    ['stats', (prefix) => buildStatsMenu(prefix)],
    ['estatisticas', (prefix) => buildStatsMenu(prefix)],
    ['estatistica', (prefix) => buildStatsMenu(prefix)],
    ['anime', (prefix) => buildAnimeMenu(prefix)],
  ]);

  const buildCategory = categoryMap.get(category);
  const caption = buildCategory ? buildCategory(commandPrefix).trim() : buildMenuCaption(senderName, commandPrefix).trim();

  await sendMenuImage(sock, remoteJid, messageInfo, expirationMessage, caption);
}

export async function handleMenuAdmCommand(sock, remoteJid, messageInfo, expirationMessage, commandPrefix) {
  await sendMenuImage(sock, remoteJid, messageInfo, expirationMessage, buildAdminMenu(commandPrefix).trim());
}
