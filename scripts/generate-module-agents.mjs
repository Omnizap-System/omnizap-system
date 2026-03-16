#!/usr/bin/env node
import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const modulesRoot = path.join(repoRoot, 'app', 'modules');
const nowIso = __timeNowIso();

const normalizeBoolLabel = (value) => (value ? 'sim' : 'nao');

const ensureArray = (value) => (Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null && item !== '') : []);
const ensureObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const hasOwn = (target, key) => Object.prototype.hasOwnProperty.call(target || {}, key);
const hasEntries = (value) => Object.keys(ensureObject(value)).length > 0;

const normalizeText = (value, fallback = '(nao informado)') => {
  const raw = String(value || '').trim();
  return raw || fallback;
};

const normalizeToken = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const getArgValue = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const next = process.argv[index + 1];
  if (!next || next.startsWith('--')) return null;
  return next;
};

const deepMerge = (left, right) => {
  const base = ensureObject(left);
  const override = ensureObject(right);
  const output = { ...base };
  for (const key of Object.keys(override)) {
    const leftValue = base[key];
    const rightValue = override[key];
    if (Array.isArray(rightValue)) {
      output[key] = rightValue.slice();
      continue;
    }
    if (rightValue && typeof rightValue === 'object') {
      output[key] = deepMerge(leftValue, rightValue);
      continue;
    }
    output[key] = rightValue;
  }
  return output;
};

const pickFirst = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const pickFirstBoolean = (...values) => {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return false;
};

const unique = (items = []) => {
  const out = [];
  for (const item of ensureArray(items)) {
    const raw = String(item).trim();
    if (!raw || out.includes(raw)) continue;
    out.push(raw);
  }
  return out;
};

const printList = (items, emptyText = '(nenhum)') => {
  const safeItems = ensureArray(items);
  if (!safeItems.length) return [`- ${emptyText}`];
  return safeItems.map((item) => `- ${String(item)}`);
};

const printObjectPairs = (obj, fallback = '(nao informado)') => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [`- ${fallback}`];
  const entries = Object.entries(obj);
  if (!entries.length) return [`- ${fallback}`];
  return entries.map(([key, value]) => `- ${key}: ${String(value)}`);
};

const printObjectPairsDeep = (obj, prefix = '') => {
  if (!obj || typeof obj !== 'object') return [];
  const entries = Object.entries(obj);
  if (!entries.length) return [];

  const lines = [];
  for (const [key, value] of entries) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      if (!value.length) {
        lines.push(`- ${nextKey}: (nenhum)`);
      } else {
        const serialized = value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', ');
        lines.push(`- ${nextKey}: ${serialized}`);
      }
      continue;
    }
    if (value && typeof value === 'object') {
      lines.push(...printObjectPairsDeep(value, nextKey));
      continue;
    }
    lines.push(`- ${nextKey}: ${String(value)}`);
  }
  return lines;
};

const normalizeLegacyRequirements = (requirements = {}) => ({
  requer_grupo: pickFirstBoolean(requirements.require_group, requirements.requer_grupo),
  requer_admin: pickFirstBoolean(requirements.require_group_admin, requirements.requer_admin),
  requer_admin_principal: pickFirstBoolean(requirements.require_bot_owner, requirements.requer_admin_principal),
  requer_google_login: pickFirstBoolean(requirements.require_google_login, requirements.requer_google_login),
  requer_nsfw: pickFirstBoolean(requirements.require_nsfw_enabled, requirements.requer_nsfw),
  requer_midia: pickFirstBoolean(requirements.require_media, requirements.requer_midia),
  requer_mensagem_respondida: pickFirstBoolean(requirements.require_reply_message, requirements.requer_mensagem_respondida),
});

const normalizeRateLimit = (rateLimit = {}) => ({
  max: pickFirst(rateLimit.max, null),
  janela_ms: pickFirst(rateLimit.janela_ms, rateLimit.window_ms, null),
  escopo: normalizeText(pickFirst(rateLimit.escopo, rateLimit.scope), '(nao informado)'),
});

const normalizePlanEntry = (entry = {}) => ({
  max: pickFirst(entry.max, null),
  janela_ms: pickFirst(entry.janela_ms, entry.window_ms, null),
  escopo: normalizeText(pickFirst(entry.escopo, entry.scope), '(nao informado)'),
});

const normalizeArgument = (arg = {}) => {
  const safeArg = ensureObject(arg);
  const name = normalizeText(pickFirst(safeArg.name, safeArg.nome), '');
  if (!name) return null;
  return {
    name,
    type: normalizeText(pickFirst(safeArg.type, safeArg.tipo, 'any'), 'any'),
    required: pickFirstBoolean(safeArg.required, safeArg.obrigatorio),
    validation: normalizeText(pickFirst(safeArg.validation, safeArg.validacao), 'livre'),
    defaultValue: hasOwn(safeArg, 'default') ? safeArg.default : null,
    description: normalizeText(pickFirst(safeArg.description, safeArg.descricao), '(nao informado)'),
    enumValues: ensureArray(safeArg.enum),
    position: pickFirst(safeArg.position, null),
  };
};

const renderArgumentLine = (argument) => {
  const normalized = normalizeArgument(argument);
  if (!normalized) return '- (argumento invalido)';
  const obrigatorio = normalized.required ? 'obrigatorio' : 'opcional';
  const defaultValue = normalized.defaultValue === undefined ? 'null' : JSON.stringify(normalized.defaultValue);
  const enumLabel = normalized.enumValues.length ? ` | enum: ${normalized.enumValues.join(', ')}` : '';
  const positionLabel = normalized.position === null ? '' : ` | posicao: ${normalized.position}`;
  return `- ${normalized.name} | tipo: ${normalized.type} | ${obrigatorio} | validacao: ${normalized.validation} | default: ${defaultValue}${enumLabel}${positionLabel}`;
};

const resolveGuideTitle = (moduleName) => {
  const raw = String(moduleName || 'module').trim() || 'module';
  return `${raw.charAt(0).toUpperCase()}${raw.slice(1)} Agent Guide`;
};

const normalizeCommand = (command = {}, moduleDefaults = {}) => {
  const mergedCommand = deepMerge(moduleDefaults.command, ensureObject(command));

  const docs = deepMerge(moduleDefaults.docs, deepMerge(mergedCommand.docs, mergedCommand.documentacao));
  const behavior = deepMerge(moduleDefaults.behavior, mergedCommand.behavior);
  const limits = deepMerge(moduleDefaults.limits, mergedCommand.limits);
  const discovery = deepMerge(moduleDefaults.discovery, mergedCommand.discovery);

  const rawRequirements = deepMerge(moduleDefaults.requirements || moduleDefaults.pre_condicoes, mergedCommand.requirements || mergedCommand.pre_condicoes);
  const requirementsLegacy = deepMerge(rawRequirements.legacy, deepMerge(moduleDefaults.pre_condicoes, mergedCommand.pre_condicoes));
  const normalizedRequirements = {
    require_group: pickFirstBoolean(rawRequirements.require_group, rawRequirements.requer_grupo, requirementsLegacy.require_group, requirementsLegacy.requer_grupo),
    require_group_admin: pickFirstBoolean(rawRequirements.require_group_admin, rawRequirements.requer_admin, requirementsLegacy.require_group_admin, requirementsLegacy.requer_admin),
    require_bot_owner: pickFirstBoolean(rawRequirements.require_bot_owner, rawRequirements.requer_admin_principal, requirementsLegacy.require_bot_owner, requirementsLegacy.requer_admin_principal),
    require_google_login: pickFirstBoolean(rawRequirements.require_google_login, rawRequirements.requer_google_login, requirementsLegacy.require_google_login, requirementsLegacy.requer_google_login),
    require_nsfw_enabled: pickFirstBoolean(rawRequirements.require_nsfw_enabled, rawRequirements.requer_nsfw, requirementsLegacy.require_nsfw_enabled, requirementsLegacy.requer_nsfw),
    require_media: pickFirstBoolean(rawRequirements.require_media, rawRequirements.requer_midia, requirementsLegacy.require_media, requirementsLegacy.requer_midia),
    require_reply_message: pickFirstBoolean(rawRequirements.require_reply_message, rawRequirements.requer_mensagem_respondida, requirementsLegacy.require_reply_message, requirementsLegacy.requer_mensagem_respondida),
  };

  const rawRateLimit = deepMerge(moduleDefaults.rate_limit, deepMerge(limits.rate_limit, mergedCommand.rate_limit));
  const rateLimit = normalizeRateLimit(rawRateLimit);

  const rawAccess = deepMerge(moduleDefaults.access || moduleDefaults.acesso, mergedCommand.access || mergedCommand.acesso);
  const access = {
    premium_only: pickFirstBoolean(rawAccess.premium_only, rawAccess.somente_premium),
    allowed_plans: unique(ensureArray(pickFirst(rawAccess.allowed_plans, rawAccess.planos_permitidos))),
  };

  const rawPlanLimits = deepMerge(moduleDefaults.plan_limits || moduleDefaults.limite_uso_por_plano, mergedCommand.plan_limits || mergedCommand.limite_uso_por_plano);
  const planLimits = {
    comum: normalizePlanEntry(rawPlanLimits.comum),
    premium: normalizePlanEntry(rawPlanLimits.premium),
  };

  const rawResponses = deepMerge(moduleDefaults.responses || moduleDefaults.respostas_padrao, mergedCommand.responses || mergedCommand.respostas_padrao);

  const rawObservability = deepMerge(moduleDefaults.observability || moduleDefaults.observabilidade, mergedCommand.observability || mergedCommand.observabilidade);
  const observability = {
    event_name: pickFirst(rawObservability.event_name, rawObservability.evento_analytics, null),
    analytics_event: pickFirst(rawObservability.analytics_event, rawObservability.evento_analytics, null),
    tags: unique([...ensureArray(rawObservability.tags), ...ensureArray(rawObservability.tags_log)]),
    level: normalizeText(pickFirst(rawObservability.log_level, rawObservability.nivel_log), '(nao informado)'),
  };

  const rawPrivacy = deepMerge(moduleDefaults.privacy || moduleDefaults.privacidade, mergedCommand.privacy || mergedCommand.privacidade);
  const privacy = {
    data_categories: unique([...ensureArray(rawPrivacy.data_categories), ...ensureArray(rawPrivacy.dados_sensiveis)]),
    retention: normalizeText(pickFirst(rawPrivacy.retention_policy, rawPrivacy.retencao), '(nao informado)'),
    legal_basis: normalizeText(pickFirst(rawPrivacy.legal_basis, rawPrivacy.base_legal), '(nao informado)'),
  };

  const argsRaw = ensureArray(mergedCommand.arguments).length ? mergedCommand.arguments : mergedCommand.argumentos;
  const normalizedArguments = ensureArray(argsRaw)
    .map((entry) => normalizeArgument(entry))
    .filter(Boolean);

  const usage = unique(ensureArray(pickFirst(mergedCommand.usage, mergedCommand.metodos_de_uso, docs.usage_examples)));
  const usageVariants = deepMerge(docs.usage_variants, mergedCommand.mensagens_uso);

  const systemMessages = deepMerge(moduleDefaults.mensagens_sistema, mergedCommand.mensagens_sistema);
  const operationalLimits = deepMerge(moduleDefaults.limites_operacionais, mergedCommand.limites_operacionais);
  const options = deepMerge(moduleDefaults.opcoes || moduleDefaults.behavior_templates, mergedCommand.opcoes);

  return {
    name: normalizeText(mergedCommand.name, 'comando'),
    id: normalizeText(mergedCommand.id, '(nao informado)'),
    aliases: unique(ensureArray(mergedCommand.aliases)),
    enabled: mergedCommand.enabled !== false,
    category: normalizeText(pickFirst(mergedCommand.category, mergedCommand.categoria), '(nao informado)'),
    description: normalizeText(pickFirst(mergedCommand.description, mergedCommand.descricao), 'Sem descricao cadastrada.'),
    permission: normalizeText(pickFirst(mergedCommand.permission, mergedCommand.permissao_necessaria), '(nao informado)'),
    version: normalizeText(mergedCommand.version, '(nao informado)'),
    stability: normalizeText(mergedCommand.stability, '(nao informado)'),
    deprecated: pickFirstBoolean(mergedCommand.deprecated),
    replaced_by: normalizeText(mergedCommand.replaced_by, ''),
    risk_level: normalizeText(mergedCommand.risk_level, '(nao informado)'),
    contexts: unique(ensureArray(pickFirst(mergedCommand.contexts, mergedCommand.local_de_uso))),
    subcommands: unique(ensureArray(mergedCommand.subcomandos)),
    usage,
    usageVariants: ensureObject(usageVariants),
    arguments: normalizedArguments,
    requirementsLegacy: normalizeLegacyRequirements(normalizedRequirements),
    rateLimit,
    access,
    planLimits,
    collectedData: unique(ensureArray(pickFirst(mergedCommand.collected_data, mergedCommand.informacoes_coletadas))),
    dependencies: unique(ensureArray(pickFirst(mergedCommand.dependencies, mergedCommand.dependencias_externas))),
    sideEffects: unique(ensureArray(pickFirst(mergedCommand.side_effects, mergedCommand.efeitos_colaterais))),
    responses: ensureObject(rawResponses),
    systemMessages: ensureObject(systemMessages),
    operationalLimits: ensureObject(operationalLimits),
    options: ensureObject(options),
    observability,
    privacy,
    docs: ensureObject(docs),
    behavior: ensureObject(behavior),
    limits: ensureObject(limits),
    discovery: ensureObject(discovery),
    handler: ensureObject(mergedCommand.handler),
  };
};

const buildCommandSection = (command = {}) => {
  const commandName = normalizeText(command.name, 'comando');
  const lines = [];
  lines.push(`### ${commandName}`);
  const aliases = unique(ensureArray(command.aliases));
  lines.push(`- id: ${normalizeText(command.id)}`);
  lines.push(`- aliases: ${aliases.length ? aliases.join(', ') : '(nenhum)'}`);
  lines.push(`- enabled: ${command.enabled !== false}`);
  lines.push(`- categoria: ${normalizeText(command.category)}`);
  lines.push(`- descricao: ${normalizeText(command.description, 'Sem descricao cadastrada.')}`);
  lines.push(`- permissao_necessaria: ${normalizeText(command.permission)}`);
  lines.push(`- version: ${normalizeText(command.version)}`);
  lines.push(`- stability: ${normalizeText(command.stability)}`);
  lines.push(`- deprecated: ${normalizeBoolLabel(Boolean(command.deprecated))}`);
  if (command.replaced_by) {
    lines.push(`- replaced_by: ${command.replaced_by}`);
  }
  lines.push(`- risk_level: ${normalizeText(command.risk_level)}`);

  lines.push('- local_de_uso:');
  lines.push(...printList(command.contexts));

  lines.push('- metodos_de_uso:');
  lines.push(...printList(command.usage));

  if (command.usageVariants && typeof command.usageVariants === 'object') {
    lines.push('- mensagens_uso (variantes):');
    const usageVariants = Object.entries(command.usageVariants);
    if (!usageVariants.length) {
      lines.push('- (nenhum)');
    } else {
      for (const [variant, usageList] of usageVariants) {
        lines.push(`- ${variant}:`);
        lines.push(...printList(usageList));
      }
    }
  }

  lines.push('- subcomandos:');
  lines.push(...printList(command.subcommands));

  lines.push('- argumentos:');
  const argumentos = ensureArray(command.arguments);
  if (!argumentos.length) {
    lines.push('- (nenhum)');
  } else {
    lines.push(...argumentos.map((arg) => renderArgumentLine(arg)));
  }

  lines.push('- pre_condicoes:');
  const pre = ensureObject(command.requirementsLegacy);
  lines.push(`- requer_grupo: ${normalizeBoolLabel(Boolean(pre.requer_grupo))}`);
  lines.push(`- requer_admin: ${normalizeBoolLabel(Boolean(pre.requer_admin))}`);
  lines.push(`- requer_admin_principal: ${normalizeBoolLabel(Boolean(pre.requer_admin_principal))}`);
  lines.push(`- requer_google_login: ${normalizeBoolLabel(Boolean(pre.requer_google_login))}`);
  lines.push(`- requer_nsfw: ${normalizeBoolLabel(Boolean(pre.requer_nsfw))}`);
  lines.push(`- requer_midia: ${normalizeBoolLabel(Boolean(pre.requer_midia))}`);
  lines.push(`- requer_mensagem_respondida: ${normalizeBoolLabel(Boolean(pre.requer_mensagem_respondida))}`);

  const rateLimit = ensureObject(command.rateLimit);
  lines.push('- rate_limit:');
  lines.push(`- max: ${rateLimit.max ?? 'null'}`);
  lines.push(`- janela_ms: ${rateLimit.janela_ms ?? 'null'}`);
  lines.push(`- escopo: ${rateLimit.escopo ?? '(nao informado)'}`);

  lines.push('- acesso:');
  if (command.access && typeof command.access === 'object') {
    lines.push(`- somente_premium: ${normalizeBoolLabel(Boolean(command.access.premium_only))}`);
    lines.push(`- planos_permitidos: ${command.access.allowed_plans.length ? command.access.allowed_plans.join(', ') : '(nao informado)'}`);
  } else {
    lines.push('- (nao informado)');
  }

  lines.push('- limite_uso_por_plano:');
  if (command.planLimits && typeof command.planLimits === 'object') {
    const planos = command.planLimits;
    const comum = planos.comum && typeof planos.comum === 'object' ? planos.comum : null;
    const premium = planos.premium && typeof planos.premium === 'object' ? planos.premium : null;
    if (!comum && !premium) {
      lines.push('- (nao informado)');
    } else {
      if (comum) {
        lines.push(`- comum: max=${comum.max ?? 'null'}, janela_ms=${comum.janela_ms ?? 'null'}, escopo=${comum.escopo ?? '(nao informado)'}`);
      }
      if (premium) {
        lines.push(`- premium: max=${premium.max ?? 'null'}, janela_ms=${premium.janela_ms ?? 'null'}, escopo=${premium.escopo ?? '(nao informado)'}`);
      }
    }
  } else {
    lines.push('- (nao informado)');
  }

  lines.push('- informacoes_coletadas:');
  lines.push(...printList(command.collectedData));

  lines.push('- dependencias_externas:');
  lines.push(...printList(command.dependencies));

  lines.push('- efeitos_colaterais:');
  lines.push(...printList(command.sideEffects));

  lines.push('- respostas_padrao:');
  lines.push(...printObjectPairs(command.responses));

  lines.push('- mensagens_sistema:');
  const mensagensSistema = hasEntries(command.systemMessages) ? command.systemMessages : null;
  if (!mensagensSistema) {
    lines.push('- (nao informado)');
  } else {
    const deepPairs = printObjectPairsDeep(mensagensSistema);
    lines.push(...(deepPairs.length ? deepPairs : ['- (nao informado)']));
  }

  lines.push('- limites_operacionais:');
  const limitesOperacionais = hasEntries(command.operationalLimits) ? command.operationalLimits : null;
  if (!limitesOperacionais) {
    lines.push('- (nao informado)');
  } else {
    const deepPairs = printObjectPairsDeep(limitesOperacionais);
    lines.push(...(deepPairs.length ? deepPairs : ['- (nao informado)']));
  }

  lines.push('- opcoes:');
  const opcoes = hasEntries(command.options) ? command.options : null;
  if (!opcoes) {
    lines.push('- (nao informado)');
  } else {
    const deepPairs = printObjectPairsDeep(opcoes);
    lines.push(...(deepPairs.length ? deepPairs : ['- (nao informado)']));
  }

  lines.push('- observabilidade:');
  if (command.observability && typeof command.observability === 'object') {
    lines.push(`- event_name: ${command.observability.event_name ?? '(nao informado)'}`);
    lines.push(`- analytics_event: ${command.observability.analytics_event ?? '(nao informado)'}`);
    lines.push(`- tags_log: ${command.observability.tags.length ? command.observability.tags.join(', ') : '(nenhum)'}`);
    lines.push(`- nivel_log: ${command.observability.level ?? '(nao informado)'}`);
  } else {
    lines.push('- (nao informado)');
  }

  lines.push('- privacidade:');
  if (command.privacy && typeof command.privacy === 'object') {
    const privacy = command.privacy;
    lines.push('- dados_sensiveis:');
    lines.push(...printList(privacy.data_categories));
    lines.push(`- retencao: ${privacy.retention ?? '(nao informado)'}`);
    lines.push(`- base_legal: ${privacy.legal_basis ?? '(nao informado)'}`);
  } else {
    lines.push('- (nao informado)');
  }

  lines.push('- docs:');
  if (hasEntries(command.docs)) {
    const deepPairs = printObjectPairsDeep(command.docs);
    lines.push(...(deepPairs.length ? deepPairs : ['- (nao informado)']));
  } else {
    lines.push('- (nao informado)');
  }

  lines.push('- behavior:');
  if (hasEntries(command.behavior)) {
    const deepPairs = printObjectPairsDeep(command.behavior);
    lines.push(...(deepPairs.length ? deepPairs : ['- (nao informado)']));
  } else {
    lines.push('- (nao informado)');
  }

  lines.push('- limits:');
  if (hasEntries(command.limits)) {
    const deepPairs = printObjectPairsDeep(command.limits);
    lines.push(...(deepPairs.length ? deepPairs : ['- (nao informado)']));
  } else {
    lines.push('- (nao informado)');
  }

  lines.push('- discovery:');
  if (hasEntries(command.discovery)) {
    const deepPairs = printObjectPairsDeep(command.discovery);
    lines.push(...(deepPairs.length ? deepPairs : ['- (nao informado)']));
  } else {
    lines.push('- (nao informado)');
  }

  lines.push('- handler:');
  if (hasEntries(command.handler)) {
    lines.push(...printObjectPairs(command.handler));
  } else {
    lines.push('- (nao informado)');
  }

  return lines;
};

const buildAgentMarkdown = ({ moduleDirName, config }) => {
  const safeConfig = ensureObject(config);
  const moduleName = normalizeText(safeConfig.module || moduleDirName || 'module', 'module');
  const schemaVersion = normalizeText(safeConfig.schema_version, '1.0.0');
  const moduleEnabled = config?.enabled !== false;
  const sourceFiles = ensureArray(safeConfig.source_files);
  const moduleDefaults = ensureObject(safeConfig.defaults);
  const commands = ensureArray(safeConfig.commands).map((entry) => normalizeCommand(entry, moduleDefaults));
  const enabledCommands = commands.filter((entry) => entry && entry.enabled !== false);

  const lines = [];
  lines.push(`# ${resolveGuideTitle(moduleName)}`);
  lines.push('');
  lines.push('Este arquivo e destinado a agentes de IA para gerar respostas no contexto dos comandos deste modulo.');
  lines.push('');
  lines.push('## Fonte de Verdade');
  lines.push(`- arquivo_base: \`app/modules/${moduleDirName}/commandConfig.json\``);
  lines.push(`- schema_version: \`${schemaVersion}\``);
  lines.push(`- module_enabled: \`${moduleEnabled}\``);
  lines.push(`- generated_at: \`${nowIso}\``);
  lines.push('');
  lines.push('## Escopo do Modulo');
  lines.push(`- module: \`${moduleName}\``);
  lines.push('- source_files:');
  lines.push(...printList(sourceFiles));
  lines.push(`- total_commands: \`${commands.length}\``);
  lines.push(`- total_enabled_commands: \`${enabledCommands.length}\``);

  if (hasEntries(moduleDefaults)) {
    lines.push('');
    lines.push('## Defaults Schema v2');
    lines.push(`- inheritance_mode: ${normalizeText(moduleDefaults.inheritance_mode, '(nao informado)')}`);
    lines.push(`- compatibility_mode: ${normalizeText(moduleDefaults.compatibility_mode, '(nao informado)')}`);
    lines.push('- legacy_field_aliases:');
    lines.push(...printObjectPairs(moduleDefaults.legacy_field_aliases));

    lines.push('- defaults.command:');
    const commandDefaultsPairs = printObjectPairsDeep(moduleDefaults.command);
    lines.push(...(commandDefaultsPairs.length ? commandDefaultsPairs : ['- (nao informado)']));

    lines.push('- defaults.requirements (legacy view):');
    const reqLegacy = normalizeLegacyRequirements(ensureObject(moduleDefaults.requirements));
    lines.push(`- requer_grupo: ${normalizeBoolLabel(Boolean(reqLegacy.requer_grupo))}`);
    lines.push(`- requer_admin: ${normalizeBoolLabel(Boolean(reqLegacy.requer_admin))}`);
    lines.push(`- requer_admin_principal: ${normalizeBoolLabel(Boolean(reqLegacy.requer_admin_principal))}`);
    lines.push(`- requer_google_login: ${normalizeBoolLabel(Boolean(reqLegacy.requer_google_login))}`);
    lines.push(`- requer_nsfw: ${normalizeBoolLabel(Boolean(reqLegacy.requer_nsfw))}`);
    lines.push(`- requer_midia: ${normalizeBoolLabel(Boolean(reqLegacy.requer_midia))}`);
    lines.push(`- requer_mensagem_respondida: ${normalizeBoolLabel(Boolean(reqLegacy.requer_mensagem_respondida))}`);
  }

  if (config?.ai_help && typeof config.ai_help === 'object') {
    const aiHelp = config.ai_help;
    lines.push('');
    lines.push('## Configuracao AI Help');
    lines.push(`- enabled: ${aiHelp.enabled !== false}`);
    lines.push(`- mode: ${String(aiHelp.mode || '(nao informado)')}`);
    lines.push('- rag_sources:');
    lines.push(...printList(aiHelp.rag_sources));
    const faq = aiHelp.faq && typeof aiHelp.faq === 'object' ? aiHelp.faq : {};
    const llm = aiHelp.llm && typeof aiHelp.llm === 'object' ? aiHelp.llm : {};
    lines.push(`- faq.cache_file: ${faq.cache_file ?? '(nao informado)'}`);
    lines.push(`- faq.interval_ms: ${faq.interval_ms ?? '(nao informado)'}`);
    lines.push(`- faq.auto_generate_on_start: ${faq.auto_generate_on_start ?? '(nao informado)'}`);
    lines.push(`- llm.enabled: ${llm.enabled ?? '(nao informado)'}`);
    lines.push(`- llm.model: ${llm.model ?? '(nao informado)'}`);
    lines.push(`- llm.max_agent_context_chars: ${llm.max_agent_context_chars ?? '(nao informado)'}`);
    lines.push(`- llm.max_response_chars: ${llm.max_response_chars ?? '(nao informado)'}`);
    lines.push(`- llm.timeout_ms: ${llm.timeout_ms ?? '(nao informado)'}`);
  }

  lines.push('');
  lines.push('## Protocolo de Resposta para IA');
  lines.push('- Passo 1: identificar comando pelo token apos o prefixo.');
  lines.push('- Passo 2: resolver alias para nome canonico usando campo `aliases`.');
  lines.push('- Passo 3: validar `enabled`, `pre_condicoes`, permissao e local de uso.');
  lines.push('- Passo 4: se houver erro de uso, responder com `mensagens_uso` (quando existir) ou `metodos_de_uso`.');
  lines.push('- Passo 5: seguir `respostas_padrao` como fallback de texto.');
  lines.push('- Passo 6: considerar `informacoes_coletadas`, `privacidade` e `observabilidade` ao elaborar resposta.');

  lines.push('');
  lines.push('## Regras de Seguranca para IA');
  lines.push('- A IA orienta, mas nao executa acao administrativa automaticamente.');
  lines.push('- Nao inventar comandos, subcomandos ou permissao fora do JSON.');
  lines.push('- Sempre informar onde pode usar (grupo/privado) e quem pode usar.');
  lines.push('- Em duvida de permissao, responder com orientacao conservadora.');

  lines.push('');
  lines.push('## Catalogo de Comandos');
  if (!commands.length) {
    lines.push('- (nenhum comando configurado)');
  } else {
    for (const command of commands) {
      lines.push(...buildCommandSection(command));
      lines.push('');
    }
    while (lines.length && lines[lines.length - 1] === '') {
      lines.pop();
    }
  }

  lines.push('');
  return lines.join('\n');
};

const listModuleDirs = async () => {
  const entries = await fs.readdir(modulesRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
};

const shouldSkipModule = (moduleDirName, includeAdmin) => {
  if (moduleDirName === 'adminModule' && !includeAdmin) return true;
  return false;
};

const main = async () => {
  const includeAdmin = process.argv.includes('--include-admin');
  const dryRun = process.argv.includes('--dry-run');
  const onlyModule = normalizeToken(getArgValue('--module'));
  const moduleDirs = await listModuleDirs();
  const generated = [];

  for (const moduleDirName of moduleDirs) {
    if (shouldSkipModule(moduleDirName, includeAdmin)) continue;
    if (onlyModule && normalizeToken(moduleDirName) !== onlyModule) continue;

    const configPath = path.join(modulesRoot, moduleDirName, 'commandConfig.json');
    let raw = '';
    try {
      raw = await fs.readFile(configPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        continue;
      }
      throw error;
    }
    if (!raw) {
      continue;
    }
    const config = JSON.parse(raw);
    const markdown = buildAgentMarkdown({ moduleDirName, config });
    const targetPath = path.join(modulesRoot, moduleDirName, 'AGENT.md');
    if (!dryRun) {
      await fs.writeFile(targetPath, markdown, 'utf8');
    }
    generated.push(path.relative(repoRoot, targetPath));
  }

  for (const item of generated) {
    console.log(`${dryRun ? 'planned' : 'generated'}: ${item}`);
  }
  console.log(`total_${dryRun ? 'planned' : 'generated'}: ${generated.length}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
