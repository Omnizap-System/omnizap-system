import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
export const BIOME_KEYS = ['floresta', 'cidade', 'caverna'];

export const BIOME_DEFINITIONS = {
  floresta: {
    key: 'floresta',
    label: 'Floresta',
    preferredTypes: ['grass', 'bug'],
    preferredHabitats: ['forest', 'grassland'],
  },
  cidade: {
    key: 'cidade',
    label: 'Cidade',
    preferredTypes: ['electric', 'normal'],
    preferredHabitats: ['urban', 'rough-terrain'],
  },
  caverna: {
    key: 'caverna',
    label: 'Caverna',
    preferredTypes: ['rock', 'ground'],
    preferredHabitats: ['cave', 'mountain'],
  },
};

export const MISSION_KEYS = {
  EXPLORE: 'explorar',
  WIN: 'vitorias',
  CAPTURE: 'capturas',
};

export const DAILY_MISSION_TARGET = {
  [MISSION_KEYS.EXPLORE]: 3,
  [MISSION_KEYS.WIN]: 2,
  [MISSION_KEYS.CAPTURE]: 1,
};

export const WEEKLY_MISSION_TARGET = {
  [MISSION_KEYS.EXPLORE]: 20,
  [MISSION_KEYS.WIN]: 12,
  [MISSION_KEYS.CAPTURE]: 5,
};

export const DAILY_MISSION_REWARD = {
  gold: 150,
  xp: 120,
  items: [{ key: 'potion', quantity: 1 }],
};

export const WEEKLY_MISSION_REWARD = {
  gold: 800,
  xp: 500,
  items: [
    { key: 'superpotion', quantity: 2 },
    { key: 'pokeball', quantity: 2 },
  ],
};

const toInt = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

const toDateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

const stableHash = (value) => {
  const raw = String(value || '');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return hash;
};

export const resolveBiomeFromKey = (biomeKey) => {
  const key = String(biomeKey || '')
    .trim()
    .toLowerCase();
  return BIOME_DEFINITIONS[key] || null;
};

export const resolveDefaultBiomeForGroup = (groupJid) => {
  const index = stableHash(groupJid) % BIOME_KEYS.length;
  const biomeKey = BIOME_KEYS[index];
  return BIOME_DEFINITIONS[biomeKey];
};

export const resolveMissionRefs = (date = __timeNow()) => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const today = new Date(Date.UTC(year, month, day));
  const weekDay = today.getUTCDay();
  const diffToMonday = weekDay === 0 ? 6 : weekDay - 1;
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - diffToMonday);

  return {
    dailyRefDate: toDateOnly(today),
    weeklyRefDate: toDateOnly(monday),
  };
};

export const buildMissionProgressZero = () => ({
  [MISSION_KEYS.EXPLORE]: 0,
  [MISSION_KEYS.WIN]: 0,
  [MISSION_KEYS.CAPTURE]: 0,
});

export const normalizeMissionProgress = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  return {
    [MISSION_KEYS.EXPLORE]: Math.max(0, toInt(source[MISSION_KEYS.EXPLORE], 0)),
    [MISSION_KEYS.WIN]: Math.max(0, toInt(source[MISSION_KEYS.WIN], 0)),
    [MISSION_KEYS.CAPTURE]: Math.max(0, toInt(source[MISSION_KEYS.CAPTURE], 0)),
  };
};

export const isMissionCompleted = (progress, target) => {
  return progress[MISSION_KEYS.EXPLORE] >= target[MISSION_KEYS.EXPLORE] && progress[MISSION_KEYS.WIN] >= target[MISSION_KEYS.WIN] && progress[MISSION_KEYS.CAPTURE] >= target[MISSION_KEYS.CAPTURE];
};

export const resolveMissionStateForRefs = ({ ownerJid, row, refs }) => {
  const normalized = {
    owner_jid: ownerJid,
    daily_ref_date: toDateOnly(row?.daily_ref_date) || refs.dailyRefDate,
    weekly_ref_date: toDateOnly(row?.weekly_ref_date) || refs.weeklyRefDate,
    daily_progress_json: normalizeMissionProgress(row?.daily_progress_json),
    weekly_progress_json: normalizeMissionProgress(row?.weekly_progress_json),
    daily_claimed_at: row?.daily_claimed_at || null,
    weekly_claimed_at: row?.weekly_claimed_at || null,
  };

  let dirty = false;
  if (normalized.daily_ref_date !== refs.dailyRefDate) {
    normalized.daily_ref_date = refs.dailyRefDate;
    normalized.daily_progress_json = buildMissionProgressZero();
    normalized.daily_claimed_at = null;
    dirty = true;
  }

  if (normalized.weekly_ref_date !== refs.weeklyRefDate) {
    normalized.weekly_ref_date = refs.weeklyRefDate;
    normalized.weekly_progress_json = buildMissionProgressZero();
    normalized.weekly_claimed_at = null;
    dirty = true;
  }

  return {
    normalized,
    dirty,
  };
};

export const resolveVictoryRewards = (battleSnapshot) => {
  const enemyLevel = Math.max(1, toInt(battleSnapshot?.enemy?.level, 1));
  const growthRate = String(battleSnapshot?.enemy?.growthRate || '')
    .trim()
    .toLowerCase();
  const isGymBattle = battleSnapshot?.mode === 'gym';

  const growthMultiplier = growthRate === 'slow' ? 1.12 : growthRate === 'fast' ? 0.92 : growthRate === 'medium slow' ? 1.06 : 1;

  const rewards = {
    playerXp: Math.max(1, Math.round(enemyLevel * 14 * growthMultiplier)),
    pokemonXp: Math.max(1, Math.round(enemyLevel * 20 * growthMultiplier)),
    gold: Math.max(40, Math.round(enemyLevel * 12 * growthMultiplier)),
    items: [],
  };

  if (isGymBattle) {
    rewards.playerXp = Math.round(rewards.playerXp * 2.2);
    rewards.pokemonXp = Math.round(rewards.pokemonXp * 2);
    rewards.gold = Math.round(rewards.gold * 2.3);
    rewards.items.push({ key: 'pokeball', quantity: 1 });
  }

  return rewards;
};

export const __testablesRpgPokemonDomain = {
  resolveBiomeFromKey,
  resolveDefaultBiomeForGroup,
  resolveMissionRefs,
  buildMissionProgressZero,
  normalizeMissionProgress,
  isMissionCompleted,
  resolveMissionStateForRefs,
  resolveVictoryRewards,
};
