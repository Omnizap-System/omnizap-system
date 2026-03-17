import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createModuleCommandConfigRuntime } from '../../services/ai/moduleCommandConfigRuntimeService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'commandConfig.json');

const DEFAULT_TEXTS = {
  usage_header: 'Use assim:',
  premium_only: '⭐ *Comando Premium*\n\nEste comando é exclusivo para usuários premium.',
  openai_not_configured: '⚠️ *OpenAI não configurada*\n\nDefina a variável *OPENAI_API_KEY* no `.env` para usar este comando.',
  generic_error: '❌ *Erro ao falar com a IA*\nTente novamente em alguns instantes.',
};

const runtime = createModuleCommandConfigRuntime({
  configPath: CONFIG_PATH,
  fallbackConfig: {
    module: 'aiModule',
    commands: [],
    textos: DEFAULT_TEXTS,
  },
});

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const renderUsageMethod = (method, commandPrefix) => String(method || '').replaceAll('<prefix>', String(commandPrefix || '/'));

const resolveUsageLines = (entry, variant) => {
  if (!entry || typeof entry !== 'object') return [];

  const usageMessages = entry?.mensagens_uso && typeof entry.mensagens_uso === 'object' ? entry.mensagens_uso : null;

  if (usageMessages) {
    const variantKey = typeof variant === 'string' ? variant.trim() : '';
    const picked = (variantKey && usageMessages[variantKey]) || usageMessages.default || null;
    if (Array.isArray(picked)) {
      return picked.filter(Boolean).map((value) => String(value));
    }
    if (typeof picked === 'string' && picked.trim()) {
      return [picked.trim()];
    }
  }

  const methods = Array.isArray(entry?.metodos_de_uso) ? entry.metodos_de_uso : [];
  return methods.filter(Boolean).map((value) => String(value));
};

export const getAiModuleConfig = () => runtime.getModuleConfig();

export const resolveAiCommandName = (command) => runtime.resolveCommandName(command);
export const getAiCommandEntry = (command) => runtime.getCommandEntry(command);
export const listEnabledAiCommands = () => runtime.listEnabledCommands();

export const getAiTextConfig = () => {
  const config = getAiModuleConfig();
  const raw = config?.textos && typeof config.textos === 'object' ? config.textos : {};
  return {
    ...DEFAULT_TEXTS,
    ...raw,
  };
};

export const getAiUsageText = (command, { commandPrefix = '/', header, variant } = {}) => {
  const entry = getAiCommandEntry(command);
  const methods = resolveUsageLines(entry, variant);
  if (!methods.length) return '';

  const prefixHeader = typeof header === 'string' ? header : getAiTextConfig().usage_header || DEFAULT_TEXTS.usage_header;
  const lines = methods.map((method) => renderUsageMethod(method, commandPrefix));
  return [prefixHeader, ...lines].join('\n');
};

export const isAiCommandPremiumOnly = (command) => {
  const entry = getAiCommandEntry(command);
  return Boolean(entry?.acesso?.somente_premium);
};

export const getAiCommandSystemMessages = (command) => {
  const entry = getAiCommandEntry(command);
  const raw = entry?.mensagens_sistema && typeof entry.mensagens_sistema === 'object' ? entry.mensagens_sistema : {};
  return raw;
};

export const getAiCommandOperationalLimits = (command) => {
  const entry = getAiCommandEntry(command);
  const raw = entry?.limites_operacionais && typeof entry.limites_operacionais === 'object' ? entry.limites_operacionais : {};
  return raw;
};

const normalizeMapKeys = (value = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, mapValue] of Object.entries(value)) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) continue;
    output[normalizedKey] = String(mapValue ?? '').trim();
  }
  return output;
};

export const getAiCommandOptionConfig = (command) => {
  const entry = getAiCommandEntry(command);
  const options = entry?.opcoes && typeof entry.opcoes === 'object' ? entry.opcoes : {};

  const parse = options?.parse && typeof options.parse === 'object' ? options.parse : {};
  const generation = options?.geracao_imagem && typeof options.geracao_imagem === 'object' ? options.geracao_imagem : {};

  return {
    parse: {
      audio_flags: Array.isArray(parse.audio_flags) ? parse.audio_flags.map((item) => String(item || '')).filter(Boolean) : [],
      text_flags: Array.isArray(parse.text_flags) ? parse.text_flags.map((item) => String(item || '')).filter(Boolean) : [],
      reset_aliases: Array.isArray(parse.reset_aliases) ? parse.reset_aliases.map((item) => String(item || '')).filter(Boolean) : [],
      image_detail_aliases: normalizeMapKeys(parse.image_detail_aliases || {}),
    },
    geracao_imagem: {
      size_options: Array.isArray(generation.size_options) ? generation.size_options.map((item) => normalizeText(item)).filter(Boolean) : [],
      size_aliases: normalizeMapKeys(generation.size_aliases || {}),
      quality_options: Array.isArray(generation.quality_options) ? generation.quality_options.map((item) => normalizeText(item)).filter(Boolean) : [],
      quality_aliases: normalizeMapKeys(generation.quality_aliases || {}),
      format_options: Array.isArray(generation.format_options) ? generation.format_options.map((item) => normalizeText(item)).filter(Boolean) : [],
      format_aliases: normalizeMapKeys(generation.format_aliases || {}),
      background_options: Array.isArray(generation.background_options) ? generation.background_options.map((item) => normalizeText(item)).filter(Boolean) : [],
      background_aliases: normalizeMapKeys(generation.background_aliases || {}),
      flag_aliases: generation.flag_aliases && typeof generation.flag_aliases === 'object' ? Object.fromEntries(Object.entries(generation.flag_aliases).map(([key, value]) => [normalizeText(key), Array.isArray(value) ? value.map((item) => normalizeText(item)).filter(Boolean) : []])) : {},
      compression: {
        min: Number(generation?.compression?.min ?? 0),
        max: Number(generation?.compression?.max ?? 100),
      },
    },
  };
};
