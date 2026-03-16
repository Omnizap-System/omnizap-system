#!/usr/bin/env node
import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import 'dotenv/config';

import { closePool, executeQuery, TABLES } from '../database/index.js';
import { queueAutomatedEmail } from '../server/email/emailAutomationService.js';

const parseCliArgs = (argv = []) => {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    const next = String(argv[index + 1] || '').trim();
    if (!next || next.startsWith('--')) {
      args.set(token, true);
      continue;
    }
    args.set(token, next);
    index += 1;
  }
  return args;
};

const parseBoolArg = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parsePositiveInt = (value, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
};

const normalizeEmail = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 255);

const normalizeText = (value, maxLength = 120) =>
  String(value || '')
    .trim()
    .slice(0, maxLength);

const normalizeTag = (value, fallback) =>
  String(value || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, '')
    .slice(0, 60);

const nowIsoDate = __timeNowIso().slice(0, 10);
const args = parseCliArgs(process.argv.slice(2));

const dryRun = parseBoolArg(args.get('--dry-run'), false);
const limit = parsePositiveInt(args.get('--limit'), 0);
const termsUrlArg = normalizeText(args.get('--terms-url') || process.env.EMAIL_TERMS_URL || 'https://omnizap.shop/termos-de-uso/', 2048);
const subjectArg = normalizeText(args.get('--subject') || 'Atualização dos Termos de Serviço do OmniZap', 180);
const broadcastTag = normalizeTag(args.get('--tag') || process.env.EMAIL_TERMS_BROADCAST_TAG, nowIsoDate) || nowIsoDate;

const fetchRecipients = async ({ maxRows = 0 } = {}) => {
  const sqlParts = [`SELECT LOWER(TRIM(email)) AS recipient_email,`, `       MAX(COALESCE(NULLIF(TRIM(name), ''), '')) AS recipient_name,`, `       MAX(COALESCE(last_seen_at, last_login_at, updated_at, created_at)) AS activity_at`, `  FROM ${TABLES.STICKER_WEB_GOOGLE_USER}`, ` WHERE email IS NOT NULL`, `   AND TRIM(email) <> ''`, ` GROUP BY LOWER(TRIM(email))`, ` ORDER BY activity_at DESC`];

  const params = [];
  if (maxRows > 0) {
    sqlParts.push(' LIMIT ?');
    params.push(maxRows);
  }

  return executeQuery(sqlParts.join('\n'), params);
};

const run = async () => {
  const rows = await fetchRecipients({ maxRows: limit });
  const recipients = [];

  for (const row of rows || []) {
    const email = normalizeEmail(row?.recipient_email);
    if (!email || !email.includes('@')) continue;
    recipients.push({
      email,
      name: normalizeText(row?.recipient_name || '', 80),
    });
  }

  console.log(`[terms-broadcast] Destinatários elegíveis: ${recipients.length}`);
  console.log(`[terms-broadcast] Modo: ${dryRun ? 'dry-run' : 'queue-send'}`);
  console.log(`[terms-broadcast] Tag: ${broadcastTag}`);
  console.log(`[terms-broadcast] Termos: ${termsUrlArg}`);

  if (!recipients.length) {
    return {
      total: 0,
      queued: 0,
      failed: 0,
    };
  }

  if (dryRun) {
    const preview = recipients.slice(0, 10).map((item) => `${item.email}${item.name ? ` (${item.name})` : ''}`);
    console.log('[terms-broadcast] Preview (até 10):');
    preview.forEach((line) => console.log(` - ${line}`));
    return {
      total: recipients.length,
      queued: 0,
      failed: 0,
    };
  }

  let queued = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const idempotencyKey = `terms_update:${broadcastTag}:${recipient.email}`;

    try {
      const result = await queueAutomatedEmail({
        to: recipient.email,
        name: recipient.name,
        templateKey: 'terms_update',
        templateData: {
          name: recipient.name,
          subject: subjectArg,
          termsUrl: termsUrlArg,
        },
        metadata: {
          trigger: 'terms_update_broadcast',
          broadcast_tag: broadcastTag,
          terms_url: termsUrlArg,
        },
        priority: 85,
        maxAttempts: 5,
        idempotencyKey,
      });

      if (result?.task_id) {
        queued += 1;
        continue;
      }

      failed += 1;
      console.warn(`[terms-broadcast] Falha ao enfileirar: ${recipient.email}`);
    } catch (error) {
      failed += 1;
      console.warn(`[terms-broadcast] Erro para ${recipient.email}: ${error?.message || 'enqueue_failed'}`);
    }
  }

  return {
    total: recipients.length,
    queued,
    failed,
  };
};

run()
  .then((summary) => {
    console.log(`[terms-broadcast] Resumo: total=${summary.total} queued=${summary.queued} failed=${summary.failed}`);
  })
  .catch((error) => {
    console.error(`[terms-broadcast] Falha fatal: ${error?.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
