#!/usr/bin/env node
import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';

import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env') });

const args = process.argv.slice(2);
const action = String(args[0] || '').trim();

const getArg = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  return String(args[index + 1] || fallback).trim();
};

const env = (...keys) => {
  for (const key of keys) {
    const value = process.env[key];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
};

const parseRepoFromRemote = () => {
  try {
    const remoteUrl = execSync('git config --get remote.origin.url', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
    if (!remoteUrl) return '';

    const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/i);
    if (httpsMatch?.[1]) return httpsMatch[1];

    const sshMatch = remoteUrl.match(/github\.com:([^/]+\/[^/.]+)(?:\.git)?$/i);
    if (sshMatch?.[1]) return sshMatch[1];
  } catch {
    return '';
  }
  return '';
};

const currentRef = () => {
  const explicitRef = env('DEPLOY_GITHUB_REF');
  if (explicitRef) return explicitRef;
  try {
    return execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim();
  } catch {
    return 'main';
  }
};

const token = env('DEPLOY_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN');
const repository = env('DEPLOY_GITHUB_REPO', 'GITHUB_REPOSITORY') || parseRepoFromRemote();
const environment = getArg('--environment', env('DEPLOY_GITHUB_ENVIRONMENT') || 'production');
const environmentUrl = getArg('--environment-url', env('DEPLOY_GITHUB_ENV_URL', 'DEPLOY_VERIFY_URL') || '');
const logUrl = getArg('--log-url', env('DEPLOY_GITHUB_LOG_URL', 'DEPLOY_VERIFY_URL') || environmentUrl);
const buildId = getArg('--build-id', env('DEPLOY_BUILD_ID') || '');
const deploymentId = getArg('--deployment-id', '');
const state = getArg('--state', '');
const description = getArg('--description', '');

if (!action || !['start', 'status'].includes(action)) {
  console.error('Uso: node scripts/github-deploy-notify.mjs <start|status> [opções]');
  process.exit(1);
}

if (!token || !repository) {
  console.error('GitHub deploy notify ignorado: token ou repositório não configurado.');
  process.exit(2);
}

const [repoOwnerRaw, repoNameRaw] = repository.split('/', 2);
const repoOwner = String(repoOwnerRaw || '').trim();
const repoName = String(repoNameRaw || '').trim();
if (!repoOwner || !repoName) {
  console.error('GitHub deploy notify ignorado: formato de repositório inválido (esperado owner/repo).');
  process.exit(2);
}

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'omnizap-deploy-script',
};

const request = async (url, method, payload) => {
  const response = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.message || raw || response.statusText;
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }

  return data;
};

const run = async () => {
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}`;

  if (action === 'start') {
    const startDescription = description || `Deploy OmniZap ${buildId || __timeNowIso()}`;
    const deployment = await request(`${baseUrl}/deployments`, 'POST', {
      ref: currentRef(),
      task: 'deploy',
      auto_merge: false,
      required_contexts: [],
      environment,
      description: startDescription,
      transient_environment: environment !== 'production',
      production_environment: environment === 'production',
    });

    await request(`${baseUrl}/deployments/${deployment.id}/statuses`, 'POST', {
      state: 'in_progress',
      environment,
      environment_url: environmentUrl || undefined,
      log_url: logUrl || undefined,
      auto_inactive: false,
      description: `Deploy iniciado (${buildId || 'manual'})`,
    });

    process.stdout.write(String(deployment.id));
    return;
  }

  if (!deploymentId || !state) {
    throw new Error('Ação status requer --deployment-id e --state.');
  }

  const finalDescription = description || `Deploy ${state} (${buildId || 'manual'})`;
  await request(`${baseUrl}/deployments/${deploymentId}/statuses`, 'POST', {
    state,
    environment,
    environment_url: environmentUrl || undefined,
    log_url: logUrl || undefined,
    auto_inactive: state === 'success',
    description: finalDescription,
  });
};

run().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
