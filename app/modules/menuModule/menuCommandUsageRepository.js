import logger from '#logger';
import { executeQuery, TABLES } from '../../../database/index.js';

const DEFAULT_USAGE_WINDOW_DAYS = 30;
const DEFAULT_TOP_LIMIT = 20;
const DEFAULT_CACHE_TTL_MS = 90_000;

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric < min) return fallback;
  return Math.max(min, Math.min(max, numeric));
};

const MENU_USAGE_CACHE_TTL_MS = toPositiveInt(process.env.MENU_USAGE_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 5000, 10 * 60 * 1000);

const sanitizeLogValue = (value) =>
  String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeCommandName = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);

const normalizeChatId = (value) => {
  const normalized = String(value || '')
    .trim()
    .slice(0, 255);
  return normalized || null;
};

const buildCacheKey = ({ days, limit, chatId }) => `days:${days}|limit:${limit}|chat:${chatId || 'global'}`;

let usageCache = new Map();

export const listTopCommandsByUsage = async ({ days = DEFAULT_USAGE_WINDOW_DAYS, limit = DEFAULT_TOP_LIMIT, chatId = null, forceRefresh = false } = {}) => {
  const safeDays = toPositiveInt(days, DEFAULT_USAGE_WINDOW_DAYS, 1, 365);
  const safeLimit = toPositiveInt(limit, DEFAULT_TOP_LIMIT, 1, 100);
  const safeChatId = normalizeChatId(chatId);
  const cacheKey = buildCacheKey({
    days: safeDays,
    limit: safeLimit,
    chatId: safeChatId,
  });

  const now = Date.now();
  const cached = usageCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.rows;
  }

  const where = ['is_command = 1', 'command_known = 1', 'command_name IS NOT NULL', "command_name <> ''", 'created_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)'];
  const params = [safeDays];

  if (safeChatId) {
    where.push('chat_id = ?');
    params.push(safeChatId);
  }

  params.push(safeLimit);

  try {
    const rows = await executeQuery(
      `SELECT command_name AS command_name, COUNT(*) AS usage_count
         FROM ${TABLES.MESSAGE_ANALYSIS_EVENT}
        WHERE ${where.join(' AND ')}
        GROUP BY command_name
        ORDER BY usage_count DESC
        LIMIT ?`,
      params,
    );

    const normalizedRows = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const commandName = normalizeCommandName(row?.command_name);
        const usageCount = Number(row?.usage_count || 0);
        if (!commandName || !Number.isFinite(usageCount) || usageCount <= 0) return null;
        return {
          commandName,
          usageCount: Math.max(1, Math.floor(usageCount)),
        };
      })
      .filter(Boolean);

    usageCache.set(cacheKey, {
      rows: normalizedRows,
      expiresAt: now + MENU_USAGE_CACHE_TTL_MS,
    });

    return normalizedRows;
  } catch (error) {
    logger.warn('Falha ao consultar top comandos por uso para o menu dinamico.', {
      action: 'menu_usage_query_failed',
      error: sanitizeLogValue(error?.message) || 'unknown_error',
      chatId: safeChatId || null,
      days: safeDays,
      limit: safeLimit,
    });
    return [];
  }
};

export const resetMenuUsageCacheForTests = () => {
  usageCache = new Map();
};
