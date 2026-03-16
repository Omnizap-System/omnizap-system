import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import axios from 'axios';
import { createCanvas, loadImage } from 'canvas';
import logger from '#logger';

const WIDTH = 1600;
const HEIGHT = 1200;
const PANEL_RADIUS = 26;
const IMAGE_TIMEOUT_MS = Math.max(2_000, Number(process.env.RPG_PROFILE_CANVAS_TIMEOUT_MS) || 6_000);
const IMAGE_CACHE_TTL_MS = Math.max(2 * 60 * 1000, Number(process.env.RPG_PROFILE_CANVAS_CACHE_TTL_MS) || 10 * 60 * 1000);
const IMAGE_CACHE_LIMIT = Math.max(20, Number(process.env.RPG_PROFILE_CANVAS_CACHE_LIMIT) || 80);

const imageCache = globalThis.__omnizapProfileCanvasImageCache instanceof Map ? globalThis.__omnizapProfileCanvasImageCache : new Map();
globalThis.__omnizapProfileCanvasImageCache = imageCache;

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

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const toInt = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
};

const toText = (value, fallback = 'N/D') => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
};

const trimText = (value, max = 120) => {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(16, max - 1)).trimEnd()}…`;
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

const cleanupImageCache = () => {
  if (imageCache.size <= IMAGE_CACHE_LIMIT) return;
  const now = __timeNowMs();
  for (const [key, value] of imageCache.entries()) {
    if (!value || value.expiresAt <= now) imageCache.delete(key);
  }
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
};

const resolveImage = async (url) => {
  const normalized = String(url || '').trim();
  if (!normalized) return null;

  const cached = imageCache.get(normalized);
  if (cached && cached.expiresAt > __timeNowMs()) return cached.image;

  try {
    const response = await axios.get(normalized, {
      responseType: 'arraybuffer',
      timeout: IMAGE_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const image = await loadImage(Buffer.from(response.data));
    imageCache.set(normalized, {
      image,
      expiresAt: __timeNowMs() + IMAGE_CACHE_TTL_MS,
    });
    cleanupImageCache();
    return image;
  } catch (error) {
    logger.debug('Falha ao carregar imagem para perfil canvas.', {
      url: normalized,
      error: error.message,
    });
    return null;
  }
};

const drawProgressBar = ({ ctx, x, y, width, height, progressPct = 0, color = '#22d3ee', background = 'rgba(15,23,42,0.75)' }) => {
  drawRoundRect(ctx, x, y, width, height, Math.min(14, Math.round(height / 2)), background);
  const ratio = clamp(Number(progressPct) / 100, 0, 1);
  if (ratio <= 0) return;
  drawRoundRect(ctx, x + 2, y + 2, Math.max(0, (width - 4) * ratio), Math.max(0, height - 4), Math.min(12, Math.round((height - 4) / 2)), color);
};

const sanitizeProfileText = (text) => {
  const raw = String(text || '');
  return raw
    .split('\n')
    .map((line) =>
      String(line || '')
        .replace(/\*/g, '')
        .replace(/\s+$/g, ''),
    )
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]));
};

const wrapLine = (ctx, line, maxWidth) => {
  const text = String(line || '').trim();
  if (!text) return [''];

  const words = text.split(' ');
  const wrapped = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      wrapped.push(current);
      current = word;
      continue;
    }

    let chunk = word;
    while (chunk.length > 1 && ctx.measureText(chunk).width > maxWidth) {
      const safeSize = Math.max(1, Math.floor((maxWidth / Math.max(1, ctx.measureText(chunk).width)) * chunk.length));
      const part = chunk.slice(0, safeSize);
      wrapped.push(`${part}…`);
      chunk = chunk.slice(safeSize);
    }
    current = chunk;
  }

  if (current) wrapped.push(current);
  return wrapped.length ? wrapped : [''];
};

const isHeaderLine = (line) => {
  const value = String(line || '').trim();
  if (!value) return false;
  if (/^\d+\./.test(value)) return false;
  if (value.startsWith('•')) return false;
  return value.length <= 36;
};

export const renderProfileCanvasCard = async ({ trainerLabel = 'Treinador', generatedAtLabel = null, activePokemon = null, summary = {}, profileText = '' }) => {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const primaryType = String(activePokemon?.types?.[0] || '')
    .trim()
    .toLowerCase();
  const accent = TYPE_COLORS.get(primaryType) || '#38bdf8';

  const bgGradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  bgGradient.addColorStop(0, '#0b1220');
  bgGradient.addColorStop(0.55, '#111827');
  bgGradient.addColorStop(1, '#1e293b');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createRadialGradient(240, 240, 40, 240, 240, 560);
  glow.addColorStop(0, `${accent}70`);
  glow.addColorStop(1, 'rgba(2,6,23,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const leftX = 40;
  const leftY = 40;
  const leftW = 470;
  const leftH = HEIGHT - 80;
  drawRoundRect(ctx, leftX, leftY, leftW, leftH, PANEL_RADIUS, 'rgba(2, 6, 23, 0.72)');

  const rightX = leftX + leftW + 24;
  const rightY = 40;
  const rightW = WIDTH - rightX - 40;
  const rightH = HEIGHT - 80;
  drawRoundRect(ctx, rightX, rightY, rightW, rightH, PANEL_RADIUS, 'rgba(2, 6, 23, 0.65)');

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '700 40px Sans';
  ctx.fillText('PERFIL RPG', leftX + 30, leftY + 62);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 22px Sans';
  ctx.fillText(trimText(trainerLabel, 22), leftX + 30, leftY + 96);

  const levelText = `Nivel ${toInt(summary?.level, 1)}`;
  const goldText = `${toInt(summary?.gold, 0)} gold`;
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 28px Sans';
  ctx.fillText(levelText, leftX + 30, leftY + 146);
  ctx.fillText(goldText, leftX + 30, leftY + 184);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 20px Sans';
  const rankText = Number.isFinite(Number(summary?.pvpWeeklyRank)) ? `Rank PvP: #${toInt(summary?.pvpWeeklyRank, 0)}` : 'Rank PvP: sem rank';
  const streakText = `Streak: ${toText(summary?.streakLabel, 'Sem historico')}`;
  ctx.fillText(trimText(rankText, 34), leftX + 30, leftY + 220);
  ctx.fillText(trimText(streakText, 34), leftX + 30, leftY + 248);

  const xpProgressPct = clamp(toInt(summary?.xpProgressPct, 0), 0, 100);
  drawProgressBar({
    ctx,
    x: leftX + 30,
    y: leftY + 272,
    width: leftW - 60,
    height: 24,
    progressPct: xpProgressPct,
    color: accent,
  });

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '600 18px Sans';
  ctx.fillText(`XP: ${toInt(summary?.xp, 0)} (${xpProgressPct}%)`, leftX + 30, leftY + 325);
  if (toInt(summary?.xpToNextLevel, 0) > 0) {
    ctx.fillText(`Faltam ${toInt(summary?.xpToNextLevel, 0)} XP para o nivel ${toInt(summary?.nextLevel, toInt(summary?.level, 1) + 1)}`, leftX + 30, leftY + 350);
  } else {
    ctx.fillText('Nivel maximo alcancado', leftX + 30, leftY + 350);
  }

  const spriteX = leftX + 30;
  const spriteY = leftY + 380;
  const spriteW = leftW - 60;
  const spriteH = 330;
  drawRoundRect(ctx, spriteX, spriteY, spriteW, spriteH, 22, 'rgba(15, 23, 42, 0.8)');

  const image = await resolveImage(activePokemon?.imageUrl || activePokemon?.sprite || null);
  if (image) {
    const size = Math.min(spriteW - 36, spriteH - 36);
    const drawX = spriteX + (spriteW - size) / 2;
    const drawY = spriteY + (spriteH - size) / 2;
    ctx.drawImage(image, drawX, drawY, size, size);
  } else {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.2)';
    drawRoundRect(ctx, spriteX + 18, spriteY + 18, spriteW - 36, spriteH - 36, 18, 'rgba(148, 163, 184, 0.14)');
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 22px Sans';
    ctx.textAlign = 'center';
    ctx.fillText('Imagem indisponivel', spriteX + spriteW / 2, spriteY + spriteH / 2 + 8);
    ctx.textAlign = 'start';
  }

  const pokemonName = trimText(activePokemon?.displayName || activePokemon?.name || 'Sem Pokemon ativo', 28);
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 26px Sans';
  ctx.fillText(pokemonName, leftX + 30, leftY + 748);

  const hpCurrent = Math.max(0, toInt(activePokemon?.currentHp, 0));
  const hpMax = Math.max(1, toInt(activePokemon?.maxHp, 1));
  const typeText = Array.isArray(activePokemon?.types) && activePokemon.types.length ? activePokemon.types.join(', ') : 'tipo indefinido';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 20px Sans';
  ctx.fillText(`Lv.${Math.max(1, toInt(activePokemon?.level, 1))}  |  HP ${hpCurrent}/${hpMax}`, leftX + 30, leftY + 782);
  ctx.fillText(trimText(`Tipos: ${typeText}`, 36), leftX + 30, leftY + 812);

  if (generatedAtLabel) {
    ctx.fillStyle = '#64748b';
    ctx.font = '500 17px Sans';
    ctx.fillText(`Atualizado em ${generatedAtLabel}`, leftX + 30, leftY + leftH - 24);
  }

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '700 34px Sans';
  ctx.fillText('Informacoes do jogador', rightX + 28, rightY + 56);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 18px Sans';
  ctx.fillText('Resumo completo em duas colunas', rightX + 28, rightY + 84);

  const textLines = sanitizeProfileText(profileText);
  ctx.font = '500 20px Sans';

  const contentTop = rightY + 122;
  const contentBottom = rightY + rightH - 28;
  const lineHeight = 24;
  const colGap = 28;
  const colWidth = Math.floor((rightW - 56 - colGap) / 2);
  const colOneX = rightX + 28;
  const colTwoX = colOneX + colWidth + colGap;
  const maxLinesPerCol = Math.max(1, Math.floor((contentBottom - contentTop) / lineHeight));
  const maxLines = maxLinesPerCol * 2;

  const wrapped = [];
  for (const line of textLines) {
    const normalized = String(line || '');
    if (!normalized.trim()) {
      wrapped.push('');
      continue;
    }
    const segments = wrapLine(ctx, normalized, colWidth - 2);
    segments.forEach((segment) => wrapped.push(segment));
  }

  const truncated = wrapped.length > maxLines;
  const visible = wrapped.slice(0, maxLines);
  if (truncated && visible.length) {
    visible[visible.length - 1] = '... use /rpg perfil para ver texto completo';
  }

  visible.forEach((line, index) => {
    const colIndex = Math.floor(index / maxLinesPerCol);
    const rowIndex = index % maxLinesPerCol;
    const x = colIndex === 0 ? colOneX : colTwoX;
    const y = contentTop + rowIndex * lineHeight;

    if (!line) return;

    if (isHeaderLine(line)) {
      ctx.fillStyle = '#f8fafc';
      ctx.font = '700 20px Sans';
      ctx.fillText(trimText(line, 64), x, y);
      return;
    }

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 19px Sans';
    ctx.fillText(trimText(line, 94), x, y);
  });

  return canvas.toBuffer('image/png', { compressionLevel: 4 });
};
