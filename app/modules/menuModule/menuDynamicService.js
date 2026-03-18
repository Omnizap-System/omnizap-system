import logger from '#logger';
import { getCommandsCatalogSnapshot } from './menuCatalogService.js';

const MENU_SITE_URL = 'https://omnizap.shop/comandos/';
const DEFAULT_USAGE_WINDOW_DAYS = 30;
const DEFAULT_MANY_COMMANDS_THRESHOLD = 20;
const DEFAULT_MAIN_PRIMARY_LIMIT = 8;
const DEFAULT_MAIN_ROTATION_LIMIT = 4;
const DEFAULT_TOP_MENU_LIMIT = 12;
const DEFAULT_CATEGORY_MENU_LIMIT = 12;
const DEFAULT_CATEGORY_PREVIEW_LIMIT = 8;

const toPositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric < min) return fallback;
  return Math.max(min, Math.min(max, numeric));
};

const MENU_USAGE_WINDOW_DAYS = toPositiveInt(process.env.MENU_USAGE_WINDOW_DAYS, DEFAULT_USAGE_WINDOW_DAYS, 1, 365);
const MENU_MANY_COMMANDS_THRESHOLD = toPositiveInt(process.env.MENU_MANY_COMMANDS_THRESHOLD, DEFAULT_MANY_COMMANDS_THRESHOLD, 8, 120);
const MENU_MAIN_PRIMARY_LIMIT = toPositiveInt(process.env.MENU_MAIN_PRIMARY_LIMIT, DEFAULT_MAIN_PRIMARY_LIMIT, 4, 20);
const MENU_MAIN_ROTATION_LIMIT = toPositiveInt(process.env.MENU_MAIN_ROTATION_LIMIT, DEFAULT_MAIN_ROTATION_LIMIT, 0, 20);
const MENU_TOP_LIMIT = toPositiveInt(process.env.MENU_TOP_LIMIT, DEFAULT_TOP_MENU_LIMIT, 5, 30);
const MENU_CATEGORY_LIMIT = toPositiveInt(process.env.MENU_CATEGORY_LIMIT, DEFAULT_CATEGORY_MENU_LIMIT, 5, 40);
const MENU_CATEGORY_PREVIEW_LIMIT = toPositiveInt(process.env.MENU_CATEGORY_PREVIEW_LIMIT, DEFAULT_CATEGORY_PREVIEW_LIMIT, 4, 20);

const TOP_TOKENS = new Set(['top', 'tops', 'maisusados', 'popular', 'populares', 'trending']);
const ALL_TOKENS = new Set(['todos', 'todas', 'all', 'completo', 'completa']);
const CATEGORY_TOKENS = new Set(['categoria', 'cat', 'categorias']);

const sanitizeLogValue = (value) =>
  String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeLookupToken = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();

const normalizeCommandName = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);

const shortText = (value, max = 62) => {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'Sem descricao cadastrada.';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
};

const chunk = (items = [], size = 8) => {
  const safeSize = Math.max(1, size);
  const chunks = [];
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }
  return chunks;
};

const parseGeneratedAtMs = (snapshot = null) => {
  const explicit = Number(snapshot?.generatedAtMs || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const parsed = Date.parse(String(snapshot?.catalog?.generated_at || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatCatalogGeneratedAt = (snapshot = null) => {
  const generatedAtMs = parseGeneratedAtMs(snapshot);
  if (!generatedAtMs) return null;
  try {
    const formatter = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'UTC',
    });
    return `${formatter.format(new Date(generatedAtMs))} UTC`;
  } catch {
    return null;
  }
};

const normalizeCatalogCategory = (rawCategory = {}) => {
  const key = String(rawCategory?.key || '').trim();
  const label = String(rawCategory?.label || key || 'Categoria').trim();
  const rawCommands = Array.isArray(rawCategory?.commands) ? rawCategory.commands : [];
  const seenNames = new Set();
  const commands = rawCommands
    .map((rawCommand) => {
      const name = normalizeCommandName(rawCommand?.name);
      if (!name || seenNames.has(name)) return null;
      seenNames.add(name);
      return {
        ...rawCommand,
        name,
        aliases: Array.isArray(rawCommand?.aliases) ? rawCommand.aliases.map((alias) => normalizeCommandName(alias)).filter(Boolean) : [],
        descricao: String(rawCommand?.descricao || rawCommand?.description || '').trim(),
      };
    })
    .filter(Boolean);

  if (!key || !commands.length) return null;
  return {
    ...rawCategory,
    key,
    label,
    commands,
  };
};

const extractCatalogModel = (catalogSnapshot = null) => {
  const catalog = catalogSnapshot?.catalog || catalogSnapshot;
  const rawCategories = Array.isArray(catalog?.categories) ? catalog.categories : [];
  const categories = rawCategories.map(normalizeCatalogCategory).filter(Boolean);

  const dedupeCommands = new Map();
  for (const category of categories) {
    for (const command of category.commands) {
      if (!dedupeCommands.has(command.name)) {
        dedupeCommands.set(command.name, {
          ...command,
          categoryKey: category.key,
          categoryLabel: category.label,
        });
      }
    }
  }

  return {
    categories,
    commands: [...dedupeCommands.values()],
  };
};

const buildUsageMap = (usageRows = []) => {
  const usageMap = new Map();
  for (const row of usageRows) {
    const commandName = normalizeCommandName(row?.commandName);
    const usageCount = Number(row?.usageCount || 0);
    if (!commandName || !Number.isFinite(usageCount) || usageCount <= 0) continue;
    usageMap.set(commandName, Math.max(1, Math.floor(usageCount)));
  }
  return usageMap;
};

const getSuggestionPriority = (command = {}) => {
  const direct = Number(command?.suggestion_priority);
  if (Number.isFinite(direct)) return direct;
  const discoveryPriority = Number(command?.discovery?.suggestion_priority);
  if (Number.isFinite(discoveryPriority)) return discoveryPriority;
  return 0;
};

const rankCommands = (commands = [], usageMap = new Map()) =>
  [...commands].sort((left, right) => {
    const usageDiff = (usageMap.get(right.name) || 0) - (usageMap.get(left.name) || 0);
    if (usageDiff !== 0) return usageDiff;

    const priorityDiff = getSuggestionPriority(right) - getSuggestionPriority(left);
    if (priorityDiff !== 0) return priorityDiff;

    return left.name.localeCompare(right.name, 'pt-BR');
  });

const mergeUsageRows = (...rowsSets) => {
  const merged = new Map();
  for (const rows of rowsSets) {
    for (const row of rows || []) {
      const commandName = normalizeCommandName(row?.commandName);
      const usageCount = Number(row?.usageCount || 0);
      if (!commandName || !Number.isFinite(usageCount) || usageCount <= 0) continue;
      const current = merged.get(commandName) || 0;
      if (usageCount > current) {
        merged.set(commandName, Math.floor(usageCount));
      }
    }
  }

  return [...merged.entries()]
    .map(([commandName, usageCount]) => ({
      commandName,
      usageCount,
    }))
    .sort((left, right) => right.usageCount - left.usageCount);
};

const pickRotatingCommands = (commands = [], limit = 0, seed = 0) => {
  const safeLimit = Math.max(0, limit);
  if (!commands.length || safeLimit <= 0) return [];

  const start = Math.abs(Math.floor(seed)) % commands.length;
  const picked = [];
  for (let index = 0; index < commands.length && picked.length < safeLimit; index += 1) {
    picked.push(commands[(start + index) % commands.length]);
  }
  return picked;
};

const buildCategoryAliasMap = (categories = []) => {
  const aliasMap = new Map();

  const bindAlias = (alias, category) => {
    const normalizedAlias = normalizeLookupToken(alias);
    if (!normalizedAlias || !category) return;
    if (!aliasMap.has(normalizedAlias)) {
      aliasMap.set(normalizedAlias, category);
    }
  };

  for (const category of categories) {
    bindAlias(category.key, category);
    bindAlias(category.label, category);
  }

  const bindKnownAliases = (keys = [], aliases = []) => {
    const normalizedKeys = new Set(keys.map((entry) => normalizeLookupToken(entry)).filter(Boolean));
    const category = categories.find((entry) => normalizedKeys.has(normalizeLookupToken(entry.key)));
    if (!category) return;
    for (const alias of aliases) {
      bindAlias(alias, category);
    }
  };

  bindKnownAliases(['admin'], ['adm', 'administracao', 'moderação', 'moderacao']);
  bindKnownAliases(['figurinhas'], ['figurinha', 'sticker', 'stickers']);
  bindKnownAliases(['midia'], ['media']);
  bindKnownAliases(['ia'], ['ai', 'inteligenciaartificial']);
  bindKnownAliases(['stats'], ['estatistica', 'estatisticas']);

  return aliasMap;
};

const resolveCategoryFromQuery = (categories = [], query = '') => {
  const normalizedQuery = normalizeLookupToken(query);
  if (!normalizedQuery) return null;

  const aliasMap = buildCategoryAliasMap(categories);
  if (aliasMap.has(normalizedQuery)) {
    return aliasMap.get(normalizedQuery);
  }

  return categories.find((entry) => normalizeLookupToken(entry.label).includes(normalizedQuery) || normalizeLookupToken(entry.key).includes(normalizedQuery)) || null;
};

const formatUsageSuffix = (commandName, usageMap, withLabel = true) => {
  const usage = usageMap.get(commandName) || 0;
  if (!usage) return '';
  return withLabel ? ` (${usage} usos)` : ` (${usage})`;
};

const buildMainMenuText = ({ senderName = '', commandPrefix = '/', categories = [], commands = [], usageMap = new Map(), catalogSnapshot = null } = {}) => {
  const rankedCommands = rankCommands(commands, usageMap);
  const hasManyCommands = commands.length > MENU_MANY_COMMANDS_THRESHOLD;
  const primary = rankedCommands.slice(0, MENU_MAIN_PRIMARY_LIMIT);
  const remaining = rankedCommands.slice(MENU_MAIN_PRIMARY_LIMIT);

  const rotationSeed = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const rotating = hasManyCommands ? pickRotatingCommands(remaining, MENU_MAIN_ROTATION_LIMIT, rotationSeed) : [];
  const highlighted = [...new Map([...primary, ...rotating].map((command) => [command.name, command])).values()];
  const generatedAtLabel = formatCatalogGeneratedAt(catalogSnapshot);
  const quickCategories = [...categories].sort((left, right) => right.commands.length - left.commands.length).slice(0, MENU_CATEGORY_PREVIEW_LIMIT);

  const safeName =
    String(senderName || '')
      .trim()
      .split(/\s+/)[0] || 'pessoa';
  const lines = [`Olá, ${safeName}!`, '', '📌 *Menu dinâmico do OmniZap*', `Comandos cadastrados: *${commands.length}*`, `Categorias disponíveis: *${categories.length}*`];

  if (generatedAtLabel) {
    lines.push(`Catálogo atualizado: *${generatedAtLabel}*`);
  }

  lines.push('', '*Categorias rápidas:*');
  for (const category of quickCategories) {
    lines.push(`• ${category.label} (${category.commands.length}) → ${commandPrefix}menu ${category.key}`);
  }

  if (categories.length > quickCategories.length) {
    lines.push(`• ...e mais ${categories.length - quickCategories.length} categorias`);
  }

  lines.push('', hasManyCommands ? `*🔥 Destaques por uso (${MENU_USAGE_WINDOW_DAYS}d):*` : '*✨ Destaques:*');
  for (const command of highlighted) {
    lines.push(`• ${commandPrefix}${command.name}${formatUsageSuffix(command.name, usageMap, false)} — ${shortText(command.descricao, 56)}`);
  }

  if (!highlighted.length) {
    lines.push('• Nenhum comando em destaque encontrado.');
  }

  lines.push('', '*Navegação:*', `• ${commandPrefix}menu top`, `• ${commandPrefix}menu categoria <nome>`, `• ${commandPrefix}menu todos`, '', `🌐 ${MENU_SITE_URL}`);
  return lines.join('\n');
};

const buildTopMenuText = ({ commandPrefix = '/', commands = [], usageMap = new Map() } = {}) => {
  const ranked = rankCommands(commands, usageMap).slice(0, MENU_TOP_LIMIT);
  const hasUsage = ranked.some((command) => (usageMap.get(command.name) || 0) > 0);
  const lines = [hasUsage ? `🏆 *Top comandos (${MENU_USAGE_WINDOW_DAYS} dias)*` : '🏆 *Destaques de comandos*', ''];

  for (const command of ranked) {
    lines.push(`• ${commandPrefix}${command.name}${formatUsageSuffix(command.name, usageMap)} — ${shortText(command.descricao, 58)}`);
  }

  if (!ranked.length) {
    lines.push('Nenhum comando disponível no catálogo no momento.');
  }

  lines.push('', `Use ${commandPrefix}menu categoria <nome> para abrir uma categoria.`);
  lines.push(`🌐 ${MENU_SITE_URL}`);
  return lines.join('\n');
};

const buildCategoryMenuText = ({ commandPrefix = '/', category = null, usageMap = new Map() } = {}) => {
  if (!category) return null;

  const ranked = rankCommands(category.commands, usageMap);
  const visible = ranked.slice(0, MENU_CATEGORY_LIMIT);
  const hiddenCount = Math.max(0, ranked.length - visible.length);
  const lines = [`📂 *Categoria: ${category.label}*`, `Total: *${ranked.length}* comando(s)`, ''];

  for (const command of visible) {
    lines.push(`• ${commandPrefix}${command.name}${formatUsageSuffix(command.name, usageMap)} — ${shortText(command.descricao, 60)}`);
  }

  if (hiddenCount > 0) {
    lines.push('', `... e mais *${hiddenCount}* comando(s) nesta categoria.`);
    lines.push(`Use ${commandPrefix}menu todos para ver a lista completa.`);
  }

  lines.push('', `🌐 ${MENU_SITE_URL}`);
  return lines.join('\n');
};

const buildAllMenuText = ({ commandPrefix = '/', categories = [] } = {}) => {
  const sortedCategories = [...categories].sort((left, right) => right.commands.length - left.commands.length);
  const totalCommands = sortedCategories.reduce((acc, category) => acc + category.commands.length, 0);
  const lines = ['📚 *Catálogo completo de comandos*', `Categorias: *${sortedCategories.length}* | Comandos: *${totalCommands}*`, ''];

  for (const category of sortedCategories) {
    lines.push(`📁 *${category.label}* (${category.commands.length})`);
    const commandNames = category.commands.map((command) => `${commandPrefix}${command.name}`);
    for (const lineChunk of chunk(commandNames, 8)) {
      lines.push(lineChunk.join(' • '));
    }
    lines.push('');
  }

  lines.push(`🌐 ${MENU_SITE_URL}`);
  return lines.join('\n').trim();
};

const buildUnknownCategoryText = ({ commandPrefix = '/', query = '', categories = [] } = {}) => {
  const quickCategories = [...categories].sort((left, right) => right.commands.length - left.commands.length).slice(0, MENU_CATEGORY_PREVIEW_LIMIT);
  const lines = [`Não encontrei a categoria *${query || 'informada'}*.`, '', '*Tente uma destas:*'];

  for (const category of quickCategories) {
    lines.push(`• ${commandPrefix}menu ${category.key}`);
  }

  lines.push('', `Ou acesse: ${MENU_SITE_URL}`);
  return lines.join('\n');
};

export const buildDynamicMenuText = ({ catalogSnapshot = null, usageRows = [], args = [], senderName = '', commandPrefix = '/' } = {}) => {
  const { categories, commands } = extractCatalogModel(catalogSnapshot);
  if (!categories.length || !commands.length) return null;

  const usageMap = buildUsageMap(usageRows);
  const safeArgs = Array.isArray(args) ? args.map((value) => String(value || '').trim()).filter(Boolean) : [];
  const firstToken = normalizeLookupToken(safeArgs[0] || '');

  if (!firstToken) {
    return buildMainMenuText({
      senderName,
      commandPrefix,
      categories,
      commands,
      usageMap,
      catalogSnapshot,
    });
  }

  if (TOP_TOKENS.has(firstToken)) {
    return buildTopMenuText({
      commandPrefix,
      commands,
      usageMap,
    });
  }

  if (ALL_TOKENS.has(firstToken)) {
    return buildAllMenuText({
      commandPrefix,
      categories,
    });
  }

  const isCategorySelector = CATEGORY_TOKENS.has(firstToken);
  const query = isCategorySelector ? safeArgs.slice(1).join(' ') : safeArgs.join(' ');

  if (isCategorySelector && !query) {
    return [`Use ${commandPrefix}menu categoria <nome>.`, '', `Exemplo: ${commandPrefix}menu categoria admin`, `🌐 ${MENU_SITE_URL}`].join('\n');
  }

  const category = resolveCategoryFromQuery(categories, query);
  if (!category) {
    return buildUnknownCategoryText({
      commandPrefix,
      query,
      categories,
    });
  }

  return buildCategoryMenuText({
    commandPrefix,
    category,
    usageMap,
  });
};

export const resolveDynamicMenuText = async ({ args = [], senderName = '', commandPrefix = '/', remoteJid = null } = {}) => {
  try {
    const { listTopCommandsByUsage } = await import('./menuCommandUsageRepository.js');
    const catalogSnapshot = await getCommandsCatalogSnapshot();
    const [groupUsage, globalUsage] = await Promise.all([
      listTopCommandsByUsage({
        chatId: remoteJid || null,
        days: MENU_USAGE_WINDOW_DAYS,
        limit: 30,
      }),
      listTopCommandsByUsage({
        days: MENU_USAGE_WINDOW_DAYS,
        limit: 40,
      }),
    ]);

    const usageRows = mergeUsageRows(groupUsage, globalUsage);
    return buildDynamicMenuText({
      catalogSnapshot,
      usageRows,
      args,
      senderName,
      commandPrefix,
    });
  } catch (error) {
    logger.warn('Falha ao montar menu dinamico. Aplicando fallback para menu estatico.', {
      action: 'menu_dynamic_build_failed',
      error: sanitizeLogValue(error?.message) || 'unknown_error',
    });
    return null;
  }
};

export const __menuDynamicInternals = {
  normalizeLookupToken,
  buildUsageMap,
  rankCommands,
  resolveCategoryFromQuery,
  buildAllMenuText,
  mergeUsageRows,
};
