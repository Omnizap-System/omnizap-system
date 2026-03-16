import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { executeQuery, TABLES } from '../../../database/index.js';
import { getJidUser, getProfilePicBuffer, normalizeJid } from '../../config/index.js';
import { isUserAdmin } from '../../config/index.js';
import { extractUserIdInfo, isWhatsAppUserId, resolveUserId, resolveUserIdCached } from '../../config/index.js';
import { fetchBlocklistFromActiveSocket } from '../../config/index.js';
import { sendAndStore } from '../../services/messaging/messagePersistenceService.js';
import premiumUserStore from '../../store/premiumUserStore.js';
import logger from '#logger';
import { MESSAGE_TYPE_SQL, TIMESTAMP_TO_DATETIME_SQL } from '../statsModule/rankingCommon.js';
import { getAdminJid } from '../../config/index.js';
import { getUserUsageText } from './userConfigRuntime.js';

const DEFAULT_COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';
const ACTIVE_DAYS_WINDOW = Number.parseInt(process.env.USER_PROFILE_ACTIVE_DAYS || '30', 10);
const OWNER_JID = getAdminJid();
const MIN_PHONE_DIGITS = 5;
const MAX_PHONE_DIGITS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOCIAL_RECENT_DAYS = Number.parseInt(process.env.USER_PROFILE_SOCIAL_DAYS || '45', 10);
const SOCIAL_DST_EXPR = `JSON_UNQUOTE(
  COALESCE(
    JSON_EXTRACT(m.raw_message, '$.message.extendedTextMessage.contextInfo.participant'),
    JSON_EXTRACT(m.raw_message, '$.message.extendedTextMessage.contextInfo.mentionedJid[0]'),
    JSON_EXTRACT(m.raw_message, '$.message.imageMessage.contextInfo.participant'),
    JSON_EXTRACT(m.raw_message, '$.message.imageMessage.contextInfo.mentionedJid[0]'),
    JSON_EXTRACT(m.raw_message, '$.message.videoMessage.contextInfo.participant'),
    JSON_EXTRACT(m.raw_message, '$.message.videoMessage.contextInfo.mentionedJid[0]'),
    JSON_EXTRACT(m.raw_message, '$.message.documentMessage.contextInfo.participant'),
    JSON_EXTRACT(m.raw_message, '$.message.documentMessage.contextInfo.mentionedJid[0]')
  )
)`;

/**
 * Monta o texto de ajuda com a forma correta de uso do comando.
 * @param {string} [commandPrefix=DEFAULT_COMMAND_PREFIX] Prefixo configurado para comandos.
 * @returns {string} Texto de instruções para o usuário.
 */
const buildUsageText = (commandPrefix = DEFAULT_COMMAND_PREFIX) => getUserUsageText('user', { commandPrefix }) || ['Formato de uso:', `${commandPrefix}user perfil <id|telefone>`, '', 'Dica:', '• Você pode mencionar alguém.', '• Ou responder a mensagem do usuário desejado.'].join('\n');

/**
 * Extrai o `contextInfo` da mensagem, incluindo estruturas aninhadas.
 * @param {object} messageInfo Estrutura da mensagem recebida pelo bot.
 * @returns {object|null} `contextInfo` encontrado ou `null` quando indisponível.
 */
const getContextInfo = (messageInfo) => {
  const message = messageInfo?.message;
  if (!message || typeof message !== 'object') return null;

  for (const value of Object.values(message)) {
    if (value?.contextInfo && typeof value.contextInfo === 'object') {
      return value.contextInfo;
    }
    if (value?.message && typeof value.message === 'object') {
      for (const nested of Object.values(value.message)) {
        if (nested?.contextInfo && typeof nested.contextInfo === 'object') {
          return nested.contextInfo;
        }
      }
    }
  }

  return null;
};

/**
 * Normaliza e valida o alvo informado manualmente no comando.
 * @param {string} rawValue Valor bruto digitado após o subcomando.
 * @returns {{ jid: string | null, invalid: boolean }} JID normalizado ou sinalização de entrada inválida.
 */
const parseTargetArgument = (rawValue) => {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) return { jid: null, invalid: false };

  const withoutAt = value.startsWith('@') ? value.slice(1).trim() : value;
  if (!withoutAt) return { jid: null, invalid: true };

  if (withoutAt.includes('@')) {
    const normalized = normalizeJid(withoutAt);
    return normalized ? { jid: normalized, invalid: false } : { jid: null, invalid: true };
  }

  const digits = withoutAt.replace(/\D/g, '');
  const hasValidLength = digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS;
  if (!digits || !hasValidLength) return { jid: null, invalid: true };

  return { jid: `${digits}@s.whatsapp.net`, invalid: false };
};

/**
 * Define qual usuário será usado como alvo (menção, argumento, reply ou remetente).
 * @param {object} messageInfo Mensagem usada para inferir contexto.
 * @param {string|null} senderJid JID do remetente do comando.
 * @param {string} targetArg Argumento explícito passado no comando.
 * @returns {{ source: string | object | null, invalidExplicitTarget: boolean }} Fonte escolhida e sinalizador de argumento inválido.
 */
const resolveCandidateTarget = (messageInfo, senderJid, targetArg) => {
  const contextInfo = getContextInfo(messageInfo);
  const mentioned = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid.find(Boolean) || null : null;
  const parsedTarget = parseTargetArgument(targetArg);
  const repliedSource =
    contextInfo?.participant || contextInfo?.participantAlt
      ? {
          participant: contextInfo.participant || null,
          participantAlt: contextInfo.participantAlt || null,
        }
      : null;
  const hasContextTarget = Boolean(mentioned || repliedSource);

  return {
    source: mentioned || parsedTarget.jid || repliedSource || senderJid || null,
    invalidExplicitTarget: parsedTarget.invalid && !hasContextTarget,
  };
};

/**
 * Resolve o identificador canônico do usuário, considerando mapeamento JID/LID.
 * @param {string|object|null} source Fonte de identificação do usuário.
 * @returns {Promise<string|null>} ID canônico resolvido ou fallback quando possível.
 */
const resolveCanonicalTarget = async (source) => {
  if (!source) return null;
  const info = extractUserIdInfo(source);
  const fallbackId = resolveUserIdCached(info) || info.raw || null;
  try {
    const resolved = await resolveUserId(info);
    return normalizeJid(resolved) || resolved || fallbackId;
  } catch (error) {
    logger.warn('Falha ao resolver alvo no comando user perfil.', {
      error: error.message,
      source: info.raw,
    });
    return fallbackId;
  }
};

/**
 * Carrega todos os IDs equivalentes ao alvo (JID e/ou LID) para consultas no banco.
 * @param {string|null} canonicalTarget ID canônico do usuário.
 * @returns {Promise<string[]>} Lista de IDs possíveis para o mesmo usuário.
 */
const resolveSenderIdsForTarget = async (canonicalTarget) => {
  if (!canonicalTarget) return [];
  const ids = new Set([canonicalTarget]);

  if (isWhatsAppUserId(canonicalTarget)) {
    const rows = await executeQuery(`SELECT lid FROM ${TABLES.LID_MAP} WHERE jid = ?`, [canonicalTarget]);
    (rows || []).forEach((row) => {
      if (row?.lid) ids.add(row.lid);
    });
  } else {
    const rows = await executeQuery(`SELECT jid FROM ${TABLES.LID_MAP} WHERE lid = ?`, [canonicalTarget]);
    (rows || []).forEach((row) => {
      if (row?.jid) ids.add(normalizeJid(row.jid) || row.jid);
    });
  }

  return Array.from(ids);
};

/**
 * Constrói placeholders SQL para cláusulas `IN`.
 * @param {unknown[]} items Itens que serão bindados na query.
 * @returns {string} String no formato `?, ?, ?`.
 */
const buildInClause = (items) => items.map(() => '?').join(', ');

/**
 * Busca contagem e período de atividade do usuário no histórico de mensagens.
 * @param {{ canonicalId: string | null, senderIds?: string[] }} params Parâmetros de busca.
 * @returns {Promise<{ totalMessages: number, firstMessage: string | Date | null, lastMessage: string | Date | null }>} Estatísticas básicas.
 */
const fetchUserStats = async ({ canonicalId, senderIds = [] }) => {
  if (canonicalId) {
    const [row] = await executeQuery(
      `SELECT COUNT(*) AS total_messages,
              MIN(m.timestamp) AS first_message,
              MAX(m.timestamp) AS last_message
         FROM ${TABLES.MESSAGES} m
         LEFT JOIN ${TABLES.LID_MAP} lm
           ON lm.lid = m.sender_id
          AND lm.jid IS NOT NULL
        WHERE m.sender_id IS NOT NULL
          AND COALESCE(lm.jid, m.sender_id) = ?`,
      [canonicalId],
    );

    return {
      totalMessages: Number(row?.total_messages || 0),
      firstMessage: row?.first_message || null,
      lastMessage: row?.last_message || null,
    };
  }

  if (!senderIds.length) return { totalMessages: 0, firstMessage: null, lastMessage: null };

  const inClause = buildInClause(senderIds);
  const [row] = await executeQuery(
    `SELECT COUNT(*) AS total_messages,
            MIN(timestamp) AS first_message,
            MAX(timestamp) AS last_message
       FROM ${TABLES.MESSAGES}
      WHERE sender_id IN (${inClause})`,
    senderIds,
  );

  return {
    totalMessages: Number(row?.total_messages || 0),
    firstMessage: row?.first_message || null,
    lastMessage: row?.last_message || null,
  };
};

/**
 * Converte timestamps numéricos ou datas textuais para milissegundos.
 * @param {number|string|Date|null|undefined} value Valor de data/hora em formatos suportados.
 * @returns {number|null} Timestamp em milissegundos ou `null` quando inválido.
 */
const toMillis = (value) => {
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
 * Formata uma proporção em percentual com duas casas decimais.
 * @param {number} value Numerador.
 * @param {number} total Denominador.
 * @returns {string} Percentual no padrão `00.00%`.
 */
const formatPercent = (value, total) => {
  const numericValue = Number(value || 0);
  const numericTotal = Number(total || 0);
  if (numericTotal <= 0) return '0.00%';
  return `${((numericValue / numericTotal) * 100).toFixed(2)}%`;
};

/**
 * Calcula a diferença inteira em dias entre dois timestamps.
 * @param {number} fromMs Timestamp inicial em milissegundos.
 * @param {number} [toMs=__timeNowMs()] Timestamp final em milissegundos.
 * @returns {number} Quantidade de dias inteiros.
 */
const toIntegerDays = (fromMs, toMs = __timeNowMs()) => {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return 0;
  return Math.floor((toMs - fromMs) / DAY_MS);
};

/**
 * Normaliza um valor de data para chave `YYYY-MM-DD`.
 * @param {Date|string|number|null|undefined} value Valor retornado do banco.
 * @returns {string|null} Chave normalizada ou `null` quando inválida.
 */
const normalizeDayKey = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match?.[1]) return match[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

/**
 * Calcula a maior sequência de dias consecutivos com atividade.
 * @param {string[]} days Dias ativos ordenados no formato `YYYY-MM-DD`.
 * @returns {number} Melhor sequência contínua em dias.
 */
const computeStreak = (days) => {
  if (!days.length) return 0;
  let best = 1;
  let current = 1;
  let prev = new Date(`${days[0]}T00:00:00Z`).getTime();
  for (let i = 1; i < days.length; i += 1) {
    const currentDay = new Date(`${days[i]}T00:00:00Z`).getTime();
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
 * Consolida métricas globais de atividade do usuário para o perfil.
 * @param {{ canonicalId: string | null, totalMessages?: number, firstMessage?: string | Date | null, lastMessage?: string | Date | null }} params Dados base do usuário.
 * @returns {Promise<{ activeDays: number, avgPerDay: string, streakDays: number, favoriteType: string | null, favoriteCount: number }>} Indicadores de frequência e tipo favorito.
 */
const fetchUserGlobalRankingInsights = async ({ canonicalId, totalMessages = 0, firstMessage = null, lastMessage = null }) => {
  if (!canonicalId) {
    return {
      activeDays: 0,
      avgPerDay: '0.00',
      streakDays: 0,
      favoriteType: null,
      favoriteCount: 0,
    };
  }

  const daysRows = await executeQuery(
    `SELECT DISTINCT DATE(ts) AS day
       FROM (
         SELECT ${TIMESTAMP_TO_DATETIME_SQL} AS ts
           FROM ${TABLES.MESSAGES} m
           LEFT JOIN ${TABLES.LID_MAP} lm
             ON lm.lid = m.sender_id
            AND lm.jid IS NOT NULL
          WHERE m.sender_id IS NOT NULL
            AND COALESCE(lm.jid, m.sender_id) = ?
            AND m.timestamp IS NOT NULL
       ) d
      WHERE d.ts IS NOT NULL
      ORDER BY day ASC`,
    [canonicalId],
  );
  const days = Array.from(new Set((daysRows || []).map((item) => normalizeDayKey(item?.day)).filter(Boolean))).sort();
  const activeDays = days.length;
  const streakDays = computeStreak(days);

  const firstMs = toMillis(firstMessage);
  const lastMs = toMillis(lastMessage);
  let avgPerDay = '0.00';
  if (Number(totalMessages) > 0 && firstMs !== null && lastMs !== null) {
    const rangeDays = Math.max(1, Math.ceil((lastMs - firstMs) / DAY_MS) + 1);
    avgPerDay = (Number(totalMessages) / rangeDays).toFixed(2);
  }

  const [favRow] = await executeQuery(
    `SELECT
        ${MESSAGE_TYPE_SQL} AS message_type,
        COUNT(*) AS total
      FROM ${TABLES.MESSAGES} m
      LEFT JOIN ${TABLES.LID_MAP} lm
        ON lm.lid = m.sender_id
       AND lm.jid IS NOT NULL
      WHERE m.sender_id IS NOT NULL
        AND COALESCE(lm.jid, m.sender_id) = ?
        AND m.raw_message IS NOT NULL
      GROUP BY message_type
      ORDER BY total DESC
      LIMIT 1`,
    [canonicalId],
  );

  return {
    activeDays,
    avgPerDay,
    streakDays,
    favoriteType: favRow?.message_type || null,
    favoriteCount: Number(favRow?.total || 0),
  };
};

/**
 * Compara volume de mensagens dos últimos 30 dias com os 30 dias anteriores.
 * @param {string|null} canonicalId ID canônico do usuário.
 * @returns {Promise<{ last30: number, prev30: number, delta: number, trendLabel: 'subiu'|'caiu'|'estável' }>} Resultado da tendência.
 */
const fetchUserTrendInsights = async (canonicalId) => {
  if (!canonicalId) return { last30: 0, prev30: 0, delta: 0, trendLabel: 'estável' };

  const [row] = await executeQuery(
    `SELECT
        SUM(CASE WHEN m.timestamp >= NOW() - INTERVAL 30 DAY THEN 1 ELSE 0 END) AS last30,
        SUM(
          CASE
            WHEN m.timestamp < NOW() - INTERVAL 30 DAY
             AND m.timestamp >= NOW() - INTERVAL 60 DAY
            THEN 1
            ELSE 0
          END
        ) AS prev30
      FROM ${TABLES.MESSAGES} m
      LEFT JOIN ${TABLES.LID_MAP} lm
        ON lm.lid = m.sender_id
       AND lm.jid IS NOT NULL
      WHERE m.sender_id IS NOT NULL
        AND m.timestamp IS NOT NULL
        AND COALESCE(lm.jid, m.sender_id) = ?`,
    [canonicalId],
  );

  const last30 = Number(row?.last30 || 0);
  const prev30 = Number(row?.prev30 || 0);
  const delta = last30 - prev30;
  const trendLabel = delta > 0 ? 'subiu' : delta < 0 ? 'caiu' : 'estável';
  return { last30, prev30, delta, trendLabel };
};

/**
 * Traduz a hora do dia para uma faixa textual.
 * @param {number|string|null} hour Hora em formato 0-23.
 * @returns {string} Faixa horária (`madrugada`, `manhã`, `tarde`, `noite` ou `N/D`).
 */
const getHourBand = (hour) => {
  const h = Number(hour);
  if (!Number.isFinite(h) || h < 0 || h > 23) return 'N/D';
  if (h < 6) return 'madrugada';
  if (h < 12) return 'manhã';
  if (h < 18) return 'tarde';
  return 'noite';
};

/**
 * Obtém o horário de maior atividade do usuário.
 * @param {string|null} canonicalId ID canônico do usuário.
 * @returns {Promise<{ activeHour: number|null, hourBand: string, count: number }>} Hora mais ativa e total de mensagens na faixa.
 */
const fetchUserActiveHourInsights = async (canonicalId) => {
  if (!canonicalId) return { activeHour: null, hourBand: 'N/D', count: 0 };
  const [row] = await executeQuery(
    `SELECT HOUR(m.timestamp) AS active_hour,
            COUNT(*) AS total
       FROM ${TABLES.MESSAGES} m
       LEFT JOIN ${TABLES.LID_MAP} lm
         ON lm.lid = m.sender_id
        AND lm.jid IS NOT NULL
      WHERE m.sender_id IS NOT NULL
        AND m.timestamp IS NOT NULL
        AND COALESCE(lm.jid, m.sender_id) = ?
      GROUP BY HOUR(m.timestamp)
      ORDER BY total DESC
      LIMIT 1`,
    [canonicalId],
  );

  const activeHour = row?.active_hour ?? null;
  return {
    activeHour,
    hourBand: getHourBand(activeHour),
    count: Number(row?.total || 0),
  };
};

/**
 * Identifica o tipo de mensagem dominante no período atual e no período anterior.
 * @param {string|null} canonicalId ID canônico do usuário.
 * @returns {Promise<{ last30: { type: string|null, count: number }, prev30: { type: string|null, count: number } }>} Tipos dominantes por janela.
 */
const fetchDominantTypeByPeriod = async (canonicalId) => {
  if (!canonicalId) {
    return {
      last30: { type: null, count: 0 },
      prev30: { type: null, count: 0 },
    };
  }

  const rows = await executeQuery(
    `SELECT period, message_type, total
       FROM (
             SELECT
               CASE
                 WHEN m.timestamp >= NOW() - INTERVAL 30 DAY THEN 'last30'
                 ELSE 'prev30'
               END AS period,
               ${MESSAGE_TYPE_SQL} AS message_type,
               COUNT(*) AS total
             FROM ${TABLES.MESSAGES} m
             LEFT JOIN ${TABLES.LID_MAP} lm
               ON lm.lid = m.sender_id
              AND lm.jid IS NOT NULL
             WHERE m.sender_id IS NOT NULL
               AND m.raw_message IS NOT NULL
               AND m.timestamp IS NOT NULL
               AND m.timestamp >= NOW() - INTERVAL 60 DAY
               AND COALESCE(lm.jid, m.sender_id) = ?
             GROUP BY period, message_type
            ) t
      ORDER BY period, total DESC`,
    [canonicalId],
  );

  const result = {
    last30: { type: null, count: 0 },
    prev30: { type: null, count: 0 },
  };
  (rows || []).forEach((row) => {
    const period = row?.period;
    if (!period || !result[period]) return;
    if (result[period].type) return;
    result[period] = {
      type: row?.message_type || null,
      count: Number(row?.total || 0),
    };
  });

  return result;
};

/**
 * Calcula posição do usuário no ranking global por volume de mensagens.
 * @param {string|null} canonicalId ID canônico do usuário.
 * @returns {Promise<{ position: number|null, totalRankedUsers: number, totalMessages: number }>} Posição no ranking e totais associados.
 */
const fetchUserRanking = async (canonicalId) => {
  if (!canonicalId) {
    return { position: null, totalRankedUsers: 0, totalMessages: 0 };
  }

  const [totalRow] = await executeQuery(
    `SELECT COUNT(*) AS total_messages
       FROM ${TABLES.MESSAGES} m
       LEFT JOIN ${TABLES.LID_MAP} lm ON lm.lid = m.sender_id
      WHERE m.sender_id IS NOT NULL
        AND COALESCE(lm.jid, m.sender_id) = ?`,
    [canonicalId],
  );
  const totalMessages = Number(totalRow?.total_messages || 0);

  const [rankedUsersRow] = await executeQuery(
    `SELECT COUNT(*) AS total_ranked_users
       FROM (
             SELECT COALESCE(lm.jid, m.sender_id) AS canonical_id
               FROM ${TABLES.MESSAGES} m
               LEFT JOIN ${TABLES.LID_MAP} lm ON lm.lid = m.sender_id
              WHERE m.sender_id IS NOT NULL
              GROUP BY COALESCE(lm.jid, m.sender_id)
            ) ranked_users`,
  );
  const totalRankedUsers = Number(rankedUsersRow?.total_ranked_users || 0);

  if (totalMessages <= 0) {
    return { position: null, totalRankedUsers, totalMessages };
  }

  const [rankRow] = await executeQuery(
    `SELECT COUNT(*) + 1 AS rank_position
       FROM (
             SELECT COALESCE(lm.jid, m.sender_id) AS canonical_id,
                    COUNT(*) AS total_messages
               FROM ${TABLES.MESSAGES} m
               LEFT JOIN ${TABLES.LID_MAP} lm ON lm.lid = m.sender_id
              WHERE m.sender_id IS NOT NULL
              GROUP BY COALESCE(lm.jid, m.sender_id)
            ) ranked
      WHERE ranked.total_messages > ?`,
    [totalMessages],
  );

  return {
    position: Number.isFinite(Number(rankRow?.rank_position)) ? Number(rankRow.rank_position) : null,
    totalRankedUsers,
    totalMessages,
  };
};

/**
 * Busca o `pushName` mais recente entre um conjunto de IDs equivalentes.
 * @param {string[]} senderIds IDs usados nas mensagens salvas.
 * @returns {Promise<string|null>} Nome exibido mais recente, quando disponível.
 */
const fetchLatestPushName = async (senderIds) => {
  if (!senderIds.length) return null;
  const inClause = buildInClause(senderIds);
  const [row] = await executeQuery(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(raw_message, '$.pushName')) AS push_name
       FROM ${TABLES.MESSAGES}
      WHERE sender_id IN (${inClause})
        AND raw_message IS NOT NULL
        AND JSON_EXTRACT(raw_message, '$.pushName') IS NOT NULL
      ORDER BY id DESC
      LIMIT 1`,
    senderIds,
  );
  return row?.push_name || null;
};

/**
 * Tenta resolver o nome de exibição do contato a partir do cache de contatos do socket.
 * @param {object} sock Instância do socket Baileys.
 * @param {string[]} ids Lista de IDs candidatos.
 * @returns {string|null} Nome encontrado ou `null`.
 */
const resolveNameFromContacts = (sock, ids) => {
  for (const id of ids) {
    const contact = sock?.contacts?.[id];
    const name = contact?.notify || contact?.name || contact?.short || null;
    if (name) return name;
  }
  return null;
};

/**
 * Busca o `pushName` mais recente para um ID canônico específico.
 * @param {string|null} canonicalId ID canônico alvo.
 * @returns {Promise<string|null>} Nome mais recente registrado nas mensagens.
 */
const fetchCanonicalPushName = async (canonicalId) => {
  if (!canonicalId) return null;
  const [row] = await executeQuery(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(m.raw_message, '$.pushName')) AS push_name
       FROM ${TABLES.MESSAGES} m
       LEFT JOIN ${TABLES.LID_MAP} lm
         ON lm.lid = m.sender_id
        AND lm.jid IS NOT NULL
      WHERE m.sender_id IS NOT NULL
        AND COALESCE(lm.jid, m.sender_id) = ?
        AND m.raw_message IS NOT NULL
        AND JSON_EXTRACT(m.raw_message, '$.pushName') IS NOT NULL
      ORDER BY m.id DESC
      LIMIT 1`,
    [canonicalId],
  );
  return row?.push_name || null;
};

/**
 * Monta a base SQL reutilizável para análises de interação social.
 * @param {string} selectSql Trecho `SELECT ...` que será aplicado sobre a CTE `base`.
 * @returns {string} Query SQL final.
 */
const buildSocialBaseQuery = (selectSql) => `
  WITH base AS (
    SELECT
      COALESCE(src_map.jid, m.sender_id) AS src,
      COALESCE(dst_map.jid, ${SOCIAL_DST_EXPR}) AS dst
    FROM ${TABLES.MESSAGES} m
    LEFT JOIN ${TABLES.LID_MAP} src_map
      ON src_map.lid = m.sender_id
     AND src_map.jid IS NOT NULL
    LEFT JOIN ${TABLES.LID_MAP} dst_map
      ON dst_map.lid = ${SOCIAL_DST_EXPR}
     AND dst_map.jid IS NOT NULL
    WHERE m.raw_message IS NOT NULL
      AND m.sender_id IS NOT NULL
      AND m.timestamp IS NOT NULL
      AND m.timestamp >= NOW() - INTERVAL ${SOCIAL_RECENT_DAYS} DAY
      AND ${SOCIAL_DST_EXPR} IS NOT NULL
      AND ${SOCIAL_DST_EXPR} <> ''
      AND COALESCE(src_map.jid, m.sender_id) <> COALESCE(dst_map.jid, ${SOCIAL_DST_EXPR})
  )
  ${selectSql}
`;

/**
 * Calcula métricas sociais do usuário (envio/recebimento de respostas e parceiros).
 * @param {{ canonicalId: string | null, sock: object }} params Parâmetros de consulta.
 * @returns {Promise<{
 *   repliesSent: number,
 *   repliesReceived: number,
 *   socialScore: number,
 *   uniquePartners: number,
 *   topPartnerId: string|null,
 *   topPartnerCount: number,
 *   topPartnerLabel: string,
 *   responseRatePercent: string,
 *   responseRatio: string,
 *   topPartners: Array<{ id: string|null, count: number, label: string }>
 * }>} Métricas sociais agregadas.
 */
const fetchUserSocialInsights = async ({ canonicalId, sock }) => {
  if (!canonicalId) {
    return {
      repliesSent: 0,
      repliesReceived: 0,
      socialScore: 0,
      uniquePartners: 0,
      topPartnerId: null,
      topPartnerCount: 0,
      topPartnerLabel: 'N/D',
      responseRatePercent: '0.00%',
      responseRatio: '0/0',
      topPartners: [],
    };
  }

  const [summaryRow] = await executeQuery(
    buildSocialBaseQuery(
      `SELECT
          SUM(CASE WHEN src = ? THEN 1 ELSE 0 END) AS replies_sent,
          SUM(CASE WHEN dst = ? THEN 1 ELSE 0 END) AS replies_received,
          COUNT(DISTINCT CASE
            WHEN src = ? THEN dst
            WHEN dst = ? THEN src
            ELSE NULL
          END) AS unique_partners
        FROM base
       WHERE src = ? OR dst = ?`,
    ),
    [canonicalId, canonicalId, canonicalId, canonicalId, canonicalId, canonicalId],
  );

  const topPartnerRows = await executeQuery(
    buildSocialBaseQuery(
      `SELECT
          CASE WHEN src = ? THEN dst ELSE src END AS partner_id,
          COUNT(*) AS total
        FROM base
       WHERE src = ? OR dst = ?
       GROUP BY partner_id
       ORDER BY total DESC
       LIMIT 3`,
    ),
    [canonicalId, canonicalId, canonicalId],
  );

  const repliesSent = Number(summaryRow?.replies_sent || 0);
  const repliesReceived = Number(summaryRow?.replies_received || 0);
  const uniquePartners = Number(summaryRow?.unique_partners || 0);
  const topPartners = await Promise.all(
    (topPartnerRows || []).map(async (row) => {
      const id = row?.partner_id || null;
      const count = Number(row?.total || 0);
      const mention = id && getJidUser(id) ? `@${getJidUser(id)}` : null;
      const fromContacts = resolveNameFromContacts(sock, id ? [id] : []);
      const pushName = id ? await fetchCanonicalPushName(id) : null;
      const label = fromContacts || pushName || mention || id || 'N/D';
      return { id, count, label };
    }),
  );
  const topPartner = topPartners[0] || null;
  const topPartnerId = topPartner?.id || null;
  const topPartnerCount = Number(topPartner?.count || 0);
  const topPartnerLabel = topPartner?.label || 'N/D';
  const totalSocial = repliesSent + repliesReceived;
  const responseRatePercent = totalSocial > 0 ? `${((repliesSent / totalSocial) * 100).toFixed(2)}%` : '0.00%';
  const responseRatio = `${repliesSent}/${repliesReceived}`;

  return {
    repliesSent,
    repliesReceived,
    socialScore: repliesSent + repliesReceived,
    uniquePartners,
    topPartnerId,
    topPartnerCount,
    topPartnerLabel,
    responseRatePercent,
    responseRatio,
    topPartners,
  };
};

/**
 * Retorna os grupos onde o usuário mais fala.
 * @param {string|null} canonicalId ID canônico do usuário.
 * @returns {Promise<Array<{ chatId: string|null, subject: string|null, total: number }>>} Top grupos por volume.
 */
const fetchTopGroupsInsights = async (canonicalId) => {
  if (!canonicalId) return [];
  const rows = await executeQuery(
    `SELECT
        m.chat_id,
        COALESCE(gm.subject, '') AS group_subject,
        COUNT(*) AS total
      FROM ${TABLES.MESSAGES} m
      LEFT JOIN ${TABLES.LID_MAP} lm
        ON lm.lid = m.sender_id
       AND lm.jid IS NOT NULL
      LEFT JOIN ${TABLES.GROUPS_METADATA} gm
        ON gm.id = m.chat_id
      WHERE m.sender_id IS NOT NULL
        AND m.chat_id LIKE '%@g.us'
        AND COALESCE(lm.jid, m.sender_id) = ?
      GROUP BY m.chat_id, gm.subject
      ORDER BY total DESC
      LIMIT 3`,
    [canonicalId],
  );
  return (rows || []).map((row) => ({
    chatId: row?.chat_id || null,
    subject: row?.group_subject ? String(row.group_subject).trim() : null,
    total: Number(row?.total || 0),
  }));
};

/**
 * Calcula participação proporcional do usuário no global e no grupo atual.
 * @param {{ canonicalId: string | null, totalMessages: number, remoteJid: string, isGroupMessage: boolean }} params Contexto da conversa e totais.
 * @returns {Promise<{ globalTotal: number, globalShare: string, groupTotal: number, groupUserTotal: number, groupShare: string }>} Métricas de participação.
 */
const fetchParticipationInsights = async ({ canonicalId, totalMessages, remoteJid, isGroupMessage }) => {
  const [globalRow] = await executeQuery(
    `SELECT COUNT(*) AS total
       FROM ${TABLES.MESSAGES}
      WHERE sender_id IS NOT NULL`,
  );
  const globalTotal = Number(globalRow?.total || 0);

  const globalShare = formatPercent(totalMessages, globalTotal);

  if (!isGroupMessage || !remoteJid || !canonicalId) {
    return {
      globalTotal,
      globalShare,
      groupTotal: 0,
      groupUserTotal: 0,
      groupShare: 'N/D',
    };
  }

  const [groupTotalsRow, groupUserRow] = await Promise.all([
    executeQuery(
      `SELECT COUNT(*) AS total
         FROM ${TABLES.MESSAGES}
        WHERE sender_id IS NOT NULL
          AND chat_id = ?`,
      [remoteJid],
    ),
    executeQuery(
      `SELECT COUNT(*) AS total
         FROM ${TABLES.MESSAGES} m
         LEFT JOIN ${TABLES.LID_MAP} lm
           ON lm.lid = m.sender_id
          AND lm.jid IS NOT NULL
        WHERE m.sender_id IS NOT NULL
          AND m.chat_id = ?
          AND COALESCE(lm.jid, m.sender_id) = ?`,
      [remoteJid, canonicalId],
    ),
  ]);

  const groupTotal = Number(groupTotalsRow?.[0]?.total || 0);
  const groupUserTotal = Number(groupUserRow?.[0]?.total || 0);
  const groupShare = groupTotal > 0 ? formatPercent(groupUserTotal, groupTotal) : '0.00%';

  return {
    globalTotal,
    globalShare,
    groupTotal,
    groupUserTotal,
    groupShare,
  };
};

/**
 * Formata JID para telefone em padrão internacional simples.
 * @param {string|null} jid JID do usuário.
 * @returns {string} Telefone formatado ou `N/D`.
 */
const formatPhone = (jid) => {
  const user = getJidUser(jid);
  if (!user) return 'N/D';
  const digits = user.replace(/\D/g, '');
  return digits ? `+${digits}` : user;
};

/**
 * Formata data/hora no padrão pt-BR com timezone de São Paulo.
 * @param {string|Date|null} value Valor de data para formatação.
 * @returns {string} Data formatada ou texto padrão quando indisponível.
 */
const formatDateTime = (value) => {
  if (!value) return 'Sem registros';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sem registros';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
};

/**
 * Verifica se houve interação dentro da janela de atividade configurada.
 * @param {string|Date|null} lastMessage Última mensagem registrada.
 * @returns {boolean} `true` quando a última interação está dentro da janela ativa.
 */
const hasRecentInteraction = (lastMessage) => {
  if (!lastMessage) return false;
  const parsed = lastMessage instanceof Date ? lastMessage.getTime() : new Date(lastMessage).getTime();
  if (!Number.isFinite(parsed)) return false;
  const maxAgeMs = ACTIVE_DAYS_WINDOW * 24 * 60 * 60 * 1000;
  return __timeNowMs() - parsed <= maxAgeMs;
};

/**
 * Consulta se algum dos IDs do usuário está bloqueado no WhatsApp.
 * @param {string[]} targetIds IDs que representam o usuário alvo.
 * @returns {Promise<boolean>} `true` quando o alvo consta na blocklist.
 */
const isTargetBlocked = async (targetIds) => {
  try {
    const blocklist = await fetchBlocklistFromActiveSocket();
    if (!Array.isArray(blocklist) || blocklist.length === 0) return false;
    const normalizedBlocked = new Set(blocklist.map((jid) => normalizeJid(jid) || jid).filter(Boolean));
    return targetIds.some((id) => normalizedBlocked.has(normalizeJid(id) || id));
  } catch (error) {
    logger.warn('Falha ao consultar blocklist no comando user perfil.', { error: error.message });
    return false;
  }
};

/**
 * Converte a primeira mensagem em tempo de casa no bot (em dias).
 * @param {string|Date|null} firstMessage Primeira mensagem registrada.
 * @returns {string} Tempo de casa formatado.
 */
const formatTempoDeCasa = (firstMessage) => {
  const firstMs = toMillis(firstMessage);
  if (!Number.isFinite(firstMs)) return 'N/D';
  const days = toIntegerDays(firstMs, __timeNowMs());
  return `${days} dia(s)`;
};

/**
 * Calcula quantos dias o usuário está sem enviar mensagens.
 * @param {string|Date|null} lastMessage Última mensagem registrada.
 * @returns {string} Quantidade de dias sem falar.
 */
const formatDaysSinceLastMessage = (lastMessage) => {
  const lastMs = toMillis(lastMessage);
  if (!Number.isFinite(lastMs)) return 'N/D';
  return `${toIntegerDays(lastMs, __timeNowMs())} dia(s)`;
};

/**
 * Formata o resumo da tendência de mensagens dos últimos períodos.
 * @param {{ trendLabel: string, delta: number, last30: number, prev30: number }} trend Dados de tendência.
 * @returns {string} Texto de tendência pronto para exibição.
 */
const formatTrendLabel = ({ trendLabel, delta, last30, prev30 }) => {
  const sign = delta > 0 ? '+' : '';
  return `${trendLabel} (${sign}${delta} | 30d: ${last30} vs ant.: ${prev30})`;
};

/**
 * Trunca labels longos preservando tamanho máximo com reticências.
 * @param {string} value Texto original.
 * @param {number} [max=30] Tamanho máximo permitido.
 * @returns {string} Texto truncado quando necessário.
 */
const truncateLabel = (value, max = 30) => {
  const input = String(value || '');
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}…`;
};

/**
 * Formata a saída do horário mais ativo do usuário.
 * @param {{ hourBand: string, activeHour: number|null, count: number }} insights Dados de atividade por hora.
 * @returns {string} Texto de horário mais ativo.
 */
const formatActiveHourLabel = ({ hourBand, activeHour, count }) => {
  if (!Number.isFinite(Number(activeHour))) return 'N/D';
  return `${hourBand} (${String(activeHour).padStart(2, '0')}h, ${count} msg)`;
};

/**
 * Formata os tipos de mensagem dominantes por janela temporal.
 * @param {{ last30?: { type?: string|null, count?: number }, prev30?: { type?: string|null, count?: number } }} dominantByPeriod Resultado bruto da consulta.
 * @returns {string} Texto com comparativo entre período atual e anterior.
 */
const formatDominantTypeByPeriod = (dominantByPeriod) => {
  const last30Type = dominantByPeriod?.last30?.type || 'N/D';
  const last30Count = Number(dominantByPeriod?.last30?.count || 0);
  const prev30Type = dominantByPeriod?.prev30?.type || 'N/D';
  const prev30Count = Number(dominantByPeriod?.prev30?.count || 0);
  return `30d: ${last30Type} (${last30Count}) | ant.: ${prev30Type} (${prev30Count})`;
};

/**
 * Formata lista dos principais parceiros de interação em linhas.
 * @param {Array<{ label: string, count: number }>} [topPartners=[]] Lista dos parceiros.
 * @returns {string} Bloco multiline com ranking de parceiros.
 */
const formatTopPartnersLine = (topPartners = []) => {
  if (!Array.isArray(topPartners) || topPartners.length === 0) return '   N/D';
  return topPartners
    .slice(0, 3)
    .map((entry, index) => `   ${index + 1}) ${truncateLabel(entry.label, 26)} (${entry.count})`)
    .join('\n');
};

/**
 * Formata lista dos grupos com maior volume de mensagens do usuário.
 * @param {Array<{ subject?: string|null, chatId?: string|null, total: number }>} [topGroups=[]] Lista de grupos.
 * @returns {string} Bloco multiline com ranking de grupos.
 */
const formatTopGroupsLine = (topGroups = []) => {
  if (!Array.isArray(topGroups) || topGroups.length === 0) return '   N/D';
  return topGroups
    .slice(0, 3)
    .map((entry, index) => `   ${index + 1}) ${truncateLabel((entry.subject && entry.subject.trim()) || entry.chatId || 'grupo', 24)} (${entry.total})`)
    .join('\n');
};

/**
 * Insere linhas em branco entre itens para melhorar legibilidade.
 * @param {string[]} [lines=[]] Linhas que serão espaçadas.
 * @returns {string[]} Linhas com separação vertical.
 */
const withVerticalSpacing = (lines = []) => lines.flatMap((line, index) => (index === lines.length - 1 ? [line] : [line, '']));

/**
 * Constrói a mensagem final do perfil com seções e métricas organizadas.
 * @param {object} data Dados agregados do usuário para renderização.
 * @returns {string} Texto completo enviado no comando de perfil.
 */
const buildProfileMessage = ({ mentionLabel, displayName, phone, canonicalTarget, status, firstMessage, tempoDeCasa, lastInteraction, diasSemFalar, totalMessages, rankingLabel, trendLabel, avgPerDay, activeDays, streakDays, activeHourLabel, favoriteTypeLabel, dominantTypeByPeriodLabel, socialScore, socialSent, socialReceived, responseRateLabel, socialPartners, topPartnerLabel, topPartnersLabel, topGroupsLabel, globalShareLabel, groupShareLabel, tags }) => ['👤 *PERFIL DO USUÁRIO*', '━━━━━━━━━━━━━━━━━━━━', '', '🧾 *Identificação*', ...withVerticalSpacing([`• Usuário: ${mentionLabel}`, `• Nome: ${displayName}`, `• Número: ${phone}`, `• ID: ${canonicalTarget || 'N/D'}`, `• Status: *${status}*`]), '', '📈 *Mensagens e Ranking*', ...withVerticalSpacing([`• Primeira mensagem: ${firstMessage}`, `• Tempo de casa no bot: ${tempoDeCasa}`, `• Última interação: ${lastInteraction}`, `• Dias sem falar: ${diasSemFalar}`, `• Mensagens gerais registradas: ${totalMessages}`, `• Participação global: ${globalShareLabel}`, `• Participação no grupo atual: ${groupShareLabel}`, `• Posição no ranking (mensagens): ${rankingLabel}`, `• Tendência de mensagens: ${trendLabel}`, `• Média/dia (global): ${avgPerDay}`, `• Dias ativos (global): ${activeDays}`, `• Streak (global): ${streakDays} dia(s)`, `• Horário mais ativo: ${activeHourLabel}`, `• Tipo favorito (global): ${favoriteTypeLabel}`, `• Tipo dominante por período: ${dominantTypeByPeriodLabel}`]), '', '🌐 *Interações Sociais*', ...withVerticalSpacing([`• Interações sociais (${SOCIAL_RECENT_DAYS}d): ${socialScore}`, `• Respostas enviadas (${SOCIAL_RECENT_DAYS}d): ${socialSent}`, `• Respostas recebidas (${SOCIAL_RECENT_DAYS}d): ${socialReceived}`, `• Taxa de resposta (${SOCIAL_RECENT_DAYS}d): ${responseRateLabel}`, `• Parceiros sociais (${SOCIAL_RECENT_DAYS}d): ${socialPartners}`, `• Parceiro principal (${SOCIAL_RECENT_DAYS}d): ${topPartnerLabel}`, `• Top 3 parceiros (${SOCIAL_RECENT_DAYS}d):\n${topPartnersLabel}`]), '', '🏘️ *Presença em Grupos*', ...withVerticalSpacing([`• Top grupos onde fala:\n${topGroupsLabel}`]), '', '🏷️ *Contexto*', ...withVerticalSpacing([`• Tags: ${tags.length ? tags.join(', ') : 'sem tags'}`])].join('\n');

/**
 * Seleciona o primeiro ID de usuário válido dentro de uma lista.
 * @param {string[]} [ids=[]] IDs candidatos.
 * @returns {string|null} Primeiro JID de usuário válido ou `null`.
 */
const resolveMentionJid = (ids = []) => ids.find((id) => isWhatsAppUserId(id)) || null;

/**
 * Processa o comando `user perfil`, resolve o alvo e envia o resumo com métricas.
 * @param {object} params Parâmetros operacionais do comando.
 * @param {object} params.sock Instância do socket Baileys.
 * @param {string} params.remoteJid JID da conversa atual.
 * @param {object} params.messageInfo Mensagem original usada como contexto.
 * @param {number|undefined} params.expirationMessage Configuração de expiração de mensagem.
 * @param {string} params.senderJid JID de quem executou o comando.
 * @param {string[]} [params.args=[]] Argumentos recebidos após o comando.
 * @param {boolean} params.isGroupMessage Indica se o contexto é grupo.
 * @param {string} [params.commandPrefix=DEFAULT_COMMAND_PREFIX] Prefixo de comandos.
 * @returns {Promise<void>} Finaliza após responder ao usuário.
 */
export async function handleUserCommand({ sock, remoteJid, messageInfo, expirationMessage, senderJid, args = [], isGroupMessage, commandPrefix = DEFAULT_COMMAND_PREFIX }) {
  const subcommand = args?.[0]?.toLowerCase() || '';
  if (subcommand !== 'perfil' && subcommand !== 'profile') {
    await sendAndStore(sock, remoteJid, { text: buildUsageText(commandPrefix) }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  const explicitTargetArg = args.slice(1).join(' ').trim();
  const { source, invalidExplicitTarget } = resolveCandidateTarget(messageInfo, senderJid, explicitTargetArg);
  if (invalidExplicitTarget) {
    await sendAndStore(sock, remoteJid, { text: `❌ ID ou telefone inválido.\n\n${buildUsageText(commandPrefix)}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }
  if (!source) {
    await sendAndStore(sock, remoteJid, { text: buildUsageText(commandPrefix) }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  try {
    const canonicalTarget = await resolveCanonicalTarget(source);
    const senderIds = await resolveSenderIdsForTarget(canonicalTarget);
    const normalizedTargetIds = Array.from(new Set([canonicalTarget, ...senderIds].map((value) => normalizeJid(value) || value).filter(Boolean)));
    const mentionJid = resolveMentionJid(normalizedTargetIds);
    const senderCanonical = resolveUserIdCached({
      jid: senderJid,
      lid: senderJid,
      participantAlt: null,
    });
    const rankingTargetId = mentionJid || canonicalTarget;

    const [stats, ranking, latestPushName, premiumUsers, blocked, groupAdmin] = await Promise.all([fetchUserStats({ canonicalId: rankingTargetId, senderIds: normalizedTargetIds }), fetchUserRanking(rankingTargetId), fetchLatestPushName(normalizedTargetIds), premiumUserStore.getPremiumUsers(), isTargetBlocked(normalizedTargetIds), isGroupMessage ? isUserAdmin(remoteJid, mentionJid || canonicalTarget) : Promise.resolve(false)]);
    const [globalInsights, socialInsights, trendInsights, activeHourInsights, dominantTypeByPeriod, topGroups, participationInsights] = await Promise.all([
      fetchUserGlobalRankingInsights({
        canonicalId: rankingTargetId,
        totalMessages: stats.totalMessages,
        firstMessage: stats.firstMessage,
        lastMessage: stats.lastMessage,
      }),
      fetchUserSocialInsights({
        canonicalId: rankingTargetId,
        sock,
      }),
      fetchUserTrendInsights(rankingTargetId),
      fetchUserActiveHourInsights(rankingTargetId),
      fetchDominantTypeByPeriod(rankingTargetId),
      fetchTopGroupsInsights(rankingTargetId),
      fetchParticipationInsights({
        canonicalId: rankingTargetId,
        totalMessages: stats.totalMessages,
        remoteJid,
        isGroupMessage,
      }),
    ]);

    const premiumSet = new Set((premiumUsers || []).map((jid) => normalizeJid(jid) || jid));
    const isPremium = normalizedTargetIds.some((id) => premiumSet.has(id));
    const isOwner = OWNER_JID ? normalizedTargetIds.some((id) => id === OWNER_JID) : false;
    const recentInteraction = hasRecentInteraction(stats.lastMessage);
    const status = blocked ? 'bloqueado' : 'ativo';
    const mentionUser = getJidUser(mentionJid || canonicalTarget);
    const mentionLabel = mentionUser ? `@${mentionUser}` : canonicalTarget || 'Desconhecido';
    const nameFromContacts = resolveNameFromContacts(sock, normalizedTargetIds);
    const displayName = nameFromContacts || latestPushName || mentionLabel;

    const tags = [];
    if (senderCanonical && canonicalTarget && senderCanonical === canonicalTarget) tags.push('você');
    if (isPremium) tags.push('premium');
    if (groupAdmin) tags.push('admin do grupo');
    if (isOwner) tags.push('owner');
    if (!recentInteraction && stats.totalMessages > 0) tags.push('inativo');
    if (stats.totalMessages === 0) tags.push('sem histórico');
    const rankingLabel = ranking.position && ranking.totalRankedUsers > 0 ? `#${ranking.position} de ${ranking.totalRankedUsers}` : 'fora do ranking (sem mensagens)';
    const favoriteTypeLabel = globalInsights.favoriteType ? `${globalInsights.favoriteType} (${globalInsights.favoriteCount})` : 'N/D';
    const topPartnerLabel = socialInsights.topPartnerCount > 0 ? `${socialInsights.topPartnerLabel} (${socialInsights.topPartnerCount})` : 'N/D';
    const trendLabel = formatTrendLabel(trendInsights);
    const activeHourLabel = formatActiveHourLabel(activeHourInsights);
    const dominantTypeByPeriodLabel = formatDominantTypeByPeriod(dominantTypeByPeriod);
    const responseRateLabel = `${socialInsights.responseRatePercent} (${socialInsights.responseRatio})`;
    const topPartnersLabel = formatTopPartnersLine(socialInsights.topPartners);
    const topGroupsLabel = formatTopGroupsLine(topGroups);
    const groupShareLabel = isGroupMessage ? `${participationInsights.groupShare} (${participationInsights.groupUserTotal}/${participationInsights.groupTotal})` : 'N/D';
    const globalShareLabel = `${participationInsights.globalShare} (${stats.totalMessages}/${participationInsights.globalTotal})`;

    const text = buildProfileMessage({
      mentionLabel,
      displayName,
      phone: formatPhone(canonicalTarget),
      canonicalTarget,
      status,
      firstMessage: formatDateTime(stats.firstMessage),
      tempoDeCasa: formatTempoDeCasa(stats.firstMessage),
      lastInteraction: formatDateTime(stats.lastMessage),
      diasSemFalar: formatDaysSinceLastMessage(stats.lastMessage),
      totalMessages: stats.totalMessages,
      globalShareLabel,
      groupShareLabel,
      rankingLabel,
      trendLabel,
      avgPerDay: globalInsights.avgPerDay,
      activeDays: globalInsights.activeDays,
      streakDays: globalInsights.streakDays,
      activeHourLabel,
      favoriteTypeLabel,
      dominantTypeByPeriodLabel,
      socialScore: socialInsights.socialScore,
      socialSent: socialInsights.repliesSent,
      socialReceived: socialInsights.repliesReceived,
      responseRateLabel,
      socialPartners: socialInsights.uniquePartners,
      topPartnerLabel,
      topPartnersLabel,
      topGroupsLabel,
      tags,
    });

    const mentions = mentionJid ? [mentionJid] : [];
    const avatarJid = mentionJid;
    const profilePicBuffer = avatarJid
      ? await getProfilePicBuffer(sock, {
          key: {
            participant: avatarJid,
            remoteJid,
          },
        })
      : null;

    await sendAndStore(sock, remoteJid, profilePicBuffer ? (mentions.length ? { image: profilePicBuffer, caption: text, mentions } : { image: profilePicBuffer, caption: text }) : mentions.length ? { text, mentions } : { text }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
  } catch (error) {
    logger.error('Erro ao processar comando user perfil.', { error: error.message });
    await sendAndStore(sock, remoteJid, { text: '❌ Não foi possível carregar o perfil do usuário agora.' }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
  }
}
