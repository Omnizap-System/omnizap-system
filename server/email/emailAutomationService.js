import logger from '#logger';
import { enqueueEmailOutbox, getEmailOutboxStatusSnapshot } from './emailOutboxRepository.js';
import { renderEmailTemplate } from './emailTemplateService.js';
import { getEmailTransportMetadata } from './emailTransportService.js';

const normalizeEmail = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 255);

const maskEmailForLogs = (value) => {
  const normalized = normalizeEmail(value);
  const [localPartRaw, domainRaw] = normalized.split('@');
  const localPart = String(localPartRaw || '').trim();
  const domain = String(domainRaw || '').trim();
  if (!localPart || !domain) return 'invalid-email';
  const localMasked = localPart.length <= 2 ? `${localPart.charAt(0) || '*'}*` : `${localPart.slice(0, 2)}***`;
  return `${localMasked}@${domain}`;
};

const resolveEmailDomain = (value) => {
  const normalized = normalizeEmail(value);
  if (!normalized.includes('@')) return null;
  return normalized.split('@')[1] || null;
};

const normalizeOptionalText = (value, maxLength = 500_000) => {
  const normalized =
    String(value || '')
      .trim()
      .slice(0, maxLength) || '';
  return normalized || null;
};

const normalizeTemplateKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, '')
    .slice(0, 64);

const normalizePayloadObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const resolveEmailBodyFromPayload = ({ templateKey = '', templateData = {}, subject = '', text = '', html = '' } = {}) => {
  const normalizedTemplateKey = normalizeTemplateKey(templateKey);
  const normalizedTemplateData = normalizePayloadObject(templateData);

  const renderedTemplate = normalizedTemplateKey ? renderEmailTemplate(normalizedTemplateKey, normalizedTemplateData) : null;

  if (normalizedTemplateKey && !renderedTemplate && !normalizeOptionalText(subject, 180) && !normalizeOptionalText(text, 120_000) && !normalizeOptionalText(html, 500_000)) {
    const error = new Error(`Template de e-mail inválido ou indisponível: "${normalizedTemplateKey}".`);
    error.statusCode = 400;
    throw error;
  }

  const normalizedSubject = normalizeOptionalText(subject, 180) || renderedTemplate?.subject || '';
  const normalizedText = normalizeOptionalText(text, 120_000) || renderedTemplate?.text || null;
  const normalizedHtml = normalizeOptionalText(html, 500_000) || renderedTemplate?.html || null;

  if (!normalizedSubject) {
    const error = new Error('Informe o assunto ou use um template válido.');
    error.statusCode = 400;
    throw error;
  }

  if (!normalizedText && !normalizedHtml) {
    const error = new Error('Informe conteúdo de e-mail (text/html) ou use um template válido.');
    error.statusCode = 400;
    throw error;
  }

  return {
    template_key: renderedTemplate?.template_key || normalizedTemplateKey || null,
    template_payload: renderedTemplate ? normalizedTemplateData : {},
    subject: normalizedSubject,
    text_body: normalizedText,
    html_body: normalizedHtml,
  };
};

export const queueAutomatedEmail = async ({ to, name = '', templateKey = '', templateData = {}, subject = '', text = '', html = '', metadata = {}, priority = 50, scheduledAt = null, maxAttempts = 5, idempotencyKey = '' } = {}) => {
  const normalizedEmail = normalizeEmail(to);
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    const error = new Error('Destinatário de e-mail inválido.');
    error.statusCode = 400;
    throw error;
  }

  const body = resolveEmailBodyFromPayload({
    templateKey,
    templateData,
    subject,
    text,
    html,
  });

  const safeMetadata = normalizePayloadObject(metadata);

  const taskId = await enqueueEmailOutbox({
    recipientEmail: normalizedEmail,
    recipientName: normalizeOptionalText(name, 120),
    subject: body.subject,
    textBody: body.text_body,
    htmlBody: body.html_body,
    templateKey: body.template_key,
    templatePayload: body.template_payload,
    metadata: safeMetadata,
    priority,
    scheduledAt,
    maxAttempts,
    idempotencyKey,
  });

  if (!taskId) {
    const error = new Error('Não foi possível enfileirar o e-mail.');
    error.statusCode = 500;
    throw error;
  }

  logger.info('E-mail enfileirado para processamento.', {
    action: 'email_outbox_enqueued',
    task_id: taskId,
    template_key: body.template_key || null,
    recipient_email_masked: maskEmailForLogs(normalizedEmail),
    recipient_domain: resolveEmailDomain(normalizedEmail),
    subject_length: body.subject.length,
    has_text_body: Boolean(body.text_body),
    has_html_body: Boolean(body.html_body),
    metadata_keys: Object.keys(safeMetadata).slice(0, 20),
    priority: Number.isFinite(Number(priority)) ? Number(priority) : null,
    scheduled_at: scheduledAt ? String(scheduledAt) : null,
    max_attempts: Number.isFinite(Number(maxAttempts)) ? Number(maxAttempts) : null,
    idempotency_key_present: Boolean(String(idempotencyKey || '').trim()),
  });

  return {
    task_id: taskId,
    recipient_email: normalizedEmail,
    subject: body.subject,
    template_key: body.template_key || null,
  };
};

export const queueWelcomeEmail = async ({ to, name = '', loginUrl = '', redirectUrl = '', homeUrl = '', metadata = {}, idempotencyKey = '' } = {}) =>
  queueAutomatedEmail({
    to,
    name,
    templateKey: 'welcome',
    templateData: {
      name,
      loginUrl,
      redirectUrl,
      homeUrl,
    },
    metadata,
    idempotencyKey,
  });

export const getEmailAutomationStatusSnapshot = async () => {
  const queue = await getEmailOutboxStatusSnapshot();
  return {
    queue,
    transport: getEmailTransportMetadata(),
  };
};
