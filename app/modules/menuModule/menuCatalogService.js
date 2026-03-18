import { readFile } from 'node:fs/promises';
import path from 'node:path';
import logger from '#logger';

const DEFAULT_LOCAL_CATALOG_PATH = path.resolve(process.cwd(), 'public/comandos/commands-catalog.json');
const DEFAULT_REMOTE_CATALOG_URL = 'https://omnizap.shop/comandos/commands-catalog.json';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 2500;

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric < min) return fallback;
  return Math.max(min, Math.min(max, numeric));
};

const MENU_CATALOG_LOCAL_PATH = String(process.env.MENU_CATALOG_LOCAL_PATH || DEFAULT_LOCAL_CATALOG_PATH).trim() || DEFAULT_LOCAL_CATALOG_PATH;
const MENU_CATALOG_REMOTE_URL = String(process.env.MENU_CATALOG_REMOTE_URL || DEFAULT_REMOTE_CATALOG_URL).trim() || DEFAULT_REMOTE_CATALOG_URL;
const MENU_CATALOG_CACHE_TTL_MS = toPositiveInt(process.env.MENU_CATALOG_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 15_000, 30 * 60 * 1000);
const MENU_CATALOG_FETCH_TIMEOUT_MS = toPositiveInt(process.env.MENU_CATALOG_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS, 500, 15_000);
const MENU_CATALOG_REMOTE_ENABLED =
  String(process.env.MENU_CATALOG_REMOTE_ENABLED ?? 'true')
    .trim()
    .toLowerCase() !== 'false';

const sanitizeLogValue = (value) =>
  String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeCatalogCategories = (categories = []) =>
  categories
    .map((entry) => {
      const key = String(entry?.key || '').trim();
      const label = String(entry?.label || key || 'Categoria').trim();
      const commands = Array.isArray(entry?.commands) ? entry.commands : [];
      if (!key || !commands.length) return null;
      return {
        ...entry,
        key,
        label,
        commands,
      };
    })
    .filter(Boolean);

const parseGeneratedAtMs = (catalog = null) => {
  const parsed = Date.parse(String(catalog?.generated_at || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeCatalogPayload = (rawCatalog = null) => {
  if (!rawCatalog || typeof rawCatalog !== 'object') {
    throw new Error('catalogo_invalido: payload ausente');
  }

  const categories = normalizeCatalogCategories(rawCatalog.categories);
  if (!categories.length) {
    throw new Error('catalogo_invalido: sem categorias');
  }

  return {
    ...rawCatalog,
    categories,
  };
};

const buildSnapshot = ({ catalog, source = 'unknown' } = {}) => ({
  catalog,
  source,
  generatedAtMs: parseGeneratedAtMs(catalog),
  fetchedAtMs: Date.now(),
});

const compareSnapshots = (left, right) => {
  const leftGenerated = Number(left?.generatedAtMs || 0);
  const rightGenerated = Number(right?.generatedAtMs || 0);
  if (leftGenerated !== rightGenerated) return rightGenerated - leftGenerated;

  const priority = {
    remote: 3,
    local: 2,
    cache: 1,
  };

  return (priority[right?.source] || 0) - (priority[left?.source] || 0);
};

let catalogCache = {
  snapshot: null,
  expiresAt: 0,
};

const readLocalCatalogSnapshot = async () => {
  const text = await readFile(MENU_CATALOG_LOCAL_PATH, 'utf8');
  const parsed = JSON.parse(text);
  const catalog = normalizeCatalogPayload(parsed);
  return buildSnapshot({
    catalog,
    source: 'local',
  });
};

const fetchRemoteCatalogSnapshot = async () => {
  if (!MENU_CATALOG_REMOTE_ENABLED) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MENU_CATALOG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(MENU_CATALOG_REMOTE_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    const parsed = await response.json();
    const catalog = normalizeCatalogPayload(parsed);
    return buildSnapshot({
      catalog,
      source: 'remote',
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

export const getCommandsCatalogSnapshot = async ({ forceRefresh = false } = {}) => {
  const now = Date.now();
  if (!forceRefresh && catalogCache.snapshot && now < catalogCache.expiresAt) {
    return catalogCache.snapshot;
  }

  const localPromise = readLocalCatalogSnapshot();
  const remotePromise = MENU_CATALOG_REMOTE_ENABLED ? fetchRemoteCatalogSnapshot() : Promise.resolve(null);
  const [localResult, remoteResult] = await Promise.allSettled([localPromise, remotePromise]);

  const candidates = [];

  if (localResult.status === 'fulfilled' && localResult.value) {
    candidates.push(localResult.value);
  } else if (localResult.status === 'rejected') {
    logger.warn('Falha ao carregar catalogo local de comandos para o menu dinamico.', {
      action: 'menu_catalog_local_load_failed',
      error: sanitizeLogValue(localResult.reason?.message) || 'unknown_error',
      catalogPath: MENU_CATALOG_LOCAL_PATH,
    });
  }

  if (remoteResult.status === 'fulfilled' && remoteResult.value) {
    candidates.push(remoteResult.value);
  } else if (remoteResult.status === 'rejected') {
    logger.warn('Falha ao atualizar catalogo remoto de comandos para o menu dinamico.', {
      action: 'menu_catalog_remote_fetch_failed',
      error: sanitizeLogValue(remoteResult.reason?.message) || 'unknown_error',
      catalogUrl: MENU_CATALOG_REMOTE_URL,
    });
  }

  if (catalogCache.snapshot) {
    candidates.push({
      ...catalogCache.snapshot,
      source: 'cache',
    });
  }

  candidates.sort(compareSnapshots);
  const selectedSnapshot = candidates[0] || null;

  if (!selectedSnapshot?.catalog) {
    throw new Error('catalogo_indisponivel');
  }

  catalogCache = {
    snapshot: selectedSnapshot,
    expiresAt: now + MENU_CATALOG_CACHE_TTL_MS,
  };

  return selectedSnapshot;
};

export const resetMenuCatalogCacheForTests = () => {
  catalogCache = {
    snapshot: null,
    expiresAt: 0,
  };
};
