import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { createHash } from 'node:crypto';

import logger from '#logger';
import { executeQuery, TABLES } from '../../../database/index.js';

const FEATURE_FLAG_CACHE_TTL_MS = Math.max(5_000, Number(process.env.FEATURE_FLAG_CACHE_TTL_MS) || 30_000);

let cacheState = {
  loadedAt: 0,
  byName: new Map(),
  tableAvailable: true,
};

const normalizeFlagName = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, '')
    .slice(0, 120);

const toPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.floor(numeric)));
};

const toBool = (value, fallback = false) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeRow = (row) => ({
  flag_name: normalizeFlagName(row?.flag_name),
  is_enabled: toBool(row?.is_enabled, false),
  rollout_percent: toPercent(row?.rollout_percent ?? 100),
});

const resolveCohortBucket = (subjectKey) => {
  const normalized = String(subjectKey || '').trim();
  if (!normalized) return 0;
  const digest = createHash('sha256').update(normalized).digest();
  const value = digest.readUInt32BE(0);
  return value % 100;
};

const loadFlagsFromDatabase = async () => {
  const rows = await executeQuery(
    `SELECT flag_name, is_enabled, rollout_percent
     FROM ${TABLES.FEATURE_FLAG}`,
    [],
  );

  const byName = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const normalized = normalizeRow(row);
    if (!normalized.flag_name) return;
    byName.set(normalized.flag_name, normalized);
  });
  return byName;
};

export const refreshFeatureFlags = async ({ force = false } = {}) => {
  const now = __timeNowMs();
  const isFresh = now - cacheState.loadedAt < FEATURE_FLAG_CACHE_TTL_MS;
  if (!force && isFresh) return cacheState.byName;

  if (!cacheState.tableAvailable) return cacheState.byName;

  try {
    const byName = await loadFlagsFromDatabase();
    cacheState = {
      loadedAt: now,
      byName,
      tableAvailable: true,
    };
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      cacheState = {
        ...cacheState,
        tableAvailable: false,
      };
      logger.warn('Tabela de feature flags indisponível. Usando fallback por env/default.', {
        action: 'feature_flag_table_unavailable',
      });
      return cacheState.byName;
    }
    logger.warn('Falha ao carregar feature flags. Mantendo cache anterior.', {
      action: 'feature_flag_refresh_failed',
      error: error?.message,
    });
  }

  return cacheState.byName;
};

const resolveEnvFallback = (flagName, fallback) => {
  const envKey = `FEATURE_${flagName.toUpperCase()}`;
  return toBool(process.env[envKey], fallback);
};

export const isFeatureEnabled = async (flagName, { fallback = false, subjectKey = '' } = {}) => {
  const normalizedFlagName = normalizeFlagName(flagName);
  if (!normalizedFlagName) return Boolean(fallback);

  const byName = await refreshFeatureFlags();
  const entry = byName.get(normalizedFlagName);
  if (!entry) {
    return resolveEnvFallback(normalizedFlagName, fallback);
  }

  if (!entry.is_enabled) return false;
  if (entry.rollout_percent >= 100) return true;
  if (entry.rollout_percent <= 0) return false;

  const bucket = resolveCohortBucket(subjectKey || normalizedFlagName);
  return bucket < entry.rollout_percent;
};

export const getFeatureFlagsSnapshot = async () => {
  const byName = await refreshFeatureFlags();
  return Array.from(byName.values()).map((entry) => ({
    flag_name: entry.flag_name,
    is_enabled: Boolean(entry.is_enabled),
    rollout_percent: Number(entry.rollout_percent || 0),
  }));
};
