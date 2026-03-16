import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
const DEFAULT_API_BASE_PATH = '/api';
const DEFAULT_STICKERS_PATH = '/stickers';
const DEFAULT_LOGIN_PATH = '/login';
const FALLBACK_AVATAR = 'https://iili.io/FC3FABe.jpg';

const root = document.getElementById('user-app-root');

if (root) {
  const ui = {
    status: document.getElementById('user-status'),
    error: document.getElementById('user-error'),
    profile: document.getElementById('user-profile'),
    avatar: document.getElementById('user-avatar'),
    topAvatar: document.getElementById('user-top-avatar'),
    topAdminName: document.getElementById('user-top-admin-name'),
    envBadge: document.getElementById('user-env-badge'),
    globalStatus: document.getElementById('user-global-status'),
    globalStatusText: document.getElementById('user-global-status-text'),
    compactToggle: document.getElementById('user-compact-toggle'),
    navLinks: Array.from(document.querySelectorAll('#user-admin-nav .nav-link')),
    viewport: document.querySelector('.viewport'),
    toastStack: document.getElementById('user-admin-toast-stack'),
    name: document.getElementById('user-name'),
    email: document.getElementById('user-email'),
    whatsapp: document.getElementById('user-whatsapp'),
    grid: document.getElementById('user-grid'),
    metricPacks: document.getElementById('metric-packs'),
    metricStickers: document.getElementById('metric-stickers'),
    metricDownloads: document.getElementById('metric-downloads'),
    metricLikes: document.getElementById('metric-likes'),
    summary: document.getElementById('user-summary'),
    ownerJid: document.getElementById('user-owner-jid'),
    googleSub: document.getElementById('user-google-sub'),
    expiresAt: document.getElementById('user-expires-at'),
    actions: document.getElementById('user-actions'),
    chatLink: document.getElementById('user-chat-link'),
    logoutBtn: document.getElementById('user-logout-btn'),
    manageHeadLink: document.getElementById('user-manage-head-link'),
    manageMainLink: document.getElementById('user-manage-main-link'),
    currentYear: document.getElementById('user-current-year'),

    adminPanel: document.getElementById('user-admin-panel'),
    adminRole: document.getElementById('user-admin-role'),
    adminStatus: document.getElementById('user-admin-status'),
    adminError: document.getElementById('user-admin-error'),
    adminUnlockForm: document.getElementById('user-admin-unlock-form'),
    adminPassword: document.getElementById('user-admin-password'),
    adminUnlockBtn: document.getElementById('user-admin-unlock-btn'),
    adminOverview: document.getElementById('user-admin-overview'),
    adminLayout: document.getElementById('user-admin-layout'),
    adminRefreshBtn: document.getElementById('user-admin-refresh-btn'),
    adminLogoutBtn: document.getElementById('user-admin-logout-btn'),
    adminCarouselNav: document.getElementById('user-admin-carousel-nav'),
    adminCarouselPrevBtn: document.getElementById('user-admin-carousel-prev'),
    adminCarouselNextBtn: document.getElementById('user-admin-carousel-next'),
    adminCarouselCounter: document.getElementById('user-admin-carousel-counter'),

    adminBotsOnline: document.getElementById('user-admin-bots-online'),
    adminMessagesToday: document.getElementById('user-admin-messages-today'),
    adminSpamBlocked: document.getElementById('user-admin-spam-blocked'),
    adminUptime: document.getElementById('user-admin-uptime'),
    adminErrors5xx: document.getElementById('user-admin-errors-5xx'),
    adminTotalPacks: document.getElementById('user-admin-total-packs'),
    adminTotalStickers: document.getElementById('user-admin-total-stickers'),
    adminActiveBans: document.getElementById('user-admin-active-bans'),
    adminKnownUsers: document.getElementById('user-admin-known-users'),
    adminActiveSessions: document.getElementById('user-admin-active-sessions'),
    adminVisits24h: document.getElementById('user-admin-visits-24h'),
    adminVisits7d: document.getElementById('user-admin-visits-7d'),
    adminUniqueVisitors7d: document.getElementById('user-admin-unique-visitors-7d'),
    adminBotsOnlineContext: document.getElementById('user-admin-bots-online-context'),
    adminMessagesTodayContext: document.getElementById('user-admin-messages-today-context'),
    adminUptimeContext: document.getElementById('user-admin-uptime-context'),
    adminErrors5xxContext: document.getElementById('user-admin-errors-5xx-context'),
    adminTotalPacksContext: document.getElementById('user-admin-total-packs-context'),
    adminTotalStickersContext: document.getElementById('user-admin-total-stickers-context'),
    adminSpamBlockedContext: document.getElementById('user-admin-spam-blocked-context'),
    adminActiveBansContext: document.getElementById('user-admin-active-bans-context'),
    adminKnownUsersContext: document.getElementById('user-admin-known-users-context'),
    adminActiveSessionsContext: document.getElementById('user-admin-active-sessions-context'),
    adminVisits24hContext: document.getElementById('user-admin-visits-24h-context'),
    adminVisits7dContext: document.getElementById('user-admin-visits-7d-context'),
    adminUniqueVisitors7dContext: document.getElementById('user-admin-unique-visitors-7d-context'),
    adminLastUpdated: document.getElementById('user-admin-last-updated'),
    securitySession: document.getElementById('user-security-session'),
    securityEncryption: document.getElementById('user-security-encryption'),
    securityIp: document.getElementById('user-security-ip'),
    security2fa: document.getElementById('user-security-2fa'),

    adminHealthCpu: document.getElementById('user-admin-health-cpu'),
    adminHealthRam: document.getElementById('user-admin-health-ram'),
    adminHealthLatency: document.getElementById('user-admin-health-latency'),
    adminHealthQueue: document.getElementById('user-admin-health-queue'),
    adminHealthDb: document.getElementById('user-admin-health-db'),
    adminHealthCpuMeta: document.getElementById('user-admin-health-cpu-meta'),
    adminHealthRamMeta: document.getElementById('user-admin-health-ram-meta'),
    adminHealthLatencyMeta: document.getElementById('user-admin-health-latency-meta'),
    adminHealthQueueMeta: document.getElementById('user-admin-health-queue-meta'),
    adminHealthDbMeta: document.getElementById('user-admin-health-db-meta'),
    adminHealthCpuBar: document.getElementById('user-admin-health-cpu-bar'),
    adminHealthRamBar: document.getElementById('user-admin-health-ram-bar'),
    adminHealthLatencyBar: document.getElementById('user-admin-health-latency-bar'),
    adminHealthQueueBar: document.getElementById('user-admin-health-queue-bar'),
    adminHealthDbBadge: document.getElementById('user-admin-health-db-badge'),

    adminModerationList: document.getElementById('user-admin-moderation-list'),
    adminModerationFilterSeverity: document.getElementById('user-admin-moderation-filter-severity'),
    adminModerationFilterType: document.getElementById('user-admin-moderation-filter-type'),
    adminModerationPagination: document.getElementById('user-admin-moderation-pagination'),
    adminModerationPageMeta: document.getElementById('user-admin-moderation-page-meta'),
    adminModerationPageCounter: document.getElementById('user-admin-moderation-page-counter'),
    adminModerationPrevBtn: document.getElementById('user-admin-moderation-prev'),
    adminModerationNextBtn: document.getElementById('user-admin-moderation-next'),
    adminSessionsList: document.getElementById('user-admin-sessions-list'),
    adminSessionsPagination: document.getElementById('user-admin-sessions-pagination'),
    adminSessionsPageMeta: document.getElementById('user-admin-sessions-page-meta'),
    adminSessionsPageCounter: document.getElementById('user-admin-sessions-page-counter'),
    adminSessionsPrevBtn: document.getElementById('user-admin-sessions-prev'),
    adminSessionsNextBtn: document.getElementById('user-admin-sessions-next'),
    adminUsersList: document.getElementById('user-admin-users-list'),
    adminUsersPagination: document.getElementById('user-admin-users-pagination'),
    adminUsersPageMeta: document.getElementById('user-admin-users-page-meta'),
    adminUsersPageCounter: document.getElementById('user-admin-users-page-counter'),
    adminUsersPrevBtn: document.getElementById('user-admin-users-prev'),
    adminUsersNextBtn: document.getElementById('user-admin-users-next'),
    adminBansList: document.getElementById('user-admin-bans-list'),
    adminAuditList: document.getElementById('user-admin-audit-list'),
    adminAuditFilterStatus: document.getElementById('user-admin-audit-filter-status'),
    adminAuditSearch: document.getElementById('user-admin-audit-search'),
    adminAuditPagination: document.getElementById('user-admin-audit-pagination'),
    adminAuditPageMeta: document.getElementById('user-admin-audit-page-meta'),
    adminAuditPageCounter: document.getElementById('user-admin-audit-page-counter'),
    adminAuditPrevBtn: document.getElementById('user-admin-audit-prev'),
    adminAuditNextBtn: document.getElementById('user-admin-audit-next'),
    adminFlagsList: document.getElementById('user-admin-flags-list'),
    adminAlertsList: document.getElementById('user-admin-alerts-list'),
    adminAlertsPagination: document.getElementById('user-admin-alerts-pagination'),
    adminAlertsPageMeta: document.getElementById('user-admin-alerts-page-meta'),
    adminAlertsPageCounter: document.getElementById('user-admin-alerts-page-counter'),
    adminAlertsPrevBtn: document.getElementById('user-admin-alerts-prev'),
    adminAlertsNextBtn: document.getElementById('user-admin-alerts-next'),
    adminOpsStatus: document.getElementById('user-admin-ops-status'),
    riskCpu: document.getElementById('user-risk-cpu'),
    riskSpam: document.getElementById('user-risk-spam'),
    riskBans: document.getElementById('user-risk-bans'),
    riskErrors: document.getElementById('user-risk-errors'),

    adminSearchForm: document.getElementById('user-admin-search-form'),
    adminSearchInput: document.getElementById('user-admin-search-input'),
    adminSearchBtn: document.getElementById('user-admin-search-btn'),
    adminSearchResults: document.getElementById('user-admin-search-results'),

    adminExportMetricsJsonBtn: document.getElementById('user-admin-export-metrics-json'),
    adminExportMetricsCsvBtn: document.getElementById('user-admin-export-metrics-csv'),
    adminExportEventsJsonBtn: document.getElementById('user-admin-export-events-json'),
    adminExportEventsCsvBtn: document.getElementById('user-admin-export-events-csv'),
    adminOpButtons: Array.from(document.querySelectorAll('[data-admin-op-action]')),
  };

  const state = {
    apiBasePath: String(root.dataset.apiBasePath || DEFAULT_API_BASE_PATH).trim() || DEFAULT_API_BASE_PATH,
    stickersPath: String(root.dataset.stickersPath || DEFAULT_STICKERS_PATH).trim() || DEFAULT_STICKERS_PATH,
    loginPath: String(root.dataset.loginPath || DEFAULT_LOGIN_PATH).trim() || DEFAULT_LOGIN_PATH,
    botPhone: '',
    adminBusy: false,
    adminStatusPayload: null,
    adminOverviewPayload: null,
    previousAdminOverviewPayload: null,
    adminSearchPayload: null,
    adminOpsMessage: '',
    compactMode: false,
    moderationFilterSeverity: 'all',
    moderationFilterType: 'all',
    moderationPage: 1,
    moderationPageSize: 6,
    usersPage: 1,
    usersPageSize: 6,
    sessionsPage: 1,
    sessionsPageSize: 6,
    auditFilterStatus: 'all',
    auditSearchQuery: '',
    auditPage: 1,
    auditPageSize: 6,
    alertsPage: 1,
    alertsPageSize: 6,
    adminCarouselIndex: 0,
  };

  const sessionApiPath = `${state.apiBasePath}/auth/google/session`;
  const myProfileApiPath = `${state.apiBasePath}/me`;
  const botContactApiPath = `${state.apiBasePath}/bot-contact`;
  const adminSessionApiPath = `${state.apiBasePath}/admin/session`;
  const adminOverviewApiPath = `${state.apiBasePath}/admin/overview`;
  const adminForceLogoutApiPath = `${state.apiBasePath}/admin/users/force-logout`;
  const adminFeatureFlagsApiPath = `${state.apiBasePath}/admin/feature-flags`;
  const adminOpsApiPath = `${state.apiBasePath}/admin/ops`;
  const adminSearchApiPath = `${state.apiBasePath}/admin/search`;
  const adminExportApiPath = `${state.apiBasePath}/admin/export`;
  const adminBansApiPath = `${state.apiBasePath}/admin/bans`;
  const COMPACT_MODE_STORAGE_KEY = 'omnizap_admin_compact_mode_v1';
  const CRITICAL_ADMIN_ACTIONS = new Set(['restart_worker', 'clear_cache']);

  const setText = (el, value) => {
    if (!el) return;
    el.textContent = String(value || '');
  };

  const clearNode = (el) => {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  };

  const showError = (message) => {
    if (!ui.error) return;
    const safeMessage = String(message || '').trim();
    ui.error.hidden = !safeMessage;
    if (safeMessage) ui.error.textContent = safeMessage;
  };

  const showAdminError = (message) => {
    if (!ui.adminError) return;
    const safeMessage = String(message || '').trim();
    ui.adminError.hidden = !safeMessage;
    if (safeMessage) {
      ui.adminError.textContent = safeMessage;
      showToast({ kind: 'error', title: 'Erro', message: safeMessage });
    }
  };

  const normalizeSeverity = (value, fallback = 'low') => {
    const normalized = String(value || '')
      .trim()
      .toLowerCase();
    if (['critical', 'high', 'medium', 'low'].includes(normalized)) return normalized;
    if (normalized === 'error') return 'high';
    if (normalized === 'warn' || normalized === 'warning') return 'medium';
    return fallback;
  };

  const setRiskPill = (el, text, tone = 'normal') => {
    if (!el) return;
    el.textContent = text;
    el.title = text;
    el.classList.remove('warn', 'danger');
    if (tone === 'warn') el.classList.add('warn');
    if (tone === 'danger') el.classList.add('danger');
  };

  const setHealthMeter = (el, value, { max = 100, warnAt = 70, dangerAt = 90 } = {}) => {
    if (!el) return;
    const numeric = Number(value);
    const percent = Number.isFinite(numeric) ? Math.max(0, Math.min(100, (numeric / max) * 100)) : 0;
    el.style.width = `${percent.toFixed(1)}%`;
    el.classList.remove('warn', 'danger');
    if (percent >= dangerAt) {
      el.classList.add('danger');
    } else if (percent >= warnAt) {
      el.classList.add('warn');
    }
  };

  const showToast = ({ kind = 'success', title = 'Status', message = '' } = {}) => {
    if (!ui.toastStack) return;
    const text = String(message || '').trim();
    if (!text) return;

    const toast = document.createElement('article');
    toast.className = `toast ${kind}`;

    const headline = document.createElement('strong');
    headline.textContent = String(title || 'Status').trim() || 'Status';
    toast.appendChild(headline);

    const body = document.createElement('p');
    body.textContent = text;
    toast.appendChild(body);

    ui.toastStack.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 3800);
  };

  const normalizeDigits = (value) => String(value || '').replace(/\D+/g, '');
  const normalizeString = (value) => String(value || '').trim();
  const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const toPositiveInt = (value, fallback = 1) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 1) return fallback;
    return Math.floor(numeric);
  };

  const setActiveNavLink = (targetId) => {
    if (!ui.navLinks.length) return;
    const normalizedTarget = normalizeString(targetId).replace(/^#/, '');
    for (const link of ui.navLinks) {
      const href = normalizeString(link.getAttribute('href'));
      const linkTarget = href.startsWith('#') ? href.slice(1) : '';
      link.classList.toggle('active', Boolean(linkTarget) && linkTarget === normalizedTarget);
    }
  };

  const getAdminSubpageSections = () => {
    if (!ui.adminLayout) return [];
    return Array.from(ui.adminLayout.querySelectorAll('.section[data-admin-page]'));
  };

  const resolveAdminSubpageTarget = (value) => {
    const sections = getAdminSubpageSections();
    if (!sections.length) return '';
    const requested = normalizeString(value).replace(/^#/, '');
    if (requested) {
      const hasMatch = sections.some((section) => {
        const pageKey = normalizeString(section.dataset.adminPage || section.id).replace(/^#/, '');
        return pageKey === requested || normalizeString(section.id).replace(/^#/, '') === requested;
      });
      if (hasMatch) return requested;
    }
    const first = sections[0];
    return normalizeString(first?.dataset?.adminPage || first?.id).replace(/^#/, '');
  };

  const activateAdminSubpage = (value, { syncHash = false, resetScroll = true } = {}) => {
    const sections = getAdminSubpageSections();
    if (!sections.length) return false;

    const target = resolveAdminSubpageTarget(value);
    if (!target) return false;

    for (const section of sections) {
      const pageKey = normalizeString(section.dataset.adminPage || section.id).replace(/^#/, '');
      const sectionId = normalizeString(section.id).replace(/^#/, '');
      const visible = pageKey === target || sectionId === target;
      section.hidden = !visible;
      section.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }

    setActiveNavLink(target);
    if (syncHash) {
      const nextHash = `#${target}`;
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, '', nextHash);
      }
    }
    if (resetScroll && ui.viewport) {
      ui.viewport.scrollTo({ top: 0, behavior: 'auto' });
    }
    return true;
  };

  const getAdminCarouselSlides = () => {
    if (!ui.adminLayout) return [];
    return Array.from(ui.adminLayout.children).filter((node) => node instanceof Element && node.classList.contains('section'));
  };

  const isCarouselMode = () => Boolean(ui.adminLayout && ui.adminLayout.dataset.carouselEnabled === 'true' && document.body.classList.contains('compact'));

  const updateAdminCarouselControls = (slides = getAdminCarouselSlides()) => {
    const carouselMode = isCarouselMode();
    const total = slides.length;
    if (ui.adminCarouselNav) ui.adminCarouselNav.hidden = !carouselMode || total <= 1;
    if (!carouselMode) {
      if (ui.adminLayout) ui.adminLayout.style.blockSize = '';
      if (ui.adminCarouselPrevBtn) ui.adminCarouselPrevBtn.disabled = true;
      if (ui.adminCarouselNextBtn) ui.adminCarouselNextBtn.disabled = true;
      if (ui.adminCarouselCounter) ui.adminCarouselCounter.textContent = `${Math.min(state.adminCarouselIndex + 1, Math.max(total, 1))} / ${Math.max(total, 1)}`;
      return;
    }

    if (!total) {
      if (ui.adminCarouselCounter) ui.adminCarouselCounter.textContent = '0 / 0';
      if (ui.adminCarouselPrevBtn) ui.adminCarouselPrevBtn.disabled = true;
      if (ui.adminCarouselNextBtn) ui.adminCarouselNextBtn.disabled = true;
      state.adminCarouselIndex = 0;
      return;
    }

    const nextIndex = Math.max(0, Math.min(state.adminCarouselIndex, total - 1));
    state.adminCarouselIndex = nextIndex;
    const activeSlide = slides[nextIndex];
    if (ui.adminLayout && activeSlide) {
      const viewportRatio = state.compactMode ? 0.62 : 0.68;
      const maxHeight = Math.max(300, Math.round(window.innerHeight * viewportRatio));
      const targetHeight = Math.min(Math.max(activeSlide.scrollHeight, 300), maxHeight);
      ui.adminLayout.style.blockSize = `${targetHeight}px`;
    }

    if (ui.adminCarouselCounter) {
      ui.adminCarouselCounter.textContent = `${nextIndex + 1} / ${total}`;
    }
    if (ui.adminCarouselPrevBtn) ui.adminCarouselPrevBtn.disabled = nextIndex <= 0;
    if (ui.adminCarouselNextBtn) ui.adminCarouselNextBtn.disabled = nextIndex >= total - 1;
  };

  const scrollAdminCarouselToIndex = (index, { behavior = 'smooth' } = {}) => {
    if (!isCarouselMode()) return false;
    const slides = getAdminCarouselSlides();
    if (!slides.length || !ui.adminLayout) return false;

    const boundedIndex = Math.max(0, Math.min(Number(index) || 0, slides.length - 1));
    state.adminCarouselIndex = boundedIndex;
    const targetSlide = slides[boundedIndex];
    ui.adminLayout.scrollTo({
      left: targetSlide.offsetLeft,
      behavior,
    });
    updateAdminCarouselControls(slides);
    if (targetSlide.id) setActiveNavLink(targetSlide.id);
    return true;
  };

  const scrollAdminCarouselToId = (targetId, options = {}) => {
    if (!isCarouselMode()) return false;
    const normalizedTarget = normalizeString(targetId).replace(/^#/, '');
    if (!normalizedTarget) return false;
    const slides = getAdminCarouselSlides();
    const nextIndex = slides.findIndex((slide) => slide.id === normalizedTarget);
    if (nextIndex < 0) return false;
    return scrollAdminCarouselToIndex(nextIndex, options);
  };

  const bindAdminCarousel = () => {
    if (!ui.adminLayout) return;
    const slides = getAdminCarouselSlides();
    if (!slides.length) return;

    let rafToken = 0;
    const syncFromScroll = () => {
      if (!isCarouselMode()) return;
      if (!ui.adminLayout) return;
      const currentLeft = ui.adminLayout.scrollLeft;
      let closestIndex = state.adminCarouselIndex;
      let closestDistance = Number.POSITIVE_INFINITY;

      for (let index = 0; index < slides.length; index += 1) {
        const distance = Math.abs(slides[index].offsetLeft - currentLeft);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      }

      if (closestIndex !== state.adminCarouselIndex) {
        state.adminCarouselIndex = closestIndex;
        if (slides[closestIndex]?.id) setActiveNavLink(slides[closestIndex].id);
      }
      updateAdminCarouselControls(slides);
    };

    ui.adminLayout.addEventListener(
      'scroll',
      () => {
        if (rafToken) return;
        rafToken = window.requestAnimationFrame(() => {
          rafToken = 0;
          syncFromScroll();
        });
      },
      { passive: true },
    );

    if (ui.adminCarouselPrevBtn) {
      ui.adminCarouselPrevBtn.addEventListener('click', () => {
        if (!isCarouselMode()) return;
        scrollAdminCarouselToIndex(state.adminCarouselIndex - 1);
      });
    }

    if (ui.adminCarouselNextBtn) {
      ui.adminCarouselNextBtn.addEventListener('click', () => {
        if (!isCarouselMode()) return;
        scrollAdminCarouselToIndex(state.adminCarouselIndex + 1);
      });
    }

    for (const link of ui.navLinks) {
      const href = normalizeString(link.getAttribute('href'));
      if (!href.startsWith('#')) continue;
      const targetId = href.slice(1);
      if (!targetId) continue;
      link.addEventListener('click', (event) => {
        if (!isCarouselMode()) return;
        if (!scrollAdminCarouselToId(targetId)) return;
        event.preventDefault();
      });
    }

    window.addEventListener('resize', () => {
      if (!isCarouselMode()) {
        updateAdminCarouselControls();
        return;
      }
      scrollAdminCarouselToIndex(state.adminCarouselIndex, { behavior: 'auto' });
    });

    const hashTarget = normalizeString(window.location.hash);
    if (isCarouselMode() && hashTarget && scrollAdminCarouselToId(hashTarget, { behavior: 'auto' })) {
      return;
    }
    updateAdminCarouselControls(slides);
  };

  const setPaginationHidden = ({ wrapper, counter, meta }) => {
    if (wrapper) wrapper.hidden = true;
    if (counter) counter.textContent = '1 / 1';
    if (meta) meta.textContent = '';
  };

  const paginateItems = ({ items = [], statePageKey = '', pageSize = 10, wrapper = null, counter = null, meta = null, prevBtn = null, nextBtn = null } = {}) => {
    const safeItems = Array.isArray(items) ? items : [];
    const safePageSize = toPositiveInt(pageSize, 10);

    if (!safeItems.length) {
      setPaginationHidden({ wrapper, counter, meta });
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return [];
    }

    const totalPages = Math.max(1, Math.ceil(safeItems.length / safePageSize));
    const page = Math.min(Math.max(1, toPositiveInt(state[statePageKey], 1)), totalPages);
    state[statePageKey] = page;

    const startIndex = (page - 1) * safePageSize;
    const endIndex = Math.min(startIndex + safePageSize, safeItems.length);
    const pageItems = safeItems.slice(startIndex, endIndex);

    if (wrapper) wrapper.hidden = safeItems.length <= safePageSize;
    if (counter) counter.textContent = `${page} / ${totalPages}`;
    if (meta) meta.textContent = `Mostrando ${startIndex + 1}-${endIndex} de ${safeItems.length}`;
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;

    return pageItems;
  };

  const formatPhone = (digits) => {
    const value = normalizeDigits(digits);
    if (!value) return '';
    if (value.length <= 4) return value;
    return `${value.slice(0, 2)} ${value.slice(2, -4)}-${value.slice(-4)}`.trim();
  };

  const formatNumber = (value) =>
    new Intl.NumberFormat('pt-BR', {
      maximumFractionDigits: 0,
    }).format(Math.max(0, Number(value || 0)));

  const formatDateTime = (value) => {
    const ms = Date.parse(String(value || ''));
    if (!Number.isFinite(ms)) return 'n/d';
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
  };

  const formatRelativeTime = (value) => {
    const ms = Date.parse(String(value || ''));
    if (!Number.isFinite(ms)) return 'n/d';
    const deltaMs = __timeNowMs() - ms;
    const absMs = Math.abs(deltaMs);
    const suffix = deltaMs >= 0 ? 'atrás' : 'à frente';
    if (absMs < 1000) return 'agora';
    const seconds = Math.round(absMs / 1000);
    if (seconds < 60) return `${seconds}s ${suffix}`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ${suffix}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ${suffix}`;
    const days = Math.round(hours / 24);
    return `${days}d ${suffix}`;
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

  const formatIntegerOrNd = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 'n/d';
    return formatNumber(numeric);
  };

  const toFiniteNumber = (value, fallback = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  };

  const formatDeltaLabel = (current, previous, { percent = true, suffix = '' } = {}) => {
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
  };

  const setMetricContext = (el, value) => {
    if (!el) return;
    el.textContent = String(value || '').trim() || 'n/d';
  };

  const setButtonProcessing = (button, processingText = 'Processando...') => {
    if (!button) return;
    if (!button.dataset.idleText) {
      button.dataset.idleText = button.textContent || '';
    }
    button.disabled = true;
    button.dataset.state = 'processing';
    button.textContent = processingText;
  };

  const setButtonIdle = (button) => {
    if (!button) return;
    button.disabled = false;
    button.dataset.state = 'idle';
    if (button.dataset.idleText) {
      button.textContent = button.dataset.idleText;
    }
  };

  const flashButtonSuccess = (button, successText = 'Concluído', timeoutMs = 1200) => {
    if (!button) return;
    const idleText = button.dataset.idleText || button.textContent || '';
    button.textContent = successText;
    button.dataset.state = 'success';
    window.setTimeout(() => {
      button.dataset.state = 'idle';
      button.textContent = idleText;
    }, timeoutMs);
  };

  const resolveEnvironmentLabel = () => {
    const host = String(window.location.hostname || '').toLowerCase();
    if (host.includes('localhost') || host.includes('127.0.0.1') || host.includes('staging') || host.includes('dev')) return 'Staging';
    return 'Production';
  };

  const applyEnvironmentBadge = () => {
    if (!ui.envBadge) return;
    ui.envBadge.textContent = resolveEnvironmentLabel();
  };

  const setGlobalStatusChip = (tone = 'online', text = 'Online') => {
    if (!ui.globalStatus || !ui.globalStatusText) return;
    ui.globalStatus.classList.remove('warning', 'incident');
    if (tone === 'warning') ui.globalStatus.classList.add('warning');
    if (tone === 'incident') ui.globalStatus.classList.add('incident');
    ui.globalStatusText.textContent = text;
  };

  const updateSecurityStrip = (sessionData = null) => {
    const ownerJid = normalizeString(sessionData?.owner_jid);
    const secureProtocol = window.location.protocol === 'https:';
    const ipLabel = 'IP mascarado';
    const isTwoFactorPossible = Boolean(ownerJid);

    setText(ui.securitySession, secureProtocol ? 'Sessão segura (HTTPS)' : 'Sessão sem HTTPS');
    setText(ui.securityEncryption, secureProtocol ? 'Criptografia ativa TLS' : 'Criptografia limitada');
    setText(ui.securityIp, ipLabel);
    setText(ui.security2fa, isTwoFactorPossible ? '2FA: disponível' : '2FA: n/d');
  };

  const buildRegex = (query) => {
    const source = String(query || '')
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!source) return null;
    return new RegExp(source, 'ig');
  };

  const appendHighlightedText = (target, text, query) => {
    if (!target) return;
    const content = String(text || '');
    const pattern = buildRegex(query);
    if (!pattern) {
      target.textContent = content;
      return;
    }

    target.textContent = '';
    let lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const start = match.index || 0;
      if (start > lastIndex) {
        target.appendChild(document.createTextNode(content.slice(lastIndex, start)));
      }
      const mark = document.createElement('mark');
      mark.textContent = content.slice(start, start + match[0].length);
      target.appendChild(mark);
      lastIndex = start + match[0].length;
    }
    if (lastIndex < content.length) {
      target.appendChild(document.createTextNode(content.slice(lastIndex)));
    }
  };

  const confirmCriticalAction = (message) => window.confirm(message);

  const buildLoginRedirectUrl = () => {
    const loginUrl = new URL(state.loginPath, window.location.origin);
    const nextPath = `${window.location.pathname || '/user/systemadm/'}${window.location.search || ''}`;
    loginUrl.searchParams.set('next', nextPath);
    return `${loginUrl.pathname}${loginUrl.search}`;
  };

  const buildWhatsAppMenuUrl = (phoneDigits) => {
    const params = new URLSearchParams({
      text: '/menu',
      type: 'custom_url',
      app_absent: '0',
    });
    const digits = normalizeDigits(phoneDigits);
    if (digits) params.set('phone', digits);
    return `https://api.whatsapp.com/send/?${params.toString()}`;
  };

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
      const err = new Error(payload?.error || `Falha HTTP ${response.status}`);
      err.statusCode = response.status;
      throw err;
    }
    return payload || {};
  };

  const fetchWithAuth = async (url, init = {}) => {
    const response = await fetch(url, {
      credentials: 'include',
      ...init,
    });
    if (!response.ok) {
      let message = `Falha HTTP ${response.status}`;
      try {
        const payload = await response.json();
        if (payload?.error) message = payload.error;
      } catch {
        // noop
      }
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }
    return response;
  };

  const redirectToLogin = () => {
    window.location.assign(buildLoginRedirectUrl());
  };

  const normalizeOwnerJidCandidate = (value) => {
    const jid = normalizeString(value);
    if (!jid || !jid.includes('@')) return '';
    if (jid.endsWith('@g.us')) return '';
    return jid;
  };

  const compactIdentityPayload = (raw = {}) => {
    const payload = {};
    const sessionToken = normalizeString(raw.session_token);
    const googleSub = normalizeString(raw.google_sub);
    const email = normalizeString(raw.email);
    const ownerJid = normalizeOwnerJidCandidate(raw.owner_jid);
    if (sessionToken) payload.session_token = sessionToken;
    if (googleSub) payload.google_sub = googleSub;
    if (email) payload.email = email;
    if (ownerJid) payload.owner_jid = ownerJid;
    return payload;
  };

  const buildIdentityLabel = (identity = {}) => {
    const email = normalizeString(identity.email);
    const ownerJid = normalizeString(identity.owner_jid);
    const googleSub = normalizeString(identity.google_sub);
    const sessionToken = normalizeString(identity.session_token);
    if (email) return email;
    if (ownerJid) return ownerJid;
    if (googleSub) return googleSub;
    if (sessionToken) return `${sessionToken.slice(0, 8)}...`;
    return 'identidade';
  };

  const getAdminSession = () => state.adminStatusPayload?.session || null;
  const isAdminAuthenticated = () => Boolean(getAdminSession()?.authenticated);
  const isAdminEligible = () => Boolean(state.adminStatusPayload?.eligible_google_login || isAdminAuthenticated());

  const resolveAdminRole = () =>
    String(getAdminSession()?.role || state.adminStatusPayload?.eligible_role || '')
      .trim()
      .toLowerCase();

  const formatAdminRole = (role) => {
    if (role === 'owner') return 'dono';
    if (role === 'moderator') return 'moderador';
    return 'admin';
  };

  const createItemMeta = (text) => {
    const p = document.createElement('p');
    p.className = 'admin-item-meta';
    p.textContent = text;
    return p;
  };

  const createBadge = (label, severity = 'low') => {
    const normalizedSeverity = ['critical', 'high', 'medium', 'low'].includes(String(severity)) ? String(severity) : 'low';
    const badge = document.createElement('span');
    badge.className = `admin-badge ${normalizedSeverity}`;
    badge.textContent = String(label || '').trim() || normalizedSeverity.toUpperCase();
    return badge;
  };

  const createMiniButton = (label, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'admin-mini-btn';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (typeof onClick === 'function') void onClick();
    });
    return button;
  };

  const createMiniLink = (label, href) => {
    const link = document.createElement('a');
    link.className = 'admin-mini-btn';
    link.textContent = label;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    return link;
  };

  const renderListPlaceholder = (container, message) => {
    if (!container) return;
    clearNode(container);
    container.appendChild(createItemMeta(message));
  };

  const appendListItem = ({ container, title, severity = '', badgeLabel = '', meta = [], actions = [], customNode = null, itemData = {}, highlightQuery = '' }) => {
    if (!container) return;

    const item = document.createElement('article');
    item.className = 'admin-item';
    for (const [key, value] of Object.entries(itemData || {})) {
      item.dataset[key] = String(value || '');
    }

    const titleEl = document.createElement('p');
    titleEl.className = 'admin-item-title';
    appendHighlightedText(titleEl, title, highlightQuery);
    item.appendChild(titleEl);

    if (badgeLabel) {
      item.appendChild(createBadge(badgeLabel, severity));
    }

    for (const line of meta) {
      const text = normalizeString(line);
      if (!text) continue;
      const metaNode = createItemMeta('');
      appendHighlightedText(metaNode, text, highlightQuery);
      item.appendChild(metaNode);
    }

    if (customNode) item.appendChild(customNode);

    if (Array.isArray(actions) && actions.length) {
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'admin-item-actions';
      for (const actionNode of actions) {
        if (actionNode instanceof Element) actionsWrap.appendChild(actionNode);
      }
      if (actionsWrap.childNodes.length > 0) {
        item.appendChild(actionsWrap);
      }
    }

    container.appendChild(item);
  };

  const setAdminBusy = (value) => {
    const busy = Boolean(value);
    state.adminBusy = busy;
    document.body.dataset.adminBusy = busy ? 'true' : 'false';

    const authenticated = isAdminAuthenticated();
    const eligible = isAdminEligible();

    if (ui.adminPanel) {
      const controls = ui.adminPanel.querySelectorAll('button, input, select, textarea');
      for (const control of controls) {
        const inUnlockForm = Boolean(control.closest('#user-admin-unlock-form'));
        const inOverview = Boolean(control.closest('#user-admin-overview'));
        if (inUnlockForm) {
          control.disabled = busy || !eligible || authenticated;
          continue;
        }
        if (inOverview) {
          control.disabled = busy || !authenticated;
          continue;
        }
        control.disabled = busy;
      }
    }

    if (ui.adminPassword) ui.adminPassword.disabled = busy || !isAdminEligible() || isAdminAuthenticated();
    if (ui.adminUnlockBtn) ui.adminUnlockBtn.disabled = busy || !isAdminEligible() || isAdminAuthenticated();
    if (ui.adminRefreshBtn) ui.adminRefreshBtn.disabled = busy || !isAdminAuthenticated();
    if (ui.adminLogoutBtn) ui.adminLogoutBtn.disabled = busy || !isAdminAuthenticated();
  };

  const renderSession = (sessionData) => {
    const user = sessionData?.user || {};
    const ownerPhone = normalizeString(sessionData?.owner_phone);
    const ownerJid = normalizeString(sessionData?.owner_jid);

    setText(ui.name, user?.name || 'Conta Google');
    setText(ui.email, user?.email || 'Email não disponível');
    if (ownerPhone) {
      setText(ui.whatsapp, `WhatsApp vinculado: +${formatPhone(ownerPhone)}`);
    } else if (ownerJid) {
      setText(ui.whatsapp, `WhatsApp vinculado via owner: ${ownerJid}`);
    } else {
      setText(ui.whatsapp, 'WhatsApp não vinculado.');
    }

    if (ui.avatar) {
      const picture = normalizeString(user?.picture) || FALLBACK_AVATAR;
      ui.avatar.src = picture;
      ui.avatar.onerror = () => {
        ui.avatar.src = FALLBACK_AVATAR;
      };
      if (ui.topAvatar) {
        ui.topAvatar.src = picture;
        ui.topAvatar.onerror = () => {
          ui.topAvatar.src = FALLBACK_AVATAR;
        };
      }
    }

    setText(ui.topAdminName, normalizeString(user?.name) || 'Admin');
    updateSecurityStrip(sessionData);

    setText(ui.ownerJid, ownerJid || 'n/d');
    setText(ui.googleSub, normalizeString(user?.sub) || 'n/d');
    setText(ui.expiresAt, formatDateTime(sessionData?.expires_at));

    if (ui.profile) ui.profile.hidden = false;
    if (ui.summary) ui.summary.hidden = false;
    if (ui.actions) ui.actions.hidden = false;
  };

  const renderPackMetrics = (payload) => {
    const data = payload?.data || {};
    const packs = Array.isArray(data?.packs) ? data.packs : [];
    const stats = isObject(data?.stats) ? data.stats : {};

    let stickers = 0;
    let downloads = 0;
    let likes = 0;

    for (const pack of packs) {
      stickers += Number(pack?.sticker_count || 0);
      downloads += Number(pack?.engagement?.open_count || 0);
      likes += Number(pack?.engagement?.like_count || 0);
    }

    setText(ui.metricPacks, formatNumber(stats.total || packs.length));
    setText(ui.metricStickers, formatNumber(stickers));
    setText(ui.metricDownloads, formatNumber(downloads));
    setText(ui.metricLikes, formatNumber(likes));
    if (ui.grid) ui.grid.hidden = false;
  };

  const setAdminMetricsDefaults = () => {
    setText(ui.adminBotsOnline, '0');
    setText(ui.adminMessagesToday, 'n/d');
    setText(ui.adminSpamBlocked, 'n/d');
    setText(ui.adminUptime, 'n/d');
    setText(ui.adminErrors5xx, '0');
    setText(ui.adminTotalPacks, '0');
    setText(ui.adminTotalStickers, '0');
    setText(ui.adminActiveBans, '0');
    setText(ui.adminKnownUsers, '0');
    setText(ui.adminActiveSessions, '0');
    setText(ui.adminVisits24h, '0');
    setText(ui.adminVisits7d, '0');
    setText(ui.adminUniqueVisitors7d, '0');
    setMetricContext(ui.adminBotsOnlineContext, 'vs ontem: n/d');
    setMetricContext(ui.adminMessagesTodayContext, 'vs ontem: n/d');
    setMetricContext(ui.adminUptimeContext, 'janela: processo atual');
    setMetricContext(ui.adminErrors5xxContext, 'vs ontem: n/d');
    setMetricContext(ui.adminTotalPacksContext, 'delta 24h: n/d');
    setMetricContext(ui.adminTotalStickersContext, 'delta 24h: n/d');
    setMetricContext(ui.adminSpamBlockedContext, 'vs ontem: n/d');
    setMetricContext(ui.adminActiveBansContext, 'delta 24h: n/d');
    setMetricContext(ui.adminKnownUsersContext, 'delta 7d: n/d');
    setMetricContext(ui.adminActiveSessionsContext, 'agora: n/d');
    setMetricContext(ui.adminVisits24hContext, 'janela: 24h');
    setMetricContext(ui.adminVisits7dContext, 'janela: 7 dias');
    setMetricContext(ui.adminUniqueVisitors7dContext, 'janela: 7 dias');

    setText(ui.adminHealthCpu, 'n/d');
    setText(ui.adminHealthRam, 'n/d');
    setText(ui.adminHealthLatency, 'n/d');
    setText(ui.adminHealthQueue, 'n/d');
    setText(ui.adminHealthDb, 'n/d');
    setText(ui.adminHealthCpuMeta, 'Limite recomendado: 88%');
    setText(ui.adminHealthRamMeta, 'Limite recomendado: 90%');
    setText(ui.adminHealthLatencyMeta, 'Alerta acima de 300ms');
    setText(ui.adminHealthQueueMeta, 'Ideal: abaixo de 120 jobs');
    setText(ui.adminHealthDbMeta, 'SLA alvo: 99.95%');
    setText(ui.adminLastUpdated, 'n/d');
    state.moderationPage = 1;
    state.auditPage = 1;
    state.usersPage = 1;
    state.sessionsPage = 1;
    state.alertsPage = 1;
    if (ui.adminHealthDbBadge) {
      ui.adminHealthDbBadge.classList.remove('healthy', 'degraded', 'down');
      ui.adminHealthDbBadge.textContent = 'Unknown';
    }
    setHealthMeter(ui.adminHealthCpuBar, 0);
    setHealthMeter(ui.adminHealthRamBar, 0);
    setHealthMeter(ui.adminHealthLatencyBar, 0);
    setHealthMeter(ui.adminHealthQueueBar, 0);

    renderListPlaceholder(ui.adminModerationList, 'Nenhum evento recente de moderação.');
    renderListPlaceholder(ui.adminSessionsList, 'Nenhuma sessão ativa encontrada.');
    renderListPlaceholder(ui.adminUsersList, 'Nenhum usuário encontrado.');
    renderListPlaceholder(ui.adminBansList, 'Nenhuma conta bloqueada.');
    renderListPlaceholder(ui.adminAuditList, 'Sem eventos de auditoria recentes.');
    setPaginationHidden({
      wrapper: ui.adminModerationPagination,
      counter: ui.adminModerationPageCounter,
      meta: ui.adminModerationPageMeta,
    });
    setPaginationHidden({
      wrapper: ui.adminAuditPagination,
      counter: ui.adminAuditPageCounter,
      meta: ui.adminAuditPageMeta,
    });
    setPaginationHidden({
      wrapper: ui.adminUsersPagination,
      counter: ui.adminUsersPageCounter,
      meta: ui.adminUsersPageMeta,
    });
    setPaginationHidden({
      wrapper: ui.adminSessionsPagination,
      counter: ui.adminSessionsPageCounter,
      meta: ui.adminSessionsPageMeta,
    });
    setPaginationHidden({
      wrapper: ui.adminAlertsPagination,
      counter: ui.adminAlertsPageCounter,
      meta: ui.adminAlertsPageMeta,
    });
    renderListPlaceholder(ui.adminFlagsList, 'Nenhuma feature flag disponível.');
    renderListPlaceholder(ui.adminAlertsList, 'Sem alertas ativos no momento.');
    renderListPlaceholder(ui.adminSearchResults, 'Faça uma busca para ver usuários, grupos, packs e sessões.');
    setText(ui.adminOpsStatus, state.adminOpsMessage || 'Ações operacionais disponíveis.');
    setRiskPill(ui.riskCpu, 'CPU normal');
    setRiskPill(ui.riskSpam, 'Spam sob controle');
    setRiskPill(ui.riskBans, 'Bans estáveis');
    setRiskPill(ui.riskErrors, 'Erros baixos');
    updateSecurityStrip(null);
    setGlobalStatusChip('online', 'Online');
  };

  const buildBanPayloadFromEvent = (event) => {
    const metadata = isObject(event?.metadata) ? event.metadata : {};
    const payload = compactIdentityPayload({
      google_sub: metadata.google_sub,
      email: metadata.email,
      owner_jid: event?.sender_id || metadata.owner_jid,
    });
    if (!Object.keys(payload).length) return null;
    payload.reason = `Ban via moderação (${normalizeString(event?.event_type) || 'evento'})`;
    return payload;
  };

  const buildForceLogoutPayloadFromAny = (entry = {}) =>
    compactIdentityPayload({
      session_token: entry?.session_token,
      google_sub: entry?.google_sub,
      email: entry?.email,
      owner_jid: entry?.owner_jid,
    });

  const handleAdminForceLogout = async (identity, contextLabel = '') => {
    const payload = compactIdentityPayload(identity);
    if (!Object.keys(payload).length) {
      showAdminError('Não foi possível forçar logout: identidade ausente.');
      return;
    }
    if (state.adminBusy) return;

    const label = normalizeString(contextLabel) || buildIdentityLabel(payload);
    if (!confirmCriticalAction(`Forçar logout de ${label}?`)) {
      return;
    }

    showAdminError('');
    setAdminBusy(true);
    try {
      const response = await fetchJson(adminForceLogoutApiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      const removed = Number(response?.data?.removed_sessions || 0);
      state.adminOpsMessage = `Logout forçado concluído para ${label}. Sessões removidas: ${removed}.`;
      showToast({ kind: 'success', title: 'Sessão', message: state.adminOpsMessage });
      await refreshAdminArea({ keepCurrentError: true });
    } catch (error) {
      showAdminError(error?.message || 'Falha ao forçar logout.');
    } finally {
      setAdminBusy(false);
      renderAdminPanel();
    }
  };

  const handleAdminBanCreate = async (banPayload, contextLabel = '') => {
    if (!isObject(banPayload)) return;
    const payload = {
      ...compactIdentityPayload(banPayload),
      reason: normalizeString(banPayload.reason),
    };
    if (!payload.google_sub && !payload.email && !payload.owner_jid) {
      showAdminError('Não foi possível banir: identidade ausente.');
      return;
    }
    if (state.adminBusy) return;

    const label = normalizeString(contextLabel) || buildIdentityLabel(payload);
    if (!confirmCriticalAction(`Confirmar bloqueio da conta ${label}?`)) {
      return;
    }

    showAdminError('');
    setAdminBusy(true);
    try {
      const response = await fetchJson(adminBansApiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      const created = Boolean(response?.data?.created);
      state.adminOpsMessage = created ? `Conta banida: ${label}.` : `Conta já estava banida: ${label}.`;
      showToast({
        kind: created ? 'warn' : 'success',
        title: 'Ban',
        message: state.adminOpsMessage,
      });
      await refreshAdminArea({ keepCurrentError: true });
    } catch (error) {
      showAdminError(error?.message || 'Falha ao criar ban.');
    } finally {
      setAdminBusy(false);
      renderAdminPanel();
    }
  };

  const handleAdminBanRevoke = async (banId) => {
    const normalizedId = normalizeString(banId);
    if (!normalizedId || state.adminBusy) return;
    if (!confirmCriticalAction(`Revogar ban ${normalizedId}?`)) return;

    showAdminError('');
    setAdminBusy(true);
    try {
      await fetchJson(`${adminBansApiPath}/${encodeURIComponent(normalizedId)}/revoke`, {
        method: 'DELETE',
      });
      state.adminOpsMessage = `Ban ${normalizedId} revogado com sucesso.`;
      showToast({ kind: 'success', title: 'Ban', message: state.adminOpsMessage });
      await refreshAdminArea({ keepCurrentError: true });
    } catch (error) {
      showAdminError(error?.message || 'Falha ao revogar ban.');
    } finally {
      setAdminBusy(false);
      renderAdminPanel();
    }
  };

  const handleAdminFeatureFlagUpdate = async ({ flagName = '', isEnabled = false, rolloutPercent = 100, description = '' } = {}) => {
    const normalizedName = normalizeString(flagName);
    if (!normalizedName || state.adminBusy) return;

    showAdminError('');
    setAdminBusy(true);
    try {
      await fetchJson(adminFeatureFlagsApiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          flag_name: normalizedName,
          is_enabled: Boolean(isEnabled),
          rollout_percent: Math.max(0, Math.min(100, Math.floor(Number(rolloutPercent) || 0))),
          description: normalizeString(description),
        }),
      });
      state.adminOpsMessage = `Feature flag ${normalizedName} atualizada.`;
      showToast({ kind: 'success', title: 'Feature Flag', message: state.adminOpsMessage });
      await refreshAdminArea({ keepCurrentError: true });
    } catch (error) {
      showAdminError(error?.message || 'Falha ao atualizar feature flag.');
    } finally {
      setAdminBusy(false);
      renderAdminPanel();
    }
  };

  const handleAdminOpsAction = async (action, triggerButton = null) => {
    const normalizedAction = normalizeString(action);
    if (!normalizedAction || state.adminBusy) return;
    if (CRITICAL_ADMIN_ACTIONS.has(normalizedAction)) {
      const confirmed = confirmCriticalAction(`Executar ação crítica: ${normalizedAction.replace(/_/g, ' ')}?`);
      if (!confirmed) return;
    }

    showAdminError('');
    setButtonProcessing(triggerButton, 'Executando...');
    setAdminBusy(true);
    let success = false;
    try {
      const response = await fetchJson(adminOpsApiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ action: normalizedAction }),
      });
      const message = normalizeString(response?.data?.message) || `Ação ${normalizedAction} concluída.`;
      state.adminOpsMessage = `${message} (${formatDateTime(response?.data?.updated_at)})`;
      setText(ui.adminOpsStatus, state.adminOpsMessage);
      showToast({ kind: 'success', title: 'Operação', message: state.adminOpsMessage });
      await refreshAdminArea({ keepCurrentError: true });
      success = true;
    } catch (error) {
      showAdminError(error?.message || 'Falha ao executar ação operacional.');
    } finally {
      setAdminBusy(false);
      setButtonIdle(triggerButton);
      if (success) flashButtonSuccess(triggerButton, 'Executado');
      renderAdminPanel();
    }
  };

  const renderModerationQueue = (events) => {
    const list = Array.isArray(events) ? events : [];
    const severityFilter = normalizeString(state.moderationFilterSeverity || 'all').toLowerCase();
    const typeFilter = normalizeString(state.moderationFilterType || 'all').toLowerCase();
    const filtered = list.filter((event) => {
      const eventSeverity = normalizeSeverity(event?.severity);
      const eventType = normalizeString(event?.event_type || '').toLowerCase();
      const severityOk = severityFilter === 'all' || eventSeverity === severityFilter;
      const typeOk = typeFilter === 'all' || eventType.includes(typeFilter);
      return severityOk && typeOk;
    });
    clearNode(ui.adminModerationList);

    if (!filtered.length) {
      renderListPlaceholder(ui.adminModerationList, 'Nenhum evento recente de moderação.');
      setPaginationHidden({
        wrapper: ui.adminModerationPagination,
        counter: ui.adminModerationPageCounter,
        meta: ui.adminModerationPageMeta,
      });
      if (ui.adminModerationPrevBtn) ui.adminModerationPrevBtn.disabled = true;
      if (ui.adminModerationNextBtn) ui.adminModerationNextBtn.disabled = true;
      return;
    }

    const pageItems = paginateItems({
      items: filtered,
      statePageKey: 'moderationPage',
      pageSize: state.moderationPageSize,
      wrapper: ui.adminModerationPagination,
      counter: ui.adminModerationPageCounter,
      meta: ui.adminModerationPageMeta,
      prevBtn: ui.adminModerationPrevBtn,
      nextBtn: ui.adminModerationNextBtn,
    });

    for (const event of pageItems) {
      const title = normalizeString(event?.title) || 'Evento de moderação';
      const severity = normalizeSeverity(event?.severity);
      const badgeLabel = severity.toUpperCase();
      const createdAt = formatDateTime(event?.created_at || event?.revoked_at);
      const meta = [normalizeString(event?.subtitle), `Tipo: ${normalizeString(event?.event_type) || 'evento'} • ${createdAt}`];

      if (normalizeString(event?.reason)) meta.push(`Motivo: ${normalizeString(event.reason)}`);

      const actions = [];
      if (event?.event_type === 'ban') {
        if (event?.ban_id && !event?.revoked_at) {
          actions.push(createMiniButton('Revogar ban', () => handleAdminBanRevoke(event.ban_id)));
        }
      } else {
        const banPayload = buildBanPayloadFromEvent(event);
        if (banPayload) {
          actions.push(createMiniButton('Banir conta', () => handleAdminBanCreate(banPayload, buildIdentityLabel(banPayload))));
        }
        const logoutPayload = compactIdentityPayload({
          session_token: event?.metadata?.session_token,
          google_sub: event?.metadata?.google_sub,
          email: event?.metadata?.email,
          owner_jid: event?.sender_id || event?.metadata?.owner_jid,
        });
        if (Object.keys(logoutPayload).length) {
          actions.push(createMiniButton('Forçar logout', () => handleAdminForceLogout(logoutPayload, buildIdentityLabel(logoutPayload))));
        }
      }

      appendListItem({
        container: ui.adminModerationList,
        title,
        severity,
        badgeLabel,
        meta,
        actions,
        itemData: {
          severity,
          type: normalizeString(event?.event_type || '').toLowerCase(),
        },
      });
    }
  };

  const renderActiveSessions = (sessions) => {
    const list = Array.isArray(sessions) ? sessions : [];
    clearNode(ui.adminSessionsList);

    if (!list.length) {
      renderListPlaceholder(ui.adminSessionsList, 'Nenhuma sessão ativa encontrada.');
      setPaginationHidden({
        wrapper: ui.adminSessionsPagination,
        counter: ui.adminSessionsPageCounter,
        meta: ui.adminSessionsPageMeta,
      });
      if (ui.adminSessionsPrevBtn) ui.adminSessionsPrevBtn.disabled = true;
      if (ui.adminSessionsNextBtn) ui.adminSessionsNextBtn.disabled = true;
      return;
    }

    const pageItems = paginateItems({
      items: list,
      statePageKey: 'sessionsPage',
      pageSize: state.sessionsPageSize,
      wrapper: ui.adminSessionsPagination,
      counter: ui.adminSessionsPageCounter,
      meta: ui.adminSessionsPageMeta,
      prevBtn: ui.adminSessionsPrevBtn,
      nextBtn: ui.adminSessionsNextBtn,
    });

    for (const session of pageItems) {
      const identity = compactIdentityPayload(session);
      const title = normalizeString(session?.name || session?.email || session?.owner_jid || 'Sessão ativa');
      const meta = [`Email: ${normalizeString(session?.email) || 'n/d'}`, `Owner: ${normalizeString(session?.owner_jid) || 'n/d'}`, `Último acesso: ${formatDateTime(session?.last_seen_at)} • Expira: ${formatDateTime(session?.expires_at)}`];
      const actions = [];
      if (Object.keys(identity).length) {
        actions.push(createMiniButton('Forçar logout', () => handleAdminForceLogout(identity, buildIdentityLabel(identity))));
      }
      appendListItem({
        container: ui.adminSessionsList,
        title,
        severity: 'low',
        badgeLabel: 'ATIVA',
        meta,
        actions,
      });
    }
  };

  const renderKnownUsers = (users) => {
    const list = Array.isArray(users) ? users : [];
    clearNode(ui.adminUsersList);

    if (!list.length) {
      renderListPlaceholder(ui.adminUsersList, 'Nenhum usuário encontrado.');
      setPaginationHidden({
        wrapper: ui.adminUsersPagination,
        counter: ui.adminUsersPageCounter,
        meta: ui.adminUsersPageMeta,
      });
      if (ui.adminUsersPrevBtn) ui.adminUsersPrevBtn.disabled = true;
      if (ui.adminUsersNextBtn) ui.adminUsersNextBtn.disabled = true;
      return;
    }

    const pageItems = paginateItems({
      items: list,
      statePageKey: 'usersPage',
      pageSize: state.usersPageSize,
      wrapper: ui.adminUsersPagination,
      counter: ui.adminUsersPageCounter,
      meta: ui.adminUsersPageMeta,
      prevBtn: ui.adminUsersPrevBtn,
      nextBtn: ui.adminUsersNextBtn,
    });

    for (const user of pageItems) {
      const identity = buildForceLogoutPayloadFromAny(user);
      const title = normalizeString(user?.name || user?.email || user?.owner_jid || 'Usuário');
      const meta = [`Email: ${normalizeString(user?.email) || 'n/d'}`, `Owner: ${normalizeString(user?.owner_jid) || 'n/d'}`, `Último login: ${formatDateTime(user?.last_login_at)} • Último acesso: ${formatDateTime(user?.last_seen_at)}`];
      const actions = [];
      if (Object.keys(identity).length) {
        actions.push(createMiniButton('Forçar logout', () => handleAdminForceLogout(identity, buildIdentityLabel(identity))));
      }
      appendListItem({
        container: ui.adminUsersList,
        title,
        severity: 'low',
        badgeLabel: 'USER',
        meta,
        actions,
      });
    }
  };

  const renderBlockedAccounts = (bans) => {
    const list = Array.isArray(bans) ? bans : [];
    clearNode(ui.adminBansList);

    if (!list.length) {
      renderListPlaceholder(ui.adminBansList, 'Nenhuma conta bloqueada.');
      return;
    }

    for (const ban of list) {
      const identity = normalizeString(ban?.email || ban?.owner_jid || ban?.google_sub || `ban:${ban?.id || ''}`);
      const isRevoked = Boolean(ban?.revoked_at);
      const meta = [`Criado: ${formatDateTime(ban?.created_at)}${isRevoked ? ` • Revogado: ${formatDateTime(ban?.revoked_at)}` : ''}`, `Motivo: ${normalizeString(ban?.reason) || 'não informado'}`];
      const actions = [];
      if (!isRevoked && normalizeString(ban?.id)) {
        actions.push(createMiniButton('Revogar ban', () => handleAdminBanRevoke(ban.id)));
      }
      appendListItem({
        container: ui.adminBansList,
        title: identity,
        severity: isRevoked ? 'low' : 'critical',
        badgeLabel: isRevoked ? 'REVOGADO' : 'BLOQUEADO',
        meta,
        actions,
      });
    }
  };

  const renderAuditLog = (events) => {
    const list = Array.isArray(events) ? events : [];
    const statusFilter = normalizeString(state.auditFilterStatus || 'all').toLowerCase();
    const query = normalizeString(state.auditSearchQuery).toLowerCase();
    const filtered = list.filter((item) => {
      const status = normalizeString(item?.status || 'success').toLowerCase();
      const statusOk = statusFilter === 'all' || status === statusFilter;
      if (!statusOk) return false;
      if (!query) return true;

      const details = isObject(item?.details) ? Object.entries(item.details).slice(0, 3) : [];
      const haystack = [normalizeString(item?.action), normalizeString(item?.target_type), normalizeString(item?.target_id), normalizeString(item?.admin_email), normalizeString(item?.admin_google_sub), normalizeString(item?.admin_owner_jid), details.map(([key, value]) => `${key}=${value}`).join(' ')].join(' ').toLowerCase();
      return haystack.includes(query);
    });
    clearNode(ui.adminAuditList);

    if (!filtered.length) {
      renderListPlaceholder(ui.adminAuditList, 'Sem eventos de auditoria recentes.');
      setPaginationHidden({
        wrapper: ui.adminAuditPagination,
        counter: ui.adminAuditPageCounter,
        meta: ui.adminAuditPageMeta,
      });
      if (ui.adminAuditPrevBtn) ui.adminAuditPrevBtn.disabled = true;
      if (ui.adminAuditNextBtn) ui.adminAuditNextBtn.disabled = true;
      return;
    }

    const pageItems = paginateItems({
      items: filtered,
      statePageKey: 'auditPage',
      pageSize: state.auditPageSize,
      wrapper: ui.adminAuditPagination,
      counter: ui.adminAuditPageCounter,
      meta: ui.adminAuditPageMeta,
      prevBtn: ui.adminAuditPrevBtn,
      nextBtn: ui.adminAuditNextBtn,
    });

    for (const item of pageItems) {
      const action = normalizeString(item?.action || 'action');
      const targetType = normalizeString(item?.target_type || 'target');
      const targetId = normalizeString(item?.target_id || '');
      const status = normalizeString(item?.status || 'success');
      const details = isObject(item?.details) ? Object.entries(item.details).slice(0, 3) : [];
      const detailLine = details.length ? `Detalhes: ${details.map(([key, value]) => `${key}=${value}`).join(' • ')}` : '';

      const meta = [`Admin: ${normalizeString(item?.admin_email || item?.admin_google_sub || item?.admin_owner_jid || 'n/d')} (${formatAdminRole(normalizeString(item?.admin_role || 'admin'))})`, `Alvo: ${targetType}${targetId ? ` / ${targetId}` : ''} • Em: ${formatDateTime(item?.created_at)}`];
      if (detailLine) meta.push(detailLine);

      appendListItem({
        container: ui.adminAuditList,
        title: action,
        severity: status === 'success' ? 'low' : 'high',
        badgeLabel: status.toUpperCase(),
        meta,
        highlightQuery: query,
      });
    }
  };

  const renderFeatureFlags = (flags) => {
    const list = Array.isArray(flags) ? flags : [];
    clearNode(ui.adminFlagsList);

    if (!list.length) {
      renderListPlaceholder(ui.adminFlagsList, 'Nenhuma feature flag disponível.');
      return;
    }

    for (const flag of list) {
      const flagName = normalizeString(flag?.flag_name);
      const isEnabled = Boolean(flag?.is_enabled);
      const rollout = Math.max(0, Math.min(100, Math.floor(Number(flag?.rollout_percent) || 0)));
      const description = normalizeString(flag?.description);
      const updatedBy = normalizeString(flag?.updated_by);

      const rolloutForm = document.createElement('form');
      rolloutForm.className = 'admin-inline-form';

      const rolloutInput = document.createElement('input');
      rolloutInput.className = 'admin-input';
      rolloutInput.type = 'number';
      rolloutInput.min = '0';
      rolloutInput.max = '100';
      rolloutInput.step = '1';
      rolloutInput.value = String(rollout);
      rolloutInput.setAttribute('aria-label', `Rollout de ${flagName}`);

      const rolloutBtn = document.createElement('button');
      rolloutBtn.type = 'submit';
      rolloutBtn.className = 'admin-mini-btn';
      rolloutBtn.textContent = 'Salvar rollout';

      rolloutForm.appendChild(rolloutInput);
      rolloutForm.appendChild(rolloutBtn);
      rolloutForm.addEventListener('submit', (event) => {
        event.preventDefault();
        void handleAdminFeatureFlagUpdate({
          flagName,
          isEnabled,
          rolloutPercent: rolloutInput.value,
          description,
        });
      });

      const actions = [
        createMiniButton(isEnabled ? 'Desativar' : 'Ativar', () =>
          handleAdminFeatureFlagUpdate({
            flagName,
            isEnabled: !isEnabled,
            rolloutPercent: rollout,
            description,
          }),
        ),
      ];

      appendListItem({
        container: ui.adminFlagsList,
        title: flagName || 'feature_flag',
        severity: isEnabled ? 'low' : 'medium',
        badgeLabel: isEnabled ? 'ON' : 'OFF',
        meta: [`Rollout: ${rollout}%`, description ? `Descrição: ${description}` : 'Descrição: n/d', `Atualizado por: ${updatedBy || 'n/d'} • ${formatDateTime(flag?.updated_at)}`],
        actions,
        customNode: rolloutForm,
      });
    }
  };

  const renderAlerts = (alerts) => {
    const list = Array.isArray(alerts) ? alerts : [];
    clearNode(ui.adminAlertsList);

    if (!list.length) {
      renderListPlaceholder(ui.adminAlertsList, 'Sem alertas ativos no momento.');
      setPaginationHidden({
        wrapper: ui.adminAlertsPagination,
        counter: ui.adminAlertsPageCounter,
        meta: ui.adminAlertsPageMeta,
      });
      if (ui.adminAlertsPrevBtn) ui.adminAlertsPrevBtn.disabled = true;
      if (ui.adminAlertsNextBtn) ui.adminAlertsNextBtn.disabled = true;
      return;
    }

    const pageItems = paginateItems({
      items: list,
      statePageKey: 'alertsPage',
      pageSize: state.alertsPageSize,
      wrapper: ui.adminAlertsPagination,
      counter: ui.adminAlertsPageCounter,
      meta: ui.adminAlertsPageMeta,
      prevBtn: ui.adminAlertsPrevBtn,
      nextBtn: ui.adminAlertsNextBtn,
    });

    for (const alert of pageItems) {
      const severity = normalizeSeverity(alert?.severity);
      const title = normalizeString(alert?.title || alert?.code || 'Alerta');
      const meta = [normalizeString(alert?.message || ''), `Código: ${normalizeString(alert?.code || 'n/d')} • ${formatDateTime(alert?.created_at)}`];
      appendListItem({
        container: ui.adminAlertsList,
        title,
        severity,
        badgeLabel: severity.toUpperCase(),
        meta,
      });
    }
  };

  const renderSearchResults = (payload = state.adminSearchPayload) => {
    if (!ui.adminSearchResults) return;
    clearNode(ui.adminSearchResults);

    if (!payload || !isObject(payload)) {
      renderListPlaceholder(ui.adminSearchResults, 'Faça uma busca para ver usuários, grupos, packs e sessões.');
      return;
    }

    const q = normalizeString(payload?.q);
    const totals = isObject(payload?.totals) ? payload.totals : {};
    const results = isObject(payload?.results) ? payload.results : {};

    appendListItem({
      container: ui.adminSearchResults,
      title: `Resultado para "${q || 'consulta'}"`,
      severity: 'low',
      badgeLabel: 'BUSCA',
      meta: [`Usuários: ${formatIntegerOrNd(totals.users)}`, `Sessões: ${formatIntegerOrNd(totals.sessions)}`, `Grupos: ${formatIntegerOrNd(totals.groups)}`, `Packs: ${formatIntegerOrNd(totals.packs)}`],
      highlightQuery: q,
    });

    const users = Array.isArray(results.users) ? results.users : [];
    for (const user of users) {
      const identity = buildForceLogoutPayloadFromAny(user);
      const actions = [];
      if (Object.keys(identity).length) {
        actions.push(createMiniButton('Forçar logout', () => handleAdminForceLogout(identity, buildIdentityLabel(identity))));
      }
      appendListItem({
        container: ui.adminSearchResults,
        title: `[Usuário] ${normalizeString(user?.name || user?.email || user?.owner_jid || 'registro')}`,
        severity: 'low',
        badgeLabel: 'USER',
        meta: [`Email: ${normalizeString(user?.email) || 'n/d'}`, `Owner: ${normalizeString(user?.owner_jid) || 'n/d'}`],
        actions,
        highlightQuery: q,
      });
    }

    const sessions = Array.isArray(results.sessions) ? results.sessions : [];
    for (const session of sessions) {
      const identity = buildForceLogoutPayloadFromAny(session);
      const actions = [];
      if (Object.keys(identity).length) {
        actions.push(createMiniButton('Forçar logout', () => handleAdminForceLogout(identity, buildIdentityLabel(identity))));
      }
      appendListItem({
        container: ui.adminSearchResults,
        title: `[Sessão] ${normalizeString(session?.name || session?.email || session?.owner_jid || 'ativa')}`,
        severity: 'low',
        badgeLabel: 'SESSÃO',
        meta: [`Email: ${normalizeString(session?.email) || 'n/d'}`, `Expira: ${formatDateTime(session?.expires_at)}`],
        actions,
        highlightQuery: q,
      });
    }

    const groups = Array.isArray(results.groups) ? results.groups : [];
    for (const group of groups) {
      appendListItem({
        container: ui.adminSearchResults,
        title: `[Grupo] ${normalizeString(group?.subject || group?.id || 'grupo')}`,
        severity: 'medium',
        badgeLabel: 'GRUPO',
        meta: [`ID: ${normalizeString(group?.id) || 'n/d'}`, `Atualizado: ${formatDateTime(group?.updated_at)}`],
        highlightQuery: q,
      });
    }

    const packs = Array.isArray(results.packs) ? results.packs : [];
    for (const pack of packs) {
      const packUrl = normalizeString(pack?.web_url);
      const actions = [];
      if (packUrl) actions.push(createMiniLink('Abrir pack', packUrl));
      appendListItem({
        container: ui.adminSearchResults,
        title: `[Pack] ${normalizeString(pack?.name || pack?.pack_key || 'pack')}`,
        severity: 'low',
        badgeLabel: normalizeString(pack?.visibility || 'pack').toUpperCase(),
        meta: [`Owner: ${normalizeString(pack?.owner_jid) || 'n/d'}`, `Stickers: ${formatIntegerOrNd(pack?.stickers_count)}`],
        actions,
        highlightQuery: q,
      });
    }

    if (!users.length && !sessions.length && !groups.length && !packs.length) {
      appendListItem({
        container: ui.adminSearchResults,
        title: 'Nenhum resultado encontrado.',
        severity: 'low',
        badgeLabel: 'VAZIO',
        meta: ['Tente outro termo de busca.'],
      });
    }
  };

  const renderSystemHealth = (health) => {
    const cpu = Number(health?.cpu_percent);
    const ram = Number(health?.ram_percent);
    const latency = Number(health?.http_latency_p95_ms);
    const queue = Number(health?.queue_pending);
    const dbStatus = normalizeString(health?.db_status).toLowerCase();

    setText(ui.adminHealthCpu, formatPercent(cpu));
    setText(ui.adminHealthRam, formatPercent(ram));
    setText(ui.adminHealthLatency, formatMilliseconds(latency));
    setText(ui.adminHealthQueue, formatIntegerOrNd(queue));

    setHealthMeter(ui.adminHealthCpuBar, cpu, { max: 100, warnAt: 70, dangerAt: 88 });
    setHealthMeter(ui.adminHealthRamBar, ram, { max: 100, warnAt: 75, dangerAt: 90 });
    setHealthMeter(ui.adminHealthLatencyBar, latency, { max: 900, warnAt: 35, dangerAt: 60 });
    setHealthMeter(ui.adminHealthQueueBar, queue, { max: 400, warnAt: 30, dangerAt: 55 });

    let dbBadgeClass = '';
    let dbLabel = 'Unknown';
    if (dbStatus === 'ok') {
      dbBadgeClass = 'healthy';
      dbLabel = 'Healthy';
    } else if (dbStatus === 'degraded') {
      dbBadgeClass = 'degraded';
      dbLabel = 'Degraded';
    } else if (dbStatus === 'down') {
      dbBadgeClass = 'down';
      dbLabel = 'Down';
    }

    setText(ui.adminHealthDb, dbLabel);
    if (ui.adminHealthDbBadge) {
      ui.adminHealthDbBadge.classList.remove('healthy', 'degraded', 'down');
      if (dbBadgeClass) ui.adminHealthDbBadge.classList.add(dbBadgeClass);
      ui.adminHealthDbBadge.textContent = dbLabel;
    }

    return { cpu, ram, latency, queue, dbStatus };
  };

  const updateOperationalSignals = ({ counters = {}, dashboard = {}, health = {}, alerts = [] } = {}) => {
    const normalizedAlerts = Array.isArray(alerts) ? alerts : [];
    const hasCriticalAlert = normalizedAlerts.some((entry) => {
      const severity = normalizeSeverity(entry?.severity);
      return severity === 'critical' || severity === 'high';
    });
    const hasMediumAlert = normalizedAlerts.some((entry) => normalizeSeverity(entry?.severity) === 'medium');

    const cpuPercent = Number(health?.cpu_percent);
    const spamBlocked = Number(dashboard?.spam_blocked_today || 0);
    const activeBans = Number(counters?.active_bans || 0);
    const errors5xx = Number(dashboard?.errors_5xx || 0);
    const dbStatus = normalizeString(health?.db_status).toLowerCase();

    if (Number.isFinite(cpuPercent) && cpuPercent >= 88) {
      setRiskPill(ui.riskCpu, `CPU alta: ${cpuPercent.toFixed(1)}%`, 'danger');
    } else if (Number.isFinite(cpuPercent) && cpuPercent >= 75) {
      setRiskPill(ui.riskCpu, `CPU atenção: ${cpuPercent.toFixed(1)}%`, 'warn');
    } else {
      setRiskPill(ui.riskCpu, 'CPU normal');
    }

    if (spamBlocked >= 220) {
      setRiskPill(ui.riskSpam, `Spam elevado: ${formatNumber(spamBlocked)}`, 'danger');
    } else if (spamBlocked >= 90) {
      setRiskPill(ui.riskSpam, `Spam em atenção: ${formatNumber(spamBlocked)}`, 'warn');
    } else {
      setRiskPill(ui.riskSpam, 'Spam sob controle');
    }

    if (activeBans >= 30) {
      setRiskPill(ui.riskBans, `Bans críticos: ${formatNumber(activeBans)}`, 'danger');
    } else if (activeBans >= 10) {
      setRiskPill(ui.riskBans, `Bans em alta: ${formatNumber(activeBans)}`, 'warn');
    } else {
      setRiskPill(ui.riskBans, 'Bans estáveis');
    }

    if (errors5xx >= 30) {
      setRiskPill(ui.riskErrors, `Erros críticos: ${formatNumber(errors5xx)}`, 'danger');
    } else if (errors5xx >= 10) {
      setRiskPill(ui.riskErrors, `Erros em atenção: ${formatNumber(errors5xx)}`, 'warn');
    } else {
      setRiskPill(ui.riskErrors, 'Erros baixos');
    }

    if (dbStatus === 'down' || hasCriticalAlert || errors5xx >= 30 || (Number.isFinite(cpuPercent) && cpuPercent >= 92)) {
      setGlobalStatusChip('incident', 'Incident');
      return;
    }
    if (dbStatus === 'degraded' || hasMediumAlert || errors5xx >= 10 || (Number.isFinite(cpuPercent) && cpuPercent >= 75)) {
      setGlobalStatusChip('warning', 'Warning');
      return;
    }
    setGlobalStatusChip('online', 'Online');
  };

  const renderAdminOverview = () => {
    const payload = state.adminOverviewPayload || {};
    const previousPayload = state.previousAdminOverviewPayload || null;
    const counters = isObject(payload?.counters) ? payload.counters : {};
    const dashboard = isObject(payload?.dashboard_quick) ? payload.dashboard_quick : {};
    const usersSessions = isObject(payload?.users_sessions) ? payload.users_sessions : {};
    const health = isObject(payload?.system_health) ? payload.system_health : {};
    const previousCounters = isObject(previousPayload?.counters) ? previousPayload.counters : {};
    const previousDashboard = isObject(previousPayload?.dashboard_quick) ? previousPayload.dashboard_quick : {};
    const hasPrevious = Boolean(previousPayload);
    const lastUpdated = normalizeString(payload?.updated_at);
    const lastUpdatedLabel = lastUpdated ? `${formatDateTime(lastUpdated)} (${formatRelativeTime(lastUpdated)})` : 'n/d';

    state.moderationFilterSeverity = normalizeString(ui.adminModerationFilterSeverity?.value || state.moderationFilterSeverity || 'all').toLowerCase();
    state.moderationFilterType = normalizeString(ui.adminModerationFilterType?.value || state.moderationFilterType || 'all').toLowerCase();
    state.auditFilterStatus = normalizeString(ui.adminAuditFilterStatus?.value || state.auditFilterStatus || 'all').toLowerCase();
    state.auditSearchQuery = normalizeString(ui.adminAuditSearch?.value || state.auditSearchQuery || '');

    const botsOnline = toFiniteNumber(dashboard?.bots_online, 0);
    const messagesToday = toFiniteNumber(dashboard?.messages_today, 0);
    const spamBlockedToday = toFiniteNumber(dashboard?.spam_blocked_today, 0);
    const errors5xx = toFiniteNumber(dashboard?.errors_5xx, 0);
    const totalPacks = toFiniteNumber(counters?.total_packs_any_status, 0);
    const totalStickers = toFiniteNumber(counters?.total_stickers_any_status, 0);
    const activeBans = toFiniteNumber(counters?.active_bans, 0);
    const knownUsers = toFiniteNumber(counters?.known_google_users, 0);
    const activeSessions = toFiniteNumber(counters?.active_google_sessions, 0);
    const visits24h = toFiniteNumber(counters?.visit_events_24h, 0);
    const visits7d = toFiniteNumber(counters?.visit_events_7d, 0);
    const uniqueVisitors7d = toFiniteNumber(counters?.unique_visitors_7d, 0);

    setText(ui.adminBotsOnline, formatIntegerOrNd(botsOnline));
    setText(ui.adminMessagesToday, formatIntegerOrNd(messagesToday));
    setText(ui.adminSpamBlocked, formatIntegerOrNd(spamBlockedToday));
    setText(ui.adminUptime, normalizeString(dashboard?.uptime) || 'n/d');
    setText(ui.adminErrors5xx, formatIntegerOrNd(errors5xx));
    setText(ui.adminTotalPacks, formatIntegerOrNd(totalPacks));
    setText(ui.adminTotalStickers, formatIntegerOrNd(totalStickers));
    setText(ui.adminActiveBans, formatIntegerOrNd(activeBans));
    setText(ui.adminKnownUsers, formatIntegerOrNd(knownUsers));
    setText(ui.adminActiveSessions, formatIntegerOrNd(activeSessions));
    setText(ui.adminVisits24h, formatIntegerOrNd(visits24h));
    setText(ui.adminVisits7d, formatIntegerOrNd(visits7d));
    setText(ui.adminUniqueVisitors7d, formatIntegerOrNd(uniqueVisitors7d));

    const deltaOrNd = (current, previous, options) => (hasPrevious ? formatDeltaLabel(current, previous, options) : 'n/d');
    setMetricContext(ui.adminBotsOnlineContext, `vs leitura anterior: ${deltaOrNd(botsOnline, toFiniteNumber(previousDashboard?.bots_online, botsOnline))}`);
    setMetricContext(ui.adminMessagesTodayContext, `vs leitura anterior: ${deltaOrNd(messagesToday, toFiniteNumber(previousDashboard?.messages_today, messagesToday))}`);
    setMetricContext(ui.adminUptimeContext, 'janela: processo atual');
    setMetricContext(ui.adminErrors5xxContext, `vs leitura anterior: ${deltaOrNd(errors5xx, toFiniteNumber(previousDashboard?.errors_5xx, errors5xx), { percent: false, suffix: ' eventos' })}`);
    setMetricContext(ui.adminTotalPacksContext, `delta leitura: ${deltaOrNd(totalPacks, toFiniteNumber(previousCounters?.total_packs_any_status, totalPacks), { percent: false })}`);
    setMetricContext(ui.adminTotalStickersContext, `delta leitura: ${deltaOrNd(totalStickers, toFiniteNumber(previousCounters?.total_stickers_any_status, totalStickers), { percent: false })}`);
    setMetricContext(ui.adminSpamBlockedContext, `vs leitura anterior: ${deltaOrNd(spamBlockedToday, toFiniteNumber(previousDashboard?.spam_blocked_today, spamBlockedToday))}`);
    setMetricContext(ui.adminActiveBansContext, `delta leitura: ${deltaOrNd(activeBans, toFiniteNumber(previousCounters?.active_bans, activeBans), { percent: false })}`);
    setMetricContext(ui.adminKnownUsersContext, `delta leitura: ${deltaOrNd(knownUsers, toFiniteNumber(previousCounters?.known_google_users, knownUsers), { percent: false })}`);
    setMetricContext(ui.adminActiveSessionsContext, `delta leitura: ${deltaOrNd(activeSessions, toFiniteNumber(previousCounters?.active_google_sessions, activeSessions), { percent: false })}`);
    setMetricContext(ui.adminVisits24hContext, `leitura atual: ${formatNumber(visits24h)} eventos`);
    setMetricContext(ui.adminVisits7dContext, `leitura atual: ${formatNumber(visits7d)} eventos`);
    setMetricContext(ui.adminUniqueVisitors7dContext, `leitura atual: ${formatNumber(uniqueVisitors7d)} visitantes`);
    setText(ui.adminLastUpdated, lastUpdatedLabel);

    renderSystemHealth(health);
    setText(ui.adminHealthCpuMeta, `Limite: 88% • Atualizado ${formatRelativeTime(lastUpdated)}`);
    setText(ui.adminHealthRamMeta, `Limite: 90% • Atualizado ${formatRelativeTime(lastUpdated)}`);
    setText(ui.adminHealthLatencyMeta, `Alerta: >300ms • Atualizado ${formatRelativeTime(lastUpdated)}`);
    setText(ui.adminHealthQueueMeta, `Ideal: <120 jobs • Atualizado ${formatRelativeTime(lastUpdated)}`);
    setText(ui.adminHealthDbMeta, `SLA alvo: 99.95% • Atualizado ${formatRelativeTime(lastUpdated)}`);
    renderModerationQueue(payload?.moderation_queue);
    renderActiveSessions(usersSessions?.active_sessions);
    renderKnownUsers(usersSessions?.users);
    renderBlockedAccounts(usersSessions?.blocked_accounts);
    renderAuditLog(payload?.audit_log);
    renderFeatureFlags(payload?.feature_flags);
    renderAlerts(payload?.alerts);
    updateOperationalSignals({
      counters,
      dashboard,
      health,
      alerts: payload?.alerts,
    });
    renderSearchResults();
    setText(ui.adminOpsStatus, state.adminOpsMessage || 'Ações operacionais disponíveis.');
    updateAdminCarouselControls();
  };

  const renderAdminPanel = () => {
    if (!ui.adminPanel) return;

    const enabled = state.adminStatusPayload?.enabled !== false;
    const authenticated = isAdminAuthenticated();
    const eligible = isAdminEligible();
    const role = resolveAdminRole();

    if (!enabled || (!eligible && !authenticated)) {
      ui.adminPanel.hidden = true;
      if (ui.adminUnlockForm) ui.adminUnlockForm.hidden = true;
      if (ui.adminOverview) ui.adminOverview.hidden = true;
      showAdminError('');
      return;
    }

    ui.adminPanel.hidden = false;
    setText(ui.adminRole, formatAdminRole(role));

    if (authenticated) {
      setText(ui.adminStatus, `Sessão admin ativa como ${formatAdminRole(role)}. Ferramentas operacionais liberadas abaixo.`);
      if (ui.adminUnlockForm) ui.adminUnlockForm.hidden = true;
      if (ui.adminOverview) ui.adminOverview.hidden = false;
      renderAdminOverview();
    } else {
      setText(ui.adminStatus, `Conta elegível para admin (${formatAdminRole(role)}). Informe a senha para liberar os dados sensíveis.`);
      if (ui.adminUnlockForm) ui.adminUnlockForm.hidden = false;
      if (ui.adminOverview) ui.adminOverview.hidden = true;
      setAdminMetricsDefaults();
    }

    setAdminBusy(state.adminBusy);
  };

  const loadBotPhone = async () => {
    try {
      const payload = await fetchJson(botContactApiPath, { method: 'GET' });
      state.botPhone = normalizeDigits(payload?.data?.phone || '');
    } catch {
      state.botPhone = '';
    }
    if (ui.chatLink) ui.chatLink.href = buildWhatsAppMenuUrl(state.botPhone);
  };

  const loadAdminStatus = async () => {
    const payload = await fetchJson(adminSessionApiPath, { method: 'GET' });
    state.adminStatusPayload = payload?.data || null;
  };

  const loadAdminOverview = async () => {
    if (!isAdminAuthenticated()) {
      state.previousAdminOverviewPayload = null;
      state.adminOverviewPayload = null;
      return;
    }
    const payload = await fetchJson(adminOverviewApiPath, { method: 'GET' });
    state.previousAdminOverviewPayload = state.adminOverviewPayload || null;
    state.adminOverviewPayload = payload?.data || null;
  };

  const refreshAdminArea = async ({ keepCurrentError = false } = {}) => {
    if (!keepCurrentError) showAdminError('');
    try {
      await loadAdminStatus();
      await loadAdminOverview();
    } catch (error) {
      if (error?.statusCode === 404) {
        state.adminStatusPayload = { enabled: false };
        state.previousAdminOverviewPayload = null;
        state.adminOverviewPayload = null;
      } else {
        showAdminError(error?.message || 'Falha ao carregar área admin.');
      }
    }
    renderAdminPanel();
  };

  const setCompactMode = (enabled, { persist = true } = {}) => {
    state.compactMode = Boolean(enabled);
    document.body.classList.toggle('compact', state.compactMode);
    if (ui.compactToggle) {
      ui.compactToggle.textContent = state.compactMode ? 'Modo confortável' : 'Modo compacto';
    }

    const activeLink = ui.navLinks.find((link) => link.classList.contains('active'));
    const activeTarget = normalizeString(activeLink?.getAttribute('href')).replace(/^#/, '');
    if (isCarouselMode()) {
      if (activeTarget) {
        scrollAdminCarouselToId(activeTarget, { behavior: 'auto' });
      } else {
        scrollAdminCarouselToIndex(state.adminCarouselIndex, { behavior: 'auto' });
      }
    } else if (ui.adminLayout) {
      ui.adminLayout.style.blockSize = '';
    }

    updateAdminCarouselControls();
    if (!persist) return;
    try {
      window.localStorage.setItem(COMPACT_MODE_STORAGE_KEY, state.compactMode ? '1' : '0');
    } catch {
      // noop
    }
  };

  const restoreCompactMode = () => {
    try {
      const raw = window.localStorage.getItem(COMPACT_MODE_STORAGE_KEY);
      setCompactMode(raw === '1', { persist: false });
    } catch {
      setCompactMode(false, { persist: false });
    }
  };

  const bindSectionObserver = () => {
    if (!ui.navLinks.length) return;
    const subpageSections = getAdminSubpageSections();
    if (subpageSections.length) {
      const handleRouteChange = () => {
        activateAdminSubpage(window.location.hash || 'overview', {
          syncHash: true,
          resetScroll: false,
        });
      };

      for (const link of ui.navLinks) {
        const href = normalizeString(link.getAttribute('href'));
        if (!href.startsWith('#')) continue;
        link.addEventListener('click', (event) => {
          const targetId = href.slice(1);
          if (!targetId) return;
          if (!activateAdminSubpage(targetId, { syncHash: true })) return;
          event.preventDefault();
        });
      }

      window.addEventListener('hashchange', handleRouteChange);
      handleRouteChange();
      return;
    }

    const entries = [];
    for (const link of ui.navLinks) {
      const href = normalizeString(link.getAttribute('href'));
      if (!href.startsWith('#')) continue;
      const target = document.querySelector(href);
      if (target) entries.push({ link, target });
    }
    if (!entries.length) return;

    if (!('IntersectionObserver' in window)) {
      setActiveNavLink(entries[0].target.id);
      return;
    }

    const observer = new window.IntersectionObserver(
      (observed) => {
        if (isCarouselMode()) return;
        const visible = observed.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) setActiveNavLink(visible.target.id);
      },
      {
        root: null,
        rootMargin: '-35% 0px -55% 0px',
        threshold: [0.1, 0.25, 0.45, 0.7],
      },
    );

    for (const item of entries) observer.observe(item.target);
    setActiveNavLink(entries[0].target.id);
  };

  const bindKeyboardShortcuts = () => {
    window.addEventListener('keydown', (event) => {
      const isModKey = event.ctrlKey || event.metaKey;
      if (isModKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        ui.adminSearchInput?.focus();
        ui.adminSearchInput?.select();
      }
    });
  };

  const handleAdminUnlock = async () => {
    const password = normalizeString(ui.adminPassword?.value);
    if (!password) {
      showAdminError('Informe a senha do painel admin.');
      return;
    }
    if (state.adminBusy) return;

    showAdminError('');
    setButtonProcessing(ui.adminUnlockBtn, 'Desbloqueando...');
    setAdminBusy(true);
    let unlocked = false;
    try {
      const payload = await fetchJson(adminSessionApiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ password }),
      });
      state.adminStatusPayload = payload?.data || null;
      state.adminOpsMessage = '';
      state.adminSearchPayload = null;
      if (ui.adminPassword) ui.adminPassword.value = '';
      await loadAdminOverview();
      showToast({
        kind: 'success',
        title: 'Admin',
        message: 'Área administrativa desbloqueada com sucesso.',
      });
      unlocked = true;
    } catch (error) {
      showAdminError(error?.message || 'Falha ao desbloquear área admin.');
      await loadAdminStatus().catch(() => {});
      state.previousAdminOverviewPayload = null;
      state.adminOverviewPayload = null;
    } finally {
      setAdminBusy(false);
      setButtonIdle(ui.adminUnlockBtn);
      if (unlocked) flashButtonSuccess(ui.adminUnlockBtn, 'Liberado');
      renderAdminPanel();
    }
  };

  const handleAdminLogout = async (triggerButton = null) => {
    if (state.adminBusy) return;
    if (!confirmCriticalAction('Encerrar sessão administrativa atual?')) return;
    showAdminError('');
    setButtonProcessing(triggerButton, 'Saindo...');
    setAdminBusy(true);
    try {
      await fetchJson(adminSessionApiPath, { method: 'DELETE' });
    } catch {
      // no-op
    }
    state.previousAdminOverviewPayload = null;
    state.adminOverviewPayload = null;
    state.adminSearchPayload = null;
    state.adminOpsMessage = '';
    await loadAdminStatus().catch(() => {
      state.adminStatusPayload = null;
    });
    showToast({ kind: 'success', title: 'Admin', message: 'Sessão administrativa encerrada.' });
    setAdminBusy(false);
    setButtonIdle(triggerButton);
    flashButtonSuccess(triggerButton, 'Encerrado');
    renderAdminPanel();
  };

  const handleAdminRefresh = async (triggerButton = null) => {
    if (state.adminBusy) return;
    setButtonProcessing(triggerButton, 'Atualizando...');
    setAdminBusy(true);
    await refreshAdminArea({ keepCurrentError: false });
    setAdminBusy(false);
    setButtonIdle(triggerButton);
    flashButtonSuccess(triggerButton, 'Atualizado');
    renderAdminPanel();
    showToast({
      kind: 'success',
      title: 'Atualização',
      message: 'Dados administrativos atualizados.',
    });
  };

  const handleAdminSearchSubmit = async () => {
    if (state.adminBusy) return;

    const q = normalizeString(ui.adminSearchInput?.value);
    if (!q) {
      state.adminSearchPayload = null;
      renderSearchResults();
      return;
    }

    showAdminError('');
    setButtonProcessing(ui.adminSearchBtn, 'Buscando...');
    setAdminBusy(true);
    try {
      const query = new URLSearchParams({ q, limit: '12' }).toString();
      const payload = await fetchJson(`${adminSearchApiPath}?${query}`, { method: 'GET' });
      state.adminSearchPayload = payload?.data || null;
      state.adminOpsMessage = `Busca concluída para "${q}".`;
      renderSearchResults();
      setText(ui.adminOpsStatus, state.adminOpsMessage);
      showToast({ kind: 'success', title: 'Busca', message: state.adminOpsMessage });
    } catch (error) {
      showAdminError(error?.message || 'Falha ao buscar dados.');
    } finally {
      setAdminBusy(false);
      setButtonIdle(ui.adminSearchBtn);
      flashButtonSuccess(ui.adminSearchBtn, 'Concluído');
      renderAdminPanel();
    }
  };

  const downloadBlob = (blob, filename) => {
    const objectUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      window.URL.revokeObjectURL(objectUrl);
    }, 250);
  };

  const extractFilenameFromDisposition = (contentDisposition, fallbackName) => {
    const source = normalizeString(contentDisposition);
    if (!source) return fallbackName;
    const utf8Match = source.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
    const plainMatch = source.match(/filename="?([^"]+)"?/i);
    if (plainMatch?.[1]) return plainMatch[1];
    return fallbackName;
  };

  const handleAdminExport = async ({ type = 'metrics', format = 'json', triggerButton = null } = {}) => {
    if (state.adminBusy) return;

    const normalizedType = normalizeString(type || 'metrics').toLowerCase();
    const normalizedFormat = normalizeString(format || 'json').toLowerCase();
    const fallbackName = `admin-${normalizedType}-${__timeNowMs()}.${normalizedFormat === 'csv' ? 'csv' : 'json'}`;

    showAdminError('');
    setButtonProcessing(triggerButton, 'Exportando...');
    setAdminBusy(true);
    let exported = false;
    try {
      const query = new URLSearchParams({
        type: normalizedType,
        format: normalizedFormat,
      }).toString();
      const response = await fetchWithAuth(`${adminExportApiPath}?${query}`, { method: 'GET' });

      if (normalizedFormat === 'csv') {
        const blob = await response.blob();
        const contentDisposition = response.headers.get('content-disposition');
        const filename = extractFilenameFromDisposition(contentDisposition, fallbackName);
        downloadBlob(blob, filename);
      } else {
        const payload = await response.json().catch(() => ({}));
        const blob = new Blob([JSON.stringify(payload?.data || payload || {}, null, 2)], {
          type: 'application/json; charset=utf-8',
        });
        downloadBlob(blob, fallbackName);
      }

      state.adminOpsMessage = `Exportação ${normalizedType.toUpperCase()} (${normalizedFormat.toUpperCase()}) concluída.`;
      setText(ui.adminOpsStatus, state.adminOpsMessage);
      showToast({ kind: 'success', title: 'Exportação', message: state.adminOpsMessage });
      exported = true;
    } catch (error) {
      showAdminError(error?.message || 'Falha ao exportar dados.');
    } finally {
      setAdminBusy(false);
      setButtonIdle(triggerButton);
      if (exported) flashButtonSuccess(triggerButton, 'Baixado');
      renderAdminPanel();
    }
  };

  const handleLogout = async () => {
    if (!ui.logoutBtn) return;
    if (!confirmCriticalAction('Encerrar sessão da conta atual?')) return;
    setButtonProcessing(ui.logoutBtn, 'Encerrando...');
    try {
      await fetchJson(sessionApiPath, { method: 'DELETE' });
    } catch {
      // clear local navigation even if request fails
    }
    window.location.assign(`${state.loginPath}/`);
  };

  const init = async () => {
    const manageHref = `${state.stickersPath.replace(/\/+$/, '') || DEFAULT_STICKERS_PATH}/perfil`;
    if (ui.manageHeadLink) ui.manageHeadLink.href = manageHref;
    if (ui.manageMainLink) ui.manageMainLink.href = manageHref;
    if (ui.currentYear) ui.currentYear.textContent = String(__timeNow().getFullYear());
    applyEnvironmentBadge();
    restoreCompactMode();
    bindAdminCarousel();
    bindSectionObserver();
    bindKeyboardShortcuts();

    setText(ui.status, 'Validando sua sessão...');
    showError('');
    setAdminMetricsDefaults();

    let sessionData = null;
    try {
      const sessionPayload = await fetchJson(sessionApiPath, { method: 'GET' });
      sessionData = sessionPayload?.data || {};
      if (!sessionData?.authenticated || !sessionData?.user?.sub) {
        redirectToLogin();
        return;
      }
    } catch (error) {
      showError(error?.message || 'Falha ao validar sessão.');
      setText(ui.status, 'Não foi possível validar sua sessão agora.');
      return;
    }

    renderSession(sessionData);
    await loadBotPhone();
    await refreshAdminArea();

    try {
      const myProfilePayload = await fetchJson(myProfileApiPath, { method: 'GET' });
      const sessionOk = Boolean(myProfilePayload?.data?.session?.authenticated);
      if (!sessionOk) {
        redirectToLogin();
        return;
      }
      renderPackMetrics(myProfilePayload);
      setText(ui.status, 'Sessão ativa. Dados da sua conta carregados com sucesso.');
    } catch (error) {
      showError(error?.message || 'Falha ao carregar dados da conta.');
      setText(ui.status, 'Sessão ativa, mas não foi possível carregar todos os dados.');
    }
  };

  if (ui.logoutBtn) {
    ui.logoutBtn.addEventListener('click', () => {
      void handleLogout();
    });
  }

  if (ui.adminUnlockForm) {
    ui.adminUnlockForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void handleAdminUnlock();
    });
  }

  if (ui.adminLogoutBtn) {
    ui.adminLogoutBtn.addEventListener('click', (event) => {
      const button = event.currentTarget instanceof Element ? event.currentTarget : ui.adminLogoutBtn;
      void handleAdminLogout(button);
    });
  }

  if (ui.adminRefreshBtn) {
    ui.adminRefreshBtn.addEventListener('click', (event) => {
      const button = event.currentTarget instanceof Element ? event.currentTarget : ui.adminRefreshBtn;
      void handleAdminRefresh(button);
    });
  }

  if (ui.adminSearchForm) {
    ui.adminSearchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void handleAdminSearchSubmit();
    });
  }

  if (ui.compactToggle) {
    ui.compactToggle.addEventListener('click', () => {
      setCompactMode(!state.compactMode);
    });
  }

  if (ui.adminModerationFilterSeverity) {
    ui.adminModerationFilterSeverity.addEventListener('change', () => {
      state.moderationFilterSeverity = normalizeString(ui.adminModerationFilterSeverity?.value || 'all').toLowerCase();
      state.moderationPage = 1;
      renderModerationQueue(state.adminOverviewPayload?.moderation_queue);
    });
  }

  if (ui.adminModerationFilterType) {
    ui.adminModerationFilterType.addEventListener('change', () => {
      state.moderationFilterType = normalizeString(ui.adminModerationFilterType?.value || 'all').toLowerCase();
      state.moderationPage = 1;
      renderModerationQueue(state.adminOverviewPayload?.moderation_queue);
    });
  }

  if (ui.adminAuditFilterStatus) {
    ui.adminAuditFilterStatus.addEventListener('change', () => {
      state.auditFilterStatus = normalizeString(ui.adminAuditFilterStatus?.value || 'all').toLowerCase();
      state.auditPage = 1;
      renderAuditLog(state.adminOverviewPayload?.audit_log);
    });
  }

  if (ui.adminAuditSearch) {
    ui.adminAuditSearch.addEventListener('input', () => {
      state.auditSearchQuery = normalizeString(ui.adminAuditSearch?.value || '');
      state.auditPage = 1;
      renderAuditLog(state.adminOverviewPayload?.audit_log);
    });
  }

  if (ui.adminModerationPrevBtn) {
    ui.adminModerationPrevBtn.addEventListener('click', () => {
      state.moderationPage = Math.max(1, state.moderationPage - 1);
      renderModerationQueue(state.adminOverviewPayload?.moderation_queue);
    });
  }

  if (ui.adminModerationNextBtn) {
    ui.adminModerationNextBtn.addEventListener('click', () => {
      state.moderationPage += 1;
      renderModerationQueue(state.adminOverviewPayload?.moderation_queue);
    });
  }

  if (ui.adminAuditPrevBtn) {
    ui.adminAuditPrevBtn.addEventListener('click', () => {
      state.auditPage = Math.max(1, state.auditPage - 1);
      renderAuditLog(state.adminOverviewPayload?.audit_log);
    });
  }

  if (ui.adminAuditNextBtn) {
    ui.adminAuditNextBtn.addEventListener('click', () => {
      state.auditPage += 1;
      renderAuditLog(state.adminOverviewPayload?.audit_log);
    });
  }

  if (ui.adminUsersPrevBtn) {
    ui.adminUsersPrevBtn.addEventListener('click', () => {
      state.usersPage = Math.max(1, state.usersPage - 1);
      renderKnownUsers(state.adminOverviewPayload?.users_sessions?.users);
    });
  }

  if (ui.adminUsersNextBtn) {
    ui.adminUsersNextBtn.addEventListener('click', () => {
      state.usersPage += 1;
      renderKnownUsers(state.adminOverviewPayload?.users_sessions?.users);
    });
  }

  if (ui.adminSessionsPrevBtn) {
    ui.adminSessionsPrevBtn.addEventListener('click', () => {
      state.sessionsPage = Math.max(1, state.sessionsPage - 1);
      renderActiveSessions(state.adminOverviewPayload?.users_sessions?.active_sessions);
    });
  }

  if (ui.adminSessionsNextBtn) {
    ui.adminSessionsNextBtn.addEventListener('click', () => {
      state.sessionsPage += 1;
      renderActiveSessions(state.adminOverviewPayload?.users_sessions?.active_sessions);
    });
  }

  if (ui.adminAlertsPrevBtn) {
    ui.adminAlertsPrevBtn.addEventListener('click', () => {
      state.alertsPage = Math.max(1, state.alertsPage - 1);
      renderAlerts(state.adminOverviewPayload?.alerts);
    });
  }

  if (ui.adminAlertsNextBtn) {
    ui.adminAlertsNextBtn.addEventListener('click', () => {
      state.alertsPage += 1;
      renderAlerts(state.adminOverviewPayload?.alerts);
    });
  }

  if (ui.adminOpButtons.length) {
    for (const button of ui.adminOpButtons) {
      button.addEventListener('click', () => {
        const action = normalizeString(button.dataset.adminOpAction);
        if (!action) return;
        void handleAdminOpsAction(action, button);
      });
    }
  }

  if (ui.adminExportMetricsJsonBtn) {
    ui.adminExportMetricsJsonBtn.addEventListener('click', () => {
      void handleAdminExport({
        type: 'metrics',
        format: 'json',
        triggerButton: ui.adminExportMetricsJsonBtn,
      });
    });
  }
  if (ui.adminExportMetricsCsvBtn) {
    ui.adminExportMetricsCsvBtn.addEventListener('click', () => {
      void handleAdminExport({
        type: 'metrics',
        format: 'csv',
        triggerButton: ui.adminExportMetricsCsvBtn,
      });
    });
  }
  if (ui.adminExportEventsJsonBtn) {
    ui.adminExportEventsJsonBtn.addEventListener('click', () => {
      void handleAdminExport({
        type: 'events',
        format: 'json',
        triggerButton: ui.adminExportEventsJsonBtn,
      });
    });
  }
  if (ui.adminExportEventsCsvBtn) {
    ui.adminExportEventsCsvBtn.addEventListener('click', () => {
      void handleAdminExport({
        type: 'events',
        format: 'csv',
        triggerButton: ui.adminExportEventsCsvBtn,
      });
    });
  }

  void init();
}
