import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
/* eslint-disable no-unused-vars */
/* eslint-disable no-useless-escape */
import { fetchLatestBaileysVersion, downloadContentFromMessage, jidNormalizedUser, jidEncode, jidDecode, areJidsSameUser, normalizeMessageContent, isJidMetaAI, isPnUser, isLidUser, isJidBroadcast, isJidGroup, isJidStatusBroadcast, isJidNewsletter, isHostedPnUser, isHostedLidUser, isJidBot, SERVER_JID, PSA_WID, STORIES_JID, META_AI_JID, delay } from '@whiskeysockets/baileys';

import { baileysConfigLogger as logger } from './loggerConfig.js';
import { executeQuery, TABLES } from '../../database/index.js';
import { buildRowPlaceholders, createFlushRunner } from '../services/infra/queueUtils.js';
import { recordError, setQueueDepth } from '../observability/metrics.js';
import { readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/**
 * Utilitários centrais de integração com Baileys.
 *
 * Responsabilidades deste módulo:
 * - validar/normalizar JIDs e tipos de presença;
 * - encapsular chamadas seguras no socket ativo;
 * - extrair/detectar mídia em mensagens;
 * - resolver mapeamento LID <-> JID com cache e persistência.
 */

/**
 * @typedef {import('@whiskeysockets/baileys').WASocket} BaileysSocket
 * @typedef {import('@whiskeysockets/baileys').WAMessage} BaileysMessage
 * @typedef {import('@whiskeysockets/baileys').WAProto.IMessage} BaileysProtoMessage
 * @typedef {'lid'|'pn'} AddressingMode
 * @typedef {{includeAllTypes?: boolean, includeQuoted?: boolean, includeUnknown?: boolean}} MediaExtractionOptions
 * @typedef {{
 *   mediaType: string,
 *   mediaKey: Record<string, any>,
 *   messageKey: string,
 *   isQuoted: boolean,
 *   isBinary: boolean,
 *   isUnknownType?: boolean,
 *   hasUrl: boolean,
 *   hasDirectPath: boolean,
 *   hasMediaKey: boolean,
 *   hasFileEncSha256: boolean,
 *   mimetype: string|null,
 *   fileLength: number|string|null,
 *   fileName: string|null,
 *   caption: string|null
 * }} MediaEntry
 * @typedef {{
 *   mediaType: string,
 *   mediaKey: Record<string, any>,
 *   isQuoted: boolean,
 *   details: {
 *     messageKey: string,
 *     isBinary: boolean,
 *     isUnknownType?: boolean,
 *     hasUrl: boolean,
 *     hasDirectPath: boolean,
 *     hasMediaKey: boolean,
 *     hasFileEncSha256: boolean,
 *     mimetype: string|null,
 *     fileLength: number|string|null,
 *     fileName: string|null,
 *     caption: string|null,
 *     allMediaFound: MediaEntry[]|null
 *   }
 * }} MediaExtractionResult
 * @typedef {{lid?: string|null, jid?: string|null, participantAlt?: string|null}} IdentityParams
 * @typedef {{jid: string|null, expiresAt: number, lastStoredAt: number|null}} LidCacheEntry
 * @typedef {{
 *   lid: string|null,
 *   jid: string|null,
 *   participantAlt: string|null,
 *   remoteJid: string|null,
 *   remoteJidAlt: string|null,
 *   groupMessage: boolean
 * }} SenderInfo
 */

const DEFAULT_BAILEYS_VERSION = [7, 0, 0];

let activeSocket = null;

/**
 * Atualiza a referência global do socket ativo.
 * @param {BaileysSocket|null} socket Instância conectada ou `null` para limpar.
 * @returns {void}
 */
export const setActiveSocket = (socket) => {
  activeSocket = socket;
};

/**
 * Retorna a instância de socket ativa no processo.
 * @returns {BaileysSocket|null}
 */
export const getActiveSocket = () => activeSocket;

/**
 * Indica se uma instância de socket está aberta para operações.
 * @param {BaileysSocket|null|undefined} socket Instância de socket.
 * @returns {boolean}
 */
export const isSocketOpen = (socket) => {
  if (!socket?.ws) return false;
  if (typeof socket.ws.isOpen === 'boolean') return socket.ws.isOpen;
  return socket.ws.readyState === 1;
};

/**
 * Indica se o socket ativo está aberto para operações.
 * @returns {boolean}
 */
export const isActiveSocketOpen = () => isSocketOpen(activeSocket);

/**
 * Executa um método em uma instância de socket validando disponibilidade.
 * @param {BaileysSocket|null|undefined} socket Instância de socket.
 * @param {string} methodName Nome do método no socket.
 * @param {...any} args Argumentos do método.
 * @returns {Promise<any>}
 */
export const runSocketMethod = async (socket, methodName, ...args) => {
  if (!isSocketOpen(socket)) {
    throw new Error(`Socket do WhatsApp indisponível para "${methodName}".`);
  }

  const method = socket?.[methodName];
  if (typeof method !== 'function') {
    throw new Error(`Método "${methodName}" não disponível no socket informado.`);
  }

  return method.apply(socket, args);
};

/**
 * Executa um método do socket ativo após validar disponibilidade.
 * @param {string} methodName Nome do método no socket.
 * @param {...any} args Argumentos do método.
 * @returns {Promise<any>}
 */
export const runActiveSocketMethod = async (methodName, ...args) => runSocketMethod(activeSocket, methodName, ...args);

/**
 * Recupera a blocklist da conta conectada.
 * @returns {Promise<string[]>}
 */
export const fetchBlocklistFromActiveSocket = async () => runActiveSocketMethod('fetchBlocklist');

/**
 * Recupera URL da foto de perfil via socket ativo.
 * @param {string} jid JID alvo.
 * @param {'preview'|'image'} [type='image'] Resolução da imagem.
 * @param {number} [timeoutMs] Timeout opcional da query.
 * @returns {Promise<string|null>}
 */
export const profilePictureUrlFromActiveSocket = async (jid, type = 'image', timeoutMs) => {
  const url = await runActiveSocketMethod('profilePictureUrl', jid, type, timeoutMs);
  return typeof url === 'string' && url.trim() ? url : null;
};

/**
 * Constantes de JID expostas pelo Baileys para facilitar comparações.
 * @type {{SERVER_JID: string, PSA_WID: string, STORIES_JID: string, META_AI_JID: string}}
 */
export const JID_CONSTANTS = {
  SERVER_JID,
  PSA_WID,
  STORIES_JID,
  META_AI_JID,
};

/**
 * Servidores válidos para IDs de usuário WhatsApp (PN).
 * Exportado para evitar duplicação de regras em outros serviços.
 * @type {ReadonlySet<string>}
 */
export const WHATSAPP_USER_JID_SERVERS = new Set(['s.whatsapp.net', 'c.us', 'hosted']);

/**
 * Servidores válidos para IDs do tipo LID.
 * Exportado para evitar duplicação de regras em outros serviços.
 * @type {ReadonlySet<string>}
 */
export const LID_USER_JID_SERVERS = new Set(['lid', 'hosted.lid']);

const decodeJidParts = (() => {
  let lastJid = null;
  let lastDecoded = null;

  return (jid) => {
    if (!jid) return null;
    if (jid === lastJid) return lastDecoded;
    const decoded = jidDecode(jid) || null;
    lastJid = jid;
    lastDecoded = decoded;
    return decoded;
  };
})();

/**
 * Tipos de mensagem conhecidos do Baileys
 * (mapeamento de chaves do proto.Message para tipos normalizados).
 * @type {Record<string, string>}
 */
export const MEDIA_TYPE_MAPPING = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
  contactMessage: 'contact',
  contactsArrayMessage: 'contacts',
  locationMessage: 'location',
  liveLocationMessage: 'liveLocation',
  buttonsMessage: 'buttons',
  buttonsResponseMessage: 'buttonsResponse',
  templateMessage: 'template',
  templateButtonReplyMessage: 'buttonReply',
  listMessage: 'list',
  listResponseMessage: 'listResponse',
  ephemeralMessage: 'ephemeral',
  reactionMessage: 'reaction',
  pollCreationMessage: 'poll',
  pollUpdateMessage: 'pollUpdate',
  pollResultSnapshotMessage: 'pollResult',
  invoiceMessage: 'invoice',
  sendPaymentMessage: 'payment',
  requestPaymentMessage: 'paymentRequest',
  cancelPaymentRequestMessage: 'paymentCancel',
  declinePaymentRequestMessage: 'paymentDecline',
  groupInviteMessage: 'groupInvite',
  productMessage: 'product',
  orderMessage: 'order',
  viewOnceMessage: 'viewOnce',
  viewOnceMessageV2: 'viewOnceV2',
  interactiveMessage: 'interactive',
  interactiveResponseMessage: 'interactiveResponse',
  newsletterAdminInviteMessage: 'newsletterInvite',
  eventMessage: 'event',
  requestPhoneNumberMessage: 'requestPhoneNumber',
  call: 'call',
  messageHistoryBundle: 'messageHistoryBundle',
  messageHistoryNotice: 'messageHistoryNotice',
  albumMessage: 'album',
  stickerPackMessage: 'stickerPack',
  highlyStructuredMessage: 'structured',
  fastRatchetKeySenderKeyDistributionMessage: 'keyDistribution',
  deviceSentMessage: 'deviceSent',
  messageContextInfo: 'contextInfo',
  botInvokeMessage: 'botInvoke',
};

/**
 * Tipos de mídia que carregam conteúdo binário/arquivo.
 * @type {Set<string>}
 */
export const BINARY_MEDIA_TYPES = new Set(['image', 'video', 'videoNote', 'audio', 'voice', 'document', 'sticker']);

const normalizeMessage = (message) => normalizeMessageContent(message) || message;

const MESSAGE_CONTENT_WRAPPER_KEYS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'deviceSentMessage', 'documentWithCaptionMessage', 'botInvokeMessage', 'editedMessage', 'keepInChatMessage'];

const resolveSingleWrapperMessage = (node) => {
  if (!node || typeof node !== 'object') return null;

  const keys = Object.keys(node);
  if (keys.length !== 1) return null;

  const wrapperValue = node[keys[0]];
  if (wrapperValue && typeof wrapperValue === 'object' && wrapperValue.message && typeof wrapperValue.message === 'object') {
    return wrapperValue.message;
  }

  return null;
};

const unwrapMessageContent = (message, maxDepth = 8) => {
  let current = normalizeMessage(message);
  const visited = new Set();

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!current || typeof current !== 'object') break;
    if (visited.has(current)) break;
    visited.add(current);

    let next = null;
    for (const wrapperKey of MESSAGE_CONTENT_WRAPPER_KEYS) {
      const wrapperMessage = current?.[wrapperKey]?.message;
      if (wrapperMessage && typeof wrapperMessage === 'object') {
        next = wrapperMessage;
        break;
      }
    }

    if (!next && current.message && typeof current.message === 'object') {
      next = current.message;
    }

    if (!next) {
      next = resolveSingleWrapperMessage(current);
    }

    if (!next || next === current) break;
    current = normalizeMessage(next);
  }

  return current || message;
};

const hasNonEmptyMediaKey = (mediaKey) => {
  if (!mediaKey) return false;

  if (typeof mediaKey === 'string') {
    return mediaKey.trim().length > 0;
  }

  if (Buffer.isBuffer(mediaKey) || mediaKey instanceof Uint8Array) {
    return mediaKey.length > 0;
  }

  if (Array.isArray(mediaKey)) {
    return mediaKey.length > 0;
  }

  if (typeof mediaKey === 'object') {
    if (typeof mediaKey.byteLength === 'number') {
      return mediaKey.byteLength > 0;
    }
    return Object.keys(mediaKey).length > 0;
  }

  return Boolean(mediaKey);
};

const buildMediaEntry = (mediaType, messageKey, value, isQuoted, overrides = {}) => ({
  mediaType,
  mediaKey: value,
  messageKey,
  isQuoted,
  isBinary: BINARY_MEDIA_TYPES.has(mediaType),
  hasUrl: !!value.url,
  hasDirectPath: !!value.directPath,
  hasMediaKey: !!value.mediaKey,
  hasFileEncSha256: !!value.fileEncSha256,
  mimetype: value.mimetype || null,
  fileLength: value.fileLength || null,
  fileName: value.fileName || null,
  caption: value.caption || null,
  ...overrides,
});

const collectMediaFromMessage = (message, { includeQuoted = true } = {}) => {
  if (!message || !message.message) {
    return [];
  }

  const messageContent = message.message;
  let allMedia = detectAllMediaTypes(messageContent, false);

  if (includeQuoted) {
    const quotedMessage = messageContent?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMessage) {
      allMedia = allMedia.concat(detectAllMediaTypes(quotedMessage, true));
    }
  }

  return allMedia;
};

const filterMedia = (media, { includeAllTypes = false, includeUnknown = false } = {}) => {
  let filtered = media;

  if (!includeAllTypes) {
    filtered = filtered.filter((item) => item.isBinary);
  }

  if (!includeUnknown) {
    filtered = filtered.filter((item) => !item.isUnknownType);
  }

  return filtered;
};

const findExpiration = (root) => {
  if (!root || typeof root !== 'object') return null;

  const stack = [root];
  const visited = new WeakSet();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const expiration = current.contextInfo?.expiration;
    if (typeof expiration === 'number') return expiration;

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return null;
};

const getMediaExtension = (type) => {
  if (type === 'image') return 'jpeg';
  if (type === 'video') return 'mp4';
  if (type === 'audio') return 'mp3';
  return 'bin';
};

const isBadDecryptError = (error) => {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 'ERR_OSSL_BAD_DECRYPT') return true;

  const message = String(error.message || '').toLowerCase();
  const reason = String(error.reason || '').toLowerCase();
  const opensslStack = Array.isArray(error.opensslErrorStack) ? error.opensslErrorStack.join(' ').toLowerCase() : '';

  return message.includes('bad decrypt') || reason.includes('bad decrypt') || opensslStack.includes('bad decrypt');
};

/**
 * Converte a versão do Baileys (string ou array) para o formato `[major, minor, patch]`.
 * @param {string|number[]|null|undefined} rawVersion - Valor bruto informado na variável de ambiente.
 * @returns {number[]|null} Retorna a versão normalizada ou `null` se inválida.
 */
function parseBaileysVersion(rawVersion) {
  if (!rawVersion) {
    return null;
  }

  const cleaned = String(rawVersion).replace(/[\[\]\s]/g, '');
  const parts = cleaned
    .split(/[.,]/)
    .filter(Boolean)
    .map((value) => Number(value));

  if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) {
    return null;
  }

  return parts.slice(0, 3);
}

/**
 * Codifica um usuário no formato JID aceito pelo WhatsApp.
 * @param {string|number|null|undefined} user - Identificador do usuário.
 * @param {string} [server='c.us'] - Domínio do servidor JID.
 * @param {number} [device] - ID do dispositivo quando aplicável.
 * @returns {string|null} JID codificado ou `null` para entrada inválida.
 */
export function encodeJid(user, server = 'c.us', device) {
  if (user === null || user === undefined) return null;
  return jidEncode(user, server, device);
}

/**
 * Decodifica um JID em partes (`user`, `server`, `device`) usando cache simples.
 * @param {string} jid - JID completo.
 * @returns {{user?: string, server?: string, domainType?: number, device?: number}|null} Partes do JID ou `null`.
 */
export function decodeJid(jid) {
  if (!jid) return null;
  return decodeJidParts(jid);
}

/**
 * Converte strings de env para boolean de forma tolerante.
 * Aceita: 1/0, true/false, yes/no, y/n, on/off.
 * @param {unknown} value Valor bruto vindo do process.env.
 * @param {boolean} fallback Valor padrão quando não for possível interpretar.
 * @returns {boolean}
 */
export const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

/**
 * Converte strings de env para inteiro com fallback e clamp.
 * @param {unknown} value Valor bruto.
 * @param {number} fallback Valor padrão.
 * @param {number} min Valor mínimo.
 * @param {number} max Valor máximo.
 * @returns {number}
 */
export const parseEnvInt = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

/**
 * Converte strings CSV em array de strings.
 * @param {unknown} value Valor bruto.
 * @param {string[]} fallback Lista padrão.
 * @returns {string[]}
 */
export const parseEnvCsv = (value, fallback) => {
  if (value === undefined || value === null || value === '') return [...fallback];
  const parsed = String(value)
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
};

/**
 * Estados de presença suportados pelo Baileys (WAPresence).
 * Referência: Types/Chat.d.ts.
 * @type {ReadonlyArray<import('@whiskeysockets/baileys').WAPresence>}
 */
export const WA_PRESENCE_VALUES = Object.freeze(['unavailable', 'available', 'composing', 'recording', 'paused']);
const WA_PRESENCE_SET = new Set(WA_PRESENCE_VALUES);

/**
 * Verifica se o valor informado é um estado de presença válido.
 * @param {unknown} value
 * @returns {value is import('@whiskeysockets/baileys').WAPresence}
 */
export const isWAPresence = (value) => {
  if (typeof value !== 'string') return false;
  return WA_PRESENCE_SET.has(value.trim().toLowerCase());
};

/**
 * Normaliza um estado de presença para o formato aceito pelo Baileys.
 * @param {unknown} value
 * @param {import('@whiskeysockets/baileys').WAPresence} [fallback='available']
 * @returns {import('@whiskeysockets/baileys').WAPresence}
 */
export const normalizeWAPresence = (value, fallback = 'available') => {
  const normalizedFallback = isWAPresence(fallback) ? String(fallback).trim().toLowerCase() : 'available';
  if (!isWAPresence(value)) return /** @type {import('@whiskeysockets/baileys').WAPresence} */ (normalizedFallback);
  return /** @type {import('@whiskeysockets/baileys').WAPresence} */ (String(value).trim().toLowerCase());
};

/**
 * Normaliza um JID para o formato canônico.
 * @param {string} jid - JID de entrada.
 * @returns {string} JID normalizado ou string vazia quando ausente.
 */
export function normalizeJid(jid) {
  if (!jid) return '';
  return jidNormalizedUser(jid);
}

/**
 * Extrai o identificador do usuário de um JID.
 * @param {string} jid - JID completo.
 * @returns {string|null} Usuário extraído ou `null`.
 */
export function getJidUser(jid) {
  return decodeJidParts(jid)?.user || null;
}

/**
 * Extrai o servidor de um JID.
 * @param {string} jid - JID completo.
 * @returns {string|null} Servidor extraído ou `null`.
 */
export function getJidServer(jid) {
  return decodeJidParts(jid)?.server || null;
}

/**
 * Verifica se o JID pertence ao namespace LID.
 * @param {string} jid - JID a validar.
 * @returns {boolean} `true` quando for LID.
 */
export function isLidJid(jid) {
  const server = getJidServer(jid);
  return Boolean(server && LID_USER_JID_SERVERS.has(server));
}

/**
 * Verifica se o JID pertence ao namespace PN do WhatsApp.
 * @param {string} jid - JID a validar.
 * @returns {boolean} `true` quando for usuário WhatsApp.
 */
export function isWhatsAppJid(jid) {
  const server = getJidServer(jid);
  return Boolean(server && WHATSAPP_USER_JID_SERVERS.has(server));
}

/**
 * Modo de endereçamento por LID.
 * @type {'lid'}
 */
export const ADDRESSING_MODE_LID = 'lid';

/**
 * Modo de endereçamento por PN/JID canônico.
 * @type {'pn'}
 */
export const ADDRESSING_MODE_PN = 'pn';

/**
 * Normaliza um modo de endereçamento (lid/pn).
 * @param {unknown} value
 * @returns {AddressingMode|undefined}
 */
export const normalizeAddressingMode = (value) => {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === ADDRESSING_MODE_LID) return ADDRESSING_MODE_LID;
  if (normalized === ADDRESSING_MODE_PN) return ADDRESSING_MODE_PN;
  return undefined;
};

/**
 * Resolve modo de endereçamento a partir da chave da mensagem.
 * @param {object} [key={}]
 * @param {SenderInfo|Record<string, any>} [senderInfo={}]
 * @returns {AddressingMode|undefined}
 */
export const resolveAddressingModeFromMessageKey = (key = {}, senderInfo = {}) => {
  const explicit = normalizeAddressingMode(key?.addressingMode);
  if (explicit) return explicit;

  const candidates = [senderInfo?.lid, key?.participant, key?.participantAlt, key?.remoteJid, key?.remoteJidAlt];
  for (const candidate of candidates) {
    const normalized = normalizeJid(String(candidate || '').trim());
    if (!normalized) continue;
    if (isLidJid(normalized)) return ADDRESSING_MODE_LID;
    if (isWhatsAppJid(normalized)) return ADDRESSING_MODE_PN;
  }

  return undefined;
};

/**
 * Resolve JID canônico de usuário WhatsApp a partir de candidatos.
 * @param {...(string|null|undefined)} candidates
 * @returns {string}
 */
export const resolveCanonicalWhatsAppJid = (...candidates) => {
  for (const candidate of candidates) {
    const normalized = normalizeJid(String(candidate || '').trim());
    if (!normalized) continue;
    if (!isWhatsAppJid(normalized)) continue;
    const user = String(getJidUser(normalized) || '')
      .split(':')[0]
      .replace(/\D+/g, '');
    if (!user) continue;
    if (user.length < 10 || user.length > 15) continue;
    return normalizeJid(`${user}@s.whatsapp.net`) || normalized;
  }
  return '';
};

/**
 * Normaliza PN para JID de WhatsApp quando o payload vier sem domínio.
 * @param {string|null|undefined} pn
 * @returns {string|null}
 */
export const normalizePnToJid = (pn) => {
  if (!pn || typeof pn !== 'string') return null;
  const normalized = pn.trim();
  if (!normalized) return null;
  if (isWhatsAppJid(normalized)) return normalized;
  if (/^\d+(?::\d+)?$/.test(normalized)) return `${normalized}@s.whatsapp.net`;
  return null;
};

/**
 * Verifica se dois JIDs pertencem ao mesmo usuário.
 * @param {string} jid1 - Primeiro JID.
 * @param {string} jid2 - Segundo JID.
 * @returns {boolean} `true` quando representam o mesmo usuário.
 */
export function isSameJidUser(jid1, jid2) {
  return areJidsSameUser(jid1, jid2);
}

/**
 * Verifica se o JID representa um usuário (PN/LID, hospedado ou não).
 * @param {string} jid - JID a validar.
 * @returns {boolean} `true` quando for JID de usuário.
 */
export function isUserJid(jid) {
  return Boolean(jid && (isPnUser(jid) || isHostedPnUser(jid) || isLidUser(jid) || isHostedLidUser(jid)));
}

/**
 * Verifica se o JID é de grupo.
 * @param {string} jid - JID a validar.
 * @returns {boolean} `true` quando for grupo.
 */
export function isGroupJid(jid) {
  return Boolean(jid && isJidGroup(jid));
}

/**
 * Verifica se o JID é de broadcast.
 * @param {string} jid - JID a validar.
 * @returns {boolean} `true` quando for broadcast.
 */
export function isBroadcastJid(jid) {
  return Boolean(jid && isJidBroadcast(jid));
}

/**
 * Verifica se o JID é do status broadcast.
 * @param {string} jid - JID a validar.
 * @returns {boolean} `true` quando for status.
 */
export function isStatusJid(jid) {
  return Boolean(jid && isJidStatusBroadcast(jid));
}

/**
 * Verifica se o JID é de newsletter/canal.
 * @param {string} jid - JID a validar.
 * @returns {boolean} `true` quando for newsletter.
 */
export function isNewsletterJid(jid) {
  return Boolean(jid && isJidNewsletter(jid));
}

/**
 * Verifica se o JID pertence à Meta AI.
 * @param {string} jid - JID a validar.
 * @returns {boolean} `true` quando for Meta AI.
 */
export function isMetaAiJid(jid) {
  return Boolean(jid && isJidMetaAI(jid));
}

/**
 * Verifica se o JID pertence a um bot.
 * @param {string} jid - JID a validar.
 * @returns {boolean} `true` quando for bot.
 */
export function isBotJid(jid) {
  return Boolean(jid && isJidBot(jid));
}

/**
 * Resolve o JID do bot a partir do `sock.user.id`.
 * @param {string} sockUserId - ID bruto retornado pelo socket.
 * @returns {string|null} JID normalizado do bot ou `null`.
 */
export function resolveBotJid(sockUserId) {
  const normalized = normalizeJid(sockUserId);
  if (normalized) return normalized;
  if (!sockUserId || typeof sockUserId !== 'string') return null;
  const rawUser = sockUserId.split(':')[0];
  return encodeJid(rawUser, 's.whatsapp.net');
}

/**
 * Resolve a versão do Baileys com prioridade para `BAILEYS_VERSION`.
 * Se a variável não for válida, tenta buscar a recomendada e aplica fallback local.
 * @returns {Promise<number[]>} Versão no formato `[major, minor, patch]`.
 */
export async function resolveBaileysVersion() {
  const envVersion = parseBaileysVersion(process.env.BAILEYS_VERSION);
  if (envVersion) {
    return envVersion;
  }

  if (process.env.BAILEYS_VERSION) {
    logger.warn('Valor invalido em BAILEYS_VERSION; usando fallback local.', {
      provided: process.env.BAILEYS_VERSION,
    });
  }

  const shouldFetchLatest = parseEnvBool(process.env.BAILEYS_FETCH_LATEST_VERSION, false);
  if (!shouldFetchLatest) {
    return DEFAULT_BAILEYS_VERSION;
  }

  try {
    const { version } = await fetchLatestBaileysVersion();
    if (Array.isArray(version) && version.length >= 3) {
      return version;
    }
  } catch (error) {
    logger.warn('Falha ao buscar a versao recomendada do Baileys; usando fallback.', {
      error: error.message,
    });
  }

  return DEFAULT_BAILEYS_VERSION;
}

/**
 * Baixa a foto de perfil associada à mensagem recebida.
 * @param {BaileysSocket} sock - Instância conectada do socket.
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} msg - Mensagem usada para resolver o JID.
 * @returns {Promise<Buffer|null>} Buffer da imagem ou `null` se indisponível.
 */
export async function getProfilePicBuffer(sock, msg) {
  const rawJid = msg?.key?.participant || msg?.key?.remoteJid;
  const jid = jidNormalizedUser(rawJid);

  try {
    const url = await runSocketMethod(sock, 'profilePictureUrl', jid, 'image');
    if (!url) return null;

    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.arrayBuffer();
    return Buffer.from(data);
  } catch (error) {
    return null;
  }
}

/**
 * Extrai o valor de expiração de uma mensagem do WhatsApp, ou retorna 24 horas (em segundos) por padrão.
 * @param {{message?: Record<string, any>}|null|undefined} messageInfo - Estrutura contendo a propriedade `message`.
 * @returns {number} Tempo de expiração em segundos.
 */
export function getExpiration(messageInfo) {
  const DEFAULT_EXPIRATION_SECONDS = 24 * 60 * 60;

  if (!messageInfo || typeof messageInfo !== 'object' || !messageInfo.message) {
    return DEFAULT_EXPIRATION_SECONDS;
  }

  const normalizedMessage = normalizeMessage(messageInfo.message);
  const expiration = findExpiration(normalizedMessage);

  return typeof expiration === 'number' ? expiration : DEFAULT_EXPIRATION_SECONDS;
}

/**
 * Extrai o conteúdo de texto de uma mensagem do WhatsApp.
 * @param {{message?: Record<string, any>}} messageInfo - Objeto que contém o payload da mensagem.
 * @returns {string} Conteúdo textual extraído ou descrição do tipo de mensagem.
 */
export const extractMessageContent = ({ message }) => {
  if (!message) return 'Mensagem vazia';

  const normalizedMessage = unwrapMessageContent(message);
  if (!normalizedMessage) return 'Mensagem vazia';

  const text = normalizedMessage.conversation?.trim() || normalizedMessage.extendedTextMessage?.text;

  if (text) return text;

  const handlers = [
    [normalizedMessage.imageMessage, (m) => m.caption || '[Imagem]'],
    [normalizedMessage.videoMessage, (m) => m.caption || '[Vídeo]'],
    [normalizedMessage.documentMessage, (m) => m.fileName || '[Documento]'],
    [normalizedMessage.audioMessage, (m) => (m.ptt ? '[Áudio] (voz)' : '[Áudio]')],
    [normalizedMessage.stickerMessage, () => '[Figurinha]'],
    [normalizedMessage.locationMessage, (m) => `[Localização] Lat: ${m.degreesLatitude}, Long: ${m.degreesLongitude}`],
    [normalizedMessage.contactMessage, (m) => `[Contato] ${m.displayName}`],
    [normalizedMessage.contactsArrayMessage, (m) => `[Contatos] ${m.contacts.map((c) => c.displayName).join(', ')}`],
    [normalizedMessage.listMessage, (m) => m.description || '[Mensagem de Lista]'],
    [normalizedMessage.listResponseMessage, (m) => `[Lista] ${m.singleSelectReply?.selectedRowId || m.title || ''}`.trim()],
    [normalizedMessage.buttonsMessage, (m) => m.contentText || '[Mensagem de Botões]'],
    [normalizedMessage.buttonsResponseMessage, (m) => `[Botão] ${m.selectedDisplayText || m.selectedButtonId || ''}`.trim()],
    [normalizedMessage.templateButtonReplyMessage, (m) => `[Resposta de Botão] ${m.selectedDisplayText || ''}`.trim()],
    [normalizedMessage.interactiveResponseMessage, (m) => `[Interativo] ${m.body?.text || m.nativeFlowResponseMessage?.name || ''}`.trim()],
    [normalizedMessage.productMessage, (m) => m.product?.title || '[Mensagem de Produto]'],
    [normalizedMessage.reactionMessage, (m) => `[Reação] ${m.text || ''}`.trim()],
    [normalizedMessage.pollCreationMessage, (m) => `[Enquete] ${m.name}`],
    [normalizedMessage.pollResultSnapshotMessage, (m) => `[Resultado de Enquete] ${m.name || ''}`.trim()],
    [normalizedMessage.requestPhoneNumberMessage, () => '[Solicitação de telefone]'],
    [normalizedMessage.groupInviteMessage, (m) => `[Convite de grupo] ${m.groupName || ''}`.trim()],
    [normalizedMessage.eventMessage, (m) => `[Evento] ${m.name || ''}`.trim()],
    [normalizedMessage.newsletterAdminInviteMessage, () => '[Convite de newsletter]'],
    [normalizedMessage.albumMessage, () => '[Álbum]'],
    [normalizedMessage.stickerPackMessage, () => '[Pacote de figurinhas]'],
    [normalizedMessage.messageHistoryBundle, () => '[Histórico de mensagens]'],
    [normalizedMessage.messageHistoryNotice, () => '[Aviso de histórico de mensagens]'],
    [normalizedMessage.call, () => '[Chamada]'],
  ];

  for (const [msg, fn] of handlers) {
    if (msg) return fn(msg);
  }

  return 'Tipo de mensagem não suportado ou sem conteúdo.';
};

/**
 * Faz o download de mídia a partir de uma mensagem do Baileys.
 * @param {BaileysProtoMessage} message - Objeto da mídia a ser baixada.
 * @param {string} type - Tipo de mídia (ex.: `image`, `video`, `audio`, `document`).
 * @param {string} outputPath - Diretório onde o arquivo será salvo.
 * @returns {Promise<string|null>} Caminho do arquivo salvo ou `null` em caso de falha.
 */
export const downloadMediaMessage = async (message, type, outputPath) => {
  if (!message || typeof message !== 'object') {
    logger.warn('Skipping media download: invalid message payload.', { type });
    return null;
  }

  if (!hasNonEmptyMediaKey(message.mediaKey)) {
    logger.warn('Skipping media download: missing or empty media key.', {
      type,
      hasUrl: Boolean(message.url),
      hasDirectPath: Boolean(message.directPath),
    });
    return null;
  }

  if (!message.url && !message.directPath) {
    logger.warn('Skipping media download: media URL/directPath not found.', { type });
    return null;
  }

  try {
    const stream = await downloadContentFromMessage(message, type);

    const fileId = message.key?.id || __timeNowMs();
    const extension = getMediaExtension(type);
    const fileName = `${__timeNowMs()}-${fileId}.${extension}`;
    const filePath = path.join(outputPath, fileName);

    await pipeline(Readable.from(stream), createWriteStream(filePath));
    logger.info(`Media downloaded successfully to ${filePath}`);
    return filePath;
  } catch (error) {
    if (error?.message?.includes('Cannot derive from empty media key')) {
      logger.warn('Skipping media download: invalid media key received from source.', { type });
      return null;
    }

    if (isBadDecryptError(error)) {
      logger.warn('Skipping media download: failed to decrypt media payload from source.', {
        type,
        code: error.code,
        reason: error.reason || null,
      });
      return null;
    }

    logger.error(`Error downloading media: ${error.message}`, error);
    return null;
  }
};

/**
 * Detecta dinamicamente os tipos de mídia presentes em um payload de mensagem.
 * @param {Record<string, any>} messageContent Conteúdo da mensagem (normal ou quoted).
 * @param {boolean} [isQuoted=false] Sinaliza se o payload veio de uma citação.
 * @returns {MediaEntry[]} Lista de mídias detectadas (pode estar vazia).
 */
export function detectAllMediaTypes(messageContent, isQuoted = false) {
  if (!messageContent || typeof messageContent !== 'object') {
    return [];
  }

  const normalizedMessage = unwrapMessageContent(messageContent);
  if (!normalizedMessage || typeof normalizedMessage !== 'object') {
    return [];
  }

  const mediaFound = [];

  for (const [key, value] of Object.entries(normalizedMessage)) {
    if (!value || typeof value !== 'object') continue;

    let mediaType = MEDIA_TYPE_MAPPING[key];
    if (key === 'audioMessage' && value.ptt) {
      mediaType = 'voice';
    } else if (key === 'videoMessage' && value.ptv) {
      mediaType = 'videoNote';
    }

    if (mediaType) {
      mediaFound.push(buildMediaEntry(mediaType, key, value, isQuoted));
      continue;
    }

    if (key.toLowerCase().includes('message')) {
      const inferredType = key.replace(/Message$/, '').toLowerCase();
      mediaFound.push(
        buildMediaEntry(inferredType, key, value, isQuoted, {
          isBinary: false,
          isUnknownType: true,
        }),
      );
    }
  }

  return mediaFound;
}

/**
 * Extrai a mídia primária de uma mensagem com filtros configuráveis.
 * @param {BaileysMessage|{message?: Record<string, any>}|Record<string, any>} message Objeto da mensagem.
 * @param {MediaExtractionOptions} [options={}] Opções de filtragem.
 * @returns {MediaExtractionResult|null} Estrutura da mídia primária ou `null` quando não houver mídia.
 */
export function extractMediaDetails(message, options = {}) {
  const { includeAllTypes = false, includeQuoted = true, includeUnknown = false } = options;

  const allMedia = collectMediaFromMessage(message, { includeQuoted });
  const filteredMedia = filterMedia(allMedia, { includeAllTypes, includeUnknown });

  if (filteredMedia.length > 0) {
    const primaryMedia = filteredMedia[0];
    return {
      mediaType: primaryMedia.mediaType,
      mediaKey: primaryMedia.mediaKey,
      isQuoted: primaryMedia.isQuoted,
      details: {
        messageKey: primaryMedia.messageKey,
        isBinary: primaryMedia.isBinary,
        isUnknownType: primaryMedia.isUnknownType,
        hasUrl: primaryMedia.hasUrl,
        hasDirectPath: primaryMedia.hasDirectPath,
        hasMediaKey: primaryMedia.hasMediaKey,
        hasFileEncSha256: primaryMedia.hasFileEncSha256,
        mimetype: primaryMedia.mimetype,
        fileLength: primaryMedia.fileLength,
        fileName: primaryMedia.fileName,
        caption: primaryMedia.caption,
        allMediaFound: allMedia.length > 1 ? allMedia : null,
      },
    };
  }

  return null;
}

/**
 * Extrai todas as mídias detectadas de uma mensagem.
 * @param {BaileysMessage|{message?: Record<string, any>}|Record<string, any>} message Objeto da mensagem.
 * @param {MediaExtractionOptions} [options={}] Opções de filtragem.
 * @returns {MediaEntry[]} Array com todas as mídias encontradas.
 */
export function extractAllMediaDetails(message, options = {}) {
  const { includeAllTypes = true, includeQuoted = true, includeUnknown = true } = options;

  const allMedia = collectMediaFromMessage(message, { includeQuoted });
  return filterMedia(allMedia, { includeAllTypes, includeUnknown });
}

/**
 * Verifica se uma mensagem contém mídia.
 * @param {BaileysMessage|{message?: Record<string, any>}|Record<string, any>} message Objeto da mensagem.
 * @param {string|null} [specificType=null] Tipo específico para filtrar (ex.: `image`).
 * @returns {boolean} `true` quando ao menos uma mídia compatível é encontrada.
 */
export function hasMedia(message, specificType = null) {
  const allMedia = collectMediaFromMessage(message, { includeQuoted: true });
  const filtered = filterMedia(allMedia, { includeAllTypes: true, includeUnknown: true });

  if (!filtered.length) {
    return false;
  }

  if (specificType) {
    return filtered.some((media) => media.mediaType === specificType);
  }

  return true;
}

/**
 * Obtém metadados dos tipos de mídia suportados.
 * @returns {{
 *   knownTypes: string[],
 *   binaryTypes: string[],
 *   typeMapping: Record<string, string>,
 *   totalKnownTypes: number
 * }}
 */
export function getMediaTypeInfo() {
  return {
    knownTypes: Object.values(MEDIA_TYPE_MAPPING),
    binaryTypes: Array.from(BINARY_MEDIA_TYPES),
    typeMapping: { ...MEDIA_TYPE_MAPPING },
    totalKnownTypes: Object.keys(MEDIA_TYPE_MAPPING).length,
  };
}

/**
 * ===========================
 * LID Map Utilities
 * ===========================
 */
const CACHE_TTL_MS = 20 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const STORE_COOLDOWN_MS = 10 * 60 * 1000;
const BATCH_LIMIT = 800;
const BACKFILL_DEFAULT_BATCH = 50000;
const BACKFILL_SOURCE = 'backfill';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BAILEYS_AUTH_DIR = path.resolve(__dirname, '../connection/auth');
const BAILEYS_AUTH_SESSION_ID = (() => {
  const raw = String(process.env.BAILEYS_AUTH_SESSION_ID || '').trim();
  return raw || 'default';
})();

const lidCache = new Map();
const lidWriteBuffer = new Map();
const authReverseLidCache = new Map();

let backfillPromise = null;

const updateLidQueueMetric = () => {
  setQueueDepth('lid_map', lidWriteBuffer.size);
};

/**
 * Retorna timestamp atual em ms.
 * @returns {number}
 */
const now = () => __timeNowMs();

const normalizeLid = (lid) => {
  if (!lid || !isLidJid(lid)) return null;
  const normalized = normalizeJid(lid);
  return normalized || null;
};

const normalizeWhatsAppJid = (jid) => {
  if (!jid || !isWhatsAppJid(jid)) return null;
  const normalized = normalizeJid(jid);
  return normalized || null;
};

const toDigits = (value) => String(value || '').replace(/\D+/g, '');

const parseReverseMappingPhoneDigits = (content) => {
  const raw = String(content || '').trim();
  if (!raw) return '';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }

  const digits = toDigits(parsed);
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
};

const resolveAuthStoreJidByLid = async (lid) => {
  const normalizedLid = normalizeLid(lid);
  if (!normalizedLid) return null;

  const [rawUser] = normalizedLid.split('@');
  const rootUser = rawUser ? rawUser.split(':')[0] : '';
  if (!rootUser || !/^\d+$/.test(rootUser)) return null;

  if (authReverseLidCache.has(rootUser)) {
    return authReverseLidCache.get(rootUser);
  }

  try {
    const authStateTable = TABLES.BAILEYS_AUTH_STATE;
    if (authStateTable) {
      const rows = await executeQuery(`SELECT payload FROM \`${authStateTable}\` WHERE session_id = ? AND category = ? AND item_id = ? LIMIT 1`, [BAILEYS_AUTH_SESSION_ID, 'lid-mapping', `${rootUser}_reverse`]);
      const payload = rows?.[0]?.payload;
      if (payload !== undefined && payload !== null) {
        const phoneDigits = parseReverseMappingPhoneDigits(payload);
        const resolvedJid = phoneDigits ? normalizeWhatsAppJid(`${phoneDigits}@s.whatsapp.net`) : null;
        authReverseLidCache.set(rootUser, resolvedJid);
        return resolvedJid;
      }
    }
  } catch (error) {
    logger.warn('Falha ao resolver LID via auth state MySQL.', {
      lid: normalizedLid,
      error: error?.message,
    });
  }

  const reverseFilePath = path.join(BAILEYS_AUTH_DIR, `lid-mapping-${rootUser}_reverse.json`);
  try {
    const content = await readFile(reverseFilePath, 'utf8');
    const phoneDigits = parseReverseMappingPhoneDigits(content);
    const resolvedJid = phoneDigits ? normalizeWhatsAppJid(`${phoneDigits}@s.whatsapp.net`) : null;
    authReverseLidCache.set(rootUser, resolvedJid);
    return resolvedJid;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn('Falha ao resolver LID via auth store local.', {
        lid: normalizedLid,
        error: error?.message,
      });
    }
    authReverseLidCache.set(rootUser, null);
    return null;
  }
};

/**
 * Mascara um JID para logs.
 * @param {string|null|undefined} jid
 * @returns {string|null}
 */
const maskJid = (jid) => {
  if (!jid || typeof jid !== 'string') return null;
  const [user, server] = jid.split('@');
  if (!user || !server) return jid;
  const head = user.slice(0, 3);
  const tail = user.slice(-2);
  return `${head}***${tail}@${server}`;
};

/**
 * Busca entrada do cache (com expiração).
 * @param {string|null|undefined} lid
 * @returns {LidCacheEntry|null}
 */
const getCacheEntry = (lid) => {
  if (!lid) return null;
  const nowTs = now();
  const entry = lidCache.get(lid);
  if (entry) {
    if (entry.expiresAt && entry.expiresAt < nowTs) {
      lidCache.delete(lid);
    } else {
      return entry;
    }
  }

  const baseLid = normalizeLid(lid);
  if (!baseLid || baseLid === lid) return null;
  const baseEntry = lidCache.get(baseLid);
  if (!baseEntry) return null;
  if (baseEntry.expiresAt && baseEntry.expiresAt < nowTs) {
    lidCache.delete(baseLid);
    return null;
  }
  return baseEntry;
};

/**
 * Atualiza cache local do LID.
 * @param {string} lid
 * @param {string|null} jid
 * @param {number} ttlMs
 * @param {number|null} lastStoredAt
 * @returns {void}
 */
const setCacheEntry = (lid, jid, ttlMs, lastStoredAt) => {
  if (!lid) return;
  const normalizedJid = normalizeWhatsAppJid(jid);
  const baseLid = normalizeLid(lid);
  const previousEntry = lidCache.get(lid) || (baseLid ? lidCache.get(baseLid) : null);
  const entry = {
    jid: normalizedJid ?? null,
    expiresAt: now() + (ttlMs || CACHE_TTL_MS),
    lastStoredAt: lastStoredAt ?? previousEntry?.lastStoredAt ?? null,
  };
  lidCache.set(lid, entry);
  if (baseLid && baseLid !== lid) {
    lidCache.set(baseLid, entry);
  }
};

/**
 * Retorna JID do cache para um LID.
 * @param {string|null|undefined} lid
 * @returns {string|null|undefined} undefined quando nao cacheado.
 */
export const getCachedJidForLid = (lid) => {
  const entry = getCacheEntry(lid);
  if (!entry) return undefined;
  return entry.jid ?? null;
};

/**
 * Divide lista em batches.
 * @template T
 * @param {T[]} items
 * @param {number} [limit=BATCH_LIMIT]
 * @returns {T[][]}
 */
const buildChunks = (items, limit = BATCH_LIMIT) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += limit) {
    chunks.push(items.slice(i, i + limit));
  }
  return chunks;
};

/**
 * Pré-carrega cache a partir do banco.
 * @param {Array<string>} [lids=[]]
 * @returns {Promise<Map<string, string|null>>}
 */
export const primeLidCache = async (lids = []) => {
  const uniqueLids = Array.from(new Set((lids || []).filter(Boolean)));
  if (!uniqueLids.length) return new Map();

  const pending = uniqueLids.filter((lid) => isLidJid(lid) && getCachedJidForLid(lid) === undefined);
  if (!pending.length) {
    const map = new Map();
    uniqueLids.forEach((lid) => map.set(lid, getCachedJidForLid(lid) ?? null));
    return map;
  }

  const results = new Map();
  const baseByLid = new Map();
  const lookupSet = new Set();
  pending.forEach((lid) => {
    const base = normalizeLid(lid);
    baseByLid.set(lid, base);
    lookupSet.add(lid);
    if (base && base !== lid) lookupSet.add(base);
  });

  const lookupList = Array.from(lookupSet);
  const chunks = buildChunks(lookupList);
  const rowMap = new Map();

  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await executeQuery(`SELECT lid, jid FROM ${TABLES.LID_MAP} WHERE lid IN (${placeholders})`, chunk);

    (rows || []).forEach((row) => {
      if (!row?.lid) return;
      const jid = row.jid && isWhatsAppJid(row.jid) ? normalizeJid(row.jid) : null;
      rowMap.set(row.lid, jid);
    });
  }

  for (const lid of pending) {
    const base = baseByLid.get(lid);
    const direct = rowMap.has(lid) ? rowMap.get(lid) : undefined;
    const baseValue = base && base !== lid && rowMap.has(base) ? rowMap.get(base) : undefined;
    let resolved = direct ?? baseValue ?? null;

    if (!resolved) {
      const authStoreResolved = await resolveAuthStoreJidByLid(lid);
      if (authStoreResolved) {
        resolved = authStoreResolved;
      }
    }

    const directHasJid = typeof direct === 'string' && direct.length > 0;
    const shouldSeed = Boolean(resolved && (!directHasJid || direct !== resolved));
    setCacheEntry(lid, resolved, resolved ? CACHE_TTL_MS : NEGATIVE_TTL_MS, shouldSeed ? 0 : undefined);
    if (shouldSeed) {
      queueLidUpdate(lid, resolved, 'prime');
    }
    results.set(lid, resolved);
  }

  uniqueLids.forEach((lid) => {
    if (!results.has(lid)) {
      results.set(lid, getCachedJidForLid(lid) ?? null);
    }
  });

  return results;
};

/**
 * Retorna o primeiro JID valido do WhatsApp.
 * @param {...string} candidates
 * @returns {string|null}
 */
const pickWhatsAppJid = (...candidates) => {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    const normalized = normalizeWhatsAppJid(candidate);
    if (normalized) return normalized;
  }
  return null;
};

/**
 * Retorna o primeiro LID valido.
 * @param {...string} candidates
 * @returns {string|null}
 */
const pickLid = (...candidates) => {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    const normalized = normalizeLid(candidate);
    if (normalized) return normalized;
  }
  return null;
};

/**
 * Monta filtro SQL por sufixo de servidor JID.
 * @param {string} column
 * @param {Iterable<string>} servers
 * @returns {{clause: string, params: Array<string>}}
 */
const buildServerLikeFilter = (column, servers) => {
  const values = Array.from(new Set(Array.from(servers || []).filter(Boolean)));
  if (!values.length) {
    return { clause: '1 = 0', params: [] };
  }

  const clause = values.map(() => `${column} LIKE ?`).join(' OR ');
  const params = values.map((server) => `%@${server}`);
  return { clause: `(${clause})`, params };
};

/**
 * Resolve candidatos principais de identidade de usuário.
 * Centraliza regra usada por `resolveUserIdCached` e `resolveUserId`.
 * @param {IdentityParams} [params]
 * @returns {{directJid: string|null, lidValue: string|null, fallback: string|null}}
 */
const resolveIdentityCandidates = ({ lid, jid, participantAlt } = {}) => {
  const directJid = pickWhatsAppJid(jid, participantAlt, lid);
  if (directJid) {
    return {
      directJid,
      lidValue: null,
      fallback: directJid,
    };
  }

  const lidValue = pickLid(lid, jid, participantAlt);
  if (lidValue) {
    return {
      directJid: null,
      lidValue,
      fallback: lidValue,
    };
  }

  return {
    directJid: null,
    lidValue: null,
    fallback: jid || participantAlt || lid || null,
  };
};

const buildLidUpsertSql = (rows) => {
  const placeholders = buildRowPlaceholders(rows, '(?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)');
  return `
    INSERT INTO ${TABLES.LID_MAP} (lid, jid, first_seen, last_seen, source)
    VALUES ${placeholders}
    ON DUPLICATE KEY UPDATE
      jid = COALESCE(VALUES(jid), jid),
      last_seen = VALUES(last_seen),
      source = VALUES(source)
  `;
};

/**
 * Enfileira atualizacao do lid_map (com cooldown e dedupe).
 * @param {string} lid
 * @param {string|null} jid
 * @param {string} [source='message']
 * @returns {{queued: boolean, reconciled: boolean}}
 */
export const queueLidUpdate = (lid, jid, source = 'message') => {
  let resolvedLid = lid;
  let resolvedJid = jid;

  if (!isLidJid(resolvedLid) && isLidJid(resolvedJid) && isWhatsAppJid(resolvedLid)) {
    resolvedLid = jid;
    resolvedJid = lid;
  }

  if (!resolvedLid || !isLidJid(resolvedLid)) {
    return { queued: false, reconciled: false };
  }

  const normalizedJid = resolvedJid && isWhatsAppJid(resolvedJid) ? normalizeJid(resolvedJid) : null;
  const lidsToUpdate = new Set([resolvedLid]);
  const baseLid = normalizeLid(resolvedLid);
  if (baseLid && baseLid !== resolvedLid) lidsToUpdate.add(baseLid);

  let queued = false;
  let reconciled = false;

  for (const targetLid of lidsToUpdate) {
    const cacheEntry = getCacheEntry(targetLid);
    const cachedJid = cacheEntry?.jid ?? null;
    const lastStoredAt = cacheEntry?.lastStoredAt || 0;
    const nowTs = now();

    const mappingChanged = Boolean(normalizedJid && normalizedJid !== cachedJid);
    const mappingSame = normalizedJid === cachedJid;

    if (mappingSame && nowTs - lastStoredAt < STORE_COOLDOWN_MS) {
      continue;
    }

    const buffered = lidWriteBuffer.get(targetLid);
    const effectiveJid = normalizedJid ?? buffered?.jid ?? cachedJid ?? null;
    const entry = {
      lid: targetLid,
      jid: effectiveJid,
      source,
      queuedAt: nowTs,
      reconcileJid: mappingChanged ? normalizedJid : null,
    };

    lidWriteBuffer.set(targetLid, entry);
    setCacheEntry(targetLid, effectiveJid, CACHE_TTL_MS, nowTs);
    queued = true;
    reconciled = reconciled || Boolean(entry.reconcileJid);
  }

  if (queued) updateLidQueueMetric();

  return { queued, reconciled };
};

/**
 * Resolve ID canônico usando apenas cache.
 * @param {IdentityParams} [params]
 * @returns {string|null}
 */
export const resolveUserIdCached = ({ lid, jid, participantAlt } = {}) => {
  const { directJid, lidValue, fallback } = resolveIdentityCandidates({ lid, jid, participantAlt });
  if (directJid) return directJid;
  if (!lidValue) return fallback;

  const mapped = getCachedJidForLid(lidValue);
  if (mapped !== undefined) return mapped || lidValue;
  return lidValue;
};

/**
 * Extrai informações de identidade do remetente a partir da mensagem.
 * @param {BaileysMessage} msg
 * @returns {SenderInfo}
 */
export const extractSenderInfoFromMessage = (msg) => {
  const remoteJid = normalizeJid(msg?.key?.remoteJid || '') || null;
  const remoteJidAlt = normalizeJid(msg?.key?.remoteJidAlt || '') || null;
  const participant = normalizeJid(msg?.key?.participant || '') || null;
  const participantAlt = normalizeJid(msg?.key?.participantAlt || '') || null;
  const groupMessage = isGroupJid(remoteJid);

  let lid = null;
  let jid = null;

  if (groupMessage) {
    if (isWhatsAppJid(participant)) jid = participant;
    if (isLidJid(participant)) lid = participant;
    if (isWhatsAppJid(participantAlt)) jid = participantAlt;
    if (!lid && isLidJid(participantAlt)) lid = participantAlt;
  } else {
    if (isWhatsAppJid(remoteJid)) jid = remoteJid;
    if (!jid && isWhatsAppJid(remoteJidAlt)) jid = remoteJidAlt;
    if (!jid && isWhatsAppJid(participant)) jid = participant;
    if (!jid && isWhatsAppJid(participantAlt)) jid = participantAlt;
    if (isLidJid(participant)) lid = participant;
    if (!lid && isLidJid(remoteJid)) lid = remoteJid;
    if (!lid && isLidJid(participantAlt)) lid = participantAlt;
  }

  return { lid, jid, participantAlt, remoteJid, remoteJidAlt, groupMessage };
};

/**
 * Busca JID para um LID no banco e atualiza cache.
 * @param {string} lid
 * @returns {Promise<string|null>}
 */
const fetchJidByLid = async (lid) => {
  const cached = getCachedJidForLid(lid);
  if (cached !== undefined) return cached || null;

  const candidates = [lid];
  const base = normalizeLid(lid);
  if (base && base !== lid) candidates.push(base);

  const placeholders = candidates.map(() => '?').join(', ');
  const rows = await executeQuery(`SELECT lid, jid FROM ${TABLES.LID_MAP} WHERE lid IN (${placeholders})`, candidates);

  const rowMap = new Map();
  (rows || []).forEach((row) => {
    if (!row?.lid) return;
    const jid = row.jid && isWhatsAppJid(row.jid) ? normalizeJid(row.jid) : null;
    rowMap.set(row.lid, jid);
  });

  const direct = rowMap.has(lid) ? rowMap.get(lid) : undefined;
  const baseValue = base && base !== lid && rowMap.has(base) ? rowMap.get(base) : undefined;
  let resolved = direct ?? baseValue ?? null;
  let resolveSource = 'db';

  if (!resolved) {
    const authStoreResolved = await resolveAuthStoreJidByLid(lid);
    if (authStoreResolved) {
      resolved = authStoreResolved;
      resolveSource = 'auth-store';
    }
  }

  if (!resolved) {
    const normalized = base || lid;
    const [rawUser, rawServer] = String(normalized).split('@');
    const rootUser = rawUser ? rawUser.split(':')[0] : '';
    const server = rawServer || '';

    if (rootUser && server) {
      const derivedRows = await executeQuery(
        `SELECT jid
           FROM ${TABLES.LID_MAP}
          WHERE jid IS NOT NULL
            AND (
              lid = ?
              OR lid = ?
              OR lid = ?
              OR lid LIKE ?
            )
          ORDER BY last_seen DESC
          LIMIT 1`,
        [lid, base || lid, `${rootUser}@${server}`, `${rootUser}:%@${server}`],
      );
      const derivedJid = derivedRows?.[0]?.jid;
      if (derivedJid && isWhatsAppJid(derivedJid)) {
        resolved = normalizeJid(derivedJid);
        resolveSource = 'derived';
      }
    }
  }

  const directHasJid = typeof direct === 'string' && direct.length > 0;
  const shouldSeedDerived = Boolean(resolved && (!directHasJid || direct !== resolved));

  setCacheEntry(lid, resolved, resolved ? CACHE_TTL_MS : NEGATIVE_TTL_MS, shouldSeedDerived ? 0 : undefined);

  if (shouldSeedDerived) {
    queueLidUpdate(lid, resolved, resolveSource === 'auth-store' ? 'auth-store' : 'derived');
  }

  return resolved;
};

/**
 * Resolve ID canônico consultando banco se necessário.
 * @param {IdentityParams} [params]
 * @returns {Promise<string|null>}
 */
export const resolveUserId = async ({ lid, jid, participantAlt } = {}) => {
  const { directJid, lidValue, fallback } = resolveIdentityCandidates({ lid, jid, participantAlt });
  if (directJid) return directJid;
  if (!lidValue) return fallback;

  const mapped = await fetchJidByLid(lidValue);
  return mapped || lidValue;
};

/**
 * Reconcilia mensagens antigas do LID para o JID real.
 * @param {{lid?: string|null, jid?: string|null, source?: string}} [params]
 * @returns {Promise<{updated: number}>}
 */
export const reconcileLidToJid = async ({ lid, jid, source = 'map' } = {}) => {
  if (!lid || !jid) return { updated: 0 };
  let result;
  try {
    result = await executeQuery(
      `UPDATE ${TABLES.MESSAGES}
          SET sender_id = ?,
              canonical_sender_id = ?
        WHERE sender_id = ?
           OR canonical_sender_id = ?`,
      [jid, jid, lid, lid],
    );
  } catch (error) {
    // Compatibilidade para ambientes legados sem a coluna canonical_sender_id.
    const badField = String(error?.code || '').toUpperCase() === 'ER_BAD_FIELD_ERROR' || Number(error?.errno || 0) === 1054;
    if (!badField) throw error;
    result = await executeQuery(`UPDATE ${TABLES.MESSAGES} SET sender_id = ? WHERE sender_id = ?`, [jid, lid]);
  }

  const updated = Number(result?.affectedRows || 0);
  if (updated > 0) {
    logger.info('Reconciliação lid->jid aplicada.', {
      lid: maskJid(lid),
      jid: maskJid(jid),
      updated,
      source,
    });
  }
  return { updated };
};

const flushLidQueueCore = async () => {
  if (lidWriteBuffer.size === 0) return;
  const entries = Array.from(lidWriteBuffer.values());
  for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
    const batch = entries.slice(i, i + BATCH_LIMIT);
    if (!batch.length) continue;

    const sql = buildLidUpsertSql(batch.length);
    const params = [];
    for (const entry of batch) {
      params.push(entry.lid, entry.jid, entry.source);
    }

    try {
      await executeQuery(sql, params);
    } catch (error) {
      logger.error('Falha ao persistir batch do lid_map.', { error: error.message });
      recordError('lid_map');
      break;
    }

    const reconcileTargets = [];
    for (const entry of batch) {
      const current = lidWriteBuffer.get(entry.lid);
      if (!current || current.queuedAt === entry.queuedAt) {
        lidWriteBuffer.delete(entry.lid);
      }
      if (entry.reconcileJid) {
        reconcileTargets.push({ lid: entry.lid, jid: entry.reconcileJid, source: entry.source });
      }
    }

    updateLidQueueMetric();
    if (reconcileTargets.length > 0) {
      setImmediate(() => {
        for (const target of reconcileTargets) {
          reconcileLidToJid(target).catch((error) => {
            logger.warn('Falha ao reconciliar lid->jid.', { error: error.message });
            recordError('lid_map_reconcile');
          });
        }
      });
    }
  }
};

const lidFlushRunner = createFlushRunner({
  onFlush: flushLidQueueCore,
  onError: (error) => {
    logger.error('Falha ao executar flush do lid_map.', { error: error.message });
    recordError('lid_map');
  },
  onFinally: () => {
    updateLidQueueMetric();
  },
});

/**
 * Executa o flush do buffer lid_map em batch.
 * @returns {Promise<void>}
 */
export const flushLidQueue = async () => {
  await lidFlushRunner.run();
};

/**
 * Enfileira atualização de mapa LID/JID e retorna estado simplificado.
 * @param {string} lid
 * @param {string|null} jid
 * @param {string} [source='message']
 * @returns {Promise<{stored: boolean, reconciled: boolean}>}
 */
export const maybeStoreLidMap = async (lid, jid, source = 'message') => {
  const result = queueLidUpdate(lid, jid, source);
  return { stored: result.queued, reconciled: result.reconciled };
};

/**
 * Extrai lid/jid/participantAlt de um objeto ou string.
 * @param {object|string|null|undefined} value
 * @returns {{lid: string|null, jid: string|null, participantAlt: string|null, raw: string|null}}
 */
export const extractUserIdInfo = (value) => {
  if (!value) return { lid: null, jid: null, participantAlt: null, raw: null };
  if (typeof value === 'string') {
    return {
      lid: normalizeLid(value),
      jid: normalizeWhatsAppJid(value),
      participantAlt: null,
      raw: value,
    };
  }

  const readJid = (entry) => (typeof entry === 'string' ? normalizeJid(entry) || null : null);

  const participantAlt = readJid(value.participantAlt);
  const remoteJidAlt = readJid(value.remoteJidAlt);
  const alternateJid = participantAlt || remoteJidAlt;
  const participant = readJid(value.participant);
  const remoteJid = readJid(value.remoteJid);
  const jidValue = readJid(value.jid);
  const lidValue = readJid(value.lid);
  const idValue = typeof value.id === 'string' ? value.id : null;
  const jidCandidate = jidValue || idValue || alternateJid || participant || remoteJid || null;
  const lidCandidate = lidValue || participant || remoteJid || alternateJid || idValue || jidValue || null;

  return {
    lid: pickLid(lidCandidate, alternateJid, participant),
    jid: pickWhatsAppJid(jidCandidate, alternateJid, participant),
    participantAlt: alternateJid,
    raw: jidCandidate || lidCandidate,
  };
};

/**
 * Alias: verifica se valor e LID.
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export const isLidUserId = (value) => isLidJid(value);

/**
 * Alias: verifica se valor e JID do WhatsApp.
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export const isWhatsAppUserId = (value) => isWhatsAppJid(value);

/**
 * Retorna o range de IDs da tabela messages.
 * @returns {Promise<{minId: number, maxId: number}>}
 */
const getMessageIdRange = async () => {
  const rows = await executeQuery(`SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM ${TABLES.MESSAGES}`);
  const minId = Number(rows?.[0]?.min_id || 0);
  const maxId = Number(rows?.[0]?.max_id || 0);
  return { minId, maxId };
};

/**
 * Executa um batch do backfill lid_map.
 * @param {number} fromId
 * @param {number} toId
 * @returns {Promise<any>}
 */
const runBackfillBatch = async (fromId, toId) => {
  const lidFilter = buildServerLikeFilter('s.lid', LID_USER_JID_SERVERS);
  const jidFilter = buildServerLikeFilter('s.jid', WHATSAPP_USER_JID_SERVERS);

  const sql = `
    INSERT INTO ${TABLES.LID_MAP} (lid, jid, first_seen, last_seen, source)
    SELECT
      s.lid,
      s.jid,
      MIN(s.ts) AS first_seen,
      MAX(s.ts) AS last_seen,
      ?
    FROM (
      SELECT
        JSON_UNQUOTE(JSON_EXTRACT(m.raw_message, '$.key.participant')) AS lid,
        JSON_UNQUOTE(JSON_EXTRACT(m.raw_message, '$.key.participantAlt')) AS jid,
        m.timestamp AS ts
      FROM ${TABLES.MESSAGES} m
      WHERE m.id BETWEEN ? AND ?
        AND m.raw_message IS NOT NULL
        AND m.timestamp IS NOT NULL
    ) s
    WHERE ${lidFilter.clause}
      AND ${jidFilter.clause}
    GROUP BY s.lid, s.jid
    ON DUPLICATE KEY UPDATE
      jid = COALESCE(VALUES(jid), ${TABLES.LID_MAP}.jid),
      last_seen = GREATEST(${TABLES.LID_MAP}.last_seen, VALUES(last_seen)),
      source = VALUES(source)
  `;

  return executeQuery(sql, [BACKFILL_SOURCE, fromId, toId, ...lidFilter.params, ...jidFilter.params]);
};

/**
 * Backfill do lid_map a partir de messages.raw_message.
 * @param {{batchSize?: number, sleepMs?: number, maxBatches?: number|null}} [options]
 * @returns {Promise<{batches: number, minId?: number, maxId?: number}>}
 */
export const backfillLidMapFromMessages = async ({ batchSize = BACKFILL_DEFAULT_BATCH, sleepMs = 50, maxBatches = null } = {}) => {
  const { minId, maxId } = await getMessageIdRange();
  if (!minId || !maxId || maxId < minId) {
    logger.info('Backfill lid_map ignorado: tabela messages vazia.');
    return { batches: 0 };
  }

  let batches = 0;
  for (let start = minId; start <= maxId; start += batchSize) {
    const end = Math.min(start + batchSize - 1, maxId);
    await runBackfillBatch(start, end);
    batches += 1;
    if (maxBatches && batches >= maxBatches) break;
    if (sleepMs > 0) await delay(sleepMs);
  }

  logger.info('Backfill lid_map finalizado.', { batches, minId, maxId });
  return { batches, minId, maxId };
};

/**
 * Garante que o backfill rode apenas uma vez por processo.
 * @param {{batchSize?: number, sleepMs?: number, maxBatches?: number|null}} [options]
 * @returns {Promise<{batches: number, minId?: number, maxId?: number}>}
 */
export const backfillLidMapFromMessagesOnce = async (options = {}) => {
  if (!backfillPromise) {
    backfillPromise = backfillLidMapFromMessages(options).catch((error) => {
      logger.warn('Falha no backfill lid_map.', { error: error.message });
      throw error;
    });
  }
  return backfillPromise;
};

updateLidQueueMetric();
