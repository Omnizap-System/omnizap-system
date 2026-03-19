import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);
const SEARCH_HISTORY_KEY = 'omnizap_stickers_search_history_v1';
const PACK_UPLOAD_TASK_KEY = 'omnizap_pack_upload_task_v1';
const GOOGLE_AUTH_CACHE_KEY = 'omnizap_google_web_auth_cache_v1';
const GOOGLE_AUTH_CACHE_MAX_STALE_MS = 8 * 24 * 60 * 60 * 1000;
const GOOGLE_GSI_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
const PROFILE_ROUTE_SEGMENTS = new Set(['perfil', 'profile']);
const CREATORS_ROUTE_SEGMENTS = new Set(['creators', 'criadores']);
const DEFAULT_STICKER_PLACEHOLDER_URL = 'https://iili.io/fSNGag2.png';
const NSFW_STICKER_PLACEHOLDER_URL = 'https://iili.io/qfhwS6u.jpg';
const LAZY_IMAGE_PLACEHOLDER_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

const CATALOG_SORT_OPTIONS = [
  { value: 'recent', label: 'Mais recentes', icon: '🆕' },
  { value: 'likes', label: 'Mais curtidos', icon: '👍' },
  { value: 'downloads', label: 'Mais baixados', icon: '⬇️' },
  { value: 'trending', label: 'Em alta', icon: '🔥' },
  { value: 'comments', label: 'Mais comentados', icon: '💬' },
];

const DEFAULT_CATALOG_SORT = 'trending';
const DEFAULT_CREATORS_SORT = 'popular';
const FIRST_CATALOG_PAGE = 1;
const MOBILE_MAX_CATALOG_LIMIT = 12;
const MOBILE_DISCOVER_CAROUSEL_LIMIT = 5;
const DESKTOP_DISCOVER_GROWING_LIMIT = 4;
const DESKTOP_DISCOVER_TOP_LIMIT = 4;
const PACK_STICKERS_INITIAL_LIMIT_MOBILE = 8;
const PACK_STICKERS_INITIAL_LIMIT_DESKTOP = 12;
const PACK_STICKERS_LOAD_STEP = 8;
const OMNIZAP_LOGO_DATA_URL = "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%230ea5e9'/%3E%3Cstop offset='1' stop-color='%2310b981'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='48' height='48' rx='24' fill='url(%23g)'/%3E%3Ctext x='24' y='30' text-anchor='middle' font-family='Segoe UI, Roboto, Arial, sans-serif' font-size='16' font-weight='700' fill='white'%3EOZ%3C/text%3E%3C/svg%3E";
const AVATAR_BG_PALETTE = ['#0f172a', '#1e293b', '#334155', '#0f766e', '#115e59', '#1d4ed8', '#3b0764', '#7c2d12', '#7f1d1d', '#14532d'];
const AVATAR_URL_CACHE = new Map();

const safeNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const COMPLETE_PACK_STICKER_TARGET = 30;

const normalizeCatalogSort = (value, fallback = DEFAULT_CATALOG_SORT) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'new') return 'recent';
  if (normalized === 'liked') return 'likes';
  if (normalized === 'popular') return 'trending';
  if (CATALOG_SORT_OPTIONS.some((entry) => entry.value === normalized)) return normalized;
  return fallback;
};

const normalizeCreatorsSort = (value, fallback = DEFAULT_CREATORS_SORT) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'creator_score') return 'popular';
  if (['popular', 'likes', 'downloads', 'packs', 'name'].includes(normalized)) return normalized;
  return fallback;
};

const catalogSortLabel = (sort) => CATALOG_SORT_OPTIONS.find((entry) => entry.value === normalizeCatalogSort(sort))?.label || 'Ordenar';

const getPackTrendScore = (pack) => safeNumber(pack?.signals?.trend_score);
const getPackRankingScore = (pack) => safeNumber(pack?.signals?.ranking_score);
const getPackCommentCount = (pack) => safeNumber(pack?.engagement?.comment_count || pack?.comment_count || 0);
const getPackStickerCount = (pack) => Math.max(0, safeNumber(pack?.sticker_count || 0));
const isPackComplete = (pack) => {
  if (pack?.is_complete === true || pack?.is_complete === 1 || pack?.is_complete === '1') return true;
  if (pack?.is_complete === false || pack?.is_complete === 0 || pack?.is_complete === '0') return false;
  return getPackStickerCount(pack) >= COMPLETE_PACK_STICKER_TARGET;
};
const comparePacksByCompleteness = (left, right) => {
  const leftCount = getPackStickerCount(left);
  const rightCount = getPackStickerCount(right);
  const leftIsComplete = isPackComplete(left) ? 1 : 0;
  const rightIsComplete = isPackComplete(right) ? 1 : 0;

  if (rightIsComplete !== leftIsComplete) return rightIsComplete - leftIsComplete;
  if (rightCount !== leftCount) return rightCount - leftCount;
  const leftHasCover = left?.cover_url ? 1 : 0;
  const rightHasCover = right?.cover_url ? 1 : 0;
  return rightHasCover - leftHasCover;
};

const buildCreatorScore = (creator) => {
  const avgPackScore = safeNumber(creator?.avgPackScore ?? creator?.stats?.avg_pack_score);
  const totalLikes = safeNumber(creator?.likes ?? creator?.stats?.total_likes);
  const totalDownloads = safeNumber(creator?.downloads ?? creator?.stats?.total_opens);
  return Number((avgPackScore * 0.45 + totalLikes * 0.0008 + totalDownloads * 0.00015).toFixed(6));
};

const DEFAULT_CATEGORIES = [
  { value: '', label: '🔥 Em alta', icon: '🔥' },
  { value: 'anime', label: 'Anime', icon: '🎌' },
  { value: 'game', label: 'Games', icon: '🎮' },
  { value: 'meme', label: 'Meme', icon: '😂' },
  { value: 'nsfw', label: '+18', icon: '🔞' },
  { value: 'dark-aesthetic', label: 'Dark', icon: '🖤' },
  { value: 'texto', label: 'Texto', icon: '✍️' },
  { value: 'cartoon', label: 'Cartoon', icon: '🧸' },
  { value: 'foto-real', label: 'Foto real', icon: '📷' },
  { value: 'animal-photo', label: 'Animal', icon: '🐾' },
  { value: 'cyberpunk', label: 'Cyberpunk', icon: '⚡' },
];

const CATEGORY_META = new Map(DEFAULT_CATEGORIES.map((entry) => [entry.value, entry]));

const parseIntSafe = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const resolveCatalogPageLimit = (defaultLimit) => {
  const parsedLimit = parseIntSafe(defaultLimit, 24);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return parsedLimit;
  const isMobileViewport = window.matchMedia('(max-width: 767px)').matches;
  if (!isMobileViewport) return parsedLimit;
  return Math.max(8, Math.min(parsedLimit, MOBILE_MAX_CATALOG_LIMIT));
};

const resolveInitialPackStickerLimit = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return PACK_STICKERS_INITIAL_LIMIT_DESKTOP;
  const isMobileViewport = window.matchMedia('(max-width: 767px)').matches;
  return isMobileViewport ? PACK_STICKERS_INITIAL_LIMIT_MOBILE : PACK_STICKERS_INITIAL_LIMIT_DESKTOP;
};

const normalizeGoogleAuthState = (value) => {
  const user = value?.user && typeof value.user === 'object' ? value.user : null;
  const sub = String(user?.sub || '').trim();
  if (!sub) return { user: null, expiresAt: '' };
  return {
    user: {
      sub,
      email: String(user?.email || '').trim(),
      name: String(user?.name || 'Conta Google').trim() || 'Conta Google',
      picture: String(user?.picture || '').trim(),
    },
    expiresAt: String(value?.expiresAt || '').trim(),
  };
};

const readGoogleAuthCache = () => {
  try {
    const raw = localStorage.getItem(GOOGLE_AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const savedAt = Number(parsed?.savedAt || 0);
    if (savedAt && __timeNowMs() - savedAt > GOOGLE_AUTH_CACHE_MAX_STALE_MS) {
      localStorage.removeItem(GOOGLE_AUTH_CACHE_KEY);
      return null;
    }
    const normalized = normalizeGoogleAuthState(parsed?.auth || null);
    if (!normalized.user?.sub) {
      localStorage.removeItem(GOOGLE_AUTH_CACHE_KEY);
      return null;
    }
    if (normalized.expiresAt) {
      const expiresAt = Number(new Date(normalized.expiresAt));
      if (Number.isFinite(expiresAt) && expiresAt <= __timeNowMs()) {
        localStorage.removeItem(GOOGLE_AUTH_CACHE_KEY);
        return null;
      }
    }
    return normalized;
  } catch {
    return null;
  }
};

const writeGoogleAuthCache = (authState) => {
  try {
    const normalized = normalizeGoogleAuthState(authState);
    if (!normalized.user?.sub) {
      localStorage.removeItem(GOOGLE_AUTH_CACHE_KEY);
      return;
    }
    localStorage.setItem(
      GOOGLE_AUTH_CACHE_KEY,
      JSON.stringify({
        auth: normalized,
        savedAt: __timeNowMs(),
      }),
    );
  } catch {
    // ignore storage errors
  }
};

const clearGoogleAuthCache = () => {
  try {
    localStorage.removeItem(GOOGLE_AUTH_CACHE_KEY);
  } catch {
    // ignore storage errors
  }
};

const normalizeToken = (value) =>
  String(value || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9- ]+/g, '');

const NSFW_HINT_TOKENS = ['nsfw', 'adult', 'explicit', 'suggestive', 'sexual', 'porn', 'nud', 'gore', '18', 'bikini', 'lingerie', 'underwear', 'swimsuit'];
const normalizeNsfwToken = (value) =>
  String(value || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9- ]+/g, '')
    .replace(/\s+/g, '-');

const hasNsfwHint = (value) => {
  const normalized = normalizeNsfwToken(value);
  if (!normalized) return false;
  return NSFW_HINT_TOKENS.some((token) => normalized.includes(token));
};

const hasNsfwHintsInList = (values) => {
  const list = Array.isArray(values) ? values : [];
  return list.some((entry) => hasNsfwHint(entry));
};

const isSignalMarkedNsfw = (signals) => {
  const level = String(signals?.nsfw_level || '')
    .trim()
    .toLowerCase();
  if (signals?.sensitive_content === true) return true;
  if (!level) return false;
  return level !== 'safe';
};

const isClassificationMarkedNsfw = (classification) => {
  if (!classification || typeof classification !== 'object') return false;
  if (classification.is_nsfw === true) return true;
  if (hasNsfwHint(classification.category || classification.majority_category || '')) return true;
  if (hasNsfwHintsInList(classification.tags)) return true;

  const nsfw = classification.nsfw || {};
  if (Number(nsfw.flagged_items || 0) > 0) return true;
  if (Number(nsfw.max_score || 0) >= 0.12) return true;
  if (Number(nsfw.avg_score || 0) >= 0.08) return true;
  return false;
};

const isPackMarkedNsfw = (pack) => {
  if (!pack || typeof pack !== 'object') return false;
  if (pack.is_nsfw === true) return true;
  if (isSignalMarkedNsfw(pack.signals)) return true;
  if (isClassificationMarkedNsfw(pack.classification)) return true;
  if (hasNsfwHint(pack.name || '')) return true;
  if (hasNsfwHint(pack.description || '')) return true;
  if (hasNsfwHintsInList(pack.tags) || hasNsfwHintsInList(pack.manual_tags)) return true;
  return false;
};

const isStickerMarkedNsfw = (item) => {
  if (!item || typeof item !== 'object') return false;
  if (item.is_nsfw === true) return true;
  if (isClassificationMarkedNsfw(item.classification || item.asset?.classification)) return true;
  if (hasNsfwHintsInList(item.tags)) return true;
  return false;
};

const shortNum = (value) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const getPackEngagement = (pack) => {
  const engagement = pack?.engagement || {};
  const likeCount = Number(engagement.like_count || 0);
  const dislikeCount = Number(engagement.dislike_count || 0);
  const openCount = Number(engagement.open_count || 0);
  const commentCount = Number(engagement.comment_count || pack?.comment_count || 0);
  return {
    likeCount,
    dislikeCount,
    openCount,
    commentCount,
    score: Number(engagement.score || likeCount - dislikeCount),
  };
};

const buildAvatarInitials = (value) => {
  const base = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!base) return 'OZ';
  const parts = base.split(' ').filter(Boolean);
  if (!parts.length) return 'OZ';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase();
};

const hashText = (value) => {
  let hash = 0;
  const input = String(value || '');
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash >>> 0;
};

const escapeXml = (value) =>
  String(value || '').replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&apos;';
  });

const getAvatarUrl = (name) => {
  const seed = String(name || 'OmniZap').trim() || 'OmniZap';
  const cached = AVATAR_URL_CACHE.get(seed);
  if (cached) return cached;

  const paletteIndex = hashText(seed) % AVATAR_BG_PALETTE.length;
  const background = AVATAR_BG_PALETTE[paletteIndex];
  const initials = escapeXml(buildAvatarInitials(seed));
  const ariaLabel = escapeXml(seed);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80' role='img' aria-label='${ariaLabel}'><rect width='80' height='80' rx='40' fill='${background}'/><text x='40' y='49' text-anchor='middle' font-family='Segoe UI, Roboto, Arial, sans-serif' font-size='30' font-weight='700' fill='#e2e8f0'>${initials}</text></svg>`;
  const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  if (AVATAR_URL_CACHE.size > 800) AVATAR_URL_CACHE.clear();
  AVATAR_URL_CACHE.set(seed, dataUrl);
  return dataUrl;
};

const parseCatalogSearchState = (search = '') => {
  const params = new URLSearchParams(String(search || ''));
  const pageParam = Number.parseInt(String(params.get('page') || ''), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : FIRST_CATALOG_PAGE;
  const filter = String(params.get('filter') || '')
    .trim()
    .toLowerCase();
  const hasTrendingFilter = filter === 'trending';
  const q = hasTrendingFilter ? '' : String(params.get('q') || '').trim();
  const category = hasTrendingFilter
    ? ''
    : String(params.get('category') || params.get('categories') || '')
        .trim()
        .toLowerCase();

  return {
    q,
    category,
    page,
    filter: hasTrendingFilter ? 'trending' : '',
    sort: hasTrendingFilter ? 'trending' : normalizeCatalogSort(params.get('sort') || ''),
  };
};

const parseCreatorsSearchState = (search = '') => {
  const params = new URLSearchParams(String(search || ''));
  return {
    sort: normalizeCreatorsSort(params.get('sort') || ''),
    q: String(params.get('q') || '').trim(),
  };
};

const parseStickersLocation = (webPath = '/stickers') => {
  const path = String(window.location.pathname || '');
  const basePath = String(webPath || '/stickers').replace(/\/+$/, '') || '/stickers';
  if (path === basePath || path === `${basePath}/`) return { view: 'catalog', packKey: '' };
  const baseWithSlash = `${basePath}/`;
  if (!path.startsWith(baseWithSlash)) return { view: 'catalog', packKey: '' };
  const suffix = path.slice(baseWithSlash.length);
  if (!suffix) return { view: 'catalog', packKey: '' };

  const firstSegmentRaw = suffix.split('/')[0] || '';
  if (!firstSegmentRaw) return { view: 'catalog', packKey: '' };

  try {
    const firstSegment = decodeURIComponent(firstSegmentRaw);
    if (
      PROFILE_ROUTE_SEGMENTS.has(
        String(firstSegment || '')
          .trim()
          .toLowerCase(),
      )
    ) {
      return { view: 'profile', packKey: '' };
    }
    if (
      CREATORS_ROUTE_SEGMENTS.has(
        String(firstSegment || '')
          .trim()
          .toLowerCase(),
      )
    ) {
      return { view: 'creators', packKey: '' };
    }
    return { view: 'pack', packKey: firstSegment };
  } catch {
    return { view: 'catalog', packKey: '' };
  }
};

const decodeJwtPayload = (jwt) => {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
};

const loadScript = (src) =>
  new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Falha ao carregar script: ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = '1';
      resolve();
    });
    script.addEventListener('error', () => reject(new Error(`Falha ao carregar script: ${src}`)));
    document.head.appendChild(script);
  });

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('Arquivo inválido.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Falha ao ler arquivo.'));
    reader.readAsDataURL(file);
  });

const moveArrayItem = (list, fromIndex, toIndex) => {
  const arr = Array.isArray(list) ? [...list] : [];
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= arr.length || toIndex >= arr.length) return arr;
  if (fromIndex === toIndex) return arr;
  const [item] = arr.splice(fromIndex, 1);
  arr.splice(toIndex, 0, item);
  return arr;
};

const parseTagsInputText = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, 8);

const isRecent = (dateString) => {
  if (!dateString) return false;
  const created = new Date(dateString).getTime();
  if (!Number.isFinite(created)) return false;
  return __timeNowMs() - created <= 1000 * 60 * 60 * 24 * 7;
};

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));

const tagLabel = (tag) => {
  const normalized = String(tag || '').toLowerCase();
  if (normalized.includes('nsfw')) return `🔞 ${String(tag).replace(/-/g, ' ').toUpperCase()}`;
  if (normalized.includes('game')) return `🎮 ${String(tag).replace(/-/g, ' ')}`;
  if (normalized.includes('anime')) return `🎌 ${String(tag).replace(/-/g, ' ')}`;
  if (normalized.includes('meme')) return `😂 ${String(tag).replace(/-/g, ' ')}`;
  return `🏷 ${String(tag).replace(/-/g, ' ')}`;
};

const readUploadTask = () => {
  try {
    const raw = localStorage.getItem(PACK_UPLOAD_TASK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

function UploadTaskWidget({ task, onClose }) {
  if (!task) return null;
  const progress = Math.max(0, Math.min(100, Number(task.progress || 0)));
  const status = String(task.status || 'running');
  const isDone = status === 'completed';
  const isError = status === 'error';
  const isPaused = status === 'paused';
  const title = isDone ? 'Pack publicado' : isError ? 'Falha na publicação' : isPaused ? 'Publicação pausada' : 'Publicando pack';
  const packUrl = String(task.packUrl || task.pack_url || '').trim();

  return html`
    <aside className="fixed bottom-4 right-4 z-[70] w-[min(92vw,360px)] rounded-2xl border border-slate-700 bg-slate-950/95 p-3 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-slate-100">${title}</p>
        <button type="button" onClick=${onClose} className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800">Fechar</button>
      </div>
      <p className="truncate text-xs text-slate-400">${task.message || `${task.current || 0}/${task.total || 0}`}</p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
        <div className=${`h-full transition-all ${isError ? 'bg-rose-400' : isDone ? 'bg-emerald-400' : isPaused ? 'bg-amber-400' : 'bg-cyan-400'}`} style=${{ width: `${progress}%` }}></div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px]">
        <span className="text-slate-400">${task.current || 0}/${task.total || 0}</span>
        <span className=${`${isError ? 'text-rose-300' : isDone ? 'text-emerald-300' : isPaused ? 'text-amber-300' : 'text-cyan-300'} font-semibold`}> ${progress}% </span>
      </div>
      ${(isDone || isPaused) && packUrl
        ? html`
            <div className="mt-2 flex gap-2">
              <a href=${packUrl} className="inline-flex rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-200">Abrir pack</a>
              ${isPaused ? html`<a href="/stickers/create/" className="inline-flex rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-amber-200">Retomar envio</a>` : null}
            </div>
          `
        : null}
    </aside>
  `;
}

function LazyCatalogImage({ src, alt = '', className = '', eager = false, fallbackSrc = DEFAULT_STICKER_PLACEHOLDER_URL, rootMargin = '180px 0px', threshold = 0.01 }) {
  const imageRef = useRef(null);
  const resolvedSrc = String(src || '').trim() || fallbackSrc;
  const [shouldLoad, setShouldLoad] = useState(() => Boolean(eager));

  useEffect(() => {
    if (eager || shouldLoad) return;
    if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') {
      setShouldLoad(true);
      return;
    }
    const node = imageRef.current;
    if (!node) {
      setShouldLoad(true);
      return;
    }
    const observer = new window.IntersectionObserver(
      (entries) => {
        const isVisible = entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0);
        if (isVisible) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin, threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [eager, shouldLoad, resolvedSrc, rootMargin, threshold]);

  return html`<img ref=${imageRef} src=${shouldLoad ? resolvedSrc : LAZY_IMAGE_PLACEHOLDER_DATA_URL} alt=${alt} className=${className} loading=${eager ? 'eager' : 'lazy'} decoding="async" fetchpriority=${eager ? 'high' : 'low'} />`;
}

function PackCard({ pack, index, onOpen, hasNsfwAccess = true, onRequireLogin }) {
  const isTrending = index < 4 || Number(pack?.sticker_count || 0) >= 30;
  const isNew = isRecent(pack?.created_at);
  const engagement = getPackEngagement(pack);
  const lockedByNsfw = isPackMarkedNsfw(pack) && !hasNsfwAccess;
  const coverUrl = lockedByNsfw ? NSFW_STICKER_PLACEHOLDER_URL : pack.cover_preview_url || pack.cover_url || DEFAULT_STICKER_PLACEHOLDER_URL;
  const handleOpen = () => {
    if (lockedByNsfw) {
      onRequireLogin?.();
      return;
    }
    onOpen(pack.pack_key);
  };

  return html`
    <button type="button" onClick=${handleOpen} className="group w-full text-left rounded-[1rem] border border-slate-700/75 bg-slate-900/90 shadow-[0_16px_34px_rgba(2,6,23,0.34)] overflow-hidden transition-all duration-300 active:scale-[0.985] md:hover:scale-[1.02] hover:-translate-y-0.5 hover:border-cyan-400/35 hover:shadow-[0_24px_40px_rgba(2,6,23,0.5)] touch-manipulation">
      <div className="relative aspect-[4/5] bg-slate-900 overflow-hidden">
        <${LazyCatalogImage} src=${coverUrl} alt=${`Capa de ${pack.name}`} className=${`w-full h-full object-cover transition-transform duration-300 ${lockedByNsfw ? 'blur-md scale-105' : 'md:group-hover:scale-[1.06] group-active:scale-[1.02]'}`} />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent"></div>
        <div className="absolute top-2 left-2 flex items-center gap-1">${lockedByNsfw ? html`<span className="rounded-full border border-amber-300/40 bg-amber-500/30 backdrop-blur px-1.5 py-0.5 text-[9px] font-bold text-amber-100">🔞 Login</span>` : null} ${isTrending ? html`<span className="rounded-full border border-emerald-300/35 bg-emerald-400/85 backdrop-blur px-1.5 py-0.5 text-[9px] font-bold text-slate-900">Trending</span>` : null} ${isNew ? html`<span className="rounded-full border border-white/20 bg-black/55 backdrop-blur px-1.5 py-0.5 text-[9px] font-semibold text-slate-100">Novo</span>` : null}</div>

        <div className="absolute inset-x-0 bottom-0 p-2">
          <h3 className="font-semibold text-sm leading-5 line-clamp-2 text-slate-100">${pack.name || 'Pack sem nome'}</h3>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-300">
            <${LazyCatalogImage} src=${getAvatarUrl(pack.publisher)} alt="Criador" className="w-4 h-4 rounded-full bg-slate-700" />
            <span className="truncate">${pack.publisher || 'Criador não informado'}</span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-300">
            <span>🧩 ${Number(pack.sticker_count || 0)}</span>
            <span>❤️ ${shortNum(engagement.likeCount)}</span>
            <span>⬇ ${shortNum(engagement.openCount)}</span>
          </p>
        </div>

        <div className="pointer-events-none absolute inset-x-2 bottom-2 hidden md:flex justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="inline-flex h-8 w-full items-center justify-center rounded-xl border border-cyan-400/35 bg-cyan-500/15 px-3 text-xs font-semibold text-cyan-100 backdrop-blur"> ${lockedByNsfw ? 'Entrar para desbloquear' : 'Ver pack'} </span>
        </div>
        ${lockedByNsfw
          ? html`
              <div className="pointer-events-none absolute inset-x-0 top-[42%] flex justify-center px-3">
                <span className="inline-flex rounded-xl border border-amber-400/40 bg-slate-950/70 px-2.5 py-1 text-[10px] font-semibold text-amber-100 backdrop-blur"> Conteúdo sensível </span>
              </div>
            `
          : null}
      </div>

      <div className="px-2 pb-2 pt-1 bg-slate-950/88 md:hidden">
        <span className="inline-flex h-[34px] w-full items-center justify-center rounded-xl border border-cyan-400/35 bg-cyan-500/15 text-xs font-semibold text-cyan-100 transition group-active:brightness-110"> ${lockedByNsfw ? 'Entrar para desbloquear' : 'Ver pack'} </span>
      </div>
    </button>
  `;
}

function DiscoverPackRowItem({ pack, onOpen, rank = 0, hasNsfwAccess = true, onRequireLogin }) {
  if (!pack?.pack_key) return null;
  const lockedByNsfw = isPackMarkedNsfw(pack) && !hasNsfwAccess;
  const handleOpen = () => {
    if (lockedByNsfw) {
      onRequireLogin?.();
      return;
    }
    onOpen(pack.pack_key);
  };
  return html`
    <button type="button" onClick=${handleOpen} className="w-full flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-2 py-1.5 text-left hover:bg-slate-800/90">
      <${LazyCatalogImage} src=${lockedByNsfw ? NSFW_STICKER_PLACEHOLDER_URL : pack.cover_preview_url || pack.cover_url || DEFAULT_STICKER_PLACEHOLDER_URL} alt="" className=${`h-9 w-9 rounded-lg object-cover bg-slate-800 ${lockedByNsfw ? 'blur-sm' : ''}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-slate-100">${rank > 0 ? `${rank}. ` : ''}${pack.name || 'Pack'}</span>
        <span className="block truncate text-[10px] text-slate-400"> ${lockedByNsfw ? '🔒 Entrar para desbloquear' : `${pack.publisher || '-'} · ❤️ ${shortNum(getPackEngagement(pack).likeCount)}`} </span>
      </span>
      <span className="text-[10px] text-slate-500">→</span>
    </button>
  `;
}

function DiscoverPackMiniCard({ pack, onOpen, hasNsfwAccess = true, onRequireLogin }) {
  if (!pack?.pack_key) return null;
  const engagement = getPackEngagement(pack);
  const lockedByNsfw = isPackMarkedNsfw(pack) && !hasNsfwAccess;
  const handleOpen = () => {
    if (lockedByNsfw) {
      onRequireLogin?.();
      return;
    }
    onOpen(pack.pack_key);
  };
  return html`
    <button type="button" onClick=${handleOpen} className="group w-[170px] shrink-0 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 text-left">
      <div className="relative h-24 bg-slate-900">
        <${LazyCatalogImage} src=${lockedByNsfw ? NSFW_STICKER_PLACEHOLDER_URL : pack.cover_preview_url || pack.cover_url || DEFAULT_STICKER_PLACEHOLDER_URL} alt="" className=${`h-full w-full object-cover transition-transform duration-200 ${lockedByNsfw ? 'blur-sm scale-105' : 'group-active:scale-[1.02]'}`} />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 to-transparent"></div>
        ${lockedByNsfw ? html`<span className="absolute top-1.5 left-1.5 rounded-full border border-amber-300/35 bg-amber-500/25 px-1.5 py-0.5 text-[9px] font-semibold text-amber-100">🔞 Login</span>` : null}
      </div>
      <div className="p-2">
        <p className="truncate text-xs font-semibold text-slate-100">${pack.name || 'Pack'}</p>
        <p className="mt-1 truncate text-[10px] text-slate-400">${lockedByNsfw ? 'Entrar para desbloquear' : `⬇ ${shortNum(engagement.openCount)} · ❤️ ${shortNum(engagement.likeCount)}`}</p>
      </div>
    </button>
  `;
}

function DiscoverCreatorMiniCard({ creator, onPick }) {
  if (!creator?.publisher) return null;
  return html`
    <button type="button" onClick=${() => onPick(creator.publisher)} className="w-[190px] shrink-0 rounded-xl border border-slate-800 bg-slate-900/70 p-2 text-left hover:bg-slate-800/90">
      <div className="flex items-center gap-2">
        <${LazyCatalogImage} src=${getAvatarUrl(creator.publisher)} alt="" className="h-9 w-9 rounded-full bg-slate-800" />
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-slate-100">${creator.publisher}</span>
          <span className="block truncate text-[10px] text-slate-400">${creator.packCount} packs · ❤️ ${shortNum(creator.likes)}</span>
        </span>
      </div>
    </button>
  `;
}

const isShareablePack = (pack) => {
  const visibility = String(pack?.visibility || '').toLowerCase();
  const status = String(pack?.status || '').toLowerCase();
  return (visibility === 'public' || visibility === 'unlisted') && status === 'published';
};

const formatVisibilityPill = (visibility) => {
  const normalized = String(visibility || '').toLowerCase();
  if (normalized === 'public')
    return {
      label: '🌍 Público',
      className: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200',
    };
  if (normalized === 'unlisted')
    return {
      label: '🔗 Não listado',
      className: 'border-cyan-500/35 bg-cyan-500/10 text-cyan-200',
    };
  return { label: '🔒 Privado', className: 'border-slate-600 bg-slate-900/80 text-slate-300' };
};

const formatStatusPill = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'published')
    return {
      label: '✅ Publicado',
      className: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200',
    };
  if (normalized === 'draft')
    return {
      label: '📝 Rascunho',
      className: 'border-amber-500/35 bg-amber-500/10 text-amber-200',
    };
  if (normalized === 'processing')
    return {
      label: '⚙️ Processando',
      className: 'border-indigo-500/35 bg-indigo-500/10 text-indigo-200',
    };
  if (normalized === 'uploading') return { label: '⏫ Enviando', className: 'border-sky-500/35 bg-sky-500/10 text-sky-200' };
  if (normalized === 'failed') return { label: '❌ Falhou', className: 'border-rose-500/35 bg-rose-500/10 text-rose-200' };
  return {
    label: `ℹ️ ${normalized || 'desconhecido'}`,
    className: 'border-slate-600 bg-slate-900/80 text-slate-300',
  };
};

function ToastStack({ toasts = [], onDismiss }) {
  if (!Array.isArray(toasts) || !toasts.length) return null;
  return html`
    <div className="fixed right-3 top-16 z-[90] flex w-[min(92vw,380px)] flex-col gap-2">
      ${toasts.map(
        (toast) => html`
          <div key=${toast.id} className=${`rounded-2xl border px-3 py-2.5 shadow-xl backdrop-blur ${toast.type === 'error' ? 'border-rose-500/35 bg-rose-500/15 text-rose-100' : toast.type === 'warning' ? 'border-amber-500/35 bg-amber-500/15 text-amber-100' : 'border-emerald-500/35 bg-emerald-500/15 text-emerald-100'}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm leading-5">${toast.message || ''}</p>
              <button type="button" onClick=${() => onDismiss?.(toast.id)} className="rounded-md border border-white/10 px-1.5 py-0.5 text-[11px] text-white/70 hover:bg-white/10">fechar</button>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function ConfirmDialog({ open = false, title = 'Confirmar', message = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', busy = false, danger = false, onCancel, onConfirm }) {
  if (!open) return null;
  return html`
    <div className="fixed inset-0 z-[88] flex items-end justify-center bg-black/60 p-3 sm:items-center">
      <button type="button" className="absolute inset-0" onClick=${busy ? undefined : onCancel} aria-label="Fechar"></button>
      <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
        <h3 className="text-base font-bold text-slate-100">${title}</h3>
        <p className="mt-2 text-sm text-slate-300">${message}</p>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick=${onCancel} disabled=${busy} className="h-10 rounded-xl border border-slate-700 px-4 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-60">${cancelLabel}</button>
          <button type="button" onClick=${onConfirm} disabled=${busy} className=${`h-10 rounded-xl border px-4 text-sm font-semibold disabled:opacity-60 ${danger ? 'border-rose-500/35 bg-rose-500/15 text-rose-100 hover:bg-rose-500/20' : 'border-emerald-500/35 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/20'}`}>${busy ? 'Processando...' : confirmLabel}</button>
        </div>
      </div>
    </div>
  `;
}

const PROFILE_PACK_ACTIONS = [
  { key: 'manage', label: '🛠️ Gerenciar pack' },
  { key: 'edit', label: '✏️ Editar pack' },
  { key: 'visibility', label: '👁️ Alterar visibilidade' },
  { key: 'duplicate', label: '📤 Duplicar pack' },
  { key: 'analytics', label: '📊 Ver analytics' },
  { key: 'delete', label: '🗑️ Apagar pack', danger: true },
];

function PackActionsSheet({ pack, open = false, busyAction = '', onClose, onAction }) {
  if (!open || !pack) return null;
  return html`
    <div className="fixed inset-0 z-[87] flex items-end justify-center bg-black/60 p-2 sm:items-center">
      <button type="button" className="absolute inset-0" onClick=${onClose} aria-label="Fechar"></button>
      <section className="relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
        <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-slate-700 sm:hidden"></div>
        <div className="mb-2 flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-2.5">
          <img src=${pack.cover_url || 'https://iili.io/fSNGag2.png'} alt="" className="h-14 w-14 rounded-xl border border-slate-800 bg-slate-900 object-cover" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">${pack.name || 'Pack'}</p>
            <p className="truncate text-xs text-slate-400">${pack.pack_key || '-'}</p>
          </div>
        </div>
        <div className="space-y-1">
          ${PROFILE_PACK_ACTIONS.map(
            (action) => html`
              <button key=${action.key} type="button" onClick=${() => onAction?.(action.key, pack)} disabled=${Boolean(busyAction)} className=${`w-full rounded-xl border px-3 py-3 text-left text-sm transition disabled:opacity-60 ${action.danger ? 'border-rose-500/25 bg-rose-500/10 text-rose-100 hover:bg-rose-500/15' : 'border-slate-700 bg-slate-950/60 text-slate-100 hover:bg-slate-800'}`}>
                <span>${busyAction === action.key ? '⏳ ' : ''}${action.label}</span>
              </button>
            `,
          )}
        </div>
        <button type="button" onClick=${onClose} className="mt-3 h-10 w-full rounded-xl border border-slate-700 text-sm text-slate-200 hover:bg-slate-800">Fechar</button>
      </section>
    </div>
  `;
}

function PackAnalyticsModal({ open = false, pack = null, data = null, loading = false, error = '', onClose }) {
  if (!open) return null;
  const analytics = data?.analytics || null;
  const publishState = data?.publish_state || null;
  return html`
    <div className="fixed inset-0 z-[86] flex items-end justify-center bg-black/60 p-3 sm:items-center">
      <button type="button" className="absolute inset-0" onClick=${onClose} aria-label="Fechar"></button>
      <section className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-3 sm:p-4 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Analytics</p>
            <h3 className="text-lg font-bold text-slate-100">${pack?.name || 'Pack'}</h3>
          </div>
          <button type="button" onClick=${onClose} className="h-9 rounded-lg border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800">Fechar</button>
        </div>

        ${loading
          ? html`<div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">${Array.from({ length: 4 }).map((_, i) => html`<div key=${i} className="h-20 animate-pulse rounded-xl border border-slate-800 bg-slate-950/50"></div>`)}</div>`
          : error
            ? html`<div className="mt-4 rounded-xl border border-rose-500/35 bg-rose-500/10 p-3 text-sm text-rose-200">${error}</div>`
            : html`
                <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                  <article className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400">Downloads</p>
                    <p className="text-lg font-bold text-slate-100">⬇ ${shortNum(analytics?.downloads || 0)}</p>
                  </article>
                  <article className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400">Likes</p>
                    <p className="text-lg font-bold text-slate-100">❤️ ${shortNum(analytics?.likes || 0)}</p>
                  </article>
                  <article className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400">Dislikes</p>
                    <p className="text-lg font-bold text-slate-100">👎 ${shortNum(analytics?.dislikes || 0)}</p>
                  </article>
                  <article className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[11px] text-slate-400">Score</p>
                    <p className="text-lg font-bold text-slate-100">⭐ ${shortNum(analytics?.score || 0)}</p>
                  </article>
                </div>
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <article className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-xs font-semibold text-slate-200">Últimas 24h vs 7 dias</p>
                    <div className="mt-2 space-y-1.5 text-xs text-slate-300">
                      <p>
                        👆 Aberturas:
                        <span className="font-semibold text-slate-100">${shortNum(analytics?.interaction_window?.open_horizon || 0)}</span>
                        / ${shortNum(analytics?.interaction_window?.open_baseline || 0)}
                      </p>
                      <p>
                        ❤️ Likes:
                        <span className="font-semibold text-slate-100">${shortNum(analytics?.interaction_window?.like_horizon || 0)}</span>
                        / ${shortNum(analytics?.interaction_window?.like_baseline || 0)}
                      </p>
                      <p>
                        👎 Dislikes:
                        <span className="font-semibold text-slate-100">${shortNum(analytics?.interaction_window?.dislike_horizon || 0)}</span>
                        / ${shortNum(analytics?.interaction_window?.dislike_baseline || 0)}
                      </p>
                    </div>
                  </article>
                  <article className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-xs font-semibold text-slate-200">Status de publicação</p>
                    <div className="mt-2 space-y-1.5 text-xs text-slate-300">
                      <p>
                        Status:
                        <span className="font-semibold text-slate-100">${publishState?.status || '-'}</span>
                      </p>
                      <p>
                        Figurinhas:
                        <span className="font-semibold text-slate-100">${shortNum(publishState?.consistency?.sticker_count || 0)}</span>
                      </p>
                      <p>
                        Uploads falhos:
                        <span className="font-semibold text-slate-100">${shortNum(publishState?.consistency?.failed_uploads || 0)}</span>
                      </p>
                      <p>
                        Capa válida:
                        <span className="font-semibold text-slate-100">${publishState?.consistency?.cover_valid ? 'sim' : 'não'}</span>
                      </p>
                    </div>
                  </article>
                </div>
              `}
      </section>
    </div>
  `;
}

function CreatorPackCardPro({ pack, onOpenPublic, onOpenActions, onOpenManage, onQuickDelete, actionBusy = '' }) {
  const visibilityPill = formatVisibilityPill(pack?.visibility);
  const statusPill = formatStatusPill(pack?.status);
  const engagement = getPackEngagement(pack);
  const shareable = isShareablePack(pack) && Boolean(pack?.pack_key);
  const coverUrl = pack?.cover_url || 'https://iili.io/fSNGag2.png';
  const isCoverHidden = !pack?.cover_url && !isShareablePack(pack);

  return html`
    <article className="group min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lg">
      <div className="relative">
        <img src=${coverUrl} alt=${`Capa de ${pack?.name || 'Pack'}`} className="h-24 w-full object-cover bg-slate-950 sm:h-28 md:h-32" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/25 to-transparent"></div>
        <div className="absolute left-2 top-2 flex flex-wrap gap-1.5">
          <span className=${`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${statusPill.className}`}>${statusPill.label}</span>
          <span className=${`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${visibilityPill.className}`}>${visibilityPill.label}</span>
        </div>
        <button type="button" onClick=${() => onOpenActions?.(pack)} className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-700/90 bg-slate-950/80 text-slate-100 hover:bg-slate-800" title="Ações">⋮</button>
        ${isCoverHidden ? html`<div className="absolute bottom-2 left-2 rounded-full border border-slate-600 bg-slate-950/80 px-2 py-0.5 text-[10px] text-slate-300">🔒 capa oculta no catálogo</div>` : null}
      </div>

      <div className="min-w-0 p-2 space-y-1.5 sm:p-2.5 sm:space-y-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold text-slate-100 sm:text-[15px]">${pack?.name || 'Pack sem nome'}</h3>
          <p className="truncate text-[10px] text-slate-500/90">${pack?.pack_key || '-'}</p>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-slate-800 bg-slate-950/35 px-2 py-1.5">
          <p className="text-[10px] text-slate-300">🧩 ${shortNum(pack?.sticker_count || 0)}</p>
          <p className="text-[10px] text-slate-300">❤️ ${shortNum(engagement.likeCount)}</p>
          <p className="text-[10px] text-slate-300">⬇ ${shortNum(engagement.openCount)}</p>
          <p className="hidden truncate text-[10px] text-slate-400 sm:block">📅 ${pack?.updated_at ? new Date(pack.updated_at).toLocaleDateString('pt-BR') : '-'}</p>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <button type="button" onClick=${() => onOpenManage?.(pack)} disabled=${Boolean(actionBusy)} className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-950/60 px-1 text-[11px] text-slate-100 hover:bg-slate-800 disabled:opacity-60" title="Adicionar sticker">
            <span className="sm:hidden">➕</span>
            <span className="hidden sm:inline">➕ Sticker</span>
          </button>
          <button type="button" onClick=${() => onOpenManage?.(pack)} disabled=${Boolean(actionBusy)} className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-950/60 px-1 text-[11px] text-slate-100 hover:bg-slate-800 disabled:opacity-60" title="Editar pack">
            <span className="sm:hidden">✏️</span>
            <span className="hidden sm:inline">✏️ Editar</span>
          </button>
          <button type="button" onClick=${() => onQuickDelete?.(pack)} disabled=${Boolean(actionBusy)} className="inline-flex h-8 items-center justify-center rounded-lg border border-rose-500/25 bg-rose-500/10 px-1 text-[11px] text-rose-100 hover:bg-rose-500/15 disabled:opacity-60" title="Excluir pack">
            <span className="sm:hidden">🗑️</span>
            <span className="hidden sm:inline">🗑️ Excluir</span>
          </button>
        </div>

        <div className="flex gap-2">
          <button type="button" onClick=${() => onOpenManage?.(pack)} disabled=${Boolean(actionBusy)} className="inline-flex h-8 flex-1 items-center justify-center rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-2.5 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60 sm:h-9 sm:text-xs">${actionBusy === 'manage' ? 'Abrindo...' : 'Gerenciar pack'}</button>
          ${shareable ? html` <button type="button" onClick=${() => onOpenPublic?.(pack.pack_key)} className="inline-flex h-8 items-center justify-center rounded-xl border border-slate-700 bg-slate-950/60 px-2.5 text-[11px] font-medium text-slate-100 hover:bg-slate-800 sm:h-9 sm:px-3 sm:text-xs">Abrir</button> ` : html`<span className="inline-flex h-9 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/40 px-3 text-[11px] text-slate-500">Sem link público</span>`}
        </div>
      </div>
    </article>
  `;
}

function PackManagerModal({ open = false, data = null, loading = false, error = '', busyAction = '', onClose, onRefresh, onSaveMetadata, onAddSticker, onRemoveSticker, onReplaceSticker, onSetCover, onReorder, onOpenAnalytics }) {
  const pack = data?.pack || null;
  const publishState = data?.publish_state || null;
  const analytics = data?.analytics || null;
  const items = Array.isArray(pack?.items) ? pack.items : [];

  const [name, setName] = useState('');
  const [publisher, setPublisher] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [visibility, setVisibility] = useState('public');
  const [orderIds, setOrderIds] = useState([]);
  const [draggingId, setDraggingId] = useState('');

  useEffect(() => {
    if (!pack) return;
    setName(String(pack.name || ''));
    setPublisher(String(pack.publisher || ''));
    setDescription(String(pack.description || ''));
    setTagsText(Array.isArray(pack.manual_tags) ? pack.manual_tags.join(', ') : '');
    setVisibility(String(pack.visibility || 'public'));
    setOrderIds(items.map((item) => item.sticker_id).filter(Boolean));
  }, [pack?.id, pack?.version, items.length]);

  useEffect(() => {
    if (!pack) return;
    const itemIds = items.map((item) => item.sticker_id).filter(Boolean);
    setOrderIds((prev) => {
      const current = Array.isArray(prev) ? prev.filter((id) => itemIds.includes(id)) : [];
      const missing = itemIds.filter((id) => !current.includes(id));
      return [...current, ...missing];
    });
  }, [pack?.id, items.map((item) => item.sticker_id).join('|')]);

  if (!open) return null;

  const orderMap = new Map(items.map((item) => [item.sticker_id, item]));
  const orderedItems = orderIds.map((id) => orderMap.get(id)).filter(Boolean);
  const orderDirty = orderedItems.length === items.length && orderedItems.some((item, index) => String(item?.sticker_id || '') !== String(items[index]?.sticker_id || ''));

  return html`
    <div className="fixed inset-0 z-[85] flex items-end justify-center bg-black/65 p-2 sm:items-center sm:p-4">
      <button type="button" className="absolute inset-0" onClick=${onClose} aria-label="Fechar"></button>
      <section className="relative flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl sm:h-[min(94vh,960px)] sm:rounded-3xl">
        <header className="border-b border-slate-800 bg-slate-950/70 px-3 py-2.5 sm:px-4 sm:py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-slate-400">Gerenciar pack</p>
              <h3 className="truncate text-base font-bold text-slate-100 sm:text-lg">${pack?.name || 'Carregando...'}</h3>
              <p className="truncate text-xs text-slate-500">${pack?.pack_key || '-'}</p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:justify-end sm:gap-2">
              <label className=${`inline-flex h-9 cursor-pointer items-center rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-2.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/20 sm:h-10 sm:px-3 sm:text-xs ${busyAction ? 'pointer-events-none opacity-60' : ''}`}>
                <span className="sm:hidden">➕ Sticker</span>
                <span className="hidden sm:inline">➕ Adicionar sticker</span>
                <input
                  type="file"
                  accept="image/*,video/mp4,video/webm,video/quicktime,video/x-m4v"
                  className="hidden"
                  disabled=${Boolean(busyAction)}
                  onChange=${(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    onAddSticker?.(file);
                    event.target.value = '';
                  }}
                />
              </label>
              <button type="button" onClick=${onOpenAnalytics} disabled=${loading || !pack || Boolean(busyAction)} className="h-9 rounded-xl border border-indigo-500/35 bg-indigo-500/10 px-2.5 text-[11px] font-semibold text-indigo-100 hover:bg-indigo-500/20 disabled:opacity-60 sm:h-10 sm:px-3 sm:text-xs">📊 <span className="hidden sm:inline">Analytics</span></button>
              <button type="button" onClick=${onRefresh} disabled=${Boolean(busyAction) || loading} className="h-9 rounded-xl border border-slate-700 px-2.5 text-[11px] text-slate-100 hover:bg-slate-800 disabled:opacity-60 sm:h-10 sm:px-3 sm:text-xs">${loading ? 'Atualizando...' : 'Atualizar'}</button>
              <button type="button" onClick=${onClose} disabled=${Boolean(busyAction)} className="ml-auto h-9 rounded-xl border border-slate-700 px-2.5 text-[11px] text-slate-100 hover:bg-slate-800 disabled:opacity-60 sm:ml-0 sm:h-10 sm:px-3 sm:text-xs">Fechar</button>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto overflow-x-hidden p-2.5 sm:p-4">
          ${loading
            ? html`
                <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
                  <div className="space-y-3">${Array.from({ length: 4 }).map((_, i) => html`<div key=${i} className="h-24 animate-pulse rounded-2xl border border-slate-800 bg-slate-950/50"></div>`)}</div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">${Array.from({ length: 8 }).map((_, i) => html`<div key=${i} className="aspect-square animate-pulse rounded-2xl border border-slate-800 bg-slate-950/50"></div>`)}</div>
                </div>
              `
            : error
              ? html`<div className="rounded-2xl border border-rose-500/35 bg-rose-500/10 p-3 text-sm text-rose-200">${error}</div>`
              : !pack
                ? html`<div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-300">Pack não carregado.</div>`
                : html`
                    <div className="grid gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
                      <aside className="space-y-3">
                        <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-2.5 sm:p-3 space-y-3">
                          <div className="flex gap-3">
                            <img src=${pack.cover_url || 'https://iili.io/fSNGag2.png'} alt="" className="h-20 w-20 rounded-2xl border border-slate-800 bg-slate-900 object-cover" />
                            <div className="min-w-0 space-y-1">
                              <p className="truncate text-sm font-semibold text-slate-100">${pack.name || 'Pack'}</p>
                              <p className="truncate text-[11px] text-slate-400">${pack.pack_key || '-'}</p>
                              <div className="flex flex-wrap gap-1.5">
                                <span className=${`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${formatStatusPill(pack.status).className}`}>${formatStatusPill(pack.status).label}</span>
                                <span className=${`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${formatVisibilityPill(pack.visibility).className}`}>${formatVisibilityPill(pack.visibility).label}</span>
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-2">
                              <p className="text-slate-400">Stickers</p>
                              <p className="font-semibold text-slate-100">${shortNum(pack.sticker_count || 0)}</p>
                            </div>
                            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-2">
                              <p className="text-slate-400">Downloads</p>
                              <p className="font-semibold text-slate-100">${shortNum(analytics?.downloads || 0)}</p>
                            </div>
                            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-2">
                              <p className="text-slate-400">Likes</p>
                              <p className="font-semibold text-slate-100">${shortNum(analytics?.likes || 0)}</p>
                            </div>
                            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-2">
                              <p className="text-slate-400">Pronto p/ publicar</p>
                              <p className="font-semibold text-slate-100">${publishState?.consistency?.can_publish ? 'Sim' : 'Não'}</p>
                            </div>
                          </div>
                        </section>

                        <form
                          onSubmit=${(event) => {
                            event.preventDefault();
                            onSaveMetadata?.({
                              name,
                              publisher,
                              description,
                              tags: parseTagsInputText(tagsText),
                              visibility,
                            });
                          }}
                          className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3 space-y-3"
                        >
                          <div>
                            <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">Nome</label>
                            <input value=${name} onChange=${(e) => setName(e.target.value)} maxlength="120" className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-cyan-400/40" />
                          </div>
                          <div>
                            <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">Publisher</label>
                            <input value=${publisher} onChange=${(e) => setPublisher(e.target.value)} maxlength="120" className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-cyan-400/40" />
                          </div>
                          <div>
                            <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">Descrição</label>
                            <textarea value=${description} onChange=${(e) => setDescription(e.target.value)} rows="3" maxlength="1024" className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/40"></textarea>
                          </div>
                          <div>
                            <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">Tags (separadas por vírgula)</label>
                            <input value=${tagsText} onChange=${(e) => setTagsText(e.target.value)} placeholder="meme, reaction, anime" className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-cyan-400/40" />
                            <p className="mt-1 text-[11px] text-slate-500">Salvas no metadata do pack (máx. 8).</p>
                          </div>
                          <div>
                            <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">Visibilidade</label>
                            <select value=${visibility} onChange=${(e) => setVisibility(e.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-cyan-400/40">
                              <option value="public">Público</option>
                              <option value="unlisted">Não listado</option>
                              <option value="private">Privado</option>
                            </select>
                          </div>
                          <button type="submit" disabled=${Boolean(busyAction)} className="h-11 w-full rounded-xl border border-cyan-500/35 bg-cyan-500/10 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60">${busyAction === 'saveMetadata' ? 'Salvando...' : 'Salvar alterações'}</button>
                        </form>
                      </aside>

                      <section className="space-y-3 min-w-0">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h4 className="text-base font-bold text-slate-100">Stickers do pack</h4>
                            <p className="text-[11px] text-slate-400">Arraste para reordenar. Use ⭐, 🔁 e ❌.</p>
                          </div>
                          ${orderDirty ? html` <button type="button" onClick=${() => onReorder?.(orderIds)} disabled=${Boolean(busyAction)} className="h-9 rounded-xl border border-amber-500/35 bg-amber-500/10 px-2.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/20 disabled:opacity-60 sm:h-10 sm:px-3 sm:text-xs">${busyAction === 'reorder' ? 'Salvando ordem...' : 'Salvar ordem'}</button> ` : null}
                        </div>

                        ${orderedItems.length
                          ? html`
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
                                ${orderedItems.map((item, index) => {
                                  const isCover = String(pack?.cover_sticker_id || '') === String(item?.sticker_id || '');
                                  return html`
                                    <article
                                      key=${item.sticker_id}
                                      draggable="true"
                                      onDragStart=${() => setDraggingId(item.sticker_id)}
                                      onDragOver=${(e) => e.preventDefault()}
                                      onDrop=${(e) => {
                                        e.preventDefault();
                                        const fromIndex = orderIds.findIndex((id) => id === draggingId);
                                        const toIndex = orderIds.findIndex((id) => id === item.sticker_id);
                                        if (fromIndex >= 0 && toIndex >= 0) {
                                          setOrderIds(moveArrayItem(orderIds, fromIndex, toIndex));
                                        }
                                        setDraggingId('');
                                      }}
                                      className=${`group overflow-hidden rounded-2xl border bg-slate-950/40 ${draggingId === item.sticker_id ? 'border-cyan-400/50' : 'border-slate-800'}`}
                                    >
                                      <div className="relative aspect-square bg-slate-950">
                                        <img src=${item.asset_url || 'https://iili.io/fSNGag2.png'} alt=${item.accessibility_label || 'Sticker'} className="h-full w-full object-contain" loading="lazy" />
                                        <div className="absolute left-2 top-2 rounded-full border border-slate-700 bg-slate-950/90 px-2 py-0.5 text-[10px] text-slate-200">#${index + 1}</div>
                                        ${isCover ? html`<div className="absolute right-2 top-2 rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-100">⭐ Capa</div>` : null}
                                      </div>
                                      <div className="p-1.5 space-y-1.5 sm:p-2 sm:space-y-2">
                                        <p className="truncate text-[10px] text-slate-500">${item.sticker_id}</p>
                                        <div className="grid grid-cols-3 gap-1.5">
                                          <button type="button" title="Definir como capa" onClick=${() => onSetCover?.(item.sticker_id)} disabled=${Boolean(busyAction)} className="h-8 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-100 hover:bg-amber-500/15 disabled:opacity-60">⭐</button>
                                          <label className=${`inline-flex h-8 cursor-pointer items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 text-[11px] text-cyan-100 hover:bg-cyan-500/15 ${busyAction ? 'pointer-events-none opacity-60' : ''}`} title="Substituir sticker">
                                            🔁
                                            <input
                                              type="file"
                                              accept="image/*,video/mp4,video/webm,video/quicktime,video/x-m4v"
                                              className="hidden"
                                              disabled=${Boolean(busyAction)}
                                              onChange=${(event) => {
                                                const file = event.target.files?.[0];
                                                if (!file) return;
                                                onReplaceSticker?.(item.sticker_id, file);
                                                event.target.value = '';
                                              }}
                                            />
                                          </label>
                                          <button type="button" title="Remover sticker" onClick=${() => onRemoveSticker?.(item.sticker_id)} disabled=${Boolean(busyAction)} className="h-8 rounded-lg border border-rose-500/30 bg-rose-500/10 text-[11px] text-rose-100 hover:bg-rose-500/15 disabled:opacity-60">❌</button>
                                        </div>
                                      </div>
                                    </article>
                                  `;
                                })}
                              </div>
                            `
                          : html`<div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/40 p-6 text-center text-sm text-slate-300">Este pack ainda não possui stickers.</div>`}
                      </section>
                    </div>
                  `}
        </div>

        <footer className="border-t border-slate-800 bg-slate-950/80 px-3 py-2">
          <div className="flex flex-col gap-1 text-[11px] text-slate-400 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2 sm:text-xs">
            <span className="truncate">${busyAction ? `Processando: ${busyAction}` : 'Pronto para gerenciar.'}</span>
            <span className="break-words">${publishState?.consistency?.can_publish ? '✅ Pack consistente para publicação' : '⚠️ Revise capa/uploads/stickers antes de publicar'}</span>
          </div>
        </footer>
      </section>
    </div>
  `;
}

function CreatorProfileDashboard({ googleAuthConfig, googleAuth, googleAuthBusy, googleAuthError, googleSessionChecked, myPacks, myPacksLoading, myPacksError, myProfileStats, onBack, onRefresh, onLogout, onOpenPublicPack, onOpenPackActions, onOpenManagePack, onRequestDeletePack, packActionBusyByKey = {} }) {
  const [packSearch, setPackSearch] = useState('');
  const [packSort, setPackSort] = useState('recent');
  const [packFilter, setPackFilter] = useState('all');
  const hasGoogleLogin = Boolean(googleAuth?.user?.sub);
  const googleLoginEnabled = Boolean(googleAuthConfig?.enabled && googleAuthConfig?.clientId);
  const packs = Array.isArray(myPacks) ? myPacks : [];
  const totals = packs.reduce(
    (acc, pack) => {
      const engagement = getPackEngagement(pack);
      acc.downloads += Number(engagement.openCount || 0);
      acc.likes += Number(engagement.likeCount || 0);
      acc.stickers += Number(pack?.sticker_count || 0);
      if (String(pack?.status || '').toLowerCase() === 'published') {
        acc.publishedStickers += Number(pack?.sticker_count || 0);
      }
      return acc;
    },
    { downloads: 0, likes: 0, stickers: 0, publishedStickers: 0 },
  );
  const filteredSortedPacks = useMemo(() => {
    const q = normalizeToken(packSearch);
    const next = packs.filter((pack) => {
      if (packFilter !== 'all') {
        const status = String(pack?.status || '').toLowerCase();
        const visibility = String(pack?.visibility || '').toLowerCase();
        if (packFilter === 'published' && status !== 'published') return false;
        if (packFilter === 'draft' && status !== 'draft') return false;
        if (packFilter === 'private' && visibility !== 'private') return false;
        if (packFilter === 'unlisted' && visibility !== 'unlisted') return false;
      }
      if (!q) return true;
      const searchable = [pack?.name, pack?.publisher, pack?.pack_key, pack?.description, ...(Array.isArray(pack?.manual_tags) ? pack.manual_tags : [])].map((value) => normalizeToken(value)).join(' ');
      return searchable.includes(q);
    });

    next.sort((a, b) => {
      const ea = getPackEngagement(a);
      const eb = getPackEngagement(b);
      if (packSort === 'downloads') return eb.openCount - ea.openCount;
      if (packSort === 'likes') return eb.likeCount - ea.likeCount;
      return new Date(b?.updated_at || b?.created_at || 0).getTime() - new Date(a?.updated_at || a?.created_at || 0).getTime();
    });
    return next;
  }, [packs, packSearch, packSort, packFilter]);
  const visibleCountLabel = `${filteredSortedPacks.length}${packSearch.trim() || packFilter !== 'all' ? ` de ${packs.length}` : ''}`;
  const profileStatusChips = [
    { key: 'published', label: '🟢 Publicados', value: Number(myProfileStats?.published || 0) },
    { key: 'draft', label: '🟡 Rascunhos', value: Number(myProfileStats?.drafts || 0) },
    { key: 'private', label: '🔒 Privados', value: Number(myProfileStats?.private || 0) },
    { key: 'unlisted', label: '🔵 Não listados', value: Number(myProfileStats?.unlisted || 0) },
  ];
  const packFilterOptions = [
    { key: 'all', label: 'Todos' },
    { key: 'published', label: 'Publicados' },
    { key: 'draft', label: 'Rascunhos' },
    { key: 'private', label: 'Privados' },
    { key: 'unlisted', label: 'Não listados' },
  ];

  return html`
    <section className="space-y-3 pb-16 sm:pb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick=${onBack} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">← Catálogo</button>
        <div className="flex items-center gap-2">
          <a href="/user/" className="inline-flex h-10 items-center rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/20">👤 Minha conta</a>
          <button type="button" onClick=${onRefresh} disabled=${myPacksLoading || googleAuthBusy} className="inline-flex h-10 items-center rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-3 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-60">${myPacksLoading ? '...' : '⟳'}</button>
        </div>
      </div>

      <section className="relative overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-900 p-3.5 sm:p-4">
        <div className="pointer-events-none absolute -right-10 -top-8 h-40 w-40 rounded-full bg-cyan-400/15 blur-3xl"></div>
        <div className="pointer-events-none absolute -left-8 bottom-0 h-32 w-32 rounded-full bg-emerald-400/10 blur-3xl"></div>
        <div className="relative">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <img src=${googleAuth?.user?.picture || getAvatarUrl(googleAuth?.user?.name || 'creator')} alt="Avatar" className="h-20 w-20 rounded-2xl border border-slate-700 bg-slate-900 object-cover sm:h-24 sm:w-24" />
              <div className="min-w-0">
                <div className="mb-1 inline-flex items-center gap-1 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-100">🧩 Gestão de stickers</div>
                <h1 className="truncate text-2xl font-extrabold tracking-tight text-slate-100 sm:text-3xl">Gerenciamento de Packs</h1>
                <p className="truncate text-xs text-slate-400">Organize uploads, capa, ordem e publicação dos seus stickers.</p>
                <p className="mt-0.5 text-[11px] text-slate-500">Área exclusiva para gerenciamento dos seus packs.</p>
              </div>
            </div>
            ${hasGoogleLogin ? html`<button type="button" onClick=${onLogout} disabled=${googleAuthBusy} className="inline-flex h-10 items-center rounded-xl border border-slate-700 px-3 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-60">${googleAuthBusy ? 'Saindo...' : 'Sair'}</button>` : null}
          </div>

          ${hasGoogleLogin
            ? html`
                <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-950/35 p-2.5">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-2.5 py-2">
                      <p className="text-[10px] text-slate-400">Packs</p>
                      <p className="text-base font-bold text-slate-100">${shortNum(myProfileStats?.total || 0)}</p>
                    </div>
                    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-2.5 py-2">
                      <p className="text-[10px] text-slate-400">Downloads</p>
                      <p className="text-base font-bold text-slate-100">${shortNum(totals.downloads)}</p>
                    </div>
                    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-2.5 py-2">
                      <p className="text-[10px] text-slate-400">Likes</p>
                      <p className="text-base font-bold text-slate-100">${shortNum(totals.likes)}</p>
                    </div>
                    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-2.5 py-2">
                      <p className="text-[10px] text-slate-400">Stickers publicados</p>
                      <p className="text-base font-bold text-slate-100">${shortNum(totals.publishedStickers)}</p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    ${profileStatusChips.map(
                      (chip) => html`
                        <button key=${chip.key} type="button" onClick=${() => setPackFilter((prev) => (prev === chip.key ? 'all' : chip.key))} className=${`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${packFilter === chip.key ? 'border-cyan-400/35 bg-cyan-500/10 text-cyan-100' : 'border-slate-700 bg-slate-900/50 text-slate-300 hover:bg-slate-800'}`}>
                          <span>${chip.label}</span>
                          <span className="font-semibold">${shortNum(chip.value)}</span>
                        </button>
                      `,
                    )}
                  </div>
                </div>
              `
            : null}
        </div>
      </section>

      ${!hasGoogleLogin
        ? html`
            <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-3">
              <div className="space-y-2.5">
                <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
                  <p className="text-sm font-semibold text-cyan-200">Sessão necessária para gerenciamento</p>
                  <p className="mt-1 text-xs text-slate-300">${googleLoginEnabled ? 'Esta área é exclusiva para gerenciar seus packs e stickers. Redirecionando para o login...' : 'Login Google indisponível no momento.'}</p>
                </div>
                ${!googleSessionChecked ? html`<p className="text-xs text-slate-400">Verificando sessão...</p>` : null} ${googleAuthError ? html`<p className="text-xs text-rose-300">${googleAuthError}</p>` : null}
              </div>
            </section>
          `
        : html`
            ${myPacksError ? html`<div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">${myPacksError}</div>` : null}

            <section className="space-y-2.5">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-bold text-slate-100">Packs criados por você</h2>
                    <p className="text-xs text-slate-400">Busca, ordenação e gerenciamento rápido.</p>
                  </div>
                  <span className="text-xs text-slate-400">${myPacksLoading ? 'Carregando...' : `${visibleCountLabel} pack(s)`}</span>
                </div>

                <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_180px]">
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">🔎</span>
                    <input type="search" value=${packSearch} onChange=${(e) => setPackSearch(e.target.value)} placeholder="Buscar packs..." className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950/60 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-cyan-400/40" />
                  </div>
                  <select value=${packSort} onChange=${(e) => setPackSort(e.target.value)} className="h-10 rounded-xl border border-slate-700 bg-slate-950/60 px-3 text-sm text-slate-100 outline-none focus:border-cyan-400/40">
                    <option value="recent">Mais recente</option>
                    <option value="downloads">Mais downloads</option>
                    <option value="likes">Mais likes</option>
                  </select>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">${packFilterOptions.map((option) => html` <button key=${option.key} type="button" onClick=${() => setPackFilter(option.key)} className=${`h-8 rounded-full border px-2.5 text-[11px] ${packFilter === option.key ? 'border-cyan-400/35 bg-cyan-500/10 text-cyan-100' : 'border-slate-700 bg-slate-950/50 text-slate-300 hover:bg-slate-800'}`}>${option.label}</button> `)}</div>
              </div>

              ${myPacksLoading
                ? html` <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">${Array.from({ length: 6 }).map((_, index) => html`<div key=${index} className="h-56 animate-pulse rounded-2xl border border-slate-800 bg-slate-900/70"></div>`)}</div> `
                : filteredSortedPacks.length
                  ? html` <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">${filteredSortedPacks.map((pack) => html` <${CreatorPackCardPro} key=${pack.id || pack.pack_key} pack=${pack} onOpenPublic=${onOpenPublicPack} onOpenActions=${onOpenPackActions} onOpenManage=${onOpenManagePack} onQuickDelete=${onRequestDeletePack} actionBusy=${packActionBusyByKey?.[pack.pack_key] || ''} /> `)}</div> `
                  : html`
                      <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-5 text-center">
                        <p className="text-sm font-semibold text-slate-100">${packs.length ? 'Nenhum pack corresponde aos filtros.' : 'Nenhum pack encontrado para esta conta.'}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          ${packs.length
                            ? 'Tente limpar busca/filtros para ver seus packs.'
                            : html`Crie um pack com essa conta Google em
                                <a href="/stickers/create/" className="text-cyan-300 underline">/stickers/create</a>
                                e volte aqui.`}
                        </p>
                        ${packs.length
                          ? html`<button
                              type="button"
                              onClick=${() => {
                                setPackSearch('');
                                setPackFilter('all');
                              }}
                              className="mt-3 h-9 rounded-xl border border-slate-700 px-3 text-xs text-slate-100 hover:bg-slate-800"
                            >
                              Limpar filtros
                            </button>`
                          : null}
                      </div>
                    `}
            </section>
          `}
    </section>
  `;
}

function SkeletonGrid({ count = 10 }) {
  return html`
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
      ${Array.from({ length: count }).map(
        (_, index) => html`
          <div key=${index} className="rounded-2xl border border-slate-700 bg-slate-800 overflow-hidden animate-pulse">
            <div className="aspect-[4/5] bg-slate-700"></div>
            <div className="p-2.5 space-y-2">
              <div className="h-3 rounded bg-slate-700"></div>
              <div className="h-3 w-2/3 rounded bg-slate-700"></div>
              <div className="h-11 rounded-xl bg-slate-700"></div>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function EmptyState({ onClear }) {
  return html`
    <div className="market-glass rounded-3xl p-8 text-center sm:p-10">
      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-400/35 bg-cyan-500/12 text-2xl">🧩</div>
      <p className="text-slate-100 font-semibold text-lg">Nenhum pack encontrado</p>
      <p className="text-slate-400 text-sm mt-1">Tente outra busca, categoria ou limpe os filtros para descobrir novos packs.</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick=${onClear} className="inline-flex items-center justify-center rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 transition">Limpar filtros</button>
        <a href="/stickers/create/" className="inline-flex items-center justify-center rounded-xl border border-emerald-400/35 bg-emerald-500/12 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/22 transition">Criar pack</a>
      </div>
    </div>
  `;
}

function CatalogSortPicker({ open = false, currentSort = DEFAULT_CATALOG_SORT, busy = false, onClose, onSelect }) {
  if (!open) return null;
  const selectedSort = normalizeCatalogSort(currentSort);

  return html`
    <div className="fixed inset-0 z-[85]">
      <button type="button" className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-label="Fechar ordenação" onClick=${onClose}></button>
      <div className="absolute inset-x-0 bottom-0 sm:inset-auto sm:right-4 sm:top-16 sm:w-[360px]">
        <div className="rounded-t-2xl sm:rounded-2xl border border-slate-700 bg-slate-950/95 p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Ordenar catálogo</p>
              <p className="text-sm font-semibold text-slate-100">Escolha o tipo de ranking</p>
            </div>
            <button type="button" onClick=${onClose} className="h-8 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-60" disabled=${busy}>Fechar</button>
          </div>
          <div className="space-y-1.5">
            ${CATALOG_SORT_OPTIONS.map((option) => {
              const active = selectedSort === option.value;
              return html`
                <button key=${option.value} type="button" onClick=${() => onSelect?.(option.value)} disabled=${busy} className=${`w-full rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-60 ${active ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100' : 'border-slate-700 bg-slate-900/70 text-slate-200 hover:bg-slate-800'}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2">
                      <span>${option.icon}</span>
                      <span className="text-sm font-medium">${option.label}</span>
                    </span>
                    <span className="text-[10px] text-slate-400">${active ? 'ativo' : ''}</span>
                  </span>
                </button>
              `;
            })}
          </div>
        </div>
      </div>
    </div>
  `;
}

function PackPageSkeleton() {
  return html`
    <section className="space-y-4 animate-pulse">
      <div className="h-10 w-40 rounded-xl border border-slate-700 bg-slate-800/70"></div>
      <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/70">
        <div className="h-56 sm:h-64 bg-slate-800"></div>
        <div className="p-4 space-y-3">
          <div className="h-6 w-2/3 rounded bg-slate-800"></div>
          <div className="h-4 w-1/2 rounded bg-slate-800"></div>
          <div className="h-10 rounded-xl bg-slate-800"></div>
          <div className="h-9 rounded-xl bg-slate-800"></div>
          <div className="h-20 rounded-xl bg-slate-800"></div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">${Array.from({ length: 9 }).map((_, index) => html`<div key=${index} className="aspect-square rounded-xl border border-slate-700 bg-slate-800"></div>`)}</div>
    </section>
  `;
}

function CreatorRankingSkeleton({ count = 8 }) {
  return html`
    <div className="space-y-2">
      ${Array.from({ length: count }).map(
        (_, index) => html`
          <div key=${index} className="animate-pulse rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-full bg-slate-800"></div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-40 rounded bg-slate-800"></div>
                <div className="h-3 w-56 rounded bg-slate-800"></div>
              </div>
              <div className="h-9 w-24 rounded-xl bg-slate-800"></div>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function CreatorsRankingPage({ creators = [], loading = false, error = '', sort = DEFAULT_CREATORS_SORT, onSortChange, onBack, onRetry, onOpenCreator, onOpenPack }) {
  const selectedSort = normalizeCreatorsSort(sort);

  return html`
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick=${onBack} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-700 px-3 text-sm text-slate-200 hover:bg-slate-800">← Voltar para catálogo</button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Ordenar</span>
          <select value=${selectedSort} onChange=${(event) => onSortChange?.(event.target.value)} className="h-9 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200 outline-none">
            <option value="popular">Popular</option>
            <option value="likes">Likes</option>
            <option value="downloads">Downloads</option>
            <option value="packs">Packs</option>
            <option value="name">Nome</option>
          </select>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3 sm:p-4">
        <p className="text-[11px] uppercase tracking-wide text-slate-400">Criadores populares</p>
        <h1 className="mt-1 text-lg sm:text-xl font-bold text-slate-100">Ranking de criadores</h1>
        <p className="text-xs text-slate-400">Avatar, packs publicados, downloads, likes e acesso rápido ao perfil.</p>
      </div>

      ${error
        ? html`
            <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4">
              <p className="text-sm font-semibold text-rose-100">Falha ao carregar criadores</p>
              <p className="mt-1 text-xs text-rose-200/90">${error}</p>
              <button type="button" onClick=${onRetry} className="mt-3 inline-flex h-9 items-center rounded-xl border border-rose-400/40 px-3 text-xs text-rose-100 hover:bg-rose-500/10">Tentar novamente</button>
            </div>
          `
        : null}
      ${loading ? html`<${CreatorRankingSkeleton} />` : null}
      ${!loading && !error && !creators.length
        ? html`
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-8 text-center">
              <p className="text-sm font-semibold text-slate-100">Nenhum criador encontrado</p>
              <p className="mt-1 text-xs text-slate-400">Tente atualizar a página ou voltar ao catálogo.</p>
            </div>
          `
        : null}
      ${!loading && creators.length
        ? html`
            <div className="space-y-2">
              ${creators.map(
                (creator, index) => html`
                  <article key=${creator.key || creator.publisher || index} className="fade-card rounded-2xl border border-slate-800 bg-slate-900/65 p-3">
                    <div className="flex items-center gap-3">
                      <img src=${creator.avatarUrl || getAvatarUrl(creator.publisher)} alt="" className="h-12 w-12 rounded-full bg-slate-800 border border-slate-700" loading="lazy" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold text-slate-100">${creator.publisher || 'Criador'}</p>
                          ${creator.verified ? html`<span className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200">Verificado</span>` : null}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
                          <span>📦 ${shortNum(creator.packCount || 0)} packs</span>
                          <span>⬇ ${shortNum(creator.downloads || 0)} downloads</span>
                          <span>❤️ ${shortNum(creator.likes || 0)} likes</span>
                        </div>
                        ${creator.topPack?.name ? html` <button type="button" onClick=${() => onOpenPack?.(creator.topPack?.pack_key)} className="mt-1 text-[11px] text-cyan-300 hover:text-cyan-200">Top pack: ${creator.topPack.name}</button> ` : null}
                      </div>
                      <button type="button" onClick=${() => onOpenCreator?.(creator)} className="shrink-0 h-9 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/20">Ver perfil</button>
                    </div>
                  </article>
                `,
              )}
            </div>
          `
        : null}
    </section>
  `;
}

function StickerPreview({ item, onClose, onPrev, onNext, hasNsfwAccess = true, onRequireLogin }) {
  if (!item) return null;
  const lockedByNsfw = isStickerMarkedNsfw(item) && !hasNsfwAccess;
  const stickerPreviewSrc = item?.asset_preview_url || item?.asset_url || DEFAULT_STICKER_PLACEHOLDER_URL;

  const handleCopy = async () => {
    if (!item?.asset_url) return;
    try {
      await navigator.clipboard.writeText(item.asset_url);
    } catch {
      // ignore clipboard API errors
    }
  };

  return html`
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0" aria-label="Fechar preview" onClick=${onClose}></button>

      <div className="relative w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 p-3">
        <img src=${lockedByNsfw ? NSFW_STICKER_PLACEHOLDER_URL : stickerPreviewSrc} alt=${item.accessibility_label || 'Sticker'} className=${`w-full max-h-[70vh] object-contain rounded-xl bg-slate-950 ${lockedByNsfw ? 'blur-md' : ''}`} />
        ${lockedByNsfw
          ? html`
              <div className="absolute inset-x-3 top-3 bottom-[64px] flex items-center justify-center rounded-xl bg-slate-950/40 p-4">
                <div className="max-w-sm rounded-xl border border-amber-500/35 bg-slate-950/80 px-4 py-3 text-center">
                  <p className="text-sm font-semibold text-amber-100">Conteúdo sensível</p>
                  <p className="mt-1 text-xs text-slate-300">Faça login com Google para desbloquear este sticker.</p>
                  <button type="button" onClick=${() => onRequireLogin?.()} className="mt-3 inline-flex h-9 items-center rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 text-xs font-semibold text-amber-100">Entrar e desbloquear</button>
                </div>
              </div>
            `
          : null}

        <div className="mt-3 flex items-center justify-between gap-2">
          <button type="button" onClick=${onPrev} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">← Anterior</button>
          <div className="flex items-center gap-2">
            ${lockedByNsfw ? null : html`<button type="button" onClick=${handleCopy} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">Copiar link</button>`}
            <button type="button" onClick=${onClose} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">Fechar</button>
          </div>
          <button type="button" onClick=${onNext} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">Próximo →</button>
        </div>
      </div>
    </div>
  `;
}

function PackPage({ pack, relatedPacks, relatedLoading = false, onLoadRelated, onBack, onOpenRelated, onLike, onDislike, onTagClick, reactionLoading = '', reactionNotice = null, hasNsfwAccess = true, onRequireLogin }) {
  if (!pack) {
    return html`
      <section className="space-y-4">
        <button type="button" onClick=${onBack} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">← Voltar para catálogo</button>
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-8 text-center">
          <p className="text-sm font-semibold text-slate-100">Pack não encontrado</p>
          <p className="mt-1 text-xs text-slate-400">Tente voltar ao catálogo e abrir novamente.</p>
        </div>
      </section>
    `;
  }

  const items = Array.isArray(pack?.items) ? pack.items : [];
  const tags = Array.isArray(pack?.tags) ? pack.tags : [];
  const packLockedByNsfw = isPackMarkedNsfw(pack) && !hasNsfwAccess;
  const cover = packLockedByNsfw ? NSFW_STICKER_PLACEHOLDER_URL : pack?.cover_preview_url || pack?.cover_url || items?.[0]?.asset_preview_url || items?.[0]?.asset_url || DEFAULT_STICKER_PLACEHOLDER_URL;
  const whatsappUrl = String(pack?.whatsapp?.url || '').trim();
  const engagement = getPackEngagement(pack);
  const hasReactionRequest = Boolean(reactionLoading);
  const initialVisibleCount = useMemo(() => resolveInitialPackStickerLimit(), []);
  const [visibleStickerCount, setVisibleStickerCount] = useState(initialVisibleCount);
  const [previewIndex, setPreviewIndex] = useState(-1);
  const visibleItems = useMemo(() => items.slice(0, Math.max(1, Number(visibleStickerCount || 0))), [items, visibleStickerCount]);
  const hasMoreVisibleItems = visibleItems.length < items.length;
  const currentPreviewItem = previewIndex >= 0 ? visibleItems[previewIndex] : null;

  useEffect(() => {
    setVisibleStickerCount(initialVisibleCount);
    setPreviewIndex(-1);
  }, [pack?.pack_key, initialVisibleCount]);

  return html`
    <section className="space-y-4 pb-4">
      <button type="button" onClick=${onBack} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/70 px-3 text-sm text-slate-200 hover:bg-slate-800">← Voltar para catálogo</button>

      <article className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/80 shadow-[0_18px_40px_rgba(2,6,23,0.25)]">
        <div className="relative h-52 sm:h-64 md:h-72 bg-slate-900">
          <img src=${cover} alt=${`Capa ${pack?.name || 'Pack'}`} className=${`h-full w-full object-cover ${packLockedByNsfw ? 'blur-md scale-105' : ''}`} loading="lazy" />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/55 to-transparent"></div>
          ${packLockedByNsfw ? html`<div className="absolute top-3 left-3 rounded-full border border-amber-300/40 bg-amber-500/25 px-2 py-1 text-[10px] font-semibold text-amber-100">🔞 Conteúdo sensível</div>` : null}
          <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
            <div className="max-w-4xl">
              <p className="text-[11px] uppercase tracking-wide text-slate-300/90">Pack público</p>
              <h1 className="mt-1 text-xl sm:text-2xl font-extrabold tracking-tight text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.35)]">${pack?.name || 'Pack'}</h1>
              <p className="mt-1 text-xs sm:text-sm text-slate-200/90">${pack?.publisher || '-'} · ${pack?.created_at ? new Date(pack.created_at).toLocaleDateString('pt-BR') : 'sem data'}</p>
            </div>
          </div>
        </div>

        <div className="space-y-3 p-4 sm:p-5">
          ${packLockedByNsfw
            ? html`
                <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3">
                  <p className="text-sm font-semibold text-amber-100">Este pack foi marcado como sensível (+18).</p>
                  <p className="mt-1 text-xs text-slate-300">Faça login com Google para visualizar os stickers.</p>
                  <button type="button" onClick=${() => onRequireLogin?.()} className="mt-3 inline-flex h-9 items-center rounded-xl border border-amber-400/35 bg-amber-500/15 px-3 text-xs font-semibold text-amber-100">Entrar para desbloquear</button>
                </div>
              `
            : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-slate-800 bg-slate-950/35 px-3 py-2 text-sm">
            <span className="text-slate-200">👍 <strong className="font-semibold">${shortNum(engagement.likeCount)}</strong></span>
            <span className="text-slate-200">👎 <strong className="font-semibold">${shortNum(engagement.dislikeCount)}</strong></span>
            <span className="text-slate-200">🧩 <strong className="font-semibold">${shortNum(Number(pack?.sticker_count || items.length))}</strong></span>
            <span className="text-slate-200">👁 <strong className="font-semibold">${shortNum(engagement.openCount)}</strong></span>
          </div>

          ${whatsappUrl && !packLockedByNsfw ? html` <a href=${whatsappUrl} target="_blank" rel="noreferrer noopener" className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-[#25D366] px-5 text-sm font-bold text-[#042d17] shadow-[0_8px_24px_rgba(37,211,102,0.30)] transition hover:brightness-95"> 🟢 Adicionar no WhatsApp </a> ` : null}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick=${() => onLike?.(pack?.pack_key)} disabled=${hasReactionRequest || packLockedByNsfw} className="inline-flex h-9 items-center justify-center rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60">${reactionLoading === 'like' ? 'Enviando...' : 'Curtir'}</button>
            <button type="button" onClick=${() => onDislike?.(pack?.pack_key)} disabled=${hasReactionRequest || packLockedByNsfw} className="inline-flex h-9 items-center justify-center rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 text-xs font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60">${reactionLoading === 'dislike' ? 'Enviando...' : 'Não curtir'}</button>
            ${reactionNotice?.message ? html` <span className=${`text-xs ${reactionNotice.type === 'error' ? 'text-rose-300' : 'text-emerald-300'}`}> ${reactionNotice.message} </span> ` : null}
          </div>

          ${pack?.description ? html`<p className="text-sm leading-6 text-slate-300">${pack.description}</p>` : null}
          ${tags.length
            ? html`
                <div className="space-y-1">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Tags</p>
                  <div className="chips-scroll -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">${tags.slice(0, 12).map((tag) => html` <button key=${tag} type="button" onClick=${() => onTagClick?.(tag)} className="chip-item shrink-0 rounded-full border border-slate-700 bg-slate-900/90 px-2.5 py-1 text-[11px] text-slate-200 hover:border-cyan-400/30 hover:bg-cyan-500/10">${tagLabel(tag)}</button> `)}</div>
                </div>
              `
            : null}
        </div>
      </article>

      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Stickers do pack</h2>
          <span className="text-xs text-slate-400">${visibleItems.length}/${items.length} itens</span>
        </div>

        ${packLockedByNsfw
          ? html`
              <div className="rounded-2xl border border-dashed border-amber-500/35 bg-slate-900/55 p-8 text-center">
                <p className="text-sm font-semibold text-amber-100">Stickers bloqueados por conteúdo sensível.</p>
                <p className="mt-1 text-xs text-slate-300">Entre com Google para liberar a visualização deste pack.</p>
                <button type="button" onClick=${() => onRequireLogin?.()} className="mt-3 inline-flex h-9 items-center rounded-xl border border-amber-400/35 bg-amber-500/15 px-3 text-xs font-semibold text-amber-100">Entrar e desbloquear</button>
              </div>
            `
          : visibleItems.length
            ? html`
                <div className="pack-stickers-grid gap-2 sm:gap-3">
                  ${visibleItems.map((item, index) => {
                    const stickerLockedByNsfw = isStickerMarkedNsfw(item) && !hasNsfwAccess;
                    const stickerSrc = item?.asset_preview_url || item?.asset_url || DEFAULT_STICKER_PLACEHOLDER_URL;
                    return html`
                      <button key=${item.sticker_id || item.position || index} type="button" onClick=${() => (stickerLockedByNsfw ? onRequireLogin?.() : setPreviewIndex(index))} className="pack-sticker-card group relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 text-left transition hover:-translate-y-0.5 hover:border-slate-600">
                        <${LazyCatalogImage} src=${stickerLockedByNsfw ? NSFW_STICKER_PLACEHOLDER_URL : stickerSrc} alt=${item.accessibility_label || 'Sticker'} className=${`w-full aspect-square object-contain bg-slate-950 transition-transform duration-300 ${stickerLockedByNsfw ? 'blur-md scale-105' : 'group-hover:scale-105'}`} rootMargin="40px 0px" threshold=${0.05} />
                        ${stickerLockedByNsfw
                          ? html`
                              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/35 p-2">
                                <span className="rounded-lg border border-amber-400/35 bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-100"> Entrar para desbloquear </span>
                              </div>
                            `
                          : null}
                      </button>
                    `;
                  })}
                </div>
                ${hasMoreVisibleItems
                  ? html`
                      <div className="flex justify-center pt-1">
                        <button type="button" onClick=${() => setVisibleStickerCount((prev) => Math.min(items.length, Math.max(1, Number(prev || 0)) + PACK_STICKERS_LOAD_STEP))} className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-900/80 px-3 text-xs text-slate-200 hover:bg-slate-800">Carregar mais (${items.length - visibleItems.length} restantes)</button>
                      </div>
                    `
                  : null}
              `
            : html`
                <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-8 text-center">
                  <p className="text-sm font-semibold text-slate-100">Este pack ainda não tem stickers visíveis.</p>
                  <p className="mt-1 text-xs text-slate-400">Volte mais tarde ou abra outro pack do catálogo.</p>
                </div>
              `}
      </section>

      ${relatedPacks.length || typeof onLoadRelated === 'function' || relatedLoading
        ? html`
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-bold">Packs relacionados</h2>
                <span className="text-xs text-slate-500">${relatedPacks.length ? `${relatedPacks.length} sugestões` : 'sob demanda'}</span>
              </div>
              ${relatedPacks.length
                ? html`<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5 sm:gap-3">
                    ${relatedPacks.map(
                      (entry, index) =>
                        html`<div key=${entry.pack_key || entry.id} className="fade-card">
                          <${PackCard} pack=${entry} index=${index} onOpen=${onOpenRelated} hasNsfwAccess=${hasNsfwAccess} onRequireLogin=${onRequireLogin} />
                        </div>`,
                    )}
                  </div>`
                : html`
                    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-center">
                      <button type="button" onClick=${() => onLoadRelated?.()} disabled=${relatedLoading} className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">${relatedLoading ? 'Carregando relacionados...' : 'Carregar packs relacionados'}</button>
                    </div>
                  `}
            </section>
          `
        : null}
      ${previewIndex >= 0 ? html` <${StickerPreview} item=${currentPreviewItem} onClose=${() => setPreviewIndex(-1)} onPrev=${() => setPreviewIndex((value) => (value <= 0 ? visibleItems.length - 1 : value - 1))} onNext=${() => setPreviewIndex((value) => (value >= visibleItems.length - 1 ? 0 : value + 1))} hasNsfwAccess=${hasNsfwAccess} onRequireLogin=${onRequireLogin} /> ` : null}
    </section>
  `;
}

function StickersApp() {
  const root = document.getElementById('stickers-react-root');
  const config = useMemo(
    () => ({
      webPath: root?.dataset.webPath || '/stickers',
      apiBasePath: root?.dataset.apiBasePath || '/api/sticker-packs',
      loginPath: root?.dataset.loginPath || '/login',
      limit: resolveCatalogPageLimit(root?.dataset.defaultLimit),
    }),
    [root],
  );
  const initialRoute = parseStickersLocation(config.webPath);
  const initialCatalogSearch = parseCatalogSearchState(window.location.search);
  const initialCreatorsSearch = parseCreatorsSearchState(window.location.search);

  const [query, setQuery] = useState(initialCatalogSearch.q || '');
  const [appliedQuery, setAppliedQuery] = useState(initialCatalogSearch.q || '');
  const [sortBy, setSortBy] = useState(normalizeCatalogSort(initialCatalogSearch.sort || DEFAULT_CATALOG_SORT));
  const [activeCategory, setActiveCategory] = useState(initialCatalogSearch.category || '');
  const [catalogFilter, setCatalogFilter] = useState(initialCatalogSearch.filter || '');
  const [catalogPage, setCatalogPage] = useState(Math.max(FIRST_CATALOG_PAGE, Number(initialCatalogSearch.page || FIRST_CATALOG_PAGE)));
  const [discoverTab, setDiscoverTab] = useState('growing');
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [recentSearches, setRecentSearches] = useState([]);
  const [sortPickerOpen, setSortPickerOpen] = useState(false);
  const [sortPickerBusy, setSortPickerBusy] = useState(false);

  const [packs, setPacks] = useState([]);
  const [packHasMore, setPackHasMore] = useState(true);
  const [packsLoading, setPacksLoading] = useState(false);

  const [error, setError] = useState('');

  const [currentView, setCurrentView] = useState(initialRoute.view || 'catalog');
  const [currentPackKey, setCurrentPackKey] = useState(initialRoute.packKey || '');
  const [currentPack, setCurrentPack] = useState(null);
  const [packLoading, setPackLoading] = useState(false);
  const [reactionLoading, setReactionLoading] = useState('');
  const [reactionNotice, setReactionNotice] = useState(null);
  const [relatedPacks, setRelatedPacks] = useState([]);
  const [relatedPacksLoading, setRelatedPacksLoading] = useState(false);
  const [creatorRanking, setCreatorRanking] = useState([]);
  const [creatorRankingLoading, setCreatorRankingLoading] = useState(false);
  const [creatorRankingError, setCreatorRankingError] = useState('');
  const [creatorSort, setCreatorSort] = useState(normalizeCreatorsSort(initialCreatorsSearch.sort || DEFAULT_CREATORS_SORT));
  const [isScrolled, setIsScrolled] = useState(false);
  const [supportInfo, setSupportInfo] = useState(null);
  const [uploadTask, setUploadTask] = useState(null);
  const [googleAuthConfig, setGoogleAuthConfig] = useState({
    enabled: false,
    required: false,
    clientId: '',
  });
  const [googleAuth, setGoogleAuth] = useState(() => readGoogleAuthCache() || { user: null, expiresAt: '' });
  const [googleAuthError, setGoogleAuthError] = useState('');
  const [googleAuthBusy, setGoogleAuthBusy] = useState(false);
  const [googleSessionChecked, setGoogleSessionChecked] = useState(false);
  const [myPacks, setMyPacks] = useState([]);
  const [myPacksLoading, setMyPacksLoading] = useState(false);
  const [myPacksError, setMyPacksError] = useState('');
  const [myProfileStats, setMyProfileStats] = useState({
    total: 0,
    published: 0,
    drafts: 0,
    private: 0,
    unlisted: 0,
    public: 0,
  });
  const [packActionBusyByKey, setPackActionBusyByKey] = useState({});
  const [profileToasts, setProfileToasts] = useState([]);
  const [packActionsSheetPack, setPackActionsSheetPack] = useState(null);
  const [confirmDeletePack, setConfirmDeletePack] = useState(null);
  const [confirmDeleteBusy, setConfirmDeleteBusy] = useState(false);
  const [managePackOpen, setManagePackOpen] = useState(false);
  const [managePackData, setManagePackData] = useState(null);
  const [managePackLoading, setManagePackLoading] = useState(false);
  const [managePackError, setManagePackError] = useState('');
  const [managePackBusyAction, setManagePackBusyAction] = useState('');
  const [managePackTargetKey, setManagePackTargetKey] = useState('');
  const [analyticsModalOpen, setAnalyticsModalOpen] = useState(false);
  const [analyticsModalLoading, setAnalyticsModalLoading] = useState(false);
  const [analyticsModalError, setAnalyticsModalError] = useState('');
  const [analyticsModalData, setAnalyticsModalData] = useState(null);
  const [analyticsModalPack, setAnalyticsModalPack] = useState(null);
  const googleButtonRef = useRef(null);
  const googlePromptAttemptedRef = useRef(false);
  const sortPickerLockRef = useRef(false);

  const dynamicCategoryOptions = useMemo(() => {
    const scoreByTag = new Map();
    const ensureTag = (rawTag, baseScore = 1) => {
      const tag = String(rawTag || '').trim();
      if (!tag) return;
      scoreByTag.set(tag, (scoreByTag.get(tag) || 0) + baseScore);
    };

    packs.forEach((pack) => {
      const engagement = getPackEngagement(pack);
      const scoreBoost = 1 + engagement.openCount * 0.02 + engagement.likeCount * 0.08;
      (Array.isArray(pack?.tags) ? pack.tags : []).forEach((tag) => ensureTag(tag, scoreBoost));
    });

    const sortedTags = Array.from(scoreByTag.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([value]) => {
        const meta = CATEGORY_META.get(value) || null;
        if (meta) return { value, label: `${meta.icon} ${meta.label}`, icon: meta.icon };
        const label = value.replace(/-/g, ' ');
        return { value, label: `🏷️ ${label}`, icon: '🏷️' };
      });

    if (activeCategory && !sortedTags.some((entry) => entry.value === activeCategory)) {
      const meta = CATEGORY_META.get(activeCategory) || null;
      sortedTags.unshift(meta ? { value: activeCategory, label: `${meta.icon} ${meta.label}`, icon: meta.icon } : { value: activeCategory, label: `🏷️ ${activeCategory.replace(/-/g, ' ')}`, icon: '🏷️' });
    }

    return [{ value: '', label: '🔥 Em alta', icon: '🔥' }, ...sortedTags];
  }, [packs, activeCategory]);

  const tagSuggestions = useMemo(() => {
    const options = new Map();

    dynamicCategoryOptions.forEach((entry) => {
      if (!entry?.value) return;
      options.set(entry.value, {
        value: entry.value,
        label: String(entry.label || entry.value).replace(/^.+?\s/, ''),
        icon: entry.icon || '🏷️',
      });
    });

    const addTag = (rawTag) => {
      const tag = String(rawTag || '').trim();
      if (!tag) return;
      if (!options.has(tag)) {
        options.set(tag, {
          value: tag,
          label: tag.replace(/-/g, ' '),
          icon: '🏷',
        });
      }
    };

    packs.forEach((pack) => {
      (Array.isArray(pack?.tags) ? pack.tags : []).forEach(addTag);
    });

    return Array.from(options.values());
  }, [dynamicCategoryOptions, packs]);

  const filteredSuggestions = useMemo(() => {
    const q = normalizeToken(query);
    if (!q) {
      return recentSearches.slice(0, 6).map((entry) => ({
        value: entry,
        label: entry,
        icon: '🕘',
      }));
    }
    return tagSuggestions.filter((item) => normalizeToken(item.value).includes(q) || normalizeToken(item.label).includes(q)).slice(0, 8);
  }, [query, tagSuggestions, recentSearches]);

  const sortedPacks = useMemo(() => {
    const list = [...packs];
    const selectedSort = normalizeCatalogSort(sortBy);
    list.sort((a, b) => {
      const completenessDelta = comparePacksByCompleteness(a, b);
      if (completenessDelta !== 0) return completenessDelta;

      if (selectedSort === 'recent') {
        return new Date(b?.created_at || b?.updated_at || 0).getTime() - new Date(a?.created_at || a?.updated_at || 0).getTime();
      }
      if (selectedSort === 'likes') {
        return getPackEngagement(b).likeCount - getPackEngagement(a).likeCount;
      }
      if (selectedSort === 'downloads') {
        return getPackEngagement(b).openCount - getPackEngagement(a).openCount;
      }
      if (selectedSort === 'comments') {
        const commentDelta = getPackCommentCount(b) - getPackCommentCount(a);
        if (commentDelta !== 0) return commentDelta;
        return getPackEngagement(b).likeCount - getPackEngagement(a).likeCount;
      }
      if (selectedSort === 'trending') {
        const trendDelta = getPackTrendScore(b) - getPackTrendScore(a);
        if (trendDelta !== 0) return trendDelta;
        const rankingDelta = getPackRankingScore(b) - getPackRankingScore(a);
        if (rankingDelta !== 0) return rankingDelta;
        return getPackEngagement(b).openCount - getPackEngagement(a).openCount;
      }
      return getPackRankingScore(b) - getPackRankingScore(a);
    });
    return list;
  }, [packs, sortBy]);

  const categoryActiveLabel = catalogFilter === 'trending' ? 'Em alta agora' : dynamicCategoryOptions.find((entry) => entry.value === activeCategory)?.label?.replace(/^.+?\s/, '') || 'Todas';
  const growingNowPacks = useMemo(() => {
    return [...packs]
      .map((pack) => {
        const engagement = getPackEngagement(pack);
        const createdAt = new Date(pack?.created_at || pack?.updated_at || 0).getTime();
        const recentBonus = __timeNowMs() - createdAt <= 1000 * 60 * 60 * 24 * 7 ? 18 : 0;
        const growth = engagement.openCount * 1.5 + engagement.likeCount * 3 - engagement.dislikeCount + recentBonus;
        return { pack, growth };
      })
      .sort((a, b) => {
        const completenessDelta = comparePacksByCompleteness(a.pack, b.pack);
        if (completenessDelta !== 0) return completenessDelta;
        return b.growth - a.growth;
      })
      .slice(0, Math.max(DESKTOP_DISCOVER_GROWING_LIMIT, MOBILE_DISCOVER_CAROUSEL_LIMIT))
      .map((entry) => entry.pack);
  }, [packs]);
  const topWeekPacks = useMemo(
    () =>
      [...packs]
        .sort((a, b) => {
          const completenessDelta = comparePacksByCompleteness(a, b);
          if (completenessDelta !== 0) return completenessDelta;
          const ea = getPackEngagement(a);
          const eb = getPackEngagement(b);
          const sa = ea.openCount + ea.likeCount * 3 - ea.dislikeCount;
          const sb = eb.openCount + eb.likeCount * 3 - eb.dislikeCount;
          return sb - sa;
        })
        .slice(0, Math.max(DESKTOP_DISCOVER_TOP_LIMIT, MOBILE_DISCOVER_CAROUSEL_LIMIT)),
    [packs],
  );
  const featuredCreators = useMemo(() => {
    const byPublisher = new Map();
    packs.forEach((pack) => {
      const publisher = String(pack?.publisher || 'OmniZap Auto').trim();
      const current = byPublisher.get(publisher) || {
        publisher,
        key: String(publisher || '').toLowerCase(),
        packCount: 0,
        likes: 0,
        opens: 0,
        avgPackScoreSum: 0,
        topPack: pack,
      };
      const engagement = getPackEngagement(pack);
      current.packCount += 1;
      current.likes += engagement.likeCount;
      current.opens += engagement.openCount;
      current.avgPackScoreSum += safeNumber(pack?.signals?.pack_score);
      if (!current.topPack || engagement.likeCount > getPackEngagement(current.topPack).likeCount) {
        current.topPack = pack;
      }
      byPublisher.set(publisher, current);
    });
    return Array.from(byPublisher.values())
      .map((creator) => ({
        ...creator,
        downloads: creator.opens,
        avgPackScore: creator.avgPackScoreSum / Math.max(1, creator.packCount),
        creatorScore: buildCreatorScore({
          avgPackScore: creator.avgPackScoreSum / Math.max(1, creator.packCount),
          likes: creator.likes,
          downloads: creator.opens,
        }),
        avatarUrl: getAvatarUrl(creator.publisher),
      }))
      .sort((a, b) => b.creatorScore - a.creatorScore)
      .slice(0, 3);
  }, [packs]);
  const sortedCreatorRanking = useMemo(() => {
    const list = [...creatorRanking];
    const selectedSort = normalizeCreatorsSort(creatorSort);
    if (selectedSort === 'likes') {
      list.sort((a, b) => b.likes - a.likes);
      return list;
    }
    if (selectedSort === 'downloads') {
      list.sort((a, b) => b.downloads - a.downloads);
      return list;
    }
    if (selectedSort === 'packs') {
      list.sort((a, b) => b.packCount - a.packCount);
      return list;
    }
    if (selectedSort === 'name') {
      list.sort((a, b) => String(a.publisher || '').localeCompare(String(b.publisher || ''), 'pt-BR'));
      return list;
    }
    list.sort((a, b) => b.creatorScore - a.creatorScore);
    return list;
  }, [creatorRanking, creatorSort]);
  const recentPublishedPacks = useMemo(
    () =>
      [...packs]
        .sort((a, b) => {
          const completenessDelta = comparePacksByCompleteness(a, b);
          if (completenessDelta !== 0) return completenessDelta;
          return new Date(b?.created_at || b?.updated_at || 0).getTime() - new Date(a?.created_at || a?.updated_at || 0).getTime();
        })
        .slice(0, MOBILE_DISCOVER_CAROUSEL_LIMIT),
    [packs],
  );
  const catalogTotals = useMemo(() => {
    let stickers = 0;
    let likes = 0;
    let downloads = 0;
    const creators = new Set();
    for (const pack of packs) {
      stickers += Math.max(0, Number(pack?.sticker_count || 0));
      const engagement = getPackEngagement(pack);
      likes += Math.max(0, Number(engagement.likeCount || 0));
      downloads += Math.max(0, Number(engagement.openCount || 0));
      const publisher = String(pack?.publisher || '').trim();
      if (publisher) creators.add(publisher);
    }
    return {
      packs: packs.length,
      stickers,
      likes,
      downloads,
      creators: creators.size,
    };
  }, [packs]);
  const highlightCreator = String(featuredCreators?.[0]?.publisher || '').trim();

  const hasAnyResult = packs.length > 0;
  const canGoCatalogPrev = catalogPage > FIRST_CATALOG_PAGE && !packsLoading;
  const canGoCatalogNext = packHasMore && !packsLoading;
  const googleSessionApiPath = `${config.apiBasePath}/auth/google/session`;
  const myProfileApiPath = `${config.apiBasePath}/me`;
  const isProfileView = currentView === 'profile';
  const isCreatorsView = currentView === 'creators';
  const hasGoogleLogin = Boolean(googleAuth.user?.sub);
  const hasNsfwAccess = hasGoogleLogin;
  const googleLoginEnabled = Boolean(googleAuthConfig.enabled && googleAuthConfig.clientId);
  const shouldRenderGoogleButton = isProfileView && googleLoginEnabled && !hasGoogleLogin && googleSessionChecked && !googleAuthBusy;

  const fetchJson = async (url, options = undefined) => {
    const opts = options && typeof options === 'object' ? { ...options } : {};
    const retry = Math.max(0, Number(opts.retry || 0));
    const retryDelayMs = Math.max(120, Number(opts.retryDelayMs || 350));
    delete opts.retry;
    delete opts.retryDelayMs;

    let attempt = 0;
    while (true) {
      try {
        const response = await fetch(url, { credentials: 'include', ...opts });
        const rawText = await response.text().catch(() => '');
        let payload = {};
        if (rawText) {
          try {
            payload = JSON.parse(rawText);
          } catch {
            payload = { raw: rawText };
          }
        }

        if (!response.ok) {
          const error = new Error(payload?.error || payload?.message || rawText || 'Falha ao carregar catálogo');
          error.status = Number(response.status || 0);
          error.code = payload?.code || '';
          error.payload = payload;
          error.url = String(url || '');
          error.retryable = response.status >= 500 || response.status === 429;
          throw error;
        }

        return payload;
      } catch (err) {
        const normalized = err instanceof Error ? err : new Error('Falha de rede');
        if (normalized.status === undefined) normalized.status = 0;
        if (normalized.retryable === undefined) normalized.retryable = !normalized.status || normalized.status >= 500;

        if (attempt >= retry || !normalized.retryable) throw normalized;
        attempt += 1;
        await sleep(retryDelayMs * attempt);
      }
    }
  };

  const applyGoogleSessionData = (sessionData) => {
    if (!sessionData?.authenticated || !sessionData?.user?.sub) {
      setGoogleAuth({ user: null, expiresAt: '' });
      clearGoogleAuthCache();
      return false;
    }
    const nextAuth = {
      user: {
        sub: String(sessionData.user.sub || ''),
        email: String(sessionData.user.email || ''),
        name: String(sessionData.user.name || 'Conta Google'),
        picture: String(sessionData.user.picture || ''),
      },
      expiresAt: String(sessionData.expires_at || ''),
    };
    setGoogleAuth(nextAuth);
    writeGoogleAuthCache(nextAuth);
    return true;
  };

  const applyMyProfileData = (payload) => {
    const data = payload?.data || {};
    const authGoogle = data?.auth?.google || {};
    setGoogleAuthConfig({
      enabled: Boolean(authGoogle?.enabled),
      required: Boolean(authGoogle?.required),
      clientId: String(authGoogle?.client_id || '').trim(),
    });
    const authenticated = applyGoogleSessionData(data?.session || null);
    const nextPacks = Array.isArray(data?.packs) ? data.packs : [];
    setMyPacks(authenticated ? nextPacks : []);
    const stats = data?.stats && typeof data.stats === 'object' ? data.stats : {};
    setMyProfileStats({
      total: Number(stats.total || 0),
      published: Number(stats.published || 0),
      drafts: Number(stats.drafts || 0),
      private: Number(stats.private || 0),
      unlisted: Number(stats.unlisted || 0),
      public: Number(stats.public || 0),
    });
    setGoogleSessionChecked(true);
    return { authenticated };
  };

  const refreshMyProfile = async ({ silent = false } = {}) => {
    if (!silent) setMyPacksLoading(true);
    setMyPacksError('');
    setGoogleAuthError('');
    if (!silent) setGoogleSessionChecked(false);
    try {
      const payload = await fetchJson(myProfileApiPath, { retry: 1 });
      const applied = applyMyProfileData(payload);
      if (!applied?.authenticated) {
        redirectToLogin(`${config.webPath}/perfil`);
        return;
      }
    } catch (err) {
      if (Number(err?.status || 0) === 401 || Number(err?.status || 0) === 403) {
        redirectToLogin(`${config.webPath}/perfil`);
        return;
      }
      setMyPacks([]);
      setMyProfileStats({ total: 0, published: 0, drafts: 0, private: 0, unlisted: 0, public: 0 });
      setGoogleSessionChecked(true);
      setMyPacksError(err?.message || 'Falha ao carregar perfil e packs.');
    } finally {
      if (!silent) setMyPacksLoading(false);
    }
  };

  const pushProfileToast = (message, type = 'success') => {
    const id = `${__timeNowMs()}-${Math.random().toString(36).slice(2, 8)}`;
    setProfileToasts((prev) => [...prev, { id, message: String(message || ''), type }].slice(-5));
    window.setTimeout(() => {
      setProfileToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4200);
  };

  const dismissProfileToast = (toastId) => {
    setProfileToasts((prev) => prev.filter((item) => item.id !== toastId));
  };

  const setPackActionBusy = (packKey, action = '') => {
    if (!packKey) return;
    setPackActionBusyByKey((prev) => {
      if (!action) {
        const next = { ...prev };
        delete next[packKey];
        return next;
      }
      return { ...prev, [packKey]: action };
    });
  };

  const buildManagePackApiPath = (packKey, suffix = '') => `${config.apiBasePath}/${encodeURIComponent(String(packKey || ''))}/manage${suffix}`;

  const getManagedMutationStatus = (payload) =>
    String(payload?.data?.status || payload?.status || '')
      .trim()
      .toLowerCase();

  const applyManagedPackToMyList = (managedData) => {
    const pack = managedData?.pack || null;
    if (!pack?.pack_key) return;
    setMyPacks((prev) => {
      const list = Array.isArray(prev) ? [...prev] : [];
      const index = list.findIndex((entry) => String(entry?.pack_key || '') === String(pack.pack_key || ''));
      if (index >= 0) {
        list[index] = { ...list[index], ...pack };
        return list;
      }
      return [pack, ...list];
    });
  };

  const removePackFromMyList = (packKey) => {
    if (!packKey) return;
    setMyPacks((prev) => (Array.isArray(prev) ? prev.filter((entry) => String(entry?.pack_key || '') !== String(packKey)) : []));
  };

  const loadManagePackData = async (packKey, { openModal = false, silent = false } = {}) => {
    if (!packKey) return null;
    if (!silent) setManagePackLoading(true);
    setManagePackError('');
    setManagePackTargetKey(String(packKey));
    if (openModal) setManagePackOpen(true);
    try {
      const payload = await fetchJson(buildManagePackApiPath(packKey), { retry: 1 });
      const managed = payload?.data || null;
      setManagePackData(managed);
      applyManagedPackToMyList(managed);
      return managed;
    } catch (err) {
      if (Number(err?.status || 0) === 404) {
        removePackFromMyList(packKey);
        if (openModal) setManagePackOpen(false);
      }
      setManagePackError(err?.message || 'Falha ao carregar gerenciador do pack.');
      throw err;
    } finally {
      if (!silent) setManagePackLoading(false);
    }
  };

  const openManagePackByKey = async (packKey) => {
    if (!packKey) return;
    if (packActionBusyByKey?.[packKey]) return;
    setPackActionBusy(packKey, 'manage');
    setPackActionsSheetPack(null);
    try {
      await loadManagePackData(packKey, { openModal: true });
    } catch (err) {
      pushProfileToast(err?.message || 'Falha ao abrir gerenciador do pack.', 'error');
      setManagePackOpen(false);
    } finally {
      setPackActionBusy(packKey, '');
    }
  };

  const closeManagePackModal = () => {
    setManagePackOpen(false);
    setManagePackBusyAction('');
    setManagePackError('');
    setManagePackData(null);
    setManagePackTargetKey('');
  };

  const refreshManagePackData = async () => {
    if (!managePackTargetKey) return;
    try {
      await loadManagePackData(managePackTargetKey, { openModal: true, silent: true });
    } catch {
      // ignore transient refresh failures
    }
  };

  const applyManagedMutationResult = async (payloadData, { successMessage = '' } = {}) => {
    const envelope = payloadData?.data ? payloadData : { data: payloadData || {} };
    const status = getManagedMutationStatus(envelope);
    const managed = envelope?.data?.pack ? envelope.data : envelope?.pack ? envelope : null;

    if (status === 'already_deleted' && !managed?.pack) {
      const deletedPackKey = String(envelope?.data?.pack_key || managePackTargetKey || '').trim();
      if (deletedPackKey) removePackFromMyList(deletedPackKey);
      if (deletedPackKey && String(managePackTargetKey || '') === deletedPackKey) closeManagePackModal();
      await refreshMyProfile({ silent: true }).catch(() => {});
      return null;
    }

    if (managed?.pack) {
      setManagePackData(managed);
      applyManagedPackToMyList(managed);
    }

    const targetKey = String(managed?.pack?.pack_key || envelope?.data?.pack_key || managePackTargetKey || '').trim() || '';
    if (targetKey && managePackOpen && String(managePackTargetKey || '') === targetKey) {
      try {
        await loadManagePackData(targetKey, { openModal: true, silent: true });
      } catch (err) {
        if (Number(err?.status || 0) === 404) {
          removePackFromMyList(targetKey);
          closeManagePackModal();
        }
      }
    }

    await refreshMyProfile({ silent: true }).catch(() => {});
    if (successMessage && status !== 'noop' && status !== 'unchanged' && status !== 'already_deleted') {
      pushProfileToast(successMessage, 'success');
    }
    if (status === 'noop') {
      pushProfileToast('Nenhuma alteração necessária (estado já atualizado).', 'warning');
    }
    if (status === 'unchanged') {
      pushProfileToast('Nenhuma alteração detectada.', 'warning');
    }
    return managed;
  };

  const openAnalyticsModalForPack = async (pack) => {
    if (!pack?.pack_key) return;
    setAnalyticsModalPack(pack);
    setAnalyticsModalOpen(true);
    setAnalyticsModalError('');
    setAnalyticsModalLoading(true);
    try {
      const payload = await fetchJson(buildManagePackApiPath(pack.pack_key, '/analytics'), {
        retry: 1,
      });
      setAnalyticsModalData(payload?.data || null);
    } catch (err) {
      setAnalyticsModalError(err?.message || 'Falha ao carregar analytics do pack.');
    } finally {
      setAnalyticsModalLoading(false);
    }
  };

  const closeAnalyticsModal = () => {
    setAnalyticsModalOpen(false);
    setAnalyticsModalError('');
    setAnalyticsModalLoading(false);
  };

  const mergeEngagementInPack = (pack, engagement) => {
    if (!pack || !engagement) return pack;
    return {
      ...pack,
      engagement: {
        ...(pack.engagement || {}),
        ...engagement,
      },
    };
  };

  const applyPackEngagement = (packKey, engagement) => {
    if (!packKey || !engagement) return;
    setPacks((prev) => prev.map((entry) => (entry?.pack_key === packKey ? mergeEngagementInPack(entry, engagement) : entry)));
    setRelatedPacks((prev) => prev.map((entry) => (entry?.pack_key === packKey ? mergeEngagementInPack(entry, engagement) : entry)));
    setCurrentPack((prev) => (prev?.pack_key === packKey ? mergeEngagementInPack(prev, engagement) : prev));
  };

  const registerPackInteraction = async (packKey, action, { silent = false } = {}) => {
    if (!packKey || !['open', 'like', 'dislike'].includes(action)) return null;
    try {
      const payload = await fetchJson(`${config.apiBasePath}/${encodeURIComponent(packKey)}/${action}`, { method: 'POST' });
      const engagement = payload?.data?.engagement || null;
      if (engagement) applyPackEngagement(packKey, engagement);
      return engagement;
    } catch (err) {
      if (!silent) setError(err?.message || 'Falha ao registrar interação');
      return null;
    }
  };

  const buildParams = ({ q, category, sort, limit, offset, includeVisibility = false }) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (category) params.set('categories', category);
    if (sort) params.set('sort', normalizeCatalogSort(sort));
    params.set('limit', String(limit));
    if (Number.isFinite(offset)) params.set('offset', String(offset));
    if (includeVisibility) params.set('visibility', 'public');
    return params;
  };

  const loadPacks = async ({ page = catalogPage } = {}) => {
    const safePage = Math.max(FIRST_CATALOG_PAGE, Number(page || FIRST_CATALOG_PAGE));
    const nextOffset = (safePage - 1) * config.limit;
    setPacksLoading(true);
    setError('');
    try {
      const effectiveSort = catalogFilter === 'trending' ? 'trending' : sortBy;
      const params = buildParams({
        q: catalogFilter === 'trending' ? '' : appliedQuery,
        category: catalogFilter === 'trending' ? '' : activeCategory,
        sort: effectiveSort,
        limit: config.limit,
        offset: nextOffset,
        includeVisibility: true,
      });

      const payload = await fetchJson(`${config.apiBasePath}?${params.toString()}`);
      const data = Array.isArray(payload?.data) ? payload.data : [];
      const hasMore = Boolean(payload?.pagination?.has_more);
      setPacks(data);
      setPackHasMore(hasMore);
    } catch (err) {
      setError(err?.message || 'Falha ao carregar packs');
      setPacks([]);
      setPackHasMore(false);
    } finally {
      setPacksLoading(false);
    }
  };

  const loadCreatorRanking = async () => {
    setCreatorRankingLoading(true);
    setCreatorRankingError('');
    try {
      const params = new URLSearchParams();
      params.set('visibility', 'public');
      params.set('limit', '100');
      params.set('sort', normalizeCreatorsSort(creatorSort));
      const payload = await fetchJson(`${config.apiBasePath}/creators?${params.toString()}`, {
        retry: 1,
      });
      const rows = (Array.isArray(payload?.data) ? payload.data : []).map((entry, index) => {
        const publisher = String(entry?.publisher || '').trim() || `Criador ${index + 1}`;
        const stats = entry?.stats || {};
        const avgPackScore = safeNumber(stats?.avg_pack_score);
        const likes = safeNumber(stats?.total_likes);
        const downloads = safeNumber(stats?.total_opens);
        const packCount = safeNumber(stats?.packs_count);
        return {
          key: String(publisher || '').toLowerCase(),
          publisher,
          verified: Boolean(entry?.verified),
          badges: Array.isArray(entry?.badges) ? entry.badges : [],
          packCount,
          likes,
          downloads,
          avgPackScore,
          creatorScore: buildCreatorScore({ avgPackScore, likes, downloads }),
          avatarUrl: getAvatarUrl(publisher),
          topPack: entry?.top_pack || null,
          raw: entry,
        };
      });
      setCreatorRanking(rows);
    } catch (err) {
      setCreatorRanking([]);
      setCreatorRankingError(err?.message || 'Falha ao carregar ranking de criadores.');
    } finally {
      setCreatorRankingLoading(false);
    }
  };

  const loadRelatedPacksForPack = async (pack) => {
    const sourcePackKey = String(pack?.pack_key || '').trim();
    if (!sourcePackKey) return;
    const q = String(pack?.publisher || '').trim();
    const relatedParams = new URLSearchParams();
    relatedParams.set('visibility', 'public');
    relatedParams.set('limit', '6');
    if (q) relatedParams.set('q', q);
    else if (Array.isArray(pack?.tags) && pack.tags[0]) relatedParams.set('categories', pack.tags[0]);

    setRelatedPacksLoading(true);
    try {
      const relatedPayload = await fetchJson(`${config.apiBasePath}?${relatedParams.toString()}`);
      const relatedList = (Array.isArray(relatedPayload?.data) ? relatedPayload.data : []).filter((entry) => entry.pack_key && entry.pack_key !== sourcePackKey).slice(0, 4);
      setRelatedPacks(relatedList);
    } catch {
      setRelatedPacks([]);
    } finally {
      setRelatedPacksLoading(false);
    }
  };

  const tryLoadManagedPackDetail = async (packKey) => {
    try {
      const managedPayload = await fetchJson(buildManagePackApiPath(packKey), { retry: 1 });
      const managedPack = managedPayload?.data?.pack || null;
      return managedPack?.pack_key ? managedPack : null;
    } catch {
      return null;
    }
  };

  const loadPackDetail = async (packKey) => {
    if (!packKey) return;
    setPackLoading(true);
    setCurrentPack(null);
    setRelatedPacks([]);
    setRelatedPacksLoading(false);
    setError('');

    try {
      let pack = null;
      try {
        const payload = await fetchJson(`${config.apiBasePath}/${encodeURIComponent(packKey)}`);
        pack = payload?.data || null;
      } catch (publicError) {
        if (Number(publicError?.status || 0) !== 404) throw publicError;
        pack = await tryLoadManagedPackDetail(packKey);
        if (!pack) throw publicError;
      }

      setCurrentPack(pack);
      const resolvedPackKey = String(pack?.pack_key || packKey).trim();
      if (resolvedPackKey && resolvedPackKey !== packKey) {
        window.history.replaceState({}, '', `${config.webPath}/${encodeURIComponent(resolvedPackKey)}`);
        setCurrentPackKey(resolvedPackKey);
      }

      void registerPackInteraction(resolvedPackKey || packKey, 'open', { silent: true });
    } catch (err) {
      setError(err?.message || 'Não foi possível abrir o pack');
    } finally {
      setPackLoading(false);
    }
  };

  const requestRelatedPacksForCurrentPack = async () => {
    if (!currentPack || relatedPacksLoading || relatedPacks.length) return;
    await loadRelatedPacksForPack(currentPack);
  };

  const buildCatalogWebUrl = ({ q = appliedQuery, category = activeCategory, sort = sortBy, filter = catalogFilter, page = catalogPage } = {}) => {
    const params = new URLSearchParams();
    const safePage = Math.max(FIRST_CATALOG_PAGE, Number(page || FIRST_CATALOG_PAGE));
    const normalizedFilter =
      String(filter || '')
        .trim()
        .toLowerCase() === 'trending'
        ? 'trending'
        : '';
    const normalizedSort = normalizeCatalogSort(sort || DEFAULT_CATALOG_SORT);
    if (normalizedFilter === 'trending') {
      params.set('filter', 'trending');
    } else {
      if (String(q || '').trim()) params.set('q', String(q).trim());
      if (String(category || '').trim()) params.set('category', String(category).trim().toLowerCase());
      if (normalizedSort && normalizedSort !== DEFAULT_CATALOG_SORT) params.set('sort', normalizedSort);
    }
    if (safePage > FIRST_CATALOG_PAGE) params.set('page', String(safePage));
    const qs = params.toString();
    return `${config.webPath}/${qs ? `?${qs}` : ''}`;
  };

  const buildCreatorsWebUrl = ({ sort = creatorSort } = {}) => {
    const params = new URLSearchParams();
    params.set('sort', normalizeCreatorsSort(sort || DEFAULT_CREATORS_SORT));
    return `${config.webPath}/creators?${params.toString()}`;
  };

  const applyCatalogViewState = ({ q = '', category = '', sort = DEFAULT_CATALOG_SORT, filter = '', page = FIRST_CATALOG_PAGE } = {}) => {
    const normalizedFilter =
      String(filter || '')
        .trim()
        .toLowerCase() === 'trending'
        ? 'trending'
        : '';
    const normalizedSort = normalizeCatalogSort(normalizedFilter ? 'trending' : sort || DEFAULT_CATALOG_SORT);
    const nextQ = normalizedFilter ? '' : String(q || '').trim();
    const nextCategory = normalizedFilter
      ? ''
      : String(category || '')
          .trim()
          .toLowerCase();
    const nextPage = Math.max(FIRST_CATALOG_PAGE, Number(page || FIRST_CATALOG_PAGE));

    setCatalogFilter(normalizedFilter);
    setSortBy(normalizedSort);
    setQuery(nextQ);
    setAppliedQuery(nextQ);
    setActiveCategory(nextCategory);
    setCatalogPage(nextPage);
  };

  const scrollToTopIfMobile = ({ behavior = 'smooth' } = {}) => {
    const isMobile = window.matchMedia ? window.matchMedia('(max-width: 1023px)').matches : window.innerWidth < 1024;
    if (!isMobile) return;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior });
    });
  };

  const openPack = (packKey, push = true) => {
    if (!packKey) return;
    if (push) window.history.pushState({}, '', `${config.webPath}/${encodeURIComponent(packKey)}`);
    setCurrentView('pack');
    setCurrentPackKey(packKey);
    setSortPickerOpen(false);
    scrollToTopIfMobile({ behavior: 'smooth' });
  };

  const goCatalog = (push = true) => {
    if (push) window.history.pushState({}, '', buildCatalogWebUrl());
    setCurrentView('catalog');
    setCurrentPackKey('');
    setCurrentPack(null);
    setRelatedPacks([]);
    setRelatedPacksLoading(false);
    setSortPickerOpen(false);
  };

  const openCatalogWithState = ({ q = '', category = '', sort = DEFAULT_CATALOG_SORT, filter = '', page = FIRST_CATALOG_PAGE, push = true } = {}) => {
    const nextState = {
      q,
      category,
      sort: normalizeCatalogSort(sort || DEFAULT_CATALOG_SORT),
      page: Math.max(FIRST_CATALOG_PAGE, Number(page || FIRST_CATALOG_PAGE)),
      filter:
        String(filter || '')
          .trim()
          .toLowerCase() === 'trending'
          ? 'trending'
          : '',
    };
    if (push) window.history.pushState({}, '', buildCatalogWebUrl(nextState));
    applyCatalogViewState(nextState);
    setCurrentView('catalog');
    setCurrentPackKey('');
    setCurrentPack(null);
    setRelatedPacks([]);
    setRelatedPacksLoading(false);
    setError('');
    setSortPickerOpen(false);
  };

  const goToCatalogPage = (nextPage, { push = true } = {}) => {
    const safePage = Math.max(FIRST_CATALOG_PAGE, Number(nextPage || FIRST_CATALOG_PAGE));
    if (safePage === catalogPage && currentView === 'catalog' && !currentPackKey) return;
    openCatalogWithState({
      q: catalogFilter === 'trending' ? '' : appliedQuery,
      category: catalogFilter === 'trending' ? '' : activeCategory,
      sort: sortBy,
      filter: catalogFilter,
      page: safePage,
      push,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToCatalogPacksSection = ({ behavior = 'smooth' } = {}) => {
    const tryScroll = () => {
      const section = document.getElementById('catalog-packs-section');
      if (!section) return false;
      section.scrollIntoView({ behavior, block: 'start' });
      return true;
    };

    if (tryScroll()) return;
    let tries = 0;
    const retry = () => {
      tries += 1;
      if (tryScroll() || tries >= 8) return;
      window.setTimeout(retry, 80);
    };
    window.setTimeout(retry, 80);
  };

  const openTrendingCatalog = () => {
    openCatalogWithState({ q: '', category: '', sort: 'trending', filter: 'trending', push: true });
    setDiscoverTab('growing');
    scrollToCatalogPacksSection({ behavior: 'smooth' });
  };

  const openCreatorsRanking = (sort = DEFAULT_CREATORS_SORT, push = true) => {
    const nextSort = normalizeCreatorsSort(sort || DEFAULT_CREATORS_SORT);
    if (push) window.history.pushState({}, '', buildCreatorsWebUrl({ sort: nextSort }));
    setCreatorSort(nextSort);
    setCurrentView('creators');
    setCurrentPackKey('');
    setCurrentPack(null);
    setRelatedPacks([]);
    setRelatedPacksLoading(false);
    setError('');
    setSortPickerOpen(false);
  };

  const openCreatorProfileFromRanking = (creator) => {
    const publisher = String(creator?.publisher || '').trim();
    if (!publisher) return;
    openCatalogWithState({
      q: publisher,
      category: '',
      sort: DEFAULT_CATALOG_SORT,
      filter: '',
      push: true,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openCatalogTagFilter = (tag) => {
    const nextTag = String(tag || '')
      .trim()
      .toLowerCase();
    if (!nextTag) return;
    openCatalogWithState({
      q: '',
      category: nextTag,
      sort: DEFAULT_CATALOG_SORT,
      filter: '',
      push: true,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const buildLoginRedirectUrl = (nextPath = '') => {
    const next = String(nextPath || '').trim() || `${config.webPath}/perfil`;
    const loginUrl = new URL(config.loginPath || '/login', window.location.origin);
    loginUrl.searchParams.set('next', next);
    return `${loginUrl.pathname}${loginUrl.search}`;
  };

  const redirectToLogin = (nextPath = '') => {
    window.location.assign(buildLoginRedirectUrl(nextPath));
  };

  const openProfile = (push = true) => {
    googlePromptAttemptedRef.current = false;
    if (push) window.history.pushState({}, '', `${config.webPath}/perfil`);
    setCurrentView('profile');
    setCurrentPackKey('');
    setCurrentPack(null);
    setRelatedPacks([]);
    setRelatedPacksLoading(false);
    setError('');
    setSortPickerOpen(false);
  };

  const requestNsfwUnlock = () => {
    openProfile(true);
  };

  const cycleVisibilityValue = (currentVisibility) => {
    const normalized = String(currentVisibility || '').toLowerCase();
    if (normalized === 'public') return 'unlisted';
    if (normalized === 'unlisted') return 'private';
    return 'public';
  };

  const openPackActionsSheet = (pack) => {
    if (!pack?.pack_key) return;
    setPackActionsSheetPack(pack);
  };

  const closePackActionsSheet = () => {
    setPackActionsSheetPack(null);
  };

  const runPackQuickMutation = async (packKey, actionName, task) => {
    if (!packKey || typeof task !== 'function') return null;
    if (packActionBusyByKey?.[packKey]) return null;
    setPackActionBusy(packKey, actionName);
    try {
      return await task();
    } finally {
      setPackActionBusy(packKey, '');
    }
  };

  const handlePackVisibilityQuickToggle = async (pack) => {
    if (!pack?.pack_key) return;
    const nextVisibility = cycleVisibilityValue(pack.visibility);
    await runPackQuickMutation(pack.pack_key, 'visibility', async () => {
      const payload = await fetchJson(buildManagePackApiPath(pack.pack_key), {
        method: 'PATCH',
        retry: 1,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ visibility: nextVisibility }),
      });
      await applyManagedMutationResult(payload?.data ? payload : { data: payload }, {
        successMessage: `Visibilidade alterada para ${nextVisibility}.`,
      });
    }).catch((err) => {
      pushProfileToast(err?.message || 'Falha ao alterar visibilidade.', 'error');
    });
  };

  const handlePackDuplicate = async (pack) => {
    if (!pack?.pack_key) return;
    await runPackQuickMutation(pack.pack_key, 'duplicate', async () => {
      await fetchJson(buildManagePackApiPath(pack.pack_key, '/clone'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({}),
      });
      await refreshMyProfile({ silent: true });
      pushProfileToast('Pack duplicado com sucesso.', 'success');
    }).catch((err) => {
      pushProfileToast(err?.message || 'Falha ao duplicar pack.', 'error');
    });
  };

  const requestDeletePack = (pack) => {
    if (!pack?.pack_key) return;
    setConfirmDeletePack(pack);
    setConfirmDeleteBusy(false);
    closePackActionsSheet();
  };

  const handleDeletePackConfirmed = async () => {
    const pack = confirmDeletePack;
    if (!pack?.pack_key || confirmDeleteBusy) return;
    setConfirmDeleteBusy(true);
    try {
      const payload = await fetchJson(buildManagePackApiPath(pack.pack_key), {
        method: 'DELETE',
        retry: 1,
      });
      const status = getManagedMutationStatus(payload);
      removePackFromMyList(pack.pack_key);
      await refreshMyProfile({ silent: true });
      if (managePackOpen && String(managePackTargetKey || '') === String(pack.pack_key)) {
        closeManagePackModal();
      }
      pushProfileToast(status === 'already_deleted' ? 'Pack já havia sido apagado.' : 'Pack apagado com sucesso.', 'success');
      setConfirmDeletePack(null);
    } catch (err) {
      pushProfileToast(err?.message || 'Falha ao apagar pack.', 'error');
    } finally {
      setConfirmDeleteBusy(false);
    }
  };

  const handlePackActionsSheetAction = async (actionKey, pack) => {
    if (!pack?.pack_key) return;
    if (actionKey === 'manage' || actionKey === 'edit') {
      await openManagePackByKey(pack.pack_key);
      return;
    }
    if (actionKey === 'visibility') {
      closePackActionsSheet();
      await handlePackVisibilityQuickToggle(pack);
      return;
    }
    if (actionKey === 'duplicate') {
      closePackActionsSheet();
      await handlePackDuplicate(pack);
      return;
    }
    if (actionKey === 'analytics') {
      closePackActionsSheet();
      await openAnalyticsModalForPack(pack);
      return;
    }
    if (actionKey === 'delete') {
      requestDeletePack(pack);
    }
  };

  const runManagePackMutation = async (actionName, task, successMessage = '') => {
    if (!managePackTargetKey) return null;
    if (managePackBusyAction) return null;
    setManagePackBusyAction(actionName);
    setManagePackError('');
    try {
      const result = await task();
      await applyManagedMutationResult(result, { successMessage });
      return result;
    } catch (err) {
      if (Number(err?.status || 0) === 404) {
        removePackFromMyList(managePackTargetKey);
        closeManagePackModal();
      }
      setManagePackError(err?.message || 'Falha ao atualizar pack.');
      pushProfileToast(err?.message || 'Falha ao atualizar pack.', 'error');
      try {
        err.handledByUi = true;
      } catch {
        // ignore assignment failures on unknown error objects
      }
      throw err;
    } finally {
      setManagePackBusyAction('');
    }
  };

  const handleManageSaveMetadata = async (values) => {
    if (!managePackTargetKey) return;
    await runManagePackMutation(
      'saveMetadata',
      async () =>
        fetchJson(buildManagePackApiPath(managePackTargetKey), {
          method: 'PATCH',
          retry: 1,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            name: values?.name,
            publisher: values?.publisher,
            description: values?.description,
            tags: Array.isArray(values?.tags) ? values.tags : [],
            visibility: values?.visibility,
          }),
        }),
      'Pack atualizado.',
    ).catch(() => {});
  };

  const handleManageAddSticker = async (file) => {
    if (!managePackTargetKey || !file || managePackBusyAction) return;
    try {
      const stickerDataUrl = await readFileAsDataUrl(file);
      await runManagePackMutation(
        'addSticker',
        async () =>
          fetchJson(buildManagePackApiPath(managePackTargetKey, '/stickers'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ sticker_data_url: stickerDataUrl }),
          }),
        'Sticker adicionado ao pack.',
      );
    } catch (err) {
      if (err?.handledByUi) return;
      pushProfileToast(err?.message || 'Falha ao adicionar sticker.', 'error');
    }
  };

  const handleManageSetCover = async (stickerId) => {
    if (!managePackTargetKey || !stickerId) return;
    await runManagePackMutation(
      'setCover',
      async () =>
        fetchJson(buildManagePackApiPath(managePackTargetKey, '/cover'), {
          method: 'POST',
          retry: 1,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ sticker_id: stickerId }),
        }),
      'Capa atualizada.',
    ).catch(() => {});
  };

  const handleManageRemoveSticker = async (stickerId) => {
    if (!managePackTargetKey || !stickerId) return;
    await runManagePackMutation(
      'removeSticker',
      async () =>
        fetchJson(`${buildManagePackApiPath(managePackTargetKey, '/stickers')}/${encodeURIComponent(stickerId)}`, {
          method: 'DELETE',
          retry: 1,
        }),
      'Sticker removido do pack.',
    ).catch(() => {});
  };

  const handleManageReplaceSticker = async (stickerId, file) => {
    if (!managePackTargetKey || !stickerId || !file || managePackBusyAction) return;
    try {
      const stickerDataUrl = await readFileAsDataUrl(file);
      await runManagePackMutation(
        'replaceSticker',
        async () =>
          fetchJson(`${buildManagePackApiPath(managePackTargetKey, '/stickers')}/${encodeURIComponent(stickerId)}/replace`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ sticker_data_url: stickerDataUrl }),
          }),
        'Sticker substituído com sucesso.',
      );
    } catch (err) {
      if (err?.handledByUi) return;
      pushProfileToast(err?.message || 'Falha ao substituir sticker.', 'error');
    }
  };

  const handleManageReorder = async (orderStickerIds) => {
    if (!managePackTargetKey || !Array.isArray(orderStickerIds) || !orderStickerIds.length) return;
    await runManagePackMutation(
      'reorder',
      async () =>
        fetchJson(buildManagePackApiPath(managePackTargetKey, '/reorder'), {
          method: 'POST',
          retry: 1,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ order_sticker_ids: orderStickerIds }),
        }),
      'Ordem dos stickers salva.',
    ).catch(() => {});
  };

  const openSortPicker = () => {
    if (sortPickerBusy || sortPickerLockRef.current) return;
    setSortPickerOpen(true);
  };

  const closeSortPicker = () => {
    if (sortPickerBusy) return;
    setSortPickerOpen(false);
  };

  const handleCatalogSortSelection = async (sortValue) => {
    const nextSort = normalizeCatalogSort(sortValue, sortBy);
    if (sortPickerBusy || sortPickerLockRef.current) return;
    sortPickerLockRef.current = true;
    setSortPickerBusy(true);
    if (catalogFilter) setCatalogFilter('');
    setSortBy(nextSort);
    setCatalogPage(FIRST_CATALOG_PAGE);
    setSortPickerOpen(false);
    scrollToCatalogPacksSection({ behavior: 'smooth' });
    window.setTimeout(() => {
      sortPickerLockRef.current = false;
      setSortPickerBusy(false);
    }, 220);
  };

  const handleCreatorsSortChange = (sortValue) => {
    setCreatorSort(normalizeCreatorsSort(sortValue, creatorSort));
  };

  const handleCategoryChipPress = (value) => {
    const nextValue = String(value || '')
      .trim()
      .toLowerCase();
    const previousScrollY = window.scrollY || 0;

    if (!nextValue) {
      openTrendingCatalog();
      window.requestAnimationFrame(() => window.scrollTo({ top: previousScrollY }));
      return;
    }

    const toggledOff = catalogFilter !== 'trending' && activeCategory === nextValue;
    const nextSort = catalogFilter === 'trending' ? DEFAULT_CATALOG_SORT : sortBy;

    openCatalogWithState({
      q: catalogFilter === 'trending' ? '' : appliedQuery,
      category: toggledOff ? '' : nextValue,
      sort: nextSort,
      filter: '',
      push: true,
    });

    window.requestAnimationFrame(() => window.scrollTo({ top: previousScrollY }));
  };

  const getKnownPackByKey = (packKey) => {
    if (!packKey) return null;
    if (currentPack?.pack_key === packKey) return currentPack;
    return packs.find((entry) => entry?.pack_key === packKey) || relatedPacks.find((entry) => entry?.pack_key === packKey) || null;
  };

  const applyOptimisticPackReaction = (packKey, action) => {
    const sourcePack = getKnownPackByKey(packKey);
    if (!sourcePack) return null;
    const previous = {
      open_count: safeNumber(sourcePack?.engagement?.open_count),
      like_count: safeNumber(sourcePack?.engagement?.like_count),
      dislike_count: safeNumber(sourcePack?.engagement?.dislike_count),
      comment_count: safeNumber(sourcePack?.engagement?.comment_count),
      score: safeNumber(sourcePack?.engagement?.score) || safeNumber(sourcePack?.engagement?.like_count) - safeNumber(sourcePack?.engagement?.dislike_count),
      updated_at: sourcePack?.engagement?.updated_at || null,
    };
    const optimistic = {
      ...previous,
      updated_at: __timeNowIso(),
    };
    if (action === 'like') {
      optimistic.like_count += 1;
      optimistic.score += 1;
    }
    if (action === 'dislike') {
      optimistic.dislike_count += 1;
      optimistic.score -= 1;
    }
    applyPackEngagement(packKey, optimistic);
    return previous;
  };

  const emitReactionNotice = (message, type = 'success') => {
    setReactionNotice({ message: String(message || ''), type });
  };

  const handleLike = async (packKey) => {
    if (!packKey || reactionLoading) return;
    const previousEngagement = applyOptimisticPackReaction(packKey, 'like');
    setReactionLoading('like');
    emitReactionNotice('👍 Curtido');
    const engagement = await registerPackInteraction(packKey, 'like');
    if (!engagement && previousEngagement) {
      applyPackEngagement(packKey, previousEngagement);
      emitReactionNotice('Falha ao curtir', 'error');
    }
    setReactionLoading('');
  };

  const handleDislike = async (packKey) => {
    if (!packKey || reactionLoading) return;
    const previousEngagement = applyOptimisticPackReaction(packKey, 'dislike');
    setReactionLoading('dislike');
    emitReactionNotice('👎 Avaliação enviada');
    const engagement = await registerPackInteraction(packKey, 'dislike');
    if (!engagement && previousEngagement) {
      applyPackEngagement(packKey, previousEngagement);
      emitReactionNotice('Falha ao enviar avaliação', 'error');
    }
    setReactionLoading('');
  };

  useEffect(() => {
    const applyRoute = () => {
      const route = parseStickersLocation(config.webPath);
      if (route.view === 'creators') {
        const creatorsSearch = parseCreatorsSearchState(window.location.search);
        setCreatorSort(normalizeCreatorsSort(creatorsSearch.sort || DEFAULT_CREATORS_SORT));
        openCreatorsRanking(creatorsSearch.sort || DEFAULT_CREATORS_SORT, false);
        return;
      }
      if (route.view === 'profile') {
        openProfile(false);
        return;
      }
      if (route.view === 'pack' && route.packKey) {
        openPack(route.packKey, false);
        return;
      }
      applyCatalogViewState(parseCatalogSearchState(window.location.search));
      goCatalog(false);
    };

    applyRoute();

    const onPopState = () => {
      applyRoute();
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [config.webPath]);

  useEffect(() => {
    const onScroll = () => setIsScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!reactionNotice?.message) return undefined;
    const timer = window.setTimeout(() => setReactionNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [reactionNotice]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
      const parsed = JSON.parse(raw || '[]');
      if (Array.isArray(parsed)) {
        setRecentSearches(
          parsed
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
            .slice(0, 8),
        );
      }
    } catch {
      // ignore malformed local storage payloads
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'k') {
        event.preventDefault();
        const input = document.querySelector('input[type="search"]');
        if (input && typeof input.focus === 'function') input.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    let mounted = true;
    fetchJson(`${config.apiBasePath}/support`)
      .then((payload) => {
        if (!mounted) return;
        setSupportInfo(payload?.data || null);
      })
      .catch(() => {
        if (!mounted) return;
        setSupportInfo(null);
      });
    return () => {
      mounted = false;
    };
  }, [config.apiBasePath]);

  useEffect(() => {
    if (currentView !== 'catalog' || currentPackKey) return;
    const nextUrl = buildCatalogWebUrl();
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl !== currentUrl) {
      window.history.replaceState({}, '', nextUrl);
    }
  }, [currentView, currentPackKey, appliedQuery, activeCategory, sortBy, catalogFilter, catalogPage, config.webPath]);

  useEffect(() => {
    if (currentView !== 'creators') return;
    const nextUrl = buildCreatorsWebUrl();
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl !== currentUrl) {
      window.history.replaceState({}, '', nextUrl);
    }
  }, [currentView, creatorSort, config.webPath]);

  useEffect(() => {
    if (currentView === 'pack' && currentPackKey) {
      void loadPackDetail(currentPackKey);
      return;
    }
    if (currentView === 'creators') {
      void loadCreatorRanking();
      return;
    }
    if (currentView !== 'catalog') return;
    void loadPacks({ page: catalogPage });
  }, [appliedQuery, activeCategory, sortBy, catalogFilter, currentView, currentPackKey, creatorSort, catalogPage]);

  useEffect(() => {
    if (currentView !== 'catalog' || currentPackKey) return undefined;
    const timer = setInterval(() => {
      void loadPacks({ page: catalogPage });
    }, 60 * 1000);
    return () => clearInterval(timer);
  }, [currentView, currentPackKey, appliedQuery, activeCategory, sortBy, catalogFilter, catalogPage]);

  useEffect(() => {
    const sync = () => setUploadTask(readUploadTask());
    sync();

    const interval = setInterval(sync, 1000);
    const onStorage = (event) => {
      if (event?.key === PACK_UPLOAD_TASK_KEY) {
        sync();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      clearInterval(interval);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    if (!isProfileView) {
      googlePromptAttemptedRef.current = false;
      return;
    }
    void refreshMyProfile();
  }, [isProfileView, myProfileApiPath]);

  useEffect(() => {
    const clearGoogleButton = () => {
      if (googleButtonRef.current) googleButtonRef.current.innerHTML = '';
      try {
        window.google?.accounts?.id?.cancel?.();
      } catch {
        // ignore sdk cleanup errors
      }
    };

    if (!shouldRenderGoogleButton) {
      clearGoogleButton();
      return;
    }
    if (!googleButtonRef.current) return;

    let cancelled = false;
    setGoogleAuthError('');

    loadScript(GOOGLE_GSI_SCRIPT_SRC)
      .then(() => {
        if (cancelled) return;
        const accounts = window.google?.accounts?.id;
        if (!accounts) throw new Error('SDK do Google não disponível.');

        accounts.initialize({
          client_id: googleAuthConfig.clientId,
          callback: (response) => {
            const credential = String(response?.credential || '').trim();
            const claims = decodeJwtPayload(credential);
            if (!credential || !claims?.sub) {
              setGoogleAuthError('Falha ao concluir login Google.');
              return;
            }
            setGoogleAuthBusy(true);
            fetchJson(googleSessionApiPath, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ google_id_token: credential }),
            })
              .then(async () => {
                googlePromptAttemptedRef.current = true;
                const profilePayload = await fetchJson(myProfileApiPath);
                applyMyProfileData(profilePayload);
                setMyPacksError('');
              })
              .catch((sessionError) => {
                setGoogleAuthError(sessionError?.message || 'Falha ao salvar sessão Google.');
              })
              .finally(() => setGoogleAuthBusy(false));
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        });

        if (googleButtonRef.current) {
          googleButtonRef.current.innerHTML = '';
          const measuredWidth = Math.floor(Number(googleButtonRef.current.clientWidth || 0));
          const buttonWidth = Math.max(180, Math.min(320, measuredWidth || 320));
          accounts.renderButton(googleButtonRef.current, {
            type: 'standard',
            theme: 'filled_black',
            size: 'large',
            text: 'signin_with',
            shape: 'pill',
            logo_alignment: 'left',
            width: buttonWidth,
          });
        }

        if (!googlePromptAttemptedRef.current) {
          googlePromptAttemptedRef.current = true;
          try {
            accounts.prompt(() => {});
          } catch {
            // prompt may be blocked by browser/privacy settings
          }
        }
      })
      .catch((sdkError) => {
        if (cancelled) return;
        setGoogleAuthError(sdkError?.message || 'Falha ao carregar login Google.');
      });

    return () => {
      cancelled = true;
      clearGoogleButton();
    };
  }, [shouldRenderGoogleButton, googleAuthConfig.clientId, googleSessionApiPath, myProfileApiPath]);

  const handleGoogleLogout = async () => {
    setGoogleAuthBusy(true);
    setGoogleAuthError('');
    setGoogleAuth({ user: null, expiresAt: '' });
    clearGoogleAuthCache();
    try {
      await fetchJson(googleSessionApiPath, { method: 'DELETE' });
    } catch {
      // still refresh local state after logout attempts
    } finally {
      setGoogleAuthBusy(false);
    }
    googlePromptAttemptedRef.current = false;
    await refreshMyProfile({ silent: false });
  };

  const onSubmit = (event) => {
    event.preventDefault();
    setShowAutocomplete(false);
    const next = query.trim();
    setCatalogFilter('');
    setCatalogPage(FIRST_CATALOG_PAGE);
    setAppliedQuery(next);
    if (next) {
      const nextHistory = [next, ...recentSearches.filter((entry) => entry !== next)].slice(0, 8);
      setRecentSearches(nextHistory);
      try {
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(nextHistory));
      } catch {
        // ignore storage quota/security errors
      }
    }
  };

  const applySuggestion = (item) => {
    const value = String(item?.value || '').trim();
    if (!value) return;
    setQuery(value);
    setCatalogFilter('');
    setCatalogPage(FIRST_CATALOG_PAGE);
    setAppliedQuery(value);
    if (dynamicCategoryOptions.some((entry) => entry.value === value)) {
      setActiveCategory(value);
    }
    setShowAutocomplete(false);
  };

  const clearFilters = () => {
    setQuery('');
    setAppliedQuery('');
    setActiveCategory('');
    setCatalogFilter('');
    setCatalogPage(FIRST_CATALOG_PAGE);
  };

  return html`
    <div className="min-h-screen bg-slate-950 text-slate-100 stickers-market-shell">
      <style>
        ${`@keyframes fadeInCard { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulseGlow { 0%, 100% { opacity: 0.58; } 50% { opacity: 0.94; } }
        .fade-card { animation: fadeInCard 260ms ease both; }
        .line-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .stickers-market-shell { --market-blue: #0f172a; --market-cyan: #22d3ee; --market-green: #34d399; scroll-behavior: smooth; }
        .market-shell-glow {
          pointer-events: none;
          position: fixed;
          inset: 0;
          z-index: 0;
          background:
            radial-gradient(48rem 28rem at 4% -10%, rgba(52, 211, 153, 0.14), transparent 62%),
            radial-gradient(40rem 24rem at 96% -8%, rgba(34, 211, 238, 0.15), transparent 60%),
            radial-gradient(52rem 30rem at 50% 120%, rgba(15, 23, 42, 0.84), transparent 70%);
        }
        .market-glass {
          border: 1px solid rgba(71, 85, 105, 0.52);
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.78), rgba(2, 6, 23, 0.72));
          box-shadow: 0 20px 42px rgba(2, 6, 23, 0.36);
          backdrop-filter: blur(14px);
        }
        .market-header-glass {
          border-bottom: 1px solid rgba(71, 85, 105, 0.45);
          background: linear-gradient(180deg, rgba(2, 6, 23, 0.84), rgba(2, 6, 23, 0.68));
          backdrop-filter: blur(16px);
        }
        .market-search-shell {
          border: 1px solid rgba(71, 85, 105, 0.55);
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.95), rgba(15, 23, 42, 0.85));
          box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.35);
        }
        .catalog-hero {
          position: relative;
          overflow: hidden;
        }
        .catalog-hero::before {
          content: '';
          position: absolute;
          inset: -24% -10% auto;
          height: 82%;
          background: radial-gradient(26rem 14rem at 22% 0%, rgba(52, 211, 153, 0.18), transparent 65%);
          animation: pulseGlow 6.8s ease-in-out infinite;
          pointer-events: none;
        }
        .catalog-hero::after {
          content: '';
          position: absolute;
          inset: auto -20% -38% -15%;
          height: 70%;
          background: radial-gradient(26rem 12rem at 70% 60%, rgba(34, 211, 238, 0.13), transparent 70%);
          pointer-events: none;
        }
        .kpi-card {
          border: 1px solid rgba(71, 85, 105, 0.5);
          background: rgba(2, 6, 23, 0.42);
        }
        .metric-card {
          border: 1px solid rgba(71, 85, 105, 0.5);
          background: linear-gradient(180deg, rgba(2, 6, 23, 0.62), rgba(2, 6, 23, 0.38));
          border-radius: 14px;
        }
        .market-sidebar-panel {
          border: 1px solid rgba(71, 85, 105, 0.54);
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.82), rgba(2, 6, 23, 0.72));
          backdrop-filter: blur(10px);
        }
        .chips-scroll {
          scroll-snap-type: x mandatory;
          -webkit-overflow-scrolling: touch;
          scroll-behavior: smooth;
          scrollbar-width: none;
          overscroll-behavior-x: contain;
          touch-action: pan-x;
        }
        .chips-scroll::-webkit-scrollbar { display: none; }
        .chip-item { scroll-snap-align: start; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
        .pack-stickers-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .market-catalog-grid { display: grid; gap: 0.8rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
        @media (min-width: 768px) {
          .market-catalog-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }
        @media (min-width: 1024px) {
          .pack-stickers-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
          .market-catalog-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }
        @media (min-width: 1280px) {
          .market-catalog-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        }
        @media (min-width: 1536px) {
          .market-catalog-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
        }
        @media (max-width: 767px) {
          .market-header-action-label {
            display: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .fade-card { animation: none; }
          .catalog-hero::before { animation: none; }
        }`}
      </style>

      <div className="market-shell-glow"></div>

      <header className=${`sticky top-0 z-30 market-header-glass transition-shadow ${isScrolled ? 'shadow-[0_16px_44px_rgba(2,6,23,0.52)]' : ''}`}>
        <div className="mx-auto w-full max-w-[1400px] px-3 sm:px-4 lg:px-6">
          <div className="flex h-[74px] items-center gap-2.5 md:gap-3.5">
            <a href="/" className="shrink-0 flex items-center gap-2.5">
              <img src=${OMNIZAP_LOGO_DATA_URL} alt="OmniZap" className="h-9 w-9 rounded-full border border-slate-700/90 ring-2 ring-slate-800/70" decoding="async" />
              <span className="hidden md:inline text-sm font-semibold tracking-wide text-slate-100">OmniZap Marketplace</span>
            </a>

            ${currentView === 'catalog'
              ? html`
                  <form onSubmit=${onSubmit} className="relative mx-auto w-full max-w-[760px]">
                    <div className="market-search-shell h-11 rounded-2xl">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-slate-400">🔎</span>
                      <input
                        type="search"
                        value=${query}
                        onChange=${(e) => setQuery(e.target.value)}
                        onFocus=${() => setShowAutocomplete(true)}
                        onBlur=${() => setTimeout(() => setShowAutocomplete(false), 120)}
                        onKeyDown=${(event) => {
                          if (event.key === 'Escape') {
                            setShowAutocomplete(false);
                          }
                        }}
                        placeholder="Buscar packs, temas e criadores"
                        className="h-full w-full rounded-2xl bg-transparent pl-10 pr-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition focus:ring-2 focus:ring-cyan-400/25"
                      />
                    </div>
                    ${showAutocomplete && filteredSuggestions.length
                      ? html`
                          <div className="absolute z-40 mt-2 w-full overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-xl">
                            ${filteredSuggestions.map(
                              (item) => html`
                                <button key=${item.value} type="button" onClick=${() => applySuggestion(item)} className="w-full border-b border-slate-800 px-3 py-2.5 text-left text-sm text-slate-200 hover:bg-slate-800 last:border-b-0 flex items-center justify-between gap-2">
                                  <span className="inline-flex items-center gap-2">
                                    <span>${item.icon || '🏷'}</span>
                                    <span className="truncate">${item.label}</span>
                                  </span>
                                  <span className="truncate text-xs text-slate-400">${item.value}</span>
                                </button>
                              `,
                            )}
                          </div>
                        `
                      : null}
                  </form>
                `
              : html`<div className="flex-1"></div>`}

            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              <button type="button" className=${`inline-flex h-10 items-center gap-1.5 rounded-xl border px-2.5 text-xs transition ${isProfileView ? 'border-cyan-400/45 bg-cyan-500/12 text-cyan-100' : 'border-slate-700 bg-slate-900/65 text-slate-200 hover:bg-slate-800'}`} onClick=${() => openProfile(true)} title="Meus packs">
                <span>📦</span>
                <span className="market-header-action-label">Meus Packs</span>
              </button>
              <a className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-emerald-400/35 bg-emerald-500/14 px-2.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/24 transition" href="/stickers/create/" title="Criar pack">
                <span>✨</span>
                <span className="market-header-action-label">Criar Pack</span>
              </a>
              <button type="button" onClick=${() => openProfile(true)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/65 px-2 text-xs text-slate-200 hover:bg-slate-800 transition" title="Perfil">
                ${hasGoogleLogin && googleAuth?.user?.picture ? html`<img src=${googleAuth.user.picture} alt="Perfil" className="h-6 w-6 rounded-full border border-slate-700 object-cover" />` : html`<span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-700 bg-slate-800">👤</span>`}
                <span className="market-header-action-label">Perfil</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-[1] mx-auto w-full max-w-[1400px] px-3 py-3.5 sm:px-4 sm:py-4 lg:px-6 space-y-3.5 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        ${error ? html`<div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">${error}</div>` : null}
        ${isProfileView
          ? html` <${CreatorProfileDashboard} googleAuthConfig=${googleAuthConfig} googleAuth=${googleAuth} googleAuthBusy=${googleAuthBusy} googleAuthError=${googleAuthError} googleSessionChecked=${googleSessionChecked} myPacks=${myPacks} myPacksLoading=${myPacksLoading} myPacksError=${myPacksError} myProfileStats=${myProfileStats} onBack=${goCatalog} onRefresh=${() => refreshMyProfile()} onLogout=${handleGoogleLogout} onOpenPublicPack=${openPack} onOpenPackActions=${openPackActionsSheet} onOpenManagePack=${(pack) => openManagePackByKey(pack?.pack_key || '')} onRequestDeletePack=${requestDeletePack} packActionBusyByKey=${packActionBusyByKey} /> `
          : isCreatorsView
            ? html` <${CreatorsRankingPage} creators=${sortedCreatorRanking} loading=${creatorRankingLoading} error=${creatorRankingError} sort=${creatorSort} onSortChange=${handleCreatorsSortChange} onBack=${goCatalog} onRetry=${loadCreatorRanking} onOpenCreator=${openCreatorProfileFromRanking} onOpenPack=${openPack} /> `
            : currentPackKey
              ? html` ${packLoading ? html`<${PackPageSkeleton} />` : html`<${PackPage} pack=${currentPack} relatedPacks=${relatedPacks} relatedLoading=${relatedPacksLoading} onLoadRelated=${requestRelatedPacksForCurrentPack} onBack=${goCatalog} onOpenRelated=${openPack} onLike=${handleLike} onDislike=${handleDislike} onTagClick=${openCatalogTagFilter} reactionLoading=${reactionLoading} reactionNotice=${reactionNotice} hasNsfwAccess=${hasNsfwAccess} onRequireLogin=${requestNsfwUnlock} />`} `
              : html`
                  <section className="catalog-hero market-glass rounded-[28px] p-4 sm:p-5 lg:p-6">
                    <div className="relative z-[1] flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                      <div className="max-w-3xl">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-emerald-200/85">OmniZap Marketplace</p>
                        <h1 className="mt-1 text-xl font-semibold leading-tight text-slate-100 sm:text-2xl lg:text-3xl">Packs de stickers prontos para seu WhatsApp</h1>
                        <p className="mt-2 text-sm leading-relaxed text-slate-300">Explore coleções curadas, descubra criadores com melhor performance e publique novos packs com mais conversão.</p>
                        ${highlightCreator ? html`<p className="mt-2 text-xs text-cyan-200/90">⭐ Criador em destaque hoje: <span className="font-semibold">${highlightCreator}</span></p>` : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" onClick=${openTrendingCatalog} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-cyan-400/35 bg-cyan-500/14 px-3 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/24 transition">🔎 Explorar packs</button>
                        <a href="/stickers/create/" className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-emerald-400/35 bg-emerald-500/14 px-3 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/24 transition">✨ Criar pack</a>
                        <button type="button" onClick=${() => openCreatorsRanking('popular', true)} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-indigo-400/35 bg-indigo-500/10 px-3 text-xs font-semibold text-indigo-100 hover:bg-indigo-500/20 transition">⭐ Ver criadores</button>
                      </div>
                    </div>
                    <div className="relative z-[1] mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                      <article className="metric-card px-3 py-2.5">
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Packs</p>
                        <p className="mt-1 text-base font-semibold text-slate-100">${shortNum(catalogTotals.packs)}</p>
                      </article>
                      <article className="metric-card px-3 py-2.5">
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Stickers</p>
                        <p className="mt-1 text-base font-semibold text-slate-100">${shortNum(catalogTotals.stickers)}</p>
                      </article>
                      <article className="metric-card px-3 py-2.5">
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Likes</p>
                        <p className="mt-1 text-base font-semibold text-slate-100">${shortNum(catalogTotals.likes)}</p>
                      </article>
                      <article className="metric-card px-3 py-2.5">
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Downloads</p>
                        <p className="mt-1 text-base font-semibold text-slate-100">${shortNum(catalogTotals.downloads)}</p>
                      </article>
                      <article className="metric-card col-span-2 px-3 py-2.5 sm:col-span-1">
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Criadores ativos</p>
                        <p className="mt-1 text-base font-semibold text-slate-100">${shortNum(catalogTotals.creators)}</p>
                      </article>
                    </div>
                  </section>
                  <div className="lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-5">
                    <aside className="hidden lg:block">
                      <div className="market-sidebar-panel sticky top-[98px] space-y-3 rounded-2xl p-3">
                        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-200">Filtros</h3>
                            <button type="button" onClick=${clearFilters} className="h-8 rounded-lg border border-slate-700 px-2.5 text-[11px] text-slate-200 hover:bg-slate-800 transition">Limpar</button>
                          </div>
                          <p className="mt-1 text-[11px] text-slate-500">${sortedPacks.length} packs nesta página</p>
                        </div>

                        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                          <p className="text-xs font-semibold text-slate-100">Ordenação rápida</p>
                          <div className="mt-2 space-y-1.5">
                            ${[
                              { value: 'recent', label: 'Mais recentes', icon: '🆕' },
                              { value: 'likes', label: 'Mais curtidos', icon: '👍' },
                              { value: 'downloads', label: 'Mais baixados', icon: '⬇️' },
                            ].map((option) => html` <button key=${option.value} type="button" onClick=${() => handleCatalogSortSelection(option.value)} disabled=${sortPickerBusy} className=${`w-full h-9 rounded-xl border px-2.5 text-left text-xs transition disabled:opacity-60 ${normalizeCatalogSort(sortBy) === option.value ? 'border-cyan-400/40 bg-cyan-500/14 text-cyan-100' : 'border-slate-700 text-slate-200 hover:bg-slate-800'}`}>${option.icon} ${option.label}</button> `)}
                          </div>
                        </div>

                        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                          <p className="text-xs font-semibold text-slate-100">Categorias</p>
                          <div className="mt-2 flex flex-wrap gap-1.5">${dynamicCategoryOptions.slice(0, 12).map((item) => html` <button key=${`sidebar-${item.value || 'all'}`} type="button" onClick=${() => handleCategoryChipPress(item.value)} className=${`h-8 rounded-full border px-2.5 text-[11px] transition ${activeCategory === item.value ? 'border-emerald-300 bg-emerald-400 text-slate-900 font-semibold' : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'}`}>${item.label}</button> `)}</div>
                        </div>

                        <button type="button" onClick=${openTrendingCatalog} className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-cyan-400/35 bg-cyan-500/12 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/22 transition">🔥 Em alta agora</button>
                        ${supportInfo?.url ? html` <a href=${supportInfo.url} target="_blank" rel="noreferrer noopener" className="inline-flex h-9 w-full items-center justify-center rounded-xl border border-emerald-500/35 bg-emerald-500/10 text-xs text-emerald-200 hover:bg-emerald-500/20 transition"> 💬 Suporte no WhatsApp </a> ` : null}
                      </div>
                    </aside>

                    <div className="space-y-3 min-w-0">
                      <section className="space-y-2 min-w-0 rounded-2xl border border-slate-800/80 bg-slate-900/65 px-2.5 py-2 lg:hidden">
                        <div className="relative min-w-0">
                          <div className="absolute left-0 top-0 bottom-0 w-5 bg-gradient-to-r from-slate-950 to-transparent pointer-events-none z-10"></div>
                          <div className="absolute right-0 top-0 bottom-0 w-5 bg-gradient-to-l from-slate-950 to-transparent pointer-events-none z-10"></div>
                          <div className="chips-scroll flex max-w-full gap-1.5 overflow-x-auto pb-1 pr-1">${dynamicCategoryOptions.map((item) => html` <button key=${item.value || 'all'} type="button" onClick=${() => handleCategoryChipPress(item.value)} className=${`chip-item h-8 whitespace-nowrap rounded-full px-3 text-[11px] border transition ${activeCategory === item.value ? 'bg-emerald-400 text-slate-900 border-emerald-300 font-semibold shadow-[0_0_0_2px_rgba(16,185,129,0.18)]' : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'}`}>${item.label}</button> `)}</div>
                        </div>
                      </section>

                      ${packs.length
                        ? html`
                            <section className="space-y-2">
                              <div className="market-glass rounded-2xl p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div>
                                    <p className="text-[11px] uppercase tracking-wide text-slate-400">Descobrir</p>
                                    <h3 className="text-sm font-semibold text-slate-100">Painel oficial do marketplace</h3>
                                  </div>
                                </div>

                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  ${[
                                    { key: 'growing', label: '🔥 Crescendo' },
                                    { key: 'top', label: '🏆 Top 10' },
                                    { key: 'creators', label: '⭐ Criadores' },
                                  ].map((tab) => html` <button key=${tab.key} type="button" onClick=${() => setDiscoverTab(tab.key)} className=${`h-8 rounded-full border px-2.5 text-[11px] touch-manipulation ${discoverTab === tab.key ? 'border-cyan-400/35 bg-cyan-500/10 text-cyan-100' : 'border-slate-700 bg-slate-950/40 text-slate-300 hover:bg-slate-800'}`}>${tab.label}</button> `)}
                                </div>

                                <div className="mt-2 hidden lg:block">
                                  ${discoverTab === 'growing'
                                    ? html` <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">${growingNowPacks.slice(0, DESKTOP_DISCOVER_GROWING_LIMIT).map((entry) => html`<${DiscoverPackRowItem} key=${`grow-${entry.pack_key}`} pack=${entry} onOpen=${openPack} hasNsfwAccess=${hasNsfwAccess} onRequireLogin=${requestNsfwUnlock} />`)}</div> `
                                    : discoverTab === 'top'
                                      ? html` <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">${topWeekPacks.slice(0, DESKTOP_DISCOVER_TOP_LIMIT).map((entry, idx) => html`<${DiscoverPackRowItem} key=${`top-${entry.pack_key}`} pack=${entry} onOpen=${openPack} rank=${idx + 1} hasNsfwAccess=${hasNsfwAccess} onRequireLogin=${requestNsfwUnlock} />`)}</div> `
                                      : html`
                                          <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                                            ${featuredCreators.map(
                                              (creator) => html`
                                                <button
                                                  key=${creator.publisher}
                                                  onClick=${() =>
                                                    openCatalogWithState({
                                                      q: creator.publisher,
                                                      category: '',
                                                      sort: DEFAULT_CATALOG_SORT,
                                                      filter: '',
                                                      push: true,
                                                    })}
                                                  className="w-full flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-2 py-1.5 text-left hover:bg-slate-800/90"
                                                >
                                                  <img src=${getAvatarUrl(creator.publisher)} alt="" className="w-9 h-9 rounded-full bg-slate-800" />
                                                  <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-xs font-medium text-slate-100">${creator.publisher}</span>
                                                    <span className="block truncate text-[10px] text-slate-400">${creator.packCount} packs · ❤️ ${shortNum(creator.likes)} · ⬇ ${shortNum(creator.opens)}</span>
                                                  </span>
                                                  <span className="text-[10px] text-slate-500">filtrar</span>
                                                </button>
                                              `,
                                            )}
                                          </div>
                                        `}
                                </div>

                                <div className="mt-2 lg:hidden">
                                  ${discoverTab === 'growing'
                                    ? html`
                                        <div className="space-y-2">
                                          <section className="space-y-1.5">
                                            <div className="flex items-center justify-between">
                                              <h4 className="text-xs font-semibold text-slate-200">🔥 Em alta agora</h4>
                                              <button type="button" onClick=${openTrendingCatalog} className="inline-flex h-7 items-center gap-1 rounded-full border border-cyan-400/35 bg-cyan-500/10 px-2.5 text-[10px] font-semibold text-cyan-100 transition hover:bg-cyan-500/20 active:scale-[0.98]">
                                                <span>ver lista</span>
                                                <span aria-hidden="true">↗</span>
                                              </button>
                                            </div>
                                            <div className="flex gap-2 overflow-x-auto pb-1">${growingNowPacks.slice(0, MOBILE_DISCOVER_CAROUSEL_LIMIT).map((entry) => html`<${DiscoverPackMiniCard} key=${`mobile-grow-${entry.pack_key}`} pack=${entry} onOpen=${openPack} hasNsfwAccess=${hasNsfwAccess} onRequireLogin=${requestNsfwUnlock} />`)}</div>
                                          </section>
                                          <section className="space-y-1.5">
                                            <div className="flex items-center justify-between">
                                              <h4 className="text-xs font-semibold text-slate-200">🆕 Recém publicados</h4>
                                              <button type="button" onClick=${openSortPicker} disabled=${sortPickerBusy} className="inline-flex h-7 items-center gap-1 rounded-full border border-emerald-400/35 bg-emerald-500/10 px-2.5 text-[10px] font-semibold text-emerald-100 transition hover:bg-emerald-500/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100">
                                                <span>ordenar</span>
                                                <span aria-hidden="true">⇅</span>
                                              </button>
                                            </div>
                                            <div className="flex gap-2 overflow-x-auto pb-1">${recentPublishedPacks.slice(0, MOBILE_DISCOVER_CAROUSEL_LIMIT).map((entry) => html`<${DiscoverPackMiniCard} key=${`mobile-new-${entry.pack_key}`} pack=${entry} onOpen=${openPack} hasNsfwAccess=${hasNsfwAccess} onRequireLogin=${requestNsfwUnlock} />`)}</div>
                                          </section>
                                        </div>
                                      `
                                    : discoverTab === 'top'
                                      ? html`
                                          <section className="space-y-1.5">
                                            <div className="flex items-center justify-between">
                                              <h4 className="text-xs font-semibold text-slate-200">🏆 Top 10 da semana</h4>
                                              <button
                                                type="button"
                                                onClick=${() =>
                                                  openCatalogWithState({
                                                    q: '',
                                                    category: '',
                                                    sort: 'trending',
                                                    filter: '',
                                                    push: true,
                                                  })}
                                                className="text-[10px] text-cyan-300"
                                              >
                                                ver lista
                                              </button>
                                            </div>
                                            <div className="flex gap-2 overflow-x-auto pb-1">${topWeekPacks.slice(0, MOBILE_DISCOVER_CAROUSEL_LIMIT).map((entry) => html`<${DiscoverPackMiniCard} key=${`mobile-top-${entry.pack_key}`} pack=${entry} onOpen=${openPack} hasNsfwAccess=${hasNsfwAccess} onRequireLogin=${requestNsfwUnlock} />`)}</div>
                                          </section>
                                        `
                                      : html`
                                          <section className="space-y-1.5">
                                            <div className="flex items-center justify-between">
                                              <h4 className="text-xs font-semibold text-slate-200">👑 Criadores populares</h4>
                                              <button type="button" onClick=${() => openCreatorsRanking('popular', true)} className="text-[10px] text-cyan-300">ver lista</button>
                                            </div>
                                            <div className="flex gap-2 overflow-x-auto pb-1">
                                              ${featuredCreators.map(
                                                (creator) => html`
                                                  <${DiscoverCreatorMiniCard}
                                                    key=${`mobile-tab-creator-${creator.publisher}`}
                                                    creator=${creator}
                                                    onPick=${(publisher) =>
                                                      openCatalogWithState({
                                                        q: publisher,
                                                        category: '',
                                                        sort: DEFAULT_CATALOG_SORT,
                                                        filter: '',
                                                        push: true,
                                                      })}
                                                  />
                                                `,
                                              )}
                                            </div>
                                          </section>
                                        `}
                                </div>
                              </div>

                              <div className="hidden lg:block rounded-2xl border border-emerald-500/20 bg-gradient-to-r from-emerald-500/10 to-cyan-500/5 p-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-xs font-semibold text-emerald-100">Quer aparecer em destaque?</p>
                                    <p className="text-[11px] text-slate-300">Publique seu pack e melhore capa/tags para ganhar mais cliques.</p>
                                  </div>
                                  <a href="/stickers/create/" className="inline-flex h-8 items-center rounded-lg border border-emerald-400/35 bg-emerald-500/10 px-3 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/20"> Publicar pack </a>
                                </div>
                              </div>
                            </section>
                          `
                        : null}
                      ${packs.length
                        ? html`
                            <section id="catalog-packs-section" className="space-y-3.5 min-w-0">
                              <div className="flex flex-wrap items-end justify-between gap-3">
                                <div>
                                  <h2 className="text-lg sm:text-xl font-bold">Catálogo de Packs</h2>
                                  <p className="text-xs text-slate-400">Página ${catalogPage} · ${sortedPacks.length} resultados · ${categoryActiveLabel}</p>
                                </div>
                                <div className="hidden md:flex items-center gap-2">
                                  <span className="text-xs text-slate-400">Ordenar por</span>
                                  <button type="button" onClick=${openSortPicker} disabled=${sortPickerBusy} className="inline-flex h-8 items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-60 transition">
                                    <span>${catalogSortLabel(sortBy)}</span>
                                    <span className="text-[10px] text-slate-400">▾</span>
                                  </button>
                                </div>
                              </div>
                              <div className="market-glass flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2.5">
                                <span className="text-xs text-slate-400">Página ${catalogPage}${packHasMore ? ' · há mais resultados' : ' · fim da lista'}</span>
                                <div className="flex items-center gap-2">
                                  <button type="button" onClick=${() => goToCatalogPage(catalogPage - 1, { push: true })} disabled=${!canGoCatalogPrev} className="inline-flex h-8 items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 transition">Anterior</button>
                                  <button type="button" onClick=${() => goToCatalogPage(catalogPage + 1, { push: true })} disabled=${!canGoCatalogNext} className="inline-flex h-8 items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 transition">Próxima</button>
                                </div>
                              </div>
                              <div className="market-catalog-grid min-w-0">
                                ${sortedPacks.map(
                                  (pack, index) =>
                                    html`<div key=${pack.pack_key || pack.id} className="fade-card">
                                      <${PackCard} pack=${pack} index=${index} onOpen=${openPack} hasNsfwAccess=${hasNsfwAccess} onRequireLogin=${requestNsfwUnlock} />
                                    </div>`,
                                )}
                              </div>
                              <div className="market-glass flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2.5">
                                <span className="text-xs text-slate-400">Página ${catalogPage}${packHasMore ? ' · há mais resultados' : ' · fim da lista'}</span>
                                <div className="flex items-center gap-2">
                                  <button type="button" onClick=${() => goToCatalogPage(catalogPage - 1, { push: true })} disabled=${!canGoCatalogPrev} className="inline-flex h-8 items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 transition">Anterior</button>
                                  <button type="button" onClick=${() => goToCatalogPage(catalogPage + 1, { push: true })} disabled=${!canGoCatalogNext} className="inline-flex h-8 items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 transition">Próxima</button>
                                </div>
                              </div>
                            </section>
                          `
                        : null}
                      ${packsLoading ? html`<${SkeletonGrid} count=${10} />` : null} ${!packsLoading && !hasAnyResult ? html`<${EmptyState} onClear=${clearFilters} />` : null}
                    </div>
                  </div>
                `}
      </main>
      <${UploadTaskWidget}
        task=${uploadTask}
        onClose=${() => {
          try {
            localStorage.removeItem(PACK_UPLOAD_TASK_KEY);
          } catch {
            // ignore storage cleanup errors
          }
          setUploadTask(null);
        }}
      />
      <${CatalogSortPicker} open=${sortPickerOpen} currentSort=${sortBy} busy=${sortPickerBusy} onClose=${closeSortPicker} onSelect=${handleCatalogSortSelection} />
      <${PackActionsSheet} open=${Boolean(packActionsSheetPack)} pack=${packActionsSheetPack} busyAction=${packActionsSheetPack ? packActionBusyByKey?.[packActionsSheetPack.pack_key] || '' : ''} onClose=${closePackActionsSheet} onAction=${handlePackActionsSheetAction} />
      <${PackManagerModal} open=${managePackOpen} data=${managePackData} loading=${managePackLoading} error=${managePackError} busyAction=${managePackBusyAction} onClose=${closeManagePackModal} onRefresh=${refreshManagePackData} onSaveMetadata=${handleManageSaveMetadata} onAddSticker=${handleManageAddSticker} onRemoveSticker=${handleManageRemoveSticker} onReplaceSticker=${handleManageReplaceSticker} onSetCover=${handleManageSetCover} onReorder=${handleManageReorder} onOpenAnalytics=${() => openAnalyticsModalForPack(managePackData?.pack || null)} />
      <${PackAnalyticsModal} open=${analyticsModalOpen} pack=${analyticsModalPack} data=${analyticsModalData} loading=${analyticsModalLoading} error=${analyticsModalError} onClose=${closeAnalyticsModal} />
      <${ConfirmDialog} open=${Boolean(confirmDeletePack)} title="Apagar pack" message=${confirmDeletePack ? `Tem certeza que deseja apagar o pack "${confirmDeletePack.name || confirmDeletePack.pack_key}"? Essa ação remove o pack do seu painel.` : ''} confirmLabel="Apagar pack" cancelLabel="Cancelar" danger=${true} busy=${confirmDeleteBusy} onCancel=${() => (confirmDeleteBusy ? null : setConfirmDeletePack(null))} onConfirm=${handleDeletePackConfirmed} />
      <${ToastStack} toasts=${profileToasts} onDismiss=${dismissProfileToast} />
    </div>
  `;
}

const rootEl = document.getElementById('stickers-react-root');
if (rootEl) {
  createRoot(rootEl).render(html`<${StickersApp} />`);
}
