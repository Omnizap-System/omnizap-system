import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { pool } from '../../../database/index.js';
import { getJidUser, isGroupJid, normalizeJid } from '../../config/index.js';
import logger from '#logger';
import { applyPokemonXpGain, buildMoveSnapshotByName, buildPlayerBattleSnapshot, buildPokemonSnapshot, calculatePlayerLevelFromXp, createRandomIvs, createWildEncounter, resolveBattleTurn, resolveCaptureAttempt, resolveEvolutionByLevel, resolveEvolutionByItem, resolveSingleAttack } from './rpgBattleService.js';
import { addGroupCoopContribution, addGroupEventContribution, addInventoryItem, consumeInventoryItem, countPlayerPokemons, createPlayer, createKarmaVote, createPlayerPokemon, createTradeOffer, applyKarmaDelta, cancelQueuedPvpByOwner, deleteBattleStateByOwner, deleteExpiredBattleStatesByOwner, getActivePlayerPokemonForUpdate, getActivePlayerPokemon, getGroupActivitySummaryByDay, getGroupActiveUsersByDay, getBattleStateByOwner, getBattleStateByOwnerForUpdate, getFirstPlayerPokemon, getGroupCoopMember, getGroupCoopWeekly, getGroupCoopWeeklyForUpdate, getGroupEventMember, getGroupEventMemberForUpdate, getGroupEventWeeklyForUpdate, getInventoryItemForUpdate, getInventoryItems, getGroupBiomeByJid, getKarmaProfile, getKarmaVoteByWeekForUpdate, getLatestFinishedPvpByPlayer, getMissionProgressByOwnerForUpdate, getPlayerByJid, getPlayerByJidForUpdate, getPvpLifetimeStatsByOwner, getPvpWeeklyRankByOwner, getPvpWeeklyStatsByOwner, getQueuedPvpByOwnerForUpdate, getSocialLinkByUsers, getSocialSummaryByOwner, getTradeOfferByIdForUpdate, getGroupRetentionByDays, countPokedexEntries, getPlayerPokemonById, getPlayerPokemonByIdForUpdate, getSocialXpDailyByKeyForUpdate, getTravelStateByOwner, getTravelStateByOwnerForUpdate, listGroupCoopMembers, listRecentFinishedPvpByPlayer, listUnrewardedGroupCoopMembersForUpdate, listGroupEventMembers, listOpenTradeOffersByUser, listPvpWeeklyRanking, listPlayerPokemons, listPokedexEntries, listQueuedPvpByChat, listQueuedPvpByChatForUpdate, listSocialLinksByOwner, listTopKarmaProfiles, markGroupCoopCompleted, markGroupCoopMemberRewardClaimed, markGroupEventCompleted, markGroupEventMemberRewardClaimed, markPvpQueueMatchedByIds, setActivePokemon, transferPlayerPokemon, createMissionProgress, createPvpChallenge, deleteExpiredRaidStates, upsertPokedexEntry, upsertGroupBiome, deleteRaidParticipantsByChat, deleteRaidStateByChat, expireOldPvpChallenges, expireOldTradeOffers, expirePvpQueue, enqueuePvpQueue, getActivePvpChallengeByPlayerForUpdate, getPvpChallengeByIdForUpdate, getRaidParticipant, getRaidStateByChatForUpdate, listOpenPvpChallengesByPlayer, listRaidParticipants, upsertRaidParticipant, addRaidParticipantDamage, upsertGroupActivityDaily, upsertGroupCoopWeekly, upsertGroupEventWeekly, upsertPvpWeeklyStatsDelta, upsertSocialLinkDelta, upsertRaidState, upsertSocialXpDailyDelta, upsertTravelState, updatePvpChallengeState, updateTradeOfferState, updateMissionProgress, updatePlayerGoldOnly, updatePlayerPokemonState, updatePlayerProgress, updatePlayerSocialXpPool, upsertBattleState } from './rpgPokemonRepository.js';
import { buildBattleAlreadyActiveText, buildBattleStartText, buildBattleTurnText, buildBuyErrorText, buildBuySuccessText, buildCaptureFailText, buildCaptureSuccessText, buildCaptureBlockedGymText, buildChooseErrorText, buildChooseSuccessText, buildCooldownText, buildEvolutionTreeText, buildFleeText, buildGenericErrorText, buildNeedActivePokemonText, buildNeedStartText, buildNoBattleText, buildPokedexText, buildPokemonFaintedText, buildProfileText, buildBerryListText, buildPvpChallengeText, buildPvpStatusText, buildPvpTurnText, buildRaidAttackText, buildRaidStartText, buildRaidStatusText, buildShopText, buildStartText, buildTeamText, buildTmListText, buildTmUseText, buildTravelSetText, buildTravelStatusText, buildBagText, buildMissionsText, buildMissionRewardText, buildEconomyRescueText, buildUseItemErrorText, buildUsePotionSuccessText, buildUseItemUsageText, buildRpgHelpText } from './rpgPokemonMessages.js';
import { getEffectText, getEvolutionChain, getFlavorText, getLocalizedGenus, getLocalizedName, getAbility, getCharacteristic, getItem, getItemCategory, getItemPocket, getLocation, getLocationArea, getMachine, getNature, getPokedex, getPokemon, getSpecies, normalizeApiText, getRegion, getResourceList } from '../../services/external/pokeApiService.js';
import { recordRpgBattleStarted, recordRpgCapture, recordRpgCaptureAttempt, recordRpgEvolution, recordRpgAction, recordRpgBattleDuration, recordRpgFlee, recordRpgPvpChallenge, recordRpgPvpCompleted, recordRpgPvpQueue, recordRpgRaidCompleted, recordRpgRaidStarted, recordRpgPlayerCreated, recordRpgSessionDuration, recordRpgTrade, recordRpgCoopCompleted, recordRpgWeeklyEventCompleted, recordRpgKarmaVote, recordRpgGroupRetentionRatio, recordRpgShinyFound, recordSocialXpCapHit, recordSocialXpConversionRate, recordSocialXpConverted } from '../../observability/metrics.js';
import { BIOME_DEFINITIONS, BIOME_KEYS, DAILY_MISSION_REWARD, DAILY_MISSION_TARGET, MISSION_KEYS, WEEKLY_MISSION_REWARD, WEEKLY_MISSION_TARGET, buildMissionProgressZero, isMissionCompleted, normalizeMissionProgress, resolveBiomeFromKey, resolveDefaultBiomeForGroup, resolveMissionRefs, resolveMissionStateForRefs, resolveVictoryRewards } from './rpgPokemonDomain.js';
import { extractUserIdInfo, resolveUserId, resolveUserIdCached } from '../../config/index.js';
import { inferEffectTagFromLogs, renderBattleFrameCanvas } from './rpgBattleCanvasRenderer.js';
import { renderProfileCanvasCard } from './rpgProfileCanvasRenderer.js';
import { registerEvolutionPokedexEntry } from './rpgEvolutionUtils.js';

const COOLDOWN_MS = 5_000;
const BATTLE_TTL_MS = Math.max(60_000, Number(process.env.RPG_BATTLE_TTL_MS) || 5 * 60 * 1000);
const STARTER_LEVEL = Math.max(3, Number(process.env.RPG_STARTER_LEVEL) || 5);
const STARTER_POKE_IDS = [1, 4, 7, 25];
const POTION_HEAL_HP = Math.max(10, Number(process.env.RPG_POTION_HEAL_HP) || 25);
const SUPER_POTION_HEAL_HP = Math.max(POTION_HEAL_HP + 5, Number(process.env.RPG_SUPER_POTION_HEAL_HP) || 60);
const SHOP_REFRESH_MS = Math.max(15 * 60 * 1000, Number(process.env.RPG_SHOP_REFRESH_MS) || 60 * 60 * 1000);
const SHOP_ITEMS_PER_POCKET = Math.max(3, Math.min(12, Number(process.env.RPG_SHOP_ITEMS_PER_POCKET) || 6));
const DEFAULT_POKEDEX_TOTAL = Math.max(1025, Number(process.env.RPG_POKEDEX_TOTAL) || 1025);
const DEFAULT_REGION = String(process.env.RPG_DEFAULT_REGION || 'kanto')
  .trim()
  .toLowerCase();
const SESSION_IDLE_MS = Math.max(2 * 60 * 1000, Number(process.env.RPG_SESSION_IDLE_MS) || 10 * 60 * 1000);
const RAID_TTL_MS = Math.max(2 * 60 * 1000, Number(process.env.RPG_RAID_TTL_MS) || 20 * 60 * 1000);
const PVP_TTL_MS = Math.max(2 * 60 * 1000, Number(process.env.RPG_PVP_TTL_MS) || 15 * 60 * 1000);
const PVP_CHALLENGE_COOLDOWN_MS = Math.max(5_000, Number(process.env.RPG_PVP_COOLDOWN_MS) || 30_000);
const PVP_QUEUE_TTL_MS = Math.max(30_000, Number(process.env.RPG_PVP_QUEUE_TTL_MS) || 10 * 60 * 1000);
const PVP_WIN_GOLD = Math.max(50, Number(process.env.RPG_PVP_WIN_GOLD) || 220);
const PVP_WIN_PLAYER_XP = Math.max(40, Number(process.env.RPG_PVP_WIN_PLAYER_XP) || 140);
const PVP_WIN_POKEMON_XP = Math.max(40, Number(process.env.RPG_PVP_WIN_POKEMON_XP) || 120);
const PVP_WIN_POINTS = Math.max(2, Number(process.env.RPG_PVP_WIN_POINTS) || 3);
const PVP_LOSS_POINTS = Math.max(0, Number(process.env.RPG_PVP_LOSS_POINTS) || 1);
const STARTER_GOLD = Math.max(300, Number(process.env.RPG_STARTER_GOLD) || 450);
const STARTER_POKEBALL_QTY = Math.max(3, Number(process.env.RPG_STARTER_POKEBALL_QTY) || 4);
const STARTER_POTION_QTY = Math.max(1, Number(process.env.RPG_STARTER_POTION_QTY) || 3);
const SHOP_COST_FACTOR = Math.min(1, Math.max(0.05, Number(process.env.RPG_SHOP_COST_FACTOR) || 0.22));
const SHOP_COST_MIN = Math.max(10, Number(process.env.RPG_SHOP_COST_MIN) || 28);
const ECONOMY_RESCUE_COOLDOWN_MS = Math.max(60 * 60 * 1000, Number(process.env.RPG_ECONOMY_RESCUE_COOLDOWN_MS) || 6 * 60 * 60 * 1000);
const ECONOMY_RESCUE_MAX_GOLD = Math.max(0, Number(process.env.RPG_ECONOMY_RESCUE_MAX_GOLD) || 60);
const ECONOMY_RESCUE_GOLD = Math.max(0, Number(process.env.RPG_ECONOMY_RESCUE_GOLD) || 90);
const ECONOMY_RESCUE_POTION_QTY = Math.max(1, Number(process.env.RPG_ECONOMY_RESCUE_POTION_QTY) || 1);
const TRADE_TTL_MS = Math.max(60_000, Number(process.env.RPG_TRADE_TTL_MS) || 20 * 60 * 1000);
const COOP_CAPTURE_TARGET = Math.max(5, Number(process.env.RPG_COOP_CAPTURE_TARGET) || 25);
const COOP_RAID_TARGET = Math.max(1, Number(process.env.RPG_COOP_RAID_TARGET) || 8);
const COOP_REWARD_GOLD = Math.max(50, Number(process.env.RPG_COOP_REWARD_GOLD) || 220);
const COOP_REWARD_XP = Math.max(50, Number(process.env.RPG_COOP_REWARD_XP) || 160);
const COOP_REWARD_ITEM_KEY = String(process.env.RPG_COOP_REWARD_ITEM_KEY || 'pokeball')
  .trim()
  .toLowerCase();
const COOP_REWARD_ITEM_QTY = Math.max(1, Number(process.env.RPG_COOP_REWARD_ITEM_QTY) || 2);
const KARMA_BONUS_THRESHOLD = Math.max(5, Number(process.env.RPG_KARMA_BONUS_THRESHOLD) || 20);
const KARMA_BONUS_RATE = Math.min(0.25, Math.max(0, Number(process.env.RPG_KARMA_BONUS_RATE) || 0.08));
const SOCIAL_XP_CONVERSION_RATE = Math.min(1, Math.max(0.05, Number(process.env.RPG_SOCIAL_XP_CONVERSION_RATE) || 0.25));
const SOCIAL_XP_ACTION_CAP = Math.max(5, Number(process.env.RPG_SOCIAL_XP_ACTION_CAP) || 45);
const SOCIAL_XP_DAILY_CONVERSION_CAP = Math.max(SOCIAL_XP_ACTION_CAP, Number(process.env.RPG_SOCIAL_XP_DAILY_CONVERSION_CAP) || 300);
const SOCIAL_XP_PLAYER_SHARE = Math.min(0.9, Math.max(0.1, Number(process.env.RPG_SOCIAL_XP_PLAYER_SHARE) || 0.6));
const SOCIAL_XP_KARMA_BOOST_RATE = Math.min(0.2, Math.max(0, Number(process.env.RPG_SOCIAL_XP_KARMA_BOOST_RATE) || 0.08));
const SOCIAL_XP_GROUP_BOOST_RATE = Math.min(0.2, Math.max(0, Number(process.env.RPG_SOCIAL_XP_GROUP_BOOST_RATE) || 0.05));
const SOCIAL_XP_ABUSE_PENALTY_RATE = Math.min(0.4, Math.max(0, Number(process.env.RPG_SOCIAL_XP_ABUSE_PENALTY_RATE) || 0.12));
const SOCIAL_XP_ABUSE_CAP_HITS_THRESHOLD = Math.max(1, Number(process.env.RPG_SOCIAL_XP_ABUSE_CAP_HITS_THRESHOLD) || 3);
const MESSAGE_XP_BRIDGE_ENABLED = false;
const BATTLE_CANVAS_ENABLED =
  String(process.env.RPG_BATTLE_CANVAS_ENABLED ?? 'true')
    .trim()
    .toLowerCase() !== 'false';
const PROFILE_CANVAS_ENABLED =
  String(process.env.RPG_PROFILE_CANVAS_ENABLED ?? 'true')
    .trim()
    .toLowerCase() !== 'false';
const PLAYER_LEVEL_XP_FACTOR = 120;
const PLAYER_MAX_LEVEL = calculatePlayerLevelFromXp(Number.MAX_SAFE_INTEGER);

const POKEDEX_MILESTONES = new Map([
  [10, { gold: 300, xp: 120 }],
  [25, { gold: 900, xp: 350 }],
  [50, { gold: 2200, xp: 900 }],
]);

const WEEKLY_EVENT_DEFINITIONS = [
  {
    key: 'capturas',
    label: 'Festival de Capturas',
    targetValue: Math.max(10, Number(process.env.RPG_EVENT_CAPTURE_TARGET) || 40),
    trigger: 'capture',
    rewardGold: Math.max(40, Number(process.env.RPG_EVENT_CAPTURE_REWARD_GOLD) || 160),
    rewardXp: Math.max(40, Number(process.env.RPG_EVENT_CAPTURE_REWARD_XP) || 120),
  },
  {
    key: 'vitorias_pvp',
    label: 'Arena Semanal',
    targetValue: Math.max(4, Number(process.env.RPG_EVENT_PVP_TARGET) || 14),
    trigger: 'pvp_win',
    rewardGold: Math.max(60, Number(process.env.RPG_EVENT_PVP_REWARD_GOLD) || 220),
    rewardXp: Math.max(60, Number(process.env.RPG_EVENT_PVP_REWARD_XP) || 150),
  },
  {
    key: 'dano_raid',
    label: 'Caçada de Raid',
    targetValue: Math.max(1200, Number(process.env.RPG_EVENT_RAID_DAMAGE_TARGET) || 4500),
    trigger: 'raid_damage',
    rewardGold: Math.max(60, Number(process.env.RPG_EVENT_RAID_REWARD_GOLD) || 210),
    rewardXp: Math.max(60, Number(process.env.RPG_EVENT_RAID_REWARD_XP) || 145),
  },
];

const playerCooldownMap = globalThis.__omnizapRpgCooldownMap instanceof Map ? globalThis.__omnizapRpgCooldownMap : new Map();
globalThis.__omnizapRpgCooldownMap = playerCooldownMap;

const pvpCooldownMap = globalThis.__omnizapRpgPvpCooldownMap instanceof Map ? globalThis.__omnizapRpgPvpCooldownMap : new Map();
globalThis.__omnizapRpgPvpCooldownMap = pvpCooldownMap;

const sessionTrackerMap = globalThis.__omnizapRpgSessionTrackerMap instanceof Map ? globalThis.__omnizapRpgSessionTrackerMap : new Map();
globalThis.__omnizapRpgSessionTrackerMap = sessionTrackerMap;

const economyRescueMap = globalThis.__omnizapRpgEconomyRescueMap instanceof Map ? globalThis.__omnizapRpgEconomyRescueMap : new Map();
globalThis.__omnizapRpgEconomyRescueMap = economyRescueMap;

const dynamicShopCache = globalThis.__omnizapRpgDynamicShopCache || {
  items: null,
  index: null,
  aliasMap: null,
  expiresAt: 0,
};
globalThis.__omnizapRpgDynamicShopCache = dynamicShopCache;

const areaEncounterCache = globalThis.__omnizapRpgAreaEncounterCache instanceof Map ? globalThis.__omnizapRpgAreaEncounterCache : new Map();
globalThis.__omnizapRpgAreaEncounterCache = areaEncounterCache;

const BASE_SHOP_ITEMS = [
  {
    key: 'pokeball',
    label: 'Poke Bola',
    price: 70,
    description: 'Captura um Pokémon durante batalha.',
  },
  {
    key: 'potion',
    label: 'Poção',
    price: 35,
    description: `Recupera ${POTION_HEAL_HP} HP do Pokémon ativo.`,
  },
  {
    key: 'superpotion',
    label: 'Super Poção',
    price: 95,
    description: `Recupera ${SUPER_POTION_HEAL_HP} HP do Pokémon ativo.`,
  },
];

const BASE_SHOP_INDEX = new Map(BASE_SHOP_ITEMS.map((item) => [item.key, item]));
const CORE_ITEM_PRICE_OVERRIDES = new Map(BASE_SHOP_ITEMS.map((item) => [item.key, item.price]));
const ITEM_ALIASES = new Map([
  ['pokeball', 'pokeball'],
  ['pokebola', 'pokeball'],
  ['pokeballs', 'pokeball'],
  ['pokebolas', 'pokeball'],
  ['potion', 'potion'],
  ['potions', 'potion'],
  ['pocao', 'potion'],
  ['pocoes', 'potion'],
  ['superpotion', 'superpotion'],
  ['superpotions', 'superpotion'],
  ['superpocao', 'superpotion'],
  ['superpocoes', 'superpotion'],
]);

const toInt = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const randomFromArray = (items) => items[Math.floor(Math.random() * items.length)];
const randomBetweenInt = (min, max) => {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  if (high <= low) return low;
  return Math.floor(Math.random() * (high - low + 1)) + low;
};

const normalizeItemToken = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

  return ITEM_ALIASES.get(normalized) || normalized;
};

const ITEM_CATEGORY_DEFINITIONS = [
  {
    key: 'captura',
    label: 'Captura',
    aliases: ['captura', 'capturar', 'bola', 'bolas', 'pokeball', 'pokebola', 'pokebolas'],
  },
  {
    key: 'cura',
    label: 'Cura',
    aliases: ['cura', 'cura hp', 'heal', 'healing', 'medicina', 'medicine', 'potion', 'pocao', 'pocoes', 'superpotion', 'superpocao'],
  },
  { key: 'berry', label: 'Berry', aliases: ['berry', 'berries', 'fruta', 'frutas'] },
  { key: 'tm', label: 'TM', aliases: ['tm', 'tms', 'maquina', 'maquinas', 'machine', 'machines'] },
  {
    key: 'evolucao',
    label: 'Evolução',
    aliases: ['evolucao', 'evolução', 'evoluir', 'pedra', 'pedras'],
  },
  { key: 'outros', label: 'Outros', aliases: ['outros', 'outro', 'misc'] },
];

const ITEM_CATEGORY_LABEL_MAP = new Map(ITEM_CATEGORY_DEFINITIONS.map((entry) => [entry.key, entry.label]));
const ITEM_CATEGORY_ALIAS_MAP = new Map([
  ['todos', 'todos'],
  ['todo', 'todos'],
  ['all', 'todos'],
  ['categoria', 'todos'],
  ['categorias', 'todos'],
  ['listar', 'todos'],
  ['lista', 'todos'],
]);
ITEM_CATEGORY_DEFINITIONS.forEach((entry) => {
  ITEM_CATEGORY_ALIAS_MAP.set(entry.key, entry.key);
  entry.aliases.forEach((alias) => {
    ITEM_CATEGORY_ALIAS_MAP.set(normalizeItemToken(alias), entry.key);
  });
});

const resolveItemCategoryKeyFromMeta = (itemMeta = {}) => {
  if (itemMeta?.isPokeball) return 'captura';
  if (itemMeta?.isMedicine) return 'cura';
  if (itemMeta?.isBerry) return 'berry';
  if (itemMeta?.isMachine) return 'tm';
  if (String(itemMeta?.category || '').includes('evolution')) return 'evolucao';
  return 'outros';
};

const resolveItemCategoryFilter = (value) => {
  const normalized = normalizeItemToken(value);
  if (!normalized) return 'todos';
  return ITEM_CATEGORY_ALIAS_MAP.get(normalized) || null;
};

const resolveAvailableCategoryKeys = (items = []) => {
  const available = new Set();
  items.forEach((item) => {
    available.add(resolveItemCategoryKeyFromMeta(item));
  });
  return ITEM_CATEGORY_DEFINITIONS.map((entry) => entry.key).filter((key) => available.has(key));
};

const normalizeNameKey = (value) => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
};

const toTitleCase = (value) => {
  return String(value || '')
    .trim()
    .split('-')
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : ''))
    .join(' ');
};

const extractResourceIdFromUrl = (url) => {
  const match = String(url || '').match(/\/(\d+)\/?$/);
  return match ? toInt(match[1], 0) : 0;
};

const pickItemEffect = (itemData) => {
  return getEffectText(itemData?.effect_entries, { preferLong: false }) || null;
};

const pickItemFlavor = (itemData) => {
  return getFlavorText(itemData?.flavor_text_entries) || null;
};

const trimLoreText = (value, maxLength = 210) => {
  const text = normalizeApiText(value || '');
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(30, maxLength - 1)).trimEnd()}…`;
};

const appendLoreLine = (text, loreText, label = '📖') => {
  const lore = trimLoreText(loreText);
  if (!lore) return text;
  return `${text}\n${label} ${lore}`;
};

const resolveItemHealingAmount = (itemData) => {
  const effectText = String(pickItemEffect(itemData) || '').toLowerCase();
  const exact = effectText.match(/restore[s]?\s+(\d+)\s*hp/);
  if (exact) return Math.max(0, toInt(exact[1], 0));

  const simple = effectText.match(/(\d+)\s*hp/);
  if (simple) return Math.max(0, toInt(simple[1], 0));

  if (effectText.includes('fully restores hp') || effectText.includes('fully restore hp')) return 9999;
  return 0;
};

const resolveInternalShopCost = ({ itemKey, apiCost }) => {
  const normalized = normalizeItemToken(itemKey);
  if (CORE_ITEM_PRICE_OVERRIDES.has(normalized)) {
    return CORE_ITEM_PRICE_OVERRIDES.get(normalized);
  }

  const safeCost = Math.max(1, toInt(apiCost, 0) || 80);
  return Math.max(SHOP_COST_MIN, Math.round(safeCost * SHOP_COST_FACTOR));
};

const resolveCatchBonusByBall = (itemKey) => {
  const key = normalizeItemToken(itemKey);
  if (key === 'masterball') return 1;
  if (key === 'ultraball') return 0.28;
  if (key === 'greatball') return 0.16;
  if (key === 'premierball') return 0.04;
  return 0;
};

const resolvePocketKey = (itemData) =>
  String(itemData?.pocket?.name || '')
    .trim()
    .toLowerCase();
const resolveCategoryKey = (itemData) =>
  String(itemData?.category?.name || '')
    .trim()
    .toLowerCase();

const resolveItemMeaningText = ({ isPokeball, isMachine, isBerry, isMedicine, category = '', healAmount = 0, catchBonus = 0, guaranteedCapture = false }) => {
  if (isPokeball) {
    if (guaranteedCapture) return 'Captura garantida durante batalha.';
    const bonusText = catchBonus > 0 ? ` com bônus de captura +${Math.round(catchBonus * 100)}%` : '';
    return `Captura Pokémon durante batalha${bonusText}.`;
  }

  if (isMachine) {
    return 'TM que ensina um golpe para o Pokémon ativo (consome ao usar).';
  }

  if (String(category).includes('evolution')) {
    return 'Item evolutivo: evolui Pokémon compatível.';
  }

  if (isMedicine) {
    if (healAmount >= 9999) return 'Recupera todo o HP do Pokémon ativo.';
    if (healAmount > 0) return `Recupera ${healAmount} HP do Pokémon ativo.`;
    return 'Recupera HP do Pokémon ativo.';
  }

  if (isBerry) {
    const bonusText = catchBonus > 0 ? ` e aplica bônus de captura +${Math.round(catchBonus * 100)}% em batalha` : '';
    return `Berry de suporte: recupera cerca de 15% do HP${bonusText}.`;
  }

  return 'Item especial para uso no RPG.';
};

const buildShopItemFromApi = (itemData) => {
  const key = normalizeItemToken(itemData?.name || '');
  const localizedLabel = getLocalizedName(itemData?.names, itemData?.name || key);
  const label = toTitleCase(localizedLabel || itemData?.name || key);
  const pocket = resolvePocketKey(itemData);
  const category = resolveCategoryKey(itemData);
  const effect = pickItemEffect(itemData);
  const loreText = pickItemFlavor(itemData);
  const healAmount = resolveItemHealingAmount(itemData);
  const cost = resolveInternalShopCost({
    itemKey: key,
    apiCost: itemData?.cost,
  });
  const isPokeball = pocket === 'pokeballs' || category.includes('ball');
  const isMachine = pocket === 'machines' || category.includes('machines');
  const isBerry = pocket === 'berries' || category.includes('berries');
  const isMedicine = pocket === 'medicine' || category.includes('medicine') || healAmount > 0;
  const catchBonus = isPokeball ? resolveCatchBonusByBall(key) : isBerry ? 0.08 : 0;
  const guaranteedCapture = key === 'masterball';
  const description = resolveItemMeaningText({
    isPokeball,
    isMachine,
    isBerry,
    isMedicine,
    category,
    healAmount,
    catchBonus,
    guaranteedCapture,
  });

  return {
    key,
    sourceName:
      String(itemData?.name || '')
        .trim()
        .toLowerCase() || key,
    label,
    price: cost,
    description: trimLoreText(description || effect || loreText || 'Item Pokémon', 120),
    loreText: trimLoreText(loreText || effect || '', 180),
    healAmount,
    catchBonus,
    guaranteedCapture,
    pocket,
    category,
    isPokeball,
    isMachine,
    isBerry,
    isMedicine,
    sprite: itemData?.sprites?.default || null,
  };
};

const mergeShopItems = (dynamicItems = []) => {
  const merged = new Map();

  BASE_SHOP_ITEMS.forEach((item) => {
    merged.set(normalizeItemToken(item.key), {
      ...item,
      sourceName: normalizeItemToken(item.key),
      healAmount: item.key === 'superpotion' ? SUPER_POTION_HEAL_HP : item.key === 'potion' ? POTION_HEAL_HP : 0,
      catchBonus: item.key === 'pokeball' ? 0 : 0,
      guaranteedCapture: false,
      loreText: trimLoreText(item.description, 180),
      isPokeball: item.key === 'pokeball',
      isMachine: false,
      isBerry: false,
      isMedicine: item.key === 'potion' || item.key === 'superpotion',
      pocket: item.key === 'pokeball' ? 'pokeballs' : 'medicine',
      category: item.key === 'pokeball' ? 'standard-balls' : 'medicine',
      sprite: null,
    });
  });

  dynamicItems.forEach((item) => {
    if (!item?.key) return;
    merged.set(item.key, item);
  });

  return [...merged.values()];
};

const buildShopAliasMap = (items = []) => {
  const aliases = new Map(ITEM_ALIASES);
  items.forEach((item) => {
    const key = normalizeItemToken(item.key);
    if (!key) return;
    aliases.set(key, key);
    aliases.set(normalizeItemToken(item.sourceName), key);
    aliases.set(normalizeItemToken(item.label), key);
  });
  return aliases;
};

const extractCategoryNameFromPocket = (entry) => {
  const url = String(entry?.url || '').trim();
  const fromUrl = url.match(/\/item-category\/(\d+|[a-z-]+)\/?$/i)?.[1];
  if (fromUrl) return String(fromUrl).toLowerCase();
  return (
    String(entry?.name || '')
      .trim()
      .toLowerCase() || null
  );
};

const loadPocketItems = async (pocketName) => {
  const pocket = await getItemPocket(pocketName);
  const categories = (pocket?.categories || []).map(extractCategoryNameFromPocket).filter(Boolean);
  if (!categories.length) return [];

  const firstCategory = categories[0];
  const categoryData = await getItemCategory(firstCategory);
  const entries = Array.isArray(categoryData?.items) ? categoryData.items : [];
  const selected = entries.slice(0, SHOP_ITEMS_PER_POCKET);

  const items = [];
  for (const entry of selected) {
    const itemName = String(entry?.name || '')
      .trim()
      .toLowerCase();
    if (!itemName) continue;
    try {
      const itemData = await getItem(itemName);
      items.push(buildShopItemFromApi(itemData));
    } catch (error) {
      logger.debug('Item ignorado na carga da loja dinâmica.', {
        pocketName,
        itemName,
        error: error.message,
      });
    }
  }

  return items;
};

const getShopCatalog = async ({ forceRefresh = false } = {}) => {
  const now = __timeNowMs();
  if (!forceRefresh && dynamicShopCache.items && dynamicShopCache.expiresAt > now) {
    return {
      items: dynamicShopCache.items,
      index: dynamicShopCache.index,
      aliasMap: dynamicShopCache.aliasMap,
    };
  }

  try {
    const pockets = ['pokeballs', 'medicine', 'berries', 'machines'];
    const dynamicItems = [];

    for (const pocket of pockets) {
      const entries = await loadPocketItems(pocket);
      dynamicItems.push(...entries);
    }

    const items = mergeShopItems(dynamicItems);
    const index = new Map(items.map((item) => [normalizeItemToken(item.key), item]));
    const aliasMap = buildShopAliasMap(items);

    dynamicShopCache.items = items;
    dynamicShopCache.index = index;
    dynamicShopCache.aliasMap = aliasMap;
    dynamicShopCache.expiresAt = now + SHOP_REFRESH_MS;

    return { items, index, aliasMap };
  } catch (error) {
    logger.warn('Falha ao atualizar catálogo dinâmico da loja RPG. Usando fallback.', {
      error: error.message,
    });

    const fallbackItems = mergeShopItems([]);
    const fallbackIndex = new Map(fallbackItems.map((item) => [normalizeItemToken(item.key), item]));
    const aliasMap = buildShopAliasMap(fallbackItems);

    dynamicShopCache.items = fallbackItems;
    dynamicShopCache.index = fallbackIndex;
    dynamicShopCache.aliasMap = aliasMap;
    dynamicShopCache.expiresAt = __timeNowMs() + Math.min(SHOP_REFRESH_MS, 10 * 60 * 1000);

    return { items: fallbackItems, index: fallbackIndex, aliasMap };
  }
};

const resolveCatalogItemKey = (itemToken, aliasMap) => {
  const normalized = normalizeItemToken(itemToken);
  if (!normalized) return null;
  return aliasMap.get(normalized) || normalized;
};

const resolvePokemonTraits = async ({ pokemonData }) => {
  const abilities = (pokemonData?.abilities || []).filter((entry) => !entry?.is_hidden);
  const abilityCandidate = abilities.length ? randomFromArray(abilities) : pokemonData?.abilities?.[0];
  const abilityKey =
    String(abilityCandidate?.ability?.name || '')
      .trim()
      .toLowerCase() || null;

  let abilityData = null;
  if (abilityKey) {
    try {
      abilityData = await getAbility(abilityKey);
    } catch (error) {
      logger.debug('Não foi possível resolver dados da habilidade para traits.', {
        abilityKey,
        error: error.message,
      });
    }
  }

  let natureData = null;
  try {
    natureData = await getNature(randomBetweenInt(1, 25));
  } catch (error) {
    logger.debug('Não foi possível resolver nature para traits.', {
      error: error.message,
    });
  }

  let characteristicData = null;
  try {
    characteristicData = await getCharacteristic(randomBetweenInt(1, 30));
  } catch (error) {
    logger.debug('Characteristic indisponível para trait narrativa.', {
      error: error.message,
    });
  }

  return {
    natureKey:
      String(natureData?.name || '')
        .trim()
        .toLowerCase() || null,
    natureName: natureData?.name ? toTitleCase(natureData.name) : null,
    natureData,
    abilityKey,
    abilityName: abilityData?.name ? toTitleCase(abilityData.name) : abilityKey ? toTitleCase(abilityKey) : null,
    abilityEffectText: trimLoreText(getEffectText(abilityData?.effect_entries, { preferLong: false }), 160),
    abilityData,
    characteristic: characteristicData?.description ? trimLoreText(characteristicData.description, 140) : null,
  };
};

const resolveTravelEncounterPool = async (locationAreaKey) => {
  const key = String(locationAreaKey || '')
    .trim()
    .toLowerCase();
  if (!key) return [];

  const cached = areaEncounterCache.get(key);
  if (cached && cached.expiresAt > __timeNowMs()) {
    return cached.pool;
  }

  try {
    const area = await getLocationArea(key);
    const pool = (area?.pokemon_encounters || [])
      .map((entry) => entry?.pokemon?.name)
      .filter(Boolean)
      .slice(0, 40);
    areaEncounterCache.set(key, {
      pool,
      expiresAt: __timeNowMs() + SHOP_REFRESH_MS,
    });
    return pool;
  } catch (error) {
    logger.warn('Falha ao resolver encounter pool por área.', {
      locationAreaKey: key,
      error: error.message,
    });
    return [];
  }
};

const resolveBiomeForChat = async (chatJid, connection = null) => {
  if (!isGroupJid(chatJid)) return null;

  const stored = await getGroupBiomeByJid(chatJid, connection);
  const storedBiome = resolveBiomeFromKey(stored?.biome_key);
  if (storedBiome) return storedBiome;

  const assigned = resolveDefaultBiomeForGroup(chatJid);
  if (!assigned) return null;

  await upsertGroupBiome(
    {
      groupJid: chatJid,
      biomeKey: assigned.key,
    },
    connection,
  );

  return assigned;
};

const resolveTravelStateForOwner = async ({ ownerJid, connection = null }) => {
  const current = connection ? await getTravelStateByOwnerForUpdate(ownerJid, connection) : await getTravelStateByOwner(ownerJid, connection);
  if (current) return current;

  await upsertTravelState(
    {
      ownerJid,
      regionKey: DEFAULT_REGION,
      locationKey: null,
      locationAreaKey: null,
    },
    connection,
  );

  return connection ? getTravelStateByOwnerForUpdate(ownerJid, connection) : getTravelStateByOwner(ownerJid, connection);
};

const itemRewardLabel = (itemKey) => {
  return BASE_SHOP_INDEX.get(itemKey)?.label || toTitleCase(itemKey);
};

const formatMissionRewardSummary = (reward, label) => {
  const itemText = (reward.items || []).map((item) => `+${item.quantity} ${itemRewardLabel(item.key)}`).join(' | ');
  const parts = [`🏆 Missão ${label} concluída!`, `+${reward.gold} gold`, `+${reward.xp} XP`];
  if (itemText) parts.push(itemText);
  return parts.join(' ');
};

const ensureMissionStateForUpdate = async ({ ownerJid, connection }) => {
  const refs = resolveMissionRefs(__timeNow());
  let row = await getMissionProgressByOwnerForUpdate(ownerJid, connection);

  if (!row) {
    row = await createMissionProgress(
      {
        ownerJid,
        dailyRefDate: refs.dailyRefDate,
        dailyProgressJson: buildMissionProgressZero(),
        weeklyRefDate: refs.weeklyRefDate,
        weeklyProgressJson: buildMissionProgressZero(),
      },
      connection,
    );
  }
  const { normalized, dirty } = resolveMissionStateForRefs({
    ownerJid,
    row,
    refs,
  });

  if (dirty) {
    await updateMissionProgress(
      {
        ownerJid,
        dailyRefDate: normalized.daily_ref_date,
        dailyProgressJson: normalized.daily_progress_json,
        dailyClaimedAt: normalized.daily_claimed_at,
        weeklyRefDate: normalized.weekly_ref_date,
        weeklyProgressJson: normalized.weekly_progress_json,
        weeklyClaimedAt: normalized.weekly_claimed_at,
      },
      connection,
    );
  }

  return normalized;
};

const applyMissionReward = async ({ player, ownerJid, reward, connection }) => {
  const nextXp = Math.max(0, toInt(player.xp, 0) + Math.max(0, toInt(reward.xp, 0)));
  const nextGold = Math.max(0, toInt(player.gold, 0) + Math.max(0, toInt(reward.gold, 0)));
  const nextLevel = calculatePlayerLevelFromXp(nextXp);

  await updatePlayerProgress(
    {
      jid: ownerJid,
      level: nextLevel,
      xp: nextXp,
      gold: nextGold,
    },
    connection,
  );

  for (const item of reward.items || []) {
    if (!item?.key || !Number.isFinite(Number(item?.quantity)) || Number(item.quantity) <= 0) continue;
    await addInventoryItem(
      {
        ownerJid,
        itemKey: item.key,
        quantity: Number(item.quantity),
      },
      connection,
    );
  }

  return {
    ...player,
    level: nextLevel,
    xp: nextXp,
    gold: nextGold,
  };
};

const applyMissionEvent = async ({ ownerJid, eventKey, connection }) => {
  if (!Object.values(MISSION_KEYS).includes(eventKey)) {
    return { notices: [] };
  }

  const mission = await ensureMissionStateForUpdate({ ownerJid, connection });
  const player = await getPlayerByJidForUpdate(ownerJid, connection);
  if (!player) {
    return { notices: [] };
  }

  const dailyProgress = { ...mission.daily_progress_json };
  const weeklyProgress = { ...mission.weekly_progress_json };
  dailyProgress[eventKey] = Math.max(0, toInt(dailyProgress[eventKey], 0) + 1);
  weeklyProgress[eventKey] = Math.max(0, toInt(weeklyProgress[eventKey], 0) + 1);

  let updatedPlayer = player;
  const notices = [];
  let dailyClaimedAt = mission.daily_claimed_at;
  let weeklyClaimedAt = mission.weekly_claimed_at;

  if (!dailyClaimedAt && isMissionCompleted(dailyProgress, DAILY_MISSION_TARGET)) {
    updatedPlayer = await applyMissionReward({
      player: updatedPlayer,
      ownerJid,
      reward: DAILY_MISSION_REWARD,
      connection,
    });
    dailyClaimedAt = __timeNow();
    notices.push(formatMissionRewardSummary(DAILY_MISSION_REWARD, 'diária'));
  }

  if (!weeklyClaimedAt && isMissionCompleted(weeklyProgress, WEEKLY_MISSION_TARGET)) {
    updatedPlayer = await applyMissionReward({
      player: updatedPlayer,
      ownerJid,
      reward: WEEKLY_MISSION_REWARD,
      connection,
    });
    weeklyClaimedAt = __timeNow();
    notices.push(formatMissionRewardSummary(WEEKLY_MISSION_REWARD, 'semanal'));
  }

  await updateMissionProgress(
    {
      ownerJid,
      dailyRefDate: mission.daily_ref_date,
      dailyProgressJson: dailyProgress,
      dailyClaimedAt,
      weeklyRefDate: mission.weekly_ref_date,
      weeklyProgressJson: weeklyProgress,
      weeklyClaimedAt,
    },
    connection,
  );

  return { notices, player: updatedPlayer };
};

const buildBattleChatKey = (chatJid, ownerJid) => `${chatJid}::${ownerJid}`;
const extractSourceChatFromBattleKey = (battleChatKey) => String(battleChatKey || '').split('::')[0] || null;

const nowPlusTtlDate = () => new Date(__timeNowMs() + BATTLE_TTL_MS);
const nowPlusRaidTtlDate = () => new Date(__timeNowMs() + RAID_TTL_MS);
const nowPlusPvpTtlDate = () => new Date(__timeNowMs() + PVP_TTL_MS);

const parseBattleSnapshot = (battleState) => {
  const snapshot = battleState?.enemy_snapshot_json;
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (!snapshot.my || !snapshot.enemy) return null;
  return snapshot;
};

const toDateSafe = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const toDurationSeconds = (startedAt, endedAt = __timeNow()) => {
  const start = toDateSafe(startedAt);
  const end = toDateSafe(endedAt) || __timeNow();
  if (!start) return 0;
  const delta = (end.getTime() - start.getTime()) / 1000;
  if (!Number.isFinite(delta) || delta < 0) return 0;
  return delta;
};

const recordBattleDurationFromSnapshot = ({ snapshot, outcome }) => {
  const seconds = toDurationSeconds(snapshot?.startedAt);
  if (seconds <= 0) return;
  recordRpgBattleDuration({
    mode: snapshot?.mode || 'wild',
    outcome,
    seconds,
  });
};

const markSessionSample = (ownerJid) => {
  const now = __timeNowMs();
  const tracker = sessionTrackerMap.get(ownerJid);
  if (!tracker || now - tracker.lastAt > SESSION_IDLE_MS) {
    sessionTrackerMap.set(ownerJid, {
      startedAt: now,
      lastAt: now,
    });
    return;
  }

  tracker.lastAt = now;
  const durationSec = Math.max(0, Math.round((now - tracker.startedAt) / 1000));
  recordRpgSessionDuration(durationSec);
};

const toUtcDateOnly = (value = __timeNow()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

const getDateOnlyOffset = (days = 0) => {
  const now = __timeNow();
  const atMidnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  atMidnightUtc.setUTCDate(atMidnightUtc.getUTCDate() + days);
  return toUtcDateOnly(atMidnightUtc);
};

const toDateFromDateOnly = (dateOnly, plusDays = 0) => {
  const source = String(dateOnly || '').trim();
  if (!source) return __timeNow();
  const date = new Date(`${source}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return __timeNow();
  date.setUTCDate(date.getUTCDate() + plusDays);
  return date;
};

const getCurrentMissionRefs = () => resolveMissionRefs(__timeNow());

const getCurrentWeekRefDate = () => getCurrentMissionRefs().weeklyRefDate;

const getCurrentDayRefDate = () => getCurrentMissionRefs().dailyRefDate;

const resolveSocialChatScope = (chatJid) => {
  const raw = String(chatJid || '').trim();
  if (!raw) return '__direct__';
  if (raw.endsWith('@g.us')) return raw;
  return '__direct__';
};

const resolveSocialConversionMultiplier = ({ karmaScore = 0, hasGroupMomentum = false, capHits = 0 }) => {
  let multiplier = 1;
  if (karmaScore >= KARMA_BONUS_THRESHOLD) {
    multiplier += SOCIAL_XP_KARMA_BOOST_RATE;
  }
  if (hasGroupMomentum) {
    multiplier += SOCIAL_XP_GROUP_BOOST_RATE;
  }
  if (capHits >= SOCIAL_XP_ABUSE_CAP_HITS_THRESHOLD) {
    multiplier -= SOCIAL_XP_ABUSE_PENALTY_RATE;
  }
  return clamp(multiplier, 0.6, 1.4);
};

const applySocialXpConversion = async ({ ownerJid, chatJid, connection, actionKey = 'unknown' }) => {
  if (!MESSAGE_XP_BRIDGE_ENABLED) {
    return { convertedXp: 0, playerXpBonus: 0, pokemonXpBonus: 0, notice: null };
  }

  const player = await getPlayerByJidForUpdate(ownerJid, connection);
  if (!player) return { convertedXp: 0, playerXpBonus: 0, pokemonXpBonus: 0, notice: null };

  const poolBefore = Math.max(0, toInt(player?.xp_pool_social, 0));
  if (poolBefore <= 0) {
    return { convertedXp: 0, playerXpBonus: 0, pokemonXpBonus: 0, notice: null };
  }

  const dayRefDate = getCurrentDayRefDate();
  const scopedChatJid = resolveSocialChatScope(chatJid);
  const daily = await getSocialXpDailyByKeyForUpdate(dayRefDate, ownerJid, scopedChatJid, connection);
  const convertedToday = Math.max(0, toInt(daily?.converted_xp, 0));
  const capRemaining = Math.max(0, SOCIAL_XP_DAILY_CONVERSION_CAP - convertedToday);

  if (capRemaining <= 0) {
    await upsertSocialXpDailyDelta(
      {
        dayRefDate,
        ownerJid,
        chatJid: scopedChatJid,
        capHitsDelta: 1,
      },
      connection,
    );
    recordSocialXpCapHit({ scope: 'conversion' });
    return {
      convertedXp: 0,
      playerXpBonus: 0,
      pokemonXpBonus: 0,
      capReached: true,
      notice: null,
    };
  }

  const [karmaProfile, activeUsers] = await Promise.all([getKarmaProfile(ownerJid, connection), scopedChatJid.endsWith('@g.us') ? getGroupActiveUsersByDay(scopedChatJid, dayRefDate, connection) : Promise.resolve(0)]);
  const multiplier = resolveSocialConversionMultiplier({
    karmaScore: toInt(karmaProfile?.karma_score, 0),
    hasGroupMomentum: toInt(activeUsers, 0) >= 3,
    capHits: toInt(daily?.cap_hits, 0),
  });

  const baseConverted = Math.max(1, Math.round(poolBefore * SOCIAL_XP_CONVERSION_RATE));
  const adjustedConverted = Math.max(0, Math.min(poolBefore, capRemaining, SOCIAL_XP_ACTION_CAP, Math.max(1, Math.round(baseConverted * multiplier))));

  if (adjustedConverted <= 0) {
    return { convertedXp: 0, playerXpBonus: 0, pokemonXpBonus: 0, notice: null };
  }

  const playerXpBonus = Math.max(1, Math.round(adjustedConverted * SOCIAL_XP_PLAYER_SHARE));
  const pokemonXpBonus = Math.max(0, adjustedConverted - playerXpBonus);
  const poolAfter = Math.max(0, poolBefore - adjustedConverted);

  await updatePlayerSocialXpPool(
    {
      jid: ownerJid,
      xpPoolSocial: poolAfter,
    },
    connection,
  );
  await upsertSocialXpDailyDelta(
    {
      dayRefDate,
      ownerJid,
      chatJid: scopedChatJid,
      convertedDelta: adjustedConverted,
    },
    connection,
  );

  recordSocialXpConverted({ value: adjustedConverted, action: actionKey });
  recordSocialXpConversionRate({
    action: actionKey,
    rate: adjustedConverted / Math.max(1, baseConverted),
  });

  return {
    convertedXp: adjustedConverted,
    playerXpBonus,
    pokemonXpBonus,
    poolBefore,
    poolAfter,
    multiplier,
    notice: null,
  };
};

const toMentionJid = (jid) => {
  const raw = String(jid || '').trim();
  if (!raw) return null;
  const normalized = normalizeJid(raw);
  return normalized || raw;
};

const toMentionLabel = (jid) => {
  const resolved = toMentionJid(jid);
  if (!resolved) return 'desconhecido';
  const user = getJidUser(resolved) || String(resolved).split('@')[0] || '';
  const safeUser = String(user)
    .trim()
    .replace(/[^0-9a-zA-Z._-]/g, '');
  return safeUser ? `@${safeUser}` : resolved;
};

const toPvpPokemonLabel = (pokemonSnapshot) => {
  const name = String(pokemonSnapshot?.displayName || pokemonSnapshot?.name || '').trim();
  if (!name) return null;
  const level = Math.max(1, toInt(pokemonSnapshot?.level, 1));
  const shinyPrefix = pokemonSnapshot?.isShiny ? '✨ ' : '';
  return `${shinyPrefix}${name} Lv.${level}`;
};

const toPvpDuelLabels = ({ battleSnapshot, challengerJid, opponentJid }) => {
  const players = battleSnapshot?.players && typeof battleSnapshot.players === 'object' ? battleSnapshot.players : {};
  return {
    challengerPokemonLabel: toPvpPokemonLabel(players?.[challengerJid]?.pokemon || null),
    opponentPokemonLabel: toPvpPokemonLabel(players?.[opponentJid]?.pokemon || null),
  };
};

const buildEngagementMentions = (...jids) =>
  Array.from(
    new Set(
      jids
        .flat()
        .map((jid) => toMentionJid(jid))
        .filter(Boolean),
    ),
  );

const USER_JID_IN_TEXT_REGEX = /(?:\b\d{6,}@s\.whatsapp\.net\b|\b[0-9a-z._:-]+@lid\b)/gi;

const replaceUserJidsWithMentions = (text) => {
  const raw = String(text || '');
  if (!raw.trim()) {
    return {
      text: raw,
      mentions: [],
    };
  }

  const foundMentions = [];
  const replaced = raw.replace(USER_JID_IN_TEXT_REGEX, (match) => {
    const jid = toMentionJid(match);
    if (!jid) return match;
    foundMentions.push(jid);
    return toMentionLabel(jid);
  });

  return {
    text: replaced,
    mentions: buildEngagementMentions(foundMentions),
  };
};

const applyAutoMentionsOnResult = (result) => {
  if (!result || typeof result !== 'object') return result;

  const textRaw = typeof result.text === 'string' ? result.text : '';
  const captionRaw = typeof result.caption === 'string' ? result.caption : null;

  const textResolved = replaceUserJidsWithMentions(textRaw);
  const captionResolved = captionRaw === null ? { text: null, mentions: [] } : replaceUserJidsWithMentions(captionRaw);

  const mergedMentions = buildEngagementMentions(result.mentions || [], textResolved.mentions, captionResolved.mentions, result.winnerJid || null, result.loserJid || null);

  return {
    ...result,
    ...(typeof result.text === 'string' ? { text: textResolved.text } : {}),
    ...(typeof result.caption === 'string' ? { caption: captionResolved.text } : {}),
    ...(mergedMentions.length ? { mentions: mergedMentions } : {}),
  };
};

const determineEventDefinitionForGroup = ({ chatJid, weekRefDate }) => {
  const seedRaw = `${chatJid || 'chat'}::${weekRefDate || getCurrentWeekRefDate()}`;
  let hash = 0;
  for (let i = 0; i < seedRaw.length; i += 1) {
    hash = (hash * 31 + seedRaw.charCodeAt(i)) >>> 0;
  }
  const index = hash % WEEKLY_EVENT_DEFINITIONS.length;
  return WEEKLY_EVENT_DEFINITIONS[index];
};

const resolveEventDefinitionByKey = (eventKey) => {
  return WEEKLY_EVENT_DEFINITIONS.find((entry) => entry.key === eventKey) || null;
};

const normalizeTradeAssetToken = (token) => {
  const raw = String(token || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const parts = raw.split(':').filter(Boolean);
  if (parts.length < 2) return null;

  const type = parts[0];
  if (type === 'item') {
    const itemKey = normalizeItemToken(parts[1]);
    const quantity = Math.max(1, toInt(parts[2], 1));
    if (!itemKey) return null;
    return { type: 'item', itemKey, quantity };
  }

  if (type === 'pokemon') {
    const pokemonId = toInt(parts[1], NaN);
    if (!Number.isFinite(pokemonId) || pokemonId <= 0) return null;
    return { type: 'pokemon', pokemonId };
  }

  return null;
};

const formatTradeAsset = (asset) => {
  if (!asset || typeof asset !== 'object') return 'ativo inválido';
  if (asset.type === 'item') return `item:${asset.itemKey}:${Math.max(1, toInt(asset.quantity, 1))}`;
  if (asset.type === 'pokemon') return `pokemon:${toInt(asset.pokemonId, 0)}`;
  return 'ativo inválido';
};

const resolveMentionOrArgJid = async ({ token = null, mentionedJids = [] }) => {
  const mentioned = Array.isArray(mentionedJids) ? mentionedJids.find(Boolean) : null;
  if (mentioned) return resolveCanonicalUserJid(mentioned);
  return resolveCanonicalUserJid(token);
};

const applyKarmaBonus = async ({ ownerJid, gold = 0, xp = 0, connection }) => {
  const karma = await getKarmaProfile(ownerJid, connection);
  const score = toInt(karma?.karma_score, 0);
  if (score < KARMA_BONUS_THRESHOLD) {
    return {
      bonusGold: 0,
      bonusXp: 0,
      karmaScore: score,
    };
  }

  return {
    bonusGold: Math.max(0, Math.round(gold * KARMA_BONUS_RATE)),
    bonusXp: Math.max(0, Math.round(xp * KARMA_BONUS_RATE)),
    karmaScore: score,
  };
};

const trackGroupActivity = async ({ chatJid, ownerJid, actionsDelta = 1, pvpCreatedDelta = 0, pvpCompletedDelta = 0, coopCompletedDelta = 0 }) => {
  if (!isGroupJid(chatJid)) return;
  const dayRefDate = getCurrentDayRefDate();
  try {
    await upsertGroupActivityDaily({
      dayRefDate,
      chatJid,
      ownerJid,
      actionsDelta,
      pvpCreatedDelta,
      pvpCompletedDelta,
      coopCompletedDelta,
    });
  } catch (error) {
    logger.warn('Falha ao registrar atividade diária de grupo no RPG.', {
      chatJid,
      ownerJid,
      error: error.message,
    });
  }
};

const normalizeJidToken = (token) => {
  const raw = String(token || '').trim();
  if (!raw) return null;
  if (raw.includes('@s.whatsapp.net')) return raw.toLowerCase();
  if (raw.includes('@lid')) return raw.toLowerCase();

  const numeric = raw.replace(/[^\d]/g, '');
  if (numeric.length < 6) return null;
  return `${numeric}@s.whatsapp.net`;
};

const resolveCanonicalUserJid = async (rawUserId) => {
  const info = extractUserIdInfo(rawUserId);
  if (!info.raw) return null;

  const fallback = resolveUserIdCached(info) || info.raw || null;
  try {
    const resolved = await resolveUserId(info);
    return resolved || fallback;
  } catch (error) {
    logger.warn('Falha ao resolver ID canônico para PvP.', {
      rawUserId: info.raw,
      error: error.message,
    });
    return fallback;
  }
};

const resolveOpponentJidFromArgs = async ({ actionArgs = [], mentionedJids = [] }) => {
  const mentioned = await resolveMentionOrArgJid({
    token: null,
    mentionedJids,
  });
  if (mentioned) return mentioned;

  const direct = normalizeJidToken(actionArgs?.[0]);
  if (direct) return resolveCanonicalUserJid(direct);

  const joined = String(actionArgs.join(' ') || '');
  const mentionMatch = joined.match(/@(\d{6,})/);
  if (!mentionMatch) return null;
  return resolveCanonicalUserJid(`${mentionMatch[1]}@s.whatsapp.net`);
};

const getCooldownSecondsLeft = (ownerJid) => {
  const lastAt = playerCooldownMap.get(ownerJid);
  if (!lastAt) return 0;
  const diff = __timeNowMs() - lastAt;
  if (diff >= COOLDOWN_MS) return 0;
  return Math.max(1, Math.ceil((COOLDOWN_MS - diff) / 1000));
};

const getPvpCooldownSecondsLeft = (ownerJid) => {
  const lastAt = pvpCooldownMap.get(ownerJid);
  if (!lastAt) return 0;
  const diff = __timeNowMs() - lastAt;
  if (diff >= PVP_CHALLENGE_COOLDOWN_MS) return 0;
  return Math.max(1, Math.ceil((PVP_CHALLENGE_COOLDOWN_MS - diff) / 1000));
};

const shouldApplyCooldown = (action) => {
  return ['explorar', 'ginasio', 'atacar', 'capturar', 'fugir', 'comprar', 'escolher', 'usar', 'viajar', 'tm', 'berry', 'raid', 'desafiar', 'pvp'].includes(action);
};

const touchCooldown = (ownerJid) => {
  playerCooldownMap.set(ownerJid, __timeNowMs());
};

const touchPvpCooldown = (ownerJid) => {
  pvpCooldownMap.set(ownerJid, __timeNowMs());
};

const loadPokemonDisplayData = async (pokemonRow) => {
  const snapshot = await buildPlayerBattleSnapshot({ playerPokemonRow: pokemonRow });
  return {
    id: pokemonRow.id,
    pokeId: pokemonRow.poke_id,
    name: snapshot.name,
    displayName: pokemonRow.nickname || snapshot.displayName,
    level: pokemonRow.level,
    currentHp: pokemonRow.current_hp,
    maxHp: snapshot.maxHp,
    isShiny: Boolean(pokemonRow.is_shiny),
    isActive: pokemonRow.is_active,
    imageUrl: snapshot.imageUrl || null,
    natureName: snapshot?.nature?.name || pokemonRow.nature_key || null,
    abilityName: snapshot?.ability?.name || pokemonRow.ability_name || pokemonRow.ability_key || null,
    abilityEffectText: snapshot?.ability?.effectText || null,
    flavorText: snapshot?.flavorText || null,
    genus: snapshot?.genus || null,
  };
};

const createStarterPokemon = async ({ ownerJid, connection }) => {
  const starterId = randomFromArray(STARTER_POKE_IDS);
  const starterApi = await getPokemon(starterId);
  const traits = await resolvePokemonTraits({ pokemonData: starterApi });
  const starterSnapshot = await buildPokemonSnapshot({
    pokemonData: starterApi,
    natureData: traits.natureData,
    abilityData: traits.abilityData,
    level: STARTER_LEVEL,
    currentHp: null,
    ivs: createRandomIvs(),
    isShiny: false,
  });

  const created = await createPlayerPokemon(
    {
      ownerJid,
      pokeId: starterSnapshot.pokeId,
      nickname: starterSnapshot.displayName,
      level: STARTER_LEVEL,
      xp: 0,
      currentHp: starterSnapshot.maxHp,
      ivsJson: starterSnapshot.ivs,
      movesJson: starterSnapshot.moves,
      natureKey: traits.natureKey,
      abilityKey: traits.abilityKey,
      abilityName: traits.abilityName,
      isShiny: false,
      isActive: true,
    },
    connection,
  );

  await upsertPokedexEntry(
    {
      ownerJid,
      pokeId: starterSnapshot.pokeId,
    },
    connection,
  );

  return {
    row: created,
    snapshot: starterSnapshot,
  };
};

const ensureNoExpiredBattle = async (ownerJid, connection = null) => {
  await deleteExpiredBattleStatesByOwner(ownerJid, connection);
};

const withPokemonImage = ({ text, pokemonSnapshot, caption = null, extra = {} }) => {
  const imageUrl = pokemonSnapshot?.imageUrl || null;
  if (!imageUrl) {
    return { ok: true, text, ...extra };
  }

  return {
    ok: true,
    text,
    imageUrl,
    caption: caption || text,
    ...extra,
  };
};

const withProfileCanvasCard = async ({ text, profileCanvas, caption = null, extra = {}, pokemonSnapshotFallback = null }) => {
  const fallback = withPokemonImage({
    text,
    pokemonSnapshot: pokemonSnapshotFallback,
    caption: caption || text,
    extra,
  });

  if (!PROFILE_CANVAS_ENABLED) return fallback;

  try {
    const imageBuffer = await renderProfileCanvasCard(profileCanvas || {});
    return {
      ok: true,
      text,
      imageBuffer,
      caption: caption || text,
      ...extra,
    };
  } catch (error) {
    logger.warn('Falha ao renderizar canvas de perfil RPG.', {
      error: error.message,
    });
    return fallback;
  }
};

const resolveBattleModeLabel = (mode) => {
  const key = String(mode || '')
    .trim()
    .toLowerCase();
  if (key === 'gym') return 'Desafio de Ginasio';
  if (key === 'pvp') return 'Batalha PvP';
  if (key === 'raid') return 'Raid';
  return 'Batalha Pokemon';
};

const SOCIAL_XP_CANVAS_PREFIX = '💬 xp social convertido:';
const isSocialXpCanvasLine = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .startsWith(SOCIAL_XP_CANVAS_PREFIX);

const sanitizeCanvasLogs = (logs = []) => (Array.isArray(logs) ? logs : []).filter((entry) => !isSocialXpCanvasLine(entry));

const sanitizeCanvasActionText = (value) => {
  if (!isSocialXpCanvasLine(value)) return value;
  return 'Turno atualizado.';
};

const pickBattleActionText = ({ logs = [], fallback = '' }) => {
  const candidates = Array.isArray(logs) ? logs : [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const entry = trimLoreText(candidates[index], 110);
    if (!entry) continue;
    if (entry.startsWith('❤️') || entry.startsWith('➡️') || entry.startsWith('💡')) continue;
    return entry;
  }
  return trimLoreText(fallback || 'Aguardando acao.', 110) || 'Aguardando acao.';
};

const withBattleCanvasFrame = async ({ text, battleSnapshot, logs = [], caption = null, modeLabel = null, actionText = null, extra = {}, pokemonSnapshotFallback = null }) => {
  const fallback = withPokemonImage({
    text,
    pokemonSnapshot: pokemonSnapshotFallback || battleSnapshot?.enemy || battleSnapshot?.my || null,
    caption,
    extra,
  });

  if (!BATTLE_CANVAS_ENABLED) return fallback;
  if (!battleSnapshot?.my || !battleSnapshot?.enemy) return fallback;

  try {
    const canvasLogs = sanitizeCanvasLogs(logs);
    const safeActionText = sanitizeCanvasActionText(actionText || text);
    const buffer = await renderBattleFrameCanvas({
      leftPokemon: battleSnapshot.my,
      rightPokemon: battleSnapshot.enemy,
      turn: toInt(battleSnapshot?.turn, 1),
      biomeLabel: battleSnapshot?.biome?.label || battleSnapshot?.travel?.regionKey || '',
      modeLabel: modeLabel || resolveBattleModeLabel(battleSnapshot?.mode),
      actionText: pickBattleActionText({ logs: canvasLogs, fallback: safeActionText }),
      effectTag: inferEffectTagFromLogs(canvasLogs),
      logLines: canvasLogs,
    });

    return {
      ok: true,
      text,
      imageBuffer: buffer,
      caption: caption || text,
      ...extra,
    };
  } catch (error) {
    logger.warn('Falha ao renderizar frame canvas da batalha RPG.', {
      mode: battleSnapshot?.mode || null,
      error: error.message,
    });
    return fallback;
  }
};

const shouldRenamePokemonAfterEvolution = ({ currentNickname, currentSpeciesName }) => {
  if (!currentNickname) return true;
  return normalizeNameKey(currentNickname) === normalizeNameKey(currentSpeciesName);
};

const resolveEvolutionOutcome = async ({ myPokemon, pokemonProgress, updatedBattleSnapshot }) => {
  const evolution = await resolveEvolutionByLevel({
    pokeId: myPokemon.poke_id,
    level: pokemonProgress.level,
  });

  if (!evolution || evolution?.to?.pokeId === myPokemon.poke_id) {
    return null;
  }

  const currentMaxHp = Math.max(1, toInt(updatedBattleSnapshot?.my?.maxHp, myPokemon.current_hp || 1));
  const currentHp = Math.max(0, toInt(updatedBattleSnapshot?.my?.currentHp, myPokemon.current_hp || 0));
  const hpRatio = clamp(currentHp / currentMaxHp, 0, 1);

  let natureData = null;
  if (myPokemon?.nature_key) {
    try {
      natureData = await getNature(myPokemon.nature_key);
    } catch (error) {
      logger.debug('Nature não carregada durante evolução.', {
        natureKey: myPokemon.nature_key,
        error: error.message,
      });
    }
  }
  const abilityData = myPokemon?.ability_key
    ? {
        name: myPokemon.ability_key,
      }
    : null;

  const evolvedSnapshot = await buildPokemonSnapshot({
    pokemonData: evolution.pokemonData,
    level: pokemonProgress.level,
    currentHp: null,
    ivs: myPokemon.ivs_json,
    storedMoves: myPokemon.moves_json,
    natureData,
    abilityData,
    isShiny: Boolean(myPokemon.is_shiny),
  });

  const evolvedHp = clamp(Math.max(1, Math.round(evolvedSnapshot.maxHp * hpRatio)), 0, evolvedSnapshot.maxHp);
  const resolvedNickname = shouldRenamePokemonAfterEvolution({
    currentNickname: myPokemon.nickname,
    currentSpeciesName: evolution.from.name,
  })
    ? evolution.to.name
    : undefined;

  const updatedBattleMy = {
    ...updatedBattleSnapshot.my,
    ...evolvedSnapshot,
    id: updatedBattleSnapshot?.my?.id || myPokemon.id,
    xp: pokemonProgress.xp,
    currentHp: evolvedHp,
    level: pokemonProgress.level,
  };

  return {
    evolution,
    updatedBattleMy,
    updatePayload: {
      pokeId: evolution.to.pokeId,
      nickname: resolvedNickname,
      movesJson: evolvedSnapshot.moves,
      currentHp: evolvedHp,
      level: pokemonProgress.level,
      xp: pokemonProgress.xp,
      isShiny: Boolean(myPokemon.is_shiny),
    },
  };
};

const withTransaction = async (runner) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await runner(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const handleStart = async ({ ownerJid, commandPrefix }) => {
  const existing = await getPlayerByJid(ownerJid);
  if (existing) {
    return {
      ok: true,
      text: buildStartText({
        isNewPlayer: false,
        starterPokemon: { id: 0, name: '' },
        prefix: commandPrefix,
      }),
    };
  }

  const starterData = await withTransaction(async (connection) => {
    await createPlayer({ jid: ownerJid, level: 1, xp: 0, gold: STARTER_GOLD }, connection);
    await upsertTravelState(
      {
        ownerJid,
        regionKey: DEFAULT_REGION,
        locationKey: null,
        locationAreaKey: null,
      },
      connection,
    );
    const starter = await createStarterPokemon({ ownerJid, connection });
    await addInventoryItem({ ownerJid, itemKey: 'pokeball', quantity: STARTER_POKEBALL_QTY }, connection);
    await addInventoryItem({ ownerJid, itemKey: 'potion', quantity: STARTER_POTION_QTY }, connection);
    return starter;
  });

  recordRpgPlayerCreated();

  return {
    ok: true,
    text: buildStartText({
      isNewPlayer: true,
      starterPokemon: {
        id: starterData.row?.id,
        name: starterData.snapshot.displayName,
        displayName: starterData.snapshot.displayName,
        isShiny: Boolean(starterData.snapshot?.isShiny),
        flavorText: trimLoreText(starterData.snapshot?.flavorText || '', 160),
      },
      prefix: commandPrefix,
    }),
  };
};

const toPercent = (value, total, decimals = 0) => {
  const safeTotal = Math.max(0, toInt(total, 0));
  if (safeTotal <= 0) return 0;
  const ratio = clamp(toInt(value, 0) / safeTotal, 0, 1);
  const factor = 10 ** Math.max(0, toInt(decimals, 0));
  return Math.round(ratio * 100 * factor) / factor;
};

const resolvePlayerLevelProgress = ({ level, xp }) => {
  const safeXp = Math.max(0, toInt(xp, 0));
  const levelByXp = calculatePlayerLevelFromXp(safeXp);
  const fallbackLevel = clamp(toInt(level, levelByXp) || levelByXp, 1, PLAYER_MAX_LEVEL);
  const resolvedLevel = clamp(levelByXp, 1, PLAYER_MAX_LEVEL) || fallbackLevel;
  const isMaxLevel = resolvedLevel >= PLAYER_MAX_LEVEL;
  const currentLevelStartXp = isMaxLevel ? safeXp : Math.max(0, Math.floor(PLAYER_LEVEL_XP_FACTOR * (resolvedLevel - 1) * (resolvedLevel - 1)));
  const nextLevel = isMaxLevel ? resolvedLevel : resolvedLevel + 1;
  const nextLevelXp = isMaxLevel ? safeXp : Math.max(currentLevelStartXp + 1, Math.floor(PLAYER_LEVEL_XP_FACTOR * resolvedLevel * resolvedLevel));
  const xpNeededForNextLevel = Math.max(0, nextLevelXp - currentLevelStartXp);
  const xpIntoLevel = isMaxLevel ? 0 : clamp(safeXp - currentLevelStartXp, 0, xpNeededForNextLevel);
  const xpToNextLevel = isMaxLevel ? 0 : Math.max(0, nextLevelXp - safeXp);
  const xpProgressPct = isMaxLevel ? 100 : toPercent(xpIntoLevel, Math.max(1, xpNeededForNextLevel), 0);
  return {
    level: resolvedLevel,
    isMaxLevel,
    currentLevelStartXp,
    nextLevel,
    nextLevelXp,
    xpNeededForNextLevel,
    xpIntoLevel,
    xpToNextLevel,
    xpProgressPct,
  };
};

const toDateLabel = (value) => {
  const date = toDateSafe(value);
  if (!date) return null;
  return date.toISOString().slice(0, 10);
};

const toPvpOutcomeForOwner = ({ challenge, ownerJid }) => {
  if (!challenge || !ownerJid) return null;
  const winner = String(challenge?.winner_jid || '').trim();
  if (!winner) return null;
  return winner === ownerJid ? 'win' : 'loss';
};

const resolvePvpStreakInfo = ({ challenges = [], ownerJid }) => {
  const filtered = (Array.isArray(challenges) ? challenges : [])
    .map((entry) => ({
      outcome: toPvpOutcomeForOwner({ challenge: entry, ownerJid }),
    }))
    .filter((entry) => entry.outcome === 'win' || entry.outcome === 'loss');
  if (!filtered.length) {
    return {
      count: 0,
      type: 'none',
      label: 'Sem histórico',
    };
  }

  const type = filtered[0].outcome;
  let count = 0;
  for (const entry of filtered) {
    if (entry.outcome !== type) break;
    count += 1;
  }

  return {
    count,
    type,
    label: type === 'win' ? `${count} vitória(s)` : `${count} derrota(s)`,
  };
};

const resolveMostUsedPokemonLabel = ({ challenges = [], ownerJid, fallback = null }) => {
  const usage = new Map();
  for (const challenge of challenges || []) {
    const players = challenge?.battle_snapshot_json?.players || {};
    const pokemon = players?.[ownerJid]?.pokemon || {};
    const label = String(pokemon?.displayName || pokemon?.name || '').trim();
    if (!label) continue;
    usage.set(label, (usage.get(label) || 0) + 1);
  }

  if (!usage.size) return fallback;
  const sorted = [...usage.entries()].sort((a, b) => b[1] - a[1]);
  const [label, count] = sorted[0];
  return `${toTitleCase(label)} (${count}x)`;
};

const resolveBestRecentVictory = ({ challenges = [], ownerJid }) => {
  let best = null;
  for (const challenge of challenges || []) {
    if (String(challenge?.winner_jid || '').trim() !== ownerJid) continue;
    const opponentJid = resolvePvpOpponentJid(challenge, ownerJid);
    if (!opponentJid) continue;
    const players = challenge?.battle_snapshot_json?.players || {};
    const opponentSnapshot = players?.[opponentJid]?.pokemon || {};
    const opponentLevel = Math.max(1, toInt(opponentSnapshot?.level, 1));
    if (!best || opponentLevel > best.opponentLevel) {
      best = {
        opponentJid,
        opponentLevel,
        updatedAt: challenge?.updated_at || challenge?.created_at || null,
      };
    }
  }
  if (!best) return null;
  return `${toMentionLabel(best.opponentJid)} (Lv.${best.opponentLevel}, ${toDateLabel(best.updatedAt) || 'sem data'})`;
};

const resolveMissionCompletionPercent = (view = {}) => {
  const targets = view?.target || {};
  const currentValues = [MISSION_KEYS.EXPLORE, MISSION_KEYS.WIN, MISSION_KEYS.CAPTURE].map((key) => Math.max(0, toInt(view?.[key], 0)));
  const targetValues = [MISSION_KEYS.EXPLORE, MISSION_KEYS.WIN, MISSION_KEYS.CAPTURE].map((key) => Math.max(1, toInt(targets?.[key], 1)));
  const currentTotal = currentValues.reduce((acc, value, index) => acc + Math.min(value, targetValues[index]), 0);
  const targetTotal = targetValues.reduce((acc, value) => acc + value, 0);
  return toPercent(currentTotal, targetTotal, 0);
};

const resolveProfileAchievements = ({ pokedexUnique = 0, pvpWins = 0, shinyCount = 0, karmaScore = 0, coopContribution = 0, eventContribution = 0 }) => {
  const badges = [];
  if (pokedexUnique >= 10) badges.push('📘 Pokédex 10+');
  if (pokedexUnique >= 25) badges.push('📗 Pokédex 25+');
  if (pokedexUnique >= 50) badges.push('📙 Pokédex 50+');
  if (pvpWins >= 100) badges.push('🥊 100 vitórias PvP');
  if (shinyCount > 0) badges.push('✨ Primeiro shiny');
  if (karmaScore >= KARMA_BONUS_THRESHOLD) badges.push('🌟 Karma de elite');
  if (coopContribution > 0) badges.push('🤝 Contribuição coop');
  if (eventContribution > 0) badges.push('🎯 Contribuição em evento');
  if (!badges.length) badges.push('🚀 Primeiros passos');
  return badges.slice(0, 8);
};

const resolveProfileGoals = ({ pokedexUnique = 0, dailyMission, weeklyMission, karmaScore = 0, pvpWeeklyRank = null, pvpWeeklyPoints = 0 }) => {
  const goals = [];
  const milestones = [10, 25, 50, 100, 250, 500];
  const nextMilestone = milestones.find((value) => value > pokedexUnique);
  if (nextMilestone) {
    goals.push(`📘 Faltam ${nextMilestone - pokedexUnique} registros para Pokédex ${nextMilestone}.`);
  }

  const dailyRemaining = Math.max(0, toInt(dailyMission?.target?.[MISSION_KEYS.EXPLORE], 0) - toInt(dailyMission?.explorar, 0)) + Math.max(0, toInt(dailyMission?.target?.[MISSION_KEYS.WIN], 0) - toInt(dailyMission?.vitorias, 0)) + Math.max(0, toInt(dailyMission?.target?.[MISSION_KEYS.CAPTURE], 0) - toInt(dailyMission?.capturas, 0));
  if (dailyRemaining > 0) {
    goals.push(`☀️ Diária: faltam ${dailyRemaining} ação(ões) para concluir.`);
  } else if (dailyMission?.completed && !dailyMission?.claimed) {
    goals.push('🎁 Recompensa diária pronta para resgate automático.');
  }

  if (karmaScore < KARMA_BONUS_THRESHOLD) {
    goals.push(`🌟 Ganhe ${KARMA_BONUS_THRESHOLD - karmaScore} de karma para ativar bônus social.`);
  } else if (Number.isFinite(Number(pvpWeeklyRank)) && pvpWeeklyRank > 1) {
    goals.push(`🏆 PvP semanal: você está em #${pvpWeeklyRank} com ${pvpWeeklyPoints} pts.`);
  } else if (weeklyMission && !weeklyMission.completed) {
    const weeklyRemaining = Math.max(0, toInt(weeklyMission?.target?.[MISSION_KEYS.EXPLORE], 0) - toInt(weeklyMission?.explorar, 0)) + Math.max(0, toInt(weeklyMission?.target?.[MISSION_KEYS.WIN], 0) - toInt(weeklyMission?.vitorias, 0)) + Math.max(0, toInt(weeklyMission?.target?.[MISSION_KEYS.CAPTURE], 0) - toInt(weeklyMission?.capturas, 0));
    goals.push(`📅 Semanal: faltam ${weeklyRemaining} ação(ões) para concluir.`);
  }

  while (goals.length < 3) {
    goals.push('🧭 Explore biomas e varie tipos para evoluir mais rápido.');
  }
  return goals.slice(0, 3);
};

const loadProfileProgressContext = async ({ ownerJid, chatJid }) => {
  return withTransaction(async (connection) => {
    const mission = await ensureMissionStateForUpdate({ ownerJid, connection });
    const daily = toMissionView({
      progress: mission.daily_progress_json,
      target: DAILY_MISSION_TARGET,
      claimedAt: mission.daily_claimed_at,
    });
    const weekly = toMissionView({
      progress: mission.weekly_progress_json,
      target: WEEKLY_MISSION_TARGET,
      claimedAt: mission.weekly_claimed_at,
    });

    let coop = null;
    let event = null;

    if (isGroupJid(chatJid)) {
      const { weekRefDate: coopWeekRefDate } = await ensureGroupCoopStateForUpdate({
        chatJid,
        connection,
      });
      const coopWeekly = await getGroupCoopWeekly(chatJid, coopWeekRefDate, connection);
      const coopMember = await getGroupCoopMember(chatJid, coopWeekRefDate, ownerJid, connection);
      coop = {
        weekRefDate: coopWeekRefDate,
        weekly: coopWeekly,
        member: coopMember,
      };

      const eventData = await ensureWeeklyEventForUpdate({ chatJid, connection });
      const eventMember = await getGroupEventMember(chatJid, eventData.weekRefDate, ownerJid, connection);
      event = {
        weekRefDate: eventData.weekRefDate,
        weekly: eventData.event,
        definition: eventData.definition,
        member: eventMember,
      };
    }

    return {
      daily,
      weekly,
      coop,
      event,
    };
  });
};

const handleProfile = async ({ ownerJid, chatJid, commandPrefix }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return {
      ok: true,
      text: buildNeedStartText(commandPrefix),
    };
  }

  const currentWeekRefDate = getCurrentWeekRefDate();

  const [active, teamRows, karmaProfile, socialSummary, inventoryRows, uniquePokedexTotal, pokedexTotal, latestPokedexRows, pvpWeeklyStats, pvpWeeklyRank, pvpLifetimeStats, recentPvpChallenges, profileProgress, shopCatalog] = await Promise.all([getActivePlayerPokemon(ownerJid), listPlayerPokemons(ownerJid), getKarmaProfile(ownerJid), getSocialSummaryByOwner(ownerJid), getInventoryItems(ownerJid), countPokedexEntries(ownerJid), resolveNationalPokedexTotal(), listPokedexEntries(ownerJid, 1), getPvpWeeklyStatsByOwner(currentWeekRefDate, ownerJid), getPvpWeeklyRankByOwner(currentWeekRefDate, ownerJid), getPvpLifetimeStatsByOwner(ownerJid), listRecentFinishedPvpByPlayer(ownerJid, 20), loadProfileProgressContext({ ownerJid, chatJid }), getShopCatalog()]);
  let activeDisplay = null;
  let activeSnapshot = null;

  if (active) {
    try {
      const snapshot = await buildPlayerBattleSnapshot({ playerPokemonRow: active });
      activeSnapshot = snapshot;
      activeDisplay = {
        id: active.id,
        name: snapshot.name,
        displayName: active.nickname || snapshot.displayName,
        level: active.level,
        currentHp: active.current_hp,
        maxHp: snapshot.maxHp,
        types: Array.isArray(snapshot?.types) ? snapshot.types : [],
        isShiny: Boolean(active.is_shiny),
        imageUrl: snapshot.imageUrl || null,
        natureName: snapshot?.nature?.name || active.nature_key || null,
        abilityName: snapshot?.ability?.name || active.ability_name || active.ability_key || null,
        abilityEffectText: snapshot?.ability?.effectText || null,
        flavorText: snapshot?.flavorText || null,
        genus: snapshot?.genus || null,
      };
    } catch (error) {
      logger.warn('Falha ao montar perfil do Pokemon ativo no RPG.', {
        ownerJid,
        pokemonId: active.id,
        error: error.message,
      });
    }
  }

  let latestCapture = null;
  const latestCaptureEntry = latestPokedexRows?.[0] || null;
  if (latestCaptureEntry?.poke_id) {
    try {
      const species = await getSpecies(latestCaptureEntry.poke_id);
      const localizedName = getLocalizedName(species?.names, species?.name || `pokemon-${latestCaptureEntry.poke_id}`);
      latestCapture = {
        pokeId: latestCaptureEntry.poke_id,
        name: toTitleCase(localizedName || species?.name || `pokemon-${latestCaptureEntry.poke_id}`),
        capturedAt: latestCaptureEntry?.first_captured_at || null,
      };
    } catch {
      latestCapture = {
        pokeId: latestCaptureEntry.poke_id,
        name: `Pokemon #${latestCaptureEntry.poke_id}`,
        capturedAt: latestCaptureEntry?.first_captured_at || null,
      };
    }
  }

  const pvpMatchesLifetime = Math.max(0, toInt(pvpLifetimeStats?.matches_played, 0));
  const pvpWinsLifetime = Math.max(0, toInt(pvpLifetimeStats?.wins, 0));
  const pvpLossesLifetime = Math.max(0, toInt(pvpLifetimeStats?.losses, 0));
  const pvpWinRate = toPercent(pvpWinsLifetime, pvpMatchesLifetime, 0);
  const pvpKd = pvpLossesLifetime > 0 ? Math.round((pvpWinsLifetime / pvpLossesLifetime) * 100) / 100 : pvpWinsLifetime > 0 ? 'inf' : 0;
  const streak = resolvePvpStreakInfo({ challenges: recentPvpChallenges, ownerJid });
  const mostUsedPokemon = resolveMostUsedPokemonLabel({
    challenges: recentPvpChallenges,
    ownerJid,
    fallback: activeDisplay?.displayName ? `${activeDisplay.displayName} (ativo)` : null,
  });
  const bestVictory = resolveBestRecentVictory({
    challenges: recentPvpChallenges,
    ownerJid,
  });

  const dailyMission = profileProgress?.daily || {
    explorar: 0,
    vitorias: 0,
    capturas: 0,
    target: DAILY_MISSION_TARGET,
    completed: false,
    claimed: false,
  };
  const weeklyMission = profileProgress?.weekly || {
    explorar: 0,
    vitorias: 0,
    capturas: 0,
    target: WEEKLY_MISSION_TARGET,
    completed: false,
    claimed: false,
  };
  const dailyMissionPct = resolveMissionCompletionPercent(dailyMission);
  const weeklyMissionPct = resolveMissionCompletionPercent(weeklyMission);

  const coopWeekly = profileProgress?.coop?.weekly || null;
  const coopMember = profileProgress?.coop?.member || null;
  const coopContributionCapture = Math.max(0, toInt(coopMember?.capture_contribution, 0));
  const coopContributionRaid = Math.max(0, toInt(coopMember?.raid_contribution, 0));
  const coopContributionTotal = coopContributionCapture + coopContributionRaid;
  const coopRewardPending = String(coopWeekly?.status || '') === 'completed' && coopContributionTotal > 0 && !coopMember?.reward_claimed_at;

  const eventWeekly = profileProgress?.event?.weekly || null;
  const eventDefinition = profileProgress?.event?.definition || null;
  const eventMember = profileProgress?.event?.member || null;
  const eventContribution = Math.max(0, toInt(eventMember?.contribution, 0));
  const eventProgressPct = toPercent(toInt(eventWeekly?.progress_value, 0), Math.max(1, toInt(eventWeekly?.target_value, 1)), 0);
  const eventRewardPending = String(eventWeekly?.status || '') === 'completed' && eventContribution > 0 && !eventMember?.reward_claimed_at;

  const pendingRewards = [];
  if (dailyMission.completed && !dailyMission.claimed) pendingRewards.push('Missão diária');
  if (weeklyMission.completed && !weeklyMission.claimed) pendingRewards.push('Missão semanal');
  if (coopRewardPending) pendingRewards.push('Coop semanal');
  if (eventRewardPending) pendingRewards.push('Evento semanal');

  const inventoryItems = (inventoryRows || [])
    .map((entry) => ({
      key: normalizeItemToken(entry?.item_key),
      quantity: Math.max(0, toInt(entry?.quantity, 0)),
    }))
    .filter((entry) => entry.quantity > 0);
  const inventoryTop = [...inventoryItems]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5)
    .map((entry) => {
      const itemMeta = shopCatalog?.index?.get(entry.key) || null;
      return {
        key: entry.key,
        quantity: entry.quantity,
        label: itemMeta?.label || toTitleCase(entry.key),
      };
    });
  const inventoryEstimatedValue = inventoryItems.reduce((acc, entry) => {
    const itemMeta = shopCatalog?.index?.get(entry.key);
    const unitPrice = Math.max(0, toInt(itemMeta?.price, 0));
    return acc + entry.quantity * unitPrice;
  }, 0);

  const shinyCount = (teamRows || []).filter((entry) => Boolean(entry?.is_shiny)).length;
  const capturesTotal = (teamRows || []).length;
  const pokedexCompletion = toPercent(uniquePokedexTotal, Math.max(1, pokedexTotal), 0);
  const weeklyMatches = Math.max(0, toInt(pvpWeeklyStats?.matches_played, 0));
  const weeklyWins = Math.max(0, toInt(pvpWeeklyStats?.wins, 0));
  const weeklyLosses = Math.max(0, toInt(pvpWeeklyStats?.losses, 0));
  const weeklyPoints = Math.max(0, toInt(pvpWeeklyStats?.points, 0));
  const playerXp = Math.max(0, toInt(player?.xp, 0));
  const playerLevelProgress = resolvePlayerLevelProgress({
    level: player?.level,
    xp: playerXp,
  });

  const karmaScore = Math.max(0, toInt(karmaProfile?.karma_score, 0));
  const achievements = resolveProfileAchievements({
    pokedexUnique: uniquePokedexTotal,
    pvpWins: pvpWinsLifetime,
    shinyCount,
    karmaScore,
    coopContribution: coopContributionTotal,
    eventContribution,
  });
  const goals = resolveProfileGoals({
    pokedexUnique: uniquePokedexTotal,
    dailyMission,
    weeklyMission,
    karmaScore,
    pvpWeeklyRank,
    pvpWeeklyPoints: weeklyPoints,
  });

  const profileData = {
    summary: {
      weekRefDate: currentWeekRefDate,
      pvpWeeklyRank,
      streak,
      level: playerLevelProgress.level,
      nextLevel: playerLevelProgress.nextLevel,
      xpToNextLevel: playerLevelProgress.xpToNextLevel,
      xpProgressPct: playerLevelProgress.xpProgressPct,
      xpIntoLevel: playerLevelProgress.xpIntoLevel,
      xpNeededForNextLevel: playerLevelProgress.xpNeededForNextLevel,
      isMaxLevel: playerLevelProgress.isMaxLevel,
    },
    combat: {
      weeklyMatches,
      weeklyWins,
      weeklyLosses,
      lifetimeMatches: pvpMatchesLifetime,
      lifetimeWins: pvpWinsLifetime,
      lifetimeLosses: pvpLossesLifetime,
      winRatePct: pvpWinRate,
      kdRatio: pvpKd,
      averageDamage: null,
      bestVictory,
      mostUsedPokemon,
    },
    collection: {
      capturesTotal,
      captureRatePct: null,
      pokedexUnique: uniquePokedexTotal,
      pokedexTotal,
      pokedexCompletionPct: pokedexCompletion,
      shinyCount,
      rareCount: null,
      latestCapture,
    },
    progression: {
      dailyMission,
      weeklyMission,
      dailyMissionPct,
      weeklyMissionPct,
      event: eventWeekly
        ? {
            key: eventWeekly.event_key || null,
            label: eventDefinition?.label || toTitleCase(eventWeekly.event_key),
            progress: toInt(eventWeekly.progress_value, 0),
            target: Math.max(1, toInt(eventWeekly.target_value, 1)),
            progressPct: eventProgressPct,
            status: eventWeekly.status || 'active',
          }
        : null,
      pendingRewards,
    },
    economy: {
      gold: Math.max(0, toInt(player?.gold, 0)),
      totalSpent: null,
      inventoryTop,
      inventoryEstimatedValue,
    },
    social: {
      karmaScore,
      karmaBonusActive: karmaScore >= KARMA_BONUS_THRESHOLD,
      karmaThreshold: KARMA_BONUS_THRESHOLD,
      positiveVotes: Math.max(0, toInt(karmaProfile?.positive_votes, 0)),
      negativeVotes: Math.max(0, toInt(karmaProfile?.negative_votes, 0)),
      linksTotal: Math.max(0, toInt(socialSummary?.linksTotal, 0)),
      interactionsTotal: Math.max(0, toInt(socialSummary?.interactionsTotal, 0)),
      topFriendship: Math.max(0, toInt(socialSummary?.topFriendship, 0)),
      topRivalry: Math.max(0, toInt(socialSummary?.topRivalry, 0)),
      coopCaptureContribution: coopContributionCapture,
      coopRaidContribution: coopContributionRaid,
      eventContribution,
    },
    achievements,
    goals,
  };

  const text = buildProfileText({
    player,
    activePokemon: activeDisplay,
    profile: profileData,
    prefix: commandPrefix,
  });

  return withProfileCanvasCard({
    text,
    profileCanvas: {
      trainerLabel: toMentionLabel(ownerJid),
      generatedAtLabel: toDateLabel(__timeNowMs()),
      activePokemon: {
        displayName: activeDisplay?.displayName || activeDisplay?.name || null,
        name: activeDisplay?.name || null,
        level: activeDisplay?.level || null,
        currentHp: activeDisplay?.currentHp || null,
        maxHp: activeDisplay?.maxHp || null,
        imageUrl: activeDisplay?.imageUrl || activeSnapshot?.imageUrl || null,
        isShiny: Boolean(activeDisplay?.isShiny),
        types: Array.isArray(activeDisplay?.types) && activeDisplay.types.length ? activeDisplay.types : Array.isArray(activeSnapshot?.types) ? activeSnapshot.types : [],
      },
      summary: {
        level: playerLevelProgress.level,
        xp: playerXp,
        gold: Math.max(0, toInt(player?.gold, 0)),
        pvpWeeklyRank,
        streakLabel: streak?.label || null,
        xpToNextLevel: playerLevelProgress.xpToNextLevel,
        nextLevel: playerLevelProgress.nextLevel,
        xpProgressPct: playerLevelProgress.xpProgressPct,
      },
      profileText: text,
    },
    pokemonSnapshotFallback: activeSnapshot,
    caption: `📘 Perfil RPG de ${toMentionLabel(ownerJid)} | Lv.${playerLevelProgress.level}`,
    extra: {
      preferResultCaption: true,
    },
  });
};

const handleTeam = async ({ ownerJid, commandPrefix }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return {
      ok: true,
      text: buildNeedStartText(commandPrefix),
    };
  }

  const rows = await listPlayerPokemons(ownerJid);

  const hydrated = [];
  for (const row of rows) {
    try {
      hydrated.push(await loadPokemonDisplayData(row));
    } catch {
      hydrated.push({
        id: row.id,
        pokeId: row.poke_id,
        name: `pokemon-${row.poke_id}`,
        displayName: row.nickname || `Pokemon #${row.poke_id}`,
        level: row.level,
        currentHp: row.current_hp,
        maxHp: row.current_hp,
        isShiny: Boolean(row.is_shiny),
        isActive: row.is_active,
        natureName: row.nature_key || null,
        abilityName: row.ability_name || row.ability_key || null,
      });
    }
  }

  return {
    ok: true,
    text: buildTeamText({
      team: hydrated,
      prefix: commandPrefix,
    }),
  };
};

const handleChoose = async ({ ownerJid, selectedPokemonId, commandPrefix }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return { ok: true, text: buildNeedStartText(commandPrefix) };
  }

  const pokemonId = toInt(selectedPokemonId, NaN);
  if (!Number.isFinite(pokemonId) || pokemonId <= 0) {
    return { ok: true, text: buildChooseErrorText(commandPrefix) };
  }

  await ensureNoExpiredBattle(ownerJid);
  const activeBattle = await getBattleStateByOwner(ownerJid);
  if (activeBattle) {
    return { ok: true, text: buildBattleAlreadyActiveText(commandPrefix) };
  }

  const target = await getPlayerPokemonById(ownerJid, pokemonId);
  if (!target) {
    return { ok: true, text: buildChooseErrorText(commandPrefix) };
  }

  await withTransaction(async (connection) => {
    await setActivePokemon(ownerJid, pokemonId, connection);
  });

  return {
    ok: true,
    text: buildChooseSuccessText({
      pokemon: {
        id: target.id,
        name: target.nickname || `Pokemon #${target.poke_id}`,
        displayName: target.nickname || `Pokemon #${target.poke_id}`,
        isShiny: Boolean(target.is_shiny),
      },
      prefix: commandPrefix,
    }),
  };
};

const handleExplore = async ({ ownerJid, chatJid, commandPrefix }) => {
  return withTransaction(async (connection) => {
    const player = await getPlayerByJidForUpdate(ownerJid, connection);
    if (!player) {
      return { ok: true, text: buildNeedStartText(commandPrefix) };
    }

    await ensureNoExpiredBattle(ownerJid, connection);
    const existingBattle = await getBattleStateByOwnerForUpdate(ownerJid, connection);
    if (existingBattle) {
      return { ok: true, text: buildBattleAlreadyActiveText(commandPrefix) };
    }

    const activePokemonRow = await getActivePlayerPokemonForUpdate(ownerJid, connection);
    if (!activePokemonRow) {
      return { ok: true, text: buildNeedActivePokemonText(commandPrefix) };
    }

    const socialBonus = await applySocialXpConversion({
      ownerJid,
      chatJid,
      connection,
      actionKey: 'explore',
    });

    let playerXpCurrent = Math.max(0, toInt(player.xp, 0));
    const playerGoldCurrent = Math.max(0, toInt(player.gold, 0));
    if (socialBonus.playerXpBonus > 0) {
      playerXpCurrent = Math.max(0, playerXpCurrent + socialBonus.playerXpBonus);
      const playerLevelForEncounter = calculatePlayerLevelFromXp(playerXpCurrent);
      await updatePlayerProgress(
        {
          jid: ownerJid,
          level: playerLevelForEncounter,
          xp: playerXpCurrent,
          gold: playerGoldCurrent,
        },
        connection,
      );
    }

    let activePokemonState = activePokemonRow;
    if (socialBonus.pokemonXpBonus > 0) {
      const socialPokemonProgress = applyPokemonXpGain({
        currentLevel: activePokemonRow.level,
        currentXp: activePokemonRow.xp,
        gainedXp: socialBonus.pokemonXpBonus,
      });
      await updatePlayerPokemonState(
        {
          id: activePokemonRow.id,
          ownerJid,
          level: socialPokemonProgress.level,
          xp: socialPokemonProgress.xp,
          currentHp: activePokemonRow.current_hp,
        },
        connection,
      );
      activePokemonState = {
        ...activePokemonRow,
        level: socialPokemonProgress.level,
        xp: socialPokemonProgress.xp,
      };
    }

    const activeBattleSnapshot = await buildPlayerBattleSnapshot({
      playerPokemonRow: activePokemonState,
    });
    if (activeBattleSnapshot.currentHp <= 0) {
      return { ok: true, text: buildPokemonFaintedText(commandPrefix) };
    }

    const biome = await resolveBiomeForChat(chatJid, connection);
    const travel = await resolveTravelStateForOwner({ ownerJid, connection });
    const encounterPool = await resolveTravelEncounterPool(travel?.location_area_key);
    const { enemySnapshot } = await createWildEncounter({
      playerLevel: activePokemonState.level,
      preferredTypes: biome?.preferredTypes || [],
      preferredHabitats: biome?.preferredHabitats || [],
      encounterPool,
    });

    const battleSnapshot = {
      turn: 1,
      startedAt: __timeNowIso(),
      mode: 'wild',
      biome: biome
        ? {
            key: biome.key,
            label: biome.label,
          }
        : null,
      travel: travel
        ? {
            regionKey: travel.region_key || null,
            locationKey: travel.location_key || null,
            locationAreaKey: travel.location_area_key || null,
          }
        : null,
      my: {
        ...activeBattleSnapshot,
        id: activePokemonState.id,
        xp: activePokemonState.xp,
      },
      enemy: enemySnapshot,
    };

    await upsertBattleState(
      {
        chatJid: buildBattleChatKey(chatJid, ownerJid),
        ownerJid,
        myPokemonId: activePokemonState.id,
        battleSnapshot,
        turn: 1,
        expiresAt: nowPlusTtlDate(),
      },
      connection,
    );

    const mission = await applyMissionEvent({
      ownerJid,
      eventKey: MISSION_KEYS.EXPLORE,
      connection,
    });

    recordRpgBattleStarted();
    if (enemySnapshot.isShiny) {
      recordRpgShinyFound();
    }

    let text = buildBattleStartText({
      battleSnapshot,
      prefix: commandPrefix,
    });
    if (socialBonus.notice) {
      text = `${text}\n${socialBonus.notice}`;
    }
    const missionText = buildMissionRewardText(mission.notices || []);
    if (missionText) {
      text = `${text}\n${missionText}`;
    }

    const frameLogs = [`${battleSnapshot.enemy.displayName} apareceu para batalha.`];
    if (socialBonus.notice) {
      frameLogs.push(socialBonus.notice);
    }

    return withBattleCanvasFrame({
      text,
      battleSnapshot,
      logs: frameLogs,
      actionText: 'Encontro iniciado.',
      modeLabel: battleSnapshot.mode === 'gym' ? 'Desafio de Ginasio' : 'Batalha Selvagem',
      caption: enemySnapshot.isShiny ? `✨ UM POKEMON SHINY APARECEU! ✨\n${battleSnapshot.enemy.displayName} Lv.${battleSnapshot.enemy.level}` : `🐾 Um ${battleSnapshot.enemy.displayName} Lv.${battleSnapshot.enemy.level} apareceu!\nUse ${commandPrefix}rpg atacar ou ${commandPrefix}rpg capturar`,
      pokemonSnapshotFallback: battleSnapshot.enemy,
    });
  });
};

const resolveBiomeForGym = async ({ chatJid, connection = null }) => {
  const biome = await resolveBiomeForChat(chatJid, connection);
  if (biome) return biome;
  return BIOME_DEFINITIONS[randomFromArray(BIOME_KEYS)];
};

const handleGym = async ({ ownerJid, chatJid, commandPrefix }) => {
  return withTransaction(async (connection) => {
    const player = await getPlayerByJidForUpdate(ownerJid, connection);
    if (!player) {
      return { ok: true, text: buildNeedStartText(commandPrefix) };
    }

    await ensureNoExpiredBattle(ownerJid, connection);
    const existingBattle = await getBattleStateByOwnerForUpdate(ownerJid, connection);
    if (existingBattle) {
      return { ok: true, text: buildBattleAlreadyActiveText(commandPrefix) };
    }

    const activePokemonRow = await getActivePlayerPokemonForUpdate(ownerJid, connection);
    if (!activePokemonRow) {
      return { ok: true, text: buildNeedActivePokemonText(commandPrefix) };
    }

    const activeBattleSnapshot = await buildPlayerBattleSnapshot({
      playerPokemonRow: activePokemonRow,
    });
    if (activeBattleSnapshot.currentHp <= 0) {
      return { ok: true, text: buildPokemonFaintedText(commandPrefix) };
    }

    const biome = await resolveBiomeForGym({ chatJid, connection });
    const travel = await resolveTravelStateForOwner({ ownerJid, connection });
    const encounterPool = await resolveTravelEncounterPool(travel?.location_area_key);
    const { enemySnapshot } = await createWildEncounter({
      playerLevel: activePokemonRow.level,
      preferredTypes: biome?.preferredTypes || [],
      preferredHabitats: biome?.preferredHabitats || [],
      encounterPool,
    });

    const gymEnemy = {
      ...enemySnapshot,
      isGymBoss: true,
      displayName: `${enemySnapshot.displayName} (Líder)`,
    };

    const battleSnapshot = {
      turn: 1,
      startedAt: __timeNowIso(),
      mode: 'gym',
      biome: biome
        ? {
            key: biome.key,
            label: biome.label,
          }
        : null,
      travel: travel
        ? {
            regionKey: travel.region_key || null,
            locationKey: travel.location_key || null,
            locationAreaKey: travel.location_area_key || null,
          }
        : null,
      my: {
        ...activeBattleSnapshot,
        id: activePokemonRow.id,
        xp: activePokemonRow.xp,
      },
      enemy: gymEnemy,
    };

    await upsertBattleState(
      {
        chatJid: buildBattleChatKey(chatJid, ownerJid),
        ownerJid,
        myPokemonId: activePokemonRow.id,
        battleSnapshot,
        turn: 1,
        expiresAt: nowPlusTtlDate(),
      },
      connection,
    );

    recordRpgBattleStarted();
    if (gymEnemy.isShiny) {
      recordRpgShinyFound();
    }

    const text = buildBattleStartText({
      battleSnapshot,
      prefix: commandPrefix,
    });

    return withBattleCanvasFrame({
      text,
      battleSnapshot,
      logs: [`${battleSnapshot.enemy.displayName} aceitou o desafio de ginasio.`],
      actionText: 'Batalha de ginasio iniciada.',
      modeLabel: 'Desafio de Ginasio',
      caption: `🏟️ Ginasio (${biome?.label || 'Desafio'})\n${battleSnapshot.enemy.displayName} Lv.${battleSnapshot.enemy.level}`,
      pokemonSnapshotFallback: battleSnapshot.enemy,
    });
  });
};

const handleAttack = async ({ ownerJid, moveSlot, commandPrefix }) => {
  return withTransaction(async (connection) => {
    await ensureNoExpiredBattle(ownerJid, connection);

    const battleRow = await getBattleStateByOwnerForUpdate(ownerJid, connection);
    if (!battleRow) {
      return { ok: true, text: buildNoBattleText(commandPrefix) };
    }

    const battleSnapshot = parseBattleSnapshot(battleRow);
    if (!battleSnapshot) {
      await deleteBattleStateByOwner(ownerJid, connection);
      return { ok: true, text: buildNoBattleText(commandPrefix) };
    }

    const myPokemon = await getPlayerPokemonByIdForUpdate(ownerJid, battleRow.my_pokemon_id, connection);
    if (!myPokemon) {
      await deleteBattleStateByOwner(ownerJid, connection);
      return { ok: true, text: buildNoBattleText(commandPrefix) };
    }

    const selectedMoveIndex = Math.max(0, toInt(moveSlot, 1) - 1);
    const selectedMove = Array.isArray(battleSnapshot?.my?.moves) ? battleSnapshot.my.moves[selectedMoveIndex] : null;
    const selectedMoveLore = trimLoreText(selectedMove?.loreText || selectedMove?.shortEffect || '', 150);

    const turnResult = resolveBattleTurn({
      battleSnapshot,
      playerMoveSlot: moveSlot,
    });

    if (!turnResult.validTurn) {
      const frameLogs = [...turnResult.logs, ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : [])];
      const text = buildBattleTurnText({
        logs: frameLogs,
        battleSnapshot,
        prefix: commandPrefix,
        rewards: null,
      });
      return withBattleCanvasFrame({
        text,
        battleSnapshot,
        logs: frameLogs,
        modeLabel: battleSnapshot.mode === 'gym' ? 'Desafio de Ginasio' : 'Batalha Selvagem',
        actionText: frameLogs[frameLogs.length - 1] || 'Escolha outro movimento.',
        caption: `⚔️ Batalha: ${battleSnapshot.enemy?.displayName || 'Inimigo'} Lv.${battleSnapshot.enemy?.level || 1}\nUse ${commandPrefix}rpg atacar`,
        pokemonSnapshotFallback: battleSnapshot.enemy || battleSnapshot.my,
      });
    }

    const updatedSnapshot = turnResult.snapshot;
    const myPokemonFainted = toInt(updatedSnapshot?.my?.currentHp, 0) <= 0;
    const enemyPokemonFainted = toInt(updatedSnapshot?.enemy?.currentHp, 0) <= 0;
    const winner = myPokemonFainted ? 'enemy' : enemyPokemonFainted ? 'player' : turnResult.winner;
    const sourceChatJid = extractSourceChatFromBattleKey(battleRow.chat_jid);

    if (winner === 'player') {
      const rewards = resolveVictoryRewards(updatedSnapshot);
      const socialBonus = await applySocialXpConversion({
        ownerJid,
        chatJid: sourceChatJid,
        connection,
        actionKey: 'attack',
      });
      const rewardWithSocial = {
        ...rewards,
        playerXp: rewards.playerXp + Math.max(0, socialBonus.playerXpBonus || 0),
        pokemonXp: rewards.pokemonXp + Math.max(0, socialBonus.pokemonXpBonus || 0),
      };
      const player = await getPlayerByJidForUpdate(ownerJid, connection);

      const pokemonProgress = applyPokemonXpGain({
        currentLevel: myPokemon.level,
        currentXp: myPokemon.xp,
        gainedXp: rewardWithSocial.pokemonXp,
      });

      const playerXp = toInt(player?.xp, 0) + rewardWithSocial.playerXp;
      const playerGold = Math.max(0, toInt(player?.gold, 0) + rewardWithSocial.gold);
      const playerLevel = calculatePlayerLevelFromXp(playerXp);

      const evolutionOutcome = await resolveEvolutionOutcome({
        myPokemon,
        pokemonProgress,
        updatedBattleSnapshot: updatedSnapshot,
      });

      const myFinalSnapshot = evolutionOutcome?.updatedBattleMy || updatedSnapshot.my;
      const evolutionPayload = evolutionOutcome?.updatePayload || null;

      await updatePlayerPokemonState(
        {
          id: myPokemon.id,
          ownerJid,
          level: evolutionPayload?.level ?? pokemonProgress.level,
          xp: evolutionPayload?.xp ?? pokemonProgress.xp,
          currentHp: Math.max(0, toInt(myFinalSnapshot?.currentHp, myPokemon.current_hp)),
          movesJson: evolutionPayload?.movesJson ?? null,
          pokeId: evolutionPayload?.pokeId ?? null,
          ...(evolutionPayload?.nickname !== undefined ? { nickname: evolutionPayload.nickname } : {}),
        },
        connection,
      );
      await registerEvolutionPokedexEntry({
        ownerJid,
        evolutionOutcome,
        connection,
        registerEntry: upsertPokedexEntry,
      });

      await updatePlayerProgress(
        {
          jid: ownerJid,
          level: playerLevel,
          xp: playerXp,
          gold: playerGold,
        },
        connection,
      );

      for (const item of rewards.items || []) {
        if (!item?.key || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) continue;
        await addInventoryItem(
          {
            ownerJid,
            itemKey: item.key,
            quantity: Number(item.quantity),
          },
          connection,
        );
      }
      const rewardItemNotices = (rewards.items || []).filter((item) => item?.key && Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0).map((item) => `🎁 Bônus: +${Number(item.quantity)} ${itemRewardLabel(item.key)}`);
      const socialNotices = socialBonus.notice ? [socialBonus.notice] : [];

      const mission = await applyMissionEvent({
        ownerJid,
        eventKey: MISSION_KEYS.WIN,
        connection,
      });

      recordBattleDurationFromSnapshot({
        snapshot: updatedSnapshot,
        outcome: 'player_win',
      });
      await deleteBattleStateByOwner(ownerJid, connection);

      const finalBattleSnapshot = {
        ...updatedSnapshot,
        my: myFinalSnapshot,
      };

      const text = buildBattleTurnText({
        logs: [...turnResult.logs, ...rewardItemNotices, ...socialNotices, ...(mission.notices || []), ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : [])],
        battleSnapshot: finalBattleSnapshot,
        prefix: commandPrefix,
        rewards: rewardWithSocial,
        evolution: evolutionOutcome
          ? {
              fromName: evolutionOutcome.evolution.from.name,
              toName: evolutionOutcome.evolution.to.name,
            }
          : null,
      });

      const imageTarget = evolutionOutcome ? finalBattleSnapshot.my : finalBattleSnapshot.enemy;
      if (evolutionOutcome) {
        recordRpgEvolution();
      }

      const frameLogs = [...turnResult.logs, ...rewardItemNotices, ...socialNotices, ...(mission.notices || []), ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : [])];
      return withBattleCanvasFrame({
        text,
        battleSnapshot: finalBattleSnapshot,
        logs: frameLogs,
        modeLabel: finalBattleSnapshot.mode === 'gym' ? 'Desafio de Ginasio' : 'Batalha Selvagem',
        actionText: frameLogs[frameLogs.length - 1] || 'Vitoria na batalha.',
        caption: evolutionOutcome ? `✨ ${finalBattleSnapshot.my.displayName} Lv.${finalBattleSnapshot.my.level}\nPróximo: ${commandPrefix}rpg explorar` : `🏆 ${finalBattleSnapshot.enemy.displayName} derrotado!\nPróximo: ${commandPrefix}rpg explorar`,
        pokemonSnapshotFallback: imageTarget,
      });
    }

    if (winner === 'enemy') {
      await updatePlayerPokemonState(
        {
          id: myPokemon.id,
          ownerJid,
          level: myPokemon.level,
          xp: myPokemon.xp,
          currentHp: 0,
        },
        connection,
      );

      recordBattleDurationFromSnapshot({
        snapshot: updatedSnapshot,
        outcome: 'player_lose',
      });
      await deleteBattleStateByOwner(ownerJid, connection);

      const text = buildBattleTurnText({
        logs: [...turnResult.logs, ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : [])],
        battleSnapshot: updatedSnapshot,
        prefix: commandPrefix,
        rewards: null,
      });

      const frameLogs = [...turnResult.logs, ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : [])];
      return withBattleCanvasFrame({
        text,
        battleSnapshot: updatedSnapshot,
        logs: frameLogs,
        modeLabel: updatedSnapshot.mode === 'gym' ? 'Desafio de Ginasio' : 'Batalha Selvagem',
        actionText: frameLogs[frameLogs.length - 1] || 'Seu Pokemon desmaiou.',
        caption: `⚔️ ${updatedSnapshot.enemy?.displayName || 'Inimigo'} Lv.${updatedSnapshot.enemy?.level || 1}\nSeu Pokémon desmaiou`,
        pokemonSnapshotFallback: updatedSnapshot.enemy || updatedSnapshot.my,
      });
    }

    const socialBonus = await applySocialXpConversion({
      ownerJid,
      chatJid: sourceChatJid,
      connection,
      actionKey: 'attack',
    });

    if (socialBonus.playerXpBonus > 0) {
      const player = await getPlayerByJidForUpdate(ownerJid, connection);
      if (player) {
        const nextPlayerXp = Math.max(0, toInt(player.xp, 0) + socialBonus.playerXpBonus);
        const nextPlayerLevel = calculatePlayerLevelFromXp(nextPlayerXp);
        await updatePlayerProgress(
          {
            jid: ownerJid,
            level: nextPlayerLevel,
            xp: nextPlayerXp,
            gold: Math.max(0, toInt(player.gold, 0)),
          },
          connection,
        );
      }
    }

    let socialPokemonProgress = null;
    if (socialBonus.pokemonXpBonus > 0) {
      socialPokemonProgress = applyPokemonXpGain({
        currentLevel: myPokemon.level,
        currentXp: myPokemon.xp,
        gainedXp: socialBonus.pokemonXpBonus,
      });
    }

    await updatePlayerPokemonState(
      {
        id: myPokemon.id,
        ownerJid,
        level: socialPokemonProgress?.level ?? myPokemon.level,
        xp: socialPokemonProgress?.xp ?? myPokemon.xp,
        currentHp: Math.max(0, toInt(updatedSnapshot?.my?.currentHp, myPokemon.current_hp)),
      },
      connection,
    );

    await upsertBattleState(
      {
        chatJid: battleRow.chat_jid,
        ownerJid,
        myPokemonId: myPokemon.id,
        battleSnapshot: {
          ...updatedSnapshot,
          my: {
            ...(updatedSnapshot.my || {}),
            level: socialPokemonProgress?.level ?? updatedSnapshot?.my?.level ?? myPokemon.level,
            xp: socialPokemonProgress?.xp ?? updatedSnapshot?.my?.xp ?? myPokemon.xp,
          },
          turn: toInt(battleRow.turn, 1) + 1,
        },
        turn: toInt(battleRow.turn, 1) + 1,
        expiresAt: nowPlusTtlDate(),
      },
      connection,
    );

    const text = buildBattleTurnText({
      logs: [...turnResult.logs, ...(socialBonus.notice ? [socialBonus.notice] : []), ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : [])],
      battleSnapshot: updatedSnapshot,
      prefix: commandPrefix,
      rewards: null,
    });

    const frameLogs = [...turnResult.logs, ...(socialBonus.notice ? [socialBonus.notice] : []), ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : [])];
    return withBattleCanvasFrame({
      text,
      battleSnapshot: updatedSnapshot,
      logs: frameLogs,
      modeLabel: updatedSnapshot.mode === 'gym' ? 'Desafio de Ginasio' : 'Batalha Selvagem',
      actionText: frameLogs[frameLogs.length - 1] || 'Turno finalizado.',
      caption: `⚔️ ${updatedSnapshot.enemy?.displayName || 'Inimigo'} Lv.${updatedSnapshot.enemy?.level || 1}\nUse ${commandPrefix}rpg atacar`,
      pokemonSnapshotFallback: updatedSnapshot.enemy || updatedSnapshot.my,
    });
  });
};

const createCapturedPokemon = async ({ ownerJid, enemySnapshot, connection }) => {
  return createPlayerPokemon(
    {
      ownerJid,
      pokeId: enemySnapshot.pokeId,
      nickname: enemySnapshot.displayName,
      level: enemySnapshot.level,
      xp: 0,
      currentHp: enemySnapshot.maxHp,
      ivsJson: enemySnapshot.ivs,
      movesJson: enemySnapshot.moves,
      natureKey: enemySnapshot?.nature?.key || null,
      abilityKey: enemySnapshot?.ability?.key || null,
      abilityName: enemySnapshot?.ability?.name || null,
      isShiny: Boolean(enemySnapshot.isShiny),
      isActive: false,
    },
    connection,
  );
};

const requireInventoryItem = async ({ ownerJid, itemKey, connection }) => {
  const row = await getInventoryItemForUpdate(ownerJid, itemKey, connection);
  const quantity = toInt(row?.quantity, 0);
  if (quantity <= 0) return null;
  return { row, quantity };
};

const getEconomyRescueSecondsLeft = (ownerJid) => {
  const lastAt = economyRescueMap.get(ownerJid);
  if (!lastAt) return 0;
  const diff = __timeNowMs() - lastAt;
  if (diff >= ECONOMY_RESCUE_COOLDOWN_MS) return 0;
  return Math.max(1, Math.ceil((ECONOMY_RESCUE_COOLDOWN_MS - diff) / 1000));
};

const tryApplyEconomyRescue = async ({ ownerJid, player, activePokemon = null, connection }) => {
  const cooldownLeft = getEconomyRescueSecondsLeft(ownerJid);
  if (cooldownLeft > 0) return null;

  const currentGold = toInt(player?.gold, 0);
  if (currentGold > ECONOMY_RESCUE_MAX_GOLD) return null;

  const potionInventory = await getInventoryItemForUpdate(ownerJid, 'potion', connection);
  const superPotionInventory = await getInventoryItemForUpdate(ownerJid, 'superpotion', connection);
  const healingItems = toInt(potionInventory?.quantity, 0) + toInt(superPotionInventory?.quantity, 0);
  if (healingItems > 0) return null;

  if (activePokemon) {
    const snapshot = await buildPlayerBattleSnapshot({ playerPokemonRow: activePokemon });
    const maxHp = Math.max(1, toInt(snapshot?.maxHp, activePokemon.current_hp || 1));
    const currentHp = clamp(toInt(activePokemon.current_hp, 0), 0, maxHp);
    if (currentHp / maxHp > 0.6) return null;
  }

  const nextGold = currentGold + ECONOMY_RESCUE_GOLD;
  await updatePlayerGoldOnly({ jid: ownerJid, gold: nextGold }, connection);
  await addInventoryItem({ ownerJid, itemKey: 'potion', quantity: ECONOMY_RESCUE_POTION_QTY }, connection);
  economyRescueMap.set(ownerJid, __timeNowMs());

  logger.info('Auxílio econômico aplicado para evitar travamento no início.', {
    ownerJid,
    grantedGold: ECONOMY_RESCUE_GOLD,
    grantedPotions: ECONOMY_RESCUE_POTION_QTY,
  });

  return {
    grantedGold: ECONOMY_RESCUE_GOLD,
    grantedPotions: ECONOMY_RESCUE_POTION_QTY,
    nextGold,
  };
};

const handleCapture = async ({ ownerJid, commandPrefix, itemKey = 'pokeball', itemMeta = null }) => {
  return withTransaction(async (connection) => {
    await ensureNoExpiredBattle(ownerJid, connection);

    const battleRow = await getBattleStateByOwnerForUpdate(ownerJid, connection);
    if (!battleRow) {
      return { ok: true, text: buildNoBattleText(commandPrefix) };
    }

    const battleSnapshot = parseBattleSnapshot(battleRow);
    if (!battleSnapshot) {
      await deleteBattleStateByOwner(ownerJid, connection);
      return { ok: true, text: buildNoBattleText(commandPrefix) };
    }

    if (battleSnapshot.mode === 'gym') {
      return { ok: true, text: buildCaptureBlockedGymText(commandPrefix) };
    }

    const myPokemon = await getPlayerPokemonByIdForUpdate(ownerJid, battleRow.my_pokemon_id, connection);
    if (!myPokemon) {
      await deleteBattleStateByOwner(ownerJid, connection);
      return { ok: true, text: buildNoBattleText(commandPrefix) };
    }

    const captureInput = {
      ...battleSnapshot,
      my: {
        ...(battleSnapshot.my || {}),
        captureBonus: Math.max(0, Number(itemMeta?.catchBonus) || 0),
        guaranteedCapture: Boolean(itemMeta?.guaranteedCapture),
      },
    };
    const captureResult = resolveCaptureAttempt({ battleSnapshot: captureInput });

    if (!captureResult.validAction) {
      const text = buildCaptureFailText({
        logs: captureResult.logs,
        battleSnapshot,
        prefix: commandPrefix,
      });
      return withBattleCanvasFrame({
        text,
        battleSnapshot,
        logs: captureResult.logs,
        modeLabel: battleSnapshot.mode === 'gym' ? 'Desafio de Ginasio' : 'Tentativa de Captura',
        actionText: captureResult.logs[captureResult.logs.length - 1] || 'Acao invalida para captura.',
        caption: `🎯 ${battleSnapshot.enemy?.displayName || 'Alvo'} Lv.${battleSnapshot.enemy?.level || 1}\nUse ${commandPrefix}rpg atacar ou ${commandPrefix}rpg capturar`,
        pokemonSnapshotFallback: battleSnapshot.enemy || battleSnapshot.my,
      });
    }

    const inventory = await requireInventoryItem({
      ownerJid,
      itemKey,
      connection,
    });

    if (!inventory) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_item', prefix: commandPrefix }),
      };
    }

    const consumed = await consumeInventoryItem(
      {
        ownerJid,
        itemKey,
        quantity: 1,
      },
      connection,
    );

    if (!consumed) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_item', prefix: commandPrefix }),
      };
    }

    const updatedSnapshot = captureResult.snapshot;
    const pokeballLeft = Math.max(0, inventory.quantity - 1);

    if (captureResult.success) {
      recordRpgCaptureAttempt('success');
      const captured = await createCapturedPokemon({
        ownerJid,
        enemySnapshot: updatedSnapshot.enemy,
        connection,
      });

      await updatePlayerPokemonState(
        {
          id: myPokemon.id,
          ownerJid,
          level: myPokemon.level,
          xp: myPokemon.xp,
          currentHp: Math.max(0, toInt(updatedSnapshot?.my?.currentHp, myPokemon.current_hp)),
        },
        connection,
      );

      const mission = await applyMissionEvent({
        ownerJid,
        eventKey: MISSION_KEYS.CAPTURE,
        connection,
      });

      const insertedPokedex = await upsertPokedexEntry(
        {
          ownerJid,
          pokeId: updatedSnapshot.enemy.pokeId,
        },
        connection,
      );
      let pokedexNotice = '';
      if (insertedPokedex) {
        const totalUnique = await countPokedexEntries(ownerJid, connection);
        pokedexNotice = `📘 Novo registro na Pokédex: #${updatedSnapshot.enemy.pokeId} (${totalUnique} únicos)`;

        const milestone = POKEDEX_MILESTONES.get(totalUnique);
        if (milestone) {
          const playerForReward = await getPlayerByJidForUpdate(ownerJid, connection);
          if (playerForReward) {
            const nextXp = Math.max(0, toInt(playerForReward.xp, 0) + milestone.xp);
            const nextGold = Math.max(0, toInt(playerForReward.gold, 0) + milestone.gold);
            const nextLevel = calculatePlayerLevelFromXp(nextXp);
            await updatePlayerProgress(
              {
                jid: ownerJid,
                level: nextLevel,
                xp: nextXp,
                gold: nextGold,
              },
              connection,
            );
            pokedexNotice = `${pokedexNotice}\n🏅 Marco Pokédex ${totalUnique}: +${milestone.xp} XP e +${milestone.gold} gold`;
          }
        }
      }

      recordBattleDurationFromSnapshot({
        snapshot: updatedSnapshot,
        outcome: 'capture_success',
      });
      await deleteBattleStateByOwner(ownerJid, connection);
      recordRpgCapture();

      const sourceChatJid = extractSourceChatFromBattleKey(battleRow.chat_jid);
      const coopUpdate = await applyGroupCoopContribution({
        chatJid: sourceChatJid,
        ownerJid,
        captureDelta: 1,
        raidDelta: 0,
        connection,
      });
      const eventUpdate = await applyGroupWeeklyEventContribution({
        chatJid: sourceChatJid,
        ownerJid,
        trigger: 'capture',
        value: 1,
        connection,
      });

      const text = buildCaptureSuccessText({
        capturedPokemon: {
          id: captured?.id,
          name: captured?.nickname || updatedSnapshot.enemy.displayName,
          displayName: captured?.nickname || updatedSnapshot.enemy.displayName,
          isShiny: Boolean(updatedSnapshot.enemy?.isShiny),
          flavorText: trimLoreText(updatedSnapshot.enemy?.flavorText || '', 180),
        },
        prefix: commandPrefix,
      }).concat(`\nPoke Bola restante: ${pokeballLeft}${mission.notices?.length ? `\n${mission.notices.join('\n')}` : ''}${pokedexNotice ? `\n${pokedexNotice}` : ''}${coopUpdate.notices?.length ? `\n${Array.from(new Set(coopUpdate.notices)).join('\n')}` : ''}${eventUpdate.notices?.length ? `\n${Array.from(new Set(eventUpdate.notices)).join('\n')}` : ''}`);

      return withPokemonImage({
        text,
        pokemonSnapshot: updatedSnapshot.enemy,
        caption: `🎉 Capturou ${updatedSnapshot.enemy.displayName} Lv.${updatedSnapshot.enemy.level}!\nPróximos: ${commandPrefix}rpg time | ${commandPrefix}rpg explorar`,
      });
    }

    if (toInt(updatedSnapshot?.my?.currentHp, 0) <= 0 || captureResult.winner === 'enemy') {
      recordRpgCaptureAttempt('failed');
      await updatePlayerPokemonState(
        {
          id: myPokemon.id,
          ownerJid,
          level: myPokemon.level,
          xp: myPokemon.xp,
          currentHp: 0,
        },
        connection,
      );

      recordBattleDurationFromSnapshot({
        snapshot: updatedSnapshot,
        outcome: 'capture_failed_ko',
      });
      await deleteBattleStateByOwner(ownerJid, connection);

      const text = buildCaptureFailText({
        logs: [...captureResult.logs, `Poke Bola restante: ${pokeballLeft}`],
        battleSnapshot: updatedSnapshot,
        prefix: commandPrefix,
      });

      return withBattleCanvasFrame({
        text,
        battleSnapshot: updatedSnapshot,
        logs: [...captureResult.logs, `Poke Bola restante: ${pokeballLeft}`],
        modeLabel: 'Tentativa de Captura',
        actionText: 'A captura falhou e seu Pokemon desmaiou.',
        caption: `🎯 ${updatedSnapshot.enemy?.displayName || 'Alvo'} Lv.${updatedSnapshot.enemy?.level || 1}\nA captura falhou`,
        pokemonSnapshotFallback: updatedSnapshot.enemy || updatedSnapshot.my,
      });
    }

    await updatePlayerPokemonState(
      {
        id: myPokemon.id,
        ownerJid,
        level: myPokemon.level,
        xp: myPokemon.xp,
        currentHp: Math.max(0, toInt(updatedSnapshot?.my?.currentHp, myPokemon.current_hp)),
      },
      connection,
    );

    await upsertBattleState(
      {
        chatJid: battleRow.chat_jid,
        ownerJid,
        myPokemonId: myPokemon.id,
        battleSnapshot: {
          ...updatedSnapshot,
          turn: toInt(battleRow.turn, 1) + 1,
        },
        turn: toInt(battleRow.turn, 1) + 1,
        expiresAt: nowPlusTtlDate(),
      },
      connection,
    );

    recordRpgCaptureAttempt('failed');

    const text = buildCaptureFailText({
      logs: [...captureResult.logs, `Poke Bola restante: ${pokeballLeft}`],
      battleSnapshot: updatedSnapshot,
      prefix: commandPrefix,
    });

    return withBattleCanvasFrame({
      text,
      battleSnapshot: updatedSnapshot,
      logs: [...captureResult.logs, `Poke Bola restante: ${pokeballLeft}`],
      modeLabel: 'Tentativa de Captura',
      actionText: captureResult.logs[captureResult.logs.length - 1] || 'Captura nao concluida.',
      caption: `🎯 ${updatedSnapshot.enemy?.displayName || 'Alvo'} Lv.${updatedSnapshot.enemy?.level || 1}\nUse ${commandPrefix}rpg atacar ou ${commandPrefix}rpg capturar`,
      pokemonSnapshotFallback: updatedSnapshot.enemy || updatedSnapshot.my,
    });
  });
};

const resolveUsableHealAmount = (itemMeta, maxHp) => {
  const rawHeal = Math.max(0, toInt(itemMeta?.healAmount, 0));
  if (rawHeal >= 9999) return maxHp;
  if (rawHeal > 0) return rawHeal;
  if (itemMeta?.isBerry) return Math.max(12, Math.round(maxHp * 0.15));
  return 0;
};

const handleUseHealingItem = async ({ ownerJid, commandPrefix, itemMeta }) => {
  return withTransaction(async (connection) => {
    const player = await getPlayerByJidForUpdate(ownerJid, connection);
    if (!player) {
      return { ok: true, text: buildNeedStartText(commandPrefix) };
    }

    const activePokemon = await getActivePlayerPokemonForUpdate(ownerJid, connection);
    if (!activePokemon) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_active_pokemon', prefix: commandPrefix }),
      };
    }

    const activeSnapshot = await buildPlayerBattleSnapshot({ playerPokemonRow: activePokemon });
    const maxHp = Math.max(1, toInt(activeSnapshot.maxHp, activePokemon.current_hp || 1));
    const currentHp = clamp(toInt(activePokemon.current_hp, 0), 0, maxHp);
    const healAmount = resolveUsableHealAmount(itemMeta, maxHp);
    const battleRow = await getBattleStateByOwnerForUpdate(ownerJid, connection);
    const berryCaptureBoost = itemMeta?.isBerry ? Math.max(0.04, Math.min(0.2, Number(itemMeta?.catchBonus || 0.08))) : 0;
    const canApplyOnlyBuff = berryCaptureBoost > 0 && Boolean(battleRow);

    if (currentHp >= maxHp && !canApplyOnlyBuff) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'full_hp', prefix: commandPrefix }),
      };
    }

    const inventory = await requireInventoryItem({ ownerJid, itemKey: itemMeta.key, connection });
    if (!inventory) {
      const rescue = await tryApplyEconomyRescue({
        ownerJid,
        player,
        activePokemon,
        connection,
      });
      if (rescue) {
        return {
          ok: true,
          text: buildEconomyRescueText({
            goldGranted: rescue.grantedGold,
            potionGranted: rescue.grantedPotions,
            goldTotal: rescue.nextGold,
            prefix: commandPrefix,
          }),
        };
      }
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_item', prefix: commandPrefix }),
      };
    }

    const healedHp = clamp(currentHp + healAmount, 0, maxHp);
    const healedAmount = healedHp - currentHp;

    const consumed = await consumeInventoryItem({ ownerJid, itemKey: itemMeta.key, quantity: 1 }, connection);
    if (!consumed) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_item', prefix: commandPrefix }),
      };
    }

    await updatePlayerPokemonState(
      {
        id: activePokemon.id,
        ownerJid,
        level: activePokemon.level,
        xp: activePokemon.xp,
        currentHp: healedHp,
      },
      connection,
    );

    if (battleRow) {
      const battleSnapshot = parseBattleSnapshot(battleRow);
      if (battleSnapshot?.my) {
        const nextCaptureBonus = berryCaptureBoost > 0 ? clamp(toInt((battleSnapshot.my.captureBonus || 0) * 100, 0) / 100 + berryCaptureBoost, 0, 0.4) : 0;
        const nextSnapshot = {
          ...battleSnapshot,
          my: {
            ...battleSnapshot.my,
            currentHp: healedHp,
            maxHp,
            captureBonus: Math.max(0, nextCaptureBonus || battleSnapshot.my.captureBonus || 0),
          },
        };

        await upsertBattleState(
          {
            chatJid: battleRow.chat_jid,
            ownerJid,
            myPokemonId: activePokemon.id,
            battleSnapshot: nextSnapshot,
            turn: toInt(battleRow.turn, 1),
            expiresAt: nowPlusTtlDate(),
          },
          connection,
        );
      }
    }

    const suffix = berryCaptureBoost > 0 && battleRow ? `\n🎯 Bônus de captura ativo: +${Math.round(berryCaptureBoost * 100)}%` : '';
    return {
      ok: true,
      text:
        buildUsePotionSuccessText({
          itemLabel: itemMeta?.label || itemMeta?.key || 'Item',
          healedAmount,
          pokemonName: activePokemon.nickname || activeSnapshot.displayName,
          currentHp: healedHp,
          maxHp,
          quantityLeft: Math.max(0, inventory.quantity - 1),
          itemLore: trimLoreText(itemMeta?.loreText || itemMeta?.description || '', 160),
          prefix: commandPrefix,
        }) + suffix,
    };
  });
};

const handleUseEvolutionItem = async ({ ownerJid, commandPrefix, itemMeta }) => {
  return withTransaction(async (connection) => {
    const player = await getPlayerByJidForUpdate(ownerJid, connection);
    if (!player) {
      return { ok: true, text: buildNeedStartText(commandPrefix) };
    }

    const activePokemon = await getActivePlayerPokemonForUpdate(ownerJid, connection);
    if (!activePokemon) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_active_pokemon', prefix: commandPrefix }),
      };
    }

    const inventory = await requireInventoryItem({
      ownerJid,
      itemKey: itemMeta.key,
      connection,
    });
    if (!inventory) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_item', prefix: commandPrefix }),
      };
    }

    const evolution = await resolveEvolutionByItem({
      pokeId: activePokemon.poke_id,
      itemKey: itemMeta.sourceName || itemMeta.key,
    });
    if (!evolution || evolution?.to?.pokeId === activePokemon.poke_id) {
      return {
        ok: true,
        text: `Esse item não causa evolução no Pokémon ativo.\n➡️ Próximo: ${commandPrefix}rpg perfil`,
      };
    }

    const consumed = await consumeInventoryItem(
      {
        ownerJid,
        itemKey: itemMeta.key,
        quantity: 1,
      },
      connection,
    );
    if (!consumed) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_item', prefix: commandPrefix }),
      };
    }

    let speciesData = null;
    try {
      const speciesLookup = evolution?.pokemonData?.species?.name || evolution?.to?.pokeId;
      if (speciesLookup) {
        speciesData = await getSpecies(speciesLookup);
      }
    } catch (error) {
      logger.debug('Falha ao carregar species na evolução por item.', {
        ownerJid,
        pokeId: evolution?.to?.pokeId,
        error: error.message,
      });
    }

    const battleSnapshot = await buildPokemonSnapshot({
      pokemonData: evolution.pokemonData,
      speciesData,
      level: activePokemon.level,
      currentHp: null,
      ivs: activePokemon.ivs_json,
      storedMoves: activePokemon.moves_json,
      isShiny: Boolean(activePokemon.is_shiny),
    });

    await updatePlayerPokemonState(
      {
        id: activePokemon.id,
        ownerJid,
        level: activePokemon.level,
        xp: activePokemon.xp,
        currentHp: battleSnapshot.maxHp,
        movesJson: battleSnapshot.moves,
        pokeId: evolution.to.pokeId,
      },
      connection,
    );

    await upsertPokedexEntry(
      {
        ownerJid,
        pokeId: evolution.to.pokeId,
      },
      connection,
    );

    return {
      ok: true,
      text: appendLoreLine(`🎉 Evolução por item!\n${evolution.from.name} evoluiu para *${evolution.to.name}* usando ${itemMeta.label}.\n➡️ Próximos: ${commandPrefix}rpg perfil | ${commandPrefix}rpg explorar`, battleSnapshot?.flavorText || null),
      imageUrl: battleSnapshot.imageUrl || null,
    };
  });
};

const extractMachineIdFromUrl = (url) => {
  const match = String(url || '').match(/\/machine\/(\d+)\/?$/);
  return match ? toInt(match[1], 0) : 0;
};

const resolveMachineMoveName = async (itemMeta) => {
  const itemData = await getItem(itemMeta.sourceName || itemMeta.key);
  const machines = Array.isArray(itemData?.machines) ? itemData.machines : [];
  if (!machines.length) return null;

  const selected = machines[machines.length - 1];
  const machineId = extractMachineIdFromUrl(selected?.machine?.url);
  if (!machineId) return null;

  const machineData = await getMachine(machineId);
  return (
    String(machineData?.move?.name || '')
      .trim()
      .toLowerCase() || null
  );
};

const handleTm = async ({ ownerJid, commandPrefix, actionArgs = [] }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return { ok: true, text: buildNeedStartText(commandPrefix) };
  }

  const { index, aliasMap } = await getShopCatalog();
  const inventory = await getInventoryItems(ownerJid);
  const tmItems = inventory
    .filter((entry) => toInt(entry.quantity, 0) > 0)
    .map((entry) => ({
      item: index.get(normalizeItemToken(entry.item_key)),
      quantity: toInt(entry.quantity, 0),
      key: normalizeItemToken(entry.item_key),
    }))
    .filter((entry) => entry.item?.isMachine)
    .map((entry) => ({
      key: entry.key,
      label: entry.item.label,
      quantity: entry.quantity,
    }));

  const sub = String(actionArgs?.[0] || '')
    .trim()
    .toLowerCase();
  if (!sub || sub === 'listar' || sub === 'list') {
    return {
      ok: true,
      text: buildTmListText({ items: tmItems, prefix: commandPrefix }),
    };
  }

  if (sub !== 'usar') {
    return {
      ok: true,
      text: buildTmListText({ items: tmItems, prefix: commandPrefix }),
    };
  }

  const tmToken = actionArgs?.[1];
  const slot = toInt(actionArgs?.[2], NaN);
  if (!tmToken || !Number.isFinite(slot) || slot < 1 || slot > 4) {
    return {
      ok: true,
      text: `Use: ${commandPrefix}rpg tm usar <tm> <1-4>`,
    };
  }

  const itemKey = resolveCatalogItemKey(tmToken, aliasMap);
  const itemMeta = index.get(itemKey);
  if (!itemMeta?.isMachine) {
    return {
      ok: true,
      text: `TM inválido.\nUse: ${commandPrefix}rpg tm listar`,
    };
  }

  const moveName = await resolveMachineMoveName(itemMeta);
  if (!moveName) {
    return {
      ok: true,
      text: `Não foi possível resolver o golpe da TM agora.\nTente outra TM.`,
    };
  }

  const moveSnapshot = await buildMoveSnapshotByName(moveName);

  return withTransaction(async (connection) => {
    const activePokemon = await getActivePlayerPokemonForUpdate(ownerJid, connection);
    if (!activePokemon) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_active_pokemon', prefix: commandPrefix }),
      };
    }

    const inventoryItem = await requireInventoryItem({
      ownerJid,
      itemKey: itemMeta.key,
      connection,
    });
    if (!inventoryItem) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_item', prefix: commandPrefix }),
      };
    }

    const moves = Array.isArray(activePokemon.moves_json) ? [...activePokemon.moves_json] : [];
    while (moves.length < 4) {
      moves.push(moveSnapshot);
    }
    moves[slot - 1] = moveSnapshot;

    const consumed = await consumeInventoryItem(
      {
        ownerJid,
        itemKey: itemMeta.key,
        quantity: 1,
      },
      connection,
    );
    if (!consumed) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_item', prefix: commandPrefix }),
      };
    }

    await updatePlayerPokemonState(
      {
        id: activePokemon.id,
        ownerJid,
        level: activePokemon.level,
        xp: activePokemon.xp,
        currentHp: activePokemon.current_hp,
        movesJson: moves,
      },
      connection,
    );

    const battleRow = await getBattleStateByOwnerForUpdate(ownerJid, connection);
    if (battleRow) {
      const snapshot = parseBattleSnapshot(battleRow);
      if (snapshot?.my && toInt(snapshot.my.id, 0) === toInt(activePokemon.id, 0)) {
        const nextSnapshot = {
          ...snapshot,
          my: {
            ...snapshot.my,
            moves,
          },
        };

        await upsertBattleState(
          {
            chatJid: battleRow.chat_jid,
            ownerJid,
            myPokemonId: activePokemon.id,
            battleSnapshot: nextSnapshot,
            turn: toInt(battleRow.turn, 1),
            expiresAt: nowPlusTtlDate(),
          },
          connection,
        );
      }
    }

    return {
      ok: true,
      text: buildTmUseText({
        itemLabel: itemMeta.label,
        moveName: moveSnapshot.displayName || moveSnapshot.name,
        moveLore: trimLoreText(moveSnapshot?.loreText || moveSnapshot?.shortEffect || '', 160),
        slot,
        pokemonName: activePokemon.nickname || `Pokemon #${activePokemon.poke_id}`,
        prefix: commandPrefix,
      }),
    };
  });
};

const handleBerry = async ({ ownerJid, commandPrefix, actionArgs = [] }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return { ok: true, text: buildNeedStartText(commandPrefix) };
  }

  const { index } = await getShopCatalog();
  const inventory = await getInventoryItems(ownerJid);
  const berryItems = inventory
    .filter((entry) => toInt(entry.quantity, 0) > 0)
    .map((entry) => ({
      key: normalizeItemToken(entry.item_key),
      item: index.get(normalizeItemToken(entry.item_key)),
      quantity: toInt(entry.quantity, 0),
    }))
    .filter((entry) => entry.item?.isBerry)
    .map((entry) => ({
      key: entry.key,
      label: entry.item.label,
      quantity: entry.quantity,
    }));

  const sub = String(actionArgs?.[0] || '')
    .trim()
    .toLowerCase();
  if (!sub || sub === 'listar' || sub === 'list') {
    return {
      ok: true,
      text: buildBerryListText({ items: berryItems, prefix: commandPrefix }),
    };
  }

  if (sub === 'usar') {
    return handleUse({
      ownerJid,
      commandPrefix,
      itemToken: actionArgs?.[1],
    });
  }

  return {
    ok: true,
    text: buildBerryListText({ items: berryItems, prefix: commandPrefix }),
  };
};

const handleUse = async ({ ownerJid, commandPrefix, itemToken }) => {
  const { index, aliasMap } = await getShopCatalog();
  const rawItemToken = String(itemToken || '')
    .trim()
    .toLowerCase();

  if (!rawItemToken || rawItemToken === 'ajuda' || rawItemToken === 'help') {
    return { ok: true, text: buildUseItemUsageText(commandPrefix) };
  }

  let normalizedItem = null;
  if (/^\d+$/.test(rawItemToken)) {
    const targetSlot = toInt(rawItemToken, 0);
    const inventoryRows = await getInventoryItems(ownerJid);
    const inventoryView = buildInventoryView({ inventoryRows, index });
    normalizedItem = inventoryView.find((entry) => entry.slot === targetSlot)?.key || null;
  } else {
    normalizedItem = resolveCatalogItemKey(rawItemToken, aliasMap);
  }

  if (!normalizedItem) {
    return { ok: true, text: buildUseItemUsageText(commandPrefix) };
  }

  const itemMeta = index.get(normalizedItem);
  if (!itemMeta) {
    return {
      ok: true,
      text: buildUseItemErrorText({ reason: 'invalid_item', prefix: commandPrefix }),
    };
  }

  if (itemMeta.isMachine) {
    return {
      ok: true,
      text: `📀 Para usar TM, utilize:\n${commandPrefix}rpg tm usar <tm> <1-4>`,
    };
  }

  if (itemMeta.isPokeball) {
    const battle = await getBattleStateByOwner(ownerJid);
    if (!battle) {
      return {
        ok: true,
        text: buildUseItemErrorText({ reason: 'no_battle_for_pokeball', prefix: commandPrefix }),
      };
    }
    return handleCapture({ ownerJid, commandPrefix, itemKey: itemMeta.key, itemMeta });
  }

  if (itemMeta.isMedicine || itemMeta.isBerry) {
    return handleUseHealingItem({ ownerJid, commandPrefix, itemMeta });
  }

  if (String(itemMeta.category || '').includes('evolution')) {
    return handleUseEvolutionItem({ ownerJid, commandPrefix, itemMeta });
  }

  return {
    ok: true,
    text: buildUseItemErrorText({ reason: 'invalid_item', prefix: commandPrefix }),
  };
};

const toMissionView = ({ progress, target, claimedAt }) => {
  const normalized = normalizeMissionProgress(progress);
  return {
    explorar: normalized[MISSION_KEYS.EXPLORE],
    vitorias: normalized[MISSION_KEYS.WIN],
    capturas: normalized[MISSION_KEYS.CAPTURE],
    target: {
      explorar: target[MISSION_KEYS.EXPLORE],
      vitorias: target[MISSION_KEYS.WIN],
      capturas: target[MISSION_KEYS.CAPTURE],
    },
    completed: isMissionCompleted(normalized, target),
    claimed: Boolean(claimedAt),
  };
};

const buildInventoryView = ({ inventoryRows = [], index }) => {
  return inventoryRows
    .filter((item) => toInt(item?.quantity, 0) > 0)
    .map((item) => {
      const key = normalizeItemToken(item?.item_key);
      const itemMeta = index.get(key) || null;
      const categoryKey = resolveItemCategoryKeyFromMeta(itemMeta);
      return {
        key,
        label: itemMeta?.label || toTitleCase(item?.item_key),
        description: trimLoreText(itemMeta?.description || '', 120),
        loreText: trimLoreText(itemMeta?.loreText || '', 90),
        quantity: toInt(item?.quantity, 0),
        isPokeball: Boolean(itemMeta?.isPokeball),
        isMachine: Boolean(itemMeta?.isMachine),
        isBerry: Boolean(itemMeta?.isBerry),
        isMedicine: Boolean(itemMeta?.isMedicine),
        category: String(itemMeta?.category || ''),
        categoryKey,
        categoryLabel: ITEM_CATEGORY_LABEL_MAP.get(categoryKey) || 'Outros',
      };
    })
    .sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'pt-BR'))
    .map((entry, idx) => ({
      ...entry,
      slot: idx + 1,
    }));
};

const handleBag = async ({ ownerJid, commandPrefix, actionArgs = [] }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return { ok: true, text: buildNeedStartText(commandPrefix) };
  }

  const { index } = await getShopCatalog();
  const inventoryRows = await getInventoryItems(ownerJid);
  const fullInventory = buildInventoryView({ inventoryRows, index });
  const requestedCategoryToken = actionArgs?.[0];
  const selectedCategory = resolveItemCategoryFilter(requestedCategoryToken);
  const filteredItems = selectedCategory && selectedCategory !== 'todos' ? fullInventory.filter((entry) => entry.categoryKey === selectedCategory) : fullInventory;
  const availableCategories = resolveAvailableCategoryKeys(fullInventory);
  const selectedCategoryLabel = selectedCategory && selectedCategory !== 'todos' ? ITEM_CATEGORY_LABEL_MAP.get(selectedCategory) || selectedCategory : 'Todas';

  return {
    ok: true,
    text: buildBagText({
      items: filteredItems,
      gold: toInt(player.gold, 0),
      prefix: commandPrefix,
      availableCategories,
      selectedCategory: selectedCategory || 'todos',
      selectedCategoryLabel,
      invalidCategory: requestedCategoryToken && !selectedCategory ? requestedCategoryToken : null,
    }),
  };
};

const resolveNationalPokedexTotal = async () => {
  try {
    const national = await getPokedex('national');
    const entries = Array.isArray(national?.pokemon_entries) ? national.pokemon_entries : [];
    if (entries.length > 0) return entries.length;
  } catch (error) {
    logger.debug('Fallback para total da pokedex nacional.', {
      error: error.message,
    });
  }
  return DEFAULT_POKEDEX_TOTAL;
};

const handlePokedex = async ({ ownerJid, commandPrefix }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return { ok: true, text: buildNeedStartText(commandPrefix) };
  }

  const [uniqueTotal, total] = await Promise.all([countPokedexEntries(ownerJid), resolveNationalPokedexTotal()]);
  const recentRows = await listPokedexEntries(ownerJid, 10);
  const recent = [];
  for (const row of recentRows) {
    try {
      const species = await getSpecies(row.poke_id);
      const localizedName = getLocalizedName(species?.names, species?.name || `pokemon-${row.poke_id}`);
      const genus = trimLoreText(getLocalizedGenus(species?.genera), 70);
      const flavor = trimLoreText(getFlavorText(species?.flavor_text_entries), 100);
      const loreNote = trimLoreText([genus, flavor].filter(Boolean).join(' • '), 130);
      recent.push({
        pokeId: row.poke_id,
        name: localizedName || species?.name || `pokemon-${row.poke_id}`,
        displayName: toTitleCase(localizedName || species?.name || `pokemon-${row.poke_id}`),
        note: loreNote,
      });
    } catch {
      recent.push({
        pokeId: row.poke_id,
        name: `pokemon-${row.poke_id}`,
      });
    }
  }

  const completion = total > 0 ? Math.min(100, Math.round((uniqueTotal / total) * 100)) : 0;
  return {
    ok: true,
    text: buildPokedexText({
      uniqueTotal,
      total,
      completion,
      recent,
      prefix: commandPrefix,
    }),
  };
};

const findEvolutionNodeBySpeciesName = (chainNode, speciesName) => {
  if (!chainNode || !speciesName) return null;
  const current = normalizeNameKey(chainNode?.species?.name || '');
  const expected = normalizeNameKey(speciesName);
  if (current && current === expected) return chainNode;
  const nextNodes = Array.isArray(chainNode?.evolves_to) ? chainNode.evolves_to : [];
  for (const nextNode of nextNodes) {
    const found = findEvolutionNodeBySpeciesName(nextNode, speciesName);
    if (found) return found;
  }
  return null;
};

const resolveEvolutionDetailLabel = (detail = {}) => {
  if (!detail || typeof detail !== 'object') return null;
  const trigger = String(detail?.trigger?.name || '')
    .trim()
    .toLowerCase();
  const parts = [];

  if (trigger === 'level-up') {
    if (Number.isFinite(Number(detail?.min_level)) && Number(detail.min_level) > 0) {
      parts.push(`Lv. ${toInt(detail.min_level, 0)}`);
    } else {
      parts.push('Subir de nível');
    }
  } else if (trigger === 'use-item') {
    const itemName = String(detail?.item?.name || '')
      .trim()
      .toLowerCase();
    parts.push(itemName ? `Usar ${toTitleCase(itemName)}` : 'Usar item');
  } else if (trigger === 'trade') {
    parts.push('Troca');
  } else if (trigger) {
    parts.push(toTitleCase(trigger));
  }

  if (Number.isFinite(Number(detail?.min_happiness))) parts.push(`Felicidade ${toInt(detail.min_happiness, 0)}+`);
  if (Number.isFinite(Number(detail?.min_affection))) parts.push(`Afeição ${toInt(detail.min_affection, 0)}+`);
  if (Number.isFinite(Number(detail?.min_beauty))) parts.push(`Beleza ${toInt(detail.min_beauty, 0)}+`);
  if (String(detail?.time_of_day || '').trim()) parts.push(`Período: ${toTitleCase(detail.time_of_day)}`);
  if (detail?.needs_overworld_rain) parts.push('Com chuva no mapa');
  if (detail?.turn_upside_down) parts.push('Dispositivo invertido');
  if (Number(detail?.gender) === 1) parts.push('Apenas fêmea');
  if (Number(detail?.gender) === 2) parts.push('Apenas macho');

  const heldItem = String(detail?.held_item?.name || '')
    .trim()
    .toLowerCase();
  if (heldItem) parts.push(`Segurando ${toTitleCase(heldItem)}`);
  const knownMove = String(detail?.known_move?.name || '')
    .trim()
    .toLowerCase();
  if (knownMove) parts.push(`Conhecer ${toTitleCase(knownMove)}`);
  const knownMoveType = String(detail?.known_move_type?.name || '')
    .trim()
    .toLowerCase();
  if (knownMoveType) parts.push(`Golpe tipo ${toTitleCase(knownMoveType)}`);
  const location = String(detail?.location?.name || '')
    .trim()
    .toLowerCase();
  if (location) parts.push(`Local: ${toTitleCase(location)}`);
  const partySpecies = String(detail?.party_species?.name || '')
    .trim()
    .toLowerCase();
  if (partySpecies) parts.push(`Com ${toTitleCase(partySpecies)} no time`);
  const partyType = String(detail?.party_type?.name || '')
    .trim()
    .toLowerCase();
  if (partyType) parts.push(`Com tipo ${toTitleCase(partyType)} no time`);

  return parts.length ? parts.join(' • ') : null;
};

const resolveEvolutionRequirement = (details = []) => {
  const labels = (Array.isArray(details) ? details : []).map((detail) => resolveEvolutionDetailLabel(detail)).filter(Boolean);
  if (!labels.length) return 'Requisito não especificado';
  return Array.from(new Set(labels)).join('  OU  ');
};

const resolveEvolutionTargetFromTeam = async ({ ownerJid, token = '' }) => {
  const rows = await listPlayerPokemons(ownerJid);
  if (!rows.length) return null;

  const normalized = normalizeNameKey(token);
  const parsedToken = toInt(token, 0);

  const buildTargetFromRow = async (row) => {
    const snapshot = await buildPlayerBattleSnapshot({ playerPokemonRow: row });
    return {
      speciesName: snapshot.name,
      displayName: row.nickname || snapshot.displayName || toTitleCase(snapshot.name),
      flavorText: trimLoreText(snapshot?.flavorText || '', 140),
      imageUrl: snapshot?.imageUrl || null,
      speciesData: null,
    };
  };

  if (!normalized) {
    const active = rows.find((row) => Boolean(row?.is_active)) || rows[0];
    if (!active) return null;
    return buildTargetFromRow(active);
  }

  if (parsedToken > 0) {
    const byTeamId = rows.find((row) => toInt(row?.id, 0) === parsedToken);
    if (byTeamId) return buildTargetFromRow(byTeamId);

    const byPokeId = rows.find((row) => toInt(row?.poke_id, 0) === parsedToken);
    if (byPokeId) return buildTargetFromRow(byPokeId);
  }

  const byNickname = rows.find((row) => normalizeNameKey(row?.nickname) === normalized);
  if (byNickname) return buildTargetFromRow(byNickname);

  for (const row of rows) {
    try {
      const snapshot = await buildPlayerBattleSnapshot({ playerPokemonRow: row });
      if (normalizeNameKey(snapshot?.name) === normalized || normalizeNameKey(snapshot?.displayName) === normalized) {
        return {
          speciesName: snapshot.name,
          displayName: row.nickname || snapshot.displayName || toTitleCase(snapshot.name),
          flavorText: trimLoreText(snapshot?.flavorText || '', 140),
          imageUrl: snapshot?.imageUrl || null,
          speciesData: null,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
};

const resolveEvolutionTarget = async ({ ownerJid, token = '' }) => {
  const teamTarget = await resolveEvolutionTargetFromTeam({ ownerJid, token });
  if (teamTarget) return teamTarget;

  const lookup = String(token || '').trim();
  if (!lookup) return null;

  try {
    const pokemonData = await getPokemon(lookup);
    const speciesLookup = pokemonData?.species?.name || extractResourceIdFromUrl(pokemonData?.species?.url) || pokemonData?.id;
    const speciesData = speciesLookup ? await getSpecies(speciesLookup) : null;
    const localizedName = getLocalizedName(speciesData?.names, pokemonData?.name || lookup);
    return {
      speciesName: String(speciesData?.name || pokemonData?.name || lookup)
        .trim()
        .toLowerCase(),
      displayName: toTitleCase(localizedName || pokemonData?.name || lookup),
      flavorText: trimLoreText(getFlavorText(speciesData?.flavor_text_entries), 140),
      imageUrl: null,
      speciesData,
    };
  } catch {
    return null;
  }
};

const buildEvolutionStages = async (currentNode) => {
  const stages = [];
  const labelCache = new Map();

  const resolveSpeciesLabel = async (speciesNode = {}) => {
    const speciesName = String(speciesNode?.name || '')
      .trim()
      .toLowerCase();
    const speciesId = extractResourceIdFromUrl(speciesNode?.url);
    const cacheKey = speciesId > 0 ? `id:${speciesId}` : `name:${speciesName}`;
    if (labelCache.has(cacheKey)) return labelCache.get(cacheKey);

    let label = toTitleCase(speciesName || 'pokemon');
    try {
      const lookup = speciesId > 0 ? speciesId : speciesName;
      const speciesData = lookup ? await getSpecies(lookup) : null;
      const localizedName = getLocalizedName(speciesData?.names, speciesName);
      label = toTitleCase(localizedName || speciesName || 'pokemon');
    } catch {
      // fallback já definido em label
    }

    labelCache.set(cacheKey, label);
    return label;
  };

  const walk = async (node, depth) => {
    const nextNodes = Array.isArray(node?.evolves_to) ? node.evolves_to : [];
    for (const nextNode of nextNodes) {
      stages.push({
        depth,
        name: await resolveSpeciesLabel(nextNode?.species),
        requirement: resolveEvolutionRequirement(nextNode?.evolution_details),
      });
      await walk(nextNode, depth + 1);
    }
  };

  await walk(currentNode, 0);
  return stages;
};

const handleEvolutionTree = async ({ ownerJid, commandPrefix, pokemonToken = null }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return { ok: true, text: buildNeedStartText(commandPrefix) };
  }

  const target = await resolveEvolutionTarget({
    ownerJid,
    token: String(pokemonToken || '').trim(),
  });
  if (!target) {
    return {
      ok: true,
      text: `🔎 Não consegui identificar esse Pokémon.\nUse: ${commandPrefix}rpg evolucao <pokemon|id>\n💡 Se omitir o nome, uso seu Pokémon ativo.`,
    };
  }

  const speciesData = target.speciesData || (target.speciesName ? await getSpecies(target.speciesName) : null);
  const chainId = extractResourceIdFromUrl(speciesData?.evolution_chain?.url);
  if (!chainId) {
    return {
      ok: true,
      text: buildEvolutionTreeText({
        pokemonName: target.displayName,
        flavorText: target.flavorText || trimLoreText(getFlavorText(speciesData?.flavor_text_entries), 140),
        stages: [],
        prefix: commandPrefix,
      }),
    };
  }

  const chainData = await getEvolutionChain(chainId);
  const currentNode = findEvolutionNodeBySpeciesName(chainData?.chain, target.speciesName || speciesData?.name || '');
  if (!currentNode) {
    return {
      ok: true,
      text: `⚠️ Não foi possível montar a árvore evolutiva agora.\n➡️ Tente novamente: ${commandPrefix}rpg evolucao ${target.displayName}`,
    };
  }

  const stages = await buildEvolutionStages(currentNode);
  const text = buildEvolutionTreeText({
    pokemonName: target.displayName,
    flavorText: target.flavorText || trimLoreText(getFlavorText(speciesData?.flavor_text_entries), 140),
    stages,
    prefix: commandPrefix,
  });

  return withPokemonImage({
    text,
    pokemonSnapshot: { imageUrl: target.imageUrl || null },
    caption: target.imageUrl ? `🧬 Árvore evolutiva: ${target.displayName}` : null,
  });
};

const listTravelRegions = async () => {
  const list = await getResourceList({ resource: 'region', limit: 12, offset: 0 });
  return (list?.results || [])
    .map((entry) =>
      String(entry?.name || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
};

const buildRegionLore = (regionData) => {
  const generation = String(regionData?.main_generation?.name || '')
    .trim()
    .toLowerCase();
  if (!generation) return null;
  return `Região historicamente associada à ${toTitleCase(generation)}.`;
};

const buildLocationLore = (locationData) => {
  const areaCount = Array.isArray(locationData?.areas) ? locationData.areas.length : 0;
  if (areaCount <= 0) return null;
  return `Área com ${areaCount} sub-região(ões) explorável(is).`;
};

const buildAreaLore = (areaData) => {
  const encounterCount = Array.isArray(areaData?.pokemon_encounters) ? areaData.pokemon_encounters.length : 0;
  if (encounterCount <= 0) return null;
  return `${encounterCount} espécie(s) registradas nesta área.`;
};

const pickTravelLocationData = async (regionKey) => {
  const regionData = await getRegion(regionKey);
  const locations = Array.isArray(regionData?.locations) ? regionData.locations : [];
  const regionLabel = getLocalizedName(regionData?.names, regionKey) || toTitleCase(regionKey);
  const regionLore = trimLoreText(buildRegionLore(regionData), 130);
  if (!locations.length) {
    return {
      regionLabel,
      regionLore,
      locationKey: null,
      locationAreaKey: null,
      locationLabel: null,
      locationLore: null,
      areaLabel: null,
      areaLore: null,
    };
  }

  const selectedLocation = randomFromArray(locations);
  const locationName = String(selectedLocation?.name || '')
    .trim()
    .toLowerCase();
  if (!locationName) {
    return {
      regionLabel,
      regionLore,
      locationKey: null,
      locationAreaKey: null,
      locationLabel: null,
      locationLore: null,
      areaLabel: null,
      areaLore: null,
    };
  }

  const locationData = await getLocation(locationName);
  const locationLabel = getLocalizedName(locationData?.names, locationName) || toTitleCase(locationName);
  const locationLore = trimLoreText(buildLocationLore(locationData), 130);
  const areas = Array.isArray(locationData?.areas) ? locationData.areas : [];
  const selectedArea = areas.length ? randomFromArray(areas) : null;
  const areaKey =
    String(selectedArea?.name || '')
      .trim()
      .toLowerCase() || null;
  let areaLabel = null;
  let areaLore = null;
  if (areaKey) {
    areaLabel = toTitleCase(areaKey);
    try {
      const areaData = await getLocationArea(areaKey);
      areaLabel = getLocalizedName(areaData?.names, areaKey) || areaLabel;
      areaLore = trimLoreText(buildAreaLore(areaData), 130);
    } catch (error) {
      logger.debug('Falha ao carregar lore da área de viagem.', {
        areaKey,
        error: error.message,
      });
    }
  }

  return {
    regionLabel,
    regionLore,
    locationKey: locationName,
    locationAreaKey: areaKey,
    locationLabel,
    locationLore,
    areaLabel,
    areaLore,
  };
};

const hydrateTravelView = async (travelRow) => {
  if (!travelRow) return null;
  const travel = {
    regionKey: travelRow.region_key || null,
    locationKey: travelRow.location_key || null,
    locationAreaKey: travelRow.location_area_key || null,
    regionLabel: null,
    locationLabel: null,
    areaLabel: null,
    regionLore: null,
    locationLore: null,
    areaLore: null,
  };

  try {
    if (travel.regionKey) {
      const regionData = await getRegion(travel.regionKey);
      travel.regionLabel = getLocalizedName(regionData?.names, travel.regionKey) || toTitleCase(travel.regionKey);
      travel.regionLore = trimLoreText(buildRegionLore(regionData), 130);
    }
  } catch (error) {
    logger.debug('Falha ao hidratar região da viagem.', {
      regionKey: travel.regionKey,
      error: error.message,
    });
  }

  try {
    if (travel.locationKey) {
      const locationData = await getLocation(travel.locationKey);
      travel.locationLabel = getLocalizedName(locationData?.names, travel.locationKey) || toTitleCase(travel.locationKey);
      travel.locationLore = trimLoreText(buildLocationLore(locationData), 130);
    }
  } catch (error) {
    logger.debug('Falha ao hidratar local da viagem.', {
      locationKey: travel.locationKey,
      error: error.message,
    });
  }

  try {
    if (travel.locationAreaKey) {
      const areaData = await getLocationArea(travel.locationAreaKey);
      travel.areaLabel = getLocalizedName(areaData?.names, travel.locationAreaKey) || toTitleCase(travel.locationAreaKey);
      travel.areaLore = trimLoreText(buildAreaLore(areaData), 130);
    }
  } catch (error) {
    logger.debug('Falha ao hidratar área da viagem.', {
      areaKey: travel.locationAreaKey,
      error: error.message,
    });
  }

  return travel;
};

const handleTravel = async ({ ownerJid, commandPrefix, actionArgs = [] }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return { ok: true, text: buildNeedStartText(commandPrefix) };
  }

  const targetRegion = String(actionArgs?.[0] || '')
    .trim()
    .toLowerCase();
  if (!targetRegion) {
    const [travel, regions] = await Promise.all([getTravelStateByOwner(ownerJid), listTravelRegions()]);
    const hydratedTravel = await hydrateTravelView(travel);
    return {
      ok: true,
      text: buildTravelStatusText({
        travel: hydratedTravel,
        regions: regions.slice(0, 8),
        prefix: commandPrefix,
      }),
    };
  }

  try {
    const locationData = await pickTravelLocationData(targetRegion);
    await withTransaction(async (connection) => {
      await upsertTravelState(
        {
          ownerJid,
          regionKey: targetRegion,
          locationKey: locationData.locationKey,
          locationAreaKey: locationData.locationAreaKey,
        },
        connection,
      );
    });

    return {
      ok: true,
      text: buildTravelSetText({
        travel: {
          regionKey: targetRegion,
          locationKey: locationData.locationKey,
          locationAreaKey: locationData.locationAreaKey,
          regionLabel: locationData.regionLabel,
          locationLabel: locationData.locationLabel,
          areaLabel: locationData.areaLabel,
          regionLore: locationData.regionLore,
          locationLore: locationData.locationLore,
          areaLore: locationData.areaLore,
        },
        prefix: commandPrefix,
      }),
    };
  } catch (error) {
    logger.warn('Falha ao atualizar viagem RPG.', {
      ownerJid,
      targetRegion,
      error: error.message,
    });
    return {
      ok: true,
      text: `Região inválida ou indisponível agora.\nUse: ${commandPrefix}rpg viajar`,
    };
  }
};

const handleMissions = async ({ ownerJid, commandPrefix }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return { ok: true, text: buildNeedStartText(commandPrefix) };
  }

  return withTransaction(async (connection) => {
    const mission = await ensureMissionStateForUpdate({ ownerJid, connection });
    const daily = toMissionView({
      progress: mission.daily_progress_json,
      target: DAILY_MISSION_TARGET,
      claimedAt: mission.daily_claimed_at,
    });
    const weekly = toMissionView({
      progress: mission.weekly_progress_json,
      target: WEEKLY_MISSION_TARGET,
      claimedAt: mission.weekly_claimed_at,
    });

    return {
      ok: true,
      text: buildMissionsText({
        daily,
        weekly,
        prefix: commandPrefix,
      }),
    };
  });
};

const handleFlee = async ({ ownerJid, commandPrefix }) => {
  return withTransaction(async (connection) => {
    await ensureNoExpiredBattle(ownerJid, connection);
    const battleRow = await getBattleStateByOwnerForUpdate(ownerJid, connection);
    if (!battleRow) {
      return { ok: true, text: buildNoBattleText(commandPrefix) };
    }

    const snapshot = parseBattleSnapshot(battleRow);
    recordBattleDurationFromSnapshot({
      snapshot,
      outcome: 'flee',
    });
    recordRpgFlee();
    await deleteBattleStateByOwner(ownerJid, connection);
    return { ok: true, text: buildFleeText(commandPrefix) };
  });
};

const handleShop = async ({ ownerJid, commandPrefix, actionArgs = [] }) => {
  const player = await getPlayerByJid(ownerJid);
  if (!player) {
    return { ok: true, text: buildNeedStartText(commandPrefix) };
  }

  await ensureNoExpiredBattle(ownerJid);
  const battleRow = await getBattleStateByOwner(ownerJid);
  if (battleRow) {
    return { ok: true, text: buildBattleAlreadyActiveText(commandPrefix) };
  }

  const { items } = await getShopCatalog();
  const requestedCategoryToken = actionArgs?.[0];
  const selectedCategory = resolveItemCategoryFilter(requestedCategoryToken);
  const filteredItems = selectedCategory && selectedCategory !== 'todos' ? items.filter((entry) => resolveItemCategoryKeyFromMeta(entry) === selectedCategory) : items;
  const availableCategories = resolveAvailableCategoryKeys(items);
  const selectedCategoryLabel = selectedCategory && selectedCategory !== 'todos' ? ITEM_CATEGORY_LABEL_MAP.get(selectedCategory) || selectedCategory : 'Todas';

  return {
    ok: true,
    text: buildShopText({
      items: filteredItems,
      prefix: commandPrefix,
      availableCategories,
      selectedCategory: selectedCategory || 'todos',
      selectedCategoryLabel,
      invalidCategory: requestedCategoryToken && !selectedCategory ? requestedCategoryToken : null,
    }),
  };
};

const handleBuy = async ({ ownerJid, itemKey, quantity, commandPrefix }) => {
  const { index, aliasMap } = await getShopCatalog();
  const normalizedItem = resolveCatalogItemKey(itemKey, aliasMap);
  const parsedQty = toInt(quantity, NaN);

  if (!index.has(normalizedItem)) {
    return { ok: true, text: buildBuyErrorText({ reason: 'invalid_item', prefix: commandPrefix }) };
  }

  if (!Number.isFinite(parsedQty) || parsedQty <= 0 || parsedQty > 99) {
    return {
      ok: true,
      text: buildBuyErrorText({ reason: 'invalid_quantity', prefix: commandPrefix }),
    };
  }

  const item = index.get(normalizedItem);

  return withTransaction(async (connection) => {
    const player = await getPlayerByJidForUpdate(ownerJid, connection);
    if (!player) {
      return { ok: true, text: buildNeedStartText(commandPrefix) };
    }

    await ensureNoExpiredBattle(ownerJid, connection);
    const battleRow = await getBattleStateByOwnerForUpdate(ownerJid, connection);
    if (battleRow) {
      return {
        ok: true,
        text: buildBuyErrorText({ reason: 'battle_active', prefix: commandPrefix }),
      };
    }

    const totalPrice = item.price * parsedQty;
    const currentGold = toInt(player.gold, 0);

    if (currentGold < totalPrice) {
      if (item.isMedicine) {
        const rescue = await tryApplyEconomyRescue({
          ownerJid,
          player,
          connection,
        });
        if (rescue) {
          return {
            ok: true,
            text: buildBuyErrorText({
              reason: 'not_enough_gold',
              rescue,
              prefix: commandPrefix,
            }),
          };
        }
      }
      return {
        ok: true,
        text: buildBuyErrorText({ reason: 'not_enough_gold', prefix: commandPrefix }),
      };
    }

    const nextGold = Math.max(0, currentGold - totalPrice);
    await updatePlayerGoldOnly({ jid: ownerJid, gold: nextGold }, connection);
    await addInventoryItem({ ownerJid, itemKey: item.key, quantity: parsedQty }, connection);

    return {
      ok: true,
      text: appendLoreLine(
        buildBuySuccessText({
          item,
          quantity: parsedQty,
          totalPrice,
          goldLeft: nextGold,
          prefix: commandPrefix,
        }),
        item?.loreText || item?.description,
      ),
    };
  });
};

const toRaidView = (raidRow) => {
  if (!raidRow) return null;
  const boss = raidRow?.boss_snapshot_json || {};
  return {
    chatJid: raidRow.chat_jid,
    bossName: boss.displayName || boss.name || 'Boss',
    level: toInt(boss.level, 1),
    maxHp: Math.max(1, toInt(raidRow.max_hp, toInt(boss.maxHp, 1))),
    currentHp: Math.max(0, toInt(raidRow.current_hp, toInt(boss.currentHp, 0))),
    bossSnapshot: {
      ...boss,
      maxHp: Math.max(1, toInt(raidRow.max_hp, toInt(boss.maxHp, 1))),
      currentHp: Math.max(0, toInt(raidRow.current_hp, toInt(boss.currentHp, 0))),
    },
    bossLore: trimLoreText(boss?.flavorText || '', 170),
    biomeKey: raidRow.biome_key || null,
    startedAt: raidRow.started_at || null,
    endsAt: raidRow.ends_at || null,
  };
};

const isDateExpired = (value) => {
  const date = toDateSafe(value);
  if (!date) return false;
  return date.getTime() <= __timeNowMs();
};

const formatParticipantRows = (participants = []) =>
  participants.map((entry) => ({
    ownerJid: entry.owner_jid,
    totalDamage: toInt(entry.total_damage, 0),
  }));

const resolveRaidRewards = ({ bossLevel, totalDamage, participantDamage }) => {
  const safeLevel = Math.max(1, toInt(bossLevel, 1));
  const ratio = totalDamage > 0 ? clamp(participantDamage / totalDamage, 0, 1) : 0;
  const gold = Math.max(80, Math.round(safeLevel * 10 + ratio * 400));
  const playerXp = Math.max(60, Math.round(safeLevel * 12 + ratio * 260));
  const pokemonXp = Math.max(70, Math.round(safeLevel * 15 + ratio * 280));
  return { gold, playerXp, pokemonXp };
};

const buildPvpSnapshotState = ({ challengerJid, challengerPokemonId, challengerSnapshot, opponentJid, opponentPokemonId, opponentSnapshot, turnJid }) => {
  return {
    startedAt: __timeNowIso(),
    turn: 1,
    players: {
      [challengerJid]: {
        ownerJid: challengerJid,
        pokemonId: challengerPokemonId,
        pokemon: challengerSnapshot,
      },
      [opponentJid]: {
        ownerJid: opponentJid,
        pokemonId: opponentPokemonId,
        pokemon: opponentSnapshot,
      },
    },
    turnJid,
  };
};

const resolvePvpOpponentJid = (challenge, ownerJid) => {
  if (!challenge) return null;
  if (challenge.challenger_jid === ownerJid) return challenge.opponent_jid;
  if (challenge.opponent_jid === ownerJid) return challenge.challenger_jid;
  return null;
};

const toPvpStatusView = ({ challenge, ownerJid }) => {
  if (!challenge) return null;
  const snapshot = challenge?.battle_snapshot_json || {};
  const players = snapshot.players || {};
  const me = players[ownerJid]?.pokemon || {};
  const opponentJid = resolvePvpOpponentJid(challenge, ownerJid);
  const enemy = opponentJid ? players[opponentJid]?.pokemon || {} : {};
  return {
    id: challenge.id,
    turnJid: challenge.turn_jid,
    turnLabel: toMentionLabel(challenge.turn_jid),
    myPokemonLabel: toPvpPokemonLabel(me),
    enemyPokemonLabel: toPvpPokemonLabel(enemy),
    myHp: toInt(me.currentHp, 0),
    myMaxHp: Math.max(1, toInt(me.maxHp, 1)),
    enemyHp: toInt(enemy.currentHp, 0),
    enemyMaxHp: Math.max(1, toInt(enemy.maxHp, 1)),
  };
};

const buildPvpQueueStatusText = ({ queue = [], ownerJid, prefix = '/' }) => {
  const lines = ['🥊 *Fila PvP*'];
  const me = queue.find((entry) => entry.owner_jid === ownerJid) || null;
  if (me) {
    lines.push(`Você está na fila (entrada #${me.id}).`);
  } else {
    lines.push('Você não está na fila no momento.');
  }
  lines.push(`Jogadores aguardando: ${queue.length}`);
  if (queue.length) {
    queue.slice(0, 8).forEach((entry, idx) => {
      lines.push(`${idx + 1}. ${entry.ownerLabel || entry.owner_jid}`);
    });
  }
  lines.push(`➡️ Entrar: ${prefix}rpg pvp fila entrar`);
  lines.push(`➡️ Sair: ${prefix}rpg pvp fila sair`);
  return lines.join('\n');
};

const buildPvpWeeklyRankingText = ({ weekRefDate, ranking = [], prefix = '/' }) => {
  const lines = ['🏆 *Ranking PvP Semanal*', `📅 Semana: ${weekRefDate}`];
  if (!ranking.length) {
    lines.push('Sem partidas registradas nesta semana.');
  } else {
    lines.push('Pontuação: pontos | vitórias/derrotas | taxa de vitória');
    ranking.forEach((entry, idx) => {
      const games = Math.max(0, toInt(entry.matches_played, 0));
      const wins = Math.max(0, toInt(entry.wins, 0));
      const losses = Math.max(0, toInt(entry.losses, 0));
      const points = Math.max(0, toInt(entry.points, 0));
      const winRate = games > 0 ? Math.round((wins / games) * 100) : 0;
      const rankBadge = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
      lines.push(`${rankBadge} ${entry.ownerLabel || entry.owner_jid} — *${points} pts* | ${wins}W/${losses}L | ${winRate}% WR`);
    });
  }
  lines.push(`➡️ Entre na fila: ${prefix}rpg pvp fila entrar`);
  return lines.join('\n');
};

const createPvpChallengeBetweenPlayers = async ({ challengerJid, opponentJid, chatJid = null, connection }) => {
  const selfPlayer = await getPlayerByJidForUpdate(challengerJid, connection);
  const opponentPlayer = await getPlayerByJidForUpdate(opponentJid, connection);
  if (!selfPlayer || !opponentPlayer) {
    return { error: 'player_not_found' };
  }

  const existingSelf = await listOpenPvpChallengesByPlayer(challengerJid, connection);
  const existingOpponent = await listOpenPvpChallengesByPlayer(opponentJid, connection);
  if ((existingSelf || []).length || (existingOpponent || []).length) {
    return { error: 'challenge_exists' };
  }

  const myActive = await getActivePlayerPokemonForUpdate(challengerJid, connection);
  const enemyActive = await getActivePlayerPokemonForUpdate(opponentJid, connection);
  if (!myActive || !enemyActive) {
    return { error: 'active_missing' };
  }

  const mySnapshot = await buildPlayerBattleSnapshot({ playerPokemonRow: myActive });
  const enemySnapshot = await buildPlayerBattleSnapshot({ playerPokemonRow: enemyActive });
  if (mySnapshot.currentHp <= 0 || enemySnapshot.currentHp <= 0) {
    return { error: 'fainted' };
  }

  const turnJid = randomFromArray([challengerJid, opponentJid]);
  const battleSnapshot = buildPvpSnapshotState({
    challengerJid,
    challengerPokemonId: myActive.id,
    challengerSnapshot: mySnapshot,
    opponentJid,
    opponentPokemonId: enemyActive.id,
    opponentSnapshot: enemySnapshot,
    turnJid,
  });

  const challenge = await createPvpChallenge(
    {
      chatJid,
      challengerJid,
      opponentJid,
      status: 'pending',
      turnJid,
      battleSnapshot,
      startedAt: null,
      expiresAt: nowPlusPvpTtlDate(),
    },
    connection,
  );

  return { challenge };
};

const applyPvpWeeklyOutcome = async ({ winnerJid, loserJid, connection }) => {
  const weekRefDate = getCurrentWeekRefDate();
  await upsertPvpWeeklyStatsDelta(
    {
      weekRefDate,
      ownerJid: winnerJid,
      matchesPlayedDelta: 1,
      winsDelta: 1,
      lossesDelta: 0,
      pointsDelta: PVP_WIN_POINTS,
    },
    connection,
  );
  await upsertPvpWeeklyStatsDelta(
    {
      weekRefDate,
      ownerJid: loserJid,
      matchesPlayedDelta: 1,
      winsDelta: 0,
      lossesDelta: 1,
      pointsDelta: PVP_LOSS_POINTS,
    },
    connection,
  );

  await upsertSocialLinkDelta(
    {
      jidA: winnerJid,
      jidB: loserJid,
      rivalryDelta: 2,
      friendshipDelta: 0,
      interactionsDelta: 1,
    },
    connection,
  );
};

const resolveRivalryBonus = (rivalryScore) => {
  const score = Math.max(0, toInt(rivalryScore, 0));
  if (score >= 30) return { bonusXp: 45, bonusGold: 70 };
  if (score >= 15) return { bonusXp: 20, bonusGold: 30 };
  return { bonusXp: 0, bonusGold: 0 };
};

const ensureGroupCoopStateForUpdate = async ({ chatJid, connection }) => {
  const weekRefDate = getCurrentWeekRefDate();
  await upsertGroupCoopWeekly(
    {
      chatJid,
      weekRefDate,
      captureTarget: COOP_CAPTURE_TARGET,
      raidTarget: COOP_RAID_TARGET,
    },
    connection,
  );
  const row = await getGroupCoopWeeklyForUpdate(chatJid, weekRefDate, connection);
  return { weekRefDate, row };
};

const completeCoopIfNeeded = async ({ chatJid, weekRefDate, connection }) => {
  const coop = await getGroupCoopWeeklyForUpdate(chatJid, weekRefDate, connection);
  if (!coop) return { completedNow: false, rewardedCount: 0 };
  if (coop.status === 'completed') return { completedNow: false, rewardedCount: 0 };
  if (coop.capture_progress < coop.capture_target || coop.raid_progress < coop.raid_target) {
    return { completedNow: false, rewardedCount: 0 };
  }

  await markGroupCoopCompleted(chatJid, weekRefDate, connection);
  const members = await listUnrewardedGroupCoopMembersForUpdate(chatJid, weekRefDate, connection);
  let rewardedCount = 0;
  for (const member of members) {
    const contribution = toInt(member.capture_contribution, 0) + toInt(member.raid_contribution, 0);
    if (contribution <= 0) continue;
    const player = await getPlayerByJidForUpdate(member.owner_jid, connection);
    if (!player) continue;
    const nextXp = Math.max(0, toInt(player.xp, 0) + COOP_REWARD_XP);
    const nextGold = Math.max(0, toInt(player.gold, 0) + COOP_REWARD_GOLD);
    const nextLevel = calculatePlayerLevelFromXp(nextXp);
    await updatePlayerProgress(
      {
        jid: member.owner_jid,
        level: nextLevel,
        xp: nextXp,
        gold: nextGold,
      },
      connection,
    );
    await addInventoryItem(
      {
        ownerJid: member.owner_jid,
        itemKey: COOP_REWARD_ITEM_KEY,
        quantity: COOP_REWARD_ITEM_QTY,
      },
      connection,
    );
    await markGroupCoopMemberRewardClaimed(chatJid, weekRefDate, member.owner_jid, connection);
    await upsertGroupActivityDaily(
      {
        dayRefDate: getCurrentDayRefDate(),
        chatJid,
        ownerJid: member.owner_jid,
        actionsDelta: 0,
        coopCompletedDelta: 1,
      },
      connection,
    );
    rewardedCount += 1;
  }

  if (rewardedCount > 0) {
    recordRpgCoopCompleted();
  }

  return { completedNow: rewardedCount > 0, rewardedCount };
};

const applyGroupCoopContribution = async ({ chatJid, ownerJid, captureDelta = 0, raidDelta = 0, connection }) => {
  if (!isGroupJid(chatJid)) return { notices: [] };

  const { weekRefDate } = await ensureGroupCoopStateForUpdate({ chatJid, connection });
  await addGroupCoopContribution(
    {
      chatJid,
      weekRefDate,
      ownerJid,
      captureDelta,
      raidDelta,
    },
    connection,
  );
  const coop = await getGroupCoopWeekly(chatJid, weekRefDate, connection);
  const completion = await completeCoopIfNeeded({ chatJid, weekRefDate, connection });
  const notices = [];
  if (coop) {
    notices.push(`🤝 Coop semanal: capturas ${coop.capture_progress}/${coop.capture_target} | raids ${coop.raid_progress}/${coop.raid_target}`);
  }
  if (completion.completedNow) {
    notices.push(`🎉 Missão cooperativa semanal concluída! Recompensa entregue para ${completion.rewardedCount} jogador(es).`);
  }
  return { notices, completedNow: completion.completedNow };
};

const ensureWeeklyEventForUpdate = async ({ chatJid, connection }) => {
  const weekRefDate = getCurrentWeekRefDate();
  let event = await getGroupEventWeeklyForUpdate(chatJid, weekRefDate, connection);
  if (!event) {
    const definition = determineEventDefinitionForGroup({ chatJid, weekRefDate });
    const expiresAt = toDateFromDateOnly(weekRefDate, 7);
    await upsertGroupEventWeekly(
      {
        chatJid,
        weekRefDate,
        eventKey: definition.key,
        targetValue: definition.targetValue,
        expiresAt,
      },
      connection,
    );
    event = await getGroupEventWeeklyForUpdate(chatJid, weekRefDate, connection);
  }
  return { weekRefDate, event, definition: resolveEventDefinitionByKey(event?.event_key) };
};

const applyGroupWeeklyEventContribution = async ({ chatJid, ownerJid, trigger, value, connection }) => {
  if (!isGroupJid(chatJid)) return { notices: [] };
  const { weekRefDate, event, definition } = await ensureWeeklyEventForUpdate({
    chatJid,
    connection,
  });
  if (!event || !definition || definition.trigger !== trigger || event.status === 'completed') {
    return { notices: [] };
  }

  const delta = Math.max(0, toInt(value, 0));
  if (delta <= 0) return { notices: [] };

  await addGroupEventContribution(
    {
      chatJid,
      weekRefDate,
      ownerJid,
      contributionDelta: delta,
    },
    connection,
  );

  const refreshed = await getGroupEventWeeklyForUpdate(chatJid, weekRefDate, connection);
  const notices = [];
  if (refreshed) {
    notices.push(`🎯 Evento semanal (${definition.label}): ${refreshed.progress_value}/${refreshed.target_value}`);
    if (refreshed.status !== 'completed' && refreshed.progress_value >= refreshed.target_value) {
      await markGroupEventCompleted(chatJid, weekRefDate, connection);
      recordRpgWeeklyEventCompleted();
      notices.push('🏁 Evento semanal concluído! Use /rpg evento claim para resgatar.');
    }
  }

  return { notices };
};

const claimWeeklyEventReward = async ({ ownerJid, chatJid, connection }) => {
  if (!isGroupJid(chatJid)) {
    return { ok: true, text: 'Evento semanal só existe em grupos.' };
  }

  const { weekRefDate, event, definition } = await ensureWeeklyEventForUpdate({
    chatJid,
    connection,
  });
  if (!event || !definition) {
    return { ok: true, text: 'Evento semanal indisponível no momento.' };
  }
  if (event.status !== 'completed') {
    return {
      ok: true,
      text: `Evento da semana ainda em andamento: ${event.progress_value}/${event.target_value}.`,
    };
  }

  const member = await getGroupEventMemberForUpdate(chatJid, weekRefDate, ownerJid, connection);
  if (!member || toInt(member.contribution, 0) <= 0) {
    return { ok: true, text: 'Você não contribuiu neste evento semanal.' };
  }
  if (member.reward_claimed_at) {
    return { ok: true, text: 'Você já resgatou a recompensa deste evento.' };
  }

  const player = await getPlayerByJidForUpdate(ownerJid, connection);
  if (!player) return { ok: true, text: buildNeedStartText('/') };

  const nextXp = Math.max(0, toInt(player.xp, 0) + definition.rewardXp);
  const nextGold = Math.max(0, toInt(player.gold, 0) + definition.rewardGold);
  const nextLevel = calculatePlayerLevelFromXp(nextXp);
  await updatePlayerProgress(
    {
      jid: ownerJid,
      level: nextLevel,
      xp: nextXp,
      gold: nextGold,
    },
    connection,
  );
  await markGroupEventMemberRewardClaimed(chatJid, weekRefDate, ownerJid, connection);
  return {
    ok: true,
    text: `🎁 Recompensa do evento resgatada: +${definition.rewardGold} gold e +${definition.rewardXp} XP.`,
  };
};

const handleRaid = async ({ ownerJid, chatJid, commandPrefix, actionArgs = [] }) => {
  if (!isGroupJid(chatJid)) {
    return {
      ok: true,
      text: `🛡️ Raid só pode ser usada em grupos.\n💡 Use em um grupo: ${commandPrefix}rpg raid iniciar`,
    };
  }

  const sub = String(actionArgs?.[0] || 'status')
    .trim()
    .toLowerCase();

  return withTransaction(async (connection) => {
    await deleteExpiredRaidStates(connection);
    const currentRaid = await getRaidStateByChatForUpdate(chatJid, connection);
    const raidView = toRaidView(currentRaid);

    if (sub === 'status') {
      if (!raidView) {
        return {
          ok: true,
          text: buildRaidStatusText({ raid: null, participants: [], prefix: commandPrefix }),
        };
      }
      if (isDateExpired(raidView.endsAt)) {
        await deleteRaidStateByChat(chatJid, connection);
        return {
          ok: true,
          text: buildRaidStatusText({ raid: null, participants: [], prefix: commandPrefix }),
        };
      }
      const participants = await listRaidParticipants(chatJid, connection);
      return {
        ok: true,
        text: buildRaidStatusText({
          raid: raidView,
          participants: formatParticipantRows(participants),
          prefix: commandPrefix,
        }),
        imageUrl: raidView.bossSnapshot?.imageUrl || null,
      };
    }

    const player = await getPlayerByJidForUpdate(ownerJid, connection);
    if (!player) {
      return { ok: true, text: buildNeedStartText(commandPrefix) };
    }

    if (sub === 'iniciar' || sub === 'start') {
      if (raidView && !isDateExpired(raidView.endsAt)) {
        const participants = await listRaidParticipants(chatJid, connection);
        return {
          ok: true,
          text: buildRaidStatusText({
            raid: raidView,
            participants: formatParticipantRows(participants),
            prefix: commandPrefix,
          }),
          imageUrl: raidView.bossSnapshot?.imageUrl || null,
        };
      }

      const activePokemonRow = await getActivePlayerPokemonForUpdate(ownerJid, connection);
      if (!activePokemonRow) {
        return { ok: true, text: buildNeedActivePokemonText(commandPrefix) };
      }

      const activeSnapshot = await buildPlayerBattleSnapshot({
        playerPokemonRow: activePokemonRow,
      });
      if (activeSnapshot.currentHp <= 0) {
        return { ok: true, text: buildPokemonFaintedText(commandPrefix) };
      }

      const biome = await resolveBiomeForChat(chatJid, connection);
      const travel = await resolveTravelStateForOwner({ ownerJid, connection });
      const encounterPool = await resolveTravelEncounterPool(travel?.location_area_key);
      const { enemySnapshot } = await createWildEncounter({
        playerLevel: activePokemonRow.level,
        preferredTypes: biome?.preferredTypes || [],
        preferredHabitats: biome?.preferredHabitats || [],
        encounterPool,
      });

      const bossMaxHp = Math.max(1, Math.round(enemySnapshot.maxHp * 8));
      const bossSnapshot = {
        ...enemySnapshot,
        displayName: `${enemySnapshot.displayName} (Raid Boss)`,
        maxHp: bossMaxHp,
        currentHp: bossMaxHp,
      };

      const startedAt = __timeNow();
      const endsAt = nowPlusRaidTtlDate();
      await upsertRaidState(
        {
          chatJid,
          createdByJid: ownerJid,
          biomeKey: biome?.key || null,
          bossSnapshot,
          maxHp: bossMaxHp,
          currentHp: bossMaxHp,
          startedAt,
          endsAt,
        },
        connection,
      );
      await upsertRaidParticipant({ chatJid, ownerJid }, connection);
      recordRpgRaidStarted();

      return {
        ok: true,
        text: buildRaidStartText({
          bossName: bossSnapshot.displayName,
          level: bossSnapshot.level,
          currentHp: bossSnapshot.currentHp,
          maxHp: bossSnapshot.maxHp,
          expiresInMin: Math.max(1, Math.round(RAID_TTL_MS / 60000)),
          bossLore: trimLoreText(bossSnapshot?.flavorText || '', 170),
          prefix: commandPrefix,
        }),
        imageUrl: bossSnapshot.imageUrl || null,
      };
    }

    if (!raidView || isDateExpired(raidView.endsAt)) {
      if (raidView) await deleteRaidStateByChat(chatJid, connection);
      return {
        ok: true,
        text: buildRaidStatusText({ raid: null, participants: [], prefix: commandPrefix }),
      };
    }

    if (sub === 'entrar' || sub === 'join') {
      await upsertRaidParticipant({ chatJid, ownerJid }, connection);
      const participants = await listRaidParticipants(chatJid, connection);
      return {
        ok: true,
        text: buildRaidStatusText({
          raid: raidView,
          participants: formatParticipantRows(participants),
          prefix: commandPrefix,
        }),
      };
    }

    if (sub === 'atacar' || sub === 'attack') {
      const participant = await getRaidParticipant(chatJid, ownerJid, connection);
      if (!participant) {
        return {
          ok: true,
          text: `Você ainda não entrou na raid.\n👉 Use: ${commandPrefix}rpg raid entrar`,
        };
      }

      const moveSlot = actionArgs?.[1];
      const activePokemonRow = await getActivePlayerPokemonForUpdate(ownerJid, connection);
      if (!activePokemonRow) {
        return { ok: true, text: buildNeedActivePokemonText(commandPrefix) };
      }
      const playerSnapshot = await buildPlayerBattleSnapshot({
        playerPokemonRow: activePokemonRow,
      });
      if (playerSnapshot.currentHp <= 0) {
        return { ok: true, text: buildPokemonFaintedText(commandPrefix) };
      }

      const attack = resolveSingleAttack({
        attackerSnapshot: playerSnapshot,
        defenderSnapshot: raidView.bossSnapshot,
        moveSlot,
        attackerLabel: `Seu ${playerSnapshot.displayName}`,
        defenderLabel: raidView.bossSnapshot.displayName || 'Raid Boss',
      });
      const selectedMoveIndex = Math.max(0, toInt(moveSlot, 1) - 1);
      const selectedMove = Array.isArray(playerSnapshot?.moves) ? playerSnapshot.moves[selectedMoveIndex] : null;
      const selectedMoveLore = trimLoreText(selectedMove?.loreText || selectedMove?.shortEffect || '', 150);

      if (!attack.validMove) {
        return {
          ok: true,
          text: buildRaidAttackText({
            logs: [...attack.logs, ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : [])],
            currentHp: raidView.currentHp,
            maxHp: raidView.maxHp,
            defeated: false,
            ranking: [],
            prefix: commandPrefix,
          }),
        };
      }

      const socialBonus = await applySocialXpConversion({
        ownerJid,
        chatJid,
        connection,
        actionKey: 'raid_attack',
      });

      if (socialBonus.playerXpBonus > 0) {
        const playerForBonus = await getPlayerByJidForUpdate(ownerJid, connection);
        if (playerForBonus) {
          const nextPlayerXp = Math.max(0, toInt(playerForBonus.xp, 0) + socialBonus.playerXpBonus);
          const nextPlayerLevel = calculatePlayerLevelFromXp(nextPlayerXp);
          await updatePlayerProgress(
            {
              jid: ownerJid,
              level: nextPlayerLevel,
              xp: nextPlayerXp,
              gold: Math.max(0, toInt(playerForBonus.gold, 0)),
            },
            connection,
          );
        }
      }

      if (socialBonus.pokemonXpBonus > 0) {
        const socialPokemonProgress = applyPokemonXpGain({
          currentLevel: activePokemonRow.level,
          currentXp: activePokemonRow.xp,
          gainedXp: socialBonus.pokemonXpBonus,
        });
        await updatePlayerPokemonState(
          {
            id: activePokemonRow.id,
            ownerJid,
            level: socialPokemonProgress.level,
            xp: socialPokemonProgress.xp,
            currentHp: activePokemonRow.current_hp,
          },
          connection,
        );
      }

      const nextCurrentHp = clamp(toInt(attack.defender.currentHp, raidView.currentHp), 0, raidView.maxHp);
      await addRaidParticipantDamage(
        {
          chatJid,
          ownerJid,
          damage: attack.damage,
        },
        connection,
      );

      const defeated = nextCurrentHp <= 0;

      if (!defeated) {
        await upsertRaidState(
          {
            chatJid,
            createdByJid: currentRaid.created_by_jid,
            biomeKey: currentRaid.biome_key,
            bossSnapshot: {
              ...raidView.bossSnapshot,
              ...attack.defender,
              currentHp: nextCurrentHp,
              maxHp: raidView.maxHp,
            },
            maxHp: raidView.maxHp,
            currentHp: nextCurrentHp,
            startedAt: currentRaid.started_at,
            endsAt: currentRaid.ends_at,
          },
          connection,
        );

        const participants = await listRaidParticipants(chatJid, connection);
        const eventUpdate = await applyGroupWeeklyEventContribution({
          chatJid,
          ownerJid,
          trigger: 'raid_damage',
          value: attack.damage,
          connection,
        });
        return {
          ok: true,
          text: buildRaidAttackText({
            logs: [...attack.logs, ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : []), ...(socialBonus.notice ? [socialBonus.notice] : []), `💥 Dano causado: ${attack.damage}`, ...(eventUpdate.notices || [])],
            currentHp: nextCurrentHp,
            maxHp: raidView.maxHp,
            defeated: false,
            ranking: formatParticipantRows(participants),
            prefix: commandPrefix,
          }),
          imageUrl: raidView.bossSnapshot?.imageUrl || null,
        };
      }

      const participants = await listRaidParticipants(chatJid, connection);
      const totalDamage = participants.reduce((acc, entry) => acc + toInt(entry.total_damage, 0), 0);
      const mentions = [];
      const coopNotices = [];

      for (const entry of participants) {
        const participantJid = entry.owner_jid;
        mentions.push(participantJid);
        const participantDamage = toInt(entry.total_damage, 0);
        const rewards = resolveRaidRewards({
          bossLevel: raidView.level,
          totalDamage,
          participantDamage,
        });
        const karmaBonus = await applyKarmaBonus({
          ownerJid: participantJid,
          gold: rewards.gold,
          xp: rewards.playerXp,
          connection,
        });
        const totalPlayerXp = rewards.playerXp + karmaBonus.bonusXp;
        const totalGold = rewards.gold + karmaBonus.bonusGold;

        const participantPlayer = await getPlayerByJidForUpdate(participantJid, connection);
        if (!participantPlayer) continue;
        const nextPlayerXp = Math.max(0, toInt(participantPlayer.xp, 0) + totalPlayerXp);
        const nextPlayerGold = Math.max(0, toInt(participantPlayer.gold, 0) + totalGold);
        const nextPlayerLevel = calculatePlayerLevelFromXp(nextPlayerXp);

        await updatePlayerProgress(
          {
            jid: participantJid,
            level: nextPlayerLevel,
            xp: nextPlayerXp,
            gold: nextPlayerGold,
          },
          connection,
        );

        const participantActive = await getActivePlayerPokemonForUpdate(participantJid, connection);
        if (participantActive) {
          const pokemonProgress = applyPokemonXpGain({
            currentLevel: participantActive.level,
            currentXp: participantActive.xp,
            gainedXp: rewards.pokemonXp,
          });
          await updatePlayerPokemonState(
            {
              id: participantActive.id,
              ownerJid: participantJid,
              level: pokemonProgress.level,
              xp: pokemonProgress.xp,
              currentHp: participantActive.current_hp,
            },
            connection,
          );
        }

        const coopUpdate = await applyGroupCoopContribution({
          chatJid,
          ownerJid: participantJid,
          captureDelta: 0,
          raidDelta: 1,
          connection,
        });
        if (coopUpdate.notices?.length) {
          coopNotices.push(...coopUpdate.notices);
        }
      }

      for (let i = 0; i < participants.length; i += 1) {
        for (let j = i + 1; j < participants.length; j += 1) {
          const jidA = participants[i]?.owner_jid;
          const jidB = participants[j]?.owner_jid;
          if (!jidA || !jidB || jidA === jidB) continue;
          await upsertSocialLinkDelta(
            {
              jidA,
              jidB,
              friendshipDelta: 1,
              rivalryDelta: 0,
              interactionsDelta: 1,
            },
            connection,
          );
        }
      }

      recordRpgRaidCompleted();
      await deleteRaidParticipantsByChat(chatJid, connection);
      await deleteRaidStateByChat(chatJid, connection);

      return {
        ok: true,
        text: buildRaidAttackText({
          logs: [...attack.logs, ...(selectedMoveLore ? [`📖 Golpe: ${selectedMoveLore}`] : []), ...(socialBonus.notice ? [socialBonus.notice] : []), `💥 Dano final: ${attack.damage}`, ...Array.from(new Set(coopNotices))],
          currentHp: 0,
          maxHp: raidView.maxHp,
          defeated: true,
          ranking: formatParticipantRows(participants),
          prefix: commandPrefix,
        }),
        imageUrl: raidView.bossSnapshot?.imageUrl || null,
        mentions: buildEngagementMentions(mentions),
      };
    }

    return {
      ok: true,
      text: `Use: ${commandPrefix}rpg raid <iniciar|entrar|atacar|status>`,
    };
  });
};

const resolvePvpChallengeCreateErrorText = (errorCode) => {
  if (errorCode === 'player_not_found') return 'Um dos jogadores ainda não iniciou no RPG.';
  if (errorCode === 'challenge_exists') return 'Já existe um desafio PvP pendente/ativo para um dos jogadores.';
  if (errorCode === 'active_missing') return 'Ambos os jogadores precisam ter Pokémon ativo para PvP.';
  if (errorCode === 'fainted') return 'Um dos Pokémon ativos está sem HP. Recupere antes do PvP.';
  return 'Não foi possível criar o desafio PvP agora.';
};

const handleChallenge = async ({ ownerJid, chatJid, commandPrefix, actionArgs = [], mentionedJids = [] }) => {
  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) {
    return { ok: true, text: 'Não foi possível identificar o seu usuário para PvP.' };
  }

  const opponentJid = await resolveOpponentJidFromArgs({ actionArgs, mentionedJids });
  if (!opponentJid) {
    return {
      ok: true,
      text: `Use: ${commandPrefix}rpg desafiar <jid/@numero>`,
    };
  }

  if (opponentJid === canonicalOwnerJid) {
    return {
      ok: true,
      text: 'Você não pode se desafiar no PvP.',
    };
  }

  const pvpCooldown = getPvpCooldownSecondsLeft(canonicalOwnerJid);
  if (pvpCooldown > 0) {
    return {
      ok: true,
      text: `⏳ Aguarde ${pvpCooldown}s para enviar outro desafio PvP.`,
    };
  }

  const created = await withTransaction(async (connection) => {
    await expireOldPvpChallenges(connection);
    return createPvpChallengeBetweenPlayers({
      challengerJid: canonicalOwnerJid,
      opponentJid,
      chatJid,
      connection,
    });
  });

  if (created?.error) {
    return { ok: true, text: resolvePvpChallengeCreateErrorText(created.error) };
  }

  const challenge = created?.challenge;
  if (!challenge) {
    return { ok: true, text: resolvePvpChallengeCreateErrorText('unknown') };
  }
  const duelLabels = toPvpDuelLabels({
    battleSnapshot: challenge?.battle_snapshot_json,
    challengerJid: canonicalOwnerJid,
    opponentJid,
  });

  touchPvpCooldown(canonicalOwnerJid);
  recordRpgPvpChallenge();
  await trackGroupActivity({
    chatJid,
    ownerJid: canonicalOwnerJid,
    actionsDelta: 0,
    pvpCreatedDelta: 1,
  });

  const challengerLabel = toMentionLabel(canonicalOwnerJid);
  const opponentLabel = toMentionLabel(opponentJid);
  return {
    ok: true,
    text: buildPvpChallengeText({
      challengeId: challenge.id,
      challengerJid: challengerLabel,
      opponentJid: opponentLabel,
      challengerPokemonLabel: duelLabels.challengerPokemonLabel,
      opponentPokemonLabel: duelLabels.opponentPokemonLabel,
      prefix: commandPrefix,
    }),
    mentions: buildEngagementMentions(canonicalOwnerJid, opponentJid),
  };
};

const handlePvpStatus = async ({ ownerJid, chatJid, commandPrefix }) => {
  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) {
    return { ok: true, text: 'Não foi possível identificar o seu usuário para PvP.' };
  }

  await withTransaction(async (connection) => {
    await expireOldPvpChallenges(connection);
    await expirePvpQueue(connection);
  });

  const open = await listOpenPvpChallengesByPlayer(canonicalOwnerJid);
  const pending = open
    .filter((entry) => entry.status === 'pending' && entry.opponent_jid === canonicalOwnerJid)
    .map((entry) => ({
      id: entry.id,
      challengerJid: entry.challenger_jid,
      challengerLabel: toMentionLabel(entry.challenger_jid),
      challengerPokemonLabel: toPvpDuelLabels({
        battleSnapshot: entry?.battle_snapshot_json,
        challengerJid: entry.challenger_jid,
        opponentJid: entry.opponent_jid,
      }).challengerPokemonLabel,
    }));
  const active = open.find((entry) => entry.status === 'active') || null;
  const activeView = active ? toPvpStatusView({ challenge: active, ownerJid: canonicalOwnerJid }) : null;
  const queue = isGroupJid(chatJid) ? await listQueuedPvpByChat(chatJid, 10) : [];
  const queueView = queue.slice(0, 8).map((entry) => ({
    ...entry,
    ownerLabel: toMentionLabel(entry.owner_jid),
  }));
  const statusMentions = buildEngagementMentions(
    canonicalOwnerJid,
    pending.map((entry) => entry.challengerJid),
    active ? [active.challenger_jid, active.opponent_jid, active.turn_jid] : [],
    queueView.map((entry) => entry.owner_jid),
  );

  const statusText = buildPvpStatusText({
    pending,
    active: activeView,
    ownerJid: canonicalOwnerJid,
    prefix: commandPrefix,
  });

  if (!isGroupJid(chatJid)) {
    return { ok: true, text: statusText, mentions: statusMentions };
  }

  return {
    ok: true,
    text: `${statusText}\n\n${buildPvpQueueStatusText({ queue: queueView, ownerJid: canonicalOwnerJid, prefix: commandPrefix })}`,
    mentions: statusMentions,
  };
};

const handlePvpQueue = async ({ ownerJid, chatJid, commandPrefix, actionArgs = [] }) => {
  if (!isGroupJid(chatJid)) {
    return { ok: true, text: 'Fila PvP só funciona em grupos.' };
  }

  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) return { ok: true, text: 'Não foi possível identificar o seu usuário para PvP.' };

  const queueAction = String(actionArgs?.[1] || 'status')
    .trim()
    .toLowerCase();

  return withTransaction(async (connection) => {
    await expireOldPvpChallenges(connection);
    await expirePvpQueue(connection);

    if (queueAction === 'sair' || queueAction === 'leave') {
      const removed = await cancelQueuedPvpByOwner(chatJid, canonicalOwnerJid, connection);
      if (!removed) {
        return { ok: true, text: 'Você não estava na fila PvP deste grupo.' };
      }
      recordRpgPvpQueue('leave');
      return { ok: true, text: '✅ Você saiu da fila PvP.' };
    }

    if (queueAction === 'status' || queueAction === 'listar') {
      const queue = await listQueuedPvpByChat(chatJid, 15, connection);
      const queueView = queue.slice(0, 8).map((entry) => ({
        ...entry,
        ownerLabel: toMentionLabel(entry.owner_jid),
      }));
      return {
        ok: true,
        text: buildPvpQueueStatusText({
          queue: queueView,
          ownerJid: canonicalOwnerJid,
          prefix: commandPrefix,
        }),
        mentions: buildEngagementMentions(queueView.map((entry) => entry.owner_jid)),
      };
    }

    if (queueAction !== 'entrar' && queueAction !== 'join') {
      return {
        ok: true,
        text: `Use: ${commandPrefix}rpg pvp fila <entrar|sair|status>`,
      };
    }

    const player = await getPlayerByJidForUpdate(canonicalOwnerJid, connection);
    if (!player) return { ok: true, text: buildNeedStartText(commandPrefix) };
    const activePokemon = await getActivePlayerPokemonForUpdate(canonicalOwnerJid, connection);
    if (!activePokemon) return { ok: true, text: buildNeedActivePokemonText(commandPrefix) };
    if (toInt(activePokemon.current_hp, 0) <= 0) return { ok: true, text: buildPokemonFaintedText(commandPrefix) };

    const existingChallenge = await listOpenPvpChallengesByPlayer(canonicalOwnerJid, connection);
    if ((existingChallenge || []).length) {
      return { ok: true, text: 'Você já tem um PvP pendente/ativo.' };
    }

    await enqueuePvpQueue(
      {
        chatJid,
        ownerJid: canonicalOwnerJid,
        expiresAt: new Date(__timeNowMs() + PVP_QUEUE_TTL_MS),
      },
      connection,
    );
    recordRpgPvpQueue('join');

    const myQueue = await getQueuedPvpByOwnerForUpdate(chatJid, canonicalOwnerJid, connection);
    const queue = await listQueuedPvpByChatForUpdate(chatJid, 20, connection);
    const opponentQueue = queue.find((entry) => entry.owner_jid !== canonicalOwnerJid) || null;

    if (!myQueue || !opponentQueue) {
      const queueView = queue.slice(0, 8).map((entry) => ({
        ...entry,
        ownerLabel: toMentionLabel(entry.owner_jid),
      }));
      return {
        ok: true,
        text: buildPvpQueueStatusText({
          queue: queueView,
          ownerJid: canonicalOwnerJid,
          prefix: commandPrefix,
        }),
        mentions: buildEngagementMentions(queueView.map((entry) => entry.owner_jid)),
      };
    }

    const created = await createPvpChallengeBetweenPlayers({
      challengerJid: canonicalOwnerJid,
      opponentJid: opponentQueue.owner_jid,
      chatJid,
      connection,
    });

    if (created?.error) {
      return { ok: true, text: resolvePvpChallengeCreateErrorText(created.error) };
    }

    const challenge = created?.challenge;
    if (!challenge) return { ok: true, text: 'Falha ao criar o match da fila PvP.' };
    const duelLabels = toPvpDuelLabels({
      battleSnapshot: challenge?.battle_snapshot_json,
      challengerJid: canonicalOwnerJid,
      opponentJid: opponentQueue.owner_jid,
    });

    await markPvpQueueMatchedByIds([myQueue.id, opponentQueue.id], challenge.id, connection);
    const dayRefDate = getCurrentDayRefDate();
    await upsertGroupActivityDaily(
      {
        dayRefDate,
        chatJid,
        ownerJid: canonicalOwnerJid,
        actionsDelta: 0,
        pvpCreatedDelta: 1,
      },
      connection,
    );
    await upsertGroupActivityDaily(
      {
        dayRefDate,
        chatJid,
        ownerJid: opponentQueue.owner_jid,
        actionsDelta: 0,
        pvpCreatedDelta: 1,
      },
      connection,
    );
    recordRpgPvpQueue('match');
    recordRpgPvpChallenge();
    const challengerLabel = toMentionLabel(canonicalOwnerJid);
    const opponentLabel = toMentionLabel(opponentQueue.owner_jid);
    return {
      ok: true,
      text: `${buildPvpChallengeText({
        challengeId: challenge.id,
        challengerJid: challengerLabel,
        opponentJid: opponentLabel,
        challengerPokemonLabel: duelLabels.challengerPokemonLabel,
        opponentPokemonLabel: duelLabels.opponentPokemonLabel,
        prefix: commandPrefix,
      })}\n\n🔥 Match encontrado pela fila automaticamente.`,
      mentions: buildEngagementMentions(canonicalOwnerJid, opponentQueue.owner_jid),
    };
  });
};

const handlePvpRanking = async ({ commandPrefix }) => {
  const weekRefDate = getCurrentWeekRefDate();
  const ranking = await listPvpWeeklyRanking(weekRefDate, 10);
  const rankingView = ranking.map((entry) => ({
    ...entry,
    ownerLabel: toMentionLabel(entry.owner_jid),
  }));
  return {
    ok: true,
    text: buildPvpWeeklyRankingText({ weekRefDate, ranking: rankingView, prefix: commandPrefix }),
    mentions: buildEngagementMentions(rankingView.map((entry) => entry.owner_jid)),
  };
};

const handlePvpRevanche = async ({ ownerJid, chatJid, commandPrefix, actionArgs = [], mentionedJids = [] }) => {
  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) return { ok: true, text: 'Não foi possível identificar o seu usuário para PvP.' };

  let opponentJid = await resolveOpponentJidFromArgs({
    actionArgs: actionArgs.slice(1),
    mentionedJids,
  });

  if (!opponentJid) {
    const latest = await getLatestFinishedPvpByPlayer(canonicalOwnerJid);
    opponentJid = resolvePvpOpponentJid(latest, canonicalOwnerJid);
  }

  if (!opponentJid) {
    return { ok: true, text: 'Nenhum oponente recente encontrado para revanche.' };
  }
  if (opponentJid === canonicalOwnerJid) {
    return { ok: true, text: 'Você não pode criar revanche com você mesmo.' };
  }

  const created = await withTransaction(async (connection) => {
    await expireOldPvpChallenges(connection);
    return createPvpChallengeBetweenPlayers({
      challengerJid: canonicalOwnerJid,
      opponentJid,
      chatJid,
      connection,
    });
  });
  if (created?.error) {
    return { ok: true, text: resolvePvpChallengeCreateErrorText(created.error) };
  }
  if (!created?.challenge) {
    return { ok: true, text: 'Não foi possível criar a revanche agora.' };
  }
  const duelLabels = toPvpDuelLabels({
    battleSnapshot: created?.challenge?.battle_snapshot_json,
    challengerJid: canonicalOwnerJid,
    opponentJid,
  });

  recordRpgPvpChallenge();
  await trackGroupActivity({
    chatJid,
    ownerJid: canonicalOwnerJid,
    actionsDelta: 0,
    pvpCreatedDelta: 1,
  });
  const challengerLabel = toMentionLabel(canonicalOwnerJid);
  const opponentLabel = toMentionLabel(opponentJid);
  return {
    ok: true,
    text: `${buildPvpChallengeText({
      challengeId: created.challenge.id,
      challengerJid: challengerLabel,
      opponentJid: opponentLabel,
      challengerPokemonLabel: duelLabels.challengerPokemonLabel,
      opponentPokemonLabel: duelLabels.opponentPokemonLabel,
      prefix: commandPrefix,
    })}\n\n🔁 Revanche criada.`,
    mentions: buildEngagementMentions(canonicalOwnerJid, opponentJid),
  };
};

const handlePvp = async ({ ownerJid, chatJid, commandPrefix, actionArgs = [], mentionedJids = [] }) => {
  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) {
    return { ok: true, text: 'Não foi possível identificar o seu usuário para PvP.' };
  }

  const sub = String(actionArgs?.[0] || 'status')
    .trim()
    .toLowerCase();

  if (sub === 'status' || sub === 'listar') {
    return handlePvpStatus({ ownerJid: canonicalOwnerJid, chatJid, commandPrefix });
  }

  if (sub === 'fila' || sub === 'queue') {
    return handlePvpQueue({
      ownerJid: canonicalOwnerJid,
      chatJid,
      commandPrefix,
      actionArgs,
    });
  }

  if (sub === 'ranking' || sub === 'rank') {
    return handlePvpRanking({ commandPrefix });
  }

  if (sub === 'revanche' || sub === 'rematch') {
    return handlePvpRevanche({
      ownerJid: canonicalOwnerJid,
      chatJid,
      commandPrefix,
      actionArgs,
      mentionedJids,
    });
  }

  if (sub === 'aceitar' || sub === 'accept') {
    const challengeId = toInt(actionArgs?.[1], NaN);
    if (!Number.isFinite(challengeId) || challengeId <= 0) {
      return { ok: true, text: `Use: ${commandPrefix}rpg pvp aceitar <id>` };
    }

    return withTransaction(async (connection) => {
      await expireOldPvpChallenges(connection);
      const challenge = await getPvpChallengeByIdForUpdate(challengeId, connection);
      if (!challenge || challenge.status !== 'pending') {
        return { ok: true, text: 'Desafio não encontrado ou não está pendente.' };
      }
      if (challenge.opponent_jid !== canonicalOwnerJid) {
        return { ok: true, text: 'Apenas o oponente pode aceitar este desafio.' };
      }
      if (isDateExpired(challenge.expires_at)) {
        await updatePvpChallengeState({ id: challenge.id, status: 'expired' }, connection);
        return { ok: true, text: 'Esse desafio expirou.' };
      }

      await updatePvpChallengeState(
        {
          id: challenge.id,
          status: 'active',
          startedAt: __timeNow(),
          expiresAt: nowPlusPvpTtlDate(),
        },
        connection,
      );

      const view = toPvpStatusView({ challenge, ownerJid: canonicalOwnerJid });
      return {
        ok: true,
        text: buildPvpStatusText({
          pending: [],
          active: view,
          ownerJid: canonicalOwnerJid,
          prefix: commandPrefix,
        }),
        mentions: buildEngagementMentions(challenge.challenger_jid, challenge.opponent_jid, challenge.turn_jid),
      };
    });
  }

  if (sub === 'recusar' || sub === 'reject') {
    const challengeId = toInt(actionArgs?.[1], NaN);
    if (!Number.isFinite(challengeId) || challengeId <= 0) {
      return { ok: true, text: `Use: ${commandPrefix}rpg pvp recusar <id>` };
    }

    return withTransaction(async (connection) => {
      const challenge = await getPvpChallengeByIdForUpdate(challengeId, connection);
      if (!challenge || challenge.status !== 'pending') {
        return { ok: true, text: 'Desafio não encontrado ou inválido.' };
      }
      if (challenge.opponent_jid !== canonicalOwnerJid) {
        return { ok: true, text: 'Apenas o oponente pode recusar este desafio.' };
      }
      await updatePvpChallengeState(
        {
          id: challenge.id,
          status: 'rejected',
          turnJid: null,
        },
        connection,
      );
      return { ok: true, text: '❌ Desafio recusado.' };
    });
  }

  if (sub === 'fugir' || sub === 'forfeit') {
    const outcome = await withTransaction(async (connection) => {
      await expireOldPvpChallenges(connection);
      const challenge = await getActivePvpChallengeByPlayerForUpdate(canonicalOwnerJid, connection);
      if (!challenge) {
        return { ok: true, text: 'Você não tem PvP ativo.' };
      }
      const opponentJid = resolvePvpOpponentJid(challenge, canonicalOwnerJid);
      await updatePvpChallengeState(
        {
          id: challenge.id,
          status: 'finished',
          winnerJid: opponentJid,
          turnJid: null,
          expiresAt: __timeNow(),
        },
        connection,
      );
      await applyPvpWeeklyOutcome({
        winnerJid: opponentJid,
        loserJid: canonicalOwnerJid,
        connection,
      });
      const eventUpdate = await applyGroupWeeklyEventContribution({
        chatJid: challenge.chat_jid || chatJid,
        ownerJid: opponentJid,
        trigger: 'pvp_win',
        value: 1,
        connection,
      });

      recordRpgPvpCompleted();
      recordRpgBattleDuration({
        mode: 'pvp',
        outcome: 'forfeit',
        seconds: toDurationSeconds(challenge?.battle_snapshot_json?.startedAt || challenge.started_at),
      });

      return {
        ok: true,
        text: `🏳️ Você desistiu do PvP.\nVencedor: ${toMentionLabel(opponentJid)}${eventUpdate.notices?.length ? `\n${eventUpdate.notices.join('\n')}` : ''}`,
        winnerJid: opponentJid,
        mentions: buildEngagementMentions(opponentJid, canonicalOwnerJid),
      };
    });

    if (outcome?.winnerJid) {
      await trackGroupActivity({
        chatJid,
        ownerJid: outcome.winnerJid,
        actionsDelta: 0,
        pvpCompletedDelta: 1,
      });
    }
    return outcome;
  }

  if (sub === 'atacar' || sub === 'attack') {
    const moveSlot = actionArgs?.[1];
    const output = await withTransaction(async (connection) => {
      await expireOldPvpChallenges(connection);
      const challenge = await getActivePvpChallengeByPlayerForUpdate(canonicalOwnerJid, connection);
      if (!challenge) {
        return { ok: true, text: 'Você não tem PvP ativo.' };
      }

      if (challenge.turn_jid !== canonicalOwnerJid) {
        return {
          ok: true,
          text: `⏳ Aguarde seu turno. Turno atual: ${toMentionLabel(challenge.turn_jid)}`,
          mentions: buildEngagementMentions(challenge.turn_jid),
        };
      }

      const snapshot = challenge?.battle_snapshot_json || {};
      const players = snapshot.players || {};
      const me = players[canonicalOwnerJid];
      const opponentJid = resolvePvpOpponentJid(challenge, canonicalOwnerJid);
      const enemy = opponentJid ? players[opponentJid] : null;
      if (!me || !enemy) {
        await updatePvpChallengeState({ id: challenge.id, status: 'expired', turnJid: null }, connection);
        return { ok: true, text: 'Partida PvP inválida/expirada.' };
      }
      if (toInt(me?.pokemon?.currentHp, 0) <= 0 || toInt(enemy?.pokemon?.currentHp, 0) <= 0) {
        await updatePvpChallengeState(
          {
            id: challenge.id,
            status: 'finished',
            winnerJid: toInt(me?.pokemon?.currentHp, 0) > 0 ? canonicalOwnerJid : opponentJid,
            turnJid: null,
            expiresAt: __timeNow(),
          },
          connection,
        );
        return { ok: true, text: 'Esta partida já foi finalizada.' };
      }

      const attack = resolveSingleAttack({
        attackerSnapshot: me.pokemon,
        defenderSnapshot: enemy.pokemon,
        moveSlot,
        attackerLabel: `Seu ${me.pokemon.displayName}`,
        defenderLabel: `${enemy.pokemon.displayName}`,
      });
      if (!attack.validMove) {
        const turnLogs = attack.logs;
        const turnText = buildPvpTurnText({
          logs: turnLogs,
          myPokemonLabel: toPvpPokemonLabel(me.pokemon),
          enemyPokemonLabel: toPvpPokemonLabel(enemy.pokemon),
          myHp: me.pokemon.currentHp,
          myMaxHp: me.pokemon.maxHp,
          enemyHp: enemy.pokemon.currentHp,
          enemyMaxHp: enemy.pokemon.maxHp,
          winnerJid: null,
          prefix: commandPrefix,
        });
        return {
          ...(await withBattleCanvasFrame({
            text: turnText,
            battleSnapshot: {
              mode: 'pvp',
              turn: toInt(snapshot.turn, 1),
              biome: { label: 'Arena PvP' },
              my: me.pokemon,
              enemy: enemy.pokemon,
            },
            logs: turnLogs,
            modeLabel: 'Batalha PvP',
            actionText: turnLogs[turnLogs.length - 1] || 'Movimento invalido.',
            pokemonSnapshotFallback: enemy.pokemon || me.pokemon,
          })),
        };
      }

      const nextSnapshot = {
        ...snapshot,
        turn: toInt(snapshot.turn, 1) + 1,
        players: {
          ...players,
          [canonicalOwnerJid]: {
            ...me,
            pokemon: attack.attacker,
          },
          [opponentJid]: {
            ...enemy,
            pokemon: attack.defender,
          },
        },
      };

      const myPokemonRow = await getPlayerPokemonByIdForUpdate(canonicalOwnerJid, toInt(me.pokemonId, 0), connection);
      const enemyPokemonRow = await getPlayerPokemonByIdForUpdate(opponentJid, toInt(enemy.pokemonId, 0), connection);

      if (myPokemonRow) {
        await updatePlayerPokemonState(
          {
            id: myPokemonRow.id,
            ownerJid: canonicalOwnerJid,
            level: myPokemonRow.level,
            xp: myPokemonRow.xp,
            currentHp: Math.max(0, toInt(attack.attacker.currentHp, 0)),
          },
          connection,
        );
      }

      if (enemyPokemonRow) {
        await updatePlayerPokemonState(
          {
            id: enemyPokemonRow.id,
            ownerJid: opponentJid,
            level: enemyPokemonRow.level,
            xp: enemyPokemonRow.xp,
            currentHp: Math.max(0, toInt(attack.defender.currentHp, 0)),
          },
          connection,
        );
      }

      let winnerJid = null;
      const notices = [];
      if (toInt(attack.defender.currentHp, 0) <= 0) {
        winnerJid = canonicalOwnerJid;

        const socialBefore = await getSocialLinkByUsers(canonicalOwnerJid, opponentJid, connection);
        const rivalryBonus = resolveRivalryBonus(toInt(socialBefore?.rivalry_score, 0) + 2);
        const karmaBonus = await applyKarmaBonus({
          ownerJid: canonicalOwnerJid,
          gold: PVP_WIN_GOLD,
          xp: PVP_WIN_PLAYER_XP,
          connection,
        });

        const winnerPlayer = await getPlayerByJidForUpdate(canonicalOwnerJid, connection);
        if (winnerPlayer) {
          const totalXpReward = PVP_WIN_PLAYER_XP + rivalryBonus.bonusXp + karmaBonus.bonusXp;
          const totalGoldReward = PVP_WIN_GOLD + rivalryBonus.bonusGold + karmaBonus.bonusGold;
          const nextXp = Math.max(0, toInt(winnerPlayer.xp, 0) + totalXpReward);
          const nextGold = Math.max(0, toInt(winnerPlayer.gold, 0) + totalGoldReward);
          const nextLevel = calculatePlayerLevelFromXp(nextXp);
          await updatePlayerProgress(
            {
              jid: canonicalOwnerJid,
              level: nextLevel,
              xp: nextXp,
              gold: nextGold,
            },
            connection,
          );
          if (rivalryBonus.bonusXp > 0 || rivalryBonus.bonusGold > 0) {
            notices.push(`🔥 Bônus de rivalidade: +${rivalryBonus.bonusXp} XP e +${rivalryBonus.bonusGold} gold.`);
          }
          if (karmaBonus.bonusXp > 0 || karmaBonus.bonusGold > 0) {
            notices.push(`🌟 Bônus de karma: +${karmaBonus.bonusXp} XP e +${karmaBonus.bonusGold} gold.`);
          }
        }

        const winnerPokemon = await getPlayerPokemonByIdForUpdate(canonicalOwnerJid, toInt(me.pokemonId, 0), connection);
        if (winnerPokemon) {
          const progress = applyPokemonXpGain({
            currentLevel: winnerPokemon.level,
            currentXp: winnerPokemon.xp,
            gainedXp: PVP_WIN_POKEMON_XP,
          });
          await updatePlayerPokemonState(
            {
              id: winnerPokemon.id,
              ownerJid: canonicalOwnerJid,
              level: progress.level,
              xp: progress.xp,
              currentHp: Math.max(0, toInt(attack.attacker.currentHp, 0)),
            },
            connection,
          );
        }

        await updatePvpChallengeState(
          {
            id: challenge.id,
            status: 'finished',
            winnerJid,
            turnJid: null,
            battleSnapshot: nextSnapshot,
            expiresAt: __timeNow(),
          },
          connection,
        );

        await applyPvpWeeklyOutcome({
          winnerJid: canonicalOwnerJid,
          loserJid: opponentJid,
          connection,
        });
        const eventUpdate = await applyGroupWeeklyEventContribution({
          chatJid: challenge.chat_jid || chatJid,
          ownerJid: canonicalOwnerJid,
          trigger: 'pvp_win',
          value: 1,
          connection,
        });
        if (eventUpdate.notices?.length) notices.push(...eventUpdate.notices);

        recordRpgPvpCompleted();
        recordRpgBattleDuration({
          mode: 'pvp',
          outcome: 'finished',
          seconds: toDurationSeconds(snapshot.startedAt || challenge.started_at),
        });
      } else {
        await updatePvpChallengeState(
          {
            id: challenge.id,
            status: 'active',
            turnJid: opponentJid,
            battleSnapshot: nextSnapshot,
            expiresAt: nowPlusPvpTtlDate(),
          },
          connection,
        );
      }

      const turnLogs = [...attack.logs, `💥 Dano: ${attack.damage}`, ...(notices || [])];
      const turnText = buildPvpTurnText({
        logs: turnLogs,
        myPokemonLabel: toPvpPokemonLabel(attack.attacker),
        enemyPokemonLabel: toPvpPokemonLabel(attack.defender),
        myHp: toInt(attack.attacker.currentHp, 0),
        myMaxHp: Math.max(1, toInt(attack.attacker.maxHp, 1)),
        enemyHp: Math.max(0, toInt(attack.defender.currentHp, 0)),
        enemyMaxHp: Math.max(1, toInt(attack.defender.maxHp, 1)),
        winnerJid: winnerJid
          ? {
              jid: winnerJid,
              label: toMentionLabel(winnerJid),
            }
          : null,
        prefix: commandPrefix,
      });

      return withBattleCanvasFrame({
        text: turnText,
        battleSnapshot: {
          mode: 'pvp',
          turn: toInt(nextSnapshot.turn, 1),
          biome: { label: 'Arena PvP' },
          my: attack.attacker,
          enemy: attack.defender,
        },
        logs: turnLogs,
        modeLabel: 'Batalha PvP',
        actionText: turnLogs[turnLogs.length - 1] || 'Turno atualizado.',
        pokemonSnapshotFallback: attack.defender || attack.attacker,
        extra: {
          winnerJid,
          loserJid: winnerJid ? opponentJid : null,
          mentions: winnerJid ? buildEngagementMentions(winnerJid, opponentJid) : [],
        },
      });
    });

    if (output?.winnerJid && output?.loserJid) {
      await trackGroupActivity({
        chatJid,
        ownerJid: output.winnerJid,
        actionsDelta: 0,
        pvpCompletedDelta: 1,
      });
    }
    return output;
  }

  return {
    ok: true,
    text: `Use: ${commandPrefix}rpg pvp <status|fila|ranking|revanche|aceitar|recusar|atacar|fugir>`,
  };
};

const validateTradeAssetForOwner = async ({ ownerJid, asset, connection }) => {
  if (!asset || typeof asset !== 'object') {
    return { ok: false, reason: 'asset_invalid' };
  }

  if (asset.type === 'item') {
    const inventory = await getInventoryItemForUpdate(ownerJid, asset.itemKey, connection);
    if (!inventory || toInt(inventory.quantity, 0) < Math.max(1, toInt(asset.quantity, 1))) {
      return { ok: false, reason: 'item_missing' };
    }
    return { ok: true };
  }

  if (asset.type === 'pokemon') {
    const pokemon = await getPlayerPokemonByIdForUpdate(ownerJid, asset.pokemonId, connection);
    if (!pokemon) return { ok: false, reason: 'pokemon_missing' };
    if (pokemon.is_active) return { ok: false, reason: 'pokemon_active' };
    const total = await countPlayerPokemons(ownerJid, connection);
    if (total <= 1) return { ok: false, reason: 'pokemon_last' };
    return { ok: true };
  }

  return { ok: false, reason: 'asset_invalid' };
};

const transferTradeAsset = async ({ fromJid, toJid, asset, connection }) => {
  if (asset.type === 'item') {
    const consumed = await consumeInventoryItem(
      {
        ownerJid: fromJid,
        itemKey: asset.itemKey,
        quantity: Math.max(1, toInt(asset.quantity, 1)),
      },
      connection,
    );
    if (!consumed) return false;
    await addInventoryItem(
      {
        ownerJid: toJid,
        itemKey: asset.itemKey,
        quantity: Math.max(1, toInt(asset.quantity, 1)),
      },
      connection,
    );
    return true;
  }

  if (asset.type === 'pokemon') {
    const moved = await transferPlayerPokemon(
      {
        pokemonId: asset.pokemonId,
        fromOwnerJid: fromJid,
        toOwnerJid: toJid,
      },
      connection,
    );
    if (!moved) return false;
    const receiverActive = await getActivePlayerPokemonForUpdate(toJid, connection);
    if (!receiverActive) {
      await setActivePokemon(toJid, asset.pokemonId, connection);
    }
    const senderActive = await getActivePlayerPokemonForUpdate(fromJid, connection);
    if (!senderActive) {
      const first = await getFirstPlayerPokemon(fromJid, connection);
      if (first) await setActivePokemon(fromJid, first.id, connection);
    }
    return true;
  }

  return false;
};

const handleTrade = async ({ ownerJid, chatJid, commandPrefix, actionArgs = [], mentionedJids = [] }) => {
  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) return { ok: true, text: 'Não foi possível identificar o jogador.' };

  const sub = String(actionArgs?.[0] || 'status')
    .trim()
    .toLowerCase();

  if (sub === 'status' || sub === 'listar') {
    const offers = await listOpenTradeOffersByUser(canonicalOwnerJid);
    if (!offers.length) {
      return {
        ok: true,
        text: `📦 Nenhuma troca pendente.\nUse: ${commandPrefix}rpg trade propor <jid/@numero> item:potion:2 item:pokeball:3`,
      };
    }

    const lines = ['📦 *Trocas pendentes*'];
    offers.slice(0, 12).forEach((offer) => {
      lines.push(`#${offer.id} ${offer.proposer_jid} -> ${offer.receiver_jid} | ${formatTradeAsset(offer.proposer_offer_json)} ↔ ${formatTradeAsset(offer.receiver_offer_json)}`);
    });
    lines.push(`Aceitar: ${commandPrefix}rpg trade aceitar <id>`);
    lines.push(`Recusar: ${commandPrefix}rpg trade recusar <id>`);
    return { ok: true, text: lines.join('\n') };
  }

  if (sub === 'propor' || sub === 'oferecer' || sub === 'create') {
    let cursor = 1;
    const mentionToken = Array.isArray(mentionedJids) ? mentionedJids.find(Boolean) || null : null;
    const rawTarget = mentionToken || actionArgs?.[cursor];
    if (!mentionToken) cursor += 1;
    else if (String(actionArgs?.[cursor] || '').startsWith('@')) cursor += 1;

    const offeredToken = actionArgs?.[cursor];
    const requestedToken = actionArgs?.[cursor + 1];

    if (!rawTarget || !offeredToken || !requestedToken) {
      return {
        ok: true,
        text: `Use: ${commandPrefix}rpg trade propor <jid/@numero> <item:chave:qtd|pokemon:id> <item:chave:qtd|pokemon:id>`,
      };
    }

    const receiverJid = await resolveMentionOrArgJid({
      token: rawTarget,
      mentionedJids,
    });
    if (!receiverJid) {
      return { ok: true, text: 'Não foi possível resolver o usuário alvo da troca.' };
    }
    if (receiverJid === canonicalOwnerJid) {
      return { ok: true, text: 'Você não pode criar troca com você mesmo.' };
    }

    const proposerOffer = normalizeTradeAssetToken(offeredToken);
    const receiverOffer = normalizeTradeAssetToken(requestedToken);
    if (!proposerOffer || !receiverOffer) {
      return {
        ok: true,
        text: 'Formato inválido de ativo. Use item:chave:qtd ou pokemon:id.',
      };
    }

    const created = await withTransaction(async (connection) => {
      await expireOldTradeOffers(connection);
      const proposerPlayer = await getPlayerByJidForUpdate(canonicalOwnerJid, connection);
      const receiverPlayer = await getPlayerByJidForUpdate(receiverJid, connection);
      if (!proposerPlayer || !receiverPlayer) return { error: 'player_not_found' };

      const proposerValid = await validateTradeAssetForOwner({
        ownerJid: canonicalOwnerJid,
        asset: proposerOffer,
        connection,
      });
      if (!proposerValid.ok) return { error: `proposer_${proposerValid.reason}` };

      const receiverValid = await validateTradeAssetForOwner({
        ownerJid: receiverJid,
        asset: receiverOffer,
        connection,
      });
      if (!receiverValid.ok) return { error: `receiver_${receiverValid.reason}` };

      const offer = await createTradeOffer(
        {
          chatJid,
          proposerJid: canonicalOwnerJid,
          receiverJid,
          proposerOffer,
          receiverOffer,
          expiresAt: new Date(__timeNowMs() + TRADE_TTL_MS),
        },
        connection,
      );
      return { offer };
    });

    if (created?.error === 'player_not_found') {
      return { ok: true, text: 'Ambos jogadores precisam ter conta no RPG.' };
    }
    if (created?.error?.includes('item_missing') || created?.error?.includes('pokemon_missing')) {
      return { ok: true, text: 'Um dos ativos da troca não está mais disponível.' };
    }
    if (created?.error?.includes('pokemon_active')) {
      return { ok: true, text: 'Não é permitido negociar Pokémon ativo.' };
    }
    if (created?.error?.includes('pokemon_last')) {
      return { ok: true, text: 'Não é permitido negociar seu último Pokémon.' };
    }

    const offer = created?.offer;
    if (!offer) return { ok: true, text: 'Não foi possível criar a troca agora.' };

    recordRpgTrade('created');
    return {
      ok: true,
      text: `📨 Troca #${offer.id} criada.\nVocê oferece: ${formatTradeAsset(proposerOffer)}\nVocê quer: ${formatTradeAsset(receiverOffer)}\n${receiverJid}, aceite com: ${commandPrefix}rpg trade aceitar ${offer.id}`,
      mentions: buildEngagementMentions(receiverJid),
    };
  }

  if (sub === 'aceitar' || sub === 'accept') {
    const tradeId = toInt(actionArgs?.[1], NaN);
    if (!Number.isFinite(tradeId) || tradeId <= 0) {
      return { ok: true, text: `Use: ${commandPrefix}rpg trade aceitar <id>` };
    }

    const settled = await withTransaction(async (connection) => {
      await expireOldTradeOffers(connection);
      const offer = await getTradeOfferByIdForUpdate(tradeId, connection);
      if (!offer || offer.status !== 'pending') return { error: 'not_pending' };
      if (offer.receiver_jid !== canonicalOwnerJid) return { error: 'not_receiver' };
      if (isDateExpired(offer.expires_at)) {
        await updateTradeOfferState({ id: offer.id, status: 'expired' }, connection);
        return { error: 'expired' };
      }

      const proposerValid = await validateTradeAssetForOwner({
        ownerJid: offer.proposer_jid,
        asset: offer.proposer_offer_json,
        connection,
      });
      const receiverValid = await validateTradeAssetForOwner({
        ownerJid: offer.receiver_jid,
        asset: offer.receiver_offer_json,
        connection,
      });
      if (!proposerValid.ok || !receiverValid.ok) return { error: 'asset_unavailable' };

      const movedA = await transferTradeAsset({
        fromJid: offer.proposer_jid,
        toJid: offer.receiver_jid,
        asset: offer.proposer_offer_json,
        connection,
      });
      const movedB = await transferTradeAsset({
        fromJid: offer.receiver_jid,
        toJid: offer.proposer_jid,
        asset: offer.receiver_offer_json,
        connection,
      });
      if (!movedA || !movedB) return { error: 'transfer_failed' };

      await updateTradeOfferState(
        {
          id: offer.id,
          status: 'accepted',
          acceptedAt: __timeNow(),
        },
        connection,
      );
      await upsertSocialLinkDelta(
        {
          jidA: offer.proposer_jid,
          jidB: offer.receiver_jid,
          friendshipDelta: 3,
          rivalryDelta: 0,
          interactionsDelta: 1,
        },
        connection,
      );
      const link = await getSocialLinkByUsers(offer.proposer_jid, offer.receiver_jid, connection);
      return { offer, link };
    });

    if (settled?.error === 'not_pending') return { ok: true, text: 'Troca não encontrada ou já encerrada.' };
    if (settled?.error === 'not_receiver') return { ok: true, text: 'Apenas o destinatário pode aceitar esta troca.' };
    if (settled?.error === 'expired') return { ok: true, text: 'Essa troca expirou.' };
    if (settled?.error === 'asset_unavailable') return { ok: true, text: 'Ativos indisponíveis. A troca foi invalidada.' };
    if (settled?.error === 'transfer_failed') return { ok: true, text: 'Falha de transferência. Tente novamente.' };

    if (!settled?.offer) return { ok: true, text: 'Falha ao concluir a troca.' };
    recordRpgTrade('accepted');

    return {
      ok: true,
      text: `✅ Troca #${settled.offer.id} concluída!\n${settled.offer.proposer_jid} recebeu ${formatTradeAsset(settled.offer.receiver_offer_json)}\n${settled.offer.receiver_jid} recebeu ${formatTradeAsset(settled.offer.proposer_offer_json)}\n🤝 Amizade atual: ${toInt(settled.link?.friendship_score, 0)}`,
      mentions: buildEngagementMentions(settled.offer.proposer_jid, settled.offer.receiver_jid),
    };
  }

  if (sub === 'recusar' || sub === 'reject') {
    const tradeId = toInt(actionArgs?.[1], NaN);
    if (!Number.isFinite(tradeId) || tradeId <= 0) return { ok: true, text: `Use: ${commandPrefix}rpg trade recusar <id>` };

    return withTransaction(async (connection) => {
      const offer = await getTradeOfferByIdForUpdate(tradeId, connection);
      if (!offer || offer.status !== 'pending') return { ok: true, text: 'Troca não encontrada ou inválida.' };
      if (offer.receiver_jid !== canonicalOwnerJid) return { ok: true, text: 'Apenas o destinatário pode recusar.' };
      await updateTradeOfferState({ id: offer.id, status: 'rejected' }, connection);
      recordRpgTrade('rejected');
      return { ok: true, text: '❌ Troca recusada.' };
    });
  }

  if (sub === 'cancelar' || sub === 'cancel') {
    const tradeId = toInt(actionArgs?.[1], NaN);
    if (!Number.isFinite(tradeId) || tradeId <= 0) return { ok: true, text: `Use: ${commandPrefix}rpg trade cancelar <id>` };

    return withTransaction(async (connection) => {
      const offer = await getTradeOfferByIdForUpdate(tradeId, connection);
      if (!offer || offer.status !== 'pending') return { ok: true, text: 'Troca não encontrada ou inválida.' };
      if (offer.proposer_jid !== canonicalOwnerJid) return { ok: true, text: 'Apenas o criador pode cancelar.' };
      await updateTradeOfferState({ id: offer.id, status: 'cancelled' }, connection);
      recordRpgTrade('cancelled');
      return { ok: true, text: '🛑 Troca cancelada.' };
    });
  }

  return {
    ok: true,
    text: `Use: ${commandPrefix}rpg trade <status|propor|aceitar|recusar|cancelar>`,
  };
};

const handleCoop = async ({ ownerJid, chatJid }) => {
  if (!isGroupJid(chatJid)) {
    return { ok: true, text: 'Missão cooperativa é exclusiva para grupos.' };
  }

  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) return { ok: true, text: 'Não foi possível identificar o jogador.' };

  const data = await withTransaction(async (connection) => {
    const { weekRefDate } = await ensureGroupCoopStateForUpdate({ chatJid, connection });
    const coop = await getGroupCoopWeekly(chatJid, weekRefDate, connection);
    const members = await listGroupCoopMembers(chatJid, weekRefDate, connection);
    return { weekRefDate, coop, members };
  });

  if (!data?.coop) return { ok: true, text: 'Missão cooperativa indisponível no momento.' };

  const lines = ['🤝 *Missão Cooperativa Semanal*', `Semana: ${data.weekRefDate}`, `Capturas: ${data.coop.capture_progress}/${data.coop.capture_target}`, `Raids: ${data.coop.raid_progress}/${data.coop.raid_target}`, `Status: ${data.coop.status}`, `Recompensa: +${COOP_REWARD_GOLD} gold | +${COOP_REWARD_XP} XP | +${COOP_REWARD_ITEM_QTY} ${COOP_REWARD_ITEM_KEY}`];

  if (data.members.length) {
    lines.push('', 'Top contribuições:');
    data.members.slice(0, 8).forEach((entry, idx) => {
      lines.push(`${idx + 1}. ${entry.owner_jid} — capturas ${entry.capture_contribution}, raids ${entry.raid_contribution}`);
    });
  }

  lines.push('', `💡 Progresso coop é atualizado ao capturar em grupo e concluir raids.`);
  return { ok: true, text: lines.join('\n') };
};

const handleWeeklyEvent = async ({ ownerJid, chatJid, commandPrefix, actionArgs = [] }) => {
  if (!isGroupJid(chatJid)) return { ok: true, text: 'Evento semanal é exclusivo para grupos.' };

  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) return { ok: true, text: 'Não foi possível identificar o jogador.' };

  const sub = String(actionArgs?.[0] || 'status')
    .trim()
    .toLowerCase();

  if (sub === 'claim' || sub === 'resgatar') {
    return withTransaction(async (connection) => {
      return claimWeeklyEventReward({
        ownerJid: canonicalOwnerJid,
        chatJid,
        connection,
      });
    });
  }

  const data = await withTransaction(async (connection) => {
    const { weekRefDate, event, definition } = await ensureWeeklyEventForUpdate({
      chatJid,
      connection,
    });
    const ranking = await listGroupEventMembers(chatJid, weekRefDate, 10, connection);
    return { weekRefDate, event, definition, ranking };
  });

  if (!data?.event || !data?.definition) {
    return { ok: true, text: 'Evento semanal indisponível no momento.' };
  }

  const lines = ['🎯 *Evento Semanal do Grupo*', `Semana: ${data.weekRefDate}`, `Evento: ${data.definition.label}`, `Progresso: ${data.event.progress_value}/${data.event.target_value}`, `Status: ${data.event.status}`, `Recompensa por participação: +${data.definition.rewardGold} gold e +${data.definition.rewardXp} XP`];
  if (data.ranking.length) {
    lines.push('', 'Ranking de contribuição:');
    data.ranking.forEach((entry, idx) => {
      lines.push(`${idx + 1}. ${entry.owner_jid} — ${entry.contribution}`);
    });
  }
  lines.push('', `Resgate: ${commandPrefix}rpg evento claim`);
  return { ok: true, text: lines.join('\n') };
};

const handleSocial = async ({ ownerJid, commandPrefix, actionArgs = [], mentionedJids = [] }) => {
  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) return { ok: true, text: 'Não foi possível identificar o jogador.' };

  const mode = String(actionArgs?.[0] || 'status')
    .trim()
    .toLowerCase();
  const targetToken = actionArgs?.[1] || null;
  const targetJid = await resolveMentionOrArgJid({ token: targetToken, mentionedJids });

  if (mode === 'status' && targetJid && targetJid !== canonicalOwnerJid) {
    const link = await getSocialLinkByUsers(canonicalOwnerJid, targetJid);
    if (!link) {
      return {
        ok: true,
        text: `Ainda não há histórico social entre ${canonicalOwnerJid} e ${targetJid}.`,
      };
    }
    const rivalryBonus = resolveRivalryBonus(link.rivalry_score);
    return {
      ok: true,
      text: `🤝 Link social com ${targetJid}\nAmizade: ${link.friendship_score}\nRivalidade: ${link.rivalry_score}\nInterações: ${link.interactions_count}\nPerk rivalidade atual: +${rivalryBonus.bonusXp} XP / +${rivalryBonus.bonusGold} gold em vitória PvP`,
      mentions: buildEngagementMentions(targetJid),
    };
  }

  const topFriends = await listSocialLinksByOwner(canonicalOwnerJid, 'friendship', 5);
  const topRivals = await listSocialLinksByOwner(canonicalOwnerJid, 'rivalry', 5);
  const lines = ['🧬 *Painel Social*'];

  lines.push('Top amizades:');
  if (!topFriends.length) lines.push('Sem vínculos ainda.');
  topFriends.forEach((entry, idx) => {
    const other = entry.user_a_jid === canonicalOwnerJid ? entry.user_b_jid : entry.user_a_jid;
    lines.push(`${idx + 1}. ${other} — amizade ${entry.friendship_score}`);
  });

  lines.push('', 'Top rivalidades:');
  if (!topRivals.length) lines.push('Sem rivalidades ainda.');
  topRivals.forEach((entry, idx) => {
    const other = entry.user_a_jid === canonicalOwnerJid ? entry.user_b_jid : entry.user_a_jid;
    lines.push(`${idx + 1}. ${other} — rivalidade ${entry.rivalry_score}`);
  });

  lines.push('', `Consultar vínculo direto: ${commandPrefix}rpg social status @usuario`);
  return { ok: true, text: lines.join('\n') };
};

const handleKarma = async ({ ownerJid, commandPrefix, actionArgs = [], mentionedJids = [] }) => {
  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) return { ok: true, text: 'Não foi possível identificar o jogador.' };

  const sub = String(actionArgs?.[0] || 'status')
    .trim()
    .toLowerCase();

  if (sub === 'top') {
    const top = await listTopKarmaProfiles(10);
    const lines = ['🌟 *Top Karma*'];
    if (!top.length) {
      lines.push('Sem votos registrados.');
    } else {
      top.forEach((entry, idx) => {
        lines.push(`${idx + 1}. ${entry.owner_jid} — karma ${entry.karma_score}`);
      });
    }
    return { ok: true, text: lines.join('\n') };
  }

  if (sub === '+' || sub === 'up' || sub === '-' || sub === 'down') {
    const voteValue = sub === '+' || sub === 'up' ? 1 : -1;
    const targetToken = actionArgs?.[1] || null;
    const targetJid = await resolveMentionOrArgJid({ token: targetToken, mentionedJids });
    if (!targetJid) return { ok: true, text: `Use: ${commandPrefix}rpg karma <+|-> <jid/@numero>` };
    if (targetJid === canonicalOwnerJid) return { ok: true, text: 'Você não pode votar em si mesmo.' };

    const result = await withTransaction(async (connection) => {
      const weekRefDate = getCurrentWeekRefDate();
      const voter = await getPlayerByJidForUpdate(canonicalOwnerJid, connection);
      const target = await getPlayerByJidForUpdate(targetJid, connection);
      if (!voter || !target) return { error: 'player_not_found' };

      const existing = await getKarmaVoteByWeekForUpdate(weekRefDate, canonicalOwnerJid, targetJid, connection);
      if (existing) return { error: 'already_voted' };

      const created = await createKarmaVote(
        {
          weekRefDate,
          voterJid: canonicalOwnerJid,
          targetJid,
          voteValue,
        },
        connection,
      );
      if (!created) return { error: 'vote_failed' };

      await applyKarmaDelta(
        {
          ownerJid: targetJid,
          karmaDelta: voteValue,
          positiveDelta: voteValue > 0 ? 1 : 0,
          negativeDelta: voteValue < 0 ? 1 : 0,
        },
        connection,
      );
      const profile = await getKarmaProfile(targetJid, connection);
      return { profile };
    });

    if (result?.error === 'player_not_found') return { ok: true, text: 'Ambos jogadores precisam ter conta no RPG.' };
    if (result?.error === 'already_voted') return { ok: true, text: 'Você já votou nesse jogador nesta semana.' };
    if (result?.error) return { ok: true, text: 'Não foi possível registrar o voto agora.' };

    recordRpgKarmaVote(voteValue > 0 ? 'up' : 'down');
    return {
      ok: true,
      text: `${voteValue > 0 ? '👍' : '👎'} Karma atualizado para ${targetJid}. Saldo atual: ${toInt(result?.profile?.karma_score, 0)}.`,
      mentions: buildEngagementMentions(targetJid),
    };
  }

  const targetToken = actionArgs?.[1] || null;
  const targetJid = (await resolveMentionOrArgJid({ token: targetToken, mentionedJids })) || canonicalOwnerJid;
  const profile = await getKarmaProfile(targetJid);
  return {
    ok: true,
    text: `🌟 Karma de ${targetJid}\nSaldo: ${toInt(profile?.karma_score, 0)}\n👍 ${toInt(profile?.positive_votes, 0)} | 👎 ${toInt(profile?.negative_votes, 0)}\nVote: ${commandPrefix}rpg karma + @usuario | ${commandPrefix}rpg karma - @usuario`,
    mentions: buildEngagementMentions(targetJid),
  };
};

const handleEngagement = async ({ ownerJid, chatJid }) => {
  if (!isGroupJid(chatJid)) return { ok: true, text: 'Engajamento só pode ser consultado em grupos.' };

  const canonicalOwnerJid = await resolveCanonicalUserJid(ownerJid);
  if (!canonicalOwnerJid) return { ok: true, text: 'Não foi possível identificar o jogador.' };

  const today = getDateOnlyOffset(0);
  const yesterday = getDateOnlyOffset(-1);

  const [activeToday, activeYesterday, retained, summaryToday] = await Promise.all([getGroupActiveUsersByDay(chatJid, today), getGroupActiveUsersByDay(chatJid, yesterday), getGroupRetentionByDays(chatJid, today, yesterday), getGroupActivitySummaryByDay(chatJid, today)]);

  const retentionRate = activeYesterday > 0 ? retained / activeYesterday : 0;
  recordRpgGroupRetentionRatio(retentionRate);
  const retentionPct = Math.round(retentionRate * 100);

  return {
    ok: true,
    text: ['📊 *Engajamento do Grupo (Hoje)*', `Ativos hoje: ${activeToday}`, `Ativos ontem: ${activeYesterday}`, `Retidos (ontem->hoje): ${retained} (${retentionPct}%)`, `Ações totais hoje: ${summaryToday.actionsTotal}`, `PvP criados hoje: ${summaryToday.pvpCreatedTotal}`, `PvP concluídos hoje: ${summaryToday.pvpCompletedTotal}`, `Coops concluídas hoje: ${summaryToday.coopCompletedTotal}`].join('\n'),
  };
};

export const executeRpgPokemonAction = async ({ ownerJid, chatJid, action, actionArgs = [], mentionedJids = [], commandPrefix = '/' }) => {
  try {
    const normalizedAction = String(action || '').toLowerCase();

    if (shouldApplyCooldown(normalizedAction)) {
      const cooldownLeft = getCooldownSecondsLeft(ownerJid);
      if (cooldownLeft > 0) {
        await trackGroupActivity({
          chatJid,
          ownerJid,
          actionsDelta: 1,
        });
        markSessionSample(ownerJid);
        recordRpgAction({
          action: normalizedAction,
          status: 'cooldown',
        });
        return {
          ok: true,
          text: buildCooldownText({
            secondsLeft: cooldownLeft,
            prefix: commandPrefix,
          }),
        };
      }
    }

    let result;

    switch (normalizedAction) {
      case 'help':
      case 'ajuda':
        result = { ok: true, text: buildRpgHelpText(commandPrefix) };
        break;

      case 'start':
        result = await handleStart({ ownerJid, commandPrefix });
        break;

      case 'perfil':
        result = await handleProfile({ ownerJid, chatJid, commandPrefix });
        break;

      case 'explorar':
        result = await handleExplore({ ownerJid, chatJid, commandPrefix });
        break;

      case 'ginasio':
      case 'ginásio':
        result = await handleGym({ ownerJid, chatJid, commandPrefix });
        break;

      case 'atacar':
        result = await handleAttack({ ownerJid, moveSlot: actionArgs?.[0], commandPrefix });
        break;

      case 'capturar':
        {
          const { index } = await getShopCatalog();
          const defaultBall = index.get('pokeball') || {
            key: 'pokeball',
            catchBonus: 0,
            guaranteedCapture: false,
          };
          result = await handleCapture({
            ownerJid,
            commandPrefix,
            itemKey: defaultBall.key,
            itemMeta: defaultBall,
          });
        }
        break;

      case 'fugir':
        result = await handleFlee({ ownerJid, commandPrefix });
        break;

      case 'time':
        result = await handleTeam({ ownerJid, commandPrefix });
        break;

      case 'bolsa':
        result = await handleBag({ ownerJid, commandPrefix, actionArgs });
        break;

      case 'pokedex':
        result = await handlePokedex({ ownerJid, commandPrefix });
        break;

      case 'evolucao':
      case 'evolução':
        result = await handleEvolutionTree({
          ownerJid,
          commandPrefix,
          pokemonToken: actionArgs?.[0],
        });
        break;

      case 'viajar':
        result = await handleTravel({ ownerJid, commandPrefix, actionArgs });
        break;

      case 'tm':
        result = await handleTm({ ownerJid, commandPrefix, actionArgs });
        break;

      case 'berry':
        result = await handleBerry({ ownerJid, commandPrefix, actionArgs });
        break;

      case 'raid':
        result = await handleRaid({ ownerJid, chatJid, commandPrefix, actionArgs });
        break;

      case 'desafiar':
        result = await handleChallenge({
          ownerJid,
          chatJid,
          commandPrefix,
          actionArgs,
          mentionedJids,
        });
        break;

      case 'pvp':
        result = await handlePvp({ ownerJid, chatJid, commandPrefix, actionArgs, mentionedJids });
        break;

      case 'missoes':
      case 'missões':
        result = await handleMissions({ ownerJid, commandPrefix });
        break;

      case 'escolher':
        result = await handleChoose({
          ownerJid,
          selectedPokemonId: actionArgs?.[0],
          commandPrefix,
        });
        break;

      case 'loja':
        result = await handleShop({ ownerJid, commandPrefix, actionArgs });
        break;

      case 'comprar':
        result = await handleBuy({
          ownerJid,
          itemKey: actionArgs?.[0],
          quantity: actionArgs?.[1],
          commandPrefix,
        });
        break;

      case 'usar':
        result = await handleUse({
          ownerJid,
          commandPrefix,
          itemToken: actionArgs?.[0],
        });
        break;

      case 'trade':
        result = await handleTrade({
          ownerJid,
          chatJid,
          commandPrefix,
          actionArgs,
          mentionedJids,
        });
        break;

      case 'coop':
        result = await handleCoop({
          ownerJid,
          chatJid,
          commandPrefix,
        });
        break;

      case 'evento':
        result = await handleWeeklyEvent({
          ownerJid,
          chatJid,
          commandPrefix,
          actionArgs,
        });
        break;

      case 'social':
        result = await handleSocial({
          ownerJid,
          commandPrefix,
          actionArgs,
          mentionedJids,
        });
        break;

      case 'karma':
        result = await handleKarma({
          ownerJid,
          commandPrefix,
          actionArgs,
          mentionedJids,
        });
        break;

      case 'engajamento':
        result = await handleEngagement({
          ownerJid,
          chatJid,
        });
        break;

      default:
        result = {
          ok: true,
          text: buildNeedStartText(commandPrefix),
        };
        break;
    }

    result = applyAutoMentionsOnResult(result);

    if (result?.ok && shouldApplyCooldown(normalizedAction) && normalizedAction !== 'perfil' && normalizedAction !== 'time' && normalizedAction !== 'loja') {
      touchCooldown(ownerJid);
    }

    await trackGroupActivity({
      chatJid,
      ownerJid,
      actionsDelta: 1,
    });

    markSessionSample(ownerJid);
    recordRpgAction({
      action: normalizedAction,
      status: result?.ok ? 'ok' : 'error',
    });

    return result;
  } catch (error) {
    logger.error('Erro ao executar ação RPG Pokemon.', {
      ownerJid,
      action,
      error: error.message,
    });
    markSessionSample(ownerJid);
    recordRpgAction({
      action: String(action || '').toLowerCase() || 'unknown',
      status: 'exception',
    });

    return {
      ok: false,
      text: buildGenericErrorText(commandPrefix),
    };
  }
};
