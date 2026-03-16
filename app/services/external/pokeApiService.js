import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import axios from 'axios';
import logger from '#logger';
import { recordPokeApiCacheHit } from '../../observability/metrics.js';

const BASE_URL = 'https://pokeapi.co/api/v2';
const MIN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_TTL_MS = Math.max(MIN_CACHE_TTL_MS, Number(process.env.POKEAPI_CACHE_TTL_MS) || MIN_CACHE_TTL_MS);
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.POKEAPI_TIMEOUT_MS) || 10_000);
const REQUEST_RETRY_ATTEMPTS = Math.max(0, Number(process.env.POKEAPI_RETRY_ATTEMPTS) || 2);
const REQUEST_RETRY_BASE_DELAY_MS = Math.max(120, Number(process.env.POKEAPI_RETRY_BASE_DELAY_MS) || 350);
const DNS_FAMILY = [0, 4, 6].includes(Number(process.env.POKEAPI_DNS_FAMILY)) ? Number(process.env.POKEAPI_DNS_FAMILY) : 4;
const REQUEST_USER_AGENT = String(process.env.POKEAPI_USER_AGENT || 'omnizap/2.1 (+https://github.com/Omnizap-System/omnizap)').trim();
const DEFAULT_LORE_LANGUAGES = String(process.env.POKEAPI_LORE_LANGS || 'pt-br,pt,en')
  .split(',')
  .map((entry) =>
    String(entry || '')
      .trim()
      .toLowerCase(),
  )
  .filter(Boolean);

const sharedCache = globalThis.__omnizapPokeApiCache instanceof Map ? globalThis.__omnizapPokeApiCache : new Map();
const sharedInflight = globalThis.__omnizapPokeApiInflight instanceof Map ? globalThis.__omnizapPokeApiInflight : new Map();

globalThis.__omnizapPokeApiCache = sharedCache;
globalThis.__omnizapPokeApiInflight = sharedInflight;

const normalizeKeyPart = (value) => {
  if (value === null || value === undefined) {
    throw new Error('Identificador inválido para recurso da PokéAPI.');
  }

  const raw = String(value).trim();
  if (!raw) {
    throw new Error('Identificador vazio para recurso da PokéAPI.');
  }

  return raw.toLowerCase();
};

export const normalizeApiText = (value) => {
  return String(value || '')
    .replace(/[\n\r\f\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const resolveEntryLang = (entry) =>
  String(entry?.language?.name || '')
    .trim()
    .toLowerCase();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const hasErrorMessage = (value) => typeof value === 'string' && value.trim().length > 0;

const extractCauseMessages = (error) => {
  const causes = Array.isArray(error?.cause?.errors) ? error.cause.errors : Array.isArray(error?.errors) ? error.errors : [];

  const messages = causes.map((entry) => String(entry?.message || '').trim()).filter(Boolean);
  return messages;
};

const summarizeRequestError = (error) => {
  const directMessage = String(error?.message || '').trim();
  const causeMessage = String(error?.cause?.message || '').trim();
  const status = Number(error?.response?.status);
  const code = String(error?.code || error?.cause?.code || '').trim() || null;
  const causeMessages = extractCauseMessages(error);

  const message = directMessage || causeMessage || causeMessages[0] || (Number.isFinite(status) ? `HTTP ${status}` : null) || (code ? `Erro de rede (${code})` : null) || 'erro-desconhecido';

  return {
    message,
    code,
    status: Number.isFinite(status) ? status : null,
    causeMessages: causeMessages.slice(0, 3),
  };
};

const isRetryableRequestError = (error) => {
  const status = Number(error?.response?.status);
  if (Number.isFinite(status)) {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
  }

  const code = String(error?.code || error?.cause?.code || '')
    .trim()
    .toUpperCase();
  if (!code) return false;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(code);
};

const calculateRetryDelay = (attempt) => {
  const exponential = REQUEST_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt);
  return Math.min(2_500, exponential + Math.floor(Math.random() * 180));
};

const pickEntryByLangPriority = (entries = [], languages = DEFAULT_LORE_LANGUAGES) => {
  const list = Array.isArray(entries) ? entries : [];
  const langPriority = (Array.isArray(languages) ? languages : DEFAULT_LORE_LANGUAGES)
    .map((entry) =>
      String(entry || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  if (!list.length) return null;
  if (!langPriority.length) return list[0] || null;

  for (const lang of langPriority) {
    const found = list.find((entry) => resolveEntryLang(entry) === lang);
    if (found) return found;
  }

  const english = list.find((entry) => resolveEntryLang(entry) === 'en');
  if (english) return english;
  return list[0] || null;
};

export const getLocalizedName = (names = [], fallback = null, languages = DEFAULT_LORE_LANGUAGES) => {
  const entry = pickEntryByLangPriority(names, languages);
  const value = normalizeApiText(entry?.name || '');
  return value || normalizeApiText(fallback || '') || null;
};

export const getLocalizedGenus = (genera = [], fallback = null, languages = DEFAULT_LORE_LANGUAGES) => {
  const entry = pickEntryByLangPriority(genera, languages);
  const value = normalizeApiText(entry?.genus || '');
  return value || normalizeApiText(fallback || '') || null;
};

export const getFlavorText = (flavorTextEntries = [], options = {}) => {
  const entries = Array.isArray(flavorTextEntries) ? flavorTextEntries : [];
  if (!entries.length) return null;

  const languages = Array.isArray(options?.languages) ? options.languages : DEFAULT_LORE_LANGUAGES;
  const preferredVersion = String(options?.version || '')
    .trim()
    .toLowerCase();
  const filtered = preferredVersion
    ? entries.filter(
        (entry) =>
          String(entry?.version?.name || '')
            .trim()
            .toLowerCase() === preferredVersion,
      )
    : entries;

  const entry = pickEntryByLangPriority(filtered.length ? filtered : entries, languages);
  const value = normalizeApiText(entry?.flavor_text || entry?.text || '');
  return value || null;
};

export const getEffectText = (effectEntries = [], options = {}) => {
  const entries = Array.isArray(effectEntries) ? effectEntries : [];
  if (!entries.length) return null;
  const languages = Array.isArray(options?.languages) ? options.languages : DEFAULT_LORE_LANGUAGES;
  const entry = pickEntryByLangPriority(entries, languages);
  const shortFirst = options?.preferLong ? false : true;
  const primary = shortFirst ? entry?.short_effect : entry?.effect;
  const fallback = shortFirst ? entry?.effect : entry?.short_effect;
  const value = normalizeApiText(primary || fallback || '');
  return value || null;
};

export const getDefaultLoreLanguages = () => [...DEFAULT_LORE_LANGUAGES];

const cleanupExpiredEntry = (key, now) => {
  const entry = sharedCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    sharedCache.delete(key);
    return null;
  }
  return entry.data;
};

const requestResource = async ({ path, cacheKey }) => {
  const now = __timeNowMs();
  const staleEntry = sharedCache.get(cacheKey);
  const staleData = staleEntry?.data || null;
  const cached = cleanupExpiredEntry(cacheKey, now);
  if (cached) {
    recordPokeApiCacheHit();
    return cached;
  }

  if (sharedInflight.has(cacheKey)) {
    return sharedInflight.get(cacheKey);
  }

  const requestPromise = (async () => {
    let lastError = null;
    const maxAttempts = Math.max(1, REQUEST_RETRY_ATTEMPTS + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await axios.get(`${BASE_URL}${path}`, {
          timeout: REQUEST_TIMEOUT_MS,
          family: DNS_FAMILY,
          headers: {
            Accept: 'application/json',
            'User-Agent': REQUEST_USER_AGENT,
          },
        });
        const data = response?.data;
        sharedCache.set(cacheKey, {
          data,
          expiresAt: __timeNowMs() + CACHE_TTL_MS,
        });
        return data;
      } catch (error) {
        lastError = error;
        const shouldRetry = attempt < maxAttempts - 1 && isRetryableRequestError(error);
        if (shouldRetry) {
          await sleep(calculateRetryDelay(attempt));
          continue;
        }
        break;
      }
    }

    const details = summarizeRequestError(lastError);
    if (staleData) {
      logger.warn('Falha ao consultar PokéAPI. Usando cache expirado.', {
        path,
        error: details.message,
        code: details.code,
        status: details.status,
        attempts: maxAttempts,
        causeMessages: details.causeMessages,
      });
      return staleData;
    }

    logger.warn('Falha ao consultar PokéAPI.', {
      path,
      error: details.message,
      code: details.code,
      status: details.status,
      attempts: maxAttempts,
      causeMessages: details.causeMessages,
    });

    if (!lastError || typeof lastError !== 'object') {
      const normalizedError = new Error(details.message);
      normalizedError.code = details.code;
      normalizedError.status = details.status;
      normalizedError.pokeApiMeta = {
        code: details.code,
        status: details.status,
        attempts: maxAttempts,
        causeMessages: details.causeMessages,
      };
      throw normalizedError;
    }

    if (!hasErrorMessage(lastError.message)) {
      lastError.message = details.message;
    }
    lastError.pokeApiMeta = {
      code: details.code,
      status: details.status,
      attempts: maxAttempts,
      causeMessages: details.causeMessages,
    };
    throw lastError;
  })().finally(() => {
    sharedInflight.delete(cacheKey);
  });

  sharedInflight.set(cacheKey, requestPromise);
  return requestPromise;
};

const getNamedResource = async (resource, idOrName) => {
  const normalized = normalizeKeyPart(idOrName);
  return requestResource({
    path: `/${resource}/${encodeURIComponent(normalized)}`,
    cacheKey: `${resource}:${normalized}`,
  });
};

export const getResourceList = async ({ resource, limit = 20, offset = 0 }) => {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const cacheKey = `list:${resource}:${safeLimit}:${safeOffset}`;
  const query = `?limit=${encodeURIComponent(String(safeLimit))}&offset=${encodeURIComponent(String(safeOffset))}`;
  return requestResource({
    path: `/${resource}${query}`,
    cacheKey,
  });
};

export const getPokemonImage = (pokemonApiResponse, options = {}) => {
  const shinyPreferred = Boolean(options?.shiny);
  if (shinyPreferred) {
    const shinyFront = pokemonApiResponse?.sprites?.front_shiny;
    if (typeof shinyFront === 'string' && shinyFront.trim()) {
      return shinyFront.trim();
    }
  }

  const officialArtwork = pokemonApiResponse?.sprites?.other?.['official-artwork']?.front_default;
  if (typeof officialArtwork === 'string' && officialArtwork.trim()) {
    return officialArtwork.trim();
  }

  const frontDefault = pokemonApiResponse?.sprites?.front_default;
  if (typeof frontDefault === 'string' && frontDefault.trim()) {
    return frontDefault.trim();
  }

  return null;
};

export const getPokemon = async (idOrName) => {
  return getNamedResource('pokemon', idOrName);
};

export const getMove = async (idOrName) => {
  return getNamedResource('move', idOrName);
};

export const getType = async (name) => {
  return getNamedResource('type', name);
};

export const getSpecies = async (id) => {
  const normalized = normalizeKeyPart(id);
  return requestResource({
    path: `/pokemon-species/${encodeURIComponent(normalized)}`,
    cacheKey: `species:${normalized}`,
  });
};

export const getEvolutionChain = async (id) => {
  return getNamedResource('evolution-chain', id);
};

export const getItem = async (idOrName) => getNamedResource('item', idOrName);

export const getItemCategory = async (idOrName) => getNamedResource('item-category', idOrName);

export const getItemPocket = async (idOrName) => getNamedResource('item-pocket', idOrName);

export const getMachine = async (idOrName) => getNamedResource('machine', idOrName);

export const getBerry = async (idOrName) => getNamedResource('berry', idOrName);

export const getBerryFlavor = async (idOrName) => getNamedResource('berry-flavor', idOrName);

export const getRegion = async (idOrName) => getNamedResource('region', idOrName);

export const getLocation = async (idOrName) => getNamedResource('location', idOrName);

export const getLocationArea = async (idOrName) => getNamedResource('location-area', idOrName);

export const getPokedex = async (idOrName) => getNamedResource('pokedex', idOrName);

export const getGeneration = async (idOrName) => getNamedResource('generation', idOrName);

export const getNature = async (idOrName) => getNamedResource('nature', idOrName);

export const getAbility = async (idOrName) => getNamedResource('ability', idOrName);

export const getCharacteristic = async (idOrName) => getNamedResource('characteristic', idOrName);

export default {
  getPokemon,
  getMove,
  getType,
  getSpecies,
  getEvolutionChain,
  getItem,
  getItemCategory,
  getItemPocket,
  getMachine,
  getBerry,
  getBerryFlavor,
  getRegion,
  getLocation,
  getLocationArea,
  getPokedex,
  getGeneration,
  getNature,
  getAbility,
  getCharacteristic,
  getLocalizedName,
  getLocalizedGenus,
  getFlavorText,
  getEffectText,
  getDefaultLoreLanguages,
  normalizeApiText,
  getResourceList,
  getPokemonImage,
};
