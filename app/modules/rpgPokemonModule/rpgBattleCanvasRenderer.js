import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import axios from 'axios';
import { createCanvas, loadImage } from 'canvas';
import logger from '#logger';

const CANVAS_SIZE = 1024;
const PANEL_RADIUS = 24;
const IMAGE_CACHE_TTL_MS = Math.max(2 * 60 * 1000, Number(process.env.RPG_BATTLE_CANVAS_CACHE_TTL_MS) || 10 * 60 * 1000);
const IMAGE_CACHE_LIMIT = Math.max(20, Number(process.env.RPG_BATTLE_CANVAS_CACHE_LIMIT) || 120);
const IMAGE_TIMEOUT_MS = Math.max(2_000, Number(process.env.RPG_BATTLE_CANVAS_TIMEOUT_MS) || 7_000);

const imageCache = globalThis.__omnizapBattleCanvasImageCache instanceof Map ? globalThis.__omnizapBattleCanvasImageCache : new Map();
globalThis.__omnizapBattleCanvasImageCache = imageCache;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toInt = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};
const normalizeText = (value) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const hexToRgb = (hex) => {
  const raw = String(hex || '')
    .trim()
    .replace('#', '');
  if (!/^[a-f0-9]{6}$/i.test(raw)) return null;
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
};

const toRgba = (hex, alpha = 1) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(255,255,255,${clamp(alpha, 0, 1)})`;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${clamp(alpha, 0, 1)})`;
};

const isLightHex = (hex) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const luminance = rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114;
  return luminance >= 160;
};

const toRatio = (currentHp, maxHp) => {
  const max = Math.max(1, toInt(maxHp, 1));
  const current = clamp(toInt(currentHp, 0), 0, max);
  return current / max;
};

const hpColorByRatio = (ratio) => {
  if (ratio <= 0.25) return '#ef4444';
  if (ratio <= 0.55) return '#f59e0b';
  return '#22c55e';
};

const TYPE_COLORS = new Map([
  ['normal', '#a8a77a'],
  ['fire', '#ee8130'],
  ['water', '#6390f0'],
  ['electric', '#f7d02c'],
  ['grass', '#7ac74c'],
  ['ice', '#96d9d6'],
  ['fighting', '#c22e28'],
  ['poison', '#a33ea1'],
  ['ground', '#e2bf65'],
  ['flying', '#a98ff3'],
  ['psychic', '#f95587'],
  ['bug', '#a6b91a'],
  ['rock', '#b6a136'],
  ['ghost', '#735797'],
  ['dragon', '#6f35fc'],
  ['dark', '#705746'],
  ['steel', '#b7b7ce'],
  ['fairy', '#d685ad'],
]);

const STATUS_MAP = new Map([
  ['burn', { icon: '🔥', label: 'BRN', color: '#f97316' }],
  ['brn', { icon: '🔥', label: 'BRN', color: '#f97316' }],
  ['poison', { icon: '☠', label: 'PSN', color: '#a855f7' }],
  ['psn', { icon: '☠', label: 'PSN', color: '#a855f7' }],
  ['toxic', { icon: '☠', label: 'TOX', color: '#7c3aed' }],
  ['bad-poison', { icon: '☠', label: 'TOX', color: '#7c3aed' }],
  ['paralyze', { icon: '⚡', label: 'PAR', color: '#facc15' }],
  ['paralysis', { icon: '⚡', label: 'PAR', color: '#facc15' }],
  ['par', { icon: '⚡', label: 'PAR', color: '#facc15' }],
  ['sleep', { icon: '💤', label: 'SLP', color: '#60a5fa' }],
  ['slp', { icon: '💤', label: 'SLP', color: '#60a5fa' }],
  ['freeze', { icon: '❄️', label: 'FRZ', color: '#67e8f9' }],
  ['frz', { icon: '❄️', label: 'FRZ', color: '#67e8f9' }],
  ['confusion', { icon: '🌀', label: 'CNF', color: '#fbbf24' }],
  ['conf', { icon: '🌀', label: 'CNF', color: '#fbbf24' }],
]);

const TYPE_ICONS = new Map([
  ['normal', '⚪'],
  ['fire', '🔥'],
  ['water', '💧'],
  ['electric', '⚡'],
  ['grass', '🍃'],
  ['ice', '❄️'],
  ['fighting', '🥊'],
  ['poison', '☠️'],
  ['ground', '🟤'],
  ['flying', '🪽'],
  ['psychic', '🔮'],
  ['bug', '🐞'],
  ['rock', '🪨'],
  ['ghost', '👻'],
  ['dragon', '🐉'],
  ['dark', '🌑'],
  ['steel', '⚙️'],
  ['fairy', '✨'],
]);

const ROLE_THEMES = {
  player: {
    icon: '👤',
    label: 'JOGADOR',
    accent: '#38bdf8',
    panelBg: 'rgba(8,47,73,0.45)',
  },
  enemy: {
    icon: '⚠️',
    label: 'INIMIGO',
    accent: '#fb7185',
    panelBg: 'rgba(76,5,25,0.42)',
  },
};

const BIOME_THEMES = [
  {
    match: ['forest', 'floresta', 'grass', 'jungle', 'leaf'],
    colors: ['#134e4a', '#166534', '#0f766e'],
  },
  { match: ['volcano', 'fire', 'magma', 'lava'], colors: ['#7f1d1d', '#b91c1c', '#f97316'] },
  { match: ['water', 'ocean', 'sea', 'lake', 'river'], colors: ['#082f49', '#0c4a6e', '#0369a1'] },
  { match: ['mountain', 'rock', 'cave'], colors: ['#292524', '#44403c', '#57534e'] },
  { match: ['desert', 'sand', 'ground'], colors: ['#78350f', '#92400e', '#b45309'] },
  { match: ['ice', 'snow', 'tundra'], colors: ['#0f172a', '#1d4ed8', '#22d3ee'] },
];

const trimText = (value, max = 120) => {
  const raw = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  if (raw.length <= max) return raw;
  return `${raw.slice(0, Math.max(24, max - 1)).trimEnd()}…`;
};

const fitText = (ctx, text, maxWidth, baseSize, weight = 700, family = 'Sans') => {
  let size = baseSize;
  while (size > 14) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return;
    size -= 1;
  }
};

const drawRoundRect = (ctx, x, y, width, height, radius, fillStyle) => {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }
};

const cleanupCache = () => {
  const now = __timeNowMs();
  for (const [key, entry] of imageCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      imageCache.delete(key);
    }
  }

  if (imageCache.size <= IMAGE_CACHE_LIMIT) return;
  const overflow = imageCache.size - IMAGE_CACHE_LIMIT;
  const keys = [...imageCache.keys()].slice(0, overflow);
  keys.forEach((key) => imageCache.delete(key));
};

const resolveImage = async (imageUrl) => {
  const url = String(imageUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;

  cleanupCache();
  const cached = imageCache.get(url);
  if (cached && cached.expiresAt > __timeNowMs()) return cached.image;

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: IMAGE_TIMEOUT_MS,
      headers: { Accept: 'image/*' },
    });
    const image = await loadImage(Buffer.from(response.data));
    imageCache.set(url, { image, expiresAt: __timeNowMs() + IMAGE_CACHE_TTL_MS });
    return image;
  } catch (error) {
    imageCache.set(url, { image: null, expiresAt: __timeNowMs() + 90_000 });
    logger.debug('Falha ao carregar sprite para frame de batalha.', {
      imageUrl: url,
      error: error.message,
    });
    return null;
  }
};

const resolveBiomeTheme = (biomeLabel) => {
  const normalized = String(biomeLabel || '')
    .trim()
    .toLowerCase();
  if (!normalized) return ['#0f172a', '#1f2937', '#334155'];
  for (const theme of BIOME_THEMES) {
    if (theme.match.some((entry) => normalized.includes(entry))) return theme.colors;
  }
  return ['#1d4ed8', '#1e3a8a', '#334155'];
};

const normalizeTypeList = (types) => {
  if (!Array.isArray(types)) return [];
  return types
    .map((entry) =>
      String(entry || '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
    .slice(0, 3);
};

const normalizeStatuses = (pokemon = {}) => {
  const candidates = [pokemon?.status, pokemon?.nonVolatileStatus, pokemon?.condition, pokemon?.statusCondition, ...(Array.isArray(pokemon?.statusEffects) ? pokemon.statusEffects : []), ...(Array.isArray(pokemon?.conditions) ? pokemon.conditions : []), ...(Array.isArray(pokemon?.statuses) ? pokemon.statuses : [])];
  const found = [];
  for (const candidate of candidates) {
    const key = String(candidate || '')
      .trim()
      .toLowerCase();
    if (!key) continue;
    const normalized = STATUS_MAP.get(key);
    if (!normalized) continue;
    if (!found.some((entry) => entry.label === normalized.label)) {
      found.push(normalized);
    }
  }
  return found.slice(0, 3);
};

const drawBackground = (ctx, biomeLabel, enemyTypes = []) => {
  const [c1, c2, c3] = resolveBiomeTheme(biomeLabel);
  const gradient = ctx.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  gradient.addColorStop(0, c1);
  gradient.addColorStop(0.52, c2);
  gradient.addColorStop(1, c3);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const enemyType = normalizeTypeList(enemyTypes)[0];
  const enemyTypeColor = TYPE_COLORS.get(enemyType);
  if (enemyTypeColor) {
    const typeAura = ctx.createRadialGradient(CANVAS_SIZE * 0.74, CANVAS_SIZE * 0.3, 50, CANVAS_SIZE * 0.74, CANVAS_SIZE * 0.3, 360);
    typeAura.addColorStop(0, toRgba(enemyTypeColor, 0.35));
    typeAura.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = typeAura;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }

  ctx.globalAlpha = 0.09;
  ctx.strokeStyle = '#ffffff';
  for (let i = 0; i <= 14; i += 1) {
    const y = 160 + i * 42;
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(CANVAS_SIZE - 40, y + (i % 2 === 0 ? 10 : -10));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const vignette = ctx.createRadialGradient(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE * 0.2, CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE * 0.65);
  vignette.addColorStop(0, 'rgba(255,255,255,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
};

const drawArena = (ctx) => {
  ctx.globalAlpha = 0.22;
  drawRoundRect(ctx, 80, 610, 360, 120, 90, '#cbd5e1');
  drawRoundRect(ctx, CANVAS_SIZE - 440, 270, 360, 120, 90, '#cbd5e1');
  ctx.globalAlpha = 1;
};

const drawShinyAura = (ctx, x, y, width, height) => {
  const gradient = ctx.createRadialGradient(x, y, 28, x, y, Math.max(width, height) * 0.65);
  gradient.addColorStop(0, 'rgba(252,211,77,0.66)');
  gradient.addColorStop(0.4, 'rgba(59,130,246,0.26)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(x, y, width * 0.72, height * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
};

const drawCombatAura = (ctx, { centerX, centerY, width, height, accent = '#ffffff', alpha = 0.2 }) => {
  const gradient = ctx.createRadialGradient(centerX, centerY + 18, 24, centerX, centerY + 18, Math.max(width, height) * 0.65);
  gradient.addColorStop(0, `${accent}55`);
  gradient.addColorStop(0.5, `${accent}20`);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalAlpha = clamp(alpha, 0.08, 0.35);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(centerX, centerY + 18, width * 0.62, height * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
};

const drawPokemon = async (ctx, pokemon = {}, opts = {}) => {
  const { centerX = 0, centerY = 0, maxWidth = 260, maxHeight = 260, facing = 'right', isPrimary = false, role = 'player', isActive = false, offsetX = 0, offsetY = 0, turn = 1 } = opts;
  const finalCenterX = centerX + toInt(offsetX, 0);
  const finalCenterY = centerY + toInt(offsetY, 0);
  const image = await resolveImage(pokemon?.imageUrl || pokemon?.sprite);
  const scaleBonus = isPrimary ? 1.08 : 0.96;
  const targetMaxW = maxWidth * scaleBonus;
  const targetMaxH = maxHeight * scaleBonus;
  const isShiny = Boolean(pokemon?.isShiny);
  const roleTheme = ROLE_THEMES[role] || ROLE_THEMES.player;
  const activePulse = isActive ? (toInt(turn, 1) % 2 === 0 ? 0.32 : 0.2) : 0;

  if (image) {
    const ratio = Math.min(targetMaxW / image.width, targetMaxH / image.height);
    const width = Math.max(40, Math.round(image.width * ratio));
    const height = Math.max(40, Math.round(image.height * ratio));
    const drawX = finalCenterX - width / 2;
    const drawY = finalCenterY - height / 2;

    drawCombatAura(ctx, {
      centerX: finalCenterX,
      centerY: finalCenterY + (isPrimary ? 12 : -8),
      width,
      height,
      accent: roleTheme.accent,
      alpha: isActive ? 0.3 : isPrimary ? 0.23 : 0.17,
    });

    if (isShiny) drawShinyAura(ctx, finalCenterX, finalCenterY, width, height);
    if (isActive) {
      ctx.globalAlpha = activePulse;
      ctx.strokeStyle = roleTheme.accent;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.ellipse(finalCenterX, finalCenterY + 14, width * 0.54, height * 0.44, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.save();
    if (facing === 'left') {
      ctx.translate(finalCenterX, finalCenterY);
      ctx.scale(-1, 1);
      ctx.drawImage(image, -width / 2, -height / 2, width, height);
    } else {
      ctx.drawImage(image, drawX, drawY, width, height);
    }
    ctx.restore();
    return;
  }

  const fallbackW = Math.round(targetMaxW * 0.75);
  const fallbackH = Math.round(targetMaxH * 0.75);
  drawCombatAura(ctx, {
    centerX: finalCenterX,
    centerY: finalCenterY,
    width: fallbackW,
    height: fallbackH,
    accent: roleTheme.accent,
    alpha: isActive ? 0.28 : isPrimary ? 0.2 : 0.16,
  });
  if (isShiny) drawShinyAura(ctx, finalCenterX, finalCenterY, fallbackW, fallbackH);
  if (isActive) {
    ctx.globalAlpha = activePulse;
    ctx.strokeStyle = roleTheme.accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(finalCenterX, finalCenterY + 8, fallbackW * 0.48, fallbackH * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  drawRoundRect(ctx, finalCenterX - fallbackW / 2, finalCenterY - fallbackH / 2, fallbackW, fallbackH, 28, 'rgba(255,255,255,0.14)');
  ctx.fillStyle = '#ffffff';
  fitText(ctx, trimText(pokemon?.displayName || pokemon?.name || 'Pokemon', 18), fallbackW - 28, 30, 700);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(trimText(pokemon?.displayName || pokemon?.name || 'Pokemon', 18), finalCenterX, finalCenterY);
};

const drawTypeBadges = (ctx, types = [], x, y) => {
  let cursor = x;
  types.forEach((type) => {
    const label = String(type || '')
      .slice(0, 3)
      .toUpperCase();
    const icon = TYPE_ICONS.get(type) || '◼';
    const width = 76;
    const color = TYPE_COLORS.get(type) || '#475569';
    const textColor = isLightHex(color) ? '#0b1220' : '#f8fafc';
    const gradient = ctx.createLinearGradient(cursor, y, cursor + width, y + 24);
    gradient.addColorStop(0, toRgba(color, 0.92));
    gradient.addColorStop(1, toRgba(color, 0.72));
    drawRoundRect(ctx, cursor, y, width, 24, 12, gradient);
    ctx.strokeStyle = toRgba(color, 1);
    ctx.lineWidth = 1.5;
    drawRoundRect(ctx, cursor, y, width, 24, 12);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.font = '700 13px Sans';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${icon} ${label}`, cursor + width / 2, y + 12);
    cursor += width + 8;
  });
};

const drawStatusBadges = (ctx, statuses = [], x, y) => {
  let cursor = x;
  statuses.forEach((entry) => {
    const width = 70;
    drawRoundRect(ctx, cursor, y, width, 24, 12, entry.color);
    ctx.fillStyle = '#111827';
    ctx.font = '700 14px Sans';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${entry.icon} ${entry.label}`, cursor + width / 2, y + 12);
    cursor += width + 8;
  });
};

const drawStatusPanel = (ctx, pokemon = {}, opts = {}) => {
  const { x = 0, y = 0, width = 360, height = 150, align = 'left', role = 'player', turn = 1, isActive = false } = opts;
  const roleTheme = ROLE_THEMES[role] || ROLE_THEMES.player;

  drawRoundRect(ctx, x, y, width, height, PANEL_RADIUS, roleTheme.panelBg);
  ctx.strokeStyle = `${roleTheme.accent}b3`;
  ctx.lineWidth = 2.5;
  drawRoundRect(ctx, x, y, width, height, PANEL_RADIUS);
  ctx.stroke();
  if (isActive) {
    ctx.globalAlpha = toInt(turn, 1) % 2 === 0 ? 0.45 : 0.28;
    ctx.strokeStyle = roleTheme.accent;
    ctx.lineWidth = 4;
    drawRoundRect(ctx, x - 2, y - 2, width + 4, height + 4, PANEL_RADIUS + 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  drawRoundRect(ctx, x + 1, y + 1, width - 2, height - 2, PANEL_RADIUS, 'rgba(0,0,0,0)');
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const name = trimText(pokemon?.displayName || pokemon?.name || 'Pokemon', 24);
  const level = Math.max(1, toInt(pokemon?.level, 1));
  const hpCurrent = Math.max(0, toInt(pokemon?.currentHp, 0));
  const hpMax = Math.max(1, toInt(pokemon?.maxHp, 1));
  const hpRatio = toRatio(hpCurrent, hpMax);
  const hpColor = hpColorByRatio(hpRatio);
  const types = normalizeTypeList(pokemon?.types);
  const statuses = normalizeStatuses(pokemon);
  const padding = 16;
  const textX = align === 'left' ? x + padding : x + width - padding;
  const roleBadgeW = 128;
  const roleBadgeX = align === 'left' ? x + 12 : x + width - roleBadgeW - 12;
  drawRoundRect(ctx, roleBadgeX, y + 10, roleBadgeW, 24, 12, `${roleTheme.accent}cc`);
  ctx.fillStyle = '#0b1220';
  ctx.font = '700 13px Sans';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${roleTheme.icon} ${roleTheme.label}`, roleBadgeX + roleBadgeW / 2, y + 22);

  ctx.fillStyle = '#e2e8f0';
  fitText(ctx, name, width - 120, 28, 800);
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(name, textX, y + 56);

  ctx.fillStyle = '#93c5fd';
  ctx.font = '700 16px Sans';
  ctx.fillText(`Lv.${level}`, textX, y + 78);

  const barX = x + padding;
  const barY = y + 90;
  const barW = width - padding * 2;
  const barH = 18;
  drawRoundRect(ctx, barX, barY, barW, barH, 9, 'rgba(15,23,42,0.8)');
  const hpFillW = Math.max(18, Math.round(barW * hpRatio));
  const hpGradient = ctx.createLinearGradient(barX, barY, barX + hpFillW, barY);
  hpGradient.addColorStop(0, '#e2e8f0');
  hpGradient.addColorStop(0.22, hpColorByRatio(clamp(hpRatio + 0.2, 0, 1)));
  hpGradient.addColorStop(1, hpColor);
  drawRoundRect(ctx, barX, barY, hpFillW, barH, 9, hpGradient);
  if (hpRatio <= 0.3) {
    const pulse = Math.max(0.14, toInt(turn, 1) % 2 === 0 ? 0.32 : 0.2);
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 3;
    drawRoundRect(ctx, barX - 2, barY - 2, barW + 4, barH + 4, 11);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  drawRoundRect(ctx, barX + 2, barY + 2, Math.max(10, hpFillW - 4), 4, 4, 'rgba(255,255,255,0.35)');
  ctx.fillStyle = '#f8fafc';
  ctx.font = '600 12px Sans';
  ctx.textAlign = 'center';
  ctx.fillText(`${hpCurrent}/${hpMax}`, barX + barW / 2, barY + 31);

  const badgeX = x + padding;
  drawTypeBadges(ctx, types, badgeX, y + 122);
  if (statuses.length) {
    drawStatusBadges(ctx, statuses, badgeX, y + 150);
  }
};

const resolveActionTone = (actionText) => {
  const raw = String(actionText || '').trim();
  const normalized = normalizeText(raw);
  if (normalized.includes('vitoria') || normalized.includes('venceu') || normalized.includes('desmaiou') || normalized.includes('derrot')) {
    return {
      icon: '🏆',
      color: '#fde68a',
      subline: 'Vitória garantida!',
      badge: 'FINAL',
      weight: 'high',
    };
  }
  if (normalized.includes('captur') || normalized.includes('poke bola') || normalized.includes('pokebola')) {
    return { icon: '🎯', color: '#fbcfe8', subline: null, badge: 'CAPTURA', weight: 'medium' };
  }
  if (normalized.includes('dano') || normalized.includes('causou') || normalized.includes('atac')) {
    return { icon: '💥', color: '#fecaca', subline: null, badge: 'IMPACTO', weight: 'medium' };
  }
  if (normalized.includes('curou') || normalized.includes('recuper')) {
    return { icon: '✨', color: '#bbf7d0', subline: null, badge: 'SUPORTE', weight: 'medium' };
  }
  if (normalized.includes('apareceu') || normalized.includes('inici')) {
    return { icon: '🌀', color: '#bfdbfe', subline: null, badge: 'INICIO', weight: 'low' };
  }
  return { icon: '⚔️', color: '#bfdbfe', subline: null, badge: 'ACAO', weight: 'low' };
};

const resolveSecondaryAction = ({ logLines = [], primaryAction = '' }) => {
  const primary = normalizeText(primaryAction);
  const lines = Array.isArray(logLines) ? logLines : [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = trimText(lines[index], 88);
    const normalized = normalizeText(line);
    if (!line || !normalized) continue;
    if (primary && (normalized === primary || primary.includes(normalized))) continue;
    if (normalized.includes('turno') || normalized.includes('use /rpg') || normalized.includes('hp:')) continue;
    return line;
  }
  return null;
};

const inferActiveRole = ({ actionText = '', turn = 1, leftPokemon = {}, rightPokemon = {} }) => {
  const normalized = normalizeText(actionText);
  const leftName = normalizeText(leftPokemon?.displayName || leftPokemon?.name || '');
  const rightName = normalizeText(rightPokemon?.displayName || rightPokemon?.name || '');
  const actionHint = /(usou|atac|causou|acertou|curou|recuper)/.test(normalized);

  if (leftName && normalized.includes(leftName) && actionHint) return 'player';
  if (rightName && normalized.includes(rightName) && actionHint) return 'enemy';
  if (normalized.includes('seu ') || normalized.includes('jogador') || normalized.includes('voce')) return 'player';
  if (normalized.includes('inimigo') || normalized.includes('adversario') || normalized.includes('oponente')) return 'enemy';

  return Math.max(1, toInt(turn, 1)) % 2 === 1 ? 'player' : 'enemy';
};

const resolveImpactOffsets = ({ activeRole, actionText, turn = 1 }) => {
  const normalized = normalizeText(actionText);
  const isImpact = normalized.includes('dano') || normalized.includes('causou') || normalized.includes('atac');
  if (!isImpact) return { player: { x: 0, y: 0 }, enemy: { x: 0, y: 0 } };

  const shake = Math.max(2, toInt(turn, 1) % 2 === 0 ? 8 : 6);
  if (activeRole === 'player') {
    return { player: { x: 0, y: 0 }, enemy: { x: -shake, y: 2 } };
  }
  return { player: { x: shake, y: 2 }, enemy: { x: 0, y: 0 } };
};

const drawActiveTurnIndicator = (ctx, { activeRole = 'player', leftPokemon = {}, rightPokemon = {}, turn = 1 }) => {
  const role = activeRole === 'enemy' ? 'enemy' : 'player';
  const roleTheme = ROLE_THEMES[role] || ROLE_THEMES.player;
  const isPlayer = role === 'player';
  const anchor = isPlayer ? { x: 300, y: 352, labelY: 252 } : { x: 726, y: 176, labelY: 74 };
  const actorName = trimText(isPlayer ? leftPokemon?.displayName || leftPokemon?.name || 'Seu Pokémon' : rightPokemon?.displayName || rightPokemon?.name || 'Inimigo', 18);
  const label = `👉 ${actorName} age agora`;
  ctx.font = '700 17px Sans';
  const labelWidth = clamp(Math.round(ctx.measureText(label).width) + 28, 180, 320);
  const chipX = clamp(anchor.x - labelWidth / 2, 24, CANVAS_SIZE - labelWidth - 24);
  const chipY = anchor.labelY;
  drawRoundRect(ctx, chipX, chipY, labelWidth, 32, 16, toRgba(roleTheme.accent, 0.9));
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, chipX + labelWidth / 2, chipY + 16);

  ctx.globalAlpha = toInt(turn, 1) % 2 === 0 ? 0.88 : 0.72;
  ctx.fillStyle = toRgba(roleTheme.accent, 0.95);
  ctx.beginPath();
  ctx.moveTo(anchor.x, chipY + 42);
  ctx.lineTo(anchor.x - 14, chipY + 18);
  ctx.lineTo(anchor.x + 14, chipY + 18);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
};

const drawOverlay = (ctx, { turn = 1, modeLabel = 'Batalha', actionText = '', effectTag = null, logLines = [] }) => {
  const panelX = 88;
  const panelY = 770;
  const panelW = CANVAS_SIZE - 176;
  const panelH = 188;
  drawRoundRect(ctx, panelX, panelY, panelW, panelH, 26, 'rgba(2,6,23,0.68)');
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  drawRoundRect(ctx, panelX, panelY, panelW, panelH, 26);
  ctx.stroke();

  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 30px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(`${modeLabel}  •  Turno ${Math.max(1, toInt(turn, 1))}`, panelX + 22, panelY + 42);

  const action = trimText(actionText || 'Aguardando ação do jogador.', 96);
  const tone = resolveActionTone(action);
  const actionStartsWithIcon = /^([^\w\s]|\p{Extended_Pictographic})/u.test(action);
  const decoratedAction = actionStartsWithIcon ? action : `${tone.icon} ${action}`;
  drawRoundRect(ctx, panelX + 12, panelY + 16, 8, panelH - 32, 4, toRgba(String(tone.color || '#bfdbfe'), 0.95));
  const eventBadgeW = 116;
  drawRoundRect(ctx, panelX + panelW - eventBadgeW - 20, panelY + 16, eventBadgeW, 30, 15, toRgba(String(tone.color || '#bfdbfe'), 0.84));
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 14px Sans';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(tone.badge || 'ACAO'), panelX + panelW - eventBadgeW / 2 - 20, panelY + 31);
  ctx.fillStyle = tone.color;
  ctx.font = tone.weight === 'high' ? '700 25px Sans' : tone.weight === 'medium' ? '700 24px Sans' : '600 23px Sans';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(decoratedAction, panelX + 22, panelY + 92);
  const secondaryAction = resolveSecondaryAction({ logLines, primaryAction: action });
  if (secondaryAction) {
    ctx.fillStyle = 'rgba(226,232,240,0.95)';
    ctx.font = '600 18px Sans';
    ctx.fillText(`• ${trimText(secondaryAction, 72)}`, panelX + 22, panelY + 122);
  }
  if (tone.subline) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '600 18px Sans';
    ctx.fillText(tone.subline, panelX + 22, panelY + (secondaryAction ? 150 : 124));
  }

  if (!effectTag) return;
  const palette = effectTag === 'super' ? { label: 'SUPER EFETIVO', color: '#ef4444' } : effectTag === 'weak' ? { label: 'POUCO EFETIVO', color: '#f59e0b' } : effectTag === 'none' ? { label: 'SEM EFEITO', color: '#64748b' } : null;
  if (!palette) return;
  const badgeW = 220;
  drawRoundRect(ctx, CANVAS_SIZE / 2 - badgeW / 2, 38, badgeW, 44, 22, palette.color);
  ctx.fillStyle = '#0f172a';
  ctx.font = '800 18px Sans';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(palette.label, CANVAS_SIZE / 2, 60);
};

const drawTurnImpact = (ctx, { effectTag = null, turn = 1 }) => {
  const intensity = effectTag === 'super' ? 0.28 : effectTag === 'weak' ? 0.16 : 0.1;
  const pulse = (Math.max(1, toInt(turn, 1)) % 2 === 0 ? 1 : 0.8) * intensity;
  ctx.globalAlpha = pulse;
  const flash = ctx.createRadialGradient(CANVAS_SIZE / 2, CANVAS_SIZE / 2, 40, CANVAS_SIZE / 2, CANVAS_SIZE / 2, 360);
  flash.addColorStop(0, effectTag === 'super' ? '#fca5a5' : '#f8fafc');
  flash.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = flash;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.globalAlpha = 1;
};

export const inferEffectTagFromLogs = (logs = []) => {
  const text = (Array.isArray(logs) ? logs : []).join(' ').toLowerCase();
  if (text.includes('super efetivo')) return 'super';
  if (text.includes('pouco efetivo')) return 'weak';
  if (text.includes('não teve efeito') || text.includes('nao teve efeito')) return 'none';
  return null;
};

export const renderBattleFrameCanvas = async ({ leftPokemon = {}, rightPokemon = {}, turn = 1, biomeLabel = '', modeLabel = 'Batalha Pokemon', actionText = '', effectTag = null, activeRole = null, logLines = [] }) => {
  const resolvedActiveRole =
    activeRole === 'player' || activeRole === 'enemy'
      ? activeRole
      : inferActiveRole({
          actionText,
          turn,
          leftPokemon,
          rightPokemon,
        });
  const impactOffsets = resolveImpactOffsets({
    activeRole: resolvedActiveRole,
    actionText,
    turn,
  });
  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  drawBackground(ctx, biomeLabel, rightPokemon?.types);
  drawArena(ctx);

  await Promise.all([
    drawPokemon(ctx, leftPokemon, {
      centerX: 300,
      centerY: 556,
      maxWidth: 328,
      maxHeight: 328,
      facing: 'right',
      isPrimary: true,
      role: 'player',
      isActive: resolvedActiveRole === 'player',
      offsetX: impactOffsets.player.x,
      offsetY: impactOffsets.player.y,
      turn,
    }),
    drawPokemon(ctx, rightPokemon, {
      centerX: 726,
      centerY: 346,
      maxWidth: 288,
      maxHeight: 288,
      facing: 'left',
      isPrimary: false,
      role: 'enemy',
      isActive: resolvedActiveRole === 'enemy',
      offsetX: impactOffsets.enemy.x,
      offsetY: impactOffsets.enemy.y,
      turn,
    }),
  ]);
  drawActiveTurnIndicator(ctx, {
    activeRole: resolvedActiveRole,
    leftPokemon,
    rightPokemon,
    turn,
  });

  drawStatusPanel(ctx, leftPokemon, {
    x: 44,
    y: 458,
    width: 420,
    height: 168,
    align: 'left',
    role: 'player',
    turn,
    isActive: resolvedActiveRole === 'player',
  });
  drawStatusPanel(ctx, rightPokemon, {
    x: CANVAS_SIZE - 464,
    y: 110,
    width: 420,
    height: 168,
    align: 'right',
    role: 'enemy',
    turn,
    isActive: resolvedActiveRole === 'enemy',
  });

  drawTurnImpact(ctx, { effectTag, turn });
  drawOverlay(ctx, { turn, modeLabel, actionText, effectTag, logLines });

  return canvas.toBuffer('image/png', { compressionLevel: 4 });
};
