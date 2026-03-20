import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createModuleCommandConfigRuntime } from '../../services/ai/moduleCommandConfigRuntimeService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'commandConfig.json');
const CONFIG_SNAPSHOT_TTL_MS = Math.max(1000, Number.parseInt(process.env.PLAY_CONFIG_SNAPSHOT_TTL_MS || '15000', 10) || 15000);

const DEFAULT_TEXTS = {
  usage_header: '',
  error_prefix: '❌ Erro: ',
  generic_error: 'Erro inesperado ao processar sua solicitação.',
  user_error_timeout: 'A operação demorou mais que o esperado. Tente novamente.',
  user_error_technical_generic: 'Não foi possível processar sua solicitação agora. Tente novamente em instantes.',
  admin_error_title: 'Erro no módulo play (diagnóstico).',
  wait_audio: '⏳ Processando sua mídia...',
  wait_video: '⏳ Processando sua mídia...',
  ready_title_audio: '🎵 Áudio pronto!',
  ready_title_video: '🎬 Vídeo pronto!',
  video_fallback_to_audio: '⚠️ Este link retornou somente áudio. Enviando no formato de áudio.',
  anti_bot_with_cookies: 'YouTube solicitou verificação anti-bot. Atualize o arquivo .secrets/cookies.txt e tente novamente.',
  anti_bot_with_browser_profile: 'YouTube solicitou verificação anti-bot no provedor de mídia. Verifique suas credenciais e tente novamente.',
  anti_bot_without_cookies: 'YouTube solicitou verificação anti-bot no provedor de mídia. Tente novamente em alguns minutos.',
  usage_fallback_audio: '🎵 Uso: <prefix>play <link do YouTube ou termo de busca>',
  usage_fallback_video: '🎬 Uso: <prefix>playvid <link do YouTube ou termo de busca>',
  invalid_media_type: 'Tipo de mídia inválido.',
  binary_exec_failed: 'Falha ao executar <command>.',
  provider_error_generic: 'Falha ao processar mídia no provedor.',
  provider_timeout_generic: 'Timeout ao processar mídia no provedor.',
  search_invalid_input: 'Você precisa informar um link do YouTube ou termo de busca.',
  search_not_found: 'Nenhum resultado encontrado para a busca.',
  search_timeout: 'Timeout ao buscar metadados do vídeo.',
  search_failed: 'Não foi possível buscar o vídeo agora.',
  video_unavailable: 'Não foi possível acessar este vídeo agora. Tente outro link.',
  ffmpeg_not_found: 'ffmpeg não encontrado no servidor para processar esta mídia.',
  download_timeout: 'Timeout ao baixar o arquivo.',
  download_failed: 'Falha ao baixar o arquivo localmente.',
  download_file_not_found: 'Não foi possível localizar o arquivo baixado.',
  download_invalid_media: 'Falha ao baixar mídia válida.',
  media_too_big: 'O arquivo excede o limite permitido de <max_mb> MB.',
  probe_timeout: 'Timeout ao analisar o vídeo recebido.',
  probe_failed: 'Falha ao validar o vídeo recebido.',
  transcode_timeout: 'Timeout ao normalizar o vídeo para envio.',
  transcode_failed: 'Falha ao converter o vídeo para um formato compatível.',
  transcode_output_invalid: 'Falha ao gerar vídeo compatível para envio.',
  video_without_streams: 'Não foi possível enviar como vídeo: a mídia não possui faixa de vídeo nem áudio.',
  thumbnail_timeout: 'Timeout ao baixar a thumbnail.',
  thumbnail_failed: 'Falha ao baixar a thumbnail.',
  thumbnail_too_big: 'Thumbnail excede o limite permitido.',
  http_timeout: 'Timeout na requisição HTTP.',
  http_failed: 'Falha na requisição HTTP.',
  content_too_big: 'Conteúdo excede o limite permitido.',
};

const DEFAULT_OPERATIONAL_LIMITS = {
  max_search_results: 5,
  search_cache_ttl_ms: 60000,
  max_search_cache_entries: 500,
  max_redirects: 2,
  max_concurrent_jobs: 2,
  max_error_body_bytes: 65536,
  max_meta_body_chars: 512,
  retry_backoff_base_ms: 200,
  search_retry_count: 1,
  thumbnail_retry_count: 1,
  thumbnail_timeout_ms: 15000,
  max_thumb_bytes: 5 * 1024 * 1024,
  admin_alert_dedupe_window_ms: 120000,
  ytmp3_poll_interval_ms: 2000,
};

const DEFAULT_EXECUTION_OPTIONS = {
  estrategias_formato: {
    audio: ['bestaudio/best', 'best'],
    video: ['bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best', 'bestvideo*+bestaudio/best', 'best'],
    audio_extract: {
      enabled: true,
      format: 'mp3',
      quality: '0',
    },
    video_merge_output_format: 'mp4',
  },
};

const runtime = createModuleCommandConfigRuntime({
  configPath: CONFIG_PATH,
  fallbackConfig: {
    module: 'playModule',
    commands: [],
    textos: DEFAULT_TEXTS,
    limites_operacionais: DEFAULT_OPERATIONAL_LIMITS,
    opcoes_execucao: DEFAULT_EXECUTION_OPTIONS,
  },
});

let cachedModuleConfig = null;
let cachedSnapshotExpiresAt = 0;
let cachedCommandRegistry = null;

const renderUsageMethod = (method, commandPrefix) => String(method || '').replaceAll('<prefix>', String(commandPrefix || '/'));
const renderTemplate = (value, variables = {}) => {
  let text = String(value || '');
  for (const [key, variableValue] of Object.entries(variables || {})) {
    text = text.replaceAll(`<${key}>`, String(variableValue ?? ''));
  }
  return text;
};

const normalizeCommandToken = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const toInt = (value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) => {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  if (number < min) return fallback;
  if (number > max) return fallback;
  return number;
};

const normalizeStringArray = (value, fallback = []) => {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value.map((item) => String(item || '').trim()).filter(Boolean);
  return normalized.length ? normalized : [...fallback];
};

const normalizeExecutionOptions = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaultFormat = DEFAULT_EXECUTION_OPTIONS.estrategias_formato;
  const rawFormat = source.estrategias_formato && typeof source.estrategias_formato === 'object' ? source.estrategias_formato : {};
  const rawAudioExtract = rawFormat.audio_extract && typeof rawFormat.audio_extract === 'object' ? rawFormat.audio_extract : {};

  return {
    estrategias_formato: {
      audio: normalizeStringArray(rawFormat.audio, defaultFormat.audio),
      video: normalizeStringArray(rawFormat.video, defaultFormat.video),
      audio_extract: {
        enabled: rawAudioExtract.enabled === undefined ? Boolean(defaultFormat.audio_extract.enabled) : Boolean(rawAudioExtract.enabled),
        format: String(rawAudioExtract.format || defaultFormat.audio_extract.format || '').trim() || defaultFormat.audio_extract.format,
        quality: String(rawAudioExtract.quality || defaultFormat.audio_extract.quality || '').trim() || defaultFormat.audio_extract.quality,
      },
      video_merge_output_format: String(rawFormat.video_merge_output_format || defaultFormat.video_merge_output_format || '').trim() || defaultFormat.video_merge_output_format,
    },
  };
};

const getPlayModuleConfigSnapshot = () => {
  const now = __timeNowMs();
  if (cachedModuleConfig && now < cachedSnapshotExpiresAt) {
    return cachedModuleConfig;
  }

  cachedModuleConfig = runtime.getModuleConfig();
  cachedSnapshotExpiresAt = now + CONFIG_SNAPSHOT_TTL_MS;
  cachedCommandRegistry = null;
  return cachedModuleConfig;
};

const buildCommandRegistry = () => {
  if (cachedCommandRegistry) return cachedCommandRegistry;

  const config = getPlayModuleConfigSnapshot();
  const entries = Array.isArray(config?.commands) ? config.commands : [];
  const aliasToCanonical = new Map();
  const commandEntryByCanonical = new Map();

  for (const entry of entries) {
    if (!entry || entry.enabled === false) continue;

    const canonical = normalizeCommandToken(entry.name);
    if (!canonical) continue;

    commandEntryByCanonical.set(canonical, entry);
    aliasToCanonical.set(canonical, canonical);

    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    for (const alias of aliases) {
      const normalizedAlias = normalizeCommandToken(alias);
      if (!normalizedAlias) continue;
      aliasToCanonical.set(normalizedAlias, canonical);
    }
  }

  cachedCommandRegistry = {
    aliasToCanonical,
    commandEntryByCanonical,
  };
  return cachedCommandRegistry;
};

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

export const getPlayModuleConfig = () => getPlayModuleConfigSnapshot();

export const resolvePlayCommandName = (command) => {
  const normalized = normalizeCommandToken(command);
  if (!normalized) return null;
  const { aliasToCanonical } = buildCommandRegistry();
  return aliasToCanonical.get(normalized) || null;
};

export const getPlayCommandEntry = (command) => {
  const canonical = resolvePlayCommandName(command);
  if (!canonical) return null;
  const { commandEntryByCanonical } = buildCommandRegistry();
  return commandEntryByCanonical.get(canonical) || null;
};

export const listEnabledPlayCommands = () => {
  const { commandEntryByCanonical } = buildCommandRegistry();
  return [...commandEntryByCanonical.values()];
};

export const getPlayTextConfig = () => {
  const config = getPlayModuleConfig();
  const raw = config?.textos && typeof config.textos === 'object' ? config.textos : {};
  return {
    ...DEFAULT_TEXTS,
    ...raw,
  };
};

export const getPlayOperationalLimits = () => {
  const config = getPlayModuleConfig();
  const raw = config?.limites_operacionais && typeof config.limites_operacionais === 'object' ? config.limites_operacionais : {};
  return {
    max_search_results: toInt(raw.max_search_results, DEFAULT_OPERATIONAL_LIMITS.max_search_results, { min: 1, max: 10 }),
    search_cache_ttl_ms: toInt(raw.search_cache_ttl_ms, DEFAULT_OPERATIONAL_LIMITS.search_cache_ttl_ms, { min: 1 }),
    max_search_cache_entries: toInt(raw.max_search_cache_entries, DEFAULT_OPERATIONAL_LIMITS.max_search_cache_entries, { min: 1 }),
    max_redirects: toInt(raw.max_redirects, DEFAULT_OPERATIONAL_LIMITS.max_redirects, { min: 0, max: 10 }),
    max_concurrent_jobs: toInt(raw.max_concurrent_jobs, DEFAULT_OPERATIONAL_LIMITS.max_concurrent_jobs, { min: 1, max: 32 }),
    max_error_body_bytes: toInt(raw.max_error_body_bytes, DEFAULT_OPERATIONAL_LIMITS.max_error_body_bytes, { min: 1024 }),
    max_meta_body_chars: toInt(raw.max_meta_body_chars, DEFAULT_OPERATIONAL_LIMITS.max_meta_body_chars, { min: 64 }),
    retry_backoff_base_ms: toInt(raw.retry_backoff_base_ms, DEFAULT_OPERATIONAL_LIMITS.retry_backoff_base_ms, { min: 1 }),
    search_retry_count: toInt(raw.search_retry_count, DEFAULT_OPERATIONAL_LIMITS.search_retry_count, { min: 0, max: 5 }),
    thumbnail_retry_count: toInt(raw.thumbnail_retry_count, DEFAULT_OPERATIONAL_LIMITS.thumbnail_retry_count, { min: 0, max: 5 }),
    thumbnail_timeout_ms: toInt(raw.thumbnail_timeout_ms, DEFAULT_OPERATIONAL_LIMITS.thumbnail_timeout_ms, { min: 1000 }),
    max_thumb_bytes: toInt(raw.max_thumb_bytes, DEFAULT_OPERATIONAL_LIMITS.max_thumb_bytes, { min: 1024 }),
    admin_alert_dedupe_window_ms: toInt(raw.admin_alert_dedupe_window_ms, DEFAULT_OPERATIONAL_LIMITS.admin_alert_dedupe_window_ms, { min: 0 }),
  };
};

export const getPlayExecutionOptions = () => {
  const config = getPlayModuleConfig();
  const raw = config?.opcoes_execucao && typeof config.opcoes_execucao === 'object' ? config.opcoes_execucao : {};
  return normalizeExecutionOptions(raw);
};

export const getPlayText = (key, fallback = '') => {
  const textConfig = getPlayTextConfig();
  if (typeof key !== 'string' || !key.trim()) return fallback;
  const value = textConfig[key];
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value;
};

export const getPlayWaitText = (type) => {
  const normalizedType = String(type || '').toLowerCase();
  const key = normalizedType === 'video' ? 'wait_video' : 'wait_audio';
  const fallback = normalizedType === 'video' ? DEFAULT_TEXTS.wait_video : DEFAULT_TEXTS.wait_audio;
  return getPlayText(key, fallback);
};

export const getPlayReadyTitle = (type) => {
  const normalizedType = String(type || '').toLowerCase();
  const key = normalizedType === 'video' ? 'ready_title_video' : 'ready_title_audio';
  const fallback = normalizedType === 'video' ? DEFAULT_TEXTS.ready_title_video : DEFAULT_TEXTS.ready_title_audio;
  return getPlayText(key, fallback);
};

export const getPlayUsageFallbackText = (type, commandPrefix = '/') => {
  const normalizedType = String(type || '').toLowerCase();
  const key = normalizedType === 'video' ? 'usage_fallback_video' : 'usage_fallback_audio';
  const fallback = normalizedType === 'video' ? DEFAULT_TEXTS.usage_fallback_video : DEFAULT_TEXTS.usage_fallback_audio;
  const template = getPlayText(key, fallback);
  return renderTemplate(template, { prefix: commandPrefix });
};

export const getPlayUsageText = (command, { commandPrefix = '/', header, variant } = {}) => {
  const entry = getPlayCommandEntry(command);
  const methods = resolveUsageLines(entry, variant);
  if (!methods.length) return '';

  const prefixHeader = typeof header === 'string' ? header : getPlayTextConfig().usage_header || DEFAULT_TEXTS.usage_header;
  const lines = methods.map((method) => renderUsageMethod(method, commandPrefix));
  return prefixHeader ? [prefixHeader, ...lines].join('\n') : lines.join('\n');
};
