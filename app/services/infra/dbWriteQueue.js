import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { executeQuery, TABLES } from '../../../database/index.js';
import { queueLidUpdate, flushLidQueue, resolveUserIdCached } from '../../config/index.js';
import { buildPlaceholders, createFlushRunner } from './queueUtils.js';
import { recordError, setQueueDepth } from '../../observability/metrics.js';
import { sanitizeUnicodeString, toSafeJsonColumnValue } from '../../utils/json/jsonSanitizer.js';

/**
 * Converte um valor para número com fallback.
 *
 * @param {*} value - Valor de entrada (string, number, etc.).
 * @param {number} fallback - Valor padrão caso a conversão falhe.
 * @returns {number} Número finito convertido, ou o fallback.
 */
const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Intervalo (ms) do flush periódico das filas de escrita no banco.
 * É limitado entre 1000ms e 3000ms por segurança.
 *
 * @type {number}
 */
const FLUSH_INTERVAL_MS = Math.min(3000, Math.max(1000, parseNumber(process.env.DB_WRITE_FLUSH_MS, 1500)));

/**
 * Tamanho máximo do batch de mensagens por INSERT.
 *
 * @type {number}
 */
const MESSAGE_BATCH_SIZE = Math.max(1, Math.floor(parseNumber(process.env.DB_MESSAGE_BATCH_SIZE, 200)));

/**
 * Tamanho máximo do batch de chats por INSERT/UPSERT.
 *
 * @type {number}
 */
const CHAT_BATCH_SIZE = Math.max(1, Math.floor(parseNumber(process.env.DB_CHAT_BATCH_SIZE, 200)));

/**
 * Tempo de “cooldown” (ms) por chat antes de permitir novo write no banco.
 * Ajuda a reduzir writes repetidos do mesmo chat em curto período.
 *
 * @type {number}
 */
const CHAT_COOLDOWN_MS = Math.max(1000, Math.floor(parseNumber(process.env.DB_CHAT_COOLDOWN_MS, 45000)));

/**
 * Capacidade máxima da fila de mensagens.
 * Quando atinge esse limite, forçamos flush para tentar esvaziar.
 *
 * @type {number}
 */
const MESSAGE_QUEUE_MAX = Math.max(MESSAGE_BATCH_SIZE * 5, Math.floor(parseNumber(process.env.DB_MESSAGE_QUEUE_MAX, 5000)));

/**
 * Tamanho máximo do batch de eventos do Baileys por INSERT.
 * @type {number}
 */
const BAILEYS_EVENT_BATCH_SIZE = Math.max(1, Math.floor(parseNumber(process.env.BAILEYS_EVENT_BATCH_SIZE, 100)));

/**
 * Capacidade máxima da fila de eventos do Baileys.
 * @type {number}
 */
const BAILEYS_EVENT_QUEUE_MAX = Math.max(BAILEYS_EVENT_BATCH_SIZE * 5, Math.floor(parseNumber(process.env.BAILEYS_EVENT_QUEUE_MAX, 4000)));

/**
 * Retenção do journal de eventos em dias (0 desativa prune).
 * @type {number}
 */
const BAILEYS_EVENT_JOURNAL_RETENTION_DAYS = Math.max(0, Math.floor(parseNumber(process.env.BAILEYS_EVENT_JOURNAL_RETENTION_DAYS, 14)));

/**
 * Intervalo entre execuções de prune do journal de eventos.
 * @type {number}
 */
const BAILEYS_EVENT_JOURNAL_PRUNE_INTERVAL_MS = Math.max(60_000, Math.floor(parseNumber(process.env.BAILEYS_EVENT_JOURNAL_PRUNE_INTERVAL_MS, 6 * 60 * 60 * 1000)));

/**
 * Limite de deleções por rodada de prune (protege lock longo).
 * @type {number}
 */
const BAILEYS_EVENT_JOURNAL_PRUNE_DELETE_LIMIT = Math.max(500, Math.floor(parseNumber(process.env.BAILEYS_EVENT_JOURNAL_PRUNE_DELETE_LIMIT, 10_000)));

/**
 * Regex de erro para payload JSON inválido no MySQL.
 * @type {RegExp}
 */
const INVALID_JSON_TEXT_REGEX = /Invalid JSON text/i;

/**
 * Regex específica para surrogate inválido.
 * @type {RegExp}
 */
const INVALID_SURROGATE_REGEX = /surrogate pair/i;

/**
 * Fila em memória com mensagens pendentes de persistência.
 * @type {Array<Object>}
 */
const messageQueue = [];

/**
 * Conjunto de IDs de mensagens que já estão enfileiradas, para evitar duplicação.
 * @type {Set<string>}
 */
const messagePendingIds = new Set();

/**
 * Fila (por chat.id) com atualizações pendentes de chats.
 * @type {Map<string, {id:string, name:(string|null), raw:(Object|null), rawHash:string, queuedAt:number, nextAllowedAt:number}>}
 */
const chatQueue = new Map();

/**
 * Cache por chat.id para comparar estado persistido vs pendente (hash/name/último write).
 * @type {Map<string, {
 *   storedRaw: (Object|null),
 *   storedHash: (string|null),
 *   storedName: (string|null),
 *   lastWriteAt: number,
 *   pendingRaw: (Object|null),
 *   pendingHash: (string|null),
 *   pendingName: (string|null)
 * }>}
 */
const chatCache = new Map();

/**
 * Fila em memória com eventos do Baileys pendentes de persistência.
 * @type {Array<{event_name:string, socket_generation:(number|null), chat_id:(string|null), message_id:(string|null), participant_id:(string|null), payload_summary:(string|null), event_timestamp:Date}>}
 */
const baileysEventQueue = [];

/**
 * Indica se já há um flush agendado via setImmediate.
 * @type {boolean}
 */
let flushScheduled = false;
let baileysEventTableMissingLogged = false;
let messageActivityDailyTableMissingLogged = false;
let nextBaileysEventPruneAt = 0;

/**
 * Atualiza as métricas de profundidade das filas (monitoramento).
 *
 * @returns {void}
 */
const updateQueueMetrics = () => {
  setQueueDepth('messages', messageQueue.length);
  setQueueDepth('chats', chatQueue.size);
  setQueueDepth('baileys_events', baileysEventQueue.length);
};

/**
 * Agenda a execução de flush das filas no próximo ciclo do event-loop.
 * Evita agendar múltiplas execuções repetidas em sequência.
 *
 * @returns {void}
 */
const scheduleFlush = () => {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    flushQueues().catch((error) => {
      logger.error('Falha ao executar flush das filas.', { error: error.message });
      recordError('db_write_queue');
    });
  });
};

/**
 * Calcula um hash FNV-1a (32-bit) de uma string.
 * Útil para detectar mudanças em objetos serializados.
 *
 * @param {string} input - Texto de entrada.
 * @returns {string} Hash em hexadecimal (8 chars).
 */
const fnv1aHash = (input) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * Serializa um valor para string de forma estável (ordena chaves),
 * com proteção contra referências circulares e profundidade máxima.
 *
 * @param {*} value - Valor a serializar.
 * @param {number} [depth=0] - Profundidade atual (uso interno).
 * @param {WeakSet<object>} [seen=new WeakSet()] - Rastreamento de objetos vistos (circular).
 * @returns {string} String estável do valor.
 */
const stableStringify = (value, depth = 0, seen = new WeakSet()) => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (value instanceof Date) return `"${value.toISOString()}"`;
  if (Buffer.isBuffer(value)) return `"Buffer:${value.length}"`;
  if (typeof value !== 'object') return `"${String(value)}"`;
  if (seen.has(value)) return '"[Circular]"';
  if (depth > 6) return '"[MaxDepth]"';

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => stableStringify(item, depth + 1, seen));
    return `[${items.join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const items = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1, seen)}`);
  return `{${items.join(',')}}`;
};

/**
 * Gera um hash estável de qualquer valor/objeto.
 * Caso a serialização falhe, usa fallback para String(value).
 *
 * @param {*} value - Valor a hashear.
 * @returns {string} Hash em hexadecimal (8 chars).
 */
const hashObject = (value) => {
  try {
    return fnv1aHash(stableStringify(value));
  } catch {
    return fnv1aHash(String(value));
  }
};

/**
 * Indica se o erro foi causado por texto JSON inválido (payload determinístico).
 *
 * @param {Error} error
 * @returns {boolean}
 */
const isInvalidJsonPayloadError = (error) => {
  const message = error?.message || '';
  return INVALID_JSON_TEXT_REGEX.test(message) || INVALID_SURROGATE_REGEX.test(message);
};

/**
 * Normaliza payload de mensagem antes de persistir.
 * - content: remove surrogate inválido
 * - raw_message: serializa JSON seguro para coluna JSON
 *
 * @param {{message_id:string, chat_id:string, sender_id:string, canonical_sender_id?:(string|null), content:(string|null), raw_message:(Object|string|null), timestamp:(number|string|Date)}} messageData
 * @returns {{message_id:string, chat_id:string, sender_id:(string|null), canonical_sender_id:(string|null), content:(string|null), raw_message:(string|null), timestamp:(number|string|Date)}}
 */
const normalizeUserIdForColumn = (value, maxLength = 255) => {
  if (value === null || value === undefined) return null;
  const normalized = sanitizeUnicodeString(String(value).trim()).slice(0, maxLength);
  return normalized || null;
};

const resolveCanonicalSenderIdForMessage = (messageData) => {
  const explicitCanonical = normalizeUserIdForColumn(messageData?.canonical_sender_id, 255);
  if (explicitCanonical) return explicitCanonical;

  const senderId = normalizeUserIdForColumn(messageData?.sender_id, 255);
  if (!senderId) return null;

  const cachedCanonical = resolveUserIdCached({
    lid: senderId,
    jid: senderId,
    participantAlt: null,
  });
  return normalizeUserIdForColumn(cachedCanonical || senderId, 255);
};

const normalizeMessageForQueue = (messageData) => {
  const senderId = normalizeUserIdForColumn(messageData?.sender_id, 255);
  return {
    ...messageData,
    sender_id: senderId,
    canonical_sender_id: resolveCanonicalSenderIdForMessage({
      ...messageData,
      sender_id: senderId,
    }),
    content: typeof messageData?.content === 'string' ? sanitizeUnicodeString(messageData.content) : messageData?.content,
    raw_message: toSafeJsonColumnValue(messageData?.raw_message),
  };
};

const normalizeTextForColumn = (value, maxLength = 255) => {
  if (value === null || value === undefined) return null;
  const normalized = sanitizeUnicodeString(String(value).trim()).slice(0, maxLength);
  return normalized || null;
};

const normalizeTimestampForColumn = (value) => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) return parsed;
  return __timeNow();
};

const normalizeBaileysEventForQueue = (eventData) => ({
  event_name: normalizeTextForColumn(eventData?.event_name, 64),
  socket_generation: Number.isFinite(Number(eventData?.socket_generation)) ? Math.max(0, Math.floor(Number(eventData.socket_generation))) : null,
  chat_id: normalizeTextForColumn(eventData?.chat_id, 255),
  message_id: normalizeTextForColumn(eventData?.message_id, 255),
  participant_id: normalizeTextForColumn(eventData?.participant_id, 255),
  payload_summary: toSafeJsonColumnValue(eventData?.payload_summary),
  event_timestamp: normalizeTimestampForColumn(eventData?.event_timestamp),
});

const insertBaileysEventBatch = async (batch) => {
  const placeholders = buildPlaceholders(batch.length, 7);
  const params = [];
  for (const entry of batch) {
    params.push(entry.event_name, entry.socket_generation, entry.chat_id, entry.message_id, entry.participant_id, entry.payload_summary, entry.event_timestamp);
  }

  const sql = `INSERT INTO ${TABLES.BAILEYS_EVENT_JOURNAL}
      (event_name, socket_generation, chat_id, message_id, participant_id, payload_summary, event_timestamp)
      VALUES ${placeholders}`;

  await executeQuery(sql, params);
};

/**
 * Executa INSERT IGNORE de um batch de mensagens.
 *
 * @param {Array<{message_id:string, chat_id:string, sender_id:(string|null), canonical_sender_id:(string|null), content:(string|null), raw_message:(string|null), timestamp:(number|string|Date)}>} batch
 * @returns {Promise<void>}
 */
const insertMessageBatch = async (batch) => {
  const placeholders = buildPlaceholders(batch.length, 7);
  const params = [];
  for (const message of batch) {
    params.push(message.message_id, message.chat_id, message.sender_id, message.canonical_sender_id, message.content, message.raw_message, message.timestamp);
  }

  const sql = `INSERT IGNORE INTO ${TABLES.MESSAGES}
      (message_id, chat_id, sender_id, canonical_sender_id, content, raw_message, timestamp)
      VALUES ${placeholders}`;

  await executeQuery(sql, params);
};

const toUtcDateKey = (value) => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const buildMessageActivityDailyKeys = (batch) => {
  const keyMap = new Map();
  for (const message of batch) {
    const dayRefDate = toUtcDateKey(message?.timestamp);
    const chatId = normalizeUserIdForColumn(message?.chat_id, 255);
    const canonicalSenderId = normalizeUserIdForColumn(message?.canonical_sender_id || message?.sender_id, 255);
    if (!dayRefDate || !chatId || !canonicalSenderId) continue;

    const key = `${dayRefDate}\u001f${chatId}\u001f${canonicalSenderId}`;
    if (!keyMap.has(key)) {
      keyMap.set(key, { dayRefDate, chatId, canonicalSenderId });
    }
  }
  return Array.from(keyMap.values());
};

const isMessageActivityDailyMissing = (error) => {
  const code = String(error?.code || '')
    .trim()
    .toUpperCase();
  if (code === 'ER_NO_SUCH_TABLE') return true;
  const errno = Number(error?.errno || 0);
  if (errno === 1146) return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('message_activity_daily') && message.includes("doesn't exist");
};

const refreshMessageActivityDailyForBatch = async (batch) => {
  const keys = buildMessageActivityDailyKeys(batch);
  if (!keys.length) return;

  const keyRowsSql = keys.map((_, index) => (index === 0 ? 'SELECT ? AS day_ref_date, ? AS chat_id, ? AS canonical_sender_id' : 'UNION ALL SELECT ?, ?, ?')).join('\n');
  const params = [];
  for (const keyRow of keys) {
    params.push(keyRow.dayRefDate, keyRow.chatId, keyRow.canonicalSenderId);
  }

  const sql = `INSERT INTO message_activity_daily (
      day_ref_date,
      chat_id,
      canonical_sender_id,
      total_messages,
      first_message_at,
      last_message_at
    )
    SELECT
      k.day_ref_date,
      k.chat_id,
      k.canonical_sender_id,
      COUNT(*) AS total_messages,
      MIN(m.timestamp) AS first_message_at,
      MAX(m.timestamp) AS last_message_at
    FROM (
      ${keyRowsSql}
    ) k
    JOIN ${TABLES.MESSAGES} m
      ON DATE(m.timestamp) = k.day_ref_date
     AND m.chat_id = k.chat_id
     AND COALESCE(m.canonical_sender_id, m.sender_id) = k.canonical_sender_id
    GROUP BY k.day_ref_date, k.chat_id, k.canonical_sender_id
    ON DUPLICATE KEY UPDATE
      total_messages = VALUES(total_messages),
      first_message_at = VALUES(first_message_at),
      last_message_at = VALUES(last_message_at),
      updated_at = CURRENT_TIMESTAMP`;

  await executeQuery(sql, params);
};

/**
 * Remove IDs de mensagens do set de pendentes.
 *
 * @param {Array<{message_id:string}>} batch
 * @returns {void}
 */
const clearPendingMessageIds = (batch) => {
  for (const message of batch) {
    messagePendingIds.delete(message.message_id);
  }
};

/**
 * Em caso de erro JSON no batch, tenta persistir item a item.
 * - Mensagem inválida é descartada para não travar a fila inteira.
 * - Em erro transitório, re-enfileira o restante e interrompe.
 *
 * @param {Array<{message_id:string, chat_id:string, sender_id:(string|null), canonical_sender_id:(string|null), content:(string|null), raw_message:(string|null), timestamp:(number|string|Date)}>} batch
 * @returns {Promise<void>}
 */
const salvageJsonErrorBatch = async (batch) => {
  for (let index = 0; index < batch.length; index += 1) {
    const message = batch[index];
    try {
      await insertMessageBatch([message]);
      clearPendingMessageIds([message]);
    } catch (error) {
      if (isInvalidJsonPayloadError(error)) {
        clearPendingMessageIds([message]);
        logger.warn('Mensagem descartada por payload JSON inválido.', {
          messageId: message?.message_id,
          chatId: message?.chat_id,
          error: error.message,
        });
        recordError('db_write_queue');
        continue;
      }

      messageQueue.unshift(...batch.slice(index));
      throw error;
    }
  }
};

const flushMessageQueueCore = async () => {
  while (messageQueue.length > 0) {
    const batch = messageQueue.splice(0, MESSAGE_BATCH_SIZE);
    try {
      await insertMessageBatch(batch);
      try {
        await refreshMessageActivityDailyForBatch(batch);
      } catch (error) {
        if (isMessageActivityDailyMissing(error)) {
          if (!messageActivityDailyTableMissingLogged) {
            messageActivityDailyTableMissingLogged = true;
            logger.warn('Tabela message_activity_daily ausente; rollup incremental desativado.', {
              action: 'message_activity_daily_missing',
            });
          }
        } else {
          logger.warn('Falha ao atualizar rollup message_activity_daily apos flush de mensagens.', {
            action: 'message_activity_daily_upsert_failed',
            error: error?.message,
          });
          recordError('db_write_queue');
        }
      }
      clearPendingMessageIds(batch);
    } catch (error) {
      logger.error('Falha ao inserir batch de mensagens.', { error: error.message });
      recordError('db_write_queue');

      if (isInvalidJsonPayloadError(error)) {
        try {
          await salvageJsonErrorBatch(batch);
          continue;
        } catch (salvageError) {
          logger.error('Falha ao recuperar batch de mensagens após erro de JSON inválido.', {
            error: salvageError.message,
          });
          recordError('db_write_queue');
          break;
        }
      } else {
        messageQueue.unshift(...batch);
        break;
      }
    }
  }
};

const flushChatQueueCore = async () => {
  while (chatQueue.size > 0) {
    const now = __timeNowMs();
    const ready = [];
    for (const entry of chatQueue.values()) {
      if (now < entry.nextAllowedAt) continue;
      ready.push(entry);
      if (ready.length >= CHAT_BATCH_SIZE) break;
    }
    if (!ready.length) break;

    const placeholders = buildPlaceholders(ready.length, 3);
    const params = [];
    for (const entry of ready) {
      if (typeof entry.name === 'string') {
        entry.name = sanitizeUnicodeString(entry.name);
      }
      params.push(entry.id, entry.name, toSafeJsonColumnValue(entry.raw));
    }

    const sql = `INSERT INTO ${TABLES.CHATS} (id, name, raw_chat)
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          name = COALESCE(VALUES(name), name),
          raw_chat = COALESCE(VALUES(raw_chat), raw_chat)`;

    try {
      await executeQuery(sql, params);
      const writeAt = __timeNowMs();
      for (const entry of ready) {
        const current = chatQueue.get(entry.id);
        const cache = chatCache.get(entry.id) || {};

        if (entry.raw) {
          cache.storedRaw = entry.raw;
          cache.storedHash = entry.rawHash;
        }
        if (entry.name !== null && entry.name !== undefined) {
          cache.storedName = entry.name;
        }
        cache.lastWriteAt = writeAt;

        if (!current || current.queuedAt === entry.queuedAt) {
          chatQueue.delete(entry.id);
          cache.pendingRaw = null;
          cache.pendingHash = null;
          cache.pendingName = null;
        } else {
          current.nextAllowedAt = writeAt + CHAT_COOLDOWN_MS;
          chatQueue.set(entry.id, current);
        }

        chatCache.set(entry.id, cache);
      }
    } catch (error) {
      logger.error('Falha ao inserir batch de chats.', { error: error.message });
      recordError('db_write_queue');
      break;
    }
  }
};

const pruneBaileysEventJournal = async () => {
  if (BAILEYS_EVENT_JOURNAL_RETENTION_DAYS <= 0) return;

  const now = __timeNowMs();
  if (now < nextBaileysEventPruneAt) return;
  nextBaileysEventPruneAt = now + BAILEYS_EVENT_JOURNAL_PRUNE_INTERVAL_MS;

  let totalDeleted = 0;
  const maxRounds = 5;
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await executeQuery(
      `DELETE FROM ${TABLES.BAILEYS_EVENT_JOURNAL}
        WHERE created_at < (UTC_TIMESTAMP() - INTERVAL ? DAY)
        LIMIT ?`,
      [BAILEYS_EVENT_JOURNAL_RETENTION_DAYS, BAILEYS_EVENT_JOURNAL_PRUNE_DELETE_LIMIT],
    );

    const affectedRows = Number(result?.affectedRows || 0);
    if (affectedRows <= 0) break;
    totalDeleted += affectedRows;

    if (affectedRows < BAILEYS_EVENT_JOURNAL_PRUNE_DELETE_LIMIT) {
      break;
    }
  }

  if (totalDeleted > 0) {
    logger.info('Prune do journal de eventos Baileys concluído.', {
      deletedRows: totalDeleted,
      retentionDays: BAILEYS_EVENT_JOURNAL_RETENTION_DAYS,
    });
  }
};

const flushBaileysEventQueueCore = async () => {
  while (baileysEventQueue.length > 0) {
    const batch = baileysEventQueue.splice(0, BAILEYS_EVENT_BATCH_SIZE);
    try {
      await insertBaileysEventBatch(batch);
    } catch (error) {
      if (error?.code === 'ER_NO_SUCH_TABLE') {
        if (!baileysEventTableMissingLogged) {
          baileysEventTableMissingLogged = true;
          logger.warn('Tabela baileys_event_journal não encontrada. Execute db:init para habilitar o journal.', {
            action: 'baileys_event_journal_table_missing',
          });
        }
        continue;
      }

      logger.error('Falha ao inserir batch de eventos do Baileys.', { error: error.message });
      recordError('db_write_queue');
      baileysEventQueue.unshift(...batch);
      break;
    }
  }

  try {
    await pruneBaileysEventJournal();
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') return;
    logger.error('Falha ao executar prune do journal de eventos Baileys.', {
      error: error.message,
    });
    recordError('db_write_queue');
  }
};

const messageFlushRunner = createFlushRunner({
  onFlush: flushMessageQueueCore,
  onError: (error) => {
    logger.error('Falha ao executar flush da fila de mensagens.', { error: error.message });
    recordError('db_write_queue');
  },
  onFinally: () => {
    updateQueueMetrics();
  },
});

const chatFlushRunner = createFlushRunner({
  onFlush: flushChatQueueCore,
  onError: (error) => {
    logger.error('Falha ao executar flush da fila de chats.', { error: error.message });
    recordError('db_write_queue');
  },
  onFinally: () => {
    updateQueueMetrics();
  },
});

const baileysEventFlushRunner = createFlushRunner({
  onFlush: flushBaileysEventQueueCore,
  onError: (error) => {
    logger.error('Falha ao executar flush da fila de eventos do Baileys.', {
      error: error.message,
    });
    recordError('db_write_queue');
  },
  onFinally: () => {
    updateQueueMetrics();
  },
});

/**
 * Enfileira uma mensagem para INSERT no banco (INSERT IGNORE).
 * - Evita duplicar message_id usando um Set.
 * - Força flush se a fila estiver muito grande.
 * - Agenda flush quando atinge o tamanho de batch.
 *
 * @param {{message_id:string, chat_id:string, sender_id:string, canonical_sender_id?:(string|null), content:(string|null), raw_message:(Object|string|null), timestamp:(number|string)}} messageData
 *   Objeto com os campos necessários para persistência.
 * @returns {boolean} true se foi enfileirada; false se inválida/duplicada.
 */
export function queueMessageInsert(messageData) {
  if (!messageData?.message_id) return false;
  if (messagePendingIds.has(messageData.message_id)) return false;

  const normalizedMessage = normalizeMessageForQueue(messageData);

  if (messageQueue.length >= MESSAGE_QUEUE_MAX) {
    logger.warn('Fila de mensagens cheia, forçando flush.', { size: messageQueue.length });
    scheduleFlush();
  }

  messagePendingIds.add(normalizedMessage.message_id);
  messageQueue.push(normalizedMessage);
  updateQueueMetrics();

  if (messageQueue.length >= MESSAGE_BATCH_SIZE) {
    scheduleFlush();
  }
  return true;
}

/**
 * Enfileira uma atualização de chat para UPSERT no banco.
 * Suporta atualização parcial (merge com cache) e opção de “forçar nome”.
 *
 * Regras:
 * - Detecta mudança de "raw_chat" via hash estável.
 * - Detecta mudança de "name" apenas quando fornecido.
 * - Aplica cooldown por chat para reduzir writes repetidos.
 *
 * @param {{id:string, name?:string, [key:string]:any}} chat - Objeto do chat (mínimo: {id}).
 * @param {{partial?:boolean, forceName?:boolean}} [options={}]
 *   partial: se true, faz merge do chat com o estado base do cache.
 *   forceName: se true, sempre tenta gravar name (fallback para id).
 * @returns {boolean} true se algo mudou e foi enfileirado; false se nada mudou ou inválido.
 */
export function queueChatUpdate(chat, options = {}) {
  if (!chat || !chat.id) return false;

  const now = __timeNowMs();
  const isPartial = Boolean(options.partial);
  const forceName = Boolean(options.forceName);
  const cache = chatCache.get(chat.id) || {
    storedRaw: null,
    storedHash: null,
    storedName: null,
    lastWriteAt: 0,
    pendingRaw: null,
    pendingHash: null,
    pendingName: null,
  };

  const baseRaw = cache.pendingRaw || cache.storedRaw;
  const rawChat = isPartial ? (baseRaw ? { ...baseRaw, ...chat } : null) : chat;
  const rawHash = rawChat ? hashObject(rawChat) : cache.pendingHash || cache.storedHash;

  const providedName = forceName ? chat.name || chat.id : chat.name;
  const nameProvided = providedName !== undefined && providedName !== null;
  const name = nameProvided ? providedName : cache.pendingName || cache.storedName || null;
  const compareHash = cache.pendingHash || cache.storedHash;
  const compareName = cache.pendingName || cache.storedName;

  const rawChanged = Boolean(rawChat && rawHash && rawHash !== compareHash);
  const nameChanged = nameProvided && name !== compareName;

  if (!rawChanged && !nameChanged) {
    return false;
  }

  const nextAllowedAt = cache.lastWriteAt ? cache.lastWriteAt + CHAT_COOLDOWN_MS : now;
  const entry = {
    id: chat.id,
    name: nameProvided ? name : null,
    raw: rawChanged ? rawChat : null,
    rawHash: rawHash || compareHash,
    queuedAt: now,
    nextAllowedAt,
  };

  chatQueue.set(chat.id, entry);
  chatCache.set(chat.id, {
    ...cache,
    pendingRaw: rawChat || cache.pendingRaw,
    pendingHash: rawHash || cache.pendingHash,
    pendingName: nameProvided ? name : cache.pendingName,
  });

  updateQueueMetrics();
  scheduleFlush();
  return true;
}

/**
 * Enfileira um evento resumido do Baileys para o journal de auditoria.
 *
 * @param {{event_name:string, socket_generation?:(number|null), chat_id?:(string|null), message_id?:(string|null), participant_id?:(string|null), payload_summary?:any, event_timestamp?:(string|number|Date)}} eventData
 * @returns {boolean}
 */
export function queueBaileysEventInsert(eventData) {
  const normalizedEvent = normalizeBaileysEventForQueue(eventData);
  if (!normalizedEvent.event_name) return false;

  if (baileysEventQueue.length >= BAILEYS_EVENT_QUEUE_MAX) {
    logger.warn('Fila de eventos Baileys cheia, descartando item mais antigo.', {
      size: baileysEventQueue.length,
      max: BAILEYS_EVENT_QUEUE_MAX,
    });
    baileysEventQueue.shift();
  }

  baileysEventQueue.push(normalizedEvent);
  updateQueueMetrics();

  if (baileysEventQueue.length >= BAILEYS_EVENT_BATCH_SIZE) {
    scheduleFlush();
  }

  return true;
}

/**
 * Faz flush da fila de mensagens:
 * - Processa em batches (MESSAGE_BATCH_SIZE).
 * - Usa INSERT IGNORE para evitar duplicidade.
 * - Em erro, re-enfileira o batch no início e interrompe para tentar depois.
 *
 * @returns {Promise<void>}
 */
async function flushMessageQueue() {
  await messageFlushRunner.run();
}

/**
 * Faz flush da fila de chats:
 * - Respeita cooldown (nextAllowedAt) por chat.
 * - Processa em batches (CHAT_BATCH_SIZE).
 * - Usa UPSERT para atualizar name/raw_chat quando fornecidos.
 *
 * @returns {Promise<void>}
 */
async function flushChatQueue() {
  await chatFlushRunner.run();
}

/**
 * Faz flush da fila de eventos do Baileys.
 *
 * @returns {Promise<void>}
 */
async function flushBaileysEventQueue() {
  await baileysEventFlushRunner.run();
}

/**
 * Executa flush de todas as filas (mensagens, chats, eventos do Baileys e LID).
 * Usa Promise.allSettled para não “matar” as outras filas caso uma falhe.
 *
 * @returns {Promise<void>}
 */
export async function flushQueues() {
  await Promise.allSettled([flushMessageQueue(), flushChatQueue(), flushBaileysEventQueue(), flushLidQueue()]);
}

updateQueueMetrics();

/**
 * Timer periódico para garantir flush mesmo sem eventos/tráfego.
 * O timer é "unref" quando disponível, para não segurar o processo aberto.
 */
if (FLUSH_INTERVAL_MS > 0) {
  const timer = setInterval(() => {
    flushQueues().catch((error) => {
      logger.error('Erro ao executar flush periódico das filas.', { error: error.message });
      recordError('db_write_queue');
    });
  }, FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

/**
 * Re-export do enfileiramento de update de LID.
 * @type {(update:any)=>any}
 */
export { queueLidUpdate };
