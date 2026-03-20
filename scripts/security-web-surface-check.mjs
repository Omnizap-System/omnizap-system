#!/usr/bin/env node

import { nowIso as __timeNowIso } from '#time';

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rawBaseUrl = String(process.env.SECURITY_WEB_SURFACE_BASE_URL || 'https://omnizap.shop').trim() || 'https://omnizap.shop';
const reportPath = String(process.env.SECURITY_WEB_SURFACE_REPORT_PATH || './temp/security-web-surface-report.json').trim();
const requestTimeoutMs = Math.max(1_000, Number(process.env.SECURITY_WEB_SURFACE_TIMEOUT_MS || 10_000));

const toBaseOrigin = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return 'https://omnizap.shop';
  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    try {
      const parsed = new URL(`https://${raw}`);
      return parsed.origin;
    } catch {
      return 'https://omnizap.shop';
    }
  }
};

const baseOrigin = toBaseOrigin(rawBaseUrl);

const PASS = 'PASS';
const FAIL = 'FAIL';

const STATIC_REQUIRED_HEADERS = [
  'content-security-policy',
  'permissions-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
];

const API_REQUIRED_HEADERS = [
  'content-security-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
];

const checks = [
  {
    id: 1,
    name: 'Root static page has security headers',
    path: '/',
    expectedStatuses: [200],
    requiredHeaders: STATIC_REQUIRED_HEADERS,
  },
  {
    id: 2,
    name: 'Legal page has security headers',
    path: '/notice-and-takedown/',
    expectedStatuses: [200],
    requiredHeaders: STATIC_REQUIRED_HEADERS,
  },
  {
    id: 3,
    name: 'Dotenv path is not exposed',
    path: '/.env',
    forbiddenStatuses: [200],
    bodyLeakPatterns: [/DB_PASSWORD|MYSQL_PASSWORD|GITHUB_TOKEN|SECRET|PRIVATE_KEY/i],
  },
  {
    id: 4,
    name: 'Unknown path does not soft-fallback with 200',
    path: '/__security_probe_nonexistent_omnizap__.txt',
    expectedStatuses: [404],
  },
  {
    id: 5,
    name: 'Whitespace path fuzz does not return 200',
    path: '/assets%20/',
    forbiddenStatuses: [200],
  },
  {
    id: 6,
    name: 'API bootstrap keeps hardened headers',
    path: '/api/home-bootstrap',
    expectedStatuses: [200],
    requiredHeaders: API_REQUIRED_HEADERS,
  },
];

const request = async (targetPath) => {
  const normalizedPath = String(targetPath || '/').startsWith('/') ? String(targetPath || '/') : `/${String(targetPath || '/')}`;
  const url = `${baseOrigin}${normalizedPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: true,
      url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: text,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      headers: {},
      body: '',
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const summarize = (items) =>
  items.reduce(
    (acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    },
    { PASS: 0, FAIL: 0 },
  );

const runCheck = async (check) => {
  const response = await request(check.path);
  const reasons = [];

  if (!response.ok) {
    reasons.push(`network_error:${response.error || 'unknown'}`);
  }

  if (Array.isArray(check.expectedStatuses) && check.expectedStatuses.length > 0) {
    if (!check.expectedStatuses.includes(response.status)) {
      reasons.push(`unexpected_status:${response.status}`);
    }
  }

  if (Array.isArray(check.forbiddenStatuses) && check.forbiddenStatuses.length > 0) {
    if (check.forbiddenStatuses.includes(response.status)) {
      reasons.push(`forbidden_status:${response.status}`);
    }
  }

  const missingHeaders = [];
  for (const headerName of check.requiredHeaders || []) {
    const resolved = response.headers?.[headerName];
    if (!resolved) missingHeaders.push(headerName);
  }

  if (missingHeaders.length > 0) {
    reasons.push(`missing_headers:${missingHeaders.join(',')}`);
  }

  const leakPatternHit = (check.bodyLeakPatterns || []).find((pattern) => pattern.test(String(response.body || '')));
  if (leakPatternHit) {
    reasons.push(`body_leak_pattern:${String(leakPatternHit)}`);
  }

  return {
    id: check.id,
    name: check.name,
    path: check.path,
    status: reasons.length > 0 ? FAIL : PASS,
    reasons,
    evidence: {
      url: response.url,
      status: response.status,
      headers: response.headers,
      body_preview: String(response.body || '').slice(0, 240),
    },
  };
};

const writeReport = async (payload) => {
  const absolutePath = path.resolve(process.cwd(), reportPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return absolutePath;
};

const main = async () => {
  const startedAt = __timeNowIso();
  const results = [];

  for (const check of checks) {
    const result = await runCheck(check);
    results.push(result);
    console.log(`[security-web-surface] ${String(result.id).padStart(2, '0')} ${result.name}: ${result.status}`);
  }

  const summary = summarize(results);
  const endedAt = __timeNowIso();
  const report = {
    meta: {
      base_origin: baseOrigin,
      started_at: startedAt,
      ended_at: endedAt,
      timeout_ms: requestTimeoutMs,
    },
    summary,
    results,
  };

  const reportAbsolutePath = await writeReport(report);
  console.log('[security-web-surface] ---');
  console.log(`[security-web-surface] base_origin=${baseOrigin}`);
  console.log(`[security-web-surface] summary=${JSON.stringify(summary)}`);
  console.log(`[security-web-surface] report_path=${reportAbsolutePath}`);

  if ((summary.FAIL || 0) > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(`[security-web-surface] fatal_error=${error?.message || error}`);
  process.exit(1);
});
