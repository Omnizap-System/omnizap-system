import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import fs from 'node:fs';
import path from 'node:path';
import logger from '#logger';
import { buildFunctionToolFromCommandConfig } from './commandToolBuilderService.js';

const MODULES_DIR = path.resolve(process.cwd(), 'app/modules');

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const normalizeModuleKey = (moduleDirName, moduleConfig = {}) => {
  const configModule = String(moduleConfig.module || '').trim();
  if (configModule) {
    return normalizeText(configModule.replace(/module$/i, '')) || normalizeText(moduleDirName);
  }
  return normalizeText(moduleDirName);
};

const discoverCommandConfigFiles = () => {
  const entries = [];

  let moduleDirs = [];
  try {
    moduleDirs = fs.readdirSync(MODULES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return entries;
  }

  for (const moduleDir of moduleDirs) {
    const configPath = path.join(MODULES_DIR, moduleDir.name, 'commandConfig.json');
    if (!fs.existsSync(configPath)) continue;

    try {
      const stat = fs.statSync(configPath);
      entries.push({
        moduleDir: moduleDir.name,
        configPath,
        mtimeMs: Number(stat.mtimeMs || 0),
      });
    } catch (error) {
      logger.warn('Falha ao ler stat de commandConfig para registro de tools.', {
        action: 'tool_registry_stat_failed',
        moduleDir: moduleDir.name,
        configPath,
        error: error?.message,
      });
    }
  }

  return entries.sort((a, b) => a.configPath.localeCompare(b.configPath));
};

const buildSignature = (files = []) => files.map((entry) => `${entry.configPath}:${entry.mtimeMs}`).join('|');

let cachedRegistry = null;
let cachedSignature = '';

const buildRegistrySnapshot = () => {
  const configFiles = discoverCommandConfigFiles();
  const signature = buildSignature(configFiles);

  if (cachedRegistry && signature === cachedSignature) {
    return cachedRegistry;
  }

  const records = [];
  const toolNameToRecord = new Map();

  for (const file of configFiles) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(file.configPath, 'utf8'));
    } catch (error) {
      logger.warn('Falha ao parsear commandConfig no registro global de tools.', {
        action: 'tool_registry_parse_failed',
        configPath: file.configPath,
        error: error?.message,
      });
      continue;
    }

    const moduleKey = normalizeModuleKey(file.moduleDir, parsed);
    const commandEntries = Array.isArray(parsed?.commands) ? parsed.commands : [];

    for (const commandEntry of commandEntries) {
      if (!commandEntry || commandEntry.enabled === false) continue;

      const built = buildFunctionToolFromCommandConfig({
        moduleKey,
        commandEntry,
      });
      if (!built?.tool?.function?.name) continue;

      const toolName = normalizeText(built.tool.function.name);
      if (!toolName) continue;

      if (toolNameToRecord.has(toolName)) {
        const previous = toolNameToRecord.get(toolName);
        logger.warn('Nome de tool duplicado detectado. Mantendo primeiro registro.', {
          action: 'tool_registry_duplicate_name',
          toolName,
          previousModule: previous?.moduleKey || null,
          currentModule: moduleKey,
          currentCommand: commandEntry?.name || null,
        });
        continue;
      }

      const record = {
        toolName,
        moduleKey,
        commandName: normalizeText(commandEntry.name),
        aliases: Array.isArray(commandEntry.aliases) ? commandEntry.aliases.map((alias) => normalizeText(alias)).filter(Boolean) : [],
        commandEntry,
        argumentSpecs: Array.isArray(built.argumentSpecs) ? built.argumentSpecs : [],
        tool: built.tool,
        configPath: file.configPath,
        moduleDir: file.moduleDir,
      };

      records.push(record);
      toolNameToRecord.set(toolName, record);
    }
  }

  cachedRegistry = {
    builtAt: __timeNowIso(),
    signature,
    records: records.sort((a, b) => a.toolName.localeCompare(b.toolName)),
    toolNameToRecord,
  };
  cachedSignature = signature;

  return cachedRegistry;
};

export const getAllToolRecords = () => buildRegistrySnapshot().records;

export const getAllTools = () => getAllToolRecords().map((record) => record.tool);

export const getToolRecord = (toolName) => {
  const normalized = normalizeText(toolName);
  if (!normalized) return null;
  return buildRegistrySnapshot().toolNameToRecord.get(normalized) || null;
};

export const resolveToolNameByCommand = (commandName) => {
  const normalizedCommand = normalizeText(commandName);
  if (!normalizedCommand) return null;

  const records = getAllToolRecords();
  for (const record of records) {
    if (record.commandName === normalizedCommand) return record.toolName;
    if (record.aliases.includes(normalizedCommand)) return record.toolName;
  }

  return null;
};

export const getToolRegistryStats = () => {
  const snapshot = buildRegistrySnapshot();
  return {
    builtAt: snapshot.builtAt,
    signature: snapshot.signature,
    toolCount: snapshot.records.length,
    moduleCount: new Set(snapshot.records.map((record) => record.moduleKey)).size,
  };
};

export const toolRegistry = {
  getAllTools,
  getAllToolRecords,
  getToolRecord,
  resolveToolNameByCommand,
  getToolRegistryStats,
};
