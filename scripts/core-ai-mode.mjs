#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const MANAGED_BLOCK_START = '# >>> CORE_AI_MODE_MANAGED >>>';
const MANAGED_BLOCK_END = '# <<< CORE_AI_MODE_MANAGED <<<';

const CORE_AI_FLAGS = [
  'AI_LEARNING_WORKER_ENABLED',
  'AI_HELP_CONTINUOUS_LEARNING_ENABLED',
  'COMMAND_CONFIG_ENRICHMENT_WORKER_ENABLED',
  'GLOBAL_HELP_ENABLE_WRAPPER_LLM_FALLBACK',
  'MODULE_AI_HELP_ENABLE_LLM',
  'ADMIN_AI_HELP_ENABLE_LLM',
  'AI_AI_HELP_ENABLE_LLM',
  'GAME_AI_HELP_ENABLE_LLM',
  'MENU_AI_HELP_ENABLE_LLM',
  'PLAY_AI_HELP_ENABLE_LLM',
  'QUOTE_AI_HELP_ENABLE_LLM',
  'RPG_POKEMON_AI_HELP_ENABLE_LLM',
  'STATS_AI_HELP_ENABLE_LLM',
  'STICKER_AI_HELP_ENABLE_LLM',
  'STICKER_PACK_AI_HELP_ENABLE_LLM',
  'SYSTEM_METRICS_AI_HELP_ENABLE_LLM',
  'TIKTOK_AI_HELP_ENABLE_LLM',
  'USER_AI_HELP_ENABLE_LLM',
  'WAIFUPICS_AI_HELP_ENABLE_LLM',
];

const parseArgs = (argv = []) => {
  const args = [...argv];
  let mode = 'status';
  let restart = true;
  let pm2Name = process.env.CORE_AI_PM2_NAME || 'omnizap-system-production';

  if (args[0] && !args[0].startsWith('--')) {
    mode = String(args.shift()).trim().toLowerCase();
  }

  for (const arg of args) {
    if (arg === '--no-restart') {
      restart = false;
      continue;
    }
    if (arg.startsWith('--pm2-name=')) {
      const value = String(arg.split('=').slice(1).join('=')).trim();
      if (value) pm2Name = value;
    }
  }

  return {
    mode,
    restart,
    pm2Name,
  };
};

const parseDotEnvEffectiveMap = (content) => {
  const map = new Map();
  const lines = String(content || '').split(/\r?\n/);
  const keyRegex = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = line.match(keyRegex);
    if (!match) continue;
    map.set(match[1], String(match[2] || '').trim());
  }

  return map;
};

const removeManagedBlock = (content) => {
  const lines = String(content || '').split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === MANAGED_BLOCK_START);
  if (startIndex < 0) return content;
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === MANAGED_BLOCK_END);
  if (endIndex < 0) {
    return `${lines.slice(0, startIndex).join('\n').trimEnd()}\n`;
  }
  const nextLines = [...lines.slice(0, startIndex), ...lines.slice(endIndex + 1)];
  return `${nextLines.join('\n').trimEnd()}\n`;
};

const buildManagedBlock = (value) => {
  const lines = [
    MANAGED_BLOCK_START,
    '# Gerenciado por scripts/core-ai-mode.mjs',
    ...CORE_AI_FLAGS.map((key) => `${key}=${value}`),
    MANAGED_BLOCK_END,
  ];
  return `${lines.join('\n')}\n`;
};

const writeModeToEnv = async (modeValue) => {
  const current = await fs.readFile(ENV_PATH, 'utf8');
  const withoutManaged = removeManagedBlock(current);
  const next =
    withoutManaged.trimEnd().length > 0
      ? `${withoutManaged.trimEnd()}\n\n${buildManagedBlock(modeValue)}`
      : `${buildManagedBlock(modeValue)}`;
  await fs.writeFile(ENV_PATH, next, 'utf8');
};

const computeStatus = async () => {
  const content = await fs.readFile(ENV_PATH, 'utf8');
  const map = parseDotEnvEffectiveMap(content);
  const values = CORE_AI_FLAGS.map((key) => {
    const raw = String(map.get(key) ?? '').trim().toLowerCase();
    return {
      key,
      raw: raw || '(unset)',
      bool: raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on',
      isSet: raw.length > 0,
    };
  });

  const allFalse = values.every((item) => item.isSet && item.bool === false);
  const allTrue = values.every((item) => item.isSet && item.bool === true);
  const mode = allFalse ? 'deterministic_on' : allTrue ? 'ai_on' : 'custom';

  return {
    mode,
    values,
  };
};

const restartPm2Process = ({ pm2Name, modeValue }) => {
  const envOverrides = Object.fromEntries(CORE_AI_FLAGS.map((key) => [key, modeValue]));
  const result = spawnSync('pm2', ['restart', pm2Name, '--update-env'], {
    env: {
      ...process.env,
      ...envOverrides,
    },
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Falha ao reiniciar processo PM2: ${pm2Name}`).trim());
  }
};

const printStatus = ({ mode, values }) => {
  console.log(`core_ai_mode=${mode}`);
  for (const item of values) {
    console.log(`${item.key}=${item.raw}`);
  }
};

const run = async () => {
  const { mode, restart, pm2Name } = parseArgs(process.argv.slice(2));

  if (!['on', 'off', 'status'].includes(mode)) {
    console.error('Uso: npm run core:ai -- <on|off|status> [--no-restart] [--pm2-name=<processo>]');
    process.exitCode = 1;
    return;
  }

  if (mode === 'status') {
    const status = await computeStatus();
    printStatus(status);
    return;
  }

  const modeValue = mode === 'on' ? 'false' : 'true';
  await writeModeToEnv(modeValue);

  if (restart) {
    restartPm2Process({ pm2Name, modeValue });
  }

  const status = await computeStatus();
  console.log(`core_ai_mode_updated=${mode}`);
  console.log(`pm2_restart=${restart ? 'executed' : 'skipped'}`);
  console.log(`pm2_process=${pm2Name}`);
  printStatus(status);
};

run().catch((error) => {
  console.error(`Erro ao alternar modo do core AI: ${error?.message || error}`);
  process.exitCode = 1;
});
