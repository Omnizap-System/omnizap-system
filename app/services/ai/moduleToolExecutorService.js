import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import logger from '#logger';
import { getToolRecord } from './moduleToolRegistryService.js';
import { mapToolArgsToCommandText } from './commandToolBuilderService.js';
import { saveLearningEvent } from './aiLearningRepository.js';

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const parseEnvInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const MAX_TOOL_ARGS_LOG_LENGTH = parseEnvInt(process.env.GLOBAL_TOOL_EXECUTOR_ARGS_LOG_MAX_LEN, 900, 120, 4_000);

const safeJson = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const truncate = (value, maxLen = MAX_TOOL_ARGS_LOG_LENGTH) => {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 16))}...[truncado]`;
};

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value);
  if (['true', '1', 'sim', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'nao', 'não', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
};

const coerceArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(/[\n,;|]/)
      .flatMap((chunk) => chunk.split(/\s+/))
      .map((token) => token.trim())
      .filter(Boolean);
  }
  if (value === undefined || value === null) return [];
  return [value];
};

const coerceValueByType = (value, spec) => {
  const type = String(spec?.type || 'string')
    .trim()
    .toLowerCase();
  if (value === undefined || value === null) return value;

  if (type === 'array') {
    return coerceArray(value);
  }

  if (type === 'integer') {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  if (type === 'number') {
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  if (type === 'boolean') {
    const parsed = parseBoolean(value);
    return parsed === null ? value : parsed;
  }

  if (type === 'object') {
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
      return JSON.parse(String(value));
    } catch {
      return value;
    }
  }

  return String(value);
};

const isMissingRequired = (value, type) => {
  if (value === undefined || value === null) return true;
  if (type === 'boolean') return false;
  if (type === 'array') return !Array.isArray(value) || value.length === 0;
  return String(value).trim() === '';
};

const validateAndNormalizeArgs = ({ record, inputArgs }) => {
  const safeInput = inputArgs && typeof inputArgs === 'object' ? inputArgs : {};
  const errors = [];
  const normalized = {};

  for (const spec of record.argumentSpecs) {
    let value = safeInput[spec.key];

    if ((value === undefined || value === null || value === '') && spec.defaultValue !== undefined) {
      value = spec.defaultValue;
    }

    if (spec.required && isMissingRequired(value, spec.type)) {
      errors.push(`argumento obrigatorio ausente: ${spec.key}`);
      continue;
    }

    if (value === undefined || value === null || value === '') continue;

    const coerced = coerceValueByType(value, spec);
    if (spec.type === 'integer' || spec.type === 'number') {
      if (!Number.isFinite(coerced)) {
        errors.push(`argumento invalido para ${spec.key}: esperado ${spec.type}`);
        continue;
      }
    }

    if (spec.type === 'array') {
      if (!Array.isArray(coerced) || coerced.length === 0) {
        if (spec.required) {
          errors.push(`argumento invalido para ${spec.key}: esperado lista nao vazia`);
        }
        continue;
      }
    }

    if (spec.type === 'boolean') {
      if (typeof coerced !== 'boolean') {
        errors.push(`argumento invalido para ${spec.key}: esperado boolean`);
        continue;
      }
    }

    normalized[spec.key] = coerced;
  }

  return {
    ok: errors.length === 0,
    normalizedArgs: normalized,
    errors,
  };
};

const resolveLearningConfidence = ({ context, toolName }) => {
  const direct = Number(context?.topMatchScore);
  if (Number.isFinite(direct)) {
    return Math.max(0, Math.min(1, direct));
  }

  const candidates = Array.isArray(context?.toolSelectionCandidates) ? context.toolSelectionCandidates : [];
  const found = candidates.find((candidate) => normalizeText(candidate?.toolName) === normalizeText(toolName) || normalizeText(candidate?.commandName) === normalizeText(toolName));
  const score = Number(found?.score);
  if (Number.isFinite(score)) return Math.max(0, Math.min(1, score));
  return null;
};

const resolveLearningQuestion = (context = {}) => String(context?.userQuestion || context?.question || context?.rawQuestion || context?.originalQuestion || '').trim();

const persistLearningEventSafe = async ({ context, toolSuggested, toolExecuted, success, confidence }) => {
  const question = resolveLearningQuestion(context);
  if (!question) return;

  try {
    await saveLearningEvent({
      question,
      toolSuggested,
      toolExecuted,
      success,
      confidence,
    });
  } catch (error) {
    logger.warn('Falha ao salvar evento de aprendizado de tool.', {
      action: 'ai_learning_event_save_failed',
      toolSuggested,
      toolExecuted,
      success: Boolean(success),
      error: error?.message,
    });
  }
};

const normalizePermissionText = (value) => String(value || 'nao definido').trim();

const normalizeWhereLabel = (local = []) => {
  const list = Array.isArray(local) ? local.map((item) => normalizeText(item)).filter(Boolean) : [];
  return list;
};

const buildPermissionErrorText = ({ record, reason }) => {
  const command = record.commandName;
  const permission = normalizePermissionText(record.commandEntry?.permissao_necessaria);
  const where = normalizeWhereLabel(record.commandEntry?.local_de_uso).join(', ') || 'nao definido';

  const details = [`Nao posso executar automaticamente *${command}* neste contexto.`, `Motivo: ${reason}.`, `Permissao necessaria: ${permission}.`, `Local permitido: ${where}.`];

  return details.join('\n');
};

const resolveSecurityContext = async (context = {}) => {
  const resolver = typeof context.resolveToolSecurityContext === 'function' ? context.resolveToolSecurityContext : null;

  if (!resolver) {
    return {
      isGroupMessage: Boolean(context.isGroupMessage),
      isSenderAdmin: context.isSenderAdmin,
      isSenderOwner: context.isSenderOwner,
      hasGoogleLogin: context.hasGoogleLogin,
    };
  }

  try {
    const resolved = await resolver();
    return {
      isGroupMessage: Boolean(resolved?.isGroupMessage ?? context.isGroupMessage),
      isSenderAdmin: resolved?.isSenderAdmin,
      isSenderOwner: resolved?.isSenderOwner,
      hasGoogleLogin: resolved?.hasGoogleLogin,
    };
  } catch (error) {
    logger.warn('Falha ao resolver contexto de seguranca para tool execution.', {
      action: 'tool_security_context_failed',
      error: error?.message,
    });

    return {
      isGroupMessage: Boolean(context.isGroupMessage),
      isSenderAdmin: context.isSenderAdmin,
      isSenderOwner: context.isSenderOwner,
      hasGoogleLogin: context.hasGoogleLogin,
    };
  }
};

const validateSecurityPreconditions = ({ record, securityContext }) => {
  const commandEntry = record.commandEntry || {};
  const pre = commandEntry.pre_condicoes && typeof commandEntry.pre_condicoes === 'object' ? commandEntry.pre_condicoes : {};
  const isGroupMessage = Boolean(securityContext?.isGroupMessage);

  const localList = normalizeWhereLabel(commandEntry.local_de_uso);
  if (localList.length) {
    if (isGroupMessage && !localList.includes('grupo')) {
      return {
        ok: false,
        reason: 'comando disponivel apenas no privado',
      };
    }
    if (!isGroupMessage && !localList.includes('privado')) {
      return {
        ok: false,
        reason: 'comando disponivel apenas em grupo',
      };
    }
  }

  if (pre.requer_grupo && !isGroupMessage) {
    return {
      ok: false,
      reason: 'este comando exige execucao em grupo',
    };
  }

  if (pre.requer_admin && securityContext?.isSenderAdmin !== true) {
    return {
      ok: false,
      reason: 'este comando exige permissao de admin do grupo',
    };
  }

  if (pre.requer_admin_principal && securityContext?.isSenderOwner !== true) {
    return {
      ok: false,
      reason: 'este comando exige admin principal do bot',
    };
  }

  if (pre.requer_google_login && securityContext?.hasGoogleLogin === false) {
    return {
      ok: false,
      reason: 'este comando exige login Google ativo',
    };
  }

  return { ok: true };
};

export const executeTool = async (toolName, toolArgs, context = {}) => {
  const normalizedToolName = normalizeText(toolName);
  if (!normalizedToolName) {
    return {
      ok: false,
      handled: false,
      status: 'invalid_tool_name',
      text: 'Tool invalida.',
    };
  }

  const record = getToolRecord(normalizedToolName);
  if (!record) {
    return {
      ok: false,
      handled: false,
      status: 'tool_not_found',
      text: 'Nao encontrei esta tool no registro global.',
    };
  }

  if (record.commandEntry?.enabled === false) {
    return {
      ok: false,
      handled: true,
      status: 'tool_disabled',
      moduleKey: record.moduleKey,
      commandName: record.commandName,
      text: `O comando ${record.commandName} esta desativado no momento.`,
    };
  }

  const argsValidation = validateAndNormalizeArgs({
    record,
    inputArgs: toolArgs,
  });

  if (!argsValidation.ok) {
    await persistLearningEventSafe({
      context,
      toolSuggested: normalizedToolName,
      toolExecuted: record.toolName,
      success: false,
      confidence: resolveLearningConfidence({ context, toolName: record.toolName }),
    });

    return {
      ok: false,
      handled: true,
      status: 'invalid_arguments',
      moduleKey: record.moduleKey,
      commandName: record.commandName,
      text: [`Nao consegui executar *${record.commandName}* por argumentos invalidos.`, ...argsValidation.errors.map((error) => `- ${error}`)].join('\n'),
    };
  }

  const securityContext = await resolveSecurityContext(context);
  const securityValidation = validateSecurityPreconditions({
    record,
    securityContext,
  });

  if (!securityValidation.ok) {
    await persistLearningEventSafe({
      context,
      toolSuggested: normalizedToolName,
      toolExecuted: record.toolName,
      success: false,
      confidence: resolveLearningConfidence({ context, toolName: record.toolName }),
    });

    return {
      ok: false,
      handled: true,
      status: 'security_precondition_failed',
      moduleKey: record.moduleKey,
      commandName: record.commandName,
      text: buildPermissionErrorText({
        record,
        reason: securityValidation.reason,
      }),
    };
  }

  const executeCommand = typeof context.executeCommand === 'function' ? context.executeCommand : null;

  if (!executeCommand) {
    return {
      ok: false,
      handled: false,
      status: 'missing_execute_command',
      moduleKey: record.moduleKey,
      commandName: record.commandName,
      text: 'Executor de comando indisponivel para tool call.',
    };
  }

  const mapped = mapToolArgsToCommandText(record.argumentSpecs, argsValidation.normalizedArgs);
  const startedAt = __timeNowMs();

  let executionResult = null;
  try {
    executionResult = await executeCommand({
      commandName: record.commandName,
      args: mapped.args,
      text: mapped.text,
      normalizedToolArgs: argsValidation.normalizedArgs,
      toolName: record.toolName,
      moduleKey: record.moduleKey,
    });
  } catch (error) {
    executionResult = {
      ok: false,
      error,
      alreadyResponded: false,
      text: '',
    };
  }

  const executionTimeMs = __timeNowMs() - startedAt;
  logger.info('Execucao de tool AI concluida.', {
    action: 'ai_tool_execution',
    tool_used: record.toolName,
    command_name: record.commandName,
    module_key: record.moduleKey,
    tool_arguments: truncate(safeJson(argsValidation.normalizedArgs)),
    execution_time_ms: executionTimeMs,
    ok: Boolean(executionResult?.ok),
  });

  if (!executionResult?.ok) {
    await persistLearningEventSafe({
      context,
      toolSuggested: normalizedToolName,
      toolExecuted: record.toolName,
      success: false,
      confidence: resolveLearningConfidence({ context, toolName: record.toolName }),
    });

    return {
      ok: false,
      handled: true,
      status: 'command_execution_failed',
      moduleKey: record.moduleKey,
      commandName: record.commandName,
      toolName: record.toolName,
      executionTimeMs,
      suppressReply: executionResult?.alreadyResponded === true,
      text: executionResult?.alreadyResponded === true ? '' : String(executionResult?.text || '').trim() || `Nao consegui executar ${record.commandName}. Tente o comando manualmente.`,
    };
  }

  await persistLearningEventSafe({
    context,
    toolSuggested: normalizedToolName,
    toolExecuted: record.toolName,
    success: true,
    confidence: resolveLearningConfidence({ context, toolName: record.toolName }),
  });

  return {
    ok: true,
    handled: true,
    status: 'executed',
    moduleKey: record.moduleKey,
    commandName: record.commandName,
    toolName: record.toolName,
    executionTimeMs,
    suppressReply: executionResult?.alreadyResponded !== false,
    text: String(executionResult?.text || '').trim(),
  };
};
