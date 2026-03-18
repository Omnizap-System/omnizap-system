import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);

const DEFAULT_API_BASE_PATH = '/api';
const DEFAULT_LOGIN_PATH = '/login';
const DEFAULT_STICKERS_PATH = '/stickers';
const FALLBACK_AVATAR = 'https://iili.io/FC3FABe.jpg';
const COMPACT_MODE_STORAGE_KEY = 'omnizap_admin_compact_mode_v1';

const NAV_ITEMS = Object.freeze([
  { id: 'overview', label: 'Dashboard', kbd: '1' },
  { id: 'moderacao', label: 'Moderação', kbd: '2' },
  { id: 'usuarios', label: 'Usuários', kbd: '3' },
  { id: 'sessoes', label: 'Sessões', kbd: '4' },
  { id: 'saude', label: 'Saúde', kbd: '5' },
  { id: 'auditoria', label: 'Auditoria', kbd: '6' },
  { id: 'alertas', label: 'Alertas', kbd: '7' },
  { id: 'exportacao', label: 'Exportação', kbd: '8' },
  { id: 'configuracoes', label: 'Configurações', kbd: '9' },
]);

const CRITICAL_OPS = new Set(['restart_worker', 'clear_cache']);

const normalizeString = (value) => String(value || '').trim();
const normalizeDigits = (value) => String(value || '').replace(/\D+/g, '');

const normalizeBasePath = (value, fallback) => {
  const raw = normalizeString(value);
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (/^\/\//.test(raw)) return fallback;
  return raw;
};

const normalizeSeverity = (value, fallback = 'low') => {
  const normalized = normalizeString(value).toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(normalized)) return normalized;
  if (normalized === 'error') return 'high';
  if (normalized === 'warn' || normalized === 'warning') return 'medium';
  return fallback;
};

const normalizeStatusTone = (value) => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'incident') return 'incident';
  if (normalized === 'warning') return 'warning';
  return 'online';
};

const clampInt = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

const formatNumber = (value) =>
  new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: 0,
  }).format(Math.max(0, Number(value || 0)));

const formatDateTime = (value) => {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return 'n/d';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(ms));
};

const formatPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/d';
  return `${numeric.toFixed(1)}%`;
};

const formatMilliseconds = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/d';
  return `${Math.round(numeric)} ms`;
};

const formatPhone = (digits) => {
  const value = normalizeDigits(digits);
  if (!value) return '';
  if (value.length <= 4) return value;
  return `${value.slice(0, 2)} ${value.slice(2, -4)}-${value.slice(-4)}`.trim();
};

const extractFilenameFromDisposition = (disposition, fallbackName) => {
  const raw = normalizeString(disposition);
  if (!raw) return fallbackName;
  const utf8Match = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  const filenameMatch = raw.match(/filename="?([^";]+)"?/i);
  if (filenameMatch?.[1]) return filenameMatch[1];
  return fallbackName;
};

const triggerFileDownload = (blob, filename) => {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    window.URL.revokeObjectURL(url);
  }, 350);
};

const paginate = ({ items = [], page = 1, pageSize = 6 } = {}) => {
  const safeItems = Array.isArray(items) ? items : [];
  if (!safeItems.length) {
    return {
      pageItems: [],
      page: 1,
      totalPages: 1,
      totalItems: 0,
      from: 0,
      to: 0,
    };
  }
  const safePageSize = Math.max(1, Number(pageSize || 6));
  const totalPages = Math.max(1, Math.ceil(safeItems.length / safePageSize));
  const safePage = Math.max(1, Math.min(totalPages, Math.floor(Number(page || 1) || 1)));
  const startIndex = (safePage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, safeItems.length);
  return {
    pageItems: safeItems.slice(startIndex, endIndex),
    page: safePage,
    totalPages,
    totalItems: safeItems.length,
    from: startIndex + 1,
    to: endIndex,
  };
};

const buildIdentityPayload = ({ sessionToken = '', googleSub = '', email = '', ownerJid = '' } = {}) => {
  const payload = {};
  const safeSessionToken = normalizeString(sessionToken);
  const safeGoogleSub = normalizeString(googleSub);
  const safeEmail = normalizeString(email).toLowerCase();
  const safeOwnerJid = normalizeString(ownerJid);
  if (safeSessionToken) payload.session_token = safeSessionToken;
  if (safeGoogleSub) payload.google_sub = safeGoogleSub;
  if (safeEmail) payload.email = safeEmail;
  if (safeOwnerJid) payload.owner_jid = safeOwnerJid;
  return payload;
};

const buildIdentityLabel = (identity = {}) => {
  if (identity.email) return identity.email;
  if (identity.owner_jid) return identity.owner_jid;
  if (identity.google_sub) return identity.google_sub;
  if (identity.session_token) return `${identity.session_token.slice(0, 8)}...`;
  return 'identidade';
};

const resolveGlobalStatus = ({ dashboardQuick = {}, systemHealth = {}, alerts = [] } = {}) => {
  const list = Array.isArray(alerts) ? alerts : [];
  const dbStatus = normalizeString(systemHealth?.db_status).toLowerCase();
  const cpuPercent = Number(systemHealth?.cpu_percent || 0);
  const errors5xx = Number(dashboardQuick?.errors_5xx || 0);

  const hasCritical = list.some((item) => {
    const severity = normalizeSeverity(item?.severity);
    return severity === 'critical' || severity === 'high';
  });
  const hasWarning = list.some((item) => normalizeSeverity(item?.severity) === 'medium');

  if (dbStatus === 'down' || hasCritical || errors5xx >= 30 || cpuPercent >= 92) {
    return { tone: 'incident', label: 'Incident' };
  }
  if (dbStatus === 'degraded' || hasWarning || errors5xx >= 10 || cpuPercent >= 75) {
    return { tone: 'warning', label: 'Warning' };
  }
  return { tone: 'online', label: 'Online' };
};

const createAdminApi = (apiBasePath) => {
  const authSessionPath = `${apiBasePath}/auth/google/session`;
  const botContactPath = `${apiBasePath}/bot-contact`;
  const adminSessionPath = `${apiBasePath}/admin/session`;
  const adminOverviewPath = `${apiBasePath}/admin/overview`;
  const adminSearchPath = `${apiBasePath}/admin/search`;
  const adminForceLogoutPath = `${apiBasePath}/admin/users/force-logout`;
  const adminBansPath = `${apiBasePath}/admin/bans`;
  const adminFeatureFlagsPath = `${apiBasePath}/admin/feature-flags`;
  const adminOpsPath = `${apiBasePath}/admin/ops`;
  const adminExportPath = `${apiBasePath}/admin/export`;

  const fetchJson = async (url, init = {}) => {
    const response = await fetch(url, {
      credentials: 'include',
      ...init,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(payload?.error || `Falha HTTP ${response.status}`);
      error.statusCode = response.status;
      error.code = payload?.code || null;
      error.details = payload?.details || null;
      throw error;
    }
    return payload || {};
  };

  const fetchRaw = async (url, init = {}) => {
    const response = await fetch(url, {
      credentials: 'include',
      ...init,
    });
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const error = new Error(payload?.error || `Falha HTTP ${response.status}`);
      error.statusCode = response.status;
      error.code = payload?.code || null;
      throw error;
    }
    return response;
  };

  return {
    getGoogleSession: () => fetchJson(authSessionPath, { method: 'GET' }),
    getBotContact: () => fetchJson(botContactPath, { method: 'GET' }),
    getAdminSession: () => fetchJson(adminSessionPath, { method: 'GET' }),
    unlockAdmin: (password) =>
      fetchJson(adminSessionPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ password: String(password || '') }),
      }),
    logoutAdmin: () => fetchJson(adminSessionPath, { method: 'DELETE' }),
    getOverview: () => fetchJson(adminOverviewPath, { method: 'GET' }),
    search: (query, limit = 12) => fetchJson(`${adminSearchPath}?${new URLSearchParams({ q: query, limit: String(limit) }).toString()}`, { method: 'GET' }),
    forceLogout: (payload) =>
      fetchJson(adminForceLogoutPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload || {}),
      }),
    createBan: (payload) =>
      fetchJson(adminBansPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload || {}),
      }),
    revokeBan: (banId) =>
      fetchJson(`${adminBansPath}/${encodeURIComponent(String(banId || '').trim())}`, {
        method: 'DELETE',
      }),
    upsertFeatureFlag: (payload) =>
      fetchJson(adminFeatureFlagsPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload || {}),
      }),
    runOp: (action) =>
      fetchJson(adminOpsPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ action: String(action || '').trim() }),
      }),
    exportDataRaw: (type, format) =>
      fetchRaw(`${adminExportPath}?${new URLSearchParams({ type, format }).toString()}`, {
        method: 'GET',
      }),
  };
};

const SeverityBadge = ({ label = '', severity = 'low' }) => html`<span className=${`admin-badge ${normalizeSeverity(severity)}`}>${label || normalizeSeverity(severity).toUpperCase()}</span>`;

const PaginationControls = ({ pagination, onPrev, onNext }) => {
  if (!pagination || pagination.totalItems <= 0) return null;
  return html`
    <div className="list-pagination">
      <p className="list-pagination-meta">Mostrando ${pagination.from}-${pagination.to} de ${pagination.totalItems}</p>
      <div className="list-pagination-controls">
        <button type="button" className="btn ghost" disabled=${pagination.page <= 1} onClick=${onPrev}>Anterior</button>
        <span className="list-pagination-counter">${pagination.page} / ${pagination.totalPages}</span>
        <button type="button" className="btn ghost" disabled=${pagination.page >= pagination.totalPages} onClick=${onNext}>Próximo</button>
      </div>
    </div>
  `;
};

const UserSystemAdmReactApp = ({ config }) => {
  const api = useMemo(() => createAdminApi(config.apiBasePath), [config.apiBasePath]);

  const [activePage, setActivePage] = useState('overview');
  const [compactMode, setCompactMode] = useState(false);
  const [envLabel, setEnvLabel] = useState('Production');

  const [googleSession, setGoogleSession] = useState(null);
  const [botPhone, setBotPhone] = useState('');

  const [adminStatusPayload, setAdminStatusPayload] = useState(null);
  const [adminOverviewPayload, setAdminOverviewPayload] = useState(null);
  const [previousAdminOverviewPayload, setPreviousAdminOverviewPayload] = useState(null);

  const [busy, setBusy] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [adminError, setAdminError] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState(null);

  const [moderationSeverityFilter, setModerationSeverityFilter] = useState('all');
  const [moderationTypeFilter, setModerationTypeFilter] = useState('all');
  const [moderationPage, setModerationPage] = useState(1);

  const [usersPage, setUsersPage] = useState(1);
  const [sessionsPage, setSessionsPage] = useState(1);

  const [auditStatusFilter, setAuditStatusFilter] = useState('all');
  const [auditSearchQuery, setAuditSearchQuery] = useState('');
  const [auditPage, setAuditPage] = useState(1);

  const [alertsPage, setAlertsPage] = useState(1);

  const [toasts, setToasts] = useState([]);

  const pushToast = useCallback(({ kind = 'success', title = 'Status', message = '' } = {}) => {
    const safeMessage = normalizeString(message);
    if (!safeMessage) return;
    const toastId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    setToasts((current) => [...current, { id: toastId, kind, title: normalizeString(title) || 'Status', message: safeMessage }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== toastId));
    }, 3800);
  }, []);

  const adminSession = adminStatusPayload?.session || null;
  const adminAuthenticated = Boolean(adminSession?.authenticated);
  const adminEligible = Boolean(adminStatusPayload?.eligible_google_login || adminAuthenticated);

  const overview = adminOverviewPayload || {};
  const previousOverview = previousAdminOverviewPayload || null;
  const counters = overview?.counters || {};
  const dashboardQuick = overview?.dashboard_quick || {};
  const systemHealth = overview?.system_health || {};
  const moderationQueue = Array.isArray(overview?.moderation_queue) ? overview.moderation_queue : [];
  const users = Array.isArray(overview?.users_sessions?.users) ? overview.users_sessions.users : [];
  const sessions = Array.isArray(overview?.users_sessions?.active_sessions) ? overview.users_sessions.active_sessions : [];
  const blockedAccounts = Array.isArray(overview?.users_sessions?.blocked_accounts) ? overview.users_sessions.blocked_accounts : [];
  const auditLog = Array.isArray(overview?.audit_log) ? overview.audit_log : [];
  const featureFlags = Array.isArray(overview?.feature_flags) ? overview.feature_flags : [];
  const alerts = Array.isArray(overview?.alerts) ? overview.alerts : [];
  const grafanaDashboards = Array.isArray(overview?.observability_links?.grafana?.dashboards) ? overview.observability_links.grafana.dashboards : [];
  const operationalShortcuts =
    Array.isArray(overview?.operational_shortcuts) && overview.operational_shortcuts.length
      ? overview.operational_shortcuts
      : [
          { action: 'restart_worker', label: 'Reiniciar worker', description: 'Destrava filas em processamento e recoloca em pending.' },
          { action: 'clear_cache', label: 'Limpar cache', description: 'Invalida caches internos de catálogo, ranking e resumo.' },
          { action: 'reprocess_jobs', label: 'Reprocessar jobs', description: 'Agenda ciclos de classificação/curadoria no worker.' },
        ];

  const globalStatus = useMemo(() => resolveGlobalStatus({ dashboardQuick, systemHealth, alerts }), [alerts, dashboardQuick, systemHealth]);

  const profileUser = adminSession?.user || adminStatusPayload?.google?.user || googleSession?.user || null;
  const profileName = normalizeString(profileUser?.name) || 'Admin';
  const profilePicture = normalizeString(profileUser?.picture) || FALLBACK_AVATAR;

  const deltaLabel = useCallback((current, previous, { percent = true, suffix = '' } = {}) => {
    const curr = Number(current);
    const prev = Number(previous);
    if (!Number.isFinite(curr) || !Number.isFinite(prev)) return 'n/d';

    const delta = curr - prev;
    const prefix = delta > 0 ? '+' : '';
    if (!percent) {
      return `${prefix}${formatNumber(delta)}${suffix}`.trim();
    }
    if (prev === 0) {
      return delta === 0 ? '0.0%' : `${prefix}100.0%`;
    }
    const ratio = (delta / Math.abs(prev)) * 100;
    return `${ratio >= 0 ? '+' : ''}${ratio.toFixed(1)}%`;
  }, []);

  const navigateToPage = useCallback((targetPage) => {
    const safePage = NAV_ITEMS.some((item) => item.id === targetPage) ? targetPage : 'overview';
    setActivePage(safePage);
    if (window.location.hash !== `#${safePage}`) {
      window.history.replaceState(null, '', `#${safePage}`);
    }
  }, []);

  useEffect(() => {
    const hash = normalizeString(window.location.hash).replace(/^#/, '');
    navigateToPage(hash || 'overview');
    const onHashChange = () => {
      const value = normalizeString(window.location.hash).replace(/^#/, '');
      navigateToPage(value || 'overview');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [navigateToPage]);

  useEffect(() => {
    const hostname = normalizeString(window.location.hostname).toLowerCase();
    const isStaging = hostname.includes('localhost') || hostname.includes('127.0.0.1') || hostname.includes('staging') || hostname.includes('dev');
    setEnvLabel(isStaging ? 'Staging' : 'Production');
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COMPACT_MODE_STORAGE_KEY);
      setCompactMode(stored === '1');
    } catch {
      setCompactMode(false);
    }
  }, []);

  useEffect(() => {
    document.body.classList.toggle('compact', compactMode);
    try {
      window.localStorage.setItem(COMPACT_MODE_STORAGE_KEY, compactMode ? '1' : '0');
    } catch {
      // noop
    }
  }, [compactMode]);

  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      setBusy(true);
      setAdminError('');
      try {
        const [googlePayload, botContactPayload, adminSessionPayload] = await Promise.all([api.getGoogleSession().catch(() => ({ data: null })), api.getBotContact().catch(() => ({ data: null })), api.getAdminSession()]);

        if (!active) return;

        setGoogleSession(googlePayload?.data || null);
        setBotPhone(normalizeDigits(botContactPayload?.data?.phone || ''));
        const statusData = adminSessionPayload?.data || null;
        setAdminStatusPayload(statusData);

        const isAuthenticated = Boolean(statusData?.session?.authenticated);
        if (!isAuthenticated) {
          setPreviousAdminOverviewPayload(null);
          setAdminOverviewPayload(null);
          return;
        }

        const overviewPayload = await api.getOverview();
        if (!active) return;
        setPreviousAdminOverviewPayload((current) => current || null);
        setAdminOverviewPayload(overviewPayload?.data || null);
      } catch (error) {
        if (!active) return;
        setAdminError(error?.message || 'Falha ao carregar painel admin.');
      } finally {
        if (active) {
          setBusy(false);
        }
      }
    };

    void bootstrap();
    return () => {
      active = false;
    };
  }, [api, reloadTick]);

  useEffect(() => {
    setModerationPage(1);
  }, [moderationSeverityFilter, moderationTypeFilter]);

  useEffect(() => {
    setAuditPage(1);
  }, [auditStatusFilter, auditSearchQuery]);

  const refreshPanel = useCallback(() => {
    setReloadTick((value) => value + 1);
  }, []);

  const handleUnlockAdmin = async (event) => {
    event.preventDefault();
    if (busy) return;

    const safePassword = normalizeString(unlockPassword);
    if (!safePassword) {
      setAdminError('Informe a senha do painel admin.');
      return;
    }

    setBusy(true);
    setAdminError('');
    try {
      await api.unlockAdmin(safePassword);
      setUnlockPassword('');
      pushToast({ kind: 'success', title: 'Admin', message: 'Área administrativa desbloqueada.' });
      refreshPanel();
    } catch (error) {
      setAdminError(error?.message || 'Falha ao desbloquear área admin.');
      pushToast({ kind: 'error', title: 'Erro', message: error?.message || 'Falha ao desbloquear área admin.' });
      setBusy(false);
    }
  };

  const handleAdminLogout = async () => {
    if (busy) return;
    if (!window.confirm('Encerrar sessão administrativa atual?')) return;

    setBusy(true);
    setAdminError('');
    try {
      await api.logoutAdmin();
      setSearchResult(null);
      pushToast({ kind: 'success', title: 'Admin', message: 'Sessão administrativa encerrada.' });
      refreshPanel();
    } catch (error) {
      setAdminError(error?.message || 'Falha ao encerrar sessão admin.');
      pushToast({ kind: 'error', title: 'Erro', message: error?.message || 'Falha ao encerrar sessão admin.' });
      setBusy(false);
    }
  };

  const handleRunOp = async (action, label) => {
    if (!action || busy) return;
    if (CRITICAL_OPS.has(action) && !window.confirm(`Executar ação crítica: ${label || action}?`)) {
      return;
    }

    setBusy(true);
    setAdminError('');
    try {
      const payload = await api.runOp(action);
      const message = normalizeString(payload?.data?.message) || `Ação ${action} executada.`;
      pushToast({ kind: 'success', title: 'Ops', message });
      refreshPanel();
    } catch (error) {
      setAdminError(error?.message || 'Falha ao executar ação operacional.');
      pushToast({ kind: 'error', title: 'Ops', message: error?.message || 'Falha ao executar ação operacional.' });
      setBusy(false);
    }
  };

  const handleSearchSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;

    const query = normalizeString(searchQuery);
    if (!query) {
      setSearchResult(null);
      return;
    }

    setBusy(true);
    setAdminError('');
    try {
      const payload = await api.search(query, 12);
      setSearchResult(payload?.data || null);
      pushToast({ kind: 'success', title: 'Busca', message: `Busca concluída para "${query}".` });
    } catch (error) {
      setAdminError(error?.message || 'Falha ao buscar dados.');
      pushToast({ kind: 'error', title: 'Busca', message: error?.message || 'Falha ao buscar dados.' });
    } finally {
      setBusy(false);
    }
  };

  const handleForceLogout = async (identity, contextLabel = '') => {
    const payload = buildIdentityPayload({
      sessionToken: identity?.session_token,
      googleSub: identity?.google_sub,
      email: identity?.email,
      ownerJid: identity?.owner_jid,
    });

    if (!Object.keys(payload).length || busy) return;

    const label = normalizeString(contextLabel) || buildIdentityLabel(payload);
    if (!window.confirm(`Forçar logout de ${label}?`)) return;

    setBusy(true);
    setAdminError('');
    try {
      const response = await api.forceLogout(payload);
      const removed = Number(response?.data?.removed_sessions || 0);
      pushToast({ kind: 'success', title: 'Sessão', message: `Logout forçado concluído para ${label}. Sessões removidas: ${removed}.` });
      refreshPanel();
    } catch (error) {
      setAdminError(error?.message || 'Falha ao forçar logout.');
      pushToast({ kind: 'error', title: 'Erro', message: error?.message || 'Falha ao forçar logout.' });
      setBusy(false);
    }
  };

  const handleCreateBan = async (identity, reason = '') => {
    const payload = {
      ...buildIdentityPayload({
        googleSub: identity?.google_sub,
        email: identity?.email,
        ownerJid: identity?.owner_jid,
      }),
      reason: normalizeString(reason) || 'Ban via painel administrativo.',
    };

    if (!payload.google_sub && !payload.email && !payload.owner_jid) return;
    if (busy) return;

    const label = buildIdentityLabel(payload);
    if (!window.confirm(`Banir conta ${label}?`)) return;

    setBusy(true);
    setAdminError('');
    try {
      const response = await api.createBan(payload);
      const created = Boolean(response?.data?.created);
      pushToast({ kind: 'success', title: 'Ban', message: created ? `Conta ${label} banida.` : `Conta ${label} já estava bloqueada.` });
      refreshPanel();
    } catch (error) {
      setAdminError(error?.message || 'Falha ao banir conta.');
      pushToast({ kind: 'error', title: 'Erro', message: error?.message || 'Falha ao banir conta.' });
      setBusy(false);
    }
  };

  const handleRevokeBan = async (banId) => {
    const safeBanId = normalizeString(banId);
    if (!safeBanId || busy) return;
    if (!window.confirm(`Revogar ban ${safeBanId}?`)) return;

    setBusy(true);
    setAdminError('');
    try {
      await api.revokeBan(safeBanId);
      pushToast({ kind: 'success', title: 'Ban', message: `Ban ${safeBanId} revogado.` });
      refreshPanel();
    } catch (error) {
      setAdminError(error?.message || 'Falha ao revogar ban.');
      pushToast({ kind: 'error', title: 'Erro', message: error?.message || 'Falha ao revogar ban.' });
      setBusy(false);
    }
  };

  const handleToggleFeatureFlag = async (flag) => {
    if (!flag || busy) return;

    const flagName = normalizeString(flag?.flag_name);
    if (!flagName) return;

    setBusy(true);
    setAdminError('');
    try {
      await api.upsertFeatureFlag({
        flag_name: flagName,
        is_enabled: !flag?.is_enabled,
        rollout_percent: clampInt(flag?.rollout_percent, 0, 0, 100),
        description: normalizeString(flag?.description),
      });
      pushToast({ kind: 'success', title: 'Feature flag', message: `Flag ${flagName} atualizada.` });
      refreshPanel();
    } catch (error) {
      setAdminError(error?.message || 'Falha ao atualizar feature flag.');
      pushToast({ kind: 'error', title: 'Erro', message: error?.message || 'Falha ao atualizar feature flag.' });
      setBusy(false);
    }
  };

  const handleExport = async (type, format) => {
    if (busy) return;
    const safeType = normalizeString(type).toLowerCase() || 'metrics';
    const safeFormat = normalizeString(format).toLowerCase() === 'csv' ? 'csv' : 'json';

    setBusy(true);
    setAdminError('');
    try {
      const response = await api.exportDataRaw(safeType, safeFormat);
      if (safeFormat === 'csv') {
        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition');
        const filename = extractFilenameFromDisposition(disposition, `admin-${safeType}.csv`);
        triggerFileDownload(blob, filename);
      } else {
        const payload = await response.json().catch(() => ({}));
        const blob = new Blob([JSON.stringify(payload?.data || payload || {}, null, 2)], {
          type: 'application/json; charset=utf-8',
        });
        triggerFileDownload(blob, `admin-${safeType}.json`);
      }
      pushToast({ kind: 'success', title: 'Exportação', message: `Exportação ${safeType.toUpperCase()} (${safeFormat.toUpperCase()}) concluída.` });
    } catch (error) {
      setAdminError(error?.message || 'Falha ao exportar dados.');
      pushToast({ kind: 'error', title: 'Exportação', message: error?.message || 'Falha ao exportar dados.' });
    } finally {
      setBusy(false);
    }
  };

  const moderationFiltered = useMemo(() => {
    const severityFilter = normalizeString(moderationSeverityFilter).toLowerCase();
    const typeFilter = normalizeString(moderationTypeFilter).toLowerCase();
    return moderationQueue.filter((event) => {
      const eventSeverity = normalizeSeverity(event?.severity);
      const eventType = normalizeString(event?.event_type).toLowerCase();
      const severityOk = severityFilter === 'all' || eventSeverity === severityFilter;
      const typeOk = typeFilter === 'all' || eventType.includes(typeFilter);
      return severityOk && typeOk;
    });
  }, [moderationQueue, moderationSeverityFilter, moderationTypeFilter]);

  const moderationPagination = useMemo(() => paginate({ items: moderationFiltered, page: moderationPage, pageSize: 6 }), [moderationFiltered, moderationPage]);

  const usersPagination = useMemo(() => paginate({ items: users, page: usersPage, pageSize: 6 }), [users, usersPage]);
  const sessionsPagination = useMemo(() => paginate({ items: sessions, page: sessionsPage, pageSize: 6 }), [sessions, sessionsPage]);

  const auditFiltered = useMemo(() => {
    const statusFilter = normalizeString(auditStatusFilter).toLowerCase();
    const query = normalizeString(auditSearchQuery).toLowerCase();
    return auditLog.filter((entry) => {
      const status = normalizeString(entry?.status).toLowerCase();
      const statusOk = statusFilter === 'all' || status === statusFilter;
      if (!statusOk) return false;
      if (!query) return true;
      const haystack = [entry?.action, entry?.target_type, entry?.target_id, entry?.status, entry?.created_at].map((item) => normalizeString(item).toLowerCase()).join(' ');
      return haystack.includes(query);
    });
  }, [auditLog, auditSearchQuery, auditStatusFilter]);

  const auditPagination = useMemo(() => paginate({ items: auditFiltered, page: auditPage, pageSize: 6 }), [auditFiltered, auditPage]);
  const alertsPagination = useMemo(() => paginate({ items: alerts, page: alertsPage, pageSize: 6 }), [alerts, alertsPage]);

  const renderListItem = ({ title, severity = 'low', badgeLabel = '', meta = [], actions = [], customNode = null }) => {
    const safeMeta = (Array.isArray(meta) ? meta : []).map((line) => normalizeString(line)).filter(Boolean);
    return html`
      <article className="admin-item">
        <h5 className="admin-item-title">${normalizeString(title) || 'Registro'}</h5>
        ${badgeLabel ? html`<${SeverityBadge} label=${badgeLabel} severity=${severity} />` : null} ${safeMeta.map((line, index) => html`<p key=${`meta-${index}`} className="admin-item-meta">${line}</p>`)} ${customNode ? customNode : null} ${actions.length ? html` <div className="admin-item-actions">${actions.map((action, index) => (action.kind === 'link' ? html`<a key=${`action-${index}`} className="admin-mini-btn" href=${action.href} target="_blank" rel="noreferrer noopener">${action.label}</a>` : html`<button key=${`action-${index}`} type="button" className="admin-mini-btn" disabled=${Boolean(action.disabled) || busy} onClick=${action.onClick}>${action.label}</button>`))}</div> ` : null}
      </article>
    `;
  };

  const botPhoneLabel = botPhone ? `+${formatPhone(botPhone)}` : '';
  const stickersBasePath = config.stickersPath.replace(/\/+$/, '') || DEFAULT_STICKERS_PATH;
  const stickersManagePath = `${stickersBasePath}/perfil`;

  return html`
    <main className="admin-shell" data-sidebar=${compactMode ? 'collapsed' : 'expanded'}>
      <aside className="sidebar">
        <a href="/" className="brand">
          <img src=${FALLBACK_AVATAR} alt="OmniZap" loading="lazy" decoding="async" />
          <span>Omnizap</span>
        </a>

        <div className="sidebar-summary">
          <p>Painel corporativo de operações, segurança e moderação para bots e stickers.</p>
          ${botPhoneLabel ? html`<p className="admin-item-meta" style=${{ marginTop: '8px' }}>Bot: ${botPhoneLabel}</p>` : null}
        </div>

        <ul className="nav-list">
          ${NAV_ITEMS.map(
            (item) => html`
              <li key=${item.id}>
                <a
                  className=${`nav-link ${activePage === item.id ? 'active' : ''}`}
                  href=${`#${item.id}`}
                  onClick=${(event) => {
                    event.preventDefault();
                    navigateToPage(item.id);
                  }}
                >
                  <span>${item.label}</span>
                  <span className="nav-kbd">${item.kbd}</span>
                </a>
              </li>
            `,
          )}
        </ul>

        <div className="sidebar-footer">
          <a className="btn" href="/"> Home </a>
          <a className="btn" href="/user/"> Minha Conta </a>
          <a className="btn" href=${stickersManagePath}> Gerenciar Stickers </a>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <h2 className="topbar-title">System Admin</h2>
            <div className="topbar-meta">
              <span className="chip env">${envLabel}</span>
              <span className=${`chip status ${normalizeStatusTone(globalStatus.tone) !== 'online' ? normalizeStatusTone(globalStatus.tone) : ''}`}>
                <span className="top-status-dot"></span>
                <span>${globalStatus.label}</span>
              </span>
            </div>
          </div>

          <div className="topbar-right">
            <button type="button" className="btn ghost" onClick=${() => setCompactMode((value) => !value)}>${compactMode ? 'Modo confortável' : 'Modo compacto'}</button>
            <div className="topbar-admin">
              <img src=${profilePicture} alt="Admin" />
              <span>${profileName}</span>
            </div>
          </div>
        </header>

        <div className="viewport">
          <section className="section admin-panel">
            ${!adminAuthenticated
              ? html`<p className="admin-note">${adminEligible ? 'Conta elegível para admin. Informe a senha para liberar os dados sensíveis.' : 'Conta atual sem permissão para o painel admin.'}</p>`
              : null}

            ${adminError ? html` <p className="admin-error">${adminError}</p> ` : null}
            ${!adminEligible
              ? html`
                  <div className="admin-item">
                    <h5 className="admin-item-title">Acesso restrito</h5>
                    <p className="admin-item-meta">Faça login com a conta Google autorizada para acessar o painel.</p>
                    <div className="admin-item-actions">
                      <a className="btn" href=${`${config.loginPath}/`}> Ir para login </a>
                    </div>
                  </div>
                `
              : null}
            ${adminEligible && !adminAuthenticated
              ? html`
                  <form className="admin-form" onSubmit=${handleUnlockAdmin}>
                    <label className="admin-label" for="admin-password-input">Senha do painel admin</label>
                    <div className="admin-form-row">
                      <input id="admin-password-input" className="admin-input" type="password" autocomplete="current-password" placeholder="Digite sua senha" value=${unlockPassword} disabled=${busy} onInput=${(event) => setUnlockPassword(event.target.value)} />
                      <button type="submit" className="btn" disabled=${busy}>${busy ? 'Desbloqueando...' : 'Desbloquear'}</button>
                    </div>
                  </form>
                `
              : null}
            ${adminAuthenticated
              ? html`
                  <div className="admin-layout admin-layout--enterprise is-subpage">
                    <section id="overview" className="section section-kpis span-12" hidden=${activePage !== 'overview'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Dashboard Estratégico</h4>
                          <p className="panel-subtitle">Métricas segmentadas por Operação, Sistema, Segurança e Usuários.</p>
                        </div>
                      </div>

                      <div className="admin-grid">
                        <article className="metric-card">
                          <p className="admin-metric-label">Bots online</p>
                          <p className="admin-metric-value">${formatNumber(dashboardQuick?.bots_online)}</p>
                          <span className="trend up">Operação</span>
                          <p className="metric-context">vs leitura anterior: ${deltaLabel(dashboardQuick?.bots_online, previousOverview?.dashboard_quick?.bots_online ?? dashboardQuick?.bots_online)}</p>
                        </article>
                        <article className="metric-card">
                          <p className="admin-metric-label">Mensagens hoje</p>
                          <p className="admin-metric-value">${formatNumber(dashboardQuick?.messages_today)}</p>
                          <span className="trend up">Operação</span>
                          <p className="metric-context">vs leitura anterior: ${deltaLabel(dashboardQuick?.messages_today, previousOverview?.dashboard_quick?.messages_today ?? dashboardQuick?.messages_today)}</p>
                        </article>
                        <article className="metric-card system">
                          <p className="admin-metric-label">Uptime</p>
                          <p className="admin-metric-value">${normalizeString(dashboardQuick?.uptime) || 'n/d'}</p>
                          <span className="trend up">Sistema</span>
                          <p className="metric-context">janela: processo atual</p>
                        </article>
                        <article className="metric-card system">
                          <p className="admin-metric-label">Erros 5xx</p>
                          <p className="admin-metric-value">${formatNumber(dashboardQuick?.errors_5xx)}</p>
                          <span className="trend warn">Sistema</span>
                          <p className="metric-context">vs leitura anterior: ${deltaLabel(dashboardQuick?.errors_5xx, previousOverview?.dashboard_quick?.errors_5xx ?? dashboardQuick?.errors_5xx, { percent: false, suffix: ' eventos' })}</p>
                        </article>
                        <article className="metric-card">
                          <p className="admin-metric-label">Packs (total)</p>
                          <p className="admin-metric-value">${formatNumber(counters?.total_packs_any_status)}</p>
                          <span className="trend up">Produto</span>
                          <p className="metric-context">delta leitura: ${deltaLabel(counters?.total_packs_any_status, previousOverview?.counters?.total_packs_any_status ?? counters?.total_packs_any_status, { percent: false })}</p>
                        </article>
                        <article className="metric-card">
                          <p className="admin-metric-label">Stickers (total)</p>
                          <p className="admin-metric-value">${formatNumber(counters?.total_stickers_any_status)}</p>
                          <span className="trend up">Produto</span>
                          <p className="metric-context">delta leitura: ${deltaLabel(counters?.total_stickers_any_status, previousOverview?.counters?.total_stickers_any_status ?? counters?.total_stickers_any_status, { percent: false })}</p>
                        </article>
                        <article className="metric-card security warning">
                          <p className="admin-metric-label">Spam bloqueado</p>
                          <p className="admin-metric-value">${formatNumber(dashboardQuick?.spam_blocked_today)}</p>
                          <span className="trend warn">Segurança</span>
                          <p className="metric-context">vs leitura anterior: ${deltaLabel(dashboardQuick?.spam_blocked_today, previousOverview?.dashboard_quick?.spam_blocked_today ?? dashboardQuick?.spam_blocked_today)}</p>
                        </article>
                        <article className="metric-card security critical">
                          <p className="admin-metric-label">Bans ativos</p>
                          <p className="admin-metric-value">${formatNumber(counters?.active_bans)}</p>
                          <span className="trend down">Segurança</span>
                          <p className="metric-context">delta leitura: ${deltaLabel(counters?.active_bans, previousOverview?.counters?.active_bans ?? counters?.active_bans, { percent: false })}</p>
                        </article>
                        <article className="metric-card users">
                          <p className="admin-metric-label">Usuários Google</p>
                          <p className="admin-metric-value">${formatNumber(counters?.known_google_users)}</p>
                          <span className="trend up">Usuários</span>
                          <p className="metric-context">delta leitura: ${deltaLabel(counters?.known_google_users, previousOverview?.counters?.known_google_users ?? counters?.known_google_users, { percent: false })}</p>
                        </article>
                        <article className="metric-card users">
                          <p className="admin-metric-label">Sessões Google</p>
                          <p className="admin-metric-value">${formatNumber(counters?.active_google_sessions)}</p>
                          <span className="trend warn">Usuários</span>
                          <p className="metric-context">delta leitura: ${deltaLabel(counters?.active_google_sessions, previousOverview?.counters?.active_google_sessions ?? counters?.active_google_sessions, { percent: false })}</p>
                        </article>
                        <article className="metric-card users">
                          <p className="admin-metric-label">Visitas 24h</p>
                          <p className="admin-metric-value">${formatNumber(counters?.visit_events_24h)}</p>
                          <span className="trend up">Usuários</span>
                          <p className="metric-context">janela: 24h</p>
                        </article>
                        <article className="metric-card users">
                          <p className="admin-metric-label">Visitas 7d</p>
                          <p className="admin-metric-value">${formatNumber(counters?.visit_events_7d)}</p>
                          <span className="trend up">Usuários</span>
                          <p className="metric-context">janela: 7 dias</p>
                        </article>
                        <article className="metric-card users">
                          <p className="admin-metric-label">Visitantes 7d</p>
                          <p className="admin-metric-value">${formatNumber(counters?.unique_visitors_7d)}</p>
                          <span className="trend up">Usuários</span>
                          <p className="metric-context">janela: 7 dias</p>
                        </article>
                      </div>
                    </section>

                    <section id="saude" className="section section-health span-12" hidden=${activePage !== 'saude'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Saúde do Sistema</h4>
                          <p className="panel-subtitle">Visão DevOps com barras de utilização e status de banco.</p>
                        </div>
                      </div>
                      <div className="health-grid">
                        <article className="health-card">
                          <div className="health-head">
                            <p className="admin-metric-label">CPU</p>
                            <p className="admin-metric-value">${formatPercent(systemHealth?.cpu_percent)}</p>
                          </div>
                          <div className="health-meter">
                            <span className=${Number(systemHealth?.cpu_percent || 0) >= 88 ? 'danger' : Number(systemHealth?.cpu_percent || 0) >= 75 ? 'warn' : ''} style=${{ inlineSize: `${Math.max(0, Math.min(100, Number(systemHealth?.cpu_percent || 0))).toFixed(1)}%` }}></span>
                          </div>
                          <p className="health-meta">Limite alerta: 88%</p>
                        </article>

                        <article className="health-card">
                          <div className="health-head">
                            <p className="admin-metric-label">RAM</p>
                            <p className="admin-metric-value">${formatPercent(systemHealth?.ram_percent)}</p>
                          </div>
                          <div className="health-meter">
                            <span className=${Number(systemHealth?.ram_percent || 0) >= 90 ? 'danger' : Number(systemHealth?.ram_percent || 0) >= 75 ? 'warn' : ''} style=${{ inlineSize: `${Math.max(0, Math.min(100, Number(systemHealth?.ram_percent || 0))).toFixed(1)}%` }}></span>
                          </div>
                          <p className="health-meta">Limite alerta: 90%</p>
                        </article>

                        <article className="health-card">
                          <div className="health-head">
                            <p className="admin-metric-label">Latência P95</p>
                            <p className="admin-metric-value">${formatMilliseconds(systemHealth?.http_latency_p95_ms)}</p>
                          </div>
                          <div className="health-meter">
                            <span className=${Number(systemHealth?.http_latency_p95_ms || 0) >= 500 ? 'danger' : Number(systemHealth?.http_latency_p95_ms || 0) >= 300 ? 'warn' : ''} style=${{ inlineSize: `${Math.max(0, Math.min(100, (Number(systemHealth?.http_latency_p95_ms || 0) / 900) * 100)).toFixed(1)}%` }}></span>
                          </div>
                          <p className="health-meta">Alerta: &gt; 300ms</p>
                        </article>

                        <article className="health-card">
                          <div className="health-head">
                            <p className="admin-metric-label">Fila pendente</p>
                            <p className="admin-metric-value">${formatNumber(systemHealth?.queue_pending)}</p>
                          </div>
                          <div className="health-meter">
                            <span className=${Number(systemHealth?.queue_pending || 0) >= 220 ? 'danger' : Number(systemHealth?.queue_pending || 0) >= 120 ? 'warn' : ''} style=${{ inlineSize: `${Math.max(0, Math.min(100, (Number(systemHealth?.queue_pending || 0) / 400) * 100)).toFixed(1)}%` }}></span>
                          </div>
                          <p className="health-meta">Ideal: &lt; 120 jobs</p>
                        </article>

                        <article className="health-card">
                          <div className="health-head">
                            <p className="admin-metric-label">Banco</p>
                            <span className=${`db-badge ${normalizeString(systemHealth?.db_status).toLowerCase() === 'ok' ? 'healthy' : normalizeString(systemHealth?.db_status).toLowerCase() === 'degraded' ? 'degraded' : normalizeString(systemHealth?.db_status).toLowerCase() === 'down' ? 'down' : ''}`}>${normalizeString(systemHealth?.db_status) || 'unknown'}</span>
                          </div>
                          <p className="health-meta">SLA alvo: 99.95%</p>
                        </article>
                      </div>

                      <div className="section" style=${{ marginTop: '16px' }}>
                        <div className="section-head">
                          <div>
                            <h4 className="panel-title">Dashboards Grafana</h4>
                            <p className="panel-subtitle">Visualização incorporada dos dashboards de observabilidade.</p>
                          </div>
                        </div>

                        ${grafanaDashboards.length
                          ? html`
                              <div className="admin-list">
                                ${grafanaDashboards.map((dashboard, index) => {
                                  const uid = normalizeString(dashboard?.uid) || `dashboard-${index + 1}`;
                                  const title = normalizeString(dashboard?.title) || uid;
                                  const viewUrl = normalizeString(dashboard?.view_url);
                                  const embedUrl = normalizeString(dashboard?.embed_url || viewUrl);
                                  if (!embedUrl) return null;
                                  return html`
                                    <article key=${uid} className="admin-item">
                                      <h5 className="admin-item-title">${title}</h5>
                                      <p className="admin-item-meta">UID: ${uid}</p>
                                      ${viewUrl
                                        ? html`
                                            <div className="admin-item-actions">
                                              <a className="admin-mini-btn" href=${viewUrl} target="_blank" rel="noreferrer noopener">Abrir no Grafana</a>
                                            </div>
                                          `
                                        : null}
                                      <div style=${{ marginTop: '10px', borderRadius: '12px', overflow: 'hidden', border: '1px solid rgba(148, 163, 184, 0.25)', background: '#020617' }}>
                                        <iframe title=${`grafana-${uid}`} src=${embedUrl} loading="lazy" referrerPolicy="no-referrer" style=${{ inlineSize: '100%', blockSize: '420px', border: '0', background: '#020617' }}></iframe>
                                      </div>
                                    </article>
                                  `;
                                })}
                              </div>
                            `
                          : html`<p className="admin-item-meta">Sem dashboards configurados. Defina SYSTEM_ADMIN_GRAFANA_URL e SYSTEM_ADMIN_GRAFANA_DASHBOARDS no ambiente.</p>`}
                      </div>
                    </section>

                    <section id="moderacao" className="section section-security span-12" hidden=${activePage !== 'moderacao'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Fila de Moderação</h4>
                          <p className="panel-subtitle">Eventos recentes para ação rápida do time.</p>
                        </div>
                      </div>

                      <div className="filters">
                        <div className="filter-field">
                          <label>Severidade</label>
                          <select className="admin-input" value=${moderationSeverityFilter} onChange=${(event) => setModerationSeverityFilter(event.target.value)}>
                            <option value="all">Todas</option>
                            <option value="critical">Crítica</option>
                            <option value="high">Alta</option>
                            <option value="medium">Média</option>
                            <option value="low">Baixa</option>
                          </select>
                        </div>
                        <div className="filter-field">
                          <label>Tipo</label>
                          <select className="admin-input" value=${moderationTypeFilter} onChange=${(event) => setModerationTypeFilter(event.target.value)}>
                            <option value="all">Todos</option>
                            <option value="ban">Ban</option>
                            <option value="spam">Spam</option>
                            <option value="abuse">Abuse</option>
                            <option value="incident">Incident</option>
                          </select>
                        </div>
                      </div>

                      <div className="admin-list timeline">
                        ${moderationPagination.pageItems.length
                          ? moderationPagination.pageItems.map((event) => {
                              const severity = normalizeSeverity(event?.severity);
                              const title = normalizeString(event?.title) || 'Evento de moderação';
                              const meta = [normalizeString(event?.subtitle), `Tipo: ${normalizeString(event?.event_type) || 'evento'} · ${formatDateTime(event?.created_at || event?.revoked_at)}`, normalizeString(event?.reason) ? `Motivo: ${normalizeString(event?.reason)}` : ''].filter(Boolean);

                              const actions = [];
                              if (normalizeString(event?.event_type).toLowerCase() === 'ban' && event?.ban_id && !event?.revoked_at) {
                                actions.push({
                                  label: 'Revogar ban',
                                  onClick: () => handleRevokeBan(event?.ban_id),
                                });
                              } else {
                                const identity = buildIdentityPayload({
                                  sessionToken: event?.metadata?.session_token,
                                  googleSub: event?.metadata?.google_sub,
                                  email: event?.metadata?.email,
                                  ownerJid: event?.sender_id || event?.metadata?.owner_jid,
                                });

                                if (Object.keys(identity).length) {
                                  actions.push({
                                    label: 'Banir conta',
                                    onClick: () =>
                                      handleCreateBan(
                                        {
                                          google_sub: identity.google_sub,
                                          email: identity.email,
                                          owner_jid: identity.owner_jid,
                                        },
                                        `Ban via moderação (${normalizeString(event?.event_type) || 'evento'})`,
                                      ),
                                  });
                                  actions.push({
                                    label: 'Forçar logout',
                                    onClick: () => handleForceLogout(identity, buildIdentityLabel(identity)),
                                  });
                                }
                              }

                              return renderListItem({
                                title,
                                severity,
                                badgeLabel: severity.toUpperCase(),
                                meta,
                                actions,
                              });
                            })
                          : html`<p className="admin-item-meta">Nenhum evento recente de moderação.</p>`}
                      </div>

                      <${PaginationControls} pagination=${moderationPagination} onPrev=${() => setModerationPage((value) => Math.max(1, value - 1))} onNext=${() => setModerationPage((value) => value + 1)} />
                    </section>

                    <section id="usuarios" className="section section-users span-12" hidden=${activePage !== 'usuarios'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Usuários</h4>
                          <p className="panel-subtitle">Contas conhecidas e ações de moderação.</p>
                        </div>
                      </div>

                      <div className="admin-list">
                        ${usersPagination.pageItems.length
                          ? usersPagination.pageItems.map((user) => {
                              const identity = buildIdentityPayload({
                                googleSub: user?.google_sub,
                                email: user?.email,
                                ownerJid: user?.owner_jid,
                              });
                              return renderListItem({
                                title: normalizeString(user?.name || user?.email || user?.owner_jid) || 'Usuário',
                                severity: 'low',
                                badgeLabel: 'USER',
                                meta: [`Email: ${normalizeString(user?.email) || 'n/d'}`, `Owner: ${normalizeString(user?.owner_jid) || 'n/d'}`, `Último acesso: ${formatDateTime(user?.last_seen_at || user?.last_login_at)}`],
                                actions: [
                                  {
                                    label: 'Forçar logout',
                                    onClick: () => handleForceLogout(identity, buildIdentityLabel(identity)),
                                  },
                                  {
                                    label: 'Banir conta',
                                    onClick: () => handleCreateBan(identity, 'Ban via lista de usuários.'),
                                  },
                                ],
                              });
                            })
                          : html`<p className="admin-item-meta">Nenhum usuário encontrado.</p>`}
                      </div>

                      <${PaginationControls} pagination=${usersPagination} onPrev=${() => setUsersPage((value) => Math.max(1, value - 1))} onNext=${() => setUsersPage((value) => value + 1)} />

                      <div className="section" style=${{ marginTop: '16px' }}>
                        <div className="section-head">
                          <div>
                            <h4 className="panel-title">Busca Global</h4>
                            <p className="panel-subtitle">Resultados consolidados por usuário, grupo, pack e sessão.</p>
                          </div>
                        </div>
                        <form className="admin-inline-form" onSubmit=${handleSearchSubmit} style=${{ marginBottom: '12px' }}>
                          <input className="admin-input" type="text" placeholder="Buscar por usuário, grupo, pack ou sessão" value=${searchQuery} onInput=${(event) => setSearchQuery(event.target.value)} disabled=${busy} />
                          <button type="submit" className="btn" disabled=${busy}>Buscar</button>
                        </form>
                        <div className="admin-list">
                          ${searchResult
                            ? (() => {
                                const rows = [];
                                const usersRows = Array.isArray(searchResult?.results?.users) ? searchResult.results.users : [];
                                const sessionsRows = Array.isArray(searchResult?.results?.sessions) ? searchResult.results.sessions : [];
                                const groupsRows = Array.isArray(searchResult?.results?.groups) ? searchResult.results.groups : [];
                                const packsRows = Array.isArray(searchResult?.results?.packs) ? searchResult.results.packs : [];

                                for (const row of usersRows) {
                                  const identity = buildIdentityPayload({
                                    googleSub: row?.google_sub,
                                    email: row?.email,
                                    ownerJid: row?.owner_jid,
                                  });
                                  rows.push(
                                    renderListItem({
                                      title: `[Usuário] ${normalizeString(row?.name || row?.email || row?.owner_jid) || 'registro'}`,
                                      severity: 'low',
                                      badgeLabel: 'USER',
                                      meta: [`Email: ${normalizeString(row?.email) || 'n/d'}`, `Owner: ${normalizeString(row?.owner_jid) || 'n/d'}`],
                                      actions: [
                                        {
                                          label: 'Forçar logout',
                                          onClick: () => handleForceLogout(identity, buildIdentityLabel(identity)),
                                        },
                                      ],
                                    }),
                                  );
                                }

                                for (const row of sessionsRows) {
                                  const identity = buildIdentityPayload({
                                    sessionToken: row?.session_token,
                                    googleSub: row?.google_sub,
                                    email: row?.email,
                                    ownerJid: row?.owner_jid,
                                  });
                                  rows.push(
                                    renderListItem({
                                      title: `[Sessão] ${normalizeString(row?.name || row?.email || row?.owner_jid) || 'ativa'}`,
                                      severity: 'low',
                                      badgeLabel: 'SESSÃO',
                                      meta: [`Email: ${normalizeString(row?.email) || 'n/d'}`, `Expira: ${formatDateTime(row?.expires_at)}`],
                                      actions: [
                                        {
                                          label: 'Forçar logout',
                                          onClick: () => handleForceLogout(identity, buildIdentityLabel(identity)),
                                        },
                                      ],
                                    }),
                                  );
                                }

                                for (const row of groupsRows) {
                                  rows.push(
                                    renderListItem({
                                      title: `[Grupo] ${normalizeString(row?.subject || row?.id) || 'grupo'}`,
                                      severity: 'medium',
                                      badgeLabel: 'GRUPO',
                                      meta: [`ID: ${normalizeString(row?.id) || 'n/d'}`, `Atualizado: ${formatDateTime(row?.updated_at)}`],
                                    }),
                                  );
                                }

                                for (const row of packsRows) {
                                  const actions = [];
                                  if (normalizeString(row?.web_url)) {
                                    actions.push({ kind: 'link', label: 'Abrir pack', href: row.web_url });
                                  }
                                  rows.push(
                                    renderListItem({
                                      title: `[Pack] ${normalizeString(row?.name || row?.pack_key) || 'pack'}`,
                                      severity: 'low',
                                      badgeLabel: normalizeString(row?.visibility || 'pack').toUpperCase(),
                                      meta: [`Owner: ${normalizeString(row?.owner_jid) || 'n/d'}`, `Stickers: ${formatNumber(row?.stickers_count)}`],
                                      actions,
                                    }),
                                  );
                                }

                                if (!rows.length) {
                                  return html`<p className="admin-item-meta">Nenhum resultado encontrado.</p>`;
                                }
                                return rows;
                              })()
                            : html`<p className="admin-item-meta">Faça uma busca para ver usuários, grupos, packs e sessões.</p>`}
                        </div>
                      </div>
                    </section>

                    <section id="sessoes" className="section section-users span-12" hidden=${activePage !== 'sessoes'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Sessões Ativas</h4>
                          <p className="panel-subtitle">Sessões Google abertas e monitoradas.</p>
                        </div>
                      </div>

                      <div className="admin-list">
                        ${sessionsPagination.pageItems.length
                          ? sessionsPagination.pageItems.map((sessionEntry) => {
                              const identity = buildIdentityPayload({
                                sessionToken: sessionEntry?.session_token,
                                googleSub: sessionEntry?.google_sub,
                                email: sessionEntry?.email,
                                ownerJid: sessionEntry?.owner_jid,
                              });
                              return renderListItem({
                                title: normalizeString(sessionEntry?.name || sessionEntry?.email || sessionEntry?.owner_jid) || 'Sessão ativa',
                                severity: 'medium',
                                badgeLabel: 'SESSÃO',
                                meta: [`Email: ${normalizeString(sessionEntry?.email) || 'n/d'}`, `Token: ${normalizeString(sessionEntry?.session_token) || 'n/d'}`, `Última atividade: ${formatDateTime(sessionEntry?.last_seen_at)}`, `Expira: ${formatDateTime(sessionEntry?.expires_at)}`],
                                actions: [
                                  {
                                    label: 'Forçar logout',
                                    onClick: () => handleForceLogout(identity, buildIdentityLabel(identity)),
                                  },
                                ],
                              });
                            })
                          : html`<p className="admin-item-meta">Nenhuma sessão ativa encontrada.</p>`}
                      </div>

                      <${PaginationControls} pagination=${sessionsPagination} onPrev=${() => setSessionsPage((value) => Math.max(1, value - 1))} onNext=${() => setSessionsPage((value) => value + 1)} />
                    </section>

                    <section id="auditoria" className="section section-governance span-12" hidden=${activePage !== 'auditoria'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Auditoria</h4>
                          <p className="panel-subtitle">Registro de ações administrativas recentes.</p>
                        </div>
                      </div>

                      <div className="filters">
                        <div className="filter-field">
                          <label>Status</label>
                          <select className="admin-input" value=${auditStatusFilter} onChange=${(event) => setAuditStatusFilter(event.target.value)}>
                            <option value="all">Todos</option>
                            <option value="success">Sucesso</option>
                            <option value="failed">Falha</option>
                          </select>
                        </div>
                        <div className="filter-field" style=${{ minInlineSize: '220px' }}>
                          <label>Buscar</label>
                          <input className="admin-input" type="text" value=${auditSearchQuery} onInput=${(event) => setAuditSearchQuery(event.target.value)} placeholder="Ação, alvo ou status" />
                        </div>
                      </div>

                      <div className="admin-list timeline">
                        ${auditPagination.pageItems.length
                          ? auditPagination.pageItems.map((entry) =>
                              renderListItem({
                                title: normalizeString(entry?.action) || 'Ação administrativa',
                                severity: normalizeString(entry?.status).toLowerCase() === 'failed' ? 'high' : 'low',
                                badgeLabel: normalizeString(entry?.status || 'status').toUpperCase(),
                                meta: [`Alvo: ${normalizeString(entry?.target_type || 'n/d')} · ${normalizeString(entry?.target_id || 'n/d')}`, `Autor: ${normalizeString(entry?.actor_email || entry?.actor_sub || 'n/d')}`, `Quando: ${formatDateTime(entry?.created_at)}`],
                              }),
                            )
                          : html`<p className="admin-item-meta">Nenhum evento de auditoria no período.</p>`}
                      </div>

                      <${PaginationControls} pagination=${auditPagination} onPrev=${() => setAuditPage((value) => Math.max(1, value - 1))} onNext=${() => setAuditPage((value) => value + 1)} />
                    </section>

                    <section id="alertas" className="section section-security span-12" hidden=${activePage !== 'alertas'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Alertas</h4>
                          <p className="panel-subtitle">Monitoramento de risco e estabilidade.</p>
                        </div>
                      </div>

                      <div className="admin-list">
                        ${alertsPagination.pageItems.length
                          ? alertsPagination.pageItems.map((alert) =>
                              renderListItem({
                                title: normalizeString(alert?.title || alert?.code) || 'Alerta',
                                severity: normalizeSeverity(alert?.severity),
                                badgeLabel: normalizeSeverity(alert?.severity).toUpperCase(),
                                meta: [normalizeString(alert?.description) || 'Sem descrição.', `Código: ${normalizeString(alert?.code || 'n/d')}`],
                              }),
                            )
                          : html`<p className="admin-item-meta">Sem alertas ativos no momento.</p>`}
                      </div>

                      <${PaginationControls} pagination=${alertsPagination} onPrev=${() => setAlertsPage((value) => Math.max(1, value - 1))} onNext=${() => setAlertsPage((value) => value + 1)} />
                    </section>

                    <section id="configuracoes" className="section section-governance span-6" hidden=${activePage !== 'configuracoes'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Controle de Recursos</h4>
                          <p className="panel-subtitle">Feature flags e ajustes de rollout.</p>
                        </div>
                      </div>

                      <div className="admin-list">
                        ${featureFlags.length
                          ? featureFlags.map((flag) =>
                              renderListItem({
                                title: normalizeString(flag?.flag_name) || 'flag',
                                severity: flag?.is_enabled ? 'medium' : 'low',
                                badgeLabel: flag?.is_enabled ? 'ON' : 'OFF',
                                meta: [normalizeString(flag?.description) || 'Sem descrição.', `Rollout: ${formatNumber(flag?.rollout_percent || 0)}%`],
                                actions: [
                                  {
                                    label: flag?.is_enabled ? 'Desativar' : 'Ativar',
                                    onClick: () => handleToggleFeatureFlag(flag),
                                  },
                                ],
                              }),
                            )
                          : html`<p className="admin-item-meta">Nenhuma feature flag disponível.</p>`}
                      </div>
                    </section>

                    <section className="section section-security span-6" hidden=${activePage !== 'configuracoes'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Bans</h4>
                          <p className="panel-subtitle">Estado das contas bloqueadas.</p>
                        </div>
                      </div>

                      <div className="admin-list">
                        ${blockedAccounts.length
                          ? blockedAccounts.map((ban) => {
                              const activeBan = !ban?.revoked_at;
                              return renderListItem({
                                title: normalizeString(ban?.email || ban?.owner_jid || ban?.google_sub) || 'Conta bloqueada',
                                severity: activeBan ? 'critical' : 'low',
                                badgeLabel: activeBan ? 'ATIVO' : 'REVOGADO',
                                meta: [normalizeString(ban?.reason) ? `Motivo: ${normalizeString(ban?.reason)}` : '', `Criado: ${formatDateTime(ban?.created_at)}`, ban?.revoked_at ? `Revogado: ${formatDateTime(ban?.revoked_at)}` : ''].filter(Boolean),
                                actions: activeBan
                                  ? [
                                      {
                                        label: 'Revogar ban',
                                        onClick: () => handleRevokeBan(ban?.id),
                                      },
                                    ]
                                  : [],
                              });
                            })
                          : html`<p className="admin-item-meta">Nenhum ban registrado.</p>`}
                      </div>
                    </section>

                    <section className="section section-governance span-12" hidden=${activePage !== 'configuracoes'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Atalhos Operacionais</h4>
                          <p className="panel-subtitle">Ações de manutenção com confirmação para operações críticas.</p>
                        </div>
                      </div>
                      <div className="admin-item-actions">${operationalShortcuts.map((shortcut) => html`<button key=${shortcut.action} type="button" className="admin-mini-btn" disabled=${busy} onClick=${() => handleRunOp(shortcut.action, shortcut.label)}>${shortcut.label}</button>`)}</div>
                    </section>

                    <section id="exportacao" className="section section-governance span-12" hidden=${activePage !== 'exportacao'}>
                      <div className="section-head">
                        <div>
                          <h4 className="panel-title">Exportação</h4>
                          <p className="panel-subtitle">Exportar métricas e eventos para auditoria externa.</p>
                        </div>
                      </div>
                      <div className="admin-item-actions">
                        <button type="button" className="admin-mini-btn" disabled=${busy} onClick=${() => handleExport('metrics', 'json')}>Métricas JSON</button>
                        <button type="button" className="admin-mini-btn" disabled=${busy} onClick=${() => handleExport('metrics', 'csv')}>Métricas CSV</button>
                        <button type="button" className="admin-mini-btn" disabled=${busy} onClick=${() => handleExport('events', 'json')}>Eventos JSON</button>
                        <button type="button" className="admin-mini-btn" disabled=${busy} onClick=${() => handleExport('events', 'csv')}>Eventos CSV</button>
                      </div>
                    </section>
                  </div>

                  <div className="admin-actions">
                    <button type="button" className="btn" disabled=${busy} onClick=${refreshPanel}>Atualizar dados admin</button>
                    <button type="button" className="btn" disabled=${busy} onClick=${handleAdminLogout}>Sair do admin</button>
                  </div>
                `
              : null}
          </section>

          <p className="footer">Omnizap · ${new Date().getFullYear()}</p>
        </div>
      </div>
    </main>

    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      ${toasts.map(
        (toast) => html`
          <article key=${toast.id} className=${`toast ${toast.kind}`}>
            <strong>${toast.title}</strong>
            <p>${toast.message}</p>
          </article>
        `,
      )}
    </div>
  `;
};

const rootElement = document.getElementById('user-systemadm-react-root');
if (rootElement) {
  const config = {
    apiBasePath: normalizeBasePath(rootElement.dataset.apiBasePath, DEFAULT_API_BASE_PATH),
    loginPath: normalizeBasePath(rootElement.dataset.loginPath, DEFAULT_LOGIN_PATH),
    stickersPath: normalizeBasePath(rootElement.dataset.stickersPath, DEFAULT_STICKERS_PATH),
  };
  createRoot(rootElement).render(html`<${UserSystemAdmReactApp} config=${config} />`);
}
