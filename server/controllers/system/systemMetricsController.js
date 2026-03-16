import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { formatDuration } from '../../http/httpRequestUtils.js';

const METRICS_ENDPOINT = process.env.METRICS_ENDPOINT || `http://127.0.0.1:${process.env.METRICS_PORT || 9102}${process.env.METRICS_PATH || '/metrics'}`;
const METRICS_TOKEN = String(process.env.METRICS_TOKEN || process.env.METRICS_API_KEY || '').trim();
const METRICS_SUMMARY_TIMEOUT_MS = Number(process.env.STICKER_SYSTEM_METRICS_TIMEOUT_MS || 1200);

const parsePrometheusLabels = (raw) => {
  if (!raw) return {};
  const labels = {};
  const regex = /(\w+)="((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    labels[match[1]] = match[2].replace(/\\"/g, '"');
  }
  return labels;
};

const parsePrometheusText = (text) => {
  const series = new Map();
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [metricPart, valuePart] = trimmed.split(/\s+/, 2);
    if (!metricPart || !valuePart) continue;
    const value = Number(valuePart);
    if (!Number.isFinite(value)) continue;

    let name = metricPart;
    let labels = {};
    const labelStart = metricPart.indexOf('{');
    if (labelStart !== -1) {
      name = metricPart.slice(0, labelStart);
      const labelBody = metricPart.slice(labelStart + 1, metricPart.lastIndexOf('}'));
      labels = parsePrometheusLabels(labelBody);
    }

    const list = series.get(name) || [];
    list.push({ labels, value });
    series.set(name, list);
  }
  return series;
};

const pickMetricValue = (series, name) => {
  const list = series.get(name) || [];
  return list.length ? list[0].value : null;
};

const sumMetricValues = (series, name) => {
  const list = series.get(name) || [];
  return list.reduce((sum, entry) => sum + (Number.isFinite(entry.value) ? entry.value : 0), 0);
};

const sumMetricValuesByLabel = (series, name, matchLabels = {}) => {
  const list = series.get(name) || [];
  return list.reduce((sum, entry) => {
    if (!Number.isFinite(entry.value)) return sum;
    for (const [labelKey, expectedValue] of Object.entries(matchLabels || {})) {
      if (String(entry?.labels?.[labelKey] || '') !== String(expectedValue)) return sum;
    }
    return sum + entry.value;
  }, 0);
};

const estimateHistogramQuantileMs = (series, metricBaseName, quantile = 0.95) => {
  const bucketSeries = series.get(`${metricBaseName}_bucket`) || [];
  if (!bucketSeries.length) return null;

  const cumulativeByLe = new Map();
  for (const entry of bucketSeries) {
    const leRaw = String(entry?.labels?.le || '').trim();
    if (!leRaw) continue;
    const le = leRaw === '+Inf' ? Number.POSITIVE_INFINITY : Number(leRaw);
    if (!Number.isFinite(le) && le !== Number.POSITIVE_INFINITY) continue;
    cumulativeByLe.set(le, (cumulativeByLe.get(le) || 0) + Number(entry.value || 0));
  }

  const sorted = Array.from(cumulativeByLe.entries()).sort((left, right) => left[0] - right[0]);
  if (!sorted.length) return null;

  const total = Number(sorted[sorted.length - 1]?.[1] || 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const target = total * Math.max(0, Math.min(1, Number(quantile) || 0.95));

  for (const [upperBound, cumulative] of sorted) {
    if (cumulative >= target) {
      if (!Number.isFinite(upperBound)) return null;
      return Number(upperBound.toFixed(2));
    }
  }

  return null;
};

const buildMetricsRequestOptions = (signal = null) => {
  const headers = {};
  if (METRICS_TOKEN) {
    headers.Authorization = `Bearer ${METRICS_TOKEN}`;
  }

  return {
    ...(signal ? { signal } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
};

export const fetchPrometheusSummary = async () => {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('fetch indisponivel');
  }

  const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), METRICS_SUMMARY_TIMEOUT_MS);

  try {
    const response = await globalThis.fetch(METRICS_ENDPOINT, buildMetricsRequestOptions(controller?.signal || null));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    const series = parsePrometheusText(text);

    const processStart = pickMetricValue(series, 'omnizap_process_start_time_seconds');
    const nowSeconds = __timeNowMs() / 1000;
    const processUptimeSeconds = Number.isFinite(processStart) ? Math.max(0, nowSeconds - processStart) : null;

    const lagP99 = pickMetricValue(series, 'omnizap_nodejs_eventloop_lag_p99_seconds');
    const dbTotal = sumMetricValues(series, 'omnizap_db_query_total');
    const dbSlow = sumMetricValues(series, 'omnizap_db_slow_queries_total');
    const http5xx = sumMetricValuesByLabel(series, 'omnizap_http_requests_total', {
      status_class: '5xx',
    });
    const httpLatencyP95 = estimateHistogramQuantileMs(series, 'omnizap_http_request_duration_ms', 0.95);

    const queueDepthSeries = series.get('omnizap_queue_depth') || [];
    const queuePeak = queueDepthSeries.reduce((max, entry) => {
      if (!Number.isFinite(entry.value)) return max;
      return Math.max(max, entry.value);
    }, 0);

    return {
      process_uptime: processUptimeSeconds !== null ? formatDuration(processUptimeSeconds) : 'n/a',
      lag_p99_ms: Number.isFinite(lagP99) ? Number((lagP99 * 1000).toFixed(2)) : null,
      db_total: Math.round(dbTotal || 0),
      db_slow: Math.round(dbSlow || 0),
      http_5xx_total: Math.round(http5xx || 0),
      http_latency_p95_ms: Number.isFinite(httpLatencyP95) ? Number(httpLatencyP95) : null,
      queue_peak: Math.round(queuePeak || 0),
    };
  } finally {
    clearTimeout(timeout);
  }
};
