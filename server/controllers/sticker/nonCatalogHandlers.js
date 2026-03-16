import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { withTimeout } from '../../http/httpRequestUtils.js';

export const createStickerCatalogNonCatalogHandlers = ({ sendJson, sendText, logger, getSystemSummaryCached, systemSummaryCache, systemSummaryCacheSeconds, getReadmeSummaryCached, readmeSummaryCache, readmeSummaryCacheSeconds, getGlobalRankingSummaryCached, globalRankRefreshSeconds, globalRankCache, sanitizeRankingPayloadByBot, getActiveSocket, resolveBotUserCandidates, getMarketplaceGlobalStatsCached, marketplaceGlobalStatsCacheSeconds, marketplaceGlobalStatsCache, githubRepoInfo, githubProjectCacheSeconds, fetchGitHubProjectSummary, buildSupportInfo, buildBotContactInfo, getMarketplaceStatsCached, resolveGoogleWebSessionFromRequest, mapGoogleSessionResponseData, isAuthenticatedGoogleSession, stickerWebGoogleClientId, homeBootstrapExposeContact, trackWebVisitMetric, resolveVisitPathFromReferrer, normalizeCatalogVisibility }) => {
  const buildHomeRealtimeSnapshot = async ({ systemSummary = null } = {}) => {
    const totalUsersRaw = Number(systemSummary?.platform?.total_users);
    const totalMessagesRaw = Number(systemSummary?.usage?.total_messages);
    const totalCommandsRaw = Number(systemSummary?.usage?.total_commands);
    const httpLatencyP95Ms = Number(systemSummary?.observability?.http_latency_p95_ms);
    const lagP99Ms = Number(systemSummary?.observability?.lag_p99_ms);
    const resolvedLatencyMs = Number.isFinite(httpLatencyP95Ms) && httpLatencyP95Ms > 0 ? httpLatencyP95Ms : Number.isFinite(lagP99Ms) && lagP99Ms > 0 ? lagP99Ms : null;

    const totalUsers = Number.isFinite(totalUsersRaw) ? Math.max(0, Math.round(totalUsersRaw)) : null;
    const totalMessages = Number.isFinite(totalMessagesRaw) ? Math.max(0, Math.round(totalMessagesRaw)) : null;
    const totalCommands = Number.isFinite(totalCommandsRaw) ? Math.max(0, Math.round(totalCommandsRaw)) : null;
    const systemLatencyMs = Number.isFinite(resolvedLatencyMs) && resolvedLatencyMs > 0 ? Number(resolvedLatencyMs.toFixed(2)) : null;

    const payload = {
      total_users: totalUsers,
      total_messages: totalMessages,
      total_commands: totalCommands,
      updated_at: __timeNowIso(),
    };

    if (systemLatencyMs !== null) {
      payload.system_latency_ms = systemLatencyMs;
    }

    return payload;
  };

  const handleHomeBootstrapRequest = async (req, res, url) => {
    const visibility = normalizeCatalogVisibility(url?.searchParams?.get('visibility'));
    const fetchTimeoutMs = {
      support: 450,
      bot_contact: 320,
      session: 450,
      stats: 700,
      system_summary: 700,
      home_realtime: 700,
    };
    const errors = [];

    const visitPath = resolveVisitPathFromReferrer(req);
    void trackWebVisitMetric(req, res, { pagePath: visitPath, source: 'home_bootstrap' }).catch((error) => {
      logger.warn('Falha ao registrar visita da home bootstrap.', {
        action: 'web_visit_track_home_bootstrap_failed',
        error: error?.message,
        page_path: visitPath,
      });
    });

    const [supportResult, botContactResult, sessionResult, statsResult, systemSummaryResult] = await Promise.allSettled([withTimeout(buildSupportInfo(), fetchTimeoutMs.support), withTimeout(Promise.resolve(buildBotContactInfo()), fetchTimeoutMs.bot_contact), stickerWebGoogleClientId ? withTimeout(resolveGoogleWebSessionFromRequest(req), fetchTimeoutMs.session) : Promise.resolve(null), withTimeout(getMarketplaceStatsCached(visibility), fetchTimeoutMs.stats), withTimeout(getSystemSummaryCached(), fetchTimeoutMs.system_summary)]);

    const session = sessionResult.status === 'fulfilled' ? sessionResult.value || null : null;
    if (sessionResult.status !== 'fulfilled') {
      errors.push({
        source: 'session',
        message: sessionResult.reason?.message || 'session_unavailable',
      });
    }
    const canExposeContactData = homeBootstrapExposeContact || isAuthenticatedGoogleSession(session);

    const support = canExposeContactData && supportResult.status === 'fulfilled' ? supportResult.value || null : null;
    if (canExposeContactData && supportResult.status !== 'fulfilled') {
      errors.push({
        source: 'support',
        message: supportResult.reason?.message || 'support_unavailable',
      });
    }

    const botContact = canExposeContactData && botContactResult.status === 'fulfilled' ? botContactResult.value || null : null;
    if (canExposeContactData && botContactResult.status !== 'fulfilled') {
      errors.push({
        source: 'bot_contact',
        message: botContactResult.reason?.message || 'bot_contact_unavailable',
      });
    }

    const statsPayload = statsResult.status === 'fulfilled' ? statsResult.value || null : null;
    if (statsResult.status !== 'fulfilled') {
      errors.push({
        source: 'stats',
        message: statsResult.reason?.message || 'stats_unavailable',
      });
    }

    const systemSummaryPayload = systemSummaryResult.status === 'fulfilled' ? systemSummaryResult.value || null : null;
    if (systemSummaryResult.status !== 'fulfilled') {
      errors.push({
        source: 'system_summary',
        message: systemSummaryResult.reason?.message || 'system_summary_unavailable',
      });
    }

    let homeRealtimePayload = null;
    try {
      homeRealtimePayload = await withTimeout(buildHomeRealtimeSnapshot({ systemSummary: systemSummaryPayload?.data || null }), fetchTimeoutMs.home_realtime);
    } catch (error) {
      errors.push({
        source: 'home_realtime',
        message: error?.message || 'home_realtime_unavailable',
      });
    }

    sendJson(req, res, 200, {
      data: {
        session: mapGoogleSessionResponseData(session),
        support,
        bot_contact: botContact,
        marketplace_stats: statsPayload,
        system_summary: systemSummaryPayload?.data || null,
        home_realtime: homeRealtimePayload,
        errors: errors.length ? errors : undefined,
      },
    });
  };

  const handleSystemSummaryRequest = async (req, res) => {
    try {
      const payload = await getSystemSummaryCached();
      sendJson(req, res, 200, {
        ...payload,
        meta: {
          ...(payload.meta || {}),
          cache_seconds: systemSummaryCacheSeconds,
        },
      });
    } catch (error) {
      logger.warn('Falha ao montar resumo do sistema.', {
        action: 'system_summary_error',
        error: error?.message,
      });
      if (systemSummaryCache.value) {
        sendJson(req, res, 200, {
          ...systemSummaryCache.value,
          meta: {
            ...(systemSummaryCache.value.meta || {}),
            cache_seconds: systemSummaryCacheSeconds,
            stale: true,
            error: error?.message || 'fallback_cache',
          },
        });
        return;
      }
      sendJson(req, res, 503, { error: 'Resumo do sistema indisponível no momento.' });
    }
  };

  const handleReadmeSummaryRequest = async (req, res) => {
    try {
      const payload = await getReadmeSummaryCached();
      sendJson(req, res, 200, payload);
    } catch (error) {
      logger.warn('Falha ao montar resumo markdown para README.', {
        action: 'readme_summary_error',
        error: error?.message,
      });
      if (readmeSummaryCache.value) {
        sendJson(req, res, 200, {
          ...readmeSummaryCache.value,
          meta: {
            stale: true,
            error: error?.message || 'fallback_cache',
          },
        });
        return;
      }
      sendJson(req, res, 503, { error: 'Resumo markdown indisponível no momento.' });
    }
  };

  const handleReadmeMarkdownRequest = async (req, res) => {
    try {
      const payload = await getReadmeSummaryCached();
      const markdown = String(payload?.data?.markdown || '').trim();
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Cache-Control', `public, max-age=${Math.min(readmeSummaryCacheSeconds, 300)}`);
      res.setHeader('X-Cache-Seconds', String(readmeSummaryCacheSeconds));
      sendText(req, res, 200, markdown ? `${markdown}\n` : '', 'text/markdown; charset=utf-8');
    } catch (error) {
      logger.warn('Falha ao renderizar markdown para README.', {
        action: 'readme_markdown_error',
        error: error?.message,
      });
      if (readmeSummaryCache.value) {
        const markdown = String(readmeSummaryCache.value?.data?.markdown || '').trim();
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Cache-Control', `public, max-age=${Math.min(readmeSummaryCacheSeconds, 300)}`);
        res.setHeader('X-Cache-Seconds', String(readmeSummaryCacheSeconds));
        sendText(req, res, 200, markdown ? `${markdown}\n` : '', 'text/markdown; charset=utf-8');
        return;
      }
      sendText(req, res, 503, 'Resumo markdown indisponivel no momento.\n', 'text/plain; charset=utf-8');
    }
  };

  const handleGlobalRankingSummaryRequest = async (req, res) => {
    const activeSocket = getActiveSocket();
    const botUsers = resolveBotUserCandidates(activeSocket);
    try {
      const rawData = await getGlobalRankingSummaryCached();
      const data = sanitizeRankingPayloadByBot(rawData, botUsers);
      sendJson(req, res, 200, { data, meta: { cache_seconds: globalRankRefreshSeconds } });
    } catch (error) {
      logger.warn('Falha ao montar resumo do ranking global.', {
        action: 'global_ranking_summary_error',
        error: error?.message,
      });
      if (globalRankCache.value) {
        sendJson(req, res, 200, {
          data: sanitizeRankingPayloadByBot(globalRankCache.value, botUsers),
          meta: {
            cache_seconds: globalRankRefreshSeconds,
            stale: true,
            error: error?.message || 'fallback_cache',
          },
        });
        return;
      }
      sendJson(req, res, 503, { error: 'Ranking global indisponível no momento.' });
    }
  };

  const handleMarketplaceGlobalStatsRequest = async (req, res) => {
    try {
      const data = await getMarketplaceGlobalStatsCached();
      sendJson(req, res, 200, {
        ...data,
        cache_seconds: marketplaceGlobalStatsCacheSeconds,
      });
    } catch (error) {
      logger.warn('Falha ao montar stats globais do marketplace.', {
        action: 'marketplace_global_stats_error',
        error: error?.message,
      });
      if (marketplaceGlobalStatsCache.value) {
        sendJson(req, res, 200, {
          ...marketplaceGlobalStatsCache.value,
          cache_seconds: marketplaceGlobalStatsCacheSeconds,
          stale: true,
        });
        return;
      }
      sendJson(req, res, 503, { error: 'Stats globais do marketplace indisponíveis no momento.' });
    }
  };

  const handleGitHubProjectSummaryRequest = async (req, res) => {
    if (!githubRepoInfo) {
      sendJson(req, res, 500, { error: 'Configuracao de repositorio GitHub invalida.' });
      return;
    }

    try {
      const data = await fetchGitHubProjectSummary();
      sendJson(req, res, 200, {
        data,
        meta: {
          repository: githubRepoInfo.fullName,
          cache_seconds: githubProjectCacheSeconds,
        },
      });
    } catch (error) {
      logger.warn('Falha ao consultar resumo do repositorio no GitHub.', {
        action: 'github_project_summary_error',
        repository: githubRepoInfo.fullName,
        error: error?.message,
        status_code: error?.statusCode || null,
      });
      sendJson(req, res, 502, { error: 'Falha ao consultar dados do projeto no GitHub.' });
    }
  };

  const handleSupportInfoRequest = async (req, res) => {
    const data = await buildSupportInfo();
    if (!data) {
      sendJson(req, res, 404, { error: 'Contato de suporte indisponível.' });
      return;
    }
    sendJson(req, res, 200, { data });
  };

  const handleBotContactInfoRequest = async (req, res) => {
    const data = buildBotContactInfo();
    if (!data) {
      sendJson(req, res, 404, { error: 'Contato do bot indisponivel no momento.' });
      return;
    }
    sendJson(req, res, 200, { data });
  };

  return {
    handleHomeBootstrapRequest,
    handleSystemSummaryRequest,
    handleReadmeSummaryRequest,
    handleReadmeMarkdownRequest,
    handleGlobalRankingSummaryRequest,
    handleMarketplaceGlobalStatsRequest,
    handleGitHubProjectSummaryRequest,
    handleSupportInfoRequest,
    handleBotContactInfoRequest,
  };
};
