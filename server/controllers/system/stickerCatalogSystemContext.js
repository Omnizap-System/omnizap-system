import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { withTimeout } from '../../http/httpRequestUtils.js';

export const createStickerCatalogSystemContext = ({ executeQuery, tables, logger, getSystemMetrics, getActiveSocket, resolveSocketReadyState, resolveActiveSocketBotJid, resolveCatalogBotPhone, fetchPrometheusSummary, metricsEndpoint, systemSummaryCache, systemSummaryCacheSeconds, readmeSummaryCache, readmeSummaryCacheSeconds, readmeMessageTypeSampleLimit, readmeCommandPrefix, buildMenuCaption, buildStickerMenu, buildMediaMenu, buildQuoteMenu, buildAnimeMenu, buildAiMenu, buildStatsMenu, buildAdminMenu, profilePictureUrlFromActiveSocket, normalizeJid, getJidUser, globalRankCache, globalRankRefreshSeconds, marketplaceGlobalStatsCache, marketplaceGlobalStatsCacheSeconds }) => {
  let globalRankRefreshTimer = null;

  const buildSystemSummarySnapshot = async () => {
    const system = getSystemMetrics();
    const activeSocket = getActiveSocket();
    let prometheus = null;
    let prometheusError = null;
    let platformError = null;
    let usageError = null;

    const socketReadyState = resolveSocketReadyState(activeSocket);
    const botJid = resolveActiveSocketBotJid(activeSocket) || null;
    const botPhone = String(resolveCatalogBotPhone() || '').replace(/\D+/g, '') || null;
    const botConnected = socketReadyState === 1 || (socketReadyState === null && Boolean(botJid));
    const botConnectionStatus = botConnected ? 'online' : socketReadyState === 0 ? 'connecting' : 'offline';

    let platform = {
      total_users: null,
      total_groups: null,
      total_chats: null,
    };
    let usage = {
      total_messages: null,
      total_commands: null,
      total_commands_source: tables.MESSAGE_ANALYSIS_EVENT,
    };

    try {
      prometheus = await fetchPrometheusSummary();
    } catch (error) {
      prometheusError = error?.message || 'Falha ao consultar /metrics';
    }

    try {
      const [chatTotalsRows, groupsMetadataTotalsRows, lidMapTotalsRows] = await Promise.all([
        executeQuery(
          `SELECT
             COUNT(*) AS total_chats,
             SUM(CASE WHEN id LIKE '%@g.us' THEN 1 ELSE 0 END) AS total_groups
           FROM ${tables.CHATS}`,
        ),
        executeQuery(`SELECT COUNT(*) AS total_groups FROM ${tables.GROUPS_METADATA}`),
        executeQuery(`SELECT COUNT(*) AS total_users FROM ${tables.LID_MAP}`),
      ]);

      const chatsTotals = chatTotalsRows?.[0] || {};
      const groupsMetadataTotals = groupsMetadataTotalsRows?.[0] || {};
      const lidMapTotals = lidMapTotalsRows?.[0] || {};
      const totalGroupsFromChats = Number(chatsTotals?.total_groups || 0);
      const totalGroupsFromMetadata = Number(groupsMetadataTotals?.total_groups || 0);
      const totalUsersFromLidMap = Number(lidMapTotals?.total_users || 0);

      platform = {
        total_users: totalUsersFromLidMap,
        total_users_source: 'lid_map',
        total_groups: Math.max(totalGroupsFromChats, totalGroupsFromMetadata),
        total_chats: Number(chatsTotals?.total_chats || 0),
      };
    } catch (error) {
      platformError = error?.message || 'Falha ao consultar totais de usuários/grupos';
    }

    try {
      const [messageTotalsRows, commandTotalsRows] = await Promise.all([
        executeQuery(`SELECT COUNT(*) AS total_messages FROM ${tables.MESSAGES}`),
        executeQuery(
          `SELECT COUNT(*) AS total_commands
             FROM ${tables.MESSAGE_ANALYSIS_EVENT}
            WHERE is_command = 1
              AND COALESCE(is_from_bot, 0) = 0`,
        ),
      ]);
      const messageTotals = messageTotalsRows?.[0] || {};
      const commandTotals = commandTotalsRows?.[0] || {};
      usage = {
        ...usage,
        total_messages: Number(messageTotals?.total_messages || 0),
        total_commands: Number(commandTotals?.total_commands || 0),
      };
    } catch (error) {
      usageError = error?.message || 'Falha ao consultar totais de mensagens/comandos';
    }

    const hostCpuPercent = Number(system.usoCpuPercentual);
    const hostMemoryPercent = Number(system.usoMemoriaPercentual);
    const statusReasons = [];
    if (!botConnected) statusReasons.push('bot_disconnected');
    if (!prometheus) statusReasons.push('metrics_unavailable');
    if (Number.isFinite(hostCpuPercent) && hostCpuPercent >= 90) statusReasons.push('host_cpu_high');
    if (Number.isFinite(hostMemoryPercent) && hostMemoryPercent >= 90) statusReasons.push('host_memory_high');
    const systemStatus = statusReasons.length ? 'degraded' : 'online';

    return {
      data: {
        system_status: systemStatus,
        status_reasons: statusReasons,
        bot: {
          connected: botConnected,
          connection_status: botConnectionStatus,
          jid: botJid,
          phone: botPhone,
          ready_state: socketReadyState,
        },
        platform,
        usage,
        host: {
          cpu_percent: system.usoCpuPercentual,
          memory_percent: system.usoMemoriaPercentual,
          memory_used: system.memoriaUsada,
          memory_total: system.memoriaTotal,
          uptime: system.uptimeSistema,
        },
        process: {
          uptime: prometheus?.process_uptime || system.uptime,
          node_version: system.versaoNode,
        },
        observability: {
          lag_p99_ms: prometheus?.lag_p99_ms ?? null,
          db_total: prometheus?.db_total ?? null,
          db_slow: prometheus?.db_slow ?? null,
          http_5xx_total: prometheus?.http_5xx_total ?? null,
          http_latency_p95_ms: prometheus?.http_latency_p95_ms ?? null,
          queue_peak: prometheus?.queue_peak ?? null,
        },
        updated_at: __timeNowIso(),
      },
      meta: {
        metrics_endpoint: metricsEndpoint,
        metrics_ok: Boolean(prometheus),
        metrics_error: prometheusError,
        platform_error: platformError,
        usage_error: usageError,
      },
    };
  };

  const getSystemSummaryCached = async () => {
    const now = __timeNowMs();
    const hasValue = Boolean(systemSummaryCache.value);

    if (hasValue && now < systemSummaryCache.expiresAt) {
      return systemSummaryCache.value;
    }

    if (!systemSummaryCache.pending) {
      systemSummaryCache.pending = withTimeout(buildSystemSummarySnapshot(), 5000)
        .then((payload) => {
          systemSummaryCache.value = payload;
          systemSummaryCache.expiresAt = __timeNowMs() + systemSummaryCacheSeconds * 1000;
          return payload;
        })
        .finally(() => {
          systemSummaryCache.pending = null;
        });
    }

    if (hasValue) return systemSummaryCache.value;
    return systemSummaryCache.pending;
  };

  const parseMessageTypeFromRaw = (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage || '{}')?.message || {};
      if (message.conversation || message.extendedTextMessage) return 'texto';
      if (message.imageMessage) return 'imagem';
      if (message.videoMessage) return 'video';
      if (message.audioMessage) return 'audio';
      if (message.stickerMessage) return 'figurinha';
      if (message.documentMessage) return 'documento';
      if (message.locationMessage) return 'localizacao';
      if (message.reactionMessage) return 'reacao';
      return 'outros';
    } catch {
      return 'outros';
    }
  };

  const formatPtBrInteger = (value) => Number(value || 0).toLocaleString('pt-BR');

  const extractCommandsFromMenuLine = (line, commandPrefix) => {
    const normalizedLine = String(line || '').trim();
    if (!normalizedLine.startsWith('→')) return [];

    const commandParts = normalizedLine
      .replace(/^→\s*/, '')
      .split('|')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(commandPrefix));

    return commandParts
      .map((part) => {
        const normalized = part.replace(/\s{2,}.*/, '').trim();
        const withoutPrefix = normalized.slice(commandPrefix.length).trim();
        if (!withoutPrefix) return '';

        const tokens = withoutPrefix.split(/\s+/).filter(Boolean);
        const selectedTokens = [];
        for (const token of tokens) {
          if (!/^[a-z0-9_-]+$/i.test(token)) break;
          selectedTokens.push(token);
        }
        if (!selectedTokens.length) return '';
        return `${commandPrefix}${selectedTokens.join(' ')}`;
      })
      .filter(Boolean);
  };

  const collectAvailableMenuCommands = (commandPrefix = readmeCommandPrefix) => {
    const sections = [buildMenuCaption('OmniZap', commandPrefix), buildStickerMenu(commandPrefix), buildMediaMenu(commandPrefix), buildQuoteMenu(commandPrefix), buildAnimeMenu(commandPrefix), buildAiMenu(commandPrefix), buildStatsMenu(commandPrefix), buildAdminMenu(commandPrefix)];

    const commands = new Set();
    for (const section of sections) {
      for (const line of String(section || '').split('\n')) {
        const extracted = extractCommandsFromMenuLine(line, commandPrefix);
        for (const command of extracted) {
          commands.add(command);
        }
      }
    }

    return Array.from(commands).sort((left, right) => left.localeCompare(right, 'pt-BR'));
  };

  const renderReadmeSnapshotMarkdown = ({ generatedAt, totals, topMessageTypes, commands }) => {
    const typeRows = topMessageTypes.length ? topMessageTypes.map((entry) => `| \`${entry.type}\` | ${formatPtBrInteger(entry.total)} |`) : ['| `outros` | 0 |'];

    const commandInline = commands.length ? commands.map((command) => `\`${command}\``).join(' · ') : 'Nenhum comando identificado no menu atual.';

    return ['### Snapshot do Sistema', '', `> Atualizado em \`${generatedAt}\` | cache \`${readmeSummaryCacheSeconds}s\``, '', '| Métrica | Valor |', '| --- | ---: |', `| Usuários (lid_map) | ${formatPtBrInteger(totals.total_users)} |`, `| Grupos | ${formatPtBrInteger(totals.total_groups)} |`, `| Packs | ${formatPtBrInteger(totals.total_packs)} |`, `| Stickers | ${formatPtBrInteger(totals.total_stickers)} |`, `| Mensagens registradas | ${formatPtBrInteger(totals.total_messages)} |`, '', `#### Tipos de mensagem mais usados (amostra: ${formatPtBrInteger(totals.message_types_sample_size)})`, '| Tipo | Total |', '| --- | ---: |', ...typeRows, '', `<details><summary>Comandos disponíveis (${formatPtBrInteger(commands.length)})</summary>`, '', commandInline, '', '</details>', ''].join('\n');
  };

  const buildReadmeSummarySnapshot = async () => {
    const [lidMapTotalsRows, chatsTotalsRows, groupsMetadataTotalsRows, packTotalsRows, stickerTotalsRows, messageTotalsRows, messageTypeRows] = await Promise.all([
      executeQuery(`SELECT COUNT(*) AS total_users FROM ${tables.LID_MAP}`),
      executeQuery(
        `SELECT
           COUNT(*) AS total_chats,
           SUM(CASE WHEN id LIKE '%@g.us' THEN 1 ELSE 0 END) AS total_groups
         FROM ${tables.CHATS}`,
      ),
      executeQuery(`SELECT COUNT(*) AS total_groups FROM ${tables.GROUPS_METADATA}`),
      executeQuery(`SELECT COUNT(*) AS total_packs FROM ${tables.STICKER_PACK} WHERE deleted_at IS NULL`),
      executeQuery(`SELECT COUNT(*) AS total_stickers FROM ${tables.STICKER_ASSET}`),
      executeQuery(`SELECT COUNT(*) AS total_messages FROM ${tables.MESSAGES}`),
      executeQuery(
        `SELECT raw_message
         FROM ${tables.MESSAGES}
         WHERE raw_message IS NOT NULL
         ORDER BY id DESC
         LIMIT ${readmeMessageTypeSampleLimit}`,
      ),
    ]);

    const lidMapTotals = lidMapTotalsRows?.[0] || {};
    const chatsTotals = chatsTotalsRows?.[0] || {};
    const groupsMetadataTotals = groupsMetadataTotalsRows?.[0] || {};
    const packTotals = packTotalsRows?.[0] || {};
    const stickerTotals = stickerTotalsRows?.[0] || {};
    const messageTotals = messageTotalsRows?.[0] || {};

    const totalGroupsFromChats = Number(chatsTotals?.total_groups || 0);
    const totalGroupsFromMetadata = Number(groupsMetadataTotals?.total_groups || 0);
    const totalGroups = Math.max(totalGroupsFromChats, totalGroupsFromMetadata);
    const totalMessages = Number(messageTotals?.total_messages || 0);

    const typeCounts = new Map();
    const sampledMessages = Array.isArray(messageTypeRows) ? messageTypeRows.length : 0;
    for (const row of messageTypeRows || []) {
      const type = parseMessageTypeFromRaw(row?.raw_message);
      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    }
    const topMessageTypes = Array.from(typeCounts.entries())
      .map(([type, total]) => ({ type, total: Number(total || 0) }))
      .sort((left, right) => Number(right.total || 0) - Number(left.total || 0))
      .slice(0, 8);

    const commands = collectAvailableMenuCommands(readmeCommandPrefix);
    const generatedAt = __timeNowIso();

    const totals = {
      total_users: Number(lidMapTotals?.total_users || 0),
      total_groups: totalGroups,
      total_groups_from_chats: totalGroupsFromChats,
      total_groups_from_metadata: totalGroupsFromMetadata,
      total_chats: Number(chatsTotals?.total_chats || 0),
      total_packs: Number(packTotals?.total_packs || 0),
      total_stickers: Number(stickerTotals?.total_stickers || 0),
      total_messages: totalMessages,
      message_types_sample_size: sampledMessages,
      message_types_total_coverage_percent: totalMessages > 0 ? Number(((sampledMessages / totalMessages) * 100).toFixed(2)) : 0,
    };

    const markdown = renderReadmeSnapshotMarkdown({
      generatedAt,
      totals,
      topMessageTypes,
      commands,
    });

    return {
      data: {
        generated_at: generatedAt,
        cache_seconds: readmeSummaryCacheSeconds,
        command_prefix: readmeCommandPrefix,
        totals,
        top_message_types: topMessageTypes,
        commands,
        markdown,
      },
    };
  };

  const getReadmeSummaryCached = async () => {
    const now = __timeNowMs();
    const hasValue = Boolean(readmeSummaryCache.value);

    if (hasValue && now < readmeSummaryCache.expiresAt) {
      return readmeSummaryCache.value;
    }

    if (!readmeSummaryCache.pending) {
      readmeSummaryCache.pending = withTimeout(buildReadmeSummarySnapshot(), 7000)
        .then((payload) => {
          readmeSummaryCache.value = payload;
          readmeSummaryCache.expiresAt = __timeNowMs() + readmeSummaryCacheSeconds * 1000;
          return payload;
        })
        .finally(() => {
          readmeSummaryCache.pending = null;
        });
    }

    if (hasValue) return readmeSummaryCache.value;
    return readmeSummaryCache.pending;
  };

  const resolveBotUserCandidates = (activeSocket) => {
    const candidates = new Set();
    const botJidFromSocket = resolveActiveSocketBotJid(activeSocket);
    const botUserFromSocket = getJidUser(botJidFromSocket || '');
    if (botUserFromSocket) candidates.add(String(botUserFromSocket).trim());
    const botPhoneFromCatalog = String(resolveCatalogBotPhone() || '').replace(/\D+/g, '');
    if (botPhoneFromCatalog) candidates.add(botPhoneFromCatalog);

    const envCandidates = [process.env.WHATSAPP_BOT_NUMBER, process.env.BOT_NUMBER, process.env.PHONE_NUMBER, process.env.BOT_PHONE_NUMBER];

    for (const candidate of envCandidates) {
      const digits = String(candidate || '').replace(/\D+/g, '');
      if (digits) candidates.add(digits);
    }

    return Array.from(candidates).filter((value) => value.length >= 8);
  };

  const isSenderFromAnyBotUser = (senderId, botUsers) => {
    const normalizedSender = String(senderId || '').trim();
    if (!normalizedSender) return false;
    return botUsers.some((botUser) => {
      const safe = String(botUser || '').trim();
      if (!safe) return false;
      return normalizedSender === `${safe}@s.whatsapp.net` || normalizedSender.startsWith(`${safe}:`) || normalizedSender.startsWith(`${safe}@`);
    });
  };

  const sanitizeRankingPayloadByBot = (payload, botUsers) => {
    const sourceRows = Array.isArray(payload?.rows) ? payload.rows : [];
    const filteredRows = sourceRows.filter((row) => !isSenderFromAnyBotUser(row?.sender_id, botUsers));
    const normalizedRows = filteredRows.slice(0, Number(payload?.limit || 5)).map((row, index) => ({
      ...row,
      position: index + 1,
    }));
    const totalMessages = Number(payload?.total_messages || 0);
    const topTotal = normalizedRows.reduce((acc, row) => acc + Number(row?.total_messages || 0), 0);
    const topShare = totalMessages > 0 ? Number(((topTotal / totalMessages) * 100).toFixed(2)) : 0;

    return {
      ...payload,
      rows: normalizedRows,
      top_share_percent: topShare,
    };
  };

  const extractPushNameFromRaw = (rawMessage) => {
    try {
      const parsed = JSON.parse(rawMessage || '{}');
      const direct = String(parsed?.pushName || '').trim();
      if (direct) return direct;

      const nested = String(parsed?.message?.extendedTextMessage?.contextInfo?.participantName || '').trim();
      if (nested) return nested;
    } catch {
      return '';
    }
    return '';
  };

  const resolveRankingDisplayName = async (senderId) => {
    if (!senderId) return 'Desconhecido';
    const fallback = `@${String(getJidUser(senderId) || senderId).trim()}`;
    try {
      const rows = await executeQuery(
        `SELECT raw_message FROM ${tables.MESSAGES}
         WHERE sender_id = ?
           AND raw_message IS NOT NULL
         ORDER BY id DESC
         LIMIT 12`,
        [senderId],
      );
      for (const row of rows) {
        const name = extractPushNameFromRaw(row?.raw_message);
        if (name) return name;
      }
    } catch {
      return fallback;
    }
    return fallback;
  };

  const resolveRankingAvatarUrl = async (senderId) => {
    if (!senderId) return null;
    const normalized = normalizeJid(senderId) || senderId;
    try {
      return await profilePictureUrlFromActiveSocket(normalized, 'image');
    } catch {
      return null;
    }
  };

  const buildGlobalRankingSummary = async () => {
    const limit = 5;
    const queryLimit = 12;
    const sampleLimit = 50000;
    const activeSocket = getActiveSocket();
    const botUsers = resolveBotUserCandidates(activeSocket);

    const whereClauses = ['sender_id IS NOT NULL'];
    const params = [];
    for (const botUser of botUsers) {
      whereClauses.push('sender_id <> ?');
      params.push(`${botUser}@s.whatsapp.net`);
      whereClauses.push('sender_id NOT LIKE ?');
      whereClauses.push('sender_id NOT LIKE ?');
      params.push(`${botUser}@%`, `${botUser}:%`);
    }

    const where = whereClauses.join(' AND ');
    const recentScopeSql = `SELECT id, sender_id, timestamp, raw_message FROM ${tables.MESSAGES} WHERE ${where} ORDER BY id DESC LIMIT ${sampleLimit}`;

    const [totalRow] = await executeQuery(`SELECT COUNT(*) AS total FROM (${recentScopeSql}) recent_scope`, params);
    const totalMessages = Number(totalRow?.total || 0);

    const rows = await executeQuery(
      `SELECT
        recent_scope.sender_id,
        CONCAT('@', SUBSTRING_INDEX(recent_scope.sender_id, '@', 1)) AS display_name,
        COUNT(*) AS total_messages,
        MAX(
          CASE
            WHEN recent_scope.timestamp > 1000000000000 THEN FROM_UNIXTIME(recent_scope.timestamp / 1000)
            WHEN recent_scope.timestamp > 1000000000 THEN FROM_UNIXTIME(recent_scope.timestamp)
            ELSE recent_scope.timestamp
          END
        ) AS last_message
      FROM (${recentScopeSql}) recent_scope
      GROUP BY recent_scope.sender_id
      ORDER BY total_messages DESC
      LIMIT ${queryLimit}`,
      params,
    );

    const typeRows = await executeQuery(
      `SELECT recent_scope.raw_message
       FROM (${recentScopeSql}) recent_scope
       WHERE recent_scope.raw_message IS NOT NULL
       ORDER BY recent_scope.id DESC
       LIMIT 300`,
      params,
    );

    const typeCounts = new Map();
    for (const row of typeRows) {
      const type = parseMessageTypeFromRaw(row?.raw_message);
      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    }
    const sortedTypes = Array.from(typeCounts.entries()).sort((left, right) => right[1] - left[1]);
    const topType = sortedTypes[0]?.[0] || null;
    const topTypeCount = Number(sortedTypes[0]?.[1] || 0);

    const topTotal = rows.reduce((acc, row) => acc + Number(row?.total_messages || 0), 0);
    const topShare = totalMessages > 0 ? Number(((topTotal / totalMessages) * 100).toFixed(2)) : 0;

    const rowsWithoutBot = rows.filter((row) => !isSenderFromAnyBotUser(row?.sender_id, botUsers)).slice(0, limit);

    const rowsEnriched = await Promise.all(
      rowsWithoutBot.map(async (row, index) => {
        const total = Number(row?.total_messages || 0);
        const percent = totalMessages > 0 ? Number(((total / totalMessages) * 100).toFixed(2)) : 0;
        const senderId = row?.sender_id || null;
        const displayName = await resolveRankingDisplayName(senderId);
        const avatarUrl = await resolveRankingAvatarUrl(senderId);
        return {
          position: index + 1,
          sender_id: senderId,
          mention_id: senderId,
          display_name: displayName || row?.display_name || senderId || 'Desconhecido',
          avatar_url: avatarUrl,
          total_messages: total,
          percent_of_total: percent,
          last_message: row?.last_message ? new Date(row.last_message).toISOString() : null,
        };
      }),
    );

    return {
      limit,
      sample_limit: sampleLimit,
      total_messages: totalMessages,
      top_share_percent: topShare,
      top_type: topType,
      top_type_count: topTypeCount,
      rows: rowsEnriched,
      updated_at: __timeNowIso(),
    };
  };

  const getGlobalRankingSummaryCached = async () => {
    const now = __timeNowMs();
    const hasValue = Boolean(globalRankCache.value);

    if (hasValue && now < globalRankCache.expiresAt) {
      return globalRankCache.value;
    }

    if (!globalRankCache.pending) {
      globalRankCache.pending = withTimeout(buildGlobalRankingSummary(), 5000)
        .then((data) => {
          globalRankCache.value = data;
          globalRankCache.expiresAt = __timeNowMs() + globalRankRefreshSeconds * 1000;
          return data;
        })
        .finally(() => {
          globalRankCache.pending = null;
        });
    }

    if (hasValue) {
      return globalRankCache.value;
    }

    return globalRankCache.pending;
  };

  const scheduleGlobalRankingPreload = () => {
    if (globalRankRefreshTimer) return;

    getGlobalRankingSummaryCached().catch((error) => {
      logger.warn('Falha no preload inicial do ranking global.', {
        action: 'global_ranking_preload_init_error',
        error: error?.message,
      });
    });

    globalRankRefreshTimer = setInterval(() => {
      globalRankCache.expiresAt = 0;
      getGlobalRankingSummaryCached().catch((error) => {
        logger.warn('Falha ao atualizar cache do ranking global em background.', {
          action: 'global_ranking_preload_refresh_error',
          error: error?.message,
        });
      });
    }, globalRankRefreshSeconds * 1000);

    if (typeof globalRankRefreshTimer?.unref === 'function') {
      globalRankRefreshTimer.unref();
    }
  };

  const buildLastSevenUtcDateKeys = () => {
    const now = __timeNow();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Array.from({ length: 7 }).map((_, index) => {
      const date = new Date(todayUtc - (6 - index) * 24 * 60 * 60 * 1000);
      return date.toISOString().slice(0, 10);
    });
  };

  const toUtcDayKey = (value) => {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const text = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
  };

  const mapRowsByDayKey = (rows, valueField = 'total') => {
    const map = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const dayKey = toUtcDayKey(row?.day_key);
      if (!dayKey) return;
      map.set(dayKey, Number(row?.[valueField] || 0));
    });
    return map;
  };

  const buildMarketplaceGlobalStatsSnapshot = async () => {
    const visiblePublishedVisibility = ['public', 'unlisted'];
    const placeholders = visiblePublishedVisibility.map(() => '?').join(', ');
    const dayKeys = buildLastSevenUtcDateKeys();
    const dayFilterSql = `UTC_DATE() - INTERVAL 6 DAY`;

    const [packTotalsRows, stickerTotalsRows, stickersWithoutPackRows, engagementTotalsRows, dailyPacksRows, dailyStickersRows, dailyInteractionRows] = await Promise.all([
      executeQuery(
        `SELECT
           COUNT(*) AS total_packs,
           COUNT(DISTINCT publisher) AS creators_total,
           SUM(CASE WHEN created_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS packs_last_7_days
         FROM ${tables.STICKER_PACK}
         WHERE deleted_at IS NULL
           AND status = 'published'
           AND COALESCE(pack_status, 'ready') = 'ready'
           AND visibility IN (${placeholders})`,
        visiblePublishedVisibility,
      ),
      executeQuery(`SELECT COUNT(*) AS total_stickers FROM ${tables.STICKER_ASSET}`),
      executeQuery(
        `SELECT COUNT(*) AS stickers_without_pack
         FROM ${tables.STICKER_ASSET} a
         LEFT JOIN ${tables.STICKER_PACK_ITEM} i ON i.sticker_id = a.id
         WHERE i.sticker_id IS NULL`,
      ),
      executeQuery(
        `SELECT
           COALESCE(SUM(e.open_count), 0) AS total_clicks,
           COALESCE(SUM(e.like_count), 0) AS total_likes
         FROM ${tables.STICKER_PACK_ENGAGEMENT} e
         INNER JOIN ${tables.STICKER_PACK} p ON p.id = e.pack_id
         WHERE p.deleted_at IS NULL
           AND p.status = 'published'
           AND COALESCE(p.pack_status, 'ready') = 'ready'
           AND p.visibility IN (${placeholders})`,
        visiblePublishedVisibility,
      ),
      executeQuery(
        `SELECT DATE(created_at) AS day_key, COUNT(*) AS total
         FROM ${tables.STICKER_PACK}
         WHERE deleted_at IS NULL
           AND status = 'published'
           AND COALESCE(pack_status, 'ready') = 'ready'
           AND visibility IN (${placeholders})
           AND created_at >= (${dayFilterSql})
         GROUP BY DATE(created_at)`,
        visiblePublishedVisibility,
      ),
      executeQuery(
        `SELECT DATE(created_at) AS day_key, COUNT(*) AS total
         FROM ${tables.STICKER_ASSET}
         WHERE created_at >= (${dayFilterSql})
         GROUP BY DATE(created_at)`,
      ),
      executeQuery(
        `SELECT DATE(ev.created_at) AS day_key, ev.interaction, COUNT(*) AS total
         FROM ${tables.STICKER_PACK_INTERACTION_EVENT} ev
         INNER JOIN ${tables.STICKER_PACK} p ON p.id = ev.pack_id
         WHERE ev.created_at >= (${dayFilterSql})
           AND ev.interaction IN ('open', 'like')
           AND p.deleted_at IS NULL
           AND p.status = 'published'
           AND COALESCE(p.pack_status, 'ready') = 'ready'
           AND p.visibility IN (${placeholders})
         GROUP BY DATE(ev.created_at), ev.interaction`,
        visiblePublishedVisibility,
      ),
    ]);

    const packTotals = packTotalsRows?.[0] || {};
    const stickerTotals = stickerTotalsRows?.[0] || {};
    const stickersWithoutPack = stickersWithoutPackRows?.[0] || {};
    const engagementTotals = engagementTotalsRows?.[0] || {};

    const dailyPacksByDay = mapRowsByDayKey(dailyPacksRows, 'total');
    const dailyStickersByDay = mapRowsByDayKey(dailyStickersRows, 'total');
    const dailyOpensByDay = new Map();
    const dailyLikesByDay = new Map();
    (Array.isArray(dailyInteractionRows) ? dailyInteractionRows : []).forEach((row) => {
      const dayKey = toUtcDayKey(row?.day_key);
      const interaction = String(row?.interaction || '')
        .trim()
        .toLowerCase();
      const total = Number(row?.total || 0);
      if (!dayKey) return;
      if (interaction === 'open') dailyOpensByDay.set(dayKey, total);
      if (interaction === 'like') dailyLikesByDay.set(dayKey, total);
    });

    const seriesLast7Days = dayKeys.map((day) => ({
      date: day,
      packs_published: Number(dailyPacksByDay.get(day) || 0),
      stickers_created: Number(dailyStickersByDay.get(day) || 0),
      clicks: Number(dailyOpensByDay.get(day) || 0),
      likes: Number(dailyLikesByDay.get(day) || 0),
    }));

    const likesLast7Days = seriesLast7Days.reduce((acc, row) => acc + Number(row.likes || 0), 0);
    const clicksLast7Days = seriesLast7Days.reduce((acc, row) => acc + Number(row.clicks || 0), 0);

    return {
      total_packs: Number(packTotals?.total_packs || 0),
      total_stickers: Number(stickerTotals?.total_stickers || 0),
      total_clicks: Number(engagementTotals?.total_clicks || 0),
      total_likes: Number(engagementTotals?.total_likes || 0),
      packs_last_7_days: Number(packTotals?.packs_last_7_days || 0),
      stickers_without_pack: Number(stickersWithoutPack?.stickers_without_pack || 0),
      creators_total: Number(packTotals?.creators_total || 0),
      clicks_last_7_days: Number(clicksLast7Days || 0),
      likes_last_7_days: Number(likesLast7Days || 0),
      series_last_7_days: seriesLast7Days,
      updated_at: __timeNowIso(),
    };
  };

  const getMarketplaceGlobalStatsCached = async () => {
    const now = __timeNowMs();
    const hasValue = Boolean(marketplaceGlobalStatsCache.value);
    if (hasValue && now < marketplaceGlobalStatsCache.expiresAt) {
      return marketplaceGlobalStatsCache.value;
    }

    if (!marketplaceGlobalStatsCache.pending) {
      marketplaceGlobalStatsCache.pending = withTimeout(buildMarketplaceGlobalStatsSnapshot(), 5000)
        .then((data) => {
          marketplaceGlobalStatsCache.value = data;
          marketplaceGlobalStatsCache.expiresAt = __timeNowMs() + marketplaceGlobalStatsCacheSeconds * 1000;
          return data;
        })
        .finally(() => {
          marketplaceGlobalStatsCache.pending = null;
        });
    }

    if (hasValue) return marketplaceGlobalStatsCache.value;
    return marketplaceGlobalStatsCache.pending;
  };

  return {
    withTimeout,
    getSystemSummaryCached,
    getReadmeSummaryCached,
    resolveBotUserCandidates,
    sanitizeRankingPayloadByBot,
    getGlobalRankingSummaryCached,
    scheduleGlobalRankingPreload,
    getMarketplaceGlobalStatsCached,
  };
};
