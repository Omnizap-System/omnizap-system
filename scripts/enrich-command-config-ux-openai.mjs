#!/usr/bin/env node
import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import OpenAI from 'openai';
import prettier from 'prettier';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const modulesRoot = path.join(repoRoot, 'app', 'modules');

const DEFAULT_MODEL = String(process.env.COMMAND_CONFIG_UX_ENRICH_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
const DEFAULT_DELAY_MS = Math.max(0, Number.parseInt(String(process.env.COMMAND_CONFIG_UX_ENRICH_DELAY_MS || '120'), 10) || 120);
const MAX_ATTEMPTS = Math.max(1, Number.parseInt(String(process.env.COMMAND_CONFIG_UX_ENRICH_MAX_ATTEMPTS || '3'), 10) || 3);

const UX_FIELDS = ['resumo_usuario', 'quando_usar', 'exemplos_reais', 'resposta_esperada', 'erros_comuns_usuario', 'passos_se_der_erro'];

const OUTPUT_SCHEMA = z
  .object({
    resumo_usuario: z.string(),
    quando_usar: z.array(z.string()),
    exemplos_reais: z.array(
      z.object({
        situacao: z.string(),
        comando: z.string(),
        resposta_esperada: z.string(),
        variacao: z.string().optional(),
      }),
    ),
    resposta_esperada: z.array(z.string()),
    erros_comuns_usuario: z.array(z.string()),
    passos_se_der_erro: z.array(z.string()),
  })
  .strict();

const SYSTEM_PROMPT = ['Voce escreve textos de ajuda para usuario final de um bot WhatsApp.', 'Responda SOMENTE JSON valido com as chaves exatas:', '{"resumo_usuario":"","quando_usar":[],"exemplos_reais":[{"situacao":"","comando":"","resposta_esperada":"","variacao":""}],"resposta_esperada":[],"erros_comuns_usuario":[],"passos_se_der_erro":[]}.', 'Regras:', '- pt-BR simples, objetivo e pratico.', '- Nao use linguagem tecnica de desenvolvimento.', '- Mostre acao concreta do usuario (o que fazer agora).', '- Comandos em exemplos devem manter "<prefix>" quando aplicavel.', '- Inclua restricao Premium quando existir.', '- Evite promessas absolutas e evite texto repetido.'].join(' ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const ensureArray = (value) => (Array.isArray(value) ? value : []);

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ');

const ensureSentence = (value) => {
  const text = normalizeText(value);
  if (!text) return '';
  if (/[.!?]$/.test(text)) return text;
  return `${text}.`;
};

const uniqueStrings = (values, { max = 8, minLength = 2, maxLength = 220 } = {}) => {
  const out = [];
  const seen = new Set();
  for (const value of ensureArray(values)) {
    const normalized = normalizeText(value).slice(0, maxLength);
    if (!normalized || normalized.length < minLength) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
};

const parseArgs = (argv) => {
  const options = {
    moduleFilter: '',
    commandFilter: '',
    limit: Number.POSITIVE_INFINITY,
    overwrite: false,
    dryRun: false,
    model: DEFAULT_MODEL,
    delayMs: DEFAULT_DELAY_MS,
  };

  for (const arg of argv) {
    if (!arg) continue;
    if (arg === '--overwrite') {
      options.overwrite = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith('--module=')) {
      options.moduleFilter = normalizeText(arg.slice('--module='.length)).toLowerCase();
      continue;
    }
    if (arg.startsWith('--command=')) {
      options.commandFilter = normalizeText(arg.slice('--command='.length)).toLowerCase();
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = parsed;
      }
      continue;
    }
    if (arg.startsWith('--model=')) {
      const model = normalizeText(arg.slice('--model='.length));
      if (model) options.model = model;
      continue;
    }
    if (arg.startsWith('--delay-ms=')) {
      const parsed = Number.parseInt(arg.slice('--delay-ms='.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        options.delayMs = parsed;
      }
    }
  }

  return options;
};

const listModuleConfigPaths = async () => {
  const dirs = await fs.readdir(modulesRoot, { withFileTypes: true });
  const files = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(modulesRoot, entry.name, 'commandConfig.json');
    try {
      await fs.access(configPath);
      files.push(configPath);
    } catch {
      // ignore modules sem commandConfig
    }
  }
  return files.sort((a, b) => a.localeCompare(b, 'pt-BR'));
};

const commandMatchesFilter = (command, commandFilter) => {
  if (!commandFilter) return true;
  const name = normalizeText(command?.name).toLowerCase();
  if (name.includes(commandFilter)) return true;
  const aliases = ensureArray(command?.aliases).map((alias) => normalizeText(alias).toLowerCase());
  return aliases.some((alias) => alias.includes(commandFilter));
};

const resolveRequirements = (command) => {
  const req = isObject(command?.requirements) ? command.requirements : isObject(command?.pre_condicoes) ? command.pre_condicoes : {};
  return {
    group: Boolean(req.require_group ?? req.requer_grupo),
    admin: Boolean(req.require_group_admin ?? req.requer_admin),
    owner: Boolean(req.require_bot_owner ?? req.requer_admin_principal),
    googleLogin: Boolean(req.require_google_login ?? req.requer_google_login),
    nsfw: Boolean(req.require_nsfw_enabled ?? req.requer_nsfw),
    media: Boolean(req.require_media ?? req.requer_midia),
    reply: Boolean(req.require_reply_message ?? req.requer_mensagem_respondida),
  };
};

const resolvePremium = (command) => {
  const access = isObject(command?.access) ? command.access : isObject(command?.acesso) ? command.acesso : {};
  return {
    premium: Boolean(access.premium_only ?? access.somente_premium),
    plans: uniqueStrings(access.allowed_plans || access.planos_permitidos, { max: 8, maxLength: 40 }),
  };
};

const resolveUsageMethods = (command) =>
  uniqueStrings(command?.metodos_de_uso || command?.usage, {
    max: 6,
    maxLength: 220,
  });

const resolveResponses = (command) => {
  const responses = isObject(command?.responses) ? command.responses : isObject(command?.respostas_padrao) ? command.respostas_padrao : {};
  return {
    success: normalizeText(responses.success || responses.sucesso),
    usageError: normalizeText(responses.usage_error || responses.erro_uso),
    permissionError: normalizeText(responses.permission_error || responses.erro_permissao),
  };
};

const resolveArgs = (command) =>
  ensureArray(command?.arguments || command?.argumentos)
    .map((arg) => ({
      name: normalizeText(arg?.name || arg?.nome),
      type: normalizeText(arg?.type || arg?.tipo || 'string'),
      required: Boolean(arg?.required ?? arg?.obrigatorio),
      description: normalizeText(arg?.description || arg?.descricao),
    }))
    .filter((arg) => arg.name)
    .slice(0, 6);

const normalizeExampleCommand = (value, fallback) => {
  const raw = normalizeText(value);
  const candidate = raw || normalizeText(fallback);
  if (!candidate) return '';
  if (candidate.startsWith('/')) return `<prefix>${candidate.slice(1)}`;
  return candidate;
};

const buildFallbackUx = (context) => {
  const commandName = context?.name || 'comando';
  const commandUsage = context?.usageMethods?.[0] || `<prefix>${commandName}`;
  const description = normalizeText(context?.description) || `Use <prefix>${commandName} para executar esta acao`;
  const successText = normalizeText(context?.responses?.success) || 'O bot confirma que executou com sucesso';
  const usageErrorText = normalizeText(context?.responses?.usageError) || 'Se o formato estiver errado, o bot mostra como corrigir';
  const permissionText = normalizeText(context?.responses?.permissionError) || 'Sem permissao, o bot informa o motivo';

  return {
    resumo_usuario: ensureSentence(description),
    quando_usar: uniqueStrings([`Quando voce precisa desta acao: ${ensureSentence(description)}`, context?.requirements?.group ? 'Funciona dentro de grupos.' : 'Pode ser usado no privado e em grupo.', context?.requirements?.admin ? 'Voce precisa ser admin para executar.' : '', context?.premium?.premium ? 'Disponivel para usuarios Premium.' : ''], { max: 5 }),
    exemplos_reais: [
      {
        situacao: ensureSentence(`Cenario comum para usar ${commandUsage}`),
        comando: normalizeExampleCommand(commandUsage, `<prefix>${commandName}`),
        resposta_esperada: ensureSentence(successText),
        variacao: ensureSentence(usageErrorText),
      },
    ],
    resposta_esperada: uniqueStrings([`Sucesso: ${ensureSentence(successText)}`, `Uso incorreto: ${ensureSentence(usageErrorText)}`, `Permissao: ${ensureSentence(permissionText)}`], { max: 5 }),
    erros_comuns_usuario: uniqueStrings(['Digitar o comando fora do formato esperado.', context?.requirements?.group ? 'Tentar executar fora de um grupo.' : '', context?.requirements?.admin ? 'Tentar executar sem ser admin.' : '', context?.premium?.premium ? 'Tentar usar sem plano Premium ativo.' : ''], { max: 5 }),
    passos_se_der_erro: uniqueStrings(['Copie e teste um exemplo desta pagina.', 'Confira se voce esta no local correto e com permissao.', 'Se continuar com erro, fale com o admin no privado.'], { max: 5 }),
  };
};

const sanitizeUxPayload = (payload, context) => {
  const fallback = buildFallbackUx(context);
  const usageFallback = context?.usageMethods?.[0] || `<prefix>${context?.name || 'comando'}`;

  const examples = ensureArray(payload?.exemplos_reais)
    .map((example) => {
      if (!isObject(example)) return null;
      const situacao = ensureSentence(example.situacao) || ensureSentence(fallback.exemplos_reais[0].situacao);
      const comando = normalizeExampleCommand(example.comando, usageFallback);
      const resposta = ensureSentence(example.resposta_esperada) || ensureSentence(fallback.exemplos_reais[0].resposta_esperada);
      const variacao = ensureSentence(example.variacao || '') || ensureSentence(fallback.exemplos_reais[0].variacao);
      if (!comando) return null;
      return {
        situacao,
        comando,
        resposta_esperada: resposta,
        variacao,
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  const normalized = {
    resumo_usuario: ensureSentence(payload?.resumo_usuario) || fallback.resumo_usuario,
    quando_usar: uniqueStrings(payload?.quando_usar, { max: 5 }),
    exemplos_reais: examples,
    resposta_esperada: uniqueStrings(payload?.resposta_esperada, { max: 5 }),
    erros_comuns_usuario: uniqueStrings(payload?.erros_comuns_usuario, { max: 5 }),
    passos_se_der_erro: uniqueStrings(payload?.passos_se_der_erro, { max: 5 }),
  };

  if (!normalized.quando_usar.length) normalized.quando_usar = fallback.quando_usar;
  if (!normalized.exemplos_reais.length) normalized.exemplos_reais = fallback.exemplos_reais;
  if (!normalized.resposta_esperada.length) normalized.resposta_esperada = fallback.resposta_esperada;
  if (!normalized.erros_comuns_usuario.length) normalized.erros_comuns_usuario = fallback.erros_comuns_usuario;
  if (!normalized.passos_se_der_erro.length) normalized.passos_se_der_erro = fallback.passos_se_der_erro;

  return normalized;
};

const extractCurrentUx = (command) => {
  const userExperience = isObject(command?.user_experience) ? command.user_experience : {};
  return {
    resumo_usuario: userExperience.resumo_usuario ?? command?.resumo_usuario ?? '',
    quando_usar: userExperience.quando_usar ?? command?.quando_usar ?? [],
    exemplos_reais: userExperience.exemplos_reais ?? command?.exemplos_reais ?? [],
    resposta_esperada: userExperience.resposta_esperada ?? command?.resposta_esperada ?? [],
    erros_comuns_usuario: userExperience.erros_comuns_usuario ?? command?.erros_comuns_usuario ?? [],
    passos_se_der_erro: userExperience.passos_se_der_erro ?? command?.passos_se_der_erro ?? [],
  };
};

const hasCompleteUx = (command) => {
  const ux = extractCurrentUx(command);
  return normalizeText(ux.resumo_usuario).length >= 8 && uniqueStrings(ux.quando_usar, { max: 10 }).length > 0 && ensureArray(ux.exemplos_reais).length > 0 && uniqueStrings(ux.resposta_esperada, { max: 10 }).length > 0 && uniqueStrings(ux.erros_comuns_usuario, { max: 10 }).length > 0 && uniqueStrings(ux.passos_se_der_erro, { max: 10 }).length > 0;
};

const buildCommandContext = ({ moduleDirName, command }) => {
  const name = normalizeText(command?.name);
  const description = normalizeText(command?.description || command?.descricao);
  const usageMethods = resolveUsageMethods(command);
  const requirements = resolveRequirements(command);
  const premium = resolvePremium(command);
  const responses = resolveResponses(command);
  const argumentsList = resolveArgs(command);
  const aliases = uniqueStrings(command?.aliases, { max: 8, maxLength: 60 });
  const category = normalizeText(command?.categoria || command?.category);
  const currentUx = extractCurrentUx(command);

  return {
    module: moduleDirName,
    name,
    aliases,
    category,
    description,
    usageMethods,
    requirements,
    premium,
    responses,
    arguments: argumentsList,
    currentUx,
  };
};

const extractJsonContent = (completion) => {
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.text?.value === 'string') return item.text.value;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
};

const generateUxWithOpenAI = async ({ client, model, context }) => {
  const userPayload = {
    objective: 'Gerar conteudo de pagina de comando focado em usuario final',
    output_keys: UX_FIELDS,
    command_context: context,
  };

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const requestPayload = {
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(userPayload, null, 2) },
        ],
      };
      if (
        !String(model || '')
          .trim()
          .toLowerCase()
          .startsWith('gpt-5')
      ) {
        requestPayload.temperature = 0.2;
      }

      const completion = await client.chat.completions.create(requestPayload);

      const content = extractJsonContent(completion);
      const parsed = JSON.parse(content);
      const validated = OUTPUT_SCHEMA.parse(parsed);
      return sanitizeUxPayload(validated, context);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(400 * attempt);
      }
    }
  }

  throw lastError || new Error('Falha ao gerar UX com OpenAI');
};

const writeFormattedJson = async (filePath, payload) => {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const prettierConfig = (await prettier.resolveConfig(filePath)) || {};
  const formatted = await prettier.format(serialized, {
    ...prettierConfig,
    parser: 'json',
    filepath: filePath,
  });
  await fs.writeFile(filePath, formatted, 'utf8');
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = normalizeText(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY nao configurada. Defina no ambiente ou no arquivo .env');
  }

  const client = new OpenAI({
    apiKey,
    timeout: 30_000,
    maxRetries: 1,
  });

  const configPaths = await listModuleConfigPaths();
  const stats = {
    scanned: 0,
    target: 0,
    updated: 0,
    skippedExisting: 0,
    failed: 0,
    filesChanged: 0,
  };

  console.log(`[ux-enrich] model=${options.model} dryRun=${options.dryRun} overwrite=${options.overwrite} limit=${Number.isFinite(options.limit) ? options.limit : 'all'} delayMs=${options.delayMs}`);

  for (const configPath of configPaths) {
    const moduleDirName = path.basename(path.dirname(configPath));
    if (options.moduleFilter && moduleDirName.toLowerCase() !== options.moduleFilter) {
      continue;
    }

    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const commands = ensureArray(parsed?.commands);

    let fileChanged = false;

    for (const command of commands) {
      if (stats.target >= options.limit) break;
      if (!isObject(command)) continue;
      if (command.enabled === false) continue;
      if (!commandMatchesFilter(command, options.commandFilter)) continue;

      stats.scanned += 1;

      if (!options.overwrite && hasCompleteUx(command)) {
        stats.skippedExisting += 1;
        continue;
      }

      const commandName = normalizeText(command.name);
      if (!commandName) continue;

      stats.target += 1;
      const context = buildCommandContext({ moduleDirName, command });

      try {
        const ux = await generateUxWithOpenAI({
          client,
          model: options.model,
          context,
        });

        const previousUx = isObject(command.user_experience) ? command.user_experience : {};
        command.user_experience = {
          ...previousUx,
          ...ux,
          resumo_usuario_origem: 'auto_ia_assistida',
          resumo_usuario_revisao_pendente: true,
        };

        stats.updated += 1;
        fileChanged = true;
        console.log(`[ux-enrich] ok ${moduleDirName}/${commandName}`);
      } catch (error) {
        stats.failed += 1;
        console.warn(`[ux-enrich] fail ${moduleDirName}/${commandName}: ${error?.message || 'erro desconhecido'}`);
      }

      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }

    if (fileChanged) {
      stats.filesChanged += 1;
      if (!options.dryRun) {
        await writeFormattedJson(configPath, parsed);
      }
      console.log(`[ux-enrich] file ${options.dryRun ? 'would-update' : 'updated'} ${path.relative(repoRoot, configPath)}`);
    }

    if (stats.target >= options.limit) break;
  }

  console.log('[ux-enrich] done');
  console.log([`scanned=${stats.scanned}`, `target=${stats.target}`, `updated=${stats.updated}`, `skipped_existing=${stats.skippedExisting}`, `failed=${stats.failed}`, `files_changed=${stats.filesChanged}`].join(' '));
};

main().catch((error) => {
  console.error(`[ux-enrich] fatal: ${error?.message || error}`);
  process.exitCode = 1;
});
