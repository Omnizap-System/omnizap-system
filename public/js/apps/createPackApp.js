import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);
const CREATE_PACK_DRAFT_KEY = 'omnizap_create_pack_draft_v1';
const CREATE_PACK_DRAFT_MAX_CHARS = 3_500_000;
const PACK_UPLOAD_TASK_KEY = 'omnizap_pack_upload_task_v1';
const GOOGLE_AUTH_CACHE_KEY = 'omnizap_google_web_auth_cache_v1';
const GOOGLE_AUTH_CACHE_MAX_STALE_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_MANUAL_TAGS = 8;
const DEFAULT_SUGGESTED_TAGS = ['anime', 'meme', 'game', 'texto', 'nsfw', 'dark', 'cartoon', 'foto-real', 'cyberpunk'];
const PACK_STATUS_PUBLISHED = 'published';
const FIXED_UPLOAD_QUEUE_CONCURRENCY = 3;
const UPLOAD_AUTO_RETRY_ATTEMPTS = 2;
const UPLOAD_RETRY_BASE_DELAY_MS = 700;

const DEFAULT_LIMITS = {
  pack_name_max_length: 120,
  publisher_max_length: 120,
  description_max_length: 1024,
  stickers_per_pack: 30,
  packs_per_owner: 50,
  sticker_upload_max_bytes: 2 * 1024 * 1024,
  sticker_upload_source_max_bytes: 20 * 1024 * 1024,
};
const UPLOAD_REQUEST_TIMEOUT_MS = 8 * 60 * 1000;

const STEPS = [
  { id: 1, title: 'Informações' },
  { id: 2, title: 'Stickers' },
  { id: 3, title: 'Publicação' },
];

const clampText = (value, maxLength) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const clampInputText = (value, maxLength) => String(value || '').slice(0, maxLength);

const removeControlChars = (value) =>
  Array.from(String(value || ''))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('');

const sanitizePackNameInput = (value, maxLength = 120) => removeControlChars(value).slice(0, maxLength);

const sanitizePackName = (value, maxLength = 120) => removeControlChars(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);

const toBytesLabel = (bytes) => `${Math.round(Number(bytes || 0) / 1024)} KB`;
const normalizeTag = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const mergeTags = (...groups) => {
  const seen = new Set();
  const ordered = [];
  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      const normalized = normalizeTag(entry);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
  }
  return ordered;
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

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, { credentials: 'include', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || 'Falha na requisição.');
  }
  return payload;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));

const bytesToHex = (bufferLike) => {
  const bytes = bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike || []);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const computeDataUrlSha256 = async (dataUrl) => {
  try {
    const raw = String(dataUrl || '');
    const base64 = raw.includes(',') ? raw.split(',').slice(1).join(',') : raw;
    if (!base64) return '';
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return '';
    const binary = atob(base64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const digest = await subtle.digest('SHA-256', bytes);
    return bytesToHex(digest);
  } catch {
    return '';
  }
};

const runAsyncQueue = async (items, worker, maxConcurrency = FIXED_UPLOAD_QUEUE_CONCURRENCY) => {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const concurrency = Math.max(1, Math.min(Number(maxConcurrency || 1), list.length));
  const results = new Array(list.length);
  let cursor = 0;

  const runWorker = async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
};

const isTransientUploadError = (error) => {
  const statusCode = Number(error?.statusCode || 0);
  if ([408, 429, 502, 503, 504].includes(statusCode)) return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('rede') || message.includes('timeout') || message.includes('demorou');
};

const writeUploadTask = (payload) => {
  try {
    localStorage.setItem(
      PACK_UPLOAD_TASK_KEY,
      JSON.stringify({
        ...payload,
        updatedAt: __timeNowMs(),
      }),
    );
  } catch {
    // ignore storage errors
  }
};

const clearCreatePackStorage = () => {
  try {
    localStorage.removeItem(CREATE_PACK_DRAFT_KEY);
    localStorage.removeItem(PACK_UPLOAD_TASK_KEY);
  } catch {
    // ignore storage errors
  }
};

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Falha ao ler arquivo.'));
    reader.readAsDataURL(file);
  });

const uploadStickerWithProgress = ({ apiBasePath, packKey, editToken, item, setCover, onProgress }) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${apiBasePath}/${encodeURIComponent(packKey)}/stickers-upload`);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
    xhr.timeout = UPLOAD_REQUEST_TIMEOUT_MS;

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percentage = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
      onProgress(percentage);
    };

    xhr.onerror = () => {
      const error = new Error(`Falha de rede ao enviar ${item.file.name}.`);
      error.statusCode = 0;
      reject(error);
    };
    xhr.ontimeout = () => {
      const error = new Error(`Timeout ao enviar ${item.file.name}. Tente novamente.`);
      error.statusCode = 408;
      reject(error);
    };
    xhr.onload = () => {
      let payload = {};
      try {
        payload = JSON.parse(xhr.responseText || '{}');
      } catch {
        payload = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      if (xhr.status === 413) {
        const error = new Error(`Arquivo muito grande para enviar (${item.file.name}). Reduza o tamanho e tente novamente.`);
        error.statusCode = 413;
        error.code = payload?.code || '';
        reject(error);
        return;
      }
      if (xhr.status === 502 || xhr.status === 504) {
        const error = new Error(`Servidor demorou para processar ${item.file.name}. Tente novamente em seguida.`);
        error.statusCode = xhr.status;
        error.code = payload?.code || '';
        reject(error);
        return;
      }
      const error = new Error(payload?.error || `Falha no upload de ${item.file.name}.`);
      error.statusCode = xhr.status;
      error.code = payload?.code || '';
      reject(error);
    };

    const body = JSON.stringify({
      edit_token: editToken,
      upload_id: String(item.id || ''),
      sticker_hash: String(item.hash || ''),
      sticker_data_url: item.dataUrl,
      set_cover: Boolean(setCover),
    });
    xhr.send(body);
  });

const uploadStickerWithRetry = async (params) => {
  let lastError = null;

  for (let attempt = 1; attempt <= UPLOAD_AUTO_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await uploadStickerWithProgress(params);
    } catch (error) {
      lastError = error;
      if (attempt >= UPLOAD_AUTO_RETRY_ATTEMPTS || !isTransientUploadError(error)) {
        break;
      }
      await sleep(UPLOAD_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  throw lastError || new Error('Falha no upload do sticker.');
};

function StepPill({ step, active, done }) {
  return html`
    <div className=${`flex min-w-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 transition sm:gap-2 sm:rounded-2xl sm:px-3 sm:py-2 ${active ? 'border-accent/50 bg-accent/10 text-accent' : done ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-line/70 bg-panelSoft/80 text-slate-300'}`}>
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/25 text-[11px] font-extrabold sm:h-6 sm:w-6 sm:text-xs"> ${done ? '✓' : step.id} </span>
      <p className="truncate text-[10px] font-semibold sm:text-[11px]">${step.title}</p>
    </div>
  `;
}

function FloatingField({ label, value, onChange, maxLength, hint = '', multiline = false }) {
  const used = String(value || '').length;
  const nearLimit = used >= maxLength * 0.85;
  const atLimit = used >= maxLength;
  const Tag = multiline ? 'textarea' : 'input';

  return html`
    <label className="block">
      <span className="mb-1.5 inline-block text-xs font-semibold text-slate-300">${label}</span>
      <div className="relative">
        <${Tag} className=${`w-full rounded-2xl border bg-panel/70 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-transparent md:bg-panel/80 md:px-4 md:py-3 ${atLimit ? 'border-rose-400/60 focus:border-rose-300' : 'border-line focus:border-accent/60'} ${multiline ? 'min-h-[96px] max-h-44 resize-none overflow-y-auto md:min-h-[110px] md:max-h-52' : 'h-11 md:h-12'}`} placeholder=${label} value=${value} maxlength=${maxLength} onInput=${onChange} />
        <span className="pointer-events-none absolute left-3.5 top-[-9px] rounded-md bg-app-base px-1.5 text-[10px] font-semibold uppercase tracking-[.08em] text-slate-400 md:left-4 md:bg-panel md:px-2"> ${label} </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
        <span className="line-clamp-2 text-slate-400">${hint}</span>
        <span className=${`${atLimit ? 'text-rose-300' : nearLimit ? 'text-amber-300' : 'text-slate-400'} font-semibold`}>${used}/${maxLength}</span>
      </div>
    </label>
  `;
}

function StickerThumb({ item, index, selectedCoverId, onSetCover, onRemove, onDragStart, onDropOn }) {
  return html`
    <article draggable=${true} onDragStart=${() => onDragStart(item.id)} onDragOver=${(e) => e.preventDefault()} onDrop=${() => onDropOn(item.id)} className="group relative overflow-hidden rounded-2xl border border-line bg-panelSoft">
      ${item.mediaKind === 'video' ? html`<video src=${item.dataUrl} muted=${true} playsinline=${true} preload="metadata" className="aspect-square w-full object-cover bg-slate-900/80"></video>` : html`<img src=${item.dataUrl} alt=${item.file.name} className="aspect-square w-full object-contain bg-slate-900/80" />`}
      <span className="absolute left-2 top-2 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-bold">#${index + 1}</span>
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent p-2">
        <button type="button" onClick=${() => onSetCover(item.id)} className=${`rounded-lg px-2 py-1 text-[10px] font-bold ${selectedCoverId === item.id ? 'bg-accent text-slate-900' : 'bg-white/15 text-slate-100'}`}>${selectedCoverId === item.id ? 'Capa' : 'Definir capa'}</button>
        <button type="button" onClick=${() => onRemove(item.id)} className="rounded-lg bg-rose-500/80 px-2 py-1 text-[10px] font-bold text-white">Remover</button>
      </div>
    </article>
  `;
}

function PackPreviewPanel({ preview, quality, compact = false }) {
  return html`
    <div className="space-y-2">
      <article className="min-w-0 overflow-hidden rounded-2xl border border-line/70 bg-panelSoft/80">
        <img src=${preview.coverUrl} alt="Preview capa" className="aspect-square w-full object-cover bg-slate-900/70" />
        <div className=${`${compact ? 'p-3' : 'p-4'} space-y-2`}>
          <p className=${`${compact ? 'text-base' : 'text-lg'} line-clamp-2 font-display font-bold`}>${preview.name}</p>
          <p className="line-clamp-2 text-sm text-slate-300">${preview.description || 'Descrição do pack aparecerá aqui.'}</p>
          <p className="text-xs text-slate-400">por ${preview.publisher}</p>
          <div className="flex flex-wrap items-center gap-1">${preview.tags.length ? preview.tags.map((tag) => html`<span key=${tag} className="rounded-full border border-line/70 px-2 py-0.5 text-[10px] text-slate-300">#${tag}</span>`) : html`<span className="text-[10px] text-slate-500">Adicione tags para melhorar descoberta</span>`}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-full border border-line/70 px-2 py-1 text-slate-300">${preview.visibility}</span>
            <span className="rounded-full border border-line/70 px-2 py-1 text-slate-300">🧩 ${preview.stickerCount}</span>
            <span className="rounded-full border border-line/70 px-2 py-1 text-slate-300">❤️ ${preview.fakeLikes}</span>
            <span className="rounded-full border border-line/70 px-2 py-1 text-slate-300">⬇ ${preview.fakeOpens}</span>
          </div>
        </div>
      </article>

      <div className="rounded-2xl border border-line/60 bg-panelSoft/70 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-semibold text-slate-200">Score: ${quality.score} · ${quality.label}</p>
          <span className=${`${quality.tone} shrink-0 text-[11px] font-semibold`}>${quality.score}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-900/70">
          <div className=${`h-full transition-all ${quality.bar}`} style=${{ width: `${quality.score}%` }}></div>
        </div>
      </div>
    </div>
  `;
}

function CreatePackApp() {
  const root = document.getElementById('create-pack-react-root');
  const apiBasePath = root?.dataset?.apiBasePath || '/api/sticker-packs';
  const webPath = root?.dataset?.webPath || '/stickers';
  const loginPath = root?.dataset?.loginPath || '/login';
  const googleSessionApiPath = `${apiBasePath}/auth/google/session`;

  const [step, setStep] = useState(1);
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [publisher, setPublisher] = useState('');
  const [visibility, setVisibility] = useState('public');
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');
  const [suggestedTags, setSuggestedTags] = useState(DEFAULT_SUGGESTED_TAGS);
  const [googleAuth, setGoogleAuth] = useState(() => readGoogleAuthCache() || { user: null, expiresAt: '' });
  const [googleSessionChecked, setGoogleSessionChecked] = useState(false);
  const [authRedirecting, setAuthRedirecting] = useState(false);
  const [files, setFiles] = useState([]);
  const [coverId, setCoverId] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [draggingStickerId, setDraggingStickerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [publishPhase, setPublishPhase] = useState('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [uploadMap, setUploadMap] = useState({});
  const [activeSession, setActiveSession] = useState(null);
  const [result, setResult] = useState(null);
  const [backendPublishState, setBackendPublishState] = useState(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const hasGoogleLogin = Boolean(googleAuth.user?.sub);
  const buildLoginRedirectUrl = useCallback(() => {
    const nextPath = `${window.location.pathname || '/'}${window.location.search || ''}`;
    const loginUrl = new URL(loginPath, window.location.origin);
    loginUrl.searchParams.set('next', nextPath);
    return `${loginUrl.pathname}${loginUrl.search}`;
  }, [loginPath]);
  const redirectToLogin = useCallback(
    (reason = 'Sessão ausente. Redirecionando para login...') => {
      if (authRedirecting) return;
      setAuthRedirecting(true);
      setStatus(reason);
      setError('');
      window.location.assign(buildLoginRedirectUrl());
    },
    [authRedirecting, buildLoginRedirectUrl],
  );

  const canStep2 = useMemo(() => sanitizePackName(name, limits.pack_name_max_length).length > 0 && hasGoogleLogin && googleSessionChecked && !authRedirecting, [name, limits.pack_name_max_length, hasGoogleLogin, googleSessionChecked, authRedirecting]);
  const canStep3 = useMemo(() => files.length > 0, [files.length]);
  const publishReady = canStep2 && canStep3 && !busy;
  const completionPercentage = Math.round((step / STEPS.length) * 100);
  const failedUploadsCount = useMemo(() => files.reduce((acc, item) => (uploadMap[item.id]?.status === 'error' ? acc + 1 : acc), 0), [files, uploadMap]);
  const pendingUploadsCount = useMemo(() => files.reduce((acc, item) => (uploadMap[item.id]?.status === 'done' ? acc : acc + 1), 0), [files, uploadMap]);
  const hasPartialUploadedSession = Boolean(activeSession?.packKey && pendingUploadsCount > 0 && pendingUploadsCount < files.length);
  const backendPackStatus = String(backendPublishState?.status || result?.status || activeSession?.created?.status || '').toLowerCase();
  const publishLabel = backendPackStatus === 'failed' ? '🛠️ Reparar pack' : failedUploadsCount > 0 ? `🔁 Reenviar falhas (${failedUploadsCount})` : hasPartialUploadedSession ? '▶ Retomar envio' : '🚀 Publicar Pack';

  const suggestedFromText = useMemo(() => {
    const haystack = `${name} ${description}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const selected = new Set(tags);
    const matches = [];

    for (const tag of suggestedTags) {
      const normalizedTag = normalizeTag(tag);
      if (!normalizedTag || selected.has(normalizedTag)) continue;
      const plain = normalizedTag.replace(/-/g, ' ');
      const directMatch = haystack.includes(plain) || haystack.includes(normalizedTag);
      if (directMatch) matches.push(normalizedTag);
    }

    if (matches.length >= 5) return matches.slice(0, 5);
    const fallback = suggestedTags.map((tag) => normalizeTag(tag)).filter((tag) => tag && !selected.has(tag));
    return mergeTags(matches, fallback).slice(0, 5);
  }, [name, description, suggestedTags, tags]);

  const tagTypeaheadSuggestions = useMemo(() => {
    const query = normalizeTag(tagInput);
    if (!query) return [];

    const selected = new Set(tags);
    const startsWith = [];
    const includes = [];

    for (const tag of mergeTags(suggestedFromText, suggestedTags)) {
      if (!tag || selected.has(tag) || tag === query) continue;
      if (tag.startsWith(query)) {
        startsWith.push(tag);
        continue;
      }
      if (tag.includes(query)) {
        includes.push(tag);
      }
    }

    return [...startsWith, ...includes].slice(0, 6);
  }, [tagInput, tags, suggestedFromText, suggestedTags]);

  const preview = useMemo(() => {
    const safeName = sanitizePackName(name, limits.pack_name_max_length) || 'novopack';
    const safeDescription = clampText(description, limits.description_max_length);
    const preferredCover = files.find((item) => item.id === coverId) || files[0] || null;
    const imageFallback = files.find((item) => item.mediaKind !== 'video') || null;
    const cover = preferredCover?.mediaKind === 'video' ? imageFallback : preferredCover;
    return {
      name: safeName,
      description: safeDescription,
      publisher: clampText(publisher || 'OmniZap Creator', limits.publisher_max_length),
      coverUrl: cover?.dataUrl || 'https://iili.io/fSNGag2.png',
      stickerCount: files.length,
      visibility,
      tags: tags.slice(0, 3),
      fakeLikes: Math.max(12, files.length * 7 + 11),
      fakeOpens: Math.max(100, files.length * 55 + 70),
    };
  }, [name, description, publisher, files, coverId, visibility, limits.description_max_length, limits.pack_name_max_length, limits.publisher_max_length, tags]);

  const quality = useMemo(() => {
    const titleLength = sanitizePackName(name, limits.pack_name_max_length).length;
    const descriptionLength = clampText(description, limits.description_max_length).length;
    const titleScore = titleLength >= 6 ? 1 : titleLength >= 4 ? 0.7 : 0;
    const descriptionScore = descriptionLength >= 28 ? 1 : descriptionLength >= 14 ? 0.6 : 0;
    const tagsScore = Math.min(1, tags.length / 4);
    const stickersScore = Math.min(1, files.length / 12);
    const coverScore = coverId ? 1 : files.length ? 0.6 : 0;
    const finalScore = Math.round((titleScore * 0.28 + descriptionScore * 0.24 + tagsScore * 0.2 + stickersScore * 0.2 + coverScore * 0.08) * 100);
    if (finalScore >= 80)
      return {
        score: finalScore,
        label: 'Excelente',
        tone: 'text-emerald-300',
        bar: 'bg-emerald-400',
      };
    if (finalScore >= 60) return { score: finalScore, label: 'Bom', tone: 'text-amber-300', bar: 'bg-amber-400' };
    return {
      score: finalScore,
      label: 'Precisa melhorar',
      tone: 'text-rose-300',
      bar: 'bg-rose-400',
    };
  }, [name, description, tags.length, files.length, coverId, limits.pack_name_max_length, limits.description_max_length]);

  useEffect(() => {
    const load = async () => {
      try {
        const payload = await fetchJson(`${apiBasePath}/create-config`);
        const apiLimits = payload?.data?.limits || {};
        const apiSuggestions = payload?.data?.rules?.suggested_tags;
        setLimits((prev) => ({ ...prev, ...apiLimits }));
        if (Array.isArray(apiSuggestions) && apiSuggestions.length) {
          setSuggestedTags(mergeTags(apiSuggestions).slice(0, 20));
        }
      } catch {
        // keep default
      }
    };
    load();
  }, [apiBasePath]);

  useEffect(() => {
    let cancelled = false;
    setGoogleSessionChecked(false);

    fetchJson(googleSessionApiPath)
      .then((payload) => {
        if (cancelled) return;
        const sessionData = payload?.data || {};
        if (!sessionData?.authenticated || !sessionData?.user?.sub || !sessionData?.owner_jid) {
          setGoogleAuth({ user: null, expiresAt: '' });
          clearGoogleAuthCache();
          redirectToLogin('Sessão inválida ou expirada. Redirecionando para login...');
          return;
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
      })
      .catch(() => {
        if (cancelled) return;
        setError('Não foi possível validar sua sessão agora. Recarregue a página.');
      })
      .finally(() => {
        if (cancelled) return;
        setGoogleSessionChecked(true);
      });

    return () => {
      cancelled = true;
    };
  }, [googleSessionApiPath, redirectToLogin]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CREATE_PACK_DRAFT_KEY);
      if (!raw) {
        setDraftLoaded(true);
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        setDraftLoaded(true);
        return;
      }

      const restoredName = typeof parsed.name === 'string' ? sanitizePackNameInput(parsed.name, DEFAULT_LIMITS.pack_name_max_length) : '';
      if (restoredName) setName(restoredName);
      if (typeof parsed.description === 'string') setDescription(parsed.description);
      if (typeof parsed.publisher === 'string') setPublisher(parsed.publisher);
      if (typeof parsed.visibility === 'string') setVisibility(parsed.visibility);
      if (Array.isArray(parsed.tags)) setTags(mergeTags(parsed.tags).slice(0, MAX_MANUAL_TAGS));
      const parsedStep = Number.isFinite(Number(parsed.step)) ? Math.max(1, Math.min(3, Number(parsed.step))) : 1;

      let restoredCount = 0;
      if (Array.isArray(parsed.files)) {
        const restored = parsed.files
          .filter((item) => item && typeof item.dataUrl === 'string' && typeof item.name === 'string')
          .map((item) => ({
            id: String(item.id || `${__timeNowMs()}-${Math.random().toString(36).slice(2, 9)}`),
            file: {
              name: String(item.name || 'sticker.webp'),
              size: Number(item.size || 0),
              type: String(item.type || 'image/webp'),
            },
            hash: /^[a-f0-9]{64}$/.test(String(item.hash || '').toLowerCase()) ? String(item.hash || '').toLowerCase() : '',
            mediaKind:
              String(item.type || '')
                .toLowerCase()
                .startsWith('video/') ||
              String(item.name || '')
                .toLowerCase()
                .match(/\.(mp4|webm|mov|m4v)$/i)
                ? 'video'
                : 'image',
            dataUrl: String(item.dataUrl),
          }));

        if (restored.length) {
          restoredCount = restored.length;
          setFiles(restored.slice(0, DEFAULT_LIMITS.stickers_per_pack));
          setUploadMap(
            restored.reduce((acc, item) => {
              acc[item.id] = { status: 'idle', progress: 0, name: item.file.name };
              return acc;
            }, {}),
          );
          const restoredCoverId = String(parsed.coverId || '');
          setCoverId(restored.find((item) => item.id === restoredCoverId)?.id || restored[0].id);
        }
      }
      if (parsed?.activeSession && typeof parsed.activeSession === 'object') {
        const packKey = String(parsed.activeSession.packKey || '').trim();
        const editToken = String(parsed.activeSession.editToken || '').trim();
        if (packKey && editToken) {
          setActiveSession({
            packKey,
            editToken,
            webUrl: String(parsed.activeSession.webUrl || '').trim() || null,
            created: parsed.activeSession.created && typeof parsed.activeSession.created === 'object' ? parsed.activeSession.created : null,
          });
        }
      }

      const normalizedStep = restoredCount === 0 ? Math.min(2, parsedStep) : parsedStep;
      setStep(normalizedStep);
      if (restoredCount > 0 || restoredName) {
        setStatus('Rascunho restaurado automaticamente.');
      }
    } catch {
      // ignore invalid drafts
    } finally {
      setDraftLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!draftLoaded || busy) return;

    const serializable = {
      step,
      name,
      description,
      publisher,
      visibility,
      tags,
      coverId,
      activeSession: activeSession?.packKey && activeSession?.editToken ? activeSession : null,
      files: files.map((item) => ({
        id: item.id,
        name: item?.file?.name || 'sticker.webp',
        size: Number(item?.file?.size || 0),
        type: String(item?.file?.type || 'image/webp'),
        hash: String(item?.hash || ''),
        dataUrl: item.dataUrl,
      })),
      updatedAt: __timeNowMs(),
    };

    try {
      const raw = JSON.stringify(serializable);
      if (raw.length <= CREATE_PACK_DRAFT_MAX_CHARS) {
        localStorage.setItem(CREATE_PACK_DRAFT_KEY, raw);
      } else {
        const lighter = {
          ...serializable,
          step: Math.min(2, Number(serializable.step || 1)),
          coverId: '',
          files: [],
        };
        localStorage.setItem(CREATE_PACK_DRAFT_KEY, JSON.stringify(lighter));
      }
    } catch {
      // ignore storage errors
    }
  }, [draftLoaded, busy, step, name, description, publisher, visibility, tags, coverId, files, activeSession]);

  useEffect(() => {
    if (!draftLoaded) return;
    if (files.length > 0) return;
    try {
      const rawTask = localStorage.getItem(PACK_UPLOAD_TASK_KEY);
      if (!rawTask) return;
      const task = JSON.parse(rawTask);
      const statusValue = String(task?.status || '').toLowerCase();
      if (statusValue !== 'paused') return;
      localStorage.removeItem(PACK_UPLOAD_TASK_KEY);
      setStatus((prev) => prev || 'Envio pausado anterior foi limpo. Selecione os stickers novamente para continuar.');
    } catch {
      // ignore
    }
  }, [draftLoaded, files.length]);

  useEffect(() => {
    if (!draftLoaded || busy) return;
    if (!activeSession?.packKey || !activeSession?.editToken) return;

    let cancelled = false;
    const syncBackendPublishState = async () => {
      try {
        const response = await fetch(`${apiBasePath}/${encodeURIComponent(activeSession.packKey)}/publish-state`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ edit_token: activeSession.editToken }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || cancelled) return;

        const publishState = payload?.data || null;
        const packData = payload?.pack || null;
        if (!publishState || typeof publishState !== 'object') return;

        setBackendPublishState(publishState);
        if (packData && packData.pack_key) {
          setResult((prev) => (prev?.pack_key === packData.pack_key ? { ...prev, ...packData } : prev || packData));
        }

        const uploads = Array.isArray(publishState.uploads) ? publishState.uploads : [];
        const uploadsById = new Map(uploads.map((entry) => [String(entry.upload_id || ''), entry]));
        const uploadsByHash = new Map(uploads.filter((entry) => entry?.sticker_hash).map((entry) => [String(entry.sticker_hash || ''), entry]));

        setUploadMap((prev) => {
          const next = { ...prev };
          for (const item of files) {
            const match = uploadsById.get(String(item.id || '')) || (item.hash ? uploadsByHash.get(String(item.hash || '')) : null);
            if (!match) continue;
            const remoteStatus = String(match.status || '').toLowerCase();
            if (remoteStatus === 'done') {
              next[item.id] = {
                ...(next[item.id] || {}),
                status: 'done',
                progress: 100,
                error: '',
              };
            } else if (remoteStatus === 'failed') {
              next[item.id] = {
                ...(next[item.id] || {}),
                status: 'error',
                progress: 0,
                error: String(match.error_message || 'Falha anterior no upload.'),
              };
            } else if (remoteStatus === 'processing') {
              next[item.id] = {
                ...(next[item.id] || {}),
                status: 'uploading',
                progress: Number(next[item.id]?.progress || 0),
                error: '',
              };
            }
          }
          return next;
        });

        const doneCount = files.reduce((acc, item) => {
          const match = uploadsById.get(String(item.id || '')) || (item.hash ? uploadsByHash.get(String(item.hash || '')) : null);
          return acc + (String(match?.status || '').toLowerCase() === 'done' ? 1 : 0);
        }, 0);

        setProgress({
          current: doneCount,
          total: Math.max(files.length, Number(publishState?.consistency?.total_uploads || 0), files.length ? 0 : 0),
        });

        const realStatus = String(publishState.status || '').toLowerCase();
        if (realStatus === PACK_STATUS_PUBLISHED) {
          clearCreatePackStorage();
          setActiveSession(null);
          setPublishPhase('idle');
          setError('');
          setStatus('Pack já foi publicado no backend. Rascunho local limpo.');
          return;
        }

        if (realStatus === 'failed') {
          setStatus('Pack com falha no backend. Use "Reparar pack" para retomar o fluxo.');
          return;
        }

        if (realStatus === 'processing') {
          setStatus('Pack em processamento/finalização. Você pode tentar publicar novamente para concluir.');
          return;
        }

        if (realStatus === 'draft' || realStatus === 'uploading') {
          setStatus('Rascunho sincronizado com o backend. Você pode retomar o envio com segurança.');
        }
      } catch {
        // mantém estado local se backend estiver indisponível
      }
    };

    syncBackendPublishState();
    return () => {
      cancelled = true;
    };
  }, [draftLoaded, busy, activeSession, apiBasePath, files]);

  const addIncomingFiles = async (incoming) => {
    const raw = Array.from(incoming || []).filter(Boolean);
    if (!raw.length) return;

    const filtered = raw.filter((file) => {
      const lowerName = String(file.name || '').toLowerCase();
      const lowerType = String(file.type || '').toLowerCase();
      const isImage = lowerType.startsWith('image/');
      const isVideo = lowerType.startsWith('video/') || lowerName.endsWith('.mp4') || lowerName.endsWith('.webm') || lowerName.endsWith('.mov') || lowerName.endsWith('.m4v');
      if (!isImage && !isVideo) return false;
      const maxBytes = Number(limits.sticker_upload_source_max_bytes || 0);
      return Number(file.size || 0) <= maxBytes;
    });

    if (!filtered.length) {
      setError(`Envie imagem ou vídeo até ${toBytesLabel(limits.sticker_upload_source_max_bytes)}. O sistema converte automaticamente para webp.`);
      return;
    }

    const availableSlots = Math.max(0, Number(limits.stickers_per_pack || 30) - files.length);
    const selected = filtered.slice(0, availableSlots);
    if (!selected.length) {
      setError(`Seu pack pode ter até ${limits.stickers_per_pack} stickers.`);
      return;
    }

    setError('');
    const mapped = await Promise.all(
      selected.map(async (file) => {
        const dataUrl = await fileToDataUrl(file);
        return {
          id: `${__timeNowMs()}-${Math.random().toString(36).slice(2, 9)}`,
          file,
          hash: await computeDataUrlSha256(dataUrl),
          mediaKind:
            String(file.type || '')
              .toLowerCase()
              .startsWith('video/') ||
            String(file.name || '')
              .toLowerCase()
              .match(/\.(mp4|webm|mov|m4v)$/i)
              ? 'video'
              : 'image',
          dataUrl,
        };
      }),
    );

    setFiles((prev) => [...prev, ...mapped].slice(0, limits.stickers_per_pack));
    setUploadMap((prev) => {
      const next = { ...prev };
      for (const item of mapped) {
        next[item.id] = { status: 'idle', progress: 0, name: item.file.name };
      }
      return next;
    });

    if (!coverId && mapped[0]?.id) {
      setCoverId(mapped[0].id);
    }
  };

  const onDropUpload = async (event) => {
    event.preventDefault();
    setDragActive(false);
    await addIncomingFiles(event.dataTransfer?.files || []);
  };

  const removeSticker = (id) => {
    setFiles((prev) => {
      const next = prev.filter((item) => item.id !== id);
      if (id === coverId) {
        setCoverId(next[0]?.id || '');
      }
      return next;
    });
    setUploadMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const reorderStickers = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    setFiles((prev) => {
      const fromIndex = prev.findIndex((item) => item.id === fromId);
      const toIndex = prev.findIndex((item) => item.id === toId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const clone = [...prev];
      const [moved] = clone.splice(fromIndex, 1);
      clone.splice(toIndex, 0, moved);
      return clone;
    });
  };

  const publishPack = async () => {
    const finalName = sanitizePackName(name, limits.pack_name_max_length);
    const finalPublisher = clampText(publisher || 'OmniZap Creator', limits.publisher_max_length);
    const finalDescription = clampText(description, limits.description_max_length);

    if (!finalName) {
      setError('Informe um nome válido para o pack.');
      setStep(1);
      return;
    }
    if (!hasGoogleLogin) {
      redirectToLogin('Sua sessão expirou. Redirecionando para login...');
      setStep(1);
      return;
    }
    if (!files.length) {
      setError('Adicione ao menos 1 sticker para publicar.');
      setStep(2);
      return;
    }

    setBusy(true);
    setError('');
    setBackendPublishState((prev) => prev || null);
    const doneBeforeRun = files.reduce((acc, item) => (uploadMap[item.id]?.status === 'done' ? acc + 1 : acc), 0);
    setProgress({ current: doneBeforeRun, total: files.length });
    let session = activeSession;

    try {
      if (!session?.packKey || !session?.editToken) {
        setPublishPhase('creating');
        setStatus('Criando pack...');
        writeUploadTask({
          status: 'running',
          title: 'Publicando pack',
          phase: 'creating',
          current: doneBeforeRun,
          total: files.length,
          progress: Math.round((doneBeforeRun / Math.max(1, files.length)) * 100),
          packKey: null,
          packUrl: null,
          message: 'Criando pack...',
        });

        const createResponse = await fetch(`${apiBasePath}/create`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            name: finalName,
            publisher: finalPublisher,
            description: finalDescription,
            tags,
            visibility,
          }),
        });

        const createPayload = await createResponse.json().catch(() => ({}));
        if (createResponse.status === 401 || createResponse.status === 403) {
          redirectToLogin('Sua sessão expirou. Redirecionando para login...');
        }
        if (!createResponse.ok) throw new Error(createPayload?.error || 'Não foi possível criar o pack.');

        const created = createPayload?.data || {};
        const editToken = String(createPayload?.meta?.edit_token || '').trim();
        const packKey = String(created?.pack_key || '').trim();
        if (!editToken || !packKey) throw new Error('Resposta de criação inválida.');
        session = {
          packKey,
          editToken,
          webUrl: created?.web_url || `${webPath}/${packKey}`,
          created,
        };
        setActiveSession(session);
        setResult(created);
        setBackendPublishState((prev) => ({
          ...(prev || {}),
          pack_key: packKey,
          status: String(created?.status || 'draft').toLowerCase(),
        }));
      }

      const pendingFiles = files.filter((item) => uploadMap[item.id]?.status !== 'done');
      let processed = doneBeforeRun;
      let failedCount = 0;

      if (pendingFiles.length > 0) {
        setPublishPhase('uploading');
        setStatus('Enviando stickers...');
        writeUploadTask({
          status: 'running',
          title: 'Publicando pack',
          phase: 'uploading',
          current: doneBeforeRun,
          total: files.length,
          progress: Math.round((doneBeforeRun / Math.max(1, files.length)) * 100),
          packKey: session.packKey,
          packUrl: session.webUrl,
          message: 'Enviando stickers...',
        });
        setUploadMap((prev) => {
          const next = { ...prev };
          for (const item of pendingFiles) {
            next[item.id] = {
              ...(next[item.id] || {}),
              status: 'uploading',
              progress: 0,
              error: '',
            };
          }
          return next;
        });

        await runAsyncQueue(
          pendingFiles,
          async (item) => {
            let effectiveHash = String(item.hash || '');
            if (!effectiveHash) {
              effectiveHash = await computeDataUrlSha256(item.dataUrl);
              if (effectiveHash) {
                setFiles((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, hash: effectiveHash } : entry)));
              }
            }

            const effectiveItem = effectiveHash && effectiveHash !== item.hash ? { ...item, hash: effectiveHash } : item;

            try {
              const uploadPayload = await uploadStickerWithRetry({
                apiBasePath,
                packKey: session.packKey,
                editToken: session.editToken,
                item: effectiveItem,
                setCover: effectiveItem.id === coverId,
                onProgress: (percentage) => {
                  setUploadMap((prev) => ({
                    ...prev,
                    [effectiveItem.id]: {
                      ...(prev[effectiveItem.id] || {}),
                      status: 'uploading',
                      progress: percentage,
                      error: '',
                    },
                  }));
                  writeUploadTask({
                    status: 'running',
                    title: 'Publicando pack',
                    phase: 'uploading',
                    current: processed,
                    total: files.length,
                    progress: Math.round(((processed + percentage / 100) / Math.max(1, files.length)) * 100),
                    packKey: session.packKey,
                    packUrl: session.webUrl,
                    message: `Enviando ${effectiveItem.file.name}`,
                  });
                },
              });

              setUploadMap((prev) => ({
                ...prev,
                [effectiveItem.id]: {
                  ...(prev[effectiveItem.id] || {}),
                  status: 'done',
                  progress: 100,
                  error: '',
                },
              }));

              const remotePackStatus = String(uploadPayload?.data?.pack_status || '').toLowerCase();
              if (remotePackStatus) {
                setBackendPublishState((prev) => ({
                  ...(prev || {}),
                  pack_key: session.packKey,
                  status: remotePackStatus,
                }));
              }
            } catch (err) {
              failedCount += 1;
              setUploadMap((prev) => ({
                ...prev,
                [effectiveItem.id]: {
                  ...(prev[effectiveItem.id] || {}),
                  status: 'error',
                  progress: 0,
                  error: err?.message || 'Falha de upload',
                },
              }));
            } finally {
              processed += 1;
              setProgress({ current: processed, total: files.length });
              writeUploadTask({
                status: 'running',
                title: 'Publicando pack',
                phase: 'uploading',
                current: processed,
                total: files.length,
                progress: Math.round((processed / Math.max(1, files.length)) * 100),
                packKey: session.packKey,
                packUrl: session.webUrl,
                message: processed >= files.length ? 'Preparando finalização...' : 'Processando próximo sticker...',
              });
            }
          },
          FIXED_UPLOAD_QUEUE_CONCURRENCY,
        );
      }

      if (failedCount > 0) {
        setPublishPhase('idle');
        setStatus(`Upload concluído com ${failedCount} falha(s).`);
        setError(`Alguns stickers falharam. Clique em "🚀 Publicar Pack" novamente para reenviar apenas as falhas.`);
        setResult((prev) => prev || session.created || null);
        setBackendPublishState((prev) => ({
          ...(prev || {}),
          pack_key: session.packKey,
          status: 'draft',
        }));
        setStep(3);
        writeUploadTask({
          status: 'error',
          title: 'Publicação parcial',
          phase: 'uploading',
          current: Number(processed || 0),
          total: Number(files.length || 0),
          progress: Math.round((Number(processed || 0) / Math.max(1, Number(files.length || 1))) * 100),
          packKey: session.packKey,
          packUrl: session.webUrl,
          message: `${failedCount} sticker(s) falharam no upload.`,
        });
        return;
      }

      setPublishPhase('processing');
      setStatus('Processando stickers...');
      writeUploadTask({
        status: 'running',
        title: 'Publicando pack',
        phase: 'processing',
        current: Number(files.length || 0),
        total: Number(files.length || 0),
        progress: 100,
        packKey: session.packKey,
        packUrl: session.webUrl,
        message: 'Validando consistência do pack...',
      });

      setPublishPhase('publishing');
      setStatus('Publicando pack...');
      const finalizeResponse = await fetch(`${apiBasePath}/${encodeURIComponent(session.packKey)}/finalize`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ edit_token: session.editToken }),
      });
      const finalizePayload = await finalizeResponse.json().catch(() => ({}));
      if (finalizeResponse.status === 409) {
        const publishState = finalizePayload?.data?.publish_state || null;
        const packFromFinalize = finalizePayload?.data?.pack || session.created || null;
        if (publishState) setBackendPublishState(publishState);
        if (packFromFinalize) setResult(packFromFinalize);
        setPublishPhase('idle');
        setStatus('Pack ficou em rascunho aguardando correções.');
        setError(finalizePayload?.error || 'Finalize recusado: o pack ainda não está consistente.');
        writeUploadTask({
          status: 'error',
          title: 'Finalize pendente',
          phase: 'finalize',
          current: Number(files.length || 0),
          total: Number(files.length || 0),
          progress: 100,
          packKey: session.packKey,
          packUrl: session.webUrl,
          message: finalizePayload?.error || 'Pack ainda não pode ser publicado.',
        });
        setStep(3);
        return;
      }
      if (!finalizeResponse.ok) {
        throw new Error(finalizePayload?.error || 'Falha ao finalizar publicação do pack.');
      }

      const finalizeData = finalizePayload?.data || {};
      const publishedPack = finalizeData?.pack || session.created || result;
      const publishState = finalizeData?.publish_state || null;
      if (publishState) setBackendPublishState(publishState);
      setStatus('Pack publicado com sucesso.');
      setResult(publishedPack);
      setStep(3);
      setPublishPhase('idle');
      setActiveSession(null);
      clearCreatePackStorage();
      writeUploadTask({
        status: 'done',
        title: 'Pack publicado',
        phase: 'published',
        current: Number(files.length || 0),
        total: Number(files.length || 0),
        progress: 100,
        packKey: session.packKey,
        packUrl: session.webUrl,
        message: 'Pack publicado com sucesso.',
      });
    } catch (err) {
      setPublishPhase('idle');
      setError(err?.message || 'Falha ao publicar pack.');
      setStatus('');
      writeUploadTask({
        status: 'error',
        title: 'Falha na publicação',
        phase: publishPhase || 'unknown',
        current: Number(progress.current || 0),
        total: Number(progress.total || files.length || 0),
        progress: Math.round((Number(progress.current || 0) / Math.max(1, Number(progress.total || files.length || 1))) * 100),
        packKey: session?.packKey || activeSession?.packKey || result?.pack_key || null,
        packUrl: session?.webUrl || activeSession?.webUrl || result?.web_url || null,
        message: err?.message || 'Falha ao publicar pack.',
      });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onBeforeUnload = () => {
      if (!busy) return;
      writeUploadTask({
        status: 'paused',
        title: 'Publicação pausada',
        current: Number(progress.current || 0),
        total: Number(progress.total || files.length || 0),
        progress: Math.round((Number(progress.current || 0) / Math.max(1, Number(progress.total || files.length || 1))) * 100),
        packKey: activeSession?.packKey || result?.pack_key || null,
        packUrl: activeSession?.webUrl || result?.web_url || null,
        message: 'Você saiu da tela durante o envio.',
      });
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy, progress.current, progress.total, files.length, result, activeSession]);

  const nextStep = () => {
    if (step === 1 && !canStep2) {
      if (!sanitizePackName(name, limits.pack_name_max_length).length) {
        setError('Defina um nome para avançar.');
        return;
      }
      if (!googleSessionChecked) {
        setError('Validando sua sessão. Aguarde alguns segundos...');
        return;
      }
      redirectToLogin('Sessão não encontrada. Redirecionando para login...');
      return;
    }
    if (step === 2 && !canStep3) {
      setError('Adicione stickers para avançar.');
      return;
    }
    setError('');
    setStep((prev) => Math.min(3, prev + 1));
  };

  const prevStep = () => {
    setError('');
    setStep((prev) => Math.max(1, prev - 1));
  };

  const restartCreateFlow = () => {
    if (busy) return;
    const confirmed = window.confirm('Recomeçar a criação? Isso vai limpar o rascunho local e o progresso salvo neste dispositivo.');
    if (!confirmed) return;

    clearCreatePackStorage();
    setStep(1);
    setName('');
    setDescription('');
    setPublisher('');
    setVisibility('public');
    setTags([]);
    setTagInput('');
    setFiles([]);
    setCoverId('');
    setDragActive(false);
    setDraggingStickerId('');
    setStatus('Criação reiniciada. Dados locais foram limpos.');
    setError('');
    setPublishPhase('idle');
    setProgress({ current: 0, total: 0 });
    setUploadMap({});
    setActiveSession(null);
    setResult(null);
    setBackendPublishState(null);
  };

  const addTag = (rawValue) => {
    const normalized = normalizeTag(rawValue);
    if (!normalized) return;
    setTags((prev) => {
      if (prev.includes(normalized) || prev.length >= MAX_MANUAL_TAGS) return prev;
      return [...prev, normalized];
    });
    setTagInput('');
  };

  const removeTag = (value) => {
    const normalized = normalizeTag(value);
    setTags((prev) => prev.filter((entry) => entry !== normalized));
  };

  const onTagInputKeyDown = (event) => {
    if (event.key === 'Tab' && !event.shiftKey && tagInput.trim() && tagTypeaheadSuggestions.length) {
      event.preventDefault();
      addTag(tagTypeaheadSuggestions[0]);
      return;
    }
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag(tagInput);
      return;
    }
    if (event.key === 'Backspace' && !tagInput.trim()) {
      const last = tags[tags.length - 1];
      if (last) removeTag(last);
    }
  };

  const visibilityHelp = visibility === 'private' ? 'Privado: apenas você acessa este pack.' : visibility === 'unlisted' ? 'Não listado: acesso por link direto.' : 'Público: aparece no catálogo para descoberta.';

  const uploadProgressTotal = Math.max(0, Number(progress.total || files.length || 0));
  const uploadProgressDone = Math.max(0, Math.min(uploadProgressTotal || 0, Number(progress.current || 0)));
  const uploadProgressPercent = Math.max(0, Math.min(100, Math.round((uploadProgressDone / Math.max(1, uploadProgressTotal || 1)) * 100)));
  const uploadHasFailures = failedUploadsCount > 0;
  const backendStateFailed = backendPackStatus === 'failed';
  const publishCompleted = Boolean(result && String(backendPackStatus || result?.status || '').toLowerCase() === PACK_STATUS_PUBLISHED && !busy);
  const showUploadProgressCard = step === 3 && busy;
  const showUploadFailureCard = step === 3 && !busy && (uploadHasFailures || backendStateFailed);
  const publishedPackUrl = String(result?.web_url || activeSession?.webUrl || '').trim() || (result?.pack_key ? `${webPath}/${encodeURIComponent(String(result.pack_key || ''))}` : '');
  const finalStepPrimaryLabel = publishCompleted ? '👁 Ver pack criado' : publishLabel;
  const mobilePrimaryActionLabel = step < 3 ? 'Continuar' : finalStepPrimaryLabel;
  const mobilePrimaryActionClass = step < 3 ? 'bg-accent text-slate-900' : 'bg-accent2 text-slate-900';
  const toggleMobilePreview = () => setMobilePreviewOpen((prev) => !prev);
  const openCreatedPack = () => {
    if (!publishedPackUrl) return;
    window.location.assign(publishedPackUrl);
  };
  const handleFinalStepPrimaryAction = () => {
    if (publishCompleted) {
      openCreatedPack();
      return;
    }
    publishPack();
  };
  const finalStepPrimaryDisabled = publishCompleted ? !publishedPackUrl : !publishReady;

  return html`
    <div className="min-h-screen bg-gradient-to-b from-[#0a0f15] via-[#0d1219] to-[#0e141a]">
      <div className="mx-auto w-full max-w-7xl px-4 pb-32 pt-4 md:px-6 md:pb-10 md:pt-5">
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3 md:mb-6 md:items-center">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[.15em] text-accent">OmniZap Studio</p>
            <h1 className="font-display text-2xl font-extrabold leading-tight md:text-4xl">Criar novo Pack</h1>
            <p className="mt-1 text-xs text-slate-400 md:text-sm">Fluxo guiado para montar e publicar seu pack com visual de marketplace.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5 text-[11px] font-semibold md:gap-2">
            <span className="hidden rounded-full border border-line/60 bg-panel/70 px-3 py-1 sm:inline-flex">🧩 Até ${limits.stickers_per_pack} stickers</span>
            <span className="hidden rounded-full border border-line/60 bg-panel/70 px-3 py-1 sm:inline-flex">📦 Até ${limits.packs_per_owner} packs</span>
            <span className="hidden rounded-full border border-line/60 bg-panel/70 px-3 py-1 md:inline-flex">✍ ${limits.pack_name_max_length} caracteres no nome</span>
            <button type="button" onClick=${restartCreateFlow} disabled=${busy} className="h-8 rounded-full border border-line/70 bg-panel/70 px-3 text-[11px] font-semibold text-slate-200 disabled:opacity-60" title="Limpar rascunho local e recomeçar">Recomeçar</button>
          </div>
        </header>

        <div className="mb-3 grid grid-cols-3 gap-2 md:mb-5">${STEPS.map((item) => html`<${StepPill} key=${item.id} step=${item} active=${step === item.id} done=${step > item.id} />`)}</div>
        <div className="mb-4 md:mb-6">
          <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-slate-400">
            <span>Progresso</span>
            <span>${completionPercentage}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-900/70 md:h-2">
            <div className="h-full bg-accent transition-all duration-300" style=${{ width: `${completionPercentage}%` }}></div>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(340px,1.1fr)_minmax(320px,.9fr)] lg:gap-4">
          <section className="min-w-0 rounded-2xl border border-line/70 bg-panel/85 p-3 shadow-none md:rounded-3xl md:border-line md:bg-panel md:p-5 md:shadow-panel">
            ${step === 1
              ? html`
                  <div className="space-y-3 md:space-y-4">
                    <${FloatingField} label="Nome do pack" value=${name} maxLength=${limits.pack_name_max_length} hint="Use um nome curto e fácil de encontrar." onChange=${(e) => setName(sanitizePackNameInput(e.target.value, limits.pack_name_max_length))} />
                    <${FloatingField} label="Descrição" value=${description} multiline=${true} maxLength=${limits.description_max_length} hint="Explique o tema do pack em uma frase curta" onChange=${(e) => setDescription(clampInputText(e.target.value, limits.description_max_length))} />
                    <${FloatingField} label="Autor" value=${publisher} maxLength=${limits.publisher_max_length} hint="Como seu nome será exibido no catálogo." onChange=${(e) => setPublisher(clampInputText(e.target.value, limits.publisher_max_length))} />
                    <div className="rounded-2xl border border-line/70 bg-panel/70 p-3 md:p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[.08em] text-slate-400">Sessão da conta</p>
                          <p className="mt-1 text-sm font-semibold text-slate-100">Conta Google vinculada</p>
                          <p className="mt-1 text-xs text-slate-400">${googleSessionChecked ? 'Sua sessão foi validada para criar packs.' : 'Validando sua sessão para liberar a criação.'}</p>
                        </div>
                        ${hasGoogleLogin ? html`<span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">Conectado</span>` : html`<span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-semibold text-amber-300">Validando</span>`}
                      </div>
                      <div className="mt-3 rounded-xl border border-line/70 bg-panelSoft/80 p-2.5 md:p-3">
                        <p className="truncate text-sm font-semibold text-slate-100">${googleAuth.user?.name || 'Conta Google'}</p>
                        <p className="truncate text-xs text-slate-400">${googleAuth.user?.email || 'Sessão será validada automaticamente.'}</p>
                      </div>
                    </div>
                    <label className="block">
                      <span className="mb-2 inline-block text-xs font-semibold text-slate-300">Tags do pack</span>
                      <div className="rounded-2xl border border-line/70 bg-panelSoft/80 px-3 py-3">
                        <div className="mb-2 flex flex-wrap gap-2">
                          ${tags.map(
                            (tag) => html`
                              <button key=${tag} type="button" onClick=${() => removeTag(tag)} className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent" title="Remover tag">
                                #${tag}
                                <span aria-hidden="true">×</span>
                              </button>
                            `,
                          )}
                        </div>
                        <input type="text" value=${tagInput} maxlength=${40} onInput=${(e) => setTagInput(String(e.target.value || ''))} onKeyDown=${onTagInputKeyDown} onBlur=${() => addTag(tagInput)} placeholder=${tags.length >= MAX_MANUAL_TAGS ? `Limite de ${MAX_MANUAL_TAGS} tags` : 'Digite e pressione Enter para adicionar'} disabled=${tags.length >= MAX_MANUAL_TAGS} className="h-11 w-full rounded-xl border border-line/70 bg-panel/80 px-3 text-sm outline-none transition focus:border-accent/60 disabled:opacity-60" />
                        ${tagInput.trim() && tags.length < MAX_MANUAL_TAGS && tagTypeaheadSuggestions.length
                          ? html`
                              <div className="mt-2 rounded-xl border border-line/70 bg-panel/70 p-2">
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <p className="text-[10px] font-semibold uppercase tracking-[.08em] text-slate-400">Sugestões</p>
                                  <p className="text-[10px] text-slate-500">Tab completa a primeira</p>
                                </div>
                                <div className="flex flex-wrap gap-1.5">${tagTypeaheadSuggestions.map((tag) => html` <button key=${`typeahead-${tag}`} type="button" onMouseDown=${(e) => e.preventDefault()} onClick=${() => addTag(tag)} className="rounded-full border border-accent/35 bg-accent/10 px-2 py-1 text-[10px] font-semibold text-accent transition hover:border-accent/60">#${tag}</button> `)}</div>
                              </div>
                            `
                          : null}
                        <p className="mt-2 text-[11px] text-slate-400">${tags.length}/${MAX_MANUAL_TAGS} tags selecionadas.</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">${suggestedFromText.map((tag) => html` <button key=${tag} type="button" onMouseDown=${(e) => e.preventDefault()} onClick=${() => addTag(tag)} className="rounded-full border border-line bg-panel px-2 py-1 text-[10px] font-semibold text-slate-300 transition hover:border-accent/50 hover:text-accent">+ ${tag}</button> `)}</div>
                      </div>
                    </label>
                    <label className="block">
                      <span className="mb-2 inline-block text-xs font-semibold text-slate-300">Visibilidade</span>
                      <select value=${visibility} onChange=${(e) => setVisibility(String(e.target.value || 'public'))} className="h-11 w-full rounded-2xl border border-line/70 bg-panelSoft/80 px-4 text-sm outline-none focus:border-accent/60 md:h-12">
                        <option value="public">Público</option>
                        <option value="unlisted">Não listado</option>
                        <option value="private">Privado</option>
                      </select>
                      <p className="mt-2 text-[11px] text-slate-400">${visibilityHelp}</p>
                    </label>
                  </div>
                `
              : null}
            ${step === 2
              ? html`
                  <div className="space-y-3 md:space-y-4">
                    <div
                      onDragOver=${(e) => {
                        e.preventDefault();
                        setDragActive(true);
                      }}
                      onDragLeave=${() => setDragActive(false)}
                      onDrop=${onDropUpload}
                      className=${`rounded-2xl border border-dashed p-4 text-center transition md:rounded-3xl md:border-2 md:p-6 ${dragActive ? 'border-accent bg-accent/10' : 'border-line/70 bg-panelSoft/80'}`}
                    >
                      <p className="text-sm font-bold md:text-base">Arraste e solte seus stickers aqui</p>
                      <p className="mt-1 text-xs text-slate-400">Imagens e vídeos até ${toBytesLabel(limits.sticker_upload_source_max_bytes)} cada (conversão automática para .webp)</p>
                      <input
                        id="webp-upload"
                        type="file"
                        accept="image/*,video/*"
                        multiple
                        className="hidden"
                        onChange=${async (e) => {
                          await addIncomingFiles(e.target.files || []);
                          e.target.value = '';
                        }}
                      />
                      <label for="webp-upload" className="mt-3 inline-flex h-11 cursor-pointer items-center rounded-xl bg-accent px-4 text-sm font-extrabold text-slate-900">Selecionar stickers</label>
                    </div>

                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>${files.length}/${limits.stickers_per_pack} selecionados</span>
                      <span>Arraste para reordenar • toque para definir capa</span>
                    </div>

                    ${files.length ? html` <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">${files.map((item, index) => html`<${StickerThumb} key=${item.id} item=${item} index=${index} selectedCoverId=${coverId} onSetCover=${setCoverId} onRemove=${removeSticker} onDragStart=${setDraggingStickerId} onDropOn=${(targetId) => reorderStickers(draggingStickerId, targetId)} />`)}</div> ` : html`<p className="rounded-2xl border border-line/70 bg-panelSoft/80 p-3 text-center text-sm text-slate-400 md:p-4">Nenhum sticker selecionado ainda.</p>`}
                  </div>
                `
              : null}
            ${step === 3
              ? html`
                  <div className="space-y-3 md:space-y-4">
                    <div className="rounded-2xl border border-line/70 bg-panelSoft/80 p-3 md:p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-display text-base font-bold md:text-lg">Revisão final</h3>
                          <p className="mt-0.5 text-xs text-slate-400">Confira os dados antes de publicar.</p>
                        </div>
                        <span className="rounded-full border border-line/70 bg-panel/60 px-2.5 py-1 text-[11px] font-semibold text-slate-300"> ${files.length} stickers </span>
                      </div>
                      <div className="mt-3 grid gap-1.5 text-sm text-slate-300">
                        <p className="truncate">
                          <span className="text-slate-400">Nome:</span>
                          <strong>${preview.name}</strong>
                        </p>
                        <p>
                          <span className="text-slate-400">Visibilidade:</span>
                          ${preview.visibility}
                        </p>
                        <p className="truncate text-xs text-slate-400">Autor: ${preview.publisher}</p>
                      </div>
                    </div>

                    ${showUploadProgressCard
                      ? html`
                          <div className="rounded-2xl border border-accent/25 bg-accent/5 p-3 md:p-4">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-sm font-semibold text-slate-100">${status || 'Processando publicação...'}</p>
                              <p className="text-xs font-semibold text-accent">${uploadProgressPercent}%</p>
                            </div>
                            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-900/70">
                              <div className="h-full bg-accent transition-all" style=${{ width: `${uploadProgressPercent}%` }}></div>
                            </div>
                            <p className="mt-2 text-xs text-slate-400">${publishPhase === 'creating' ? 'Criando pack...' : publishPhase === 'uploading' ? `${uploadProgressDone}/${uploadProgressTotal || files.length || 0} enviados` : publishPhase === 'processing' ? 'Validando consistência e capa do pack...' : publishPhase === 'publishing' ? 'Publicando pack no marketplace...' : `${uploadProgressDone}/${uploadProgressTotal || files.length || 0} concluídos`}</p>
                          </div>
                        `
                      : null}
                    ${showUploadFailureCard
                      ? html`
                          <div className="rounded-2xl border border-rose-400/25 bg-rose-400/5 p-3 text-sm">
                            <p className="font-semibold text-rose-200">${backendStateFailed ? 'O pack entrou em estado de falha no backend.' : `${failedUploadsCount} sticker(s) falharam no envio.`}</p>
                            <p className="mt-1 text-xs text-rose-200/80">${backendStateFailed ? `Use "${publishLabel}" para reparar e concluir a publicação.` : `Toque em "${publishLabel}" para reenviar apenas as falhas.`}</p>
                          </div>
                        `
                      : null}
                    ${publishCompleted
                      ? html`
                          <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-3 text-sm text-emerald-100 md:p-4">
                            <p className="font-bold">Pack publicado com sucesso</p>
                            <p className="mt-1">${result.name} · ${result.pack_key}</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <a href=${result.web_url || `${webPath}/${result.pack_key}`} className="inline-flex h-10 items-center rounded-lg bg-emerald-300 px-3 text-xs font-bold text-slate-900">Abrir pack</a>
                              <a href=${webPath} className="inline-flex h-10 items-center rounded-lg border border-emerald-300/30 px-3 text-xs font-bold">Voltar ao marketplace</a>
                            </div>
                          </div>
                        `
                      : null}
                  </div>
                `
              : null}
          </section>

          <aside className="hidden min-w-0 rounded-3xl border border-line/70 bg-panel/85 p-4 lg:block lg:p-5">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[.12em] text-accent">Preview em tempo real</p>
              <span className="text-[11px] font-semibold text-slate-400">Atualiza automaticamente</span>
            </div>
            <${PackPreviewPanel} preview=${preview} quality=${quality} compact=${false} />
          </aside>
        </div>

        <div className="mt-3 lg:hidden">
          <div className="rounded-2xl border border-line/70 bg-panel/80 p-3">
            <button type="button" onClick=${toggleMobilePreview} className="flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-line/70 bg-panelSoft/70 px-3 text-left" aria-expanded=${mobilePreviewOpen ? 'true' : 'false'}>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[.08em] text-slate-400">Preview</p>
                <p className="text-sm font-semibold text-slate-100">${preview.name}</p>
              </div>
              <span className="text-xs font-semibold text-accent">${mobilePreviewOpen ? 'Ocultar' : 'Mostrar'}</span>
            </button>
            ${mobilePreviewOpen
              ? html`<div className="mt-3">
                  <${PackPreviewPanel} preview=${preview} quality=${quality} compact=${true} />
                </div>`
              : html`<p className="mt-2 text-xs text-slate-400">Toque para visualizar capa, descrição e score do pack.</p>`}
          </div>
        </div>

        ${error ? html`<div className="mt-3 rounded-2xl border border-rose-400/25 bg-rose-400/5 px-3 py-2.5 text-sm text-rose-200 md:mt-4 md:px-4 md:py-3">${error}</div>` : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line/70 bg-panel/95 p-3 backdrop-blur md:hidden">
        <div className="mx-auto w-full max-w-7xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <button type="button" className="h-8 rounded-full border border-line/70 bg-panelSoft/80 px-3 text-xs font-semibold text-slate-200 disabled:opacity-60" onClick=${restartCreateFlow} disabled=${busy} title="Limpar rascunho local">Recomeçar</button>
            <button type="button" className="h-8 rounded-full border border-line/70 bg-panelSoft/60 px-3 text-xs font-semibold text-slate-300" onClick=${toggleMobilePreview} aria-expanded=${mobilePreviewOpen ? 'true' : 'false'}>${mobilePreviewOpen ? 'Ocultar preview' : 'Preview'}</button>
          </div>
          <div className="grid grid-cols-[1fr_1.45fr] gap-2">
            <button type="button" className="h-11 rounded-xl border border-line/70 bg-panelSoft/80 text-sm font-bold disabled:opacity-60" onClick=${prevStep} disabled=${step === 1 || busy}>Voltar</button>
            ${step < 3 ? html` <button type="button" className=${`h-11 rounded-xl text-sm font-extrabold disabled:opacity-60 ${mobilePrimaryActionClass}`} onClick=${nextStep} disabled=${busy}>${mobilePrimaryActionLabel}</button> ` : html` <button type="button" className=${`h-11 rounded-xl text-sm font-extrabold disabled:opacity-60 ${mobilePrimaryActionClass}`} onClick=${handleFinalStepPrimaryAction} disabled=${finalStepPrimaryDisabled}>${mobilePrimaryActionLabel}</button> `}
          </div>
        </div>
      </div>

      <div className="mt-6 hidden items-center justify-end gap-2 px-6 pb-6 md:flex">
        <button type="button" className="h-10 rounded-xl border border-line/70 bg-panelSoft/80 px-4 text-sm font-bold disabled:opacity-60" onClick=${restartCreateFlow} disabled=${busy} title="Limpar rascunho local e recomeçar">Recomeçar</button>
        <button type="button" className="h-11 rounded-xl border border-line/70 bg-panelSoft/80 px-5 text-sm font-bold" onClick=${prevStep} disabled=${step === 1 || busy}>Voltar</button>
        ${step < 3 ? html`<button type="button" className="h-11 rounded-xl bg-accent px-5 text-sm font-extrabold text-slate-900" onClick=${nextStep} disabled=${busy}>Próximo passo</button>` : html`<button type="button" className="h-11 rounded-xl bg-accent2 px-5 text-sm font-extrabold text-slate-900 disabled:opacity-60" onClick=${handleFinalStepPrimaryAction} disabled=${finalStepPrimaryDisabled}>${finalStepPrimaryLabel}</button>`}
      </div>
    </div>
  `;
}

const root = document.getElementById('create-pack-react-root');
if (root) {
  createRoot(root).render(html`<${CreatePackApp} />`);
}
