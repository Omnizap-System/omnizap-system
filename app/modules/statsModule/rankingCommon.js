import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { createCanvas, loadImage } from 'canvas';
import { executeQuery } from '../../../database/index.js';
import { getJidUser, getProfilePicBuffer, normalizeJid } from '../../config/index.js';
import { primeLidCache, resolveUserIdCached, isLidUserId, isWhatsAppUserId } from '../../config/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_CACHE_LIMIT = 2000;
const PROFILE_PIC_CACHE = globalThis.__omnizapProfilePicCache || new Map();
globalThis.__omnizapProfilePicCache = PROFILE_PIC_CACHE;
const RANKING_IMAGE_WIDTH = 1600;
const RANKING_IMAGE_HEIGHT = 900;
const RANKING_IMAGE_SCALE = 2;
const PROFILE_FETCH_TIMEOUT_MS = 4000;
const ELLIPSIS = '…';
const CANVAS_FONT_STACK = "'Noto Color Emoji', 'Segoe UI Emoji', 'Apple Color Emoji', 'Segoe UI Symbol', 'Noto Sans', 'DejaVu Sans', 'Arial Unicode MS', Arial, sans-serif";
const GRAPHEME_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }) : null;
const ZERO_WIDTH_UNICODE_REGEX = /(?:\u200B|\u200C|\u200D|\u2060|\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F)/gu;
const PRIVATE_USE_UNICODE_REGEX = /[\uE000-\uF8FF]/gu;
const EMOJI_AND_PICTO_REGEX = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/gu;
const ASCII_PRINTABLE_REGEX = /^[\x20-\x7E]$/u;
const LATIN_CHAR_REGEX = /^\p{Script=Latin}$/u;
const NUMBER_CHAR_REGEX = /^\p{Number}$/u;
const MARK_CHAR_REGEX = /^\p{Mark}$/u;
let messageActivityDailyAvailable = null;

export const MESSAGE_TYPE_SQL = `
  CASE
    WHEN JSON_EXTRACT(m.raw_message, '$.message.conversation') IS NOT NULL THEN 'texto'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.extendedTextMessage') IS NOT NULL THEN 'texto'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.imageMessage') IS NOT NULL THEN 'imagem'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.videoMessage') IS NOT NULL THEN 'video'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.audioMessage') IS NOT NULL THEN 'audio'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.stickerMessage') IS NOT NULL THEN 'figurinha'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.documentMessage') IS NOT NULL THEN 'documento'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.locationMessage') IS NOT NULL THEN 'localizacao'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.reactionMessage') IS NOT NULL THEN 'reacao'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.pollCreationMessage') IS NOT NULL THEN 'enquete'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.listMessage') IS NOT NULL THEN 'lista'
    WHEN JSON_EXTRACT(m.raw_message, '$.message.buttonsMessage') IS NOT NULL THEN 'botoes'
    ELSE 'outros'
  END
`;

export const TIMESTAMP_TO_DATETIME_SQL = `
  CASE
    WHEN m.timestamp IS NULL THEN NULL
    WHEN CAST(m.timestamp AS CHAR) REGEXP '^[0-9]{13,}$' THEN FROM_UNIXTIME(CAST(m.timestamp AS DECIMAL(20,0)) / 1000)
    WHEN CAST(m.timestamp AS CHAR) REGEXP '^[0-9]{10}$' THEN FROM_UNIXTIME(CAST(m.timestamp AS DECIMAL(20,0)))
    ELSE CAST(m.timestamp AS DATETIME)
  END
`;

/**
 * Formata data para pt-BR (America/Sao_Paulo).
 * @param {Date|string|number|null|undefined} value
 * @returns {string}
 */
export const formatDate = (value) => {
  if (!value) return 'N/D';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/D';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
};

/**
 * Converte timestamp em ms (aceita segundos/ms/string).
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
export const toMillis = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Retorna o nome exibido (pushName) ou fallback.
 * @param {string|null|undefined} pushName
 * @param {string|null|undefined} mentionId
 * @returns {string}
 */
export const getDisplayName = (pushName, mentionId) => {
  const mentionUser = getJidUser(mentionId);
  const base = mentionUser ? `@${mentionUser}` : null;
  if (pushName && typeof pushName === 'string' && pushName.trim() !== '') {
    const clean = pushName.trim();
    return base ? `${base} (${clean})` : clean;
  }
  return base || 'Desconhecido';
};

const getShortName = (row) => {
  const displayName = toSafeCanvasDisplayName(row?.display_name);
  if (displayName) return displayName;
  const mentionUser = getJidUser(row?.mention_id || row?.sender_id);
  return mentionUser ? toSafeCanvasText(`@${mentionUser}`) : 'Desconhecido';
};

const CANONICAL_SENDER_SQL = 'COALESCE(m.canonical_sender_id, m.sender_id)';
const LID_MAP_JOIN_SQL = '';

const resolveSenderIdsCanonical = (rawJid) => {
  if (!rawJid) return { displayId: null, mentionId: null, key: null };
  const canonical = resolveUserIdCached({ lid: rawJid, jid: rawJid, participantAlt: null });
  const displayId = canonical || rawJid;
  const mentionId = isWhatsAppUserId(canonical) ? canonical : null;
  const key = canonical || rawJid;
  return { displayId, mentionId, key };
};

const buildWhere = ({ scope, remoteJid, botJid, useCanonicalSender = false }) => {
  const senderExpr = useCanonicalSender ? CANONICAL_SENDER_SQL : 'm.sender_id';
  const joinSql = useCanonicalSender ? LID_MAP_JOIN_SQL : '';
  const where = [`${senderExpr} IS NOT NULL`];
  const params = [];
  if (scope === 'group') {
    where.push('m.chat_id = ?');
    params.push(remoteJid);
  }
  if (botJid) {
    const normalizedBotJid = normalizeJid(botJid) || botJid;
    const botUser = getJidUser(normalizedBotJid);

    // Exclui por JID exato (normalizado e bruto) e pelo usuário base
    // para cobrir formatos como numero:dispositivo@s.whatsapp.net.
    where.push(`${senderExpr} <> ?`);
    params.push(normalizedBotJid);
    if (botJid !== normalizedBotJid) {
      where.push(`${senderExpr} <> ?`);
      params.push(botJid);
    }
    if (botUser) {
      where.push(`${senderExpr} NOT LIKE ?`);
      params.push(`${botUser}@%`);
      where.push(`${senderExpr} NOT LIKE ?`);
      params.push(`${botUser}:%`);
    }
  }
  return { where, params, senderExpr, joinSql };
};

const isMissingMessageActivityDailyError = (error) => {
  const code = String(error?.code || '')
    .trim()
    .toUpperCase();
  if (code === 'ER_NO_SUCH_TABLE') return true;
  const errno = Number(error?.errno || 0);
  if (errno === 1146) return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('message_activity_daily') && message.includes("doesn't exist");
};

const canUseMessageActivityDaily = async () => {
  if (messageActivityDailyAvailable !== null) return messageActivityDailyAvailable;
  try {
    await executeQuery('SELECT 1 FROM message_activity_daily LIMIT 1');
    messageActivityDailyAvailable = true;
  } catch (error) {
    if (isMissingMessageActivityDailyError(error)) {
      messageActivityDailyAvailable = false;
    } else {
      throw error;
    }
  }
  return messageActivityDailyAvailable;
};

const getCachedProfilePic = (jid) => {
  const entry = PROFILE_PIC_CACHE.get(jid);
  if (!entry) return null;
  const lastAccess = entry.lastAccess || entry.createdAt || 0;
  if (__timeNowMs() - lastAccess > PROFILE_CACHE_TTL_MS) {
    PROFILE_PIC_CACHE.delete(jid);
    return null;
  }
  entry.lastAccess = __timeNowMs();
  return entry.buffer || null;
};

const setCachedProfilePic = (jid, buffer) => {
  if (!jid || !buffer) return;
  PROFILE_PIC_CACHE.set(jid, { buffer, createdAt: __timeNowMs(), lastAccess: __timeNowMs() });
  if (PROFILE_PIC_CACHE.size > PROFILE_CACHE_LIMIT) {
    const oldestKey = Array.from(PROFILE_PIC_CACHE.entries()).sort((a, b) => (a[1].lastAccess || a[1].createdAt || 0) - (b[1].lastAccess || b[1].createdAt || 0))[0]?.[0];
    if (oldestKey) PROFILE_PIC_CACHE.delete(oldestKey);
  }
};

const fetchProfileBuffer = async (sock, jid, remoteJid) => {
  const cached = getCachedProfilePic(jid);
  if (cached) return cached;
  const buffer = await Promise.race([
    getProfilePicBuffer(sock, { key: { participant: jid, remoteJid } }),
    new Promise((resolve) => {
      setTimeout(() => resolve(null), PROFILE_FETCH_TIMEOUT_MS);
    }),
  ]);
  if (buffer) setCachedProfilePic(jid, buffer);
  return buffer;
};

const loadProfileImages = async ({ sock, jids, remoteJid, concurrency = 6 }) => {
  const results = new Map();
  if (!sock) return results;
  const queue = Array.from(new Set((jids || []).filter(Boolean)));
  let index = 0;

  const worker = async () => {
    while (index < queue.length) {
      const jid = queue[index];
      index += 1;
      if (results.has(jid)) continue;
      try {
        const buffer = await fetchProfileBuffer(sock, jid, remoteJid);
        if (!buffer) continue;
        const image = await loadImage(buffer);
        results.set(jid, image);
      } catch {
        // Ignora falhas de imagem
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
};

const drawRoundedRect = (ctx, x, y, w, h, r) => {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
};

const drawTrackedText = (ctx, text, x, y, tracking = 0) => {
  const chars = splitGraphemes(text);
  if (!chars.length) return 0;
  let cursor = x;
  chars.forEach((char) => {
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + tracking;
  });
  return cursor - x;
};

const replaceControlCharsBySpace = (text) => {
  let normalized = '';
  for (const char of String(text || '')) {
    const code = char.codePointAt(0) || 0;
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      normalized += ' ';
      continue;
    }
    normalized += char;
  }
  return normalized;
};

const toSafeCanvasText = (value) => {
  if (value === null || value === undefined) return '';
  const normalized = String(value).normalize('NFKC').replace(/\r?\n/g, ' ');
  return replaceControlCharsBySpace(normalized).replace(ZERO_WIDTH_UNICODE_REGEX, '').replace(PRIVATE_USE_UNICODE_REGEX, '').replace(EMOJI_AND_PICTO_REGEX, '').replace(/\s+/g, ' ').trim();
};

const toSafeCanvasDisplayName = (value) => {
  const base = toSafeCanvasText(value);
  if (!base) return '';
  let safe = '';
  for (const char of base) {
    if (ASCII_PRINTABLE_REGEX.test(char) || LATIN_CHAR_REGEX.test(char) || NUMBER_CHAR_REGEX.test(char)) {
      safe += char;
      continue;
    }
    if (MARK_CHAR_REGEX.test(char) && safe) {
      safe += char;
    }
  }
  return safe.replace(/\s+/g, ' ').trim();
};

const splitGraphemes = (value) => {
  const text = toSafeCanvasText(value);
  if (!text) return [];
  if (GRAPHEME_SEGMENTER) {
    return Array.from(GRAPHEME_SEGMENTER.segment(text), (entry) => entry.segment);
  }
  return Array.from(text);
};

const getCanvasFont = (size, weight = 'normal') => `${weight} ${Math.max(10, Number(size) || 10)}px ${CANVAS_FONT_STACK}`;

const fitText = (ctx, text, maxWidth) => {
  const base = toSafeCanvasText(text);
  if (!base) return '';
  if (ctx.measureText(base).width <= maxWidth) return base;
  const graphemes = splitGraphemes(base);
  while (graphemes.length > 0 && ctx.measureText(`${graphemes.join('')}${ELLIPSIS}`).width > maxWidth) {
    graphemes.pop();
  }
  return graphemes.length ? `${graphemes.join('')}${ELLIPSIS}` : '';
};

const getInitials = (label) => {
  if (!label) return '?';
  const clean = toSafeCanvasDisplayName(label).replace(/^@/, '');
  if (!clean) return '?';
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return splitGraphemes(parts[0]).slice(0, 2).join('').toUpperCase();
  const first = splitGraphemes(parts[0])[0] || '';
  const second = splitGraphemes(parts[1])[0] || '';
  const value = `${first}${second}`.toUpperCase();
  return value || '?';
};

const formatCompactNumber = (value) => {
  const num = Number(value || 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return `${num}`;
};

const pickAvatarJid = (row) => {
  if (!row) return null;
  if (isWhatsAppUserId(row.mention_id)) return row.mention_id;
  if (isWhatsAppUserId(row.sender_id)) return row.sender_id;
  return null;
};

const drawAvatar = (ctx, { x, y, radius, image, fallbackLabel, borderColor = '#38bdf8', glowColor = null, glowBlur = 14 }) => {
  ctx.save();
  ctx.shadowColor = glowColor || borderColor;
  ctx.shadowBlur = Math.max(0, Number(glowBlur) || 0);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.32)';
  ctx.beginPath();
  ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const glow = ctx.createRadialGradient(x - radius * 0.2, y - radius * 0.2, radius * 0.4, x, y, radius * 1.2);
  glow.addColorStop(0, 'rgba(226, 232, 240, 0.25)');
  glow.addColorStop(1, 'rgba(15, 23, 42, 0)');
  ctx.save();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (image) {
    ctx.drawImage(image, x - radius, y - radius, radius * 2, radius * 2);
  } else {
    const gradient = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
    gradient.addColorStop(0, '#1f2937');
    gradient.addColorStop(1, '#0f172a');
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.font = getCanvasFont(Math.max(16, radius * 0.7), 'bold');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(getInitials(fallbackLabel), x, y);
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
};

const buildCanonicalWhere = ({ scope, remoteJid, botJid, canonicalId }) => {
  const canonical = normalizeJid(canonicalId) || canonicalId;
  const senderExpr = CANONICAL_SENDER_SQL;
  const where = [];
  const params = [];

  if (isWhatsAppUserId(canonical)) {
    const user = getJidUser(canonical);
    if (user) {
      // Inclui variações com dispositivo: user:device@server.
      where.push(`(${senderExpr} = ? OR ${senderExpr} LIKE ? OR ${senderExpr} LIKE ?)`);
      params.push(canonical, `${user}@%`, `${user}:%`);
    } else {
      where.push(`${senderExpr} = ?`);
      params.push(canonical);
    }
  } else {
    where.push(`${senderExpr} = ?`);
    params.push(canonical);
  }

  if (scope === 'group') {
    where.push('m.chat_id = ?');
    params.push(remoteJid);
  }
  if (botJid) {
    const normalizedBotJid = normalizeJid(botJid) || botJid;
    where.push(`${senderExpr} <> ?`);
    params.push(normalizedBotJid);
    if (botJid !== normalizedBotJid) {
      where.push(`${senderExpr} <> ?`);
      params.push(botJid);
    }
    const botUser = getJidUser(normalizedBotJid);
    if (botUser) {
      where.push(`${senderExpr} NOT LIKE ?`);
      params.push(`${botUser}@%`);
      where.push(`${senderExpr} NOT LIKE ?`);
      params.push(`${botUser}:%`);
    }
  }

  return { where, params };
};

const buildDailyWhere = ({ scope, remoteJid, botJid, canonicalId = null }) => {
  const senderExpr = 'd.canonical_sender_id';
  const where = [`${senderExpr} IS NOT NULL`];
  const params = [];

  if (canonicalId) {
    const canonical = normalizeJid(canonicalId) || canonicalId;
    if (isWhatsAppUserId(canonical)) {
      const user = getJidUser(canonical);
      if (user) {
        where.push(`(${senderExpr} = ? OR ${senderExpr} LIKE ? OR ${senderExpr} LIKE ?)`);
        params.push(canonical, `${user}@%`, `${user}:%`);
      } else {
        where.push(`${senderExpr} = ?`);
        params.push(canonical);
      }
    } else {
      where.push(`${senderExpr} = ?`);
      params.push(canonical);
    }
  }

  if (scope === 'group') {
    where.push('d.chat_id = ?');
    params.push(remoteJid);
  }
  if (botJid) {
    const normalizedBotJid = normalizeJid(botJid) || botJid;
    where.push(`${senderExpr} <> ?`);
    params.push(normalizedBotJid);
    if (botJid !== normalizedBotJid) {
      where.push(`${senderExpr} <> ?`);
      params.push(botJid);
    }
    const botUser = getJidUser(normalizedBotJid);
    if (botUser) {
      where.push(`${senderExpr} NOT LIKE ?`);
      params.push(`${botUser}@%`);
      where.push(`${senderExpr} NOT LIKE ?`);
      params.push(`${botUser}:%`);
    }
  }

  return { where, params };
};

/**
 * Busca total de mensagens conforme escopo.
 * @param {{scope: 'group'|'global', remoteJid?: string|null, botJid?: string|null}} params
 * @returns {Promise<number>}
 */
export const getTotalMessages = async ({ scope, remoteJid, botJid }) => {
  if (await canUseMessageActivityDaily()) {
    try {
      const { where, params } = buildDailyWhere({ scope, remoteJid, botJid });
      const [row] = await executeQuery(
        `SELECT COALESCE(SUM(d.total_messages), 0) AS total
           FROM message_activity_daily d
          WHERE ${where.join(' AND ')}`,
        params,
      );
      return Number(row?.total || 0);
    } catch (error) {
      if (isMissingMessageActivityDailyError(error)) {
        messageActivityDailyAvailable = false;
      } else {
        throw error;
      }
    }
  }

  const { where, params, joinSql } = buildWhere({
    scope,
    remoteJid,
    botJid,
    useCanonicalSender: true,
  });
  const sql = `SELECT COUNT(*) AS total FROM messages m ${joinSql} WHERE ${where.join(' AND ')}`;
  const [row] = await executeQuery(sql, params);
  return Number(row?.total || 0);
};

/**
 * Busca o tipo de mensagem mais usado conforme escopo.
 * @param {{scope: 'group'|'global', remoteJid?: string|null, botJid?: string|null}} params
 * @returns {Promise<{label: string, count: number}|null>}
 */
export const getTopMessageType = async ({ scope, remoteJid, botJid }) => {
  const { where, params, joinSql } = buildWhere({
    scope,
    remoteJid,
    botJid,
    useCanonicalSender: true,
  });
  const [row] = await executeQuery(
    `SELECT
        ${MESSAGE_TYPE_SQL} AS message_type,
        COUNT(*) AS total
      FROM messages m
      ${joinSql}
      WHERE ${where.join(' AND ')}
        AND m.raw_message IS NOT NULL
      GROUP BY message_type
      ORDER BY total DESC
      LIMIT 1`,
    params,
  );
  if (!row?.message_type) return null;
  return { label: row.message_type, count: Number(row.total || 0) };
};

/**
 * Busca inicio do banco conforme escopo.
 * @param {{scope: 'group'|'global', remoteJid?: string|null, botJid?: string|null}} params
 * @returns {Promise<any>}
 */
export const getDbStart = async ({ scope, remoteJid, botJid }) => {
  const { where, params, joinSql } = buildWhere({
    scope,
    remoteJid,
    botJid,
    useCanonicalSender: true,
  });
  const sql = `SELECT MIN(m.timestamp) AS db_start FROM messages m ${joinSql} WHERE ${where.join(' AND ')}`;
  const rows = await executeQuery(sql, params);
  return rows?.[0]?.db_start || null;
};

/**
 * Busca os ultimos pushNames por sender_id.
 * @param {Array<string>} senderIds
 * @returns {Promise<Map<string, string>>}
 */
export const fetchLatestPushNames = async (senderIds) => {
  if (!senderIds || !senderIds.length) return new Map();
  const placeholders = senderIds.map(() => '?').join(',');
  const rows = await executeQuery(
    `SELECT t.sender_id,
            JSON_UNQUOTE(JSON_EXTRACT(m.raw_message, '$.pushName')) AS pushName
       FROM (
         SELECT ${CANONICAL_SENDER_SQL} AS sender_id, MAX(id) AS max_id
           FROM messages m
          WHERE ${CANONICAL_SENDER_SQL} IN (${placeholders})
            AND raw_message IS NOT NULL
            AND JSON_EXTRACT(raw_message, '$.pushName') IS NOT NULL
          GROUP BY ${CANONICAL_SENDER_SQL}
       ) t
       JOIN messages m ON m.id = t.max_id`,
    senderIds,
  );
  const map = new Map();
  (rows || []).forEach((row) => {
    if (row?.sender_id && row?.pushName) {
      map.set(row.sender_id, row.pushName);
    }
  });
  return map;
};

/**
 * Monta ranking base por remetente canônico.
 * @param {{scope: 'group'|'global', remoteJid?: string|null, botJid?: string|null, limit?: number|null}} params
 * @returns {Promise<{rows: Array<any>}>}
 */
export const getRankingBase = async ({ scope, remoteJid, botJid, limit = null }) => {
  const limitClause = limit ? `LIMIT ${Number(limit)}` : '';
  let rankingRows = [];

  if (await canUseMessageActivityDaily()) {
    try {
      const { where, params } = buildDailyWhere({ scope, remoteJid, botJid });
      rankingRows = await executeQuery(
        `SELECT
            d.canonical_sender_id AS sender_id,
            SUM(d.total_messages) AS total_messages,
            MIN(d.first_message_at) AS first_message,
            MAX(d.last_message_at) AS last_message
          FROM message_activity_daily d
          WHERE ${where.join(' AND ')}
          GROUP BY d.canonical_sender_id
          ORDER BY total_messages DESC
          ${limitClause}`,
        params,
      );
    } catch (error) {
      if (isMissingMessageActivityDailyError(error)) {
        messageActivityDailyAvailable = false;
      } else {
        throw error;
      }
    }
  }

  if (!rankingRows.length) {
    const { where, params, joinSql, senderExpr } = buildWhere({
      scope,
      remoteJid,
      botJid,
      useCanonicalSender: true,
    });
    rankingRows = await executeQuery(
      `SELECT
          ${senderExpr} AS sender_id,
          COUNT(*) AS total_messages,
          MIN(m.timestamp) AS first_message,
          MAX(m.timestamp) AS last_message
        FROM messages m
        ${joinSql}
        WHERE ${where.join(' AND ')}
        GROUP BY ${senderExpr}
        ORDER BY total_messages DESC
        ${limitClause}`,
      params,
    );
  }

  const senderIds = rankingRows.map((row) => row.sender_id).filter(Boolean);
  const lidsToPrime = senderIds.filter((id) => isLidUserId(id));
  if (lidsToPrime.length > 0) {
    await primeLidCache(lidsToPrime);
  }

  const pushNameBySender = await fetchLatestPushNames(senderIds);
  const normalizedTotals = new Map();

  rankingRows.forEach((row) => {
    const rawJid = row.sender_id || '';
    if (!rawJid) return;
    const { displayId, mentionId, key } = resolveSenderIdsCanonical(rawJid);
    if (!displayId || !key) return;
    const total = Number(row.total_messages || 0);
    const firstMs = toMillis(row.first_message);
    const lastMs = toMillis(row.last_message);
    const current = normalizedTotals.get(key) || {
      sender_id: displayId,
      mention_id: mentionId,
      display_name: null,
      total_messages: 0,
      first_message: null,
      last_message: null,
    };
    current.total_messages += total;
    if (firstMs !== null) {
      current.first_message = current.first_message === null ? firstMs : Math.min(current.first_message, firstMs);
    }
    if (lastMs !== null) {
      current.last_message = current.last_message === null ? lastMs : Math.max(current.last_message, lastMs);
    }
    if (!current.mention_id && mentionId) {
      current.mention_id = mentionId;
    }
    if (isWhatsAppUserId(rawJid)) {
      current.mention_id = rawJid;
    }
    if (!current.display_name) {
      const pushName = pushNameBySender.get(rawJid);
      if (pushName) current.display_name = pushName;
    }
    normalizedTotals.set(key, current);
  });

  const rows = Array.from(normalizedTotals.values()).sort((a, b) => b.total_messages - a.total_messages);
  return { rows: limit ? rows.slice(0, limit) : rows };
};

const normalizeDayKey = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const dateOnlyMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateOnlyMatch?.[1]) return dateOnlyMatch[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const dayKeyToUtcMs = (dayKey) => {
  const match = String(dayKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Date.UTC(year, month - 1, day);
};

const computeStreak = (days) => {
  if (!days.length) return 0;
  let best = 1;
  let current = 1;
  let prev = dayKeyToUtcMs(days[0]);
  if (prev === null) return days.length ? 1 : 0;
  for (let i = 1; i < days.length; i += 1) {
    const currentDay = dayKeyToUtcMs(days[i]);
    if (currentDay === null) continue;
    const diff = currentDay - prev;
    if (diff === DAY_MS) {
      current += 1;
    } else {
      current = 1;
    }
    if (current > best) best = current;
    prev = currentDay;
  }
  return best;
};

/**
 * Enriquecer ranking com dias ativos, streak, media/dia e favorito.
 * @param {{rows: Array<any>, scope: 'group'|'global', remoteJid?: string|null, botJid?: string|null}} params
 * @returns {Promise<void>}
 */
export const enrichRankingRows = async ({ rows, scope, remoteJid, botJid }) => {
  for (const row of rows) {
    const rawJid = row.sender_id;
    if (!rawJid) continue;

    const { where, params } = buildCanonicalWhere({
      scope,
      remoteJid,
      botJid,
      canonicalId: rawJid,
    });

    let daysRows = [];
    if (await canUseMessageActivityDaily()) {
      try {
        const { where: dailyWhere, params: dailyParams } = buildDailyWhere({
          scope,
          remoteJid,
          botJid,
          canonicalId: rawJid,
        });
        daysRows = await executeQuery(
          `SELECT d.day_ref_date AS day
             FROM message_activity_daily d
            WHERE ${dailyWhere.join(' AND ')}
            ORDER BY d.day_ref_date ASC`,
          dailyParams,
        );
      } catch (error) {
        if (isMissingMessageActivityDailyError(error)) {
          messageActivityDailyAvailable = false;
        } else {
          throw error;
        }
      }
    }

    if (!daysRows.length) {
      daysRows = await executeQuery(
        `SELECT DISTINCT DATE(ts) AS day
           FROM (
             SELECT ${TIMESTAMP_TO_DATETIME_SQL} AS ts
               FROM messages m
              WHERE ${where.join(' AND ')}
                AND m.timestamp IS NOT NULL
           ) d
          WHERE d.ts IS NOT NULL
          ORDER BY day ASC`,
        params,
      );
    }

    const days = Array.from(new Set((daysRows || []).map((item) => normalizeDayKey(item?.day)).filter(Boolean))).sort();
    row.active_days = days.length;
    row.streak = computeStreak(days);

    const total = Number(row.total_messages || 0);
    const firstMs = toMillis(row.first_message);
    const lastMs = toMillis(row.last_message);
    if (firstMs !== null && lastMs !== null && total > 0) {
      const rangeDays = Math.max(1, Math.ceil((lastMs - firstMs) / DAY_MS) + 1);
      row.avg_per_day = (total / rangeDays).toFixed(2);
    } else {
      row.avg_per_day = '0.00';
    }

    const [favRow] = await executeQuery(
      `SELECT
          ${MESSAGE_TYPE_SQL} AS message_type,
          COUNT(*) AS total
        FROM messages m
        WHERE ${where.join(' AND ')}
          AND m.raw_message IS NOT NULL
        GROUP BY message_type
        ORDER BY total DESC
        LIMIT 1`,
      params,
    );

    row.favorite_type = favRow?.message_type || null;
    row.favorite_count = Number(favRow?.total || 0);
  }
};

/**
 * Monta um relatorio completo do ranking conforme escopo.
 * @param {{scope: 'group'|'global', remoteJid?: string|null, botJid?: string|null, limit?: number|null, includeTopType?: boolean, includeDbStart?: boolean, enrichRows?: boolean}} params
 * @returns {Promise<{rows: Array<any>, totalMessages: number, topType: {label: string, count: number}|null, topTotal: number, dbStart: any}>}
 */
export const getRankingReport = async ({ scope, remoteJid, botJid, limit = null, includeTopType = true, includeDbStart = true, enrichRows = true }) => {
  const totalMessages = await getTotalMessages({ scope, remoteJid, botJid });
  const topType = includeTopType ? await getTopMessageType({ scope, remoteJid, botJid }) : null;
  const { rows } = await getRankingBase({ scope, remoteJid, botJid, limit });
  if (enrichRows) {
    await enrichRankingRows({ rows, scope, remoteJid, botJid });
  }
  const topTotal = rows.reduce((acc, row) => acc + Number(row.total_messages || 0), 0);
  const dbStart = includeDbStart ? await getDbStart({ scope, remoteJid, botJid }) : null;
  return { rows, totalMessages, topType, topTotal, dbStart };
};

/**
 * Monta mensagem detalhada do ranking.
 * @param {{scope: 'group'|'global', limit: number, rows: Array<any>, totalMessages: number, topTotal: number, topType: {label: string, count: number}|null, dbStart: any}} params
 * @returns {string}
 */
export const buildRankingMessage = ({ scope, limit, rows, totalMessages, topTotal, topType, dbStart }) => {
  const scopeTitle = scope === 'global' ? 'Global' : 'Grupo';
  const scopeLabel = scope === 'global' ? 'global' : 'grupo';

  if (!rows.length) {
    return `Nao ha mensagens suficientes para gerar o ranking ${scopeLabel}.\n\nInicio do banco (primeira mensagem): ${formatDate(dbStart)}`;
  }

  const totalLabel = Number(totalMessages || 0);
  const topShare = totalLabel > 0 ? ((Number(topTotal || 0) / totalLabel) * 100).toFixed(2) : '0.00';
  const topTypeLabel = topType?.label ? `${topType.label} (${topType.count})` : 'N/D';

  const lines = [`🏆 *Ranking ${scopeTitle} Top ${limit} (mensagens)*`, `📦 Total de mensagens (${scopeLabel}): ${totalLabel}`, `📊 Top ${limit} = ${topShare}% do total`, `🔥 Tipo mais usado: ${topTypeLabel}`, ''];

  rows.forEach((row, index) => {
    const handle = getDisplayName(row.display_name, row.mention_id || row.sender_id);
    const total = row.total_messages || 0;
    const percent = totalLabel > 0 ? ((Number(total || 0) / totalLabel) * 100).toFixed(2) : '0.00';
    const first = formatDate(row.first_message);
    const last = formatDate(row.last_message);
    const avgPerDay = row.avg_per_day || '0.00';
    const activeDays = row.active_days ?? 0;
    const streak = row.streak ?? 0;
    const favoriteType = row.favorite_type ? `${row.favorite_type} (${row.favorite_count || 0})` : 'N/D';
    const position = `${index + 1}`.padStart(2, '0');
    lines.push(`${position}. ${handle}`, `   💬 ${total} msg(s)`, `   📊 ${percent}% do total`, `   📆 dias ativos: ${activeDays}`, `   📈 media/dia: ${avgPerDay}`, `   🔥 favorito: ${favoriteType}`, `   🔗 streak: ${streak} dia(s)`, `   📅 primeira: ${first}`, `   🕘 ultima: ${last}`, '');
  });

  lines.push(`Inicio do banco (primeira mensagem): ${formatDate(dbStart)}`);
  return lines.join('\n');
};

/**
 * Renderiza uma imagem de ranking horizontal.
 * @param {object} params
 * @param {object} params.sock
 * @param {string} params.remoteJid
 * @param {Array<object>} params.rows
 * @param {number} params.totalMessages
 * @param {{label: string, count: number}|null} params.topType
 * @param {'group'|'global'} params.scope
 * @param {number} params.limit
 * @returns {Promise<Buffer>}
 */
export const renderRankingImage = async ({ sock, remoteJid, rows, totalMessages, topType, scope, limit }) => {
  const width = RANKING_IMAGE_WIDTH;
  const height = RANKING_IMAGE_HEIGHT;
  const scale = RANKING_IMAGE_SCALE;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const rankColors = {
    1: '#facc15',
    2: '#38bdf8',
    3: '#34d399',
    4: '#64748b',
    5: '#64748b',
  };
  const progressGradientByRank = {
    1: ['#facc15', '#eab308'],
    2: ['#38bdf8', '#0284c7'],
    3: ['#34d399', '#059669'],
    4: ['#64748b', '#475569'],
    5: ['#64748b', '#475569'],
  };
  const medalLabelByRank = {
    1: 'GOLD',
    2: 'SILVER',
    3: 'BRONZE',
  };

  const uiFontStack = "'Inter', 'Poppins', 'Segoe UI', 'Noto Sans', 'DejaVu Sans', Arial, sans-serif";
  const uiFont = (size, weight = 500) => `${weight} ${Math.max(10, Number(size) || 10)}px ${uiFontStack}`;
  const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
  const hexToRgba = (hex, alpha = 1) => {
    const clean = String(hex || '').replace('#', '');
    const normalized =
      clean.length === 3
        ? clean
            .split('')
            .map((value) => `${value}${value}`)
            .join('')
        : clean;
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return `rgba(148, 163, 184, ${alpha})`;
    const int = Number.parseInt(normalized, 16);
    const r = (int >> 16) & 255;
    const g = (int >> 8) & 255;
    const b = int & 255;
    return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
  };

  const baseGradient = ctx.createLinearGradient(0, 0, width, height);
  baseGradient.addColorStop(0, '#0f172a');
  baseGradient.addColorStop(1, '#020617');
  ctx.fillStyle = baseGradient;
  ctx.fillRect(0, 0, width, height);

  const drawRadialShape = (x, y, radius, color, alpha = 1) => {
    const radial = ctx.createRadialGradient(x, y, 0, x, y, radius);
    radial.addColorStop(0, hexToRgba(color, alpha));
    radial.addColorStop(1, hexToRgba(color, 0));
    ctx.save();
    ctx.fillStyle = radial;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  drawRadialShape(width * 0.84, height * 0.19, 230, '#38bdf8', 0.11);
  drawRadialShape(width * 0.2, height * 0.78, 270, '#34d399', 0.07);
  drawRadialShape(width * 0.56, height * 0.42, 300, '#1e293b', 0.2);

  ctx.save();
  ctx.strokeStyle = 'rgba(100, 116, 139, 0.08)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 96) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 96) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();

  const noiseSize = 140;
  const noiseCanvas = createCanvas(noiseSize, noiseSize);
  const noiseCtx = noiseCanvas.getContext('2d');
  const noiseData = noiseCtx.createImageData(noiseSize, noiseSize);
  for (let i = 0; i < noiseData.data.length; i += 4) {
    const value = 215 + Math.floor(Math.random() * 40);
    noiseData.data[i] = value;
    noiseData.data[i + 1] = value;
    noiseData.data[i + 2] = value;
    noiseData.data[i + 3] = 10;
  }
  noiseCtx.putImageData(noiseData, 0, 0);
  const noisePattern = ctx.createPattern(noiseCanvas, 'repeat');
  if (noisePattern) {
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = noisePattern;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  const margin = 42;
  const gap = 24;
  const headerTop = 44;
  const gridTop = 160;
  const title = scope === 'global' ? `Ranking Global - Top ${limit}` : `Ranking do Grupo - Top ${limit}`;
  const topTypeLabel = toSafeCanvasText(topType?.label || 'N/D').toLowerCase() || 'n/d';
  const subtitle = `${formatCompactNumber(totalMessages)} mensagens • tipo mais usado: ${topTypeLabel}`;

  ctx.fillStyle = '#e2e8f0';
  ctx.font = uiFont(48, 700);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  drawTrackedText(ctx, title, margin, headerTop + 10, 1.15);

  ctx.fillStyle = '#94a3b8';
  ctx.font = uiFont(22, 500);
  ctx.fillText(subtitle, margin, headerTop + 72);

  ctx.save();
  const accentBarY = headerTop + 62;
  drawRoundedRect(ctx, margin, accentBarY, 16, 4, 2);
  ctx.fillStyle = 'rgba(250, 204, 21, 0.9)';
  ctx.fill();
  drawRoundedRect(ctx, margin + 22, accentBarY, 32, 4, 2);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
  ctx.fill();
  drawRoundedRect(ctx, margin + 60, accentBarY, 22, 4, 2);
  ctx.fillStyle = 'rgba(52, 211, 153, 0.85)';
  ctx.fill();
  ctx.restore();

  const avatarJids = rows.map((row) => pickAvatarJid(row)).filter(Boolean);
  const avatars = await loadProfileImages({ sock, jids: avatarJids, remoteJid });

  const availableWidth = width - margin * 2;
  const rank1Scale = 1.21;
  const rank2Scale = 0.94;
  const topBaseWidth = (availableWidth - gap) / (rank1Scale + rank2Scale);
  const topBaseHeight = 280;
  const rank1Width = topBaseWidth * rank1Scale;
  const rank2Width = topBaseWidth * rank2Scale;
  const rank1Height = topBaseHeight * rank1Scale;
  const rank2Height = topBaseHeight * rank2Scale;
  const topCombinedWidth = rank1Width + rank2Width + gap;
  const topStartX = margin + Math.max(0, (availableWidth - topCombinedWidth) / 2);
  const topRowBottom = gridTop + rank1Height;

  const drawProgressBar = ({ x, y, w, h, ratio, accentColor, rank }) => {
    const safeRatio = clamp01(ratio);
    const [startColor, endColor] = progressGradientByRank[rank] || [accentColor, accentColor];
    ctx.save();
    drawRoundedRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(100, 116, 139, 0.23)';
    ctx.fill();

    const fillWidth = safeRatio > 0 ? Math.max(2, Math.min(w, w * safeRatio)) : 0;
    if (fillWidth > 0) {
      const fillGradient = ctx.createLinearGradient(x, y, x + fillWidth, y + h);
      fillGradient.addColorStop(0, hexToRgba(startColor, 0.98));
      fillGradient.addColorStop(1, hexToRgba(endColor, 0.84));
      drawRoundedRect(ctx, x, y, fillWidth, h, h / 2);
      ctx.fillStyle = fillGradient;
      ctx.fill();

      const gloss = ctx.createLinearGradient(x, y, x, y + h);
      gloss.addColorStop(0, 'rgba(255, 255, 255, 0.24)');
      gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
      drawRoundedRect(ctx, x, y, fillWidth, h / 2, h / 2);
      ctx.fillStyle = gloss;
      ctx.fill();
    }
    ctx.restore();
  };

  const drawCard = ({ row, x, y, w, h, rank }) => {
    if (!row) return;
    const accentColor = rankColors[rank] || rankColors[5];
    const isTop = rank === 1;
    const share = totalMessages > 0 ? Number(row.total_messages || 0) / totalMessages : 0;
    const percent = (clamp01(share) * 100).toFixed(1);
    const label = getShortName(row);

    ctx.save();
    ctx.shadowColor = hexToRgba(accentColor, isTop ? 0.58 : 0.34);
    ctx.shadowBlur = isTop ? 38 : 30;
    ctx.shadowOffsetY = 6;
    drawRoundedRect(ctx, x, y, w, h, 20);
    ctx.fillStyle = isTop ? 'rgba(15, 23, 42, 0.74)' : 'rgba(15, 23, 42, 0.68)';
    ctx.fill();
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, x, y, w, h, 20);
    const cardGradient = ctx.createLinearGradient(x, y, x + w, y + h);
    cardGradient.addColorStop(0, isTop ? 'rgba(30, 41, 59, 0.76)' : 'rgba(30, 41, 59, 0.64)');
    cardGradient.addColorStop(1, 'rgba(15, 23, 42, 0.62)');
    ctx.fillStyle = cardGradient;
    ctx.fill();
    ctx.lineWidth = isTop ? 2.2 : 1.7;
    ctx.strokeStyle = hexToRgba(accentColor, isTop ? 0.9 : 0.72);
    ctx.stroke();

    ctx.clip();
    const shine = ctx.createLinearGradient(x - 120, y - 80, x + w * 0.68, y + h * 0.42);
    shine.addColorStop(0, 'rgba(255, 255, 255, 0)');
    shine.addColorStop(0.45, isTop ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.06)');
    shine.addColorStop(0.9, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = shine;
    ctx.fillRect(x - 120, y - 120, w + 300, h + 200);
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, x + 1, y + 1, w - 2, h - 2, 18);
    ctx.clip();
    const insetShade = ctx.createLinearGradient(x, y, x, y + h);
    insetShade.addColorStop(0, 'rgba(255, 255, 255, 0.06)');
    insetShade.addColorStop(0.35, 'rgba(255, 255, 255, 0.01)');
    insetShade.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
    ctx.fillStyle = insetShade;
    ctx.fillRect(x, y, w, h);
    ctx.restore();

    if (isTop) {
      ctx.save();
      drawRoundedRect(ctx, x - 3, y - 3, w + 6, h + 6, 24);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.25)';
      ctx.stroke();
      ctx.restore();
    }

    const pad = Math.round(Math.max(20, Math.min(30, w * 0.035)));
    const avatarRadius = Math.min(isTop ? 76 : 64, h * 0.29);
    const avatarX = x + pad + avatarRadius;
    const avatarY = y + h * 0.5;
    const avatarImage = avatars.get(pickAvatarJid(row)) || null;
    drawAvatar(ctx, {
      x: avatarX,
      y: avatarY,
      radius: avatarRadius,
      image: avatarImage,
      fallbackLabel: label,
      borderColor: accentColor,
      glowColor: accentColor,
      glowBlur: isTop ? 18 : 14,
    });

    const rankBadgeSize = isTop ? 50 : 44;
    ctx.save();
    ctx.fillStyle = hexToRgba(accentColor, 0.96);
    ctx.beginPath();
    ctx.arc(x + pad + rankBadgeSize / 2, y + pad + rankBadgeSize / 2, rankBadgeSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#020617';
    ctx.font = uiFont(rankBadgeSize * 0.48, 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(rank), x + pad + rankBadgeSize / 2, y + pad + rankBadgeSize / 2 + 1);
    ctx.restore();

    if (isTop) {
      const badgeW = 90;
      const badgeH = 32;
      const badgeX = x + w - pad - badgeW;
      const badgeY = y + pad + 2;
      ctx.save();
      drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 14);
      const topBadgeGradient = ctx.createLinearGradient(badgeX, badgeY, badgeX + badgeW, badgeY + badgeH);
      topBadgeGradient.addColorStop(0, 'rgba(250, 204, 21, 0.24)');
      topBadgeGradient.addColorStop(1, 'rgba(234, 179, 8, 0.14)');
      ctx.fillStyle = topBadgeGradient;
      ctx.fill();
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.78)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#facc15';
      ctx.font = uiFont(14, 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TOP 1', badgeX + badgeW / 2, badgeY + badgeH / 2 + 1);
      ctx.restore();
    }

    const medalLabel = medalLabelByRank[rank];
    if (medalLabel) {
      const medalW = 86;
      const medalH = 24;
      const medalX = x + w - pad - medalW;
      const medalY = y + h - pad - 52;
      ctx.save();
      drawRoundedRect(ctx, medalX, medalY, medalW, medalH, 12);
      ctx.fillStyle = hexToRgba(accentColor, 0.17);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(accentColor, 0.65);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = hexToRgba(accentColor, 0.95);
      ctx.font = uiFont(12, 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(medalLabel, medalX + medalW / 2, medalY + medalH / 2 + 1);
      ctx.restore();
    }

    const textX = avatarX + avatarRadius + (isTop ? 24 : 20);
    const textWidth = x + w - pad - textX;
    const nameY = y + h * 0.24;
    const nameSize = Math.max(26, Math.min(40, h * 0.12));
    const messageSize = Math.max(20, Math.min(34, h * 0.1));
    const secondarySize = Math.max(16, Math.min(22, h * 0.07));

    ctx.save();
    ctx.fillStyle = '#e2e8f0';
    ctx.font = uiFont(nameSize, 700);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(fitText(ctx, label, textWidth), textX, nameY);

    const totalLabel = formatCompactNumber(row.total_messages || 0);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = uiFont(messageSize, 600);
    ctx.fillText(`${totalLabel} mensagens`, textX, nameY + messageSize + 10);

    ctx.fillStyle = '#94a3b8';
    ctx.font = uiFont(secondarySize, 500);
    ctx.fillText(`${percent}% do grupo`, textX, nameY + messageSize + secondarySize + 24);
    ctx.restore();

    const progressY = y + h - pad - 16;
    drawProgressBar({
      x: textX,
      y: progressY,
      w: textWidth,
      h: 11,
      ratio: share,
      accentColor,
      rank,
    });
  };

  drawCard({
    row: rows[0],
    x: topStartX,
    y: gridTop,
    w: rank1Width,
    h: rank1Height,
    rank: 1,
  });

  drawCard({
    row: rows[1],
    x: topStartX + rank1Width + gap,
    y: topRowBottom - rank2Height,
    w: rank2Width,
    h: rank2Height,
    rank: 2,
  });

  const restRows = rows.slice(2, 5);
  const restTop = topRowBottom + 28;
  if (restRows.length) {
    const restCount = restRows.length;
    const restGap = 20;
    const restWidth = (availableWidth - restGap * Math.max(0, restCount - 1)) / Math.max(1, restCount);
    const restHeight = Math.min(228, height - restTop - 116);
    const usedWidth = restWidth * restCount + restGap * Math.max(0, restCount - 1);
    const restStartX = margin + Math.max(0, (availableWidth - usedWidth) / 2);
    restRows.forEach((row, index) => {
      drawCard({
        row,
        x: restStartX + index * (restWidth + restGap),
        y: restTop,
        w: restWidth,
        h: restHeight,
        rank: index + 3,
      });
    });
  }

  const footerY = height - 36;
  const updatedAt = formatDate(__timeNow());
  ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
  ctx.font = uiFont(15, 500);
  ctx.textAlign = 'left';
  ctx.fillText(`Atualizado em: ${updatedAt}`, margin, footerY);
  ctx.textAlign = 'right';
  ctx.fillText('Powered by OmniZap', width - margin, footerY);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
};
