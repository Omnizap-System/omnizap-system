import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import OpenAI from 'openai';
import NodeCache from 'node-cache';
import fs from 'node:fs/promises';
import path from 'node:path';

import logger from '#logger';
import premiumUserStore from '../../store/premiumUserStore.js';
import aiPromptStore from '../../store/aiPromptStore.js';
import { downloadMediaMessage, extractAllMediaDetails, getJidUser, isSameJidUser, normalizeJid } from '../../config/index.js';
import { sendAndStore } from '../../services/messaging/messagePersistenceService.js';
import { getAdminJid, resolveAdminJid } from '../../config/index.js';
import { extractUserIdInfo, resolveUserId, resolveUserIdCached } from '../../config/index.js';
import { getAiCommandOperationalLimits, getAiCommandOptionConfig, getAiCommandSystemMessages, getAiUsageText, isAiCommandPremiumOnly } from './aiConfigRuntime.js';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || OPENAI_MODEL;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const OPENAI_TTS_FORMAT_RAW = (process.env.OPENAI_TTS_FORMAT || 'mp3').toLowerCase();
const OPENAI_TTS_PTT = process.env.OPENAI_TTS_PTT === 'true';
const OPENAI_TTS_MAX_CHARS = Number.parseInt(process.env.OPENAI_TTS_MAX_CHARS || '4096', 10);
const OPENAI_MAX_IMAGE_MB = Number.parseFloat(process.env.OPENAI_MAX_IMAGE_MB || '50');
const OPENAI_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_TIMEOUT_MS || '30000', 10);
const OPENAI_IMAGE_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_IMAGE_TIMEOUT_MS || '120000', 10);
const OPENAI_MAX_RETRIES = Number.parseInt(process.env.OPENAI_MAX_RETRIES || '2', 10);
const OPENAI_RETRY_BASE_MS = Number.parseInt(process.env.OPENAI_RETRY_BASE_MS || '500', 10);
const OPENAI_RETRY_MAX_MS = Number.parseInt(process.env.OPENAI_RETRY_MAX_MS || '4000', 10);
const DEFAULT_SYSTEM_PROMPT = `Responda em PT-BR:`.trim();
const DEFAULT_IMAGE_PROMPT = 'Responda em PT-BR:';
const TEMP_DIR = path.join(process.cwd(), 'temp', 'ai');

const BASE_SYSTEM_PROMPT = process.env.OPENAI_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT;
const DEFAULT_COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';
const OWNER_JID = getAdminJid();

const SESSION_TTL_SECONDS = Number.parseInt(process.env.OPENAI_SESSION_TTL_SECONDS || '21600', 10);
const sessionCache = new NodeCache({
  stdTTL: SESSION_TTL_SECONDS,
  checkperiod: Math.max(60, Math.floor(SESSION_TTL_SECONDS / 4)),
});
let cachedClient = null;

const AUDIO_FLAG_ALIASES = new Set(['--audio', '--voz', '--voice', '--tts', '-a']);
const TEXT_FLAG_ALIASES = new Set(['--texto', '--text', '--txt']);
const IMAGE_DETAIL_ALIASES = new Map([
  ['low', 'low'],
  ['high', 'high'],
  ['auto', 'auto'],
  ['baixo', 'low'],
  ['baixa', 'low'],
  ['alto', 'high'],
  ['alta', 'high'],
  ['automatico', 'auto'],
  ['automático', 'auto'],
]);
const IMAGE_GEN_SIZE_OPTIONS = new Set(['auto', '1024x1024', '1024x1536', '1536x1024']);
const IMAGE_GEN_SIZE_ALIASES = new Map([
  ['1024', '1024x1024'],
  ['square', '1024x1024'],
  ['quadrado', '1024x1024'],
  ['portrait', '1024x1536'],
  ['retrato', '1024x1536'],
  ['landscape', '1536x1024'],
  ['paisagem', '1536x1024'],
  ['auto', 'auto'],
]);
const IMAGE_GEN_QUALITY_OPTIONS = new Set(['auto', 'low', 'medium', 'high']);
const IMAGE_GEN_QUALITY_ALIASES = new Map([
  ['baixa', 'low'],
  ['baixo', 'low'],
  ['media', 'medium'],
  ['média', 'medium'],
  ['medio', 'medium'],
  ['médio', 'medium'],
  ['alta', 'high'],
  ['alto', 'high'],
  ['auto', 'auto'],
]);
const IMAGE_GEN_FORMAT_OPTIONS = new Set(['png', 'jpeg', 'webp']);
const IMAGE_GEN_FORMAT_ALIASES = new Map([
  ['jpg', 'jpeg'],
  ['jpeg', 'jpeg'],
  ['png', 'png'],
  ['webp', 'webp'],
]);
const IMAGE_GEN_BACKGROUND_OPTIONS = new Set(['auto', 'transparent', 'opaque']);
const IMAGE_GEN_BACKGROUND_ALIASES = new Map([
  ['auto', 'auto'],
  ['transparent', 'transparent'],
  ['transparente', 'transparent'],
  ['opaque', 'opaque'],
  ['opaco', 'opaque'],
  ['opaca', 'opaque'],
]);
const IMAGE_GEN_FLAG_ALIASES = {
  size: new Set(['--size', '--tamanho']),
  quality: new Set(['--quality', '--qualidade']),
  format: new Set(['--format', '--formato']),
  background: new Set(['--background', '--fundo']),
  compression: new Set(['--compression', '--compressao', '--compressão']),
};
const AUDIO_MIME_BY_FORMAT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg; codecs=opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'audio/pcm',
};
const SAFE_TTS_FORMAT = AUDIO_MIME_BY_FORMAT[OPENAI_TTS_FORMAT_RAW] ? OPENAI_TTS_FORMAT_RAW : 'mp3';
const TTS_OUTPUT_FORMAT = OPENAI_TTS_PTT ? 'opus' : SAFE_TTS_FORMAT;
const TTS_MIME_TYPE = AUDIO_MIME_BY_FORMAT[TTS_OUTPUT_FORMAT] || 'audio/mpeg';
const TTS_MAX_CHARS = Number.isFinite(OPENAI_TTS_MAX_CHARS) && OPENAI_TTS_MAX_CHARS > 0 ? OPENAI_TTS_MAX_CHARS : 4096;
const OPENAI_TIMEOUT = Number.isFinite(OPENAI_TIMEOUT_MS) && OPENAI_TIMEOUT_MS > 0 ? OPENAI_TIMEOUT_MS : 30000;
const OPENAI_IMAGE_TIMEOUT = Number.isFinite(OPENAI_IMAGE_TIMEOUT_MS) && OPENAI_IMAGE_TIMEOUT_MS > 0 ? OPENAI_IMAGE_TIMEOUT_MS : 120000;
const OPENAI_CLIENT_TIMEOUT = Math.max(OPENAI_TIMEOUT, OPENAI_IMAGE_TIMEOUT);
const OPENAI_RETRIES = Number.isFinite(OPENAI_MAX_RETRIES) && OPENAI_MAX_RETRIES >= 0 ? OPENAI_MAX_RETRIES : 2;
const OPENAI_RETRY_BASE = Number.isFinite(OPENAI_RETRY_BASE_MS) && OPENAI_RETRY_BASE_MS > 0 ? OPENAI_RETRY_BASE_MS : 500;
const OPENAI_RETRY_MAX = Number.isFinite(OPENAI_RETRY_MAX_MS) && OPENAI_RETRY_MAX_MS > 0 ? OPENAI_RETRY_MAX_MS : 4000;
const MAX_IMAGE_BYTES = Number.isFinite(OPENAI_MAX_IMAGE_MB) && OPENAI_MAX_IMAGE_MB > 0 ? OPENAI_MAX_IMAGE_MB * 1024 * 1024 : 50 * 1024 * 1024;

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const toSet = (values = [], fallbackValues = []) => {
  const source = Array.isArray(values) && values.length ? values : fallbackValues;
  return new Set(source.map((value) => normalizeText(value)).filter(Boolean));
};

const toMap = (value = {}, fallbackMap = new Map()) => {
  const output = new Map();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, mapValue] of Object.entries(value)) {
      const normalizedKey = normalizeText(key);
      const normalizedValue = normalizeText(mapValue);
      if (!normalizedKey || !normalizedValue) continue;
      output.set(normalizedKey, normalizedValue);
    }
  }

  if (output.size > 0) {
    return output;
  }
  return new Map(fallbackMap);
};

const resolveAiMessages = (commandName) => {
  const commandMessages = getAiCommandSystemMessages(commandName);
  const mergeMessage = (key, fallback) => String(commandMessages?.[key] || '').trim() || String(fallback || '').trim();

  return {
    premiumOnly: mergeMessage('premium_only', ['⭐ *Comando Premium*', '', 'Este comando é exclusivo para usuários premium.', 'Fale com o administrador para liberar o acesso.'].join('\n')),
    openAiNotConfigured: mergeMessage('openai_nao_configurada', ['⚠️ *OpenAI não configurada*', '', `Defina a variável *OPENAI_API_KEY* no \`.env\` para usar o comando *${commandName}*.`].join('\n')),
    imageTooLarge: mergeMessage('imagem_muito_grande', '⚠️ A imagem enviada ultrapassa o limite de {{limite_mb}} MB. Envie uma imagem menor.'),
    imageDownloadFailed: mergeMessage('imagem_download_falhou', '⚠️ Não consegui baixar a imagem. Tente reenviar.'),
    invalidOptions: mergeMessage('opcoes_invalidas', '⚠️ Opções inválidas no comando.\nDetalhes: {{detalhes}}\n\nUse *{{prefix}}catimg* sem opções para ver o formato correto.'),
    emptyResponse: mergeMessage('resposta_vazia', '⚠️ Não consegui gerar uma resposta agora. Tente novamente.'),
    longAudioFallback: mergeMessage('audio_muito_longo', '⚠️ A resposta ficou longa demais para áudio. Enviando em texto.'),
    audioFailedFallback: mergeMessage('audio_falhou', '⚠️ Não consegui gerar o áudio agora. Enviando texto.'),
    genericAiError: mergeMessage('erro_openai', ['❌ *Erro ao falar com a IA*', 'Tente novamente em alguns instantes.'].join('\n')),
    promptTooLong: mergeMessage('prompt_muito_longo', '⚠️ Prompt muito longo. Limite: {{max_chars}} caracteres.'),
    promptResetSuccess: mergeMessage('prompt_reset_sucesso', '✅ Prompt da IA restaurado para o padrão.'),
    promptUpdateSuccess: mergeMessage('prompt_update_sucesso', '✅ Prompt da IA atualizado para você.'),
  };
};

const applyTemplate = (template, vars = {}) => {
  let output = String(template || '');
  for (const [key, value] of Object.entries(vars || {})) {
    output = output.replaceAll(`{{${key}}}`, String(value ?? ''));
  }
  return output;
};

const resolveCatParseOptions = () => {
  const config = getAiCommandOptionConfig('cat');
  const parse = config?.parse || {};

  return {
    audioFlags: toSet(parse.audio_flags, [...AUDIO_FLAG_ALIASES]),
    textFlags: toSet(parse.text_flags, [...TEXT_FLAG_ALIASES]),
    imageDetailAliases: toMap(parse.image_detail_aliases, IMAGE_DETAIL_ALIASES),
  };
};

const resolveCatImageGenerationOptions = () => {
  const config = getAiCommandOptionConfig('catimg');
  const image = config?.geracao_imagem || {};
  const fallbackFlagAliases = {
    size: [...IMAGE_GEN_FLAG_ALIASES.size],
    quality: [...IMAGE_GEN_FLAG_ALIASES.quality],
    format: [...IMAGE_GEN_FLAG_ALIASES.format],
    background: [...IMAGE_GEN_FLAG_ALIASES.background],
    compression: [...IMAGE_GEN_FLAG_ALIASES.compression],
  };

  const normalizeFlagAliasSet = (key) => toSet(image?.flag_aliases?.[key], fallbackFlagAliases[key] || []);

  const compressionMin = Number(image?.compression?.min);
  const compressionMax = Number(image?.compression?.max);

  return {
    sizeOptions: toSet(image?.size_options, [...IMAGE_GEN_SIZE_OPTIONS]),
    sizeAliases: toMap(image?.size_aliases, IMAGE_GEN_SIZE_ALIASES),
    qualityOptions: toSet(image?.quality_options, [...IMAGE_GEN_QUALITY_OPTIONS]),
    qualityAliases: toMap(image?.quality_aliases, IMAGE_GEN_QUALITY_ALIASES),
    formatOptions: toSet(image?.format_options, [...IMAGE_GEN_FORMAT_OPTIONS]),
    formatAliases: toMap(image?.format_aliases, IMAGE_GEN_FORMAT_ALIASES),
    backgroundOptions: toSet(image?.background_options, [...IMAGE_GEN_BACKGROUND_OPTIONS]),
    backgroundAliases: toMap(image?.background_aliases, IMAGE_GEN_BACKGROUND_ALIASES),
    flagAliases: {
      size: normalizeFlagAliasSet('size'),
      quality: normalizeFlagAliasSet('quality'),
      format: normalizeFlagAliasSet('format'),
      background: normalizeFlagAliasSet('background'),
      compression: normalizeFlagAliasSet('compression'),
    },
    compression: {
      min: Number.isFinite(compressionMin) ? compressionMin : 0,
      max: Number.isFinite(compressionMax) ? compressionMax : 100,
    },
  };
};

const resolveCatPromptMaxChars = () => {
  const limits = getAiCommandOperationalLimits('catprompt');
  const value = Number.parseInt(String(limits?.prompt_max_chars ?? ''), 10);
  if (!Number.isFinite(value) || value <= 0) return 2000;
  return value;
};

const getClient = () => {
  if (cachedClient) return cachedClient;
  cachedClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: OPENAI_CLIENT_TIMEOUT,
    maxRetries: 0,
  });
  return cachedClient;
};

const buildSessionKey = (remoteJid, senderJid, scope) => {
  const base = `${remoteJid}:${senderJid}`;
  return scope ? `${base}:${scope}` : base;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableOpenAIError = (error) => {
  const status = error?.status || error?.statusCode || error?.response?.status;
  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = error?.code || error?.cause?.code;
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'].includes(code)) {
    return true;
  }
  if (error?.name === 'AbortError') return true;
  if (typeof error?.message === 'string' && /timeout/i.test(error.message)) return true;
  return false;
};

const runWithTimeout = async (operation, label, timeoutMs = OPENAI_TIMEOUT) => {
  if (!timeoutMs || timeoutMs <= 0) {
    return operation;
  }
  let timeoutId;
  let didTimeout = false;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      const timeoutError = new Error(`OpenAI ${label} excedeu ${timeoutMs}ms`);
      timeoutError.code = 'OPENAI_TIMEOUT';
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } catch (error) {
    if (didTimeout && operation?.catch) {
      operation.catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const callOpenAI = async (operationFactory, label, timeoutMs) => {
  let attempt = 0;
  while (true) {
    try {
      const operation = operationFactory();
      return await runWithTimeout(operation, label, timeoutMs);
    } catch (error) {
      attempt += 1;
      if (attempt > OPENAI_RETRIES || !isRetryableOpenAIError(error)) {
        throw error;
      }
      const backoff = Math.min(OPENAI_RETRY_MAX, OPENAI_RETRY_BASE * 2 ** (attempt - 1));
      const jitter = Math.round(backoff * (0.8 + Math.random() * 0.4));
      logger.warn(`OpenAI ${label} falhou. Retry ${attempt}/${OPENAI_RETRIES} em ${jitter}ms.`, {
        error: error.message,
        status: error?.status || error?.statusCode || error?.response?.status || null,
      });
      await sleep(jitter);
    }
  }
};

const sendUsage = async (sock, remoteJid, messageInfo, expirationMessage, commandPrefix = DEFAULT_COMMAND_PREFIX) => {
  const usageText =
    getAiUsageText('cat', {
      commandPrefix,
      header: '🤖 *Comando CAT*',
      variant: 'default',
    }) || ['🤖 *Comando CAT*', '', 'Use assim:', `*${commandPrefix}cat* [--audio] sua pergunta`, `*${commandPrefix}cat* (responda ou envie uma imagem com legenda)`, '', 'Opções:', '--audio | --texto', '--detail low | high | auto', '', 'Exemplo:', `*${commandPrefix}cat* Explique como funciona a fotossíntese.`, `*${commandPrefix}cat* --audio Resuma a imagem.`].join('\n');

  await sendAndStore(sock, remoteJid, { text: usageText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
};

const reactToMessage = async (sock, remoteJid, messageInfo) => {
  try {
    if (!messageInfo?.key) return;
    await sendAndStore(sock, remoteJid, {
      react: {
        text: '🐈‍⬛',
        key: messageInfo.key,
      },
    });
  } catch (error) {
    logger.warn('handleCatCommand: falha ao reagir à mensagem.', error);
  }
};

const isPremiumAllowed = async (senderJid) => {
  const senderInfo = extractUserIdInfo({
    jid: senderJid,
    lid: senderJid,
    participantAlt: senderJid,
  });
  const cachedSender = resolveUserIdCached(senderInfo);
  const resolvedSender = await resolveUserId(senderInfo).catch(() => null);
  const senderCandidates = Array.from(new Set([senderJid, senderInfo.jid, senderInfo.lid, senderInfo.participantAlt, senderInfo.raw, cachedSender, resolvedSender].map((value) => normalizeJid(value || '')).filter(Boolean)));

  if (!senderCandidates.length) return false;

  const adminJid = (await resolveAdminJid()) || OWNER_JID;
  const normalizedAdmin = normalizeJid(adminJid || '');
  if (!normalizedAdmin) return true;
  if (senderCandidates.some((sender) => sender === normalizedAdmin || isSameJidUser(sender, normalizedAdmin))) return true;

  const premiumUsers = await premiumUserStore.getPremiumUsers();
  if (!Array.isArray(premiumUsers) || premiumUsers.length === 0) return false;
  const premiumCandidates = Array.from(new Set(premiumUsers.map((jid) => normalizeJid(jid || '')).filter(Boolean)));
  if (!premiumCandidates.length) return false;

  return senderCandidates.some((sender) => premiumCandidates.some((premium) => premium === sender || isSameJidUser(premium, sender)));
};

const sendPremiumOnly = async (sock, remoteJid, messageInfo, expirationMessage, { commandName = 'cat' } = {}) => {
  const messages = resolveAiMessages(commandName);
  await sendAndStore(sock, remoteJid, { text: messages.premiumOnly }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
};

const sendPromptUsage = async (sock, remoteJid, messageInfo, expirationMessage, commandPrefix = DEFAULT_COMMAND_PREFIX) => {
  const usageText =
    getAiUsageText('catprompt', {
      commandPrefix,
      header: '🧠 *Prompt da IA*',
      variant: 'default',
    }) || ['🧠 *Prompt da IA*', '', 'Use assim:', `*${commandPrefix}catprompt* seu novo prompt`, '', 'Para voltar ao padrão:', `*${commandPrefix}catprompt reset*`].join('\n');

  await sendAndStore(sock, remoteJid, { text: usageText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
};

const sendImageUsage = async (sock, remoteJid, messageInfo, expirationMessage, commandPrefix = DEFAULT_COMMAND_PREFIX) => {
  const usageText =
    getAiUsageText('catimg', {
      commandPrefix,
      header: '🖼️ *Imagem IA*',
      variant: 'default',
    }) || ['🖼️ *Imagem IA*', '', 'Use assim:', `*${commandPrefix}catimg* seu prompt`, `*${commandPrefix}catimg* (responda uma imagem com legenda para editar)`, '', 'Opções:', '--size 1024x1024 | 1024x1536 | 1536x1024 | auto', '--quality low | medium | high | auto', '--format png | jpeg | webp', '--background transparent | opaque | auto', '--compression 0-100', '', 'Exemplo:', `*${commandPrefix}catimg* --size 1536x1024 Um gato astronauta em aquarela.`].join('\n');

  await sendAndStore(sock, remoteJid, { text: usageText }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
};

const normalizeImageDetail = (value, detailAliases = IMAGE_DETAIL_ALIASES) => {
  if (!value) return null;
  const normalized = detailAliases.get(normalizeText(value));
  return normalized || null;
};

const normalizeImageGenSize = (value, sizeOptions = IMAGE_GEN_SIZE_OPTIONS, sizeAliases = IMAGE_GEN_SIZE_ALIASES) => {
  if (!value) return null;
  const raw = normalizeText(value);
  if (sizeOptions.has(raw)) return raw;
  const alias = sizeAliases.get(raw);
  if (alias && sizeOptions.has(alias)) return alias;
  return null;
};

const normalizeImageGenQuality = (value, qualityOptions = IMAGE_GEN_QUALITY_OPTIONS, qualityAliases = IMAGE_GEN_QUALITY_ALIASES) => {
  if (!value) return null;
  const raw = normalizeText(value);
  if (qualityOptions.has(raw)) return raw;
  const alias = qualityAliases.get(raw);
  if (alias && qualityOptions.has(alias)) return alias;
  return null;
};

const normalizeImageGenFormat = (value, formatOptions = IMAGE_GEN_FORMAT_OPTIONS, formatAliases = IMAGE_GEN_FORMAT_ALIASES) => {
  if (!value) return null;
  const raw = normalizeText(value);
  const alias = formatAliases.get(raw);
  if (alias && formatOptions.has(alias)) return alias;
  if (formatOptions.has(raw)) return raw;
  return null;
};

const normalizeImageGenBackground = (value, backgroundOptions = IMAGE_GEN_BACKGROUND_OPTIONS, backgroundAliases = IMAGE_GEN_BACKGROUND_ALIASES) => {
  if (!value) return null;
  const raw = normalizeText(value);
  if (backgroundOptions.has(raw)) return raw;
  const alias = backgroundAliases.get(raw);
  if (alias && backgroundOptions.has(alias)) return alias;
  return null;
};

const normalizeImageGenCompression = (value, { min = 0, max = 100 } = {}) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < min || numeric > max) return null;
  return numeric;
};

const parseCatOptions = (rawText = '', optionConfig = {}) => {
  const audioFlags = optionConfig?.audioFlags || AUDIO_FLAG_ALIASES;
  const textFlags = optionConfig?.textFlags || TEXT_FLAG_ALIASES;
  const imageDetailAliases = optionConfig?.imageDetailAliases || IMAGE_DETAIL_ALIASES;

  const tokens = rawText.trim().split(/\s+/).filter(Boolean);
  let wantsAudio = false;
  let imageDetail = null;
  const filtered = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = normalizeText(token);

    if (audioFlags.has(lower)) {
      wantsAudio = true;
      continue;
    }
    if (textFlags.has(lower)) {
      wantsAudio = false;
      continue;
    }

    if (lower.startsWith('--detail=') || lower.startsWith('--detalhe=')) {
      const value = token.split('=')[1];
      const detail = normalizeImageDetail(value, imageDetailAliases);
      if (detail) {
        imageDetail = detail;
        continue;
      }
    }

    if (lower === '--detail' || lower === '--detalhe') {
      const value = tokens[i + 1];
      const detail = normalizeImageDetail(value, imageDetailAliases);
      if (detail) {
        imageDetail = detail;
        i += 1;
        continue;
      }
    }

    filtered.push(token);
  }

  return {
    prompt: filtered.join(' ').trim(),
    wantsAudio,
    imageDetail,
  };
};

const parseImageGenOptions = (rawText = '', optionConfig = {}) => {
  const sizeOptions = optionConfig?.sizeOptions || IMAGE_GEN_SIZE_OPTIONS;
  const sizeAliases = optionConfig?.sizeAliases || IMAGE_GEN_SIZE_ALIASES;
  const qualityOptions = optionConfig?.qualityOptions || IMAGE_GEN_QUALITY_OPTIONS;
  const qualityAliases = optionConfig?.qualityAliases || IMAGE_GEN_QUALITY_ALIASES;
  const formatOptions = optionConfig?.formatOptions || IMAGE_GEN_FORMAT_OPTIONS;
  const formatAliases = optionConfig?.formatAliases || IMAGE_GEN_FORMAT_ALIASES;
  const backgroundOptions = optionConfig?.backgroundOptions || IMAGE_GEN_BACKGROUND_OPTIONS;
  const backgroundAliases = optionConfig?.backgroundAliases || IMAGE_GEN_BACKGROUND_ALIASES;
  const flagAliases = optionConfig?.flagAliases || IMAGE_GEN_FLAG_ALIASES;
  const compression = optionConfig?.compression || { min: 0, max: 100 };

  const tokens = rawText.trim().split(/\s+/).filter(Boolean);
  const promptParts = [];
  const toolOptions = {};
  const errors = [];

  const setOption = (key, rawValue, normalizedValue) => {
    if (!normalizedValue) {
      errors.push(`${key}=${rawValue}`);
      return;
    }
    toolOptions[key] = normalizedValue;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = normalizeText(token);

    if (lower.startsWith('--size=')) {
      const value = token.split('=')[1];
      setOption('size', value, normalizeImageGenSize(value, sizeOptions, sizeAliases));
      continue;
    }
    if (flagAliases.size?.has(lower)) {
      const value = tokens[i + 1];
      if (value) {
        setOption('size', value, normalizeImageGenSize(value, sizeOptions, sizeAliases));
        i += 1;
        continue;
      }
    }

    if (lower.startsWith('--quality=')) {
      const value = token.split('=')[1];
      setOption('quality', value, normalizeImageGenQuality(value, qualityOptions, qualityAliases));
      continue;
    }
    if (flagAliases.quality?.has(lower)) {
      const value = tokens[i + 1];
      if (value) {
        setOption('quality', value, normalizeImageGenQuality(value, qualityOptions, qualityAliases));
        i += 1;
        continue;
      }
    }

    if (lower.startsWith('--format=')) {
      const value = token.split('=')[1];
      setOption('output_format', value, normalizeImageGenFormat(value, formatOptions, formatAliases));
      continue;
    }
    if (flagAliases.format?.has(lower)) {
      const value = tokens[i + 1];
      if (value) {
        setOption('output_format', value, normalizeImageGenFormat(value, formatOptions, formatAliases));
        i += 1;
        continue;
      }
    }

    if (lower.startsWith('--background=')) {
      const value = token.split('=')[1];
      setOption('background', value, normalizeImageGenBackground(value, backgroundOptions, backgroundAliases));
      continue;
    }
    if (flagAliases.background?.has(lower)) {
      const value = tokens[i + 1];
      if (value) {
        setOption('background', value, normalizeImageGenBackground(value, backgroundOptions, backgroundAliases));
        i += 1;
        continue;
      }
    }

    if (lower.startsWith('--compression=')) {
      const value = token.split('=')[1];
      setOption('output_compression', value, normalizeImageGenCompression(value, compression));
      continue;
    }
    if (flagAliases.compression?.has(lower)) {
      const value = tokens[i + 1];
      if (value) {
        setOption('output_compression', value, normalizeImageGenCompression(value, compression));
        i += 1;
        continue;
      }
    }

    if (lower === '--transparent' || lower === '--transparente') {
      toolOptions.background = 'transparent';
      continue;
    }
    if (lower === '--opaque' || lower === '--opaco' || lower === '--opaca') {
      toolOptions.background = 'opaque';
      continue;
    }

    promptParts.push(token);
  }

  if (toolOptions.output_compression !== undefined) {
    const format = toolOptions.output_format;
    if (!format || !['jpeg', 'webp'].includes(format)) {
      errors.push('output_compression');
      delete toolOptions.output_compression;
    }
  }

  return {
    prompt: promptParts.join(' ').trim(),
    toolOptions,
    errors,
  };
};

const buildUserTempDir = (senderJid) => {
  const userId = getJidUser(senderJid) || senderJid || 'anon';
  const sanitizedUserId = String(userId).replace(/[^a-zA-Z0-9.-]/g, '_');
  return path.join(TEMP_DIR, sanitizedUserId);
};

const findImageMedia = (messageInfo) => {
  const mediaEntries = extractAllMediaDetails(messageInfo, {
    includeAllTypes: true,
    includeQuoted: true,
    includeUnknown: false,
  });
  return mediaEntries.find((entry) => entry.mediaType === 'image') || null;
};

const buildImageDataUrl = async (imageMedia, senderJid) => {
  if (!imageMedia) {
    return { dataUrl: null };
  }

  const fileLength = imageMedia.fileLength || imageMedia.mediaKey?.fileLength || 0;
  if (fileLength && fileLength > MAX_IMAGE_BYTES) {
    return { error: 'too_large', fileLength };
  }

  const userDir = buildUserTempDir(senderJid);
  await fs.mkdir(userDir, { recursive: true });

  let downloadedPath = null;
  try {
    downloadedPath = await downloadMediaMessage(imageMedia.mediaKey, 'image', userDir);
    if (!downloadedPath) {
      return { error: 'download_failed' };
    }

    const buffer = await fs.readFile(downloadedPath);
    const base64 = buffer.toString('base64');
    const mimeType = imageMedia.mimetype || imageMedia.mediaKey?.mimetype || 'image/jpeg';
    return { dataUrl: `data:${mimeType};base64,${base64}` };
  } finally {
    if (downloadedPath) {
      fs.unlink(downloadedPath).catch(() => {});
    }
  }
};

export async function handleCatCommand({ sock, remoteJid, messageInfo, expirationMessage, senderJid, text, commandPrefix = DEFAULT_COMMAND_PREFIX }) {
  const commandName = 'cat';
  const commandMessages = resolveAiMessages(commandName);
  const { prompt: rawPrompt, wantsAudio, imageDetail } = parseCatOptions(text || '', resolveCatParseOptions());

  if (!process.env.OPENAI_API_KEY) {
    logger.warn('handleCatCommand: OPENAI_API_KEY não configurada.');
    await sendAndStore(sock, remoteJid, { text: commandMessages.openAiNotConfigured }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  await reactToMessage(sock, remoteJid, messageInfo);

  if (isAiCommandPremiumOnly(commandName)) {
    if (!(await isPremiumAllowed(senderJid))) {
      await sendPremiumOnly(sock, remoteJid, messageInfo, expirationMessage, { commandName });
      return;
    }
  }

  const imageMedia = findImageMedia(messageInfo);
  const imageResult = await buildImageDataUrl(imageMedia, senderJid);
  if (imageResult.error === 'too_large') {
    const limitMb = Math.round((MAX_IMAGE_BYTES / (1024 * 1024)) * 10) / 10;
    await sendAndStore(sock, remoteJid, { text: applyTemplate(commandMessages.imageTooLarge, { limite_mb: limitMb }) }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  if (imageResult.error === 'download_failed') {
    await sendAndStore(sock, remoteJid, { text: commandMessages.imageDownloadFailed }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  const sessionKey = buildSessionKey(remoteJid, senderJid);
  const session = sessionCache.get(sessionKey);
  const userPrompt = await aiPromptStore.getPrompt(senderJid);
  const userPreference = typeof userPrompt === 'string' ? userPrompt.trim() : '';
  const effectiveSystemPrompt = userPreference || BASE_SYSTEM_PROMPT;
  const effectiveImagePrompt = userPreference || DEFAULT_IMAGE_PROMPT;

  const effectivePrompt = rawPrompt || (imageResult.dataUrl ? effectiveImagePrompt : '');
  if (!effectivePrompt && !imageResult.dataUrl) {
    await sendUsage(sock, remoteJid, messageInfo, expirationMessage, commandPrefix);
    return;
  }

  const content = [];
  if (effectivePrompt) {
    content.push({ type: 'input_text', text: effectivePrompt });
  }
  if (imageResult.dataUrl) {
    const imagePayload = { type: 'input_image', image_url: imageResult.dataUrl };
    if (imageDetail) {
      imagePayload.detail = imageDetail;
    }
    content.push(imagePayload);
  }

  const payload = {
    model: OPENAI_MODEL,
    input: [
      {
        role: 'user',
        content,
      },
    ],
  };

  if (effectiveSystemPrompt) {
    payload.instructions = effectiveSystemPrompt;
  }

  if (session?.previousResponseId) {
    payload.previous_response_id = session.previousResponseId;
  }

  try {
    const client = getClient();
    const response = await callOpenAI(() => client.responses.create(payload), 'responses.create', OPENAI_TIMEOUT);
    const outputText = response.output_text?.trim();

    sessionCache.set(sessionKey, {
      previousResponseId: response.id,
      updatedAt: __timeNowMs(),
    });

    if (!outputText) {
      await sendAndStore(sock, remoteJid, { text: commandMessages.emptyResponse }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      return;
    }

    if (wantsAudio) {
      if (outputText.length > TTS_MAX_CHARS) {
        await sendAndStore(sock, remoteJid, { text: commandMessages.longAudioFallback }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      } else {
        try {
          const audioResponse = await callOpenAI(
            () =>
              client.audio.speech.create({
                model: OPENAI_TTS_MODEL,
                voice: OPENAI_TTS_VOICE,
                input: outputText,
                response_format: TTS_OUTPUT_FORMAT,
              }),
            'audio.speech.create',
            OPENAI_TIMEOUT,
          );
          const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
          await sendAndStore(
            sock,
            remoteJid,
            {
              audio: audioBuffer,
              mimetype: TTS_MIME_TYPE,
              ptt: OPENAI_TTS_PTT,
            },
            { quoted: messageInfo, ephemeralExpiration: expirationMessage },
          );
          return;
        } catch (audioError) {
          logger.error('handleCatCommand: erro ao gerar audio.', audioError);
          await sendAndStore(sock, remoteJid, { text: commandMessages.audioFailedFallback }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        }
      }
    }

    await sendAndStore(sock, remoteJid, { text: `🐈‍⬛ ${outputText}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
  } catch (error) {
    logger.error('handleCatCommand: erro ao chamar OpenAI.', error);
    await sendAndStore(
      sock,
      remoteJid,
      {
        text: commandMessages.genericAiError,
      },
      { quoted: messageInfo, ephemeralExpiration: expirationMessage },
    );
  }
}

export async function handleCatImageCommand({ sock, remoteJid, messageInfo, expirationMessage, senderJid, text, commandPrefix = DEFAULT_COMMAND_PREFIX }) {
  const commandName = 'catimg';
  const commandMessages = resolveAiMessages(commandName);
  const { prompt, toolOptions, errors } = parseImageGenOptions(text || '', resolveCatImageGenerationOptions());

  if (!process.env.OPENAI_API_KEY) {
    logger.warn('handleCatImageCommand: OPENAI_API_KEY não configurada.');
    await sendAndStore(sock, remoteJid, { text: commandMessages.openAiNotConfigured }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  await reactToMessage(sock, remoteJid, messageInfo);

  if (isAiCommandPremiumOnly(commandName)) {
    if (!(await isPremiumAllowed(senderJid))) {
      await sendPremiumOnly(sock, remoteJid, messageInfo, expirationMessage, { commandName });
      return;
    }
  }

  const imageMedia = findImageMedia(messageInfo);
  const imageResult = await buildImageDataUrl(imageMedia, senderJid);
  if (imageResult.error === 'too_large') {
    const limitMb = Math.round((MAX_IMAGE_BYTES / (1024 * 1024)) * 10) / 10;
    await sendAndStore(sock, remoteJid, { text: applyTemplate(commandMessages.imageTooLarge, { limite_mb: limitMb }) }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  if (imageResult.error === 'download_failed') {
    await sendAndStore(sock, remoteJid, { text: commandMessages.imageDownloadFailed }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  if (!prompt) {
    await sendImageUsage(sock, remoteJid, messageInfo, expirationMessage, commandPrefix);
    return;
  }

  if (errors.length) {
    await sendAndStore(
      sock,
      remoteJid,
      {
        text: applyTemplate(commandMessages.invalidOptions, {
          detalhes: errors.join(', '),
          prefix: commandPrefix,
        }),
      },
      { quoted: messageInfo, ephemeralExpiration: expirationMessage },
    );
    return;
  }

  const userPrompt = await aiPromptStore.getPrompt(senderJid);
  const userPreference = typeof userPrompt === 'string' ? userPrompt.trim() : '';
  const effectiveSystemPrompt = userPreference || BASE_SYSTEM_PROMPT;

  const content = [];
  content.push({ type: 'input_text', text: prompt });
  if (imageResult.dataUrl) {
    content.push({ type: 'input_image', image_url: imageResult.dataUrl });
  }

  const imageTool = { type: 'image_generation', ...toolOptions };

  const payload = {
    model: OPENAI_IMAGE_MODEL,
    input: [
      {
        role: 'user',
        content,
      },
    ],
    tools: [imageTool],
    tool_choice: { type: 'image_generation' },
  };

  if (effectiveSystemPrompt) {
    payload.instructions = effectiveSystemPrompt;
  }

  const sessionKey = buildSessionKey(remoteJid, senderJid, 'image');
  const session = sessionCache.get(sessionKey);
  if (session?.previousResponseId) {
    payload.previous_response_id = session.previousResponseId;
  }

  try {
    const client = getClient();
    const response = await callOpenAI(() => client.responses.create(payload), 'responses.create.image', OPENAI_IMAGE_TIMEOUT);
    const outputText = response.output_text?.trim();

    sessionCache.set(sessionKey, {
      previousResponseId: response.id,
      updatedAt: __timeNowMs(),
    });

    const imageOutputs = Array.isArray(response.output) ? response.output.filter((output) => output.type === 'image_generation_call' && output.result) : [];
    const imageBase64 = imageOutputs[0]?.result;

    if (!imageBase64) {
      if (outputText) {
        await sendAndStore(sock, remoteJid, { text: `🖼️ ${outputText}` }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
        return;
      }

      await sendAndStore(sock, remoteJid, { text: commandMessages.emptyResponse }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
      return;
    }

    const outputFormat = toolOptions.output_format || 'png';
    const mimeByFormat = {
      png: 'image/png',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
    };
    const mimetype = mimeByFormat[outputFormat] || 'image/png';
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const caption = outputText ? `🖼️ ${outputText}` : '🖼️ Imagem gerada.';

    await sendAndStore(sock, remoteJid, { image: imageBuffer, caption, mimetype }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
  } catch (error) {
    logger.error('handleCatImageCommand: erro ao chamar OpenAI.', error);
    await sendAndStore(
      sock,
      remoteJid,
      {
        text: commandMessages.genericAiError,
      },
      { quoted: messageInfo, ephemeralExpiration: expirationMessage },
    );
  }
}

export async function handleCatPromptCommand({ sock, remoteJid, messageInfo, expirationMessage, senderJid, text, commandPrefix = DEFAULT_COMMAND_PREFIX }) {
  const commandName = 'catprompt';
  const commandMessages = resolveAiMessages(commandName);
  const promptMaxChars = resolveCatPromptMaxChars();
  const promptText = text?.trim();
  if (!promptText) {
    await sendPromptUsage(sock, remoteJid, messageInfo, expirationMessage, commandPrefix);
    return;
  }

  if (isAiCommandPremiumOnly(commandName)) {
    if (!(await isPremiumAllowed(senderJid))) {
      await sendPremiumOnly(sock, remoteJid, messageInfo, expirationMessage, { commandName });
      return;
    }
  }

  const lower = promptText.toLowerCase();
  if (lower === 'reset' || lower === 'default' || lower === 'padrao' || lower === 'padrão') {
    await aiPromptStore.clearPrompt(senderJid);
    await sendAndStore(sock, remoteJid, { text: commandMessages.promptResetSuccess }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  if (promptText.length > promptMaxChars) {
    await sendAndStore(sock, remoteJid, { text: applyTemplate(commandMessages.promptTooLong, { max_chars: promptMaxChars }) }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
    return;
  }

  await aiPromptStore.setPrompt(senderJid, promptText);
  await sendAndStore(sock, remoteJid, { text: commandMessages.promptUpdateSuccess }, { quoted: messageInfo, ephemeralExpiration: expirationMessage });
}
