import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import makeWASocket, { DisconnectReason, Browsers, getAggregateVotesInPollMessage, areJidsSameUser, WAMessageStatus, WAMessageStubType, delayCancellable, getStatusFromReceiptType, promiseTimeout } from '@whiskeysockets/baileys';

import NodeCache from 'node-cache';
import { parseEnvBool, parseEnvCsv, parseEnvInt, resolveBaileysVersion, resolveAddressingModeFromMessageKey, normalizeAddressingMode, normalizePnToJid, normalizeWAPresence, getMultiSessionRuntimeConfig, baileysConnectionLogger as logger, baileysSocketLogger } from '../config/index.js';

import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import path from 'node:path';

import { handleMessages } from '../controllers/messageController.js';
import { syncNewsBroadcastService } from '../services/messaging/newsBroadcastService.js';
import { setActiveSocket as storeActiveSocket, runActiveSocketMethod, isSocketOpen } from '../config/index.js';
import { recordError, recordMessagesUpsert } from '../observability/metrics.js';
import { resolveCaptchaByReaction } from '../services/messaging/captchaService.js';

import { handleGroupUpdate as handleGroupParticipantsEvent, handleGroupJoinRequest } from '../modules/adminModule/groupEventHandlers.js';

import { dbConfig, executeQuery, findBy, findById, pool, remove, TABLES } from '../../database/index.js';
import { extractSenderInfoFromMessage, primeLidCache, resolveUserIdCached, isLidUserId, isWhatsAppUserId } from '../config/index.js';
import { queueBaileysEventInsert, queueChatUpdate, queueLidUpdate, queueMessageInsert } from '../services/infra/dbWriteQueue.js';
import { buildGroupMetadataFromGroup, buildGroupMetadataFromUpdate, upsertGroupMetadata, parseParticipantsFromDb } from '../services/group/groupMetadataService.js';
import { buildMessageData } from '../configParts/messagePersistenceService.js';
import { useDbAuthState } from './baileysDbAuthState.js';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Indica se o ambiente de execução é de produção.
 * @type {boolean}
 */
const IS_PRODUCTION =
  String(process.env.NODE_ENV || '')
    .trim()
    .toLowerCase() === 'production';
/**
 * Tempo de vida (TTL) em segundos para o cache de retentativa de mensagem do Baileys.
 * @type {number}
 */
const MSG_RETRY_CACHE_TTL_SECONDS = parseEnvInt(process.env.BAILEYS_MSG_RETRY_CACHE_TTL_SECONDS, 600, 60, 24 * 60 * 60);
/**
 * Período de verificação em segundos para o cache de retentativa de mensagem do Baileys.
 * @type {number}
 */
const MSG_RETRY_CACHE_CHECKPERIOD_SECONDS = parseEnvInt(process.env.BAILEYS_MSG_RETRY_CACHE_CHECKPERIOD_SECONDS, 120, 30, 3600);
/**
 * Habilita ou desabilita o log de eventos do Baileys.
 * @type {boolean}
 */
const BAILEYS_EVENT_LOG_ENABLED = parseEnvBool(process.env.BAILEYS_EVENT_LOG_ENABLED, !IS_PRODUCTION);
/**
 * Tempo em milissegundos para resetar a contagem de tentativas de reconexão do Baileys.
 * @type {number}
 */
const BAILEYS_RECONNECT_ATTEMPT_RESET_MS = parseEnvInt(process.env.BAILEYS_RECONNECT_ATTEMPT_RESET_MS, 10 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
/**
 * Habilita ou desabilita a sincronização de grupos na conexão.
 * @type {boolean}
 */
const GROUP_SYNC_ON_CONNECT = parseEnvBool(process.env.GROUP_SYNC_ON_CONNECT, true);
/**
 * Tempo limite em milissegundos para a sincronização de grupos.
 * @type {number}
 */
const GROUP_SYNC_TIMEOUT_MS = parseEnvInt(process.env.GROUP_SYNC_TIMEOUT_MS, 30 * 1000, 5 * 1000, 120 * 1000);
/**
 * Número máximo de grupos a serem sincronizados.
 * @type {number}
 */
const GROUP_SYNC_MAX_GROUPS = parseEnvInt(process.env.GROUP_SYNC_MAX_GROUPS, 0, 0, 10_000);
/**
 * Tamanho do lote para a sincronização de grupos.
 * @type {number}
 */
const GROUP_SYNC_BATCH_SIZE = parseEnvInt(process.env.GROUP_SYNC_BATCH_SIZE, 50, 1, 1000);
/**
 * Habilita ou desabilita a rejeição automática de chamadas do Baileys.
 * @type {boolean}
 */
const BAILEYS_AUTO_REJECT_CALLS = parseEnvBool(process.env.BAILEYS_AUTO_REJECT_CALLS, true);
/**
 * Habilita ou desabilita a recriação automática de sessão do Baileys.
 * @type {boolean}
 */
const BAILEYS_ENABLE_AUTO_SESSION_RECREATION = parseEnvBool(process.env.BAILEYS_ENABLE_AUTO_SESSION_RECREATION, true);
/**
 * Habilita ou desabilita o cache de mensagens recentes do Baileys.
 * @type {boolean}
 */
const BAILEYS_ENABLE_RECENT_MESSAGE_CACHE = parseEnvBool(process.env.BAILEYS_ENABLE_RECENT_MESSAGE_CACHE, true);
/**
 * Habilita ou desabilita a geração de pré-visualizações de link de alta qualidade do Baileys.
 * @type {boolean}
 */
const BAILEYS_GENERATE_HIGH_QUALITY_LINK_PREVIEW = parseEnvBool(process.env.BAILEYS_GENERATE_HIGH_QUALITY_LINK_PREVIEW, false);
/**
 * Habilita ou desabilita o patch de mensagens antes do envio.
 * @type {boolean}
 */
const BAILEYS_PATCH_MESSAGE_BEFORE_SENDING = parseEnvBool(process.env.BAILEYS_PATCH_MESSAGE_BEFORE_SENDING, true);
/**
 * Tempo de vida (TTL) em segundos para o cache de dispositivos de usuário do Baileys.
 * @type {number}
 */
const BAILEYS_USER_DEVICES_CACHE_TTL_SECONDS = parseEnvInt(process.env.BAILEYS_USER_DEVICES_CACHE_TTL_SECONDS, 300, 30, 24 * 60 * 60);
/**
 * Período de verificação em segundos para o cache de dispositivos de usuário do Baileys.
 * @type {number}
 */
const BAILEYS_USER_DEVICES_CACHE_CHECKPERIOD_SECONDS = parseEnvInt(process.env.BAILEYS_USER_DEVICES_CACHE_CHECKPERIOD_SECONDS, 60, 15, 3600);
/**
 * Tempo de vida (TTL) em segundos para o cache de mídia do Baileys.
 * @type {number}
 */
const BAILEYS_MEDIA_CACHE_TTL_SECONDS = parseEnvInt(process.env.BAILEYS_MEDIA_CACHE_TTL_SECONDS, 3600, 60, 7 * 24 * 60 * 60);
/**
 * Período de verificação em segundos para o cache de mídia do Baileys.
 * @type {number}
 */
const BAILEYS_MEDIA_CACHE_CHECKPERIOD_SECONDS = parseEnvInt(process.env.BAILEYS_MEDIA_CACHE_CHECKPERIOD_SECONDS, 300, 30, 3600);
/**
 * Tempo de vida (TTL) em segundos para o cache de metadados de grupo do Baileys.
 * @type {number}
 */
const BAILEYS_GROUP_METADATA_CACHE_TTL_SECONDS = parseEnvInt(process.env.BAILEYS_GROUP_METADATA_CACHE_TTL_SECONDS, 120, 10, 3600);
/**
 * Período de verificação em segundos para o cache de metadados de grupo do Baileys.
 * @type {number}
 */
const BAILEYS_GROUP_METADATA_CACHE_CHECKPERIOD_SECONDS = parseEnvInt(process.env.BAILEYS_GROUP_METADATA_CACHE_CHECKPERIOD_SECONDS, 60, 10, 1800);
/**
 * Identificador lógico da sessão de autenticação do Baileys no MySQL.
 * Permite isolar múltiplas sessões no mesmo banco.
 * @type {string}
 */
const MULTI_SESSION_RUNTIME_CONFIG = getMultiSessionRuntimeConfig();
const BAILEYS_SESSION_IDS = Object.freeze(Array.isArray(MULTI_SESSION_RUNTIME_CONFIG?.sessionIds) && MULTI_SESSION_RUNTIME_CONFIG.sessionIds.length > 0 ? [...MULTI_SESSION_RUNTIME_CONFIG.sessionIds] : [String(process.env.BAILEYS_AUTH_SESSION_ID || 'default').trim() || 'default']);
const BAILEYS_SESSION_ID_SET = new Set(BAILEYS_SESSION_IDS);
const BAILEYS_PRIMARY_SESSION_ID = String(MULTI_SESSION_RUNTIME_CONFIG?.primarySessionId || BAILEYS_SESSION_IDS[0] || 'default').trim() || 'default';
/**
 * Habilita bootstrap inicial do auth state no MySQL usando os arquivos locais legados.
 * @type {boolean}
 */
const BAILEYS_AUTH_BOOTSTRAP_FROM_FILES = parseEnvBool(process.env.BAILEYS_AUTH_BOOTSTRAP_FROM_FILES, true);
/**
 * Habilita lock de escritor único para evitar múltiplos processos escrevendo a mesma sessão.
 * @type {boolean}
 */
const BAILEYS_SINGLE_WRITER_LOCK_ENABLED = parseEnvBool(process.env.BAILEYS_SINGLE_WRITER_LOCK_ENABLED, true);
/**
 * Timeout (segundos) para tentar adquirir lock de escritor único no MySQL.
 * @type {number}
 */
const BAILEYS_SINGLE_WRITER_LOCK_TIMEOUT_SECONDS = parseEnvInt(process.env.BAILEYS_SINGLE_WRITER_LOCK_TIMEOUT_SECONDS, 2, 0, 60);
/**
 * Atraso para nova tentativa quando lock de escritor único estiver ocupado.
 * @type {number}
 */
const BAILEYS_SINGLE_WRITER_LOCK_RETRY_DELAY_MS = parseEnvInt(process.env.BAILEYS_SINGLE_WRITER_LOCK_RETRY_DELAY_MS, 15_000, 1_000, 300_000);
/**
 * Nome do lock de escritor único usado no MySQL.
 * @type {string}
 */
const BAILEYS_SINGLE_WRITER_LOCK_NAME_BASE = (() => {
  const raw = String(process.env.BAILEYS_SINGLE_WRITER_LOCK_NAME || '').trim();
  if (raw) return raw;
  const dbLabel = String(dbConfig?.database || 'db').replace(/[^a-zA-Z0-9:_-]+/g, '_');
  return `omnizap:baileys:writer:${dbLabel}`;
})();

const normalizeSessionId = (sessionId) => {
  const normalized = String(sessionId || '').trim();
  if (!normalized) return BAILEYS_PRIMARY_SESSION_ID;
  if (!BAILEYS_SESSION_ID_SET.has(normalized)) return BAILEYS_PRIMARY_SESSION_ID;
  return normalized;
};

const getWriterLockNameBySession = (sessionId) => {
  const safeSessionId = normalizeSessionId(sessionId);
  const base = BAILEYS_SINGLE_WRITER_LOCK_NAME_BASE;
  if (base.includes('{sessionId}')) {
    return base.replace(/\{sessionId\}/g, safeSessionId);
  }
  return `${base}:${safeSessionId}`;
};
/**
 * Habilita ou desabilita o diário de eventos do Baileys.
 * @type {boolean}
 */
const BAILEYS_EVENT_JOURNAL_ENABLED = parseEnvBool(process.env.BAILEYS_EVENT_JOURNAL_ENABLED, false);
/**
 * Lista de eventos padrão para o diário de eventos do Baileys.
 * @type {string[]}
 */
const DEFAULT_BAILEYS_EVENT_JOURNAL_EVENTS = ['connection.update', 'messages.upsert', 'messages.update', 'messages.delete', 'messages.reaction', 'message-receipt.update', 'chats.upsert', 'chats.update', 'chats.delete', 'groups.upsert', 'groups.update', 'group-participants.update', 'group.join-request', 'lid-mapping.update'];
/**
 * Lista de eventos configurados para o diário de eventos do Baileys, obtidos do ambiente.
 * @type {string[]}
 */
const BAILEYS_EVENT_JOURNAL_EVENT_LIST = parseEnvCsv(process.env.BAILEYS_EVENT_JOURNAL_EVENTS, DEFAULT_BAILEYS_EVENT_JOURNAL_EVENTS);
/**
 * Indica se todos os eventos do Baileys devem ser registrados no diário.
 * @type {boolean}
 */
const BAILEYS_EVENT_JOURNAL_ALL_EVENTS = BAILEYS_EVENT_JOURNAL_EVENT_LIST.includes('*');
/**
 * Conjunto de eventos do Baileys a serem registrados no diário.
 * @type {Set<string>}
 */
const BAILEYS_EVENT_JOURNAL_EVENTS = new Set(BAILEYS_EVENT_JOURNAL_EVENT_LIST.filter((eventName) => eventName !== '*'));
/**
 * Conjunto de tipos de recibo que não mapeiam diretamente para status no Baileys.
 * @type {Set<string>}
 */
const MESSAGE_RECEIPT_TYPES_WITHOUT_STATUS = new Set(['hist_sync', 'peer_msg', 'inactive']);
/**
 * Mapeia códigos de status de mensagem do Baileys para seus nomes.
 * @type {Map<number, string>}
 */
const MESSAGE_STATUS_CODE_TO_NAME = new Map(
  Object.entries(WAMessageStatus)
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [value, name]),
);
/**
 * Mapeia códigos de tipo de stub de mensagem do Baileys para seus nomes.
 * @type {Map<number, string>}
 */
const MESSAGE_STUB_CODE_TO_NAME = new Map(
  Object.entries(WAMessageStubType)
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [value, name]),
);

/**
 * Normaliza o status de uma mensagem do Baileys.
 * @param {string | number} status - O código de status da mensagem.
 * @returns {{code: number, name: string | null} | null} Objeto contendo o código e o nome do status, ou null se inválido.
 */
const normalizeMessageStatus = (status) => {
  const statusCode = Number(status);
  if (!Number.isFinite(statusCode)) return null;
  return {
    code: statusCode,
    name: MESSAGE_STATUS_CODE_TO_NAME.get(statusCode) || null,
  };
};

/**
 * Normaliza o tipo de stub de uma mensagem do Baileys.
 * @param {string | number} stubType - O código do tipo de stub da mensagem.
 * @returns {{code: number, name: string | null} | null} Objeto contendo o código e o nome do tipo de stub, ou null se inválido.
 */
const normalizeMessageStubType = (stubType) => {
  const stubTypeCode = Number(stubType);
  if (!Number.isFinite(stubTypeCode)) return null;
  return {
    code: stubTypeCode,
    name: MESSAGE_STUB_CODE_TO_NAME.get(stubTypeCode) || null,
  };
};

/**
 * Normaliza o tipo de recibo de mensagem.
 * @param {string | undefined} receiptType - O tipo de recibo da mensagem.
 * @returns {string | undefined} O tipo de recibo normalizado, ou undefined se inválido.
 */
const normalizeMessageReceiptType = (receiptType) => {
  if (receiptType === undefined) return undefined;
  if (typeof receiptType !== 'string') return undefined;
  const normalizedType = receiptType.trim();
  if (!normalizedType) return undefined;
  if (getStatusFromReceiptType(normalizedType) !== undefined) return normalizedType;
  return MESSAGE_RECEIPT_TYPES_WITHOUT_STATUS.has(normalizedType) ? normalizedType : undefined;
};

/**
 * Instância ativa do socket do WhatsApp.
 * @type {import('@whiskeysockets/baileys').WASocket | null}
 */
let activeSocket = null;
/**
 * Contexto runtime de cada sessão de WhatsApp.
 * @typedef {{
 *   sessionId: string,
 *   socket: import('@whiskeysockets/baileys').WASocket|null,
 *   connectPromise: Promise<void>|null,
 *   reconnectTimeout: ReturnType<typeof delayCancellable>|null,
 *   reconnectWindowStartedAt: number,
 *   connectionAttempts: number,
 *   socketGeneration: number,
 *   writerLockConnection: import('mysql2/promise').PoolConnection|null
 * }} SessionContext
 */
/**
 * Registry em memória de contexto por sessão.
 * @type {Map<string, SessionContext>}
 */
const sessionContexts = new Map();

const createSessionContext = (sessionId) => ({
  sessionId,
  socket: null,
  connectPromise: null,
  reconnectTimeout: null,
  reconnectWindowStartedAt: 0,
  connectionAttempts: 0,
  socketGeneration: 0,
  writerLockConnection: null,
});

const getSessionContext = (sessionId, { createIfMissing = true } = {}) => {
  const safeSessionId = normalizeSessionId(sessionId);
  let context = sessionContexts.get(safeSessionId);
  if (!context && createIfMissing) {
    context = createSessionContext(safeSessionId);
    sessionContexts.set(safeSessionId, context);
  }
  return context || null;
};

const resolvePreferredActiveSocket = () => {
  const primaryContext = getSessionContext(BAILEYS_PRIMARY_SESSION_ID, { createIfMissing: false });
  if (isSocketOpen(primaryContext?.socket)) return primaryContext.socket;

  for (const context of sessionContexts.values()) {
    if (isSocketOpen(context?.socket)) return context.socket;
  }

  return primaryContext?.socket || null;
};

const syncLegacyActiveSocketReference = () => {
  activeSocket = resolvePreferredActiveSocket();
};
/**
 * Cache para contadores de retentativa de mensagens.
 * @type {NodeCache}
 */
const msgRetryCounterCache = new NodeCache({
  stdTTL: MSG_RETRY_CACHE_TTL_SECONDS,
  checkperiod: MSG_RETRY_CACHE_CHECKPERIOD_SECONDS,
  useClones: false,
});
/**
 * Backend de cache para informações de dispositivos de usuário.
 * @type {NodeCache}
 */
const userDevicesCacheBackend = new NodeCache({
  stdTTL: BAILEYS_USER_DEVICES_CACHE_TTL_SECONDS,
  checkperiod: BAILEYS_USER_DEVICES_CACHE_CHECKPERIOD_SECONDS,
  useClones: false,
});
/**
 * Backend de cache para mídia.
 * @type {NodeCache}
 */
const mediaCacheBackend = new NodeCache({
  stdTTL: BAILEYS_MEDIA_CACHE_TTL_SECONDS,
  checkperiod: BAILEYS_MEDIA_CACHE_CHECKPERIOD_SECONDS,
  useClones: false,
});
/**
 * Cache para metadados de grupos.
 * @type {NodeCache}
 */
const groupMetadataCache = new NodeCache({
  stdTTL: BAILEYS_GROUP_METADATA_CACHE_TTL_SECONDS,
  checkperiod: BAILEYS_GROUP_METADATA_CACHE_CHECKPERIOD_SECONDS,
  useClones: false,
});
/**
 * Número máximo de tentativas de conexão antes de entrar em um período de espera.
 * @type {number}
 */
const MAX_CONNECTION_ATTEMPTS = 5;
/**
 * Atraso inicial em milissegundos para a primeira tentativa de reconexão.
 * @type {number}
 */
const INITIAL_RECONNECT_DELAY = 3000;
/**
 * Nomes de todos os eventos do Baileys que são monitorados.
 * @type {string[]}
 */
const BAILEYS_EVENT_NAMES = ['connection.update', 'creds.update', 'messaging-history.set', 'chats.upsert', 'chats.update', 'lid-mapping.update', 'chats.delete', 'presence.update', 'contacts.upsert', 'contacts.update', 'messages.delete', 'messages.update', 'messages.media-update', 'messages.upsert', 'messages.reaction', 'message-receipt.update', 'groups.upsert', 'groups.update', 'group-participants.update', 'group.join-request', 'group.member-tag.update', 'blocklist.set', 'blocklist.update', 'call', 'labels.edit', 'labels.association', 'newsletter.reaction', 'newsletter.view', 'newsletter-participants.update', 'newsletter-settings.update', 'chats.lock', 'settings.update'];
/**
 * Conjunto de eventos do Baileys que possuem lógica de log interna.
 * @type {Set<string>}
 */
const BAILEYS_EVENTS_WITH_INTERNAL_LOG = new Set(['creds.update', 'connection.update', 'messages.upsert', 'messages.update', 'messages.media-update', 'message-receipt.update', 'groups.update', 'group-participants.update']);
/**
 * Conjunto de eventos do Baileys que são considerados "barulhentos" em produção e podem ser desabilitados.
 * @type {Set<string>}
 */
const BAILEYS_NOISY_EVENTS_IN_PRODUCTION = new Set(['presence.update']);

/**
 * Cria um adaptador de armazenamento de cache simples para um NodeCache.
 * @param {NodeCache} cache - Instância do NodeCache.
 * @returns {{get: Function, set: Function, del: Function, flushAll: Function}} Adaptador de cache.
 */
const createCacheStoreAdapter = (cache) => ({
  get: (key) => cache.get(key),
  set: (key, value) => cache.set(key, value),
  del: (key) => cache.del(key),
  flushAll: () => cache.flushAll(),
});

/**
 * Cria um adaptador de armazenamento de cache estendido com métodos multi para um NodeCache.
 * @param {NodeCache} cache - Instância do NodeCache.
 * @returns {{get: Function, set: Function, del: Function, flushAll: Function, mget: Function, mset: Function, mdel: Function}} Adaptador de cache estendido.
 */
const createExtendedCacheStoreAdapter = (cache) => ({
  ...createCacheStoreAdapter(cache),
  mget: (keys) => cache.mget(keys),
  mset: (entries) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    cache.mset(
      entries
        .filter((entry) => entry && typeof entry.key === 'string')
        .map((entry) => ({
          key: entry.key,
          val: entry.value,
        })),
    );
  },
  mdel: (keys) => cache.del(keys),
});

/**
 * Cache para informações de dispositivos de usuário.
 * @type {ReturnType<typeof createExtendedCacheStoreAdapter>}
 */
const userDevicesCache = createExtendedCacheStoreAdapter(userDevicesCacheBackend);
/**
 * Cache para mídia.
 * @type {ReturnType<typeof createCacheStoreAdapter>}
 */
const mediaCache = createCacheStoreAdapter(mediaCacheBackend);

/**
 * Verifica se um valor é um objeto "simples" (plain object).
 * @param {unknown} value - O valor a ser verificado.
 * @returns {boolean} True se for um objeto simples, false caso contrário.
 */
const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';

/**
 * Sanitiza o payload de uma mensagem removendo funções, valores undefined e referências circulares.
 * @param {any} value - O payload da mensagem a ser sanitizado.
 * @param {WeakSet<object>} [seen=new WeakSet()] - Conjunto de objetos já vistos para evitar referências circulares.
 * @returns {any} O payload sanitizado.
 */
const sanitizeMessagePayload = (value, seen = new WeakSet()) => {
  if (value === undefined || typeof value === 'function') return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof Date) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;

  seen.add(value);
  if (Array.isArray(value)) {
    const sanitizedArray = [];
    for (const item of value) {
      const sanitized = sanitizeMessagePayload(item, seen);
      if (typeof sanitized !== 'undefined') sanitizedArray.push(sanitized);
    }
    return sanitizedArray;
  }

  if (!isPlainObject(value)) return value;

  const sanitizedObject = {};
  for (const [key, item] of Object.entries(value)) {
    const sanitized = sanitizeMessagePayload(item, seen);
    if (typeof sanitized !== 'undefined') {
      sanitizedObject[key] = sanitized;
    }
  }

  return sanitizedObject;
};

/**
 * Aplica saneamento a uma mensagem antes de enviá-la, se a funcionalidade estiver habilitada.
 * @async
 * @param {any} message - A mensagem a ser potencialmente sanitizada.
 * @returns {Promise<any>} A mensagem sanitizada ou original.
 */
const patchMessageBeforeSending = async (message) => {
  if (!BAILEYS_PATCH_MESSAGE_BEFORE_SENDING) return message;
  try {
    const sanitized = sanitizeMessagePayload(message);
    if (!sanitized || typeof sanitized !== 'object') return message;
    return sanitized;
  } catch (error) {
    logger.warn('Falha ao sanitizar payload de mensagem antes do envio. Usando payload original.', {
      action: 'patch_message_before_sending_error',
      error: error?.message,
    });
    return message;
  }
};

/**
 * Constrói uma lista de participantes de grupo a partir de dados brutos do DB.
 * @param {any} participantsRaw - Dados brutos dos participantes.
 * @returns {Array<{id: string, admin?: 'admin' | 'superadmin'} | null>} Lista de participantes formatada.
 */
const buildCachedParticipants = (participantsRaw) => {
  const participants = parseParticipantsFromDb(participantsRaw);
  if (!Array.isArray(participants) || participants.length === 0) return [];
  return participants
    .map((entry) => {
      const id = entry?.id || entry?.jid || entry?.lid || null;
      if (!id) return null;
      const admin = entry?.admin === 'admin' || entry?.admin === 'superadmin' ? entry.admin : entry?.isAdmin ? 'admin' : undefined;
      return admin ? { id, admin } : { id };
    })
    .filter(Boolean);
};

/**
 * Resolve metadados de grupo do cache local ou do banco de dados.
 * @async
 * @param {string} jid - O JID do grupo.
 * @returns {Promise<object | undefined>} Metadados do grupo ou undefined.
 */
const resolveCachedGroupMetadata = async (jid) => {
  if (!jid || typeof jid !== 'string' || !jid.endsWith('@g.us')) return undefined;

  const cached = groupMetadataCache.get(jid);
  if (cached) return cached;

  try {
    const row = await findById('groups_metadata', jid);
    const data = Array.isArray(row) ? row[0] : row;
    if (!data) return undefined;

    const participants = buildCachedParticipants(data.participants || data.participants_json);
    if (participants.length === 0) return undefined;

    const metadata = {
      id: data.id || jid,
      subject: data.subject || data.name || '',
      desc: data.description || data.desc || '',
      owner: data.owner_jid || data.owner || undefined,
      creation: Number.isFinite(Number(data.creation)) ? Number(data.creation) : undefined,
      participants,
      addressingMode: normalizeAddressingMode(data.addressing_mode || data.addressingMode),
      ephemeralDuration: Number.isFinite(Number(data.ephemeral_duration ?? data.ephemeralDuration)) ? Number(data.ephemeral_duration ?? data.ephemeralDuration) : undefined,
    };

    groupMetadataCache.set(jid, metadata);
    return metadata;
  } catch (error) {
    logger.debug('Falha ao resolver metadados de grupo do cache local.', {
      action: 'cached_group_metadata_lookup_error',
      jid,
      error: error?.message,
    });
    return undefined;
  }
};

/**
 * Invalida o cache de metadados para um grupo específico.
 * @param {string} groupId - O ID do grupo a ser invalidado no cache.
 * @returns {void}
 */
const invalidateCachedGroupMetadata = (groupId) => {
  if (!groupId || typeof groupId !== 'string') return;
  groupMetadataCache.del(groupId);
};

/**
 * Gera um resumo conciso do payload de um evento do Baileys para fins de log e persistência.
 * @param {string} eventName - O nome do evento do Baileys.
 * @param {any} payload - O payload do evento.
 * @returns {object} Um objeto resumindo o payload.
 */
const summarizeBaileysEventPayload = (eventName, payload) => {
  if (payload === null) return { payloadType: 'null' };
  if (payload === undefined) return { payloadType: 'undefined' };
  if (Buffer.isBuffer(payload)) {
    return { payloadType: 'buffer', bytes: payload.length };
  }

  if (Array.isArray(payload)) {
    const summary = { payloadType: 'array', items: payload.length };
    if (payload.length > 0 && payload[0] && typeof payload[0] === 'object') {
      summary.sampleKeys = Object.keys(payload[0]).slice(0, 6);
    }
    return summary;
  }

  if (typeof payload !== 'object') {
    if (typeof payload === 'string') {
      return { payloadType: 'string', length: payload.length };
    }
    return { payloadType: typeof payload, value: payload };
  }

  const summary = { payloadType: 'object', keys: Object.keys(payload).slice(0, 10) };

  switch (eventName) {
    case 'messaging-history.set':
      summary.chats = Array.isArray(payload.chats) ? payload.chats.length : 0;
      summary.contacts = Array.isArray(payload.contacts) ? payload.contacts.length : 0;
      summary.messages = Array.isArray(payload.messages) ? payload.messages.length : 0;
      summary.isLatest = payload.isLatest ?? null;
      summary.progress = payload.progress ?? null;
      summary.syncType = payload.syncType ?? null;
      break;
    case 'presence.update':
      summary.id = payload.id ?? null;
      summary.presencesCount = payload.presences ? Object.keys(payload.presences).length : 0;
      break;
    case 'chats.lock':
      summary.id = payload.id ?? null;
      summary.locked = payload.locked ?? null;
      break;
    case 'settings.update':
      summary.setting = payload.setting ?? null;
      break;
    case 'messages.delete':
      if (payload.all === true) {
        summary.all = true;
        summary.jid = payload.jid ?? null;
      } else if (Array.isArray(payload.keys)) {
        summary.keysCount = payload.keys.length;
      }
      break;
    case 'messages.update':
      if (Array.isArray(payload)) {
        summary.updatesCount = payload.length;
        const firstUpdate = payload[0];
        const status = normalizeMessageStatus(firstUpdate?.update?.status);
        const stubType = normalizeMessageStubType(firstUpdate?.update?.messageStubType ?? firstUpdate?.update?.stubType);
        const addressingMode = resolveAddressingModeFromMessageKey(firstUpdate?.key);
        summary.pollUpdatesCount = payload.filter((entry) => Array.isArray(entry?.update?.pollUpdates) && entry.update.pollUpdates.length > 0).length;
        summary.firstStatusCode = status?.code ?? null;
        summary.firstStatusName = status?.name ?? null;
        summary.firstStubTypeCode = stubType?.code ?? null;
        summary.firstStubTypeName = stubType?.name ?? null;
        summary.firstAddressingMode = addressingMode ?? null;
      }
      break;
    case 'messages.media-update':
      if (Array.isArray(payload)) {
        summary.updatesCount = payload.length;
        summary.withMediaCount = payload.filter((entry) => Boolean(entry?.media)).length;
        summary.withErrorCount = payload.filter((entry) => Boolean(entry?.error)).length;
      }
      break;
    case 'message-receipt.update':
      if (Array.isArray(payload)) {
        summary.receiptsCount = payload.length;
        const receiptTypes = new Set();
        for (const entry of payload) {
          const type = normalizeMessageReceiptType(entry?.receipt?.type);
          if (type) receiptTypes.add(type);
        }
        summary.receiptTypes = Array.from(receiptTypes).slice(0, 8);
      }
      break;
    case 'blocklist.set':
      summary.blocklistCount = Array.isArray(payload.blocklist) ? payload.blocklist.length : 0;
      break;
    case 'blocklist.update':
      summary.blocklistCount = Array.isArray(payload.blocklist) ? payload.blocklist.length : 0;
      summary.type = payload.type ?? null;
      break;
    case 'group.join-request':
      summary.groupId = payload.id ?? null;
      summary.participant = payload.participant ?? null;
      summary.action = payload.action ?? null;
      summary.method = payload.method ?? null;
      break;
    case 'group.member-tag.update':
      summary.groupId = payload.groupId ?? null;
      summary.participant = payload.participant ?? null;
      summary.label = payload.label ?? null;
      break;
    case 'labels.association':
      summary.type = payload.type ?? null;
      summary.labelId = payload.association?.labelId ?? null;
      summary.chatId = payload.association?.chatId ?? null;
      break;
    case 'labels.edit':
      summary.labelId = payload.id ?? null;
      summary.labelName = payload.name ?? payload.label ?? null;
      break;
    case 'newsletter.reaction':
      summary.id = payload.id ?? null;
      summary.serverId = payload.server_id ?? null;
      summary.reactionCode = payload.reaction?.code ?? null;
      summary.reactionCount = payload.reaction?.count ?? null;
      summary.reactionRemoved = payload.reaction?.removed ?? null;
      break;
    case 'newsletter.view':
      summary.id = payload.id ?? null;
      summary.serverId = payload.server_id ?? null;
      summary.count = payload.count ?? null;
      break;
    case 'newsletter-participants.update':
      summary.id = payload.id ?? null;
      summary.user = payload.user ?? null;
      summary.action = payload.action ?? null;
      summary.newRole = payload.new_role ?? null;
      break;
    case 'newsletter-settings.update':
      summary.id = payload.id ?? null;
      summary.updateKeys = payload.update ? Object.keys(payload.update).slice(0, 6) : [];
      break;
    case 'lid-mapping.update':
      summary.lid = payload.lid ?? null;
      summary.pn = payload.pn ?? payload.jid ?? null;
      break;
    default:
      break;
  }

  return summary;
};

/**
 * Determina se um evento específico do Baileys deve ser logado.
 * @param {string} eventName - O nome do evento do Baileys.
 * @returns {boolean} True se o evento deve ser logado, false caso contrário.
 */
const shouldLogBaileysEvent = (eventName) => {
  if (!BAILEYS_EVENT_LOG_ENABLED) return false;
  if (IS_PRODUCTION && BAILEYS_NOISY_EVENTS_IN_PRODUCTION.has(eventName)) return false;
  return true;
};

/**
 * Registra os loggers para os eventos do Baileys.
 * @param {import('@whiskeysockets/baileys').WASocket} sock - A instância do socket do Baileys.
 * @returns {void}
 */
const registerBaileysEventLoggers = (sock) => {
  const eventsToLog = BAILEYS_EVENT_NAMES.filter((eventName) => !BAILEYS_EVENTS_WITH_INTERNAL_LOG.has(eventName) && shouldLogBaileysEvent(eventName));

  for (const eventName of eventsToLog) {
    sock.ev.on(eventName, (payload) => {
      const summary = summarizeBaileysEventPayload(eventName, payload);
      logger.debug('Evento Baileys recebido.', {
        action: 'baileys_event',
        event: eventName,
        ...summary,
        timestamp: __timeNowIso(),
      });
    });
  }

  logger.debug('Loggers de eventos Baileys registrados.', {
    action: 'baileys_event_logger_ready',
    enabled: BAILEYS_EVENT_LOG_ENABLED,
    eventsCount: eventsToLog.length,
    events: eventsToLog,
  });
};

/**
 * Determina se um evento do Baileys deve ser persistido no diário de eventos.
 * @param {string} eventName - O nome do evento do Baileys.
 * @returns {boolean} True se o evento deve ser persistido, false caso contrário.
 */
const shouldPersistBaileysEvent = (eventName) => {
  if (!BAILEYS_EVENT_JOURNAL_ENABLED) return false;
  if (BAILEYS_EVENT_JOURNAL_ALL_EVENTS) return BAILEYS_EVENT_NAMES.includes(eventName);
  return BAILEYS_EVENT_JOURNAL_EVENTS.has(eventName);
};

/**
 * Retorna a primeira string não vazia de uma lista de valores.
 * @param {...(string | null | undefined)} values - Os valores a serem verificados.
 * @returns {string | null} A primeira string não vazia encontrada ou null.
 */
const takeFirstString = (...values) => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return null;
};

/**
 * Extrai referências (chatId, messageId, participantId) de um payload de evento do Baileys.
 * @param {any} payload - O payload do evento do Baileys.
 * @returns {{chatId: string | null, messageId: string | null, participantId: string | null}} Objeto contendo as referências extraídas.
 */
const extractBaileysEventReferences = (payload) => {
  const refs = {
    chatId: null,
    messageId: null,
    participantId: null,
  };

  const assignChat = (...values) => {
    if (refs.chatId) return;
    refs.chatId = takeFirstString(...values);
  };

  const assignMessage = (...values) => {
    if (refs.messageId) return;
    refs.messageId = takeFirstString(...values);
  };

  const assignParticipant = (...values) => {
    if (refs.participantId) return;
    refs.participantId = takeFirstString(...values);
  };

  const applyFromKey = (key) => {
    if (!key || typeof key !== 'object') return;
    assignChat(key.remoteJid, key.remoteJidAlt);
    assignMessage(key.id);
    assignParticipant(key.participant, key.participantAlt);
  };

  const applyFromObject = (value) => {
    if (!value || typeof value !== 'object') return;

    applyFromKey(value.key);
    applyFromKey(value.msg?.key);
    applyFromKey(value.reaction?.key);
    applyFromKey(value.reactionMessage?.key);
    applyFromKey(value.reactedKey);

    assignChat(value.id, value.groupId, value.jid, value.chatId);
    assignMessage(value.messageId, value.msgId, value.server_id);
    assignParticipant(value.participant, value.user, value.lid, value.pn);

    if (Array.isArray(value.participants) && value.participants.length > 0) {
      assignParticipant(value.participants[0]);
    }
    if (Array.isArray(value.keys) && value.keys.length > 0) {
      applyFromKey(value.keys[0]);
    }
    if (Array.isArray(value.messages) && value.messages.length > 0) {
      applyFromObject(value.messages[0]);
    }
  };

  if (Array.isArray(payload)) {
    for (const item of payload) {
      applyFromObject(item);
      if (refs.chatId && refs.messageId && refs.participantId) break;
    }
  } else {
    applyFromObject(payload);
  }

  return refs;
};

/**
 * Resolve IDs de contato (LID/JID) a partir de payloads de contacts.upsert/contacts.update.
 * @param {any} contact
 * @returns {{lid: string | null, jid: string | null}}
 */
const resolveContactIdsForLidMap = (contact) => {
  const lidCandidates = [contact?.lid, contact?.id, contact?.jid];
  let lid = null;
  for (const candidate of lidCandidates) {
    if (isLidUserId(candidate)) {
      lid = candidate;
      break;
    }
  }

  const jidCandidates = [contact?.jid, contact?.phoneNumber, contact?.id];
  let jid = null;
  for (const candidate of jidCandidates) {
    if (isWhatsAppUserId(candidate)) {
      jid = candidate;
      break;
    }
    const normalizedPn = normalizePnToJid(candidate);
    if (normalizedPn && isWhatsAppUserId(normalizedPn)) {
      jid = normalizedPn;
      break;
    }
  }

  return { lid, jid };
};

/**
 * Enfileira atualizações do lid_map a partir de eventos de contato.
 * @param {Array<any>} contacts
 * @param {string} source
 * @returns {void}
 */
const queueContactsLidUpdates = (contacts, source) => {
  if (!Array.isArray(contacts) || contacts.length === 0) return;

  for (const contact of contacts) {
    try {
      const { lid, jid } = resolveContactIdsForLidMap(contact);
      if (!lid) continue;
      queueLidUpdate(lid, jid, source);
    } catch (error) {
      logger.warn('Falha ao processar evento de contatos para lid_map.', {
        source,
        error: error.message,
      });
    }
  }
};

/**
 * Registra o mecanismo de diário (journal) para os eventos do Baileys.
 * Eventos selecionados são enfileirados para persistência.
 * @param {import('@whiskeysockets/baileys').WASocket} sock - A instância do socket do Baileys.
 * @param {number} generation - A geração atual do socket.
 * @param {string} sessionId - Sessão associada ao socket.
 * @returns {void}
 */
const registerBaileysEventJournal = (sock, generation, sessionId) => {
  const safeSessionId = normalizeSessionId(sessionId);
  if (!BAILEYS_EVENT_JOURNAL_ENABLED) {
    logger.debug('Journal de eventos Baileys desativado por configuração.', {
      action: 'baileys_event_journal_disabled',
      sessionId: safeSessionId,
    });
    return;
  }

  const unknownEvents = BAILEYS_EVENT_JOURNAL_EVENT_LIST.filter((eventName) => eventName !== '*' && !BAILEYS_EVENT_NAMES.includes(eventName));
  if (unknownEvents.length > 0) {
    logger.warn('Alguns eventos configurados para journal não existem na lista conhecida do Baileys.', {
      action: 'baileys_event_journal_unknown_events',
      sessionId: safeSessionId,
      unknownEvents,
    });
  }

  const eventsToPersist = BAILEYS_EVENT_NAMES.filter((eventName) => shouldPersistBaileysEvent(eventName));
  if (eventsToPersist.length === 0) {
    logger.warn('Journal de eventos Baileys habilitado sem eventos válidos para persistir.', {
      action: 'baileys_event_journal_empty',
      sessionId: safeSessionId,
      configuredEvents: BAILEYS_EVENT_JOURNAL_EVENT_LIST,
    });
    return;
  }

  for (const eventName of eventsToPersist) {
    sock.ev.on(eventName, (payload) => {
      try {
        const summary = summarizeBaileysEventPayload(eventName, payload);
        const refs = extractBaileysEventReferences(payload);
        queueBaileysEventInsert({
          session_id: safeSessionId,
          event_name: eventName,
          socket_generation: generation,
          chat_id: refs.chatId,
          message_id: refs.messageId,
          participant_id: refs.participantId,
          payload_summary: summary,
          event_timestamp: __timeNow(),
        });
      } catch (error) {
        logger.warn('Falha ao enfileirar evento Baileys para journal.', {
          action: 'baileys_event_journal_enqueue_failed',
          sessionId: safeSessionId,
          eventName,
          error: error?.message,
        });
      }
    });
  }

  logger.info('Journal de eventos Baileys habilitado.', {
    action: 'baileys_event_journal_ready',
    sessionId: safeSessionId,
    generation,
    eventsCount: eventsToPersist.length,
    events: eventsToPersist,
  });
};

/**
 * Faz parse seguro de JSON com suporte a Buffer e retorna fallback em caso de erro.
 * @param {unknown} value - Valor a ser interpretado.
 * @param {any} fallback - Valor retornado quando o parse falha ou o valor é inválido.
 * @returns {any} Objeto parseado ou fallback.
 */
const safeJsonParse = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (Buffer.isBuffer(value)) {
    return safeJsonParse(value.toString('utf8'), fallback);
  }
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    logger.warn('Falha ao fazer parse de JSON armazenado.', {
      error: error.message,
    });
    return fallback;
  }
};

/**
 * Normaliza PN para JID de WhatsApp quando o payload vier sem domínio.
 * @param {string|null|undefined} pn
 * @returns {string|null}
 */
/**
 * Persiste mensagens recebidas quando o tipo do upsert permite salvamento.
 * @async
 * @param {Array<import('@whiskeysockets/baileys').WAMessage>} incomingMessages - Mensagens recebidas.
 * @param {'append' | 'notify' | string} type - Tipo do evento de upsert.
 * @returns {Promise<void>} Conclusão da persistência.
 */
async function persistIncomingMessages(incomingMessages, type, sessionId = BAILEYS_PRIMARY_SESSION_ID) {
  if (type !== 'append' && type !== 'notify') return;

  const entries = [];
  const lidsToPrime = new Set();

  for (const msg of incomingMessages) {
    if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
    const resolvedAddressingMode = resolveAddressingModeFromMessageKey(msg?.key);
    const normalizedMsg =
      resolvedAddressingMode && msg?.key && msg.key.addressingMode !== resolvedAddressingMode
        ? {
            ...msg,
            key: {
              ...msg.key,
              addressingMode: resolvedAddressingMode,
            },
          }
        : msg;

    const senderInfo = extractSenderInfoFromMessage(normalizedMsg);
    if (senderInfo.lid) lidsToPrime.add(senderInfo.lid);
    entries.push({ msg: normalizedMsg, senderInfo });
  }

  if (lidsToPrime.size > 0) {
    try {
      await primeLidCache(Array.from(lidsToPrime));
    } catch (error) {
      logger.warn('Falha ao aquecer cache de LID.', { error: error.message });
    }
  }

  for (const { msg, senderInfo } of entries) {
    if (senderInfo.lid) {
      queueLidUpdate(senderInfo.lid, senderInfo.jid, 'message');
    }

    const canonicalSenderId = resolveUserIdCached(senderInfo) || msg.key.participant || msg.key.remoteJid;

    const messageData = {
      ...buildMessageData(msg, canonicalSenderId),
      session_id: normalizeSessionId(sessionId),
    };
    queueMessageInsert(messageData);
  }
}

/**
 * Recupera mensagem armazenada para suporte a recursos (ex.: enquetes) do Baileys.
 * @async
 * @param {import('@whiskeysockets/baileys').WAMessageKey} key - Chave da mensagem.
 * @returns {Promise<import('@whiskeysockets/baileys').proto.IMessage | undefined>} Conteúdo da mensagem armazenada.
 */
async function getStoredMessage(key, sessionId = BAILEYS_PRIMARY_SESSION_ID) {
  const messageId = key?.id;
  const remoteJid = key?.remoteJid;
  if (!messageId || !remoteJid) return undefined;

  try {
    const safeSessionId = normalizeSessionId(sessionId);
    let record = null;

    try {
      const rows = await executeQuery(
        `SELECT raw_message
           FROM ${TABLES.MESSAGES}
          WHERE session_id = ? AND message_id = ? AND chat_id = ?
          LIMIT 1`,
        [safeSessionId, messageId, remoteJid],
      );
      record = rows?.[0] || null;
    } catch (error) {
      if (String(error?.code || '') !== 'ER_BAD_FIELD_ERROR') {
        throw error;
      }
      const fallbackRows = await findBy('messages', { message_id: messageId, chat_id: remoteJid }, { limit: 1 });
      record = fallbackRows?.[0] || null;
    }

    const stored = safeJsonParse(record?.raw_message, null);
    if (record?.raw_message && !stored) {
      logger.error('Falha ao interpretar raw_message armazenado.', {
        sessionId: safeSessionId,
        messageId,
        remoteJid,
      });
    }
    return stored?.message ?? undefined;
  } catch (error) {
    logger.error('Erro ao buscar mensagem armazenada no banco:', {
      sessionId: normalizeSessionId(sessionId),
      error: error.message,
      messageId,
      remoteJid,
    });
    return undefined;
  }
}

/**
 * Limpa o timeout de reconexão agendado, se houver.
 * @param {string} sessionId
 * @returns {void}
 */
const clearReconnectTimeout = (sessionId = BAILEYS_PRIMARY_SESSION_ID) => {
  const context = getSessionContext(sessionId, { createIfMissing: false });
  if (!context?.reconnectTimeout) return;
  context.reconnectTimeout.cancel();
  context.reconnectTimeout = null;
};

/**
 * Reseta o estado das tentativas de reconexão.
 * @param {string} sessionId
 * @returns {void}
 */
const resetReconnectState = (sessionId = BAILEYS_PRIMARY_SESSION_ID) => {
  const context = getSessionContext(sessionId);
  context.connectionAttempts = 0;
  context.reconnectWindowStartedAt = 0;
};

/**
 * Calcula o número da próxima tentativa de reconexão.
 * Reseta a contagem de tentativas se a janela de reconexão expirou.
 * @param {string} sessionId
 * @returns {number} O número da próxima tentativa.
 */
const getNextReconnectAttempt = (sessionId = BAILEYS_PRIMARY_SESSION_ID) => {
  const context = getSessionContext(sessionId);
  const now = __timeNowMs();
  if (!context.reconnectWindowStartedAt || now - context.reconnectWindowStartedAt >= BAILEYS_RECONNECT_ATTEMPT_RESET_MS) {
    context.reconnectWindowStartedAt = now;
    context.connectionAttempts = 0;
  }
  context.connectionAttempts += 1;
  return context.connectionAttempts;
};

/**
 * Agenda uma reconexão com o WhatsApp após um determinado atraso.
 * Evita agendar múltiplas reconexões.
 * @param {string} sessionId
 * @param {number} delay - O atraso em milissegundos antes de tentar a reconexão.
 * @returns {void}
 */
const scheduleReconnect = (sessionId, delay) => {
  const safeSessionId = normalizeSessionId(sessionId);
  const context = getSessionContext(safeSessionId);
  if (context.reconnectTimeout) return;

  const pendingReconnect = delayCancellable(Math.max(0, Number(delay) || 0));
  context.reconnectTimeout = pendingReconnect;
  pendingReconnect.delay
    .then(() => {
      if (context.reconnectTimeout !== pendingReconnect) return;
      context.reconnectTimeout = null;
      connectToWhatsApp(safeSessionId).catch((error) => {
        logger.error('Falha ao executar reconexão agendada.', {
          action: 'reconnect_schedule_failure',
          sessionId: safeSessionId,
          errorMessage: error?.message,
          stack: error?.stack,
          timestamp: __timeNowIso(),
        });
      });
    })
    .catch((error) => {
      if (context.reconnectTimeout === pendingReconnect) {
        context.reconnectTimeout = null;
      }
      if (
        String(error?.message || '')
          .trim()
          .toLowerCase() === 'cancelled'
      ) {
        return;
      }
      logger.warn('Falha ao aguardar atraso da reconexão agendada.', {
        action: 'reconnect_schedule_delay_error',
        sessionId: safeSessionId,
        errorMessage: error?.message,
      });
    });
};

/**
 * Libera lock de escritor único do Baileys, se estiver ativo.
 * @param {string} sessionId
 * @param {string} reason
 * @returns {Promise<void>}
 */
const releaseBaileysWriterLock = async (sessionId, reason = 'unknown') => {
  const safeSessionId = normalizeSessionId(sessionId);
  const context = getSessionContext(safeSessionId, { createIfMissing: false });
  const connection = context?.writerLockConnection;
  if (!connection) return;
  const lockName = getWriterLockNameBySession(safeSessionId);
  context.writerLockConnection = null;

  try {
    const rows = await executeQuery('SELECT RELEASE_LOCK(?) AS released', [lockName], connection);
    const released = Number(rows?.[0]?.released) === 1;
    logger.info('Lock de escritor do Baileys liberado.', {
      action: 'baileys_writer_lock_released',
      sessionId: safeSessionId,
      reason,
      released,
      lockName,
      timestamp: __timeNowIso(),
    });
  } catch (error) {
    logger.warn('Falha ao liberar lock de escritor do Baileys.', {
      action: 'baileys_writer_lock_release_error',
      sessionId: safeSessionId,
      reason,
      lockName,
      errorMessage: error?.message,
      timestamp: __timeNowIso(),
    });
  } finally {
    try {
      connection.release();
    } catch (error) {
      logger.debug('Conexao dedicada do lock ja estava encerrada.', {
        action: 'baileys_writer_lock_connection_already_closed',
        errorMessage: error?.message,
      });
    }
  }
};

/**
 * Garante lock de escritor único para a sessão do Baileys.
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
const ensureBaileysWriterLock = async (sessionId) => {
  if (!BAILEYS_SINGLE_WRITER_LOCK_ENABLED) {
    return true;
  }

  const safeSessionId = normalizeSessionId(sessionId);
  const context = getSessionContext(safeSessionId);
  const lockName = getWriterLockNameBySession(safeSessionId);

  if (context.writerLockConnection) {
    return true;
  }

  const connection = await pool.getConnection();

  try {
    const rows = await executeQuery('SELECT GET_LOCK(?, ?) AS lock_status', [lockName, BAILEYS_SINGLE_WRITER_LOCK_TIMEOUT_SECONDS], connection);
    const lockStatus = Number(rows?.[0]?.lock_status);
    if (lockStatus !== 1) {
      connection.release();
      logger.warn('Nao foi possivel adquirir lock de escritor do Baileys nesta tentativa.', {
        action: 'baileys_writer_lock_busy',
        sessionId: safeSessionId,
        lockName,
        timeoutSeconds: BAILEYS_SINGLE_WRITER_LOCK_TIMEOUT_SECONDS,
        status: Number.isFinite(lockStatus) ? lockStatus : null,
        retryAfterMs: BAILEYS_SINGLE_WRITER_LOCK_RETRY_DELAY_MS,
        timestamp: __timeNowIso(),
      });
      return false;
    }

    context.writerLockConnection = connection;
    logger.info('Lock de escritor do Baileys adquirido com sucesso.', {
      action: 'baileys_writer_lock_acquired',
      sessionId: safeSessionId,
      lockName,
      timeoutSeconds: BAILEYS_SINGLE_WRITER_LOCK_TIMEOUT_SECONDS,
      timestamp: __timeNowIso(),
    });
    return true;
  } catch (error) {
    try {
      connection.release();
    } catch {
      // Ignora falhas ao liberar conexão após erro de aquisição.
    }
    throw error;
  }
};

const releaseAllBaileysWriterLocks = async (reason = 'unknown') => {
  const targets = Array.from(sessionContexts.keys());
  if (!targets.length) {
    await releaseBaileysWriterLock(BAILEYS_PRIMARY_SESSION_ID, reason).catch(() => {});
    return;
  }
  await Promise.allSettled(targets.map((sessionId) => releaseBaileysWriterLock(sessionId, reason)));
};

process.once('beforeExit', () => {
  releaseAllBaileysWriterLocks('before_exit').catch(() => {});
});

process.once('SIGINT', () => {
  releaseAllBaileysWriterLocks('sigint').catch(() => {});
});

process.once('SIGTERM', () => {
  releaseAllBaileysWriterLocks('sigterm').catch(() => {});
});

/**
 * Envolve uma promessa com um timeout. Se a promessa não resolver dentro do tempo limite, ela é rejeitada.
 * @template T
 * @param {Promise<T>} promise - A promessa a ser envolvida.
 * @param {number} timeoutMs - O tempo limite em milissegundos.
 * @param {string} [timeoutLabel='operation_timeout'] - Rótulo para o erro de timeout.
 * @returns {Promise<T>} A promessa envolvida com timeout.
 */
const withTimeout = (promise, timeoutMs, timeoutLabel = 'operation_timeout') =>
  promiseTimeout(timeoutMs, (resolve, reject) => {
    promise.then(resolve).catch(reject);
  }).catch((error) => {
    if (
      String(error?.message || '')
        .trim()
        .toLowerCase() === 'timed out'
    ) {
      throw new Error(timeoutLabel);
    }
    throw error;
  });

/**
 * Sincroniza metadados de grupos ao abrir a conexão com o WhatsApp.
 * Busca todos os grupos participantes e os atualiza no banco de dados.
 * @async
 * @param {import('@whiskeysockets/baileys').WASocket} sock - A instância do socket do Baileys.
 * @returns {Promise<void>}
 */
const syncGroupsOnConnectionOpen = async (sock) => {
  if (!GROUP_SYNC_ON_CONNECT) {
    logger.info('Sincronização de grupos no connect desativada por configuração.', {
      action: 'groups_sync_disabled',
      timestamp: __timeNowIso(),
    });
    return;
  }

  const allGroups = await withTimeout(sock.groupFetchAllParticipating(), GROUP_SYNC_TIMEOUT_MS, `groups_sync_timeout_${GROUP_SYNC_TIMEOUT_MS}ms`);
  const allGroupEntries = Object.values(allGroups || {});
  const selectedGroups = GROUP_SYNC_MAX_GROUPS > 0 ? allGroupEntries.slice(0, GROUP_SYNC_MAX_GROUPS) : allGroupEntries;

  let syncedCount = 0;
  let failedCount = 0;

  for (let offset = 0; offset < selectedGroups.length; offset += GROUP_SYNC_BATCH_SIZE) {
    const batch = selectedGroups.slice(offset, offset + GROUP_SYNC_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((group) =>
        upsertGroupMetadata(group.id, buildGroupMetadataFromGroup(group), {
          mergeExisting: false,
        }).then((result) => {
          invalidateCachedGroupMetadata(group.id);
          return result;
        }),
      ),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') syncedCount += 1;
      else failedCount += 1;
    }
  }

  logger.info('📁 Metadados de grupos sincronizados com MySQL.', {
    action: 'groups_synced',
    totalFetched: allGroupEntries.length,
    totalSynced: syncedCount,
    totalFailed: failedCount,
    totalSkipped: Math.max(0, allGroupEntries.length - selectedGroups.length),
    batchSize: GROUP_SYNC_BATCH_SIZE,
    maxGroups: GROUP_SYNC_MAX_GROUPS > 0 ? GROUP_SYNC_MAX_GROUPS : null,
    timeoutMs: GROUP_SYNC_TIMEOUT_MS,
    timestamp: __timeNowIso(),
  });
};

/**
 * Inicia e gerencia a conexão com o WhatsApp usando o Baileys.
 * Configura autenticação, cria o socket e registra handlers de eventos.
 * Gerencia a lógica de reconexão e a distribuição de eventos.
 * @async
 * @returns {Promise<void>} Conclusão da inicialização e do registro de handlers.
 * @throws {Error} Lança erro se a conexão inicial falhar.
 */
export async function connectToWhatsApp(sessionId = BAILEYS_PRIMARY_SESSION_ID) {
  const safeSessionId = normalizeSessionId(sessionId);
  const context = getSessionContext(safeSessionId);

  if (context.connectPromise) {
    return context.connectPromise;
  }

  if (isSocketOpen(context.socket)) {
    return;
  }

  logger.info('Iniciando conexão com o WhatsApp...', {
    action: 'connect_init',
    sessionId: safeSessionId,
    timestamp: __timeNowIso(),
  });

  const currentConnectPromise = (async () => {
    clearReconnectTimeout(safeSessionId);
    const isWriterReady = await ensureBaileysWriterLock(safeSessionId);
    if (!isWriterReady) {
      scheduleReconnect(safeSessionId, BAILEYS_SINGLE_WRITER_LOCK_RETRY_DELAY_MS);
      return;
    }

    const generation = ++context.socketGeneration;
    const legacyAuthPath = path.join(__dirname, 'auth');
    const { state, saveCreds } = await useDbAuthState({
      sessionId: safeSessionId,
      bootstrapFromDir: legacyAuthPath,
      bootstrapFromFiles: BAILEYS_AUTH_BOOTSTRAP_FROM_FILES,
    });

    const version = await resolveBaileysVersion();

    logger.debug('Dados de autenticação carregados com sucesso.', {
      sessionId: safeSessionId,
      authSessionId: safeSessionId,
      bootstrappedFromFiles: BAILEYS_AUTH_BOOTSTRAP_FROM_FILES,
      version,
      generation,
    });

    /** @type {import('@whiskeysockets/baileys').UserFacingSocketConfig} */
    const socketConfig = {
      version,
      auth: state,
      logger: baileysSocketLogger,
      browser: Browsers.macOS('Desktop'),
      qrTimeout: 30000,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      msgRetryCounterCache,
      maxMsgRetryCount: 5,
      retryRequestDelayMs: 250,
      getMessage: (key) => getStoredMessage(key, safeSessionId),
      userDevicesCache,
      mediaCache,
      cachedGroupMetadata: resolveCachedGroupMetadata,
      patchMessageBeforeSending,
      enableAutoSessionRecreation: BAILEYS_ENABLE_AUTO_SESSION_RECREATION,
      enableRecentMessageCache: BAILEYS_ENABLE_RECENT_MESSAGE_CACHE,
      generateHighQualityLinkPreview: BAILEYS_GENERATE_HIGH_QUALITY_LINK_PREVIEW,
    };

    const sock = makeWASocket(socketConfig);

    context.socket = sock;
    storeActiveSocket(sock, safeSessionId);
    syncLegacyActiveSocketReference();

    const isCurrentSocket = () => {
      const latest = getSessionContext(safeSessionId, { createIfMissing: false });
      return Boolean(latest && latest.socket === sock && latest.socketGeneration === generation);
    };

    sock.ev.on('creds.update', async () => {
      if (!isCurrentSocket()) return;
      logger.debug('Atualizando credenciais de autenticação...', {
        action: 'creds_update',
        sessionId: safeSessionId,
        timestamp: __timeNowIso(),
      });
      await saveCreds();
    });

    sock.ev.on('connection.update', (update) => {
      if (!isCurrentSocket()) return;
      handleConnectionUpdate(update, sock, safeSessionId, generation);
      if (update.connection === 'open') {
        syncNewsBroadcastService();
      }
      logger.debug('Estado da conexão atualizado.', {
        action: 'connection_update',
        sessionId: safeSessionId,
        status: update.connection,
        lastDisconnect: update.lastDisconnect?.error?.message || null,
        isNewLogin: update.isNewLogin || false,
        timestamp: __timeNowIso(),
      });
    });

    sock.ev.on('messages.upsert', (update) => {
      if (!isCurrentSocket()) return;
      const start = process.hrtime.bigint();
      const messagesCount = Array.isArray(update?.messages) ? update.messages.length : 0;
      const eventType = update?.type || 'unknown';
      try {
        logger.debug('Novo(s) evento(s) em messages.upsert', {
          action: 'messages_upsert',
          sessionId: safeSessionId,
          type: update.type,
          messagesCount: update.messages.length,
          remoteJid: update.messages[0]?.key.remoteJid || null,
        });
        const persistPromise = persistIncomingMessages(update.messages, update.type, safeSessionId).catch((error) => {
          logger.error('Erro ao persistir mensagens no banco de dados:', {
            sessionId: safeSessionId,
            error: error.message,
          });
          recordError('messages_upsert');
        });
        const handlePromise = handleMessages(update, sock, { sessionId: safeSessionId }).catch((error) => {
          recordError('messages_upsert');
          throw error;
        });

        Promise.allSettled([persistPromise, handlePromise]).then((results) => {
          const ok = results.every((result) => result.status === 'fulfilled');
          const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
          recordMessagesUpsert({
            durationMs,
            type: eventType,
            messagesCount,
            ok,
          });
        });
      } catch (error) {
        logger.error('Erro no evento messages.upsert:', {
          sessionId: safeSessionId,
          error: error.message,
          stack: error.stack,
          action: 'messages_upsert_error',
        });
        recordError('messages_upsert');
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        recordMessagesUpsert({
          durationMs,
          type: eventType,
          messagesCount,
          ok: false,
        });
      }
    });

    sock.ev.on('chats.upsert', (newChats) => {
      if (!isCurrentSocket()) return;
      for (const chat of newChats) {
        queueChatUpdate(chat, { partial: false, forceName: true });
      }
    });

    sock.ev.on('chats.update', (updates) => {
      if (!isCurrentSocket()) return;
      for (const update of updates) {
        queueChatUpdate(update, { partial: true });
      }
    });

    sock.ev.on('chats.delete', (deletions) => {
      if (!isCurrentSocket()) return;
      for (const chatId of deletions) {
        remove('chats', chatId).catch((error) => {
          logger.error('Erro ao remover chat do banco:', {
            sessionId: safeSessionId,
            error: error.message,
            chatId,
          });
        });
      }
    });

    sock.ev.on('groups.upsert', async (newGroups) => {
      if (!isCurrentSocket()) return;
      for (const group of newGroups) {
        try {
          await upsertGroupMetadata(group.id, buildGroupMetadataFromGroup(group), {
            mergeExisting: false,
          });
          invalidateCachedGroupMetadata(group.id);
        } catch (error) {
          logger.error('Erro no upsert do grupo:', {
            sessionId: safeSessionId,
            error: error.message,
            groupId: group.id,
          });
        }
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      if (!isCurrentSocket()) return;
      queueContactsLidUpdates(contacts, 'contacts.upsert');
    });

    sock.ev.on('contacts.update', (updates) => {
      if (!isCurrentSocket()) return;
      queueContactsLidUpdates(updates, 'contacts.update');
    });

    sock.ev.on('lid-mapping.update', (update) => {
      if (!isCurrentSocket()) return;
      try {
        const lid = typeof update?.lid === 'string' ? update.lid : null;
        const pnJid = normalizePnToJid(update?.pn);
        if (!lid || !pnJid) return;
        queueLidUpdate(lid, pnJid, 'lid-mapping');
      } catch (error) {
        logger.warn('Falha ao processar lid-mapping.update para lid_map.', {
          sessionId: safeSessionId,
          error: error.message,
        });
      }
    });

    sock.ev.on('messages.update', (update) => {
      if (!isCurrentSocket()) return;
      try {
        logger.debug('Atualização de mensagens recebida.', {
          action: 'messages_update',
          sessionId: safeSessionId,
          updatesCount: update.length,
        });
        handleMessageUpdate(update, sock);
      } catch (error) {
        logger.error('Erro no evento messages.update:', {
          sessionId: safeSessionId,
          error: error.message,
          stack: error.stack,
          action: 'messages_update_error',
        });
      }
    });

    sock.ev.on('messages.media-update', (updates) => {
      if (!isCurrentSocket()) return;
      if (!Array.isArray(updates)) return;

      const erroredUpdates = updates.filter((entry) => entry?.error);
      if (erroredUpdates.length > 0) {
        const firstError = erroredUpdates[0]?.error;
        logger.warn('Falha reportada em atualização de mídia.', {
          action: 'messages_media_update_error',
          sessionId: safeSessionId,
          updatesCount: updates.length,
          errorCount: erroredUpdates.length,
          firstMessageId: erroredUpdates[0]?.key?.id || null,
          firstRemoteJid: erroredUpdates[0]?.key?.remoteJid || null,
          firstErrorMessage: firstError?.message || null,
        });
        return;
      }

      logger.debug('Atualização de mídia de mensagem recebida.', {
        action: 'messages_media_update',
        sessionId: safeSessionId,
        updatesCount: updates.length,
      });
    });

    sock.ev.on('message-receipt.update', (updates) => {
      if (!isCurrentSocket()) return;
      if (!Array.isArray(updates) || updates.length === 0) return;

      const receiptTypes = new Set();
      let invalidReceiptTypeCount = 0;
      for (const update of updates) {
        const receiptType = normalizeMessageReceiptType(update?.receipt?.type);
        if (receiptType) {
          receiptTypes.add(receiptType);
        } else if (update?.receipt?.type !== undefined) {
          invalidReceiptTypeCount += 1;
        }
      }

      logger.debug('Atualização de recibos de mensagem recebida.', {
        action: 'message_receipt_update',
        sessionId: safeSessionId,
        updatesCount: updates.length,
        receiptTypes: Array.from(receiptTypes),
        invalidReceiptTypeCount,
        sampleMessageId: updates[0]?.key?.id || null,
        sampleRemoteJid: updates[0]?.key?.remoteJid || null,
      });
    });

    sock.ev.on('messages.reaction', async (updates) => {
      if (!isCurrentSocket()) return;
      try {
        const reactions = Array.isArray(updates) ? updates : [updates];
        for (const update of reactions) {
          const key = update?.key || update?.msg?.key || update?.reaction?.key || null;
          const reaction = update?.reaction || update?.msg?.reaction || update?.reactionMessage || null;
          const reactedKey = reaction?.key || update?.reactedKey || update?.reactionMessage?.key || null;

          const groupId = key?.remoteJid || reactedKey?.remoteJid || null;
          const senderJid = key?.participant || update?.participant || reaction?.sender || null;
          const senderIdentity = {
            participant: key?.participant || update?.participant || reaction?.sender || null,
            participantAlt: key?.participantAlt || update?.participantAlt || reaction?.participantAlt || reaction?.key?.participantAlt || null,
            jid: senderJid,
          };
          const reactedMessageId = reactedKey?.id || null;
          const reactionText = typeof reaction?.text === 'string' ? reaction.text : '';

          if (groupId && (senderJid || senderIdentity.participantAlt)) {
            await resolveCaptchaByReaction({
              groupId,
              senderJid,
              senderIdentity,
              reactedMessageId,
              reactionText,
            });
          }
        }
      } catch (error) {
        logger.error('Erro no evento messages.reaction:', {
          sessionId: safeSessionId,
          error: error.message,
          stack: error.stack,
          action: 'messages_reaction_error',
        });
      }
    });

    sock.ev.on('groups.update', (updates) => {
      if (!isCurrentSocket()) return;
      try {
        logger.debug('Grupo(s) atualizado(s).', {
          action: 'groups_update',
          sessionId: safeSessionId,
          groupCount: updates.length,
          groupIds: updates.map((u) => u.id),
        });
        handleGroupUpdate(updates);
      } catch (err) {
        logger.error('Erro no evento groups.update:', {
          sessionId: safeSessionId,
          error: err.message,
          stack: err.stack,
          action: 'groups_update_error',
        });
      }
    });

    sock.ev.on('group-participants.update', (update) => {
      if (!isCurrentSocket()) return;
      try {
        logger.debug('Participantes do grupo atualizados.', {
          action: 'group_participants_update',
          sessionId: safeSessionId,
          groupId: update.id,
          actionType: update.action,
          participants: update.participants,
        });
        invalidateCachedGroupMetadata(update.id);
        handleGroupParticipantsEvent(sock, update.id, update.participants, update.action);
      } catch (err) {
        logger.error('Erro no evento group-participants.update:', {
          sessionId: safeSessionId,
          error: err.message,
          stack: err.stack,
          action: 'group_participants_update_error',
        });
      }
    });

    sock.ev.on('group.join-request', (update) => {
      if (!isCurrentSocket()) return;
      try {
        logger.debug('Solicitação de entrada no grupo recebida.', {
          action: 'group_join_request',
          sessionId: safeSessionId,
          groupId: update?.id,
          participant: update?.participant,
          method: update?.method,
          joinAction: update?.action,
        });
        handleGroupJoinRequest(sock, update);
      } catch (err) {
        logger.error('Erro no evento group.join-request:', {
          sessionId: safeSessionId,
          error: err.message,
          stack: err.stack,
          action: 'group_join_request_error',
        });
      }
    });

    sock.ev.on('call', async (calls) => {
      if (!isCurrentSocket()) return;
      if (!BAILEYS_AUTO_REJECT_CALLS) return;
      if (!Array.isArray(calls)) return;

      for (const call of calls) {
        try {
          if (!call || call.status !== 'offer') continue;
          if (!call.id || !call.from) continue;

          const myJid = sock.user?.id || null;
          if (myJid && areJidsSameUser(call.from, myJid)) {
            continue;
          }

          await sock.rejectCall(call.id, call.from);
          logger.info('Chamada recebida rejeitada automaticamente.', {
            action: 'call_auto_reject',
            sessionId: safeSessionId,
            callId: call.id,
            from: call.from,
            isGroup: call.isGroup || false,
            isVideo: call.isVideo || false,
            timestamp: __timeNowIso(),
          });
        } catch (error) {
          logger.warn('Falha ao rejeitar chamada automaticamente.', {
            action: 'call_auto_reject_failed',
            sessionId: safeSessionId,
            callId: call?.id || null,
            from: call?.from || null,
            error: error?.message,
          });
        }
      }
    });

    registerBaileysEventLoggers(sock);
    registerBaileysEventJournal(sock, generation, safeSessionId);

    logger.info('Conexão com o WhatsApp estabelecida com sucesso.', {
      action: 'connect_success',
      sessionId: safeSessionId,
      generation,
      timestamp: __timeNowIso(),
    });
  })();

  context.connectPromise = currentConnectPromise;

  try {
    await currentConnectPromise;
  } finally {
    if (context.connectPromise === currentConnectPromise) {
      context.connectPromise = null;
    }
  }
}

/**
 * Conecta todas as sessões configuradas no runtime.
 * @returns {Promise<void>}
 */
export async function connectAllWhatsAppSessions() {
  const results = await Promise.allSettled(BAILEYS_SESSION_IDS.map((sessionId) => connectToWhatsApp(sessionId)));
  const failures = results
    .map((result, index) => ({ result, sessionId: BAILEYS_SESSION_IDS[index] }))
    .filter(({ result }) => result.status === 'rejected');

  if (failures.length > 0) {
    const error = new Error(`Falha ao conectar ${failures.length}/${BAILEYS_SESSION_IDS.length} sessões do WhatsApp.`);
    // @ts-ignore enrich error object for logs
    error.failures = failures.map(({ sessionId, result }) => ({
      sessionId,
      message: result.reason?.message || String(result.reason || ''),
    }));
    throw error;
  }
}

/**
 * Gerencia atualizações de estado da conexão com o WhatsApp.
 * Lida com a exibição de QR code, reconexão automática e ações pós-conexão (como a sincronização de grupos).
 * @async
 * @param {import('@whiskeysockets/baileys').ConnectionState} update - Objeto contendo o estado atual da conexão.
 * @param {import('@whiskeysockets/baileys').WASocket} sock - Instância do socket do WhatsApp que disparou a atualização.
 * @param {string} sessionId - Sessão do socket.
 * @param {number} generation - Geração do socket.
 * @returns {Promise<void>} Uma promessa que resolve quando o processamento do estado da conexão é concluído.
 */
async function handleConnectionUpdate(update, sock, sessionId, generation) {
  const safeSessionId = normalizeSessionId(sessionId);
  const context = getSessionContext(safeSessionId, { createIfMissing: false });
  if (!context) return;
  if (context.socket !== sock) return;
  if (context.socketGeneration !== generation) return;

  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    logger.info('📱 QR Code gerado! Escaneie com seu WhatsApp.', {
      action: 'qr_code_generated',
      sessionId: safeSessionId,
      timestamp: __timeNowIso(),
    });
    qrcode.generate(qr, { small: true });
  }

  if (connection === 'close') {
    const disconnectCode = lastDisconnect?.error?.output?.statusCode || 'unknown';
    const errorMessage = lastDisconnect?.error?.message || 'Sem mensagem de erro';

    const shouldReconnect = lastDisconnect?.error instanceof Boom && disconnectCode !== DisconnectReason.loggedOut;

    if (shouldReconnect) {
      const attempt = getNextReconnectAttempt(safeSessionId);
      if (attempt <= MAX_CONNECTION_ATTEMPTS) {
        const reconnectDelay = INITIAL_RECONNECT_DELAY * Math.pow(2, attempt - 1);
        logger.warn(`⚠️ Conexão perdida. Tentando reconectar...`, {
          action: 'reconnect_attempt',
          sessionId: safeSessionId,
          attempt,
          maxAttempts: MAX_CONNECTION_ATTEMPTS,
          delay: reconnectDelay,
          reasonCode: disconnectCode,
          errorMessage,
          timestamp: __timeNowIso(),
        });
        context.socket = null;
        storeActiveSocket(null, safeSessionId);
        syncLegacyActiveSocketReference();
        scheduleReconnect(safeSessionId, reconnectDelay);
      } else {
        logger.error('❌ Limite de tentativas atingido; aguardando janela para novo retry.', {
          action: 'reconnect_backoff_window',
          sessionId: safeSessionId,
          totalAttempts: attempt,
          maxAttempts: MAX_CONNECTION_ATTEMPTS,
          retryAfterMs: BAILEYS_RECONNECT_ATTEMPT_RESET_MS,
          reasonCode: disconnectCode,
          errorMessage,
          timestamp: __timeNowIso(),
        });
        context.socket = null;
        storeActiveSocket(null, safeSessionId);
        syncLegacyActiveSocketReference();
        context.connectionAttempts = 0;
        context.reconnectWindowStartedAt = __timeNowMs();
        scheduleReconnect(safeSessionId, BAILEYS_RECONNECT_ATTEMPT_RESET_MS);
      }
    } else {
      logger.error('❌ Conexão fechada definitivamente.', {
        action: 'connection_closed',
        sessionId: safeSessionId,
        reasonCode: disconnectCode,
        errorMessage,
        timestamp: __timeNowIso(),
      });
      context.socket = null;
      storeActiveSocket(null, safeSessionId);
      syncLegacyActiveSocketReference();
      await releaseBaileysWriterLock(safeSessionId, 'connection_closed_no_reconnect');
    }
  }

  if (connection === 'open') {
    logger.info('✅ Conectado com sucesso ao WhatsApp!', {
      action: 'connection_open',
      sessionId: safeSessionId,
      timestamp: __timeNowIso(),
    });

    resetReconnectState(safeSessionId);
    clearReconnectTimeout(safeSessionId);

    if (process.send) {
      process.send('ready');
      logger.info('🟢 Sinal de "ready" enviado ao PM2.', {
        action: 'pm2_ready_signal',
        sessionId: safeSessionId,
        timestamp: __timeNowIso(),
      });
    }

    try {
      await syncGroupsOnConnectionOpen(sock);
    } catch (error) {
      logger.error('❌ Erro ao carregar metadados de grupos na conexão.', {
        action: 'groups_load_error',
        sessionId: safeSessionId,
        errorMessage: error.message,
        stack: error.stack,
        timeoutMs: GROUP_SYNC_TIMEOUT_MS,
        timestamp: __timeNowIso(),
      });
    }
  }
}

/**
 * Processa atualizações em mensagens existentes, como votos em enquetes.
 * @async
 * @param {Array<import('@whiskeysockets/baileys').WAMessageUpdate>} updates - Array de objetos de atualização de mensagens.
 * @param {import('@whiskeysockets/baileys').WASocket} sock - Instância do socket do WhatsApp.
 * @returns {Promise<void>} Uma promessa que resolve quando o processamento das atualizações é concluído.
 */
async function handleMessageUpdate(updates, sock) {
  for (const { key, update } of updates) {
    const status = normalizeMessageStatus(update?.status);
    const stubType = normalizeMessageStubType(update?.messageStubType ?? update?.stubType);
    const addressingMode = resolveAddressingModeFromMessageKey(key);

    if (status || stubType || addressingMode) {
      logger.debug('Atualização de estado da mensagem recebida.', {
        action: 'message_state_update',
        remoteJid: key?.remoteJid || null,
        messageId: key?.id || null,
        participant: key?.participant || null,
        participantAlt: key?.participantAlt || null,
        addressingMode: addressingMode || null,
        statusCode: status?.code ?? null,
        statusName: status?.name ?? null,
        stubTypeCode: stubType?.code ?? null,
        stubTypeName: stubType?.name ?? null,
        timestamp: __timeNowIso(),
      });
    }

    if (update.pollUpdates) {
      try {
        const pollCreation = await sock.getMessage(key);

        if (pollCreation) {
          const aggregatedVotes = getAggregateVotesInPollMessage({
            message: pollCreation,
            pollUpdates: update.pollUpdates,
          });

          logger.info('📊 Votos da enquete atualizados.', {
            action: 'poll_votes_updated',
            remoteJid: key.remoteJid,
            messageId: key.id,
            participant: key.participant || null,
            votesCount: Object.values(aggregatedVotes || {}).reduce((a, b) => a + b, 0),
            votes: aggregatedVotes,
            timestamp: __timeNowIso(),
          });
        } else {
          logger.warn('⚠️ Mensagem da enquete não encontrada.', {
            action: 'poll_message_not_found',
            key,
            timestamp: __timeNowIso(),
          });
        }
      } catch (error) {
        logger.error('❌ Erro ao processar atualização de votos da enquete.', {
          action: 'poll_update_error',
          errorMessage: error.message,
          stack: error.stack,
          key,
          timestamp: __timeNowIso(),
        });
      }
    }
  }
}

/**
 * Atualiza metadados de grupos no banco MySQL a partir dos eventos do Baileys.
 * Processa alterações de grupo (título, descrição, proprietário e participantes)
 * persistindo a versão consolidada no MySQL.
 * @async
 * @param {Array<import('@whiskeysockets/baileys').GroupUpdate>} updates - Eventos de atualização de grupos.
 * @returns {Promise<void>} Conclusão das atualizações em lote.
 */
async function handleGroupUpdate(updates) {
  await Promise.all(
    updates.map(async (event) => {
      try {
        const groupId = event.id;
        const oldData = (await findById('groups_metadata', groupId)) || {};
        const updatedData = buildGroupMetadataFromUpdate(event, oldData);

        await upsertGroupMetadata(groupId, updatedData, { mergeExisting: false });
        invalidateCachedGroupMetadata(groupId);

        const changedFields = Object.keys(event).filter((k) => event[k] !== oldData[k]);
        logger.info('📦 Metadados do grupo atualizados', {
          action: 'group_metadata_updated',
          groupId,
          groupName: updatedData.subject || oldData.subject || 'Desconhecido',
          changedFields,
          timestamp: __timeNowIso(),
        });
      } catch (error) {
        logger.error('❌ Erro ao atualizar metadados do grupo', {
          action: 'group_metadata_update_error',
          errorMessage: error.message,
          stack: error.stack,
          event,
          timestamp: __timeNowIso(),
        });
      }
    }),
  );
}

/**
 * Retorna a instância atual do socket ativo do WhatsApp.
 * @returns {import('@whiskeysockets/baileys').WASocket | null} O objeto socket do Baileys ativo ou `null` se não houver conexão ativa.
 */
export function getActiveSocket() {
  syncLegacyActiveSocketReference();
  logger.debug('🔍 Recuperando instância do socket ativo.', {
    action: 'get_active_socket',
    socketExists: !!activeSocket,
    timestamp: __timeNowIso(),
  });
  return activeSocket;
}

/**
 * Retorna o socket de uma sessão específica.
 * @param {string} sessionId
 * @returns {import('@whiskeysockets/baileys').WASocket | null}
 */
export function getSocketBySession(sessionId = BAILEYS_PRIMARY_SESSION_ID) {
  const safeSessionId = normalizeSessionId(sessionId);
  const context = getSessionContext(safeSessionId, { createIfMissing: false });
  return context?.socket || null;
}

/**
 * Executa um método centralizado no socket ativo, tratando erros e mapeando-os para respostas HTTP.
 * @async
 * @param {string} methodName - O nome do método a ser invocado no socket.
 * @param {...any} args - Argumentos a serem repassados para o método do socket.
 * @returns {Promise<any>} Uma promessa que resolve com o resultado do método do socket ou rejeita com um erro `Boom` em caso de falha.
 * @throws {Boom} Retorna um erro HTTP 503 se o socket não estiver disponível, ou 501 se o método não existir.
 */
async function runControllerSocketMethod(methodName, ...args) {
  const socket = getActiveSocket();
  try {
    return await runActiveSocketMethod(methodName, ...args);
  } catch (error) {
    const message = String(error?.message || '');
    if (message.includes('Socket do WhatsApp indisponível')) {
      logger.warn('Socket ativo indisponível para operação.', {
        action: methodName,
        socketExists: !!socket,
        socketOpen: isSocketOpen(socket),
        timestamp: __timeNowIso(),
      });
      throw new Boom('Socket do WhatsApp indisponível no momento.', { statusCode: 503 });
    }
    if (message.includes('não disponível no socket')) {
      throw new Boom(`Método "${methodName}" não disponível neste socket.`, { statusCode: 501 });
    }
    throw error;
  }
}

/**
 * Retorna as configurações de privacidade da conta do WhatsApp.
 * @async
 * @param {boolean} [force=false] - Se `true`, força um refresh das configurações no servidor.
 * @returns {Promise<Record<string, string>>} Um objeto contendo as configurações de privacidade.
 */
export async function fetchPrivacySettings(force = false) {
  return runControllerSocketMethod('fetchPrivacySettings', force);
}

/**
 * Atualiza a configuração de privacidade para mensagens.
 * @async
 * @param {import('@whiskeysockets/baileys').WAPrivacyMessagesValue} value - O novo valor da configuração de privacidade de mensagens.
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateMessagesPrivacy(value) {
  return runControllerSocketMethod('updateMessagesPrivacy', value);
}

/**
 * Atualiza a configuração de privacidade para chamadas.
 * @async
 * @param {import('@whiskeysockets/baileys').WAPrivacyCallValue} value - O novo valor da configuração de privacidade de chamadas.
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateCallPrivacy(value) {
  return runControllerSocketMethod('updateCallPrivacy', value);
}

/**
 * Atualiza a configuração de privacidade para "visto por último".
 * @async
 * @param {import('@whiskeysockets/baileys').WAPrivacyValue} value - O novo valor da configuração de privacidade de "visto por último".
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateLastSeenPrivacy(value) {
  return runControllerSocketMethod('updateLastSeenPrivacy', value);
}

/**
 * Atualiza a configuração de privacidade para status "online".
 * @async
 * @param {import('@whiskeysockets/baileys').WAPrivacyOnlineValue} value - O novo valor da configuração de privacidade de status "online".
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateOnlinePrivacy(value) {
  return runControllerSocketMethod('updateOnlinePrivacy', value);
}

/**
 * Atualiza a configuração de privacidade da foto de perfil.
 * @async
 * @param {import('@whiskeysockets/baileys').WAPrivacyValue} value - O novo valor da configuração de privacidade da foto de perfil.
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateProfilePicturePrivacy(value) {
  return runControllerSocketMethod('updateProfilePicturePrivacy', value);
}

/**
 * Atualiza a configuração de privacidade para status.
 * @async
 * @param {import('@whiskeysockets/baileys').WAPrivacyValue} value - O novo valor da configuração de privacidade de status.
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateStatusPrivacy(value) {
  return runControllerSocketMethod('updateStatusPrivacy', value);
}

/**
 * Atualiza a configuração de privacidade para confirmações de leitura.
 * @async
 * @param {import('@whiskeysockets/baileys').WAReadReceiptsValue} value - O novo valor da configuração de privacidade de confirmações de leitura.
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateReadReceiptsPrivacy(value) {
  return runControllerSocketMethod('updateReadReceiptsPrivacy', value);
}

/**
 * Atualiza a configuração de privacidade para adição em grupos.
 * @async
 * @param {import('@whiskeysockets/baileys').WAPrivacyGroupAddValue} value - O novo valor da configuração de privacidade de adição em grupos.
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateGroupsAddPrivacy(value) {
  return runControllerSocketMethod('updateGroupsAddPrivacy', value);
}

/**
 * Atualiza a configuração de privacidade para pré-visualização de links.
 * @async
 * @param {boolean} isPreviewsDisabled - Se `true`, desabilita a pré-visualização de links.
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateDisableLinkPreviewsPrivacy(isPreviewsDisabled) {
  return runControllerSocketMethod('updateDisableLinkPreviewsPrivacy', isPreviewsDisabled);
}

/**
 * Atualiza o modo padrão de mensagens temporárias para novos chats.
 * @async
 * @param {number} duration - A duração em segundos para as mensagens temporárias (ex: 0 para desativar, 7 * 24 * 60 * 60 para 7 dias).
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização é concluída.
 */
export async function updateDefaultDisappearingMode(duration) {
  return runControllerSocketMethod('updateDefaultDisappearingMode', duration);
}

/**
 * Envia uma atualização de presença para um chat ou para o status geral.
 * @async
 * @param {import('@whiskeysockets/baileys').WAPresence} type - O tipo de presença a ser enviado (e.g., 'available', 'composing', 'paused').
 * @param {string} [toJid] - O JID do destinatário para quem a presença será enviada (opcional).
 * @returns {Promise<void>} Uma promessa que resolve quando a atualização de presença é enviada.
 */
export async function sendPresenceUpdate(type, toJid) {
  const normalizedType = normalizeWAPresence(type, 'available');
  return runControllerSocketMethod('sendPresenceUpdate', normalizedType, toJid);
}

/**
 * Inscreve-se na presença de um JID específico para receber atualizações de status.
 * @async
 * @param {string} toJid - O JID do contato ou grupo cuja presença será observada.
 * @returns {Promise<void>} Uma promessa que resolve quando a inscrição é concluída.
 */
export async function presenceSubscribe(toJid) {
  return runControllerSocketMethod('presenceSubscribe', toJid);
}

/**
 * Executa uma modificação em um chat (e.g., arquivar, marcar como lido, mutar).
 * @async
 * @param {import('@whiskeysockets/baileys').ChatModification} mod - O objeto de modificação do chat.
 * @param {string} jid - O JID do chat a ser modificado.
 * @returns {Promise<void>} Uma promessa que resolve quando a modificação é aplicada.
 */
export async function chatModify(mod, jid) {
  return runControllerSocketMethod('chatModify', mod, jid);
}

/**
 * Atalho para arquivar ou desarquivar um chat.
 * @async
 * @param {string} jid - O JID do chat.
 * @param {Array<import('@whiskeysockets/baileys').proto.IWebMessageInfo>} [lastMessages=[]] - Últimas mensagens do chat (opcional, para contexto).
 * @param {boolean} [archive=true] - Se `true`, arquiva o chat; se `false`, desarquiva.
 * @returns {Promise<void>} Uma promessa que resolve quando o chat é arquivado/desarquivado.
 */
export async function setChatArchived(jid, lastMessages = [], archive = true) {
  return chatModify({ archive, lastMessages }, jid);
}

/**
 * Atalho para marcar um chat como lido ou não lido.
 * @async
 * @param {string} jid - O JID do chat.
 * @param {Array<import('@whiskeysockets/baileys').proto.IWebMessageInfo>} [lastMessages=[]] - Últimas mensagens do chat (opcional, para contexto).
 * @param {boolean} [markRead=true] - Se `true`, marca o chat como lido; se `false`, marca como não lido.
 * @returns {Promise<void>} Uma promessa que resolve quando o chat é marcado como lido/não lido.
 */
export async function setChatRead(jid, lastMessages = [], markRead = true) {
  return chatModify({ markRead, lastMessages }, jid);
}

/**
 * Atalho para mutar ou desmutar um chat.
 * @async
 * @param {string} jid - O JID do chat.
 * @param {number|null} muteMs - A duração do mute em milissegundos. Use `null` ou `0` para desmutar.
 * @returns {Promise<void>} Uma promessa que resolve quando o chat é mutado/desmutado.
 */
export async function setChatMute(jid, muteMs) {
  return chatModify({ mute: muteMs }, jid);
}

/**
 * Busca um histórico de mensagens sob demanda para um chat específico.
 * @async
 * @param {number} count - A quantidade de mensagens a serem solicitadas.
 * @param {import('@whiskeysockets/baileys').WAMessageKey} oldestMsgKey - A chave da mensagem mais antiga conhecida para iniciar a busca.
 * @param {number|import('long').default} oldestMsgTimestamp - O timestamp da mensagem mais antiga conhecida.
 * @returns {Promise<string>} Uma promessa que resolve com o ID da requisição da operação.
 */
export async function fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp) {
  return runControllerSocketMethod('fetchMessageHistory', count, oldestMsgKey, oldestMsgTimestamp);
}

/**
 * Solicita o reenvio de um placeholder para uma mensagem indisponível.
 * @async
 * @param {import('@whiskeysockets/baileys').WAMessageKey} messageKey - A chave da mensagem para a qual o placeholder deve ser reenviado.
 * @param {Partial<import('@whiskeysockets/baileys').WAMessage>} [msgData] - Dados auxiliares da mensagem (opcional).
 * @returns {Promise<string|undefined>} Uma promessa que resolve com um ID de string ou `undefined`.
 */
export async function requestPlaceholderResend(messageKey, msgData) {
  return runControllerSocketMethod('requestPlaceholderResend', messageKey, msgData);
}

/**
 * Rejeita uma chamada recebida no WhatsApp.
 * @async
 * @param {string} callId - O ID da chamada a ser rejeitada.
 * @param {string} callFrom - O JID do originador da chamada.
 * @returns {Promise<void>} Uma promessa que resolve quando a chamada é rejeitada.
 */
export async function rejectCall(callId, callFrom) {
  return runControllerSocketMethod('rejectCall', callId, callFrom);
}

/**
 * Força uma nova tentativa de conexão ao WhatsApp.
 * Encerra o socket ativo atual, se existir, para disparar a lógica de reconexão.
 * Se nenhum socket estiver ativo, inicia uma nova conexão.
 * @async
 * @param {string} [sessionId=BAILEYS_PRIMARY_SESSION_ID]
 * @returns {Promise<void>} Uma promessa que resolve quando o fluxo de reconexão é iniciado ou uma nova conexão é tentada.
 */
export async function reconnectToWhatsApp(sessionId = BAILEYS_PRIMARY_SESSION_ID) {
  const safeSessionId = normalizeSessionId(sessionId);
  const targetSocket = getSocketBySession(safeSessionId);
  if (targetSocket && isSocketOpen(targetSocket)) {
    logger.info('♻️ Forçando fechamento do socket para reconectar...', {
      action: 'force_reconnect',
      sessionId: safeSessionId,
      timestamp: __timeNowIso(),
    });
    targetSocket.ws?.close?.();
  } else {
    logger.warn('⚠️ Nenhum socket ativo detectado. Iniciando nova conexão manualmente.', {
      action: 'reconnect_no_active_socket',
      sessionId: safeSessionId,
      timestamp: __timeNowIso(),
    });
    await connectToWhatsApp(safeSessionId);
  }
}

/**
 * Encerra todas as sessões ativas no processo.
 * @param {{ releaseLocks?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function disconnectAllWhatsAppSessions(options = {}) {
  const { releaseLocks = true } = options;
  const targetSessionIds = Array.from(new Set([...BAILEYS_SESSION_IDS, ...sessionContexts.keys()]));

  await Promise.allSettled(
    targetSessionIds.map(async (sessionId) => {
      const safeSessionId = normalizeSessionId(sessionId);
      const context = getSessionContext(safeSessionId, { createIfMissing: false });
      if (!context) return;

      clearReconnectTimeout(safeSessionId);

      const socket = context.socket;
      context.socket = null;
      context.connectPromise = null;
      storeActiveSocket(null, safeSessionId);

      if (socket && typeof socket.end === 'function') {
        try {
          await socket.end();
        } catch (error) {
          logger.warn('Falha ao encerrar sessão do WhatsApp.', {
            action: 'disconnect_session_failed',
            sessionId: safeSessionId,
            errorMessage: error?.message,
          });
        }
      }
    }),
  );

  if (releaseLocks) {
    await releaseAllBaileysWriterLocks('disconnect_all_sessions');
  }
  syncLegacyActiveSocketReference();
}

if (process.argv[1] === __filename) {
  logger.info('🚀 Socket Controller iniciado diretamente via CLI.', {
    action: 'module_direct_execution',
    timestamp: __timeNowIso(),
  });

  connectToWhatsApp().catch((err) => {
    logger.error('❌ Falha crítica ao tentar iniciar conexão via execução direta.', {
      action: 'direct_connection_failure',
      errorMessage: err.message,
      stack: err.stack,
      timestamp: __timeNowIso(),
    });
    process.exit(1);
  });
}
