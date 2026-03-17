import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_GEMINI_AUTH_MODE = 'auto';
const DEFAULT_GEMINI_CLI_COMMAND = 'gemini';

const execFileAsync = promisify(execFile);
const cliAvailabilityCache = new Map();

const normalizeModelName = (value, fallback = DEFAULT_GEMINI_MODEL) => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
};

const toPositiveInt = (value, fallback, min = 1) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
};

const normalizeAuthMode = (value, fallback = DEFAULT_GEMINI_AUTH_MODE) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'api_key') return 'api_key';
  if (normalized === 'cli') return 'cli';
  if (normalized === 'auto') return 'auto';
  return fallback;
};

const normalizeCliCommand = (value) => {
  const command = String(value || DEFAULT_GEMINI_CLI_COMMAND).trim();
  return command || DEFAULT_GEMINI_CLI_COMMAND;
};

const parseBooleanEnv = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'sim', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(normalized)) return false;
  return fallback;
};

const isGeminiCliAvailable = (cliCommand = DEFAULT_GEMINI_CLI_COMMAND) => {
  const safeCliCommand = normalizeCliCommand(cliCommand);
  if (cliAvailabilityCache.has(safeCliCommand)) {
    return cliAvailabilityCache.get(safeCliCommand);
  }

  let available = false;
  try {
    const result = spawnSync(safeCliCommand, ['--version'], {
      stdio: 'ignore',
      shell: false,
    });
    available = result?.status === 0;
  } catch {
    available = false;
  }

  cliAvailabilityCache.set(safeCliCommand, available);
  return available;
};

const sanitizeCliOutput = (value) =>
  String(value || '')
    .replaceAll('\0', '')
    .replace(/\r\n/g, '\n')
    .trim();

const buildCliPrompt = ({ instructions = '', userPrompt = '' } = {}) => {
  const safePrompt = normalizeOutboundText(userPrompt);
  const safeInstructions = normalizeOutboundText(instructions);
  if (!safeInstructions) return safePrompt;
  if (!safePrompt) return safeInstructions;
  return `${safeInstructions}\n\n---\n\n${safePrompt}`;
};

const parseErrorMessage = (payload, status) => {
  const explicit = String(payload?.error?.message || '').trim();
  if (explicit) return explicit;
  return `Gemini API retornou status ${status}.`;
};

const extractTextFromCandidate = (candidate) => {
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const chunks = [];
  for (const part of parts) {
    const text = String(part?.text || '').trim();
    if (text) chunks.push(text);
  }
  return chunks.join('\n').trim();
};

const normalizeOutboundText = (value) =>
  String(value || '')
    .split('\0')
    .join('')
    .trim();

export const isGeminiAuthReady = ({ authMode = process.env.GEMINI_AUTH_MODE || DEFAULT_GEMINI_AUTH_MODE, apiKey = process.env.GEMINI_API_KEY, cliCommand = process.env.GEMINI_CLI_COMMAND || DEFAULT_GEMINI_CLI_COMMAND } = {}) => {
  const mode = normalizeAuthMode(authMode, DEFAULT_GEMINI_AUTH_MODE);
  const safeApiKey = String(apiKey || '').trim();
  const useCliByEnv = parseBooleanEnv(process.env.GEMINI_USE_CLI_AUTH, false);
  const modeWithLegacy = mode === 'auto' && useCliByEnv ? 'cli' : mode;

  if (modeWithLegacy === 'api_key') return Boolean(safeApiKey);
  if (modeWithLegacy === 'cli') return isGeminiCliAvailable(cliCommand);
  if (safeApiKey) return true;
  return isGeminiCliAvailable(cliCommand);
};

export const createGeminiTextService = ({ apiKey = process.env.GEMINI_API_KEY, defaultModel = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, timeoutMs = 25_000, apiBaseUrl = process.env.GEMINI_API_BASE_URL || DEFAULT_GEMINI_API_BASE_URL, authMode = process.env.GEMINI_AUTH_MODE || DEFAULT_GEMINI_AUTH_MODE, cliCommand = process.env.GEMINI_CLI_COMMAND || DEFAULT_GEMINI_CLI_COMMAND, execFileAsyncImpl = execFileAsync, isCliAvailableImpl = isGeminiCliAvailable } = {}) => {
  const safeApiKey = String(apiKey || '').trim();
  const safeAuthMode = normalizeAuthMode(authMode, DEFAULT_GEMINI_AUTH_MODE);
  const useCliByEnv = parseBooleanEnv(process.env.GEMINI_USE_CLI_AUTH, false);
  const normalizedAuthMode = safeAuthMode === 'auto' && useCliByEnv ? 'cli' : safeAuthMode;
  const selectedTransport = normalizedAuthMode === 'api_key' ? 'api_key' : normalizedAuthMode === 'cli' ? 'cli' : safeApiKey ? 'api_key' : 'cli';
  const safeCliCommand = normalizeCliCommand(cliCommand);
  const safeBaseUrl =
    String(apiBaseUrl || DEFAULT_GEMINI_API_BASE_URL)
      .trim()
      .replace(/\/+$/, '') || DEFAULT_GEMINI_API_BASE_URL;
  const safeTimeoutMs = Math.max(1_000, toPositiveInt(timeoutMs, 25_000, 1_000));
  const resolvedDefaultModel = normalizeModelName(defaultModel, DEFAULT_GEMINI_MODEL);

  if (selectedTransport === 'api_key') {
    if (!safeApiKey) return null;
    if (typeof globalThis.fetch !== 'function') {
      throw new Error('createGeminiTextService: global fetch indisponivel no runtime atual.');
    }
  } else if (!isCliAvailableImpl(safeCliCommand)) {
    return null;
  }

  const generateTextViaApiKey = async ({ instructions = '', userPrompt = '', model = resolvedDefaultModel } = {}) => {
    const safePrompt = normalizeOutboundText(userPrompt);
    if (!safePrompt) return { text: '', model: normalizeModelName(model, resolvedDefaultModel) };

    const modelName = normalizeModelName(model, resolvedDefaultModel);
    const encodedModelName = encodeURIComponent(modelName);
    const endpoint = `${safeBaseUrl}/models/${encodedModelName}:generateContent?key=${encodeURIComponent(safeApiKey)}`;
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: safePrompt }],
        },
      ],
    };

    const safeInstructions = normalizeOutboundText(instructions);
    if (safeInstructions) {
      payload.systemInstruction = {
        role: 'system',
        parts: [{ text: safeInstructions }],
      };
    }

    const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
    const timeoutHandle = controller
      ? setTimeout(() => {
          controller.abort(new Error(`Gemini generateContent excedeu ${safeTimeoutMs}ms`));
        }, safeTimeoutMs)
      : null;

    try {
      // lgtm[js/file-access-to-http]
      const response = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // lgtm[js/file-access-to-http]
        body: JSON.stringify(payload),
        signal: controller?.signal,
      });

      const responsePayload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseErrorMessage(responsePayload, response.status));
      }

      const candidates = Array.isArray(responsePayload?.candidates) ? responsePayload.candidates : [];
      const text = candidates.map((candidate) => extractTextFromCandidate(candidate)).find(Boolean) || '';
      return {
        text,
        model: modelName,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  const generateTextViaCli = async ({ instructions = '', userPrompt = '', model = resolvedDefaultModel } = {}) => {
    const prompt = buildCliPrompt({ instructions, userPrompt });
    const modelName = normalizeModelName(model, resolvedDefaultModel);
    if (!prompt) return { text: '', model: modelName };

    const args = ['-m', modelName, '-p', prompt, '--output-format', 'text'];
    try {
      const result = await execFileAsyncImpl(safeCliCommand, args, {
        timeout: safeTimeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      });
      const text = sanitizeCliOutput(result?.stdout);
      if (!text) {
        const stderrText = sanitizeCliOutput(result?.stderr);
        throw new Error(stderrText || 'Gemini CLI retornou resposta vazia.');
      }
      return {
        text,
        model: modelName,
      };
    } catch (error) {
      const stderrText = sanitizeCliOutput(error?.stderr);
      const stdoutText = sanitizeCliOutput(error?.stdout);
      const baseMessage = String(error?.message || '').trim();
      const finalMessage = stderrText || stdoutText || baseMessage || 'Falha ao executar Gemini CLI.';
      throw new Error(finalMessage);
    }
  };

  const generateText = async ({ instructions = '', userPrompt = '', model = resolvedDefaultModel } = {}) => {
    if (selectedTransport === 'api_key') {
      return generateTextViaApiKey({ instructions, userPrompt, model });
    }
    return generateTextViaCli({ instructions, userPrompt, model });
  };

  return {
    defaultModel: resolvedDefaultModel,
    transport: selectedTransport,
    generateText,
  };
};
