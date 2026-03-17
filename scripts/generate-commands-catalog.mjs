#!/usr/bin/env node
import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const modulesRoot = path.join(repoRoot, 'app', 'modules');
const outputPath = path.join(repoRoot, 'public', 'comandos', 'commands-catalog.json');

const CATEGORY_META = {
  admin: { label: 'Moderação e Admin', icon: '🛡️' },
  figurinhas: { label: 'Figurinhas', icon: '🎨' },
  midia: { label: 'Mídia', icon: '🎵' },
  ia: { label: 'Inteligência Artificial', icon: '🤖' },
  anime: { label: 'Anime e Imagens', icon: '🖼️' },
  jogos: { label: 'Jogos e Diversão', icon: '🎮' },
  estatisticas: { label: 'Estatísticas', icon: '📊' },
  menu: { label: 'Menu e Navegação', icon: '📚' },
  sistema: { label: 'Sistema', icon: '🧰' },
  usuario: { label: 'Perfil de Usuário', icon: '👤' },
};

const CATEGORY_ORDER = ['admin', 'figurinhas', 'midia', 'ia', 'jogos', 'estatisticas', 'anime', 'usuario', 'menu', 'sistema'];

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

const ensureArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

const unique = (values = []) => {
  const out = [];
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw || out.includes(raw)) continue;
    out.push(raw);
  }
  return out;
};

const normalizeCategoryKey = (value) => normalizeText(value).replace(/\s+/g, '_') || 'outros';

const resolveCategoryMeta = (key) => {
  const meta = CATEGORY_META[key] || null;
  if (meta) return meta;

  const label = key
    .split('_')
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
  return { label, icon: '🧩' };
};

const pickFirstText = (...values) => {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
};

const ensureSentence = (value) => {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return '';
  if (/[.!?]$/.test(text)) return text;
  return `${text}.`;
};

const parseOptionalBoolean = (value) => {
  if (value === true) return true;
  if (value === false) return false;
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'sim'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'nao', 'não'].includes(normalized)) return false;
  return null;
};

const normalizeUserList = (value) => unique(ensureArray(value).map((item) => String(item || '').trim()));

const normalizeExampleCommand = (value, fallback = '') => {
  const raw = String(value || '').trim();
  if (!raw) return String(fallback || '').trim();
  return raw.replaceAll('<prefix>', '/');
};

const normalizeUserExample = (value, { fallbackSituation = '', fallbackCommand = '', fallbackExpected = '', fallbackVariation = '' } = {}) => {
  if (!value) return null;

  if (typeof value === 'string') {
    const commandText = normalizeExampleCommand(value, fallbackCommand);
    if (!commandText) return null;
    return {
      situacao: ensureSentence(fallbackSituation || 'Exemplo real de uso do comando'),
      comando: commandText,
      resposta_esperada: ensureSentence(fallbackExpected || 'O bot confirma a execução'),
      variacao: ensureSentence(fallbackVariation || ''),
    };
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const situacao = pickFirstText(value.situacao, value.cenario, value.contexto, fallbackSituation);
    const comando = normalizeExampleCommand(pickFirstText(value.comando, value.command, value.uso), fallbackCommand);
    const respostaEsperada = pickFirstText(value.resposta_esperada, value.expected_response, value.resposta, fallbackExpected);
    const variacao = pickFirstText(value.variacao, value.outcome_variation, fallbackVariation);

    if (!comando) return null;

    return {
      situacao: ensureSentence(situacao || 'Exemplo real de uso do comando'),
      comando,
      resposta_esperada: ensureSentence(respostaEsperada || 'O bot confirma a execução'),
      variacao: ensureSentence(variacao || ''),
    };
  }

  return null;
};

const buildUserExperienceContract = ({ commandName = '', description = '', docsSummary = '', usageMethods = [], responses = {}, requirements = {}, premium = false, rawUserExperience = {} } = {}) => {
  const explicitSummary = pickFirstText(rawUserExperience.resumo_usuario, rawUserExperience.summary, rawUserExperience.resumo_ia);
  const explicitSummaryOrigin = pickFirstText(rawUserExperience.resumo_usuario_origem, rawUserExperience.summary_origin);
  const normalizedSummaryOrigin = explicitSummaryOrigin === 'manual' || explicitSummaryOrigin === 'auto_ia_assistida' ? explicitSummaryOrigin : '';
  const summaryBase = pickFirstText(explicitSummary, docsSummary, description, `Use /${commandName} para executar esta ação no bot`);
  const resumoUsuario = ensureSentence(summaryBase);
  const summaryOrigin = normalizedSummaryOrigin || (explicitSummary ? 'manual' : 'auto_ia_assistida');
  const explicitReviewPending = parseOptionalBoolean(rawUserExperience.resumo_usuario_revisao_pendente);

  const explicitWhenToUse = normalizeUserList(rawUserExperience.quando_usar || rawUserExperience.when_to_use);
  const descriptionNoPunctuation = String(description || '')
    .trim()
    .replace(/[.!?]+$/, '');
  const descriptionSentence = ensureSentence(descriptionNoPunctuation);
  const derivedWhenToUse = unique([descriptionSentence ? `Use quando você precisa desta ação: ${descriptionSentence}` : '', requirements.group ? 'Funciona dentro de grupos.' : 'Pode ser usado no privado e em grupo.', requirements.admin ? 'Você precisa ser admin para executar.' : '', requirements.owner ? 'Esse comando é restrito ao admin principal do sistema.' : '', requirements.google_login ? 'É necessário estar logado no sistema para usar.' : '', premium ? 'Disponível para usuários Premium.' : ''].filter(Boolean));
  const quandoUsar = explicitWhenToUse.length ? explicitWhenToUse : derivedWhenToUse.slice(0, 5);

  const successResponse = ensureSentence(pickFirstText(rawUserExperience.resposta_sucesso, responses.success, responses.sucesso, 'O bot confirma que executou o comando'));
  const usageErrorResponse = ensureSentence(pickFirstText(rawUserExperience.resposta_uso_incorreto, responses.usage_error, responses.erro_uso, 'Se o formato estiver incorreto, o bot mostra como usar corretamente'));
  const permissionResponse = ensureSentence(pickFirstText(rawUserExperience.resposta_sem_permissao, responses.permission_error, responses.erro_permissao, premium ? 'Sem plano Premium ativo, o bot informa a restrição de acesso' : 'Sem permissão suficiente, o bot informa o motivo'));

  const explicitExpectedResponses = normalizeUserList(rawUserExperience.resposta_esperada || rawUserExperience.expected_response);
  const respostaEsperada = explicitExpectedResponses.length ? explicitExpectedResponses : unique([`Sucesso: ${successResponse}`, `Uso incorreto: ${usageErrorResponse}`, `Permissão: ${permissionResponse}`]);

  const explicitExamples = ensureArray(rawUserExperience.exemplos_reais || rawUserExperience.real_examples);
  const defaultSituation = descriptionSentence ? `Cenário comum: ${descriptionSentence}` : `Cenário comum: você quer usar /${commandName} no dia a dia.`;
  const fallbackUsageMethods = usageMethods.length ? usageMethods : [`/${commandName}`];
  let exemplosReais = explicitExamples
    .map((example) =>
      normalizeUserExample(example, {
        fallbackSituation: defaultSituation,
        fallbackCommand: fallbackUsageMethods[0] || `/${commandName}`,
        fallbackExpected: successResponse,
        fallbackVariation: usageErrorResponse,
      }),
    )
    .filter(Boolean);

  if (!exemplosReais.length) {
    exemplosReais = fallbackUsageMethods.slice(0, 3).map((usageMethod, index) => ({
      situacao: ensureSentence(index === 0 ? defaultSituation : `Variação ${index + 1} de uso do comando no mesmo contexto`),
      comando: normalizeExampleCommand(usageMethod, `/${commandName}`),
      resposta_esperada: successResponse,
      variacao: usageErrorResponse,
    }));
  }

  const explicitCommonErrors = normalizeUserList(rawUserExperience.erros_comuns_usuario || rawUserExperience.common_user_errors);
  const derivedCommonErrors = unique(['Digitar o comando fora do formato esperado.', requirements.group ? 'Tentar executar fora de um grupo.' : '', requirements.admin ? 'Tentar executar sem ser admin.' : '', requirements.owner ? 'Tentar executar sem ser admin principal do sistema.' : '', requirements.google_login ? 'Tentar usar sem estar logado no sistema.' : '', premium ? 'Tentar usar sem acesso Premium ativo.' : ''].filter(Boolean));
  const errosComunsUsuario = explicitCommonErrors.length ? explicitCommonErrors : derivedCommonErrors.slice(0, 5);

  const explicitErrorSteps = normalizeUserList(rawUserExperience.passos_se_der_erro || rawUserExperience.error_steps);
  const fallbackErrorSteps = ['Copie e teste um exemplo pronto desta página.', 'Confira se você está no local certo (grupo/privado) e com a permissão necessária.', premium ? 'Verifique se seu acesso Premium está ativo.' : '', 'Se ainda falhar, fale com o admin do sistema no privado.'].filter(Boolean);
  const passosSeDerErro = explicitErrorSteps.length ? explicitErrorSteps : fallbackErrorSteps;

  return {
    resumo_usuario: resumoUsuario,
    quando_usar: quandoUsar,
    exemplos_reais: exemplosReais,
    resposta_esperada: respostaEsperada,
    erros_comuns_usuario: errosComunsUsuario,
    passos_se_der_erro: passosSeDerErro,
    resumo_usuario_origem: summaryOrigin,
    resumo_usuario_revisao_pendente: explicitReviewPending ?? summaryOrigin !== 'manual',
  };
};

const deepMerge = (target, source) => {
  if (!source) return target;
  const output = { ...target };
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        output[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
  }
  return output;
};

const listModuleConfigs = async () => {
  const dirs = await fs.readdir(modulesRoot, { withFileTypes: true });
  const configs = [];

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const moduleDir = path.join(modulesRoot, dir.name);
    const configPath = path.join(moduleDir, 'commandConfig.json');
    try {
      await fs.access(configPath);
      configs.push({ moduleDirName: dir.name, configPath });
    } catch {
      // ignore modules sem commandConfig
    }
  }

  return configs.sort((left, right) => left.moduleDirName.localeCompare(right.moduleDirName));
};

const sanitizeCommand = ({ command: rawCommand, moduleDefaults, moduleDirName, moduleName }) => {
  // Merge overrides from module defaults
  const command = deepMerge(moduleDefaults?.command || {}, rawCommand);

  const commandName = String(command?.name || '').trim();
  if (!commandName) return null;

  const category = normalizeCategoryKey(command?.categoria || command?.category);
  const aliases = unique(ensureArray(command?.aliases).map((alias) => String(alias)));

  // Usage methods & docs
  const usageMethods = unique(ensureArray(command?.metodos_de_uso || command?.usage || command?.docs?.usage_examples).map((method) => String(method).replaceAll('<prefix>', '/').trim()));
  const usageVariants = deepMerge(moduleDefaults?.responses || {}, command?.docs?.usage_variants || command?.mensagens_uso || {});

  const normalizedUsageVariants = Object.entries(usageVariants).reduce((acc, [variantKey, methods]) => {
    const normalizedVariantKey = String(variantKey || '').trim();
    const normalizedMethods = unique(ensureArray(methods).map((method) => String(method).replaceAll('<prefix>', '/').trim()));
    if (normalizedVariantKey && normalizedMethods.length) {
      acc[normalizedVariantKey] = normalizedMethods;
    }
    return acc;
  }, {});

  // Requirements (Requirements merged with defaults)
  const req = deepMerge(moduleDefaults?.requirements || moduleDefaults?.pre_condicoes || {}, command?.requirements || command?.pre_condicoes || {});
  const requirements = {
    group: Boolean(req.require_group ?? req.requer_grupo),
    admin: Boolean(req.require_group_admin ?? req.requer_admin),
    owner: Boolean(req.require_bot_owner ?? req.requer_admin_principal),
    google_login: Boolean(req.require_google_login ?? req.requer_google_login),
    nsfw: Boolean(req.require_nsfw_enabled ?? req.requer_nsfw),
    media: Boolean(req.require_media ?? req.requer_midia),
    reply: Boolean(req.require_reply_message ?? req.requer_mensagem_respondida),
  };

  // Access & Premium
  const acc = deepMerge(moduleDefaults?.access || moduleDefaults?.acesso || {}, command?.access || command?.acesso || {});
  const premium = Boolean(acc.premium_only ?? acc.somente_premium);
  const allowedPlans = unique(ensureArray(acc.allowed_plans || acc.planos_permitidos));

  // Rate Limits
  const rl = deepMerge(moduleDefaults?.rate_limit || {}, command?.limits?.rate_limit || command?.rate_limit || {});
  const rateLimit = rl.max ? { max: rl.max, window_ms: rl.janela_ms || rl.window_ms, scope: rl.escopo || rl.scope } : null;

  // Discovery
  const disc = deepMerge(moduleDefaults?.discovery || {}, command?.discovery || {});
  const keywords = unique([...ensureArray(command?.capability_keywords), ...ensureArray(disc.keywords)]);
  const userPhrasings = unique([...ensureArray(command?.user_phrasings), ...ensureArray(disc.user_phrasings)]);

  // Arguments
  const rawArgs = command?.arguments || command?.argumentos || [];
  const args = ensureArray(rawArgs)
    .map((arg) => ({
      name: String(arg.name || arg.nome || '').trim(),
      type: String(arg.type || arg.tipo || 'string').trim(),
      required: Boolean(arg.required ?? arg.obrigatorio),
      description: String(arg.description || arg.descricao || '').trim(),
      default: arg.default ?? null,
      validation: arg.validation || arg.validacao || null,
    }))
    .filter((a) => a.name);

  // Advanced Info (New Fields)
  const collectedData = unique([...ensureArray(moduleDefaults?.privacy?.data_categories), ...ensureArray(command?.privacy?.data_categories), ...ensureArray(command?.informacoes_coletadas), ...ensureArray(command?.collected_data)]);
  const dependencies = unique([...ensureArray(moduleDefaults?.dependencies), ...ensureArray(command?.dependencies), ...ensureArray(command?.dependencias_externas)]);
  const sideEffects = unique([...ensureArray(command?.efeitos_colaterais), ...ensureArray(command?.side_effects)]);

  const responses = deepMerge(moduleDefaults?.responses || moduleDefaults?.respostas_padrao || {}, command?.responses || command?.respostas_padrao || {});
  const userExperienceSeed = deepMerge(moduleDefaults?.user_experience || moduleDefaults?.experiencia_usuario || {}, command?.user_experience || command?.experiencia_usuario || {});
  if (command?.resumo_usuario !== undefined) userExperienceSeed.resumo_usuario = command.resumo_usuario;
  if (command?.quando_usar !== undefined) userExperienceSeed.quando_usar = command.quando_usar;
  if (command?.exemplos_reais !== undefined) userExperienceSeed.exemplos_reais = command.exemplos_reais;
  if (command?.resposta_esperada !== undefined) userExperienceSeed.resposta_esperada = command.resposta_esperada;
  if (command?.erros_comuns_usuario !== undefined) userExperienceSeed.erros_comuns_usuario = command.erros_comuns_usuario;
  if (command?.passos_se_der_erro !== undefined) userExperienceSeed.passos_se_der_erro = command.passos_se_der_erro;
  const userExperience = buildUserExperienceContract({
    commandName,
    description: String(command?.description || command?.descricao || '').trim(),
    docsSummary: String(command?.docs?.summary || '').trim(),
    usageMethods,
    responses,
    requirements,
    premium,
    rawUserExperience: userExperienceSeed,
  });

  const observability = deepMerge(moduleDefaults?.observability || {}, command?.observability || {});
  const privacy = deepMerge(moduleDefaults?.privacy || {}, command?.privacy || {});
  const behavior = deepMerge(moduleDefaults?.behavior || {}, command?.behavior || {});

  return {
    key: `${moduleDirName}:${commandName}`,
    name: commandName,
    id: command?.id || `${moduleDirName}.${commandName}`,
    aliases,
    module: moduleDirName,
    module_label: moduleName,
    category,
    category_label: resolveCategoryMeta(category).label,
    descricao: String(command?.description || command?.descricao || '').trim(),
    requirements,
    premium,
    allowed_plans: allowedPlans,
    rate_limit: rateLimit,
    local_de_uso: unique(ensureArray(command?.contexts || command?.local_de_uso).map((item) => String(item).trim())),
    subcomandos: unique(ensureArray(command?.subcomandos).map((item) => String(item).trim())),
    metodos_de_uso: usageMethods,
    mensagens_uso: normalizedUsageVariants,
    ...userExperience,
    arguments: args,
    responses,
    technical: {
      collected_data: collectedData,
      dependencies,
      side_effects: sideEffects,
      behavior,
      handler: command?.handler || null,
      risk_level: String(command?.risk_level || 'low'),
      stability: String(command?.stability || 'stable'),
      version: String(command?.version || '1.0.0'),
    },
    observability: {
      event_name: observability.event_name || null,
      analytics_event: observability.analytics_event || observability.evento_analytics || null,
      tags: unique([...ensureArray(observability.tags), ...ensureArray(observability.tags_log)]),
    },
    privacy: {
      retention: privacy.retention_policy || privacy.retencao || null,
      legal_basis: privacy.legal_basis || privacy.base_legal || null,
    },
    discovery: {
      keywords,
      user_phrasings: userPhrasings,
      priority: Number(command?.suggestion_priority || disc.suggestion_priority || 0),
    },
  };
};

const buildCatalog = async () => {
  const moduleConfigs = await listModuleConfigs();
  const commands = [];
  const modules = [];

  for (const { moduleDirName, configPath } of moduleConfigs) {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const moduleName = String(parsed?.module || moduleDirName).trim() || moduleDirName;
    const moduleDefaults = parsed?.defaults || {};
    const entries = ensureArray(parsed?.commands);

    const moduleCommands = [];
    for (const entry of entries) {
      if (!entry || entry.enabled === false) continue;
      const sanitized = sanitizeCommand({ command: entry, moduleDefaults, moduleDirName, moduleName });
      if (!sanitized) continue;
      moduleCommands.push(sanitized);
      commands.push(sanitized);
    }

    modules.push({
      key: moduleDirName,
      label: moduleName,
      source_file: path.relative(repoRoot, configPath),
      enabled: parsed?.enabled !== false,
      command_count: moduleCommands.length,
    });
  }

  const categoryMap = new Map();
  for (const command of commands) {
    if (!categoryMap.has(command.category)) {
      const categoryMeta = resolveCategoryMeta(command.category);
      categoryMap.set(command.category, {
        key: command.category,
        label: categoryMeta.label,
        icon: categoryMeta.icon,
        command_count: 0,
        modules: new Set(),
        commands: [],
      });
    }
    const category = categoryMap.get(command.category);
    category.command_count += 1;
    category.modules.add(command.module);
    category.commands.push(command);
  }

  const knownOrderMap = new Map(CATEGORY_ORDER.map((key, index) => [key, index]));
  const categories = Array.from(categoryMap.values())
    .sort((left, right) => {
      const leftOrder = knownOrderMap.has(left.key) ? knownOrderMap.get(left.key) : 999;
      const rightOrder = knownOrderMap.has(right.key) ? knownOrderMap.get(right.key) : 999;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (left.command_count !== right.command_count) return right.command_count - left.command_count;
      return left.label.localeCompare(right.label, 'pt-BR');
    })
    .map((category) => ({
      ...category,
      modules: Array.from(category.modules).sort((left, right) => left.localeCompare(right, 'pt-BR')),
      commands: category.commands.sort((left, right) => left.name.localeCompare(right.name, 'pt-BR')),
    }));

  const sortedModules = modules.sort((left, right) => {
    if (left.command_count !== right.command_count) return right.command_count - left.command_count;
    return left.label.localeCompare(right.label, 'pt-BR');
  });

  return {
    schema_version: '3.0.0',
    generated_at: __timeNowIso(),
    totals: {
      modules: sortedModules.length,
      categories: categories.length,
      commands: commands.length,
    },
    modules: sortedModules,
    categories,
  };
};

const writeCatalog = async () => {
  const payload = await buildCatalog();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const prettierConfig = (await prettier.resolveConfig(outputPath)) || {};
  const formatted = await prettier.format(serialized, {
    ...prettierConfig,
    parser: 'json',
    filepath: outputPath,
  });
  await fs.writeFile(outputPath, formatted, 'utf8');

  console.log(`Catalogo de comandos atualizado: ${path.relative(repoRoot, outputPath)} (${payload.totals.commands} comandos)`);
};

writeCatalog().catch((error) => {
  console.error('Falha ao gerar catalogo de comandos:', error);
  process.exitCode = 1;
});
