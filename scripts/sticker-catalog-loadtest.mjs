#!/usr/bin/env node
import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import { URL } from 'node:url';

const DEFAULT_BASE_URL = process.env.STICKER_LOADTEST_BASE_URL || 'http://127.0.0.1:9102';
const DEFAULT_PATHS = ['/api/sticker-packs?limit=24&offset=0&sort=popular', '/api/sticker-packs/stats', '/api/sticker-packs/creators?limit=25'];
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_HTTP_SLO_MS = Number(process.env.HTTP_SLO_TARGET_MS || 750);

const parseCliArgs = (argv) => {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args.set(token, true);
      continue;
    }
    args.set(token, next);
    i += 1;
  }
  return args;
};

const args = parseCliArgs(process.argv.slice(2));
const baseUrl = String(args.get('--base-url') || DEFAULT_BASE_URL)
  .trim()
  .replace(/\/+$/, '');
const durationSeconds = Math.max(5, Number(args.get('--duration-seconds') || DEFAULT_DURATION_SECONDS));
const concurrency = Math.max(1, Number(args.get('--concurrency') || DEFAULT_CONCURRENCY));
const timeoutMs = Math.max(1000, Number(args.get('--timeout-ms') || DEFAULT_TIMEOUT_MS));
const outFile = String(args.get('--out') || '').trim();
const sloMs = Math.max(50, Number(args.get('--slo-ms') || DEFAULT_HTTP_SLO_MS));
const paths = String(args.get('--paths') || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const requestPaths = paths.length ? paths : DEFAULT_PATHS;

const url = new URL(baseUrl);
const isHttps = url.protocol === 'https:';
const requestClient = isHttps ? https : http;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const quantile = (sortedValues, q) => {
  if (!sortedValues.length) return 0;
  const index = Math.max(0, Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * q)));
  return sortedValues[index];
};

const runRequest = (pathName) =>
  new Promise((resolve) => {
    const started = performance.now();
    const req = requestClient.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: pathName,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          Connection: 'keep-alive',
          Accept: 'application/json',
          'X-Viewer-Key': 'loadtest',
          'X-Session-Key': 'loadtest',
          'User-Agent': 'omnizap-sticker-loadtest/1.0',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const durationMs = performance.now() - started;
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 500,
            statusCode: Number(res.statusCode || 0),
            durationMs,
            pathName,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => {
      const durationMs = performance.now() - started;
      resolve({
        ok: false,
        statusCode: 0,
        durationMs,
        pathName,
        error: error?.message || 'request_error',
      });
    });
    req.end();
  });

const runWorker = async ({ deadlineMs, workerIndex, stats }) => {
  let requestIndex = workerIndex % requestPaths.length;
  while (__timeNowMs() < deadlineMs) {
    const pathName = requestPaths[requestIndex % requestPaths.length];
    requestIndex += 1;

    const result = await runRequest(pathName);
    stats.total += 1;
    stats.latencies.push(result.durationMs);
    stats.byStatus.set(result.statusCode, Number(stats.byStatus.get(result.statusCode) || 0) + 1);
    if (result.ok) {
      stats.success += 1;
    } else {
      stats.errors += 1;
      stats.lastErrors.push({
        path: pathName,
        status_code: result.statusCode,
        error: result.error || null,
      });
      if (stats.lastErrors.length > 10) stats.lastErrors.shift();
    }
  }
};

const main = async () => {
  const startedAt = __timeNowMs();
  const deadlineMs = startedAt + durationSeconds * 1000;
  const stats = {
    total: 0,
    success: 0,
    errors: 0,
    latencies: [],
    byStatus: new Map(),
    lastErrors: [],
  };

  console.log(`[loadtest] base_url=${baseUrl}`);
  console.log(`[loadtest] duration_seconds=${durationSeconds} concurrency=${concurrency} paths=${requestPaths.join(',')}`);
  await sleep(250);

  await Promise.all(
    Array.from({ length: concurrency }).map((_, index) =>
      runWorker({
        deadlineMs,
        workerIndex: index,
        stats,
      }),
    ),
  );

  const elapsedSeconds = Math.max(0.001, (__timeNowMs() - startedAt) / 1000);
  const sortedLatencies = [...stats.latencies].sort((a, b) => a - b);
  const p50 = quantile(sortedLatencies, 0.5);
  const p90 = quantile(sortedLatencies, 0.9);
  const p95 = quantile(sortedLatencies, 0.95);
  const p99 = quantile(sortedLatencies, 0.99);
  const throughputRps = stats.total / elapsedSeconds;
  const errorRate = stats.total > 0 ? stats.errors / stats.total : 1;

  const summary = {
    started_at: new Date(startedAt).toISOString(),
    ended_at: __timeNowIso(),
    base_url: baseUrl,
    duration_seconds: Number(elapsedSeconds.toFixed(3)),
    concurrency,
    paths: requestPaths,
    requests_total: stats.total,
    requests_success: stats.success,
    requests_error: stats.errors,
    error_rate: Number(errorRate.toFixed(6)),
    throughput_rps: Number(throughputRps.toFixed(3)),
    latency_ms: {
      p50: Number(p50.toFixed(2)),
      p90: Number(p90.toFixed(2)),
      p95: Number(p95.toFixed(2)),
      p99: Number(p99.toFixed(2)),
      max: Number((sortedLatencies[sortedLatencies.length - 1] || 0).toFixed(2)),
    },
    by_status: Object.fromEntries(stats.byStatus.entries()),
    slo: {
      target_ms: sloMs,
      p95_within_target: p95 <= sloMs,
    },
    sample_errors: stats.lastErrors,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (outFile) {
    await fs.writeFile(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(`[loadtest] report_written=${outFile}`);
  }

  if (summary.requests_total <= 0) {
    process.exitCode = 2;
    return;
  }
  if (summary.slo.p95_within_target && summary.error_rate <= 0.02) return;
  process.exitCode = 1;
};

main().catch((error) => {
  console.error('[loadtest] fatal_error', error?.message || error);
  process.exitCode = 2;
});
