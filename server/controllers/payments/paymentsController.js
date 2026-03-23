import crypto from 'node:crypto';

import axios from 'axios';

import logger from '#logger';
import premiumUserStore from '../../../app/store/premiumUserStore.js';
import { isRequestSecure, readJsonBody, readRawBody, sendJson } from '../../http/httpRequestUtils.js';

const parseEnvBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseEnvInt = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

const normalizeBasePath = (value, fallback) => {
  const raw = String(value || '').trim() || fallback;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const withoutTrailingSlash = withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
  return withoutTrailingSlash || fallback;
};

const toHttpOrigin = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.origin;
  } catch {
    return '';
  }
};

const toHttpUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
};

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

const sanitizePlainString = (value, maxLength) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);

const STRIPE_PAYMENTS_ENABLED = parseEnvBool(process.env.STRIPE_PAYMENTS_ENABLED, true);
const STRIPE_SECRET_KEY = sanitizePlainString(process.env.STRIPE_SECRET_KEY, 255);
const STRIPE_WEBHOOK_SECRET = sanitizePlainString(process.env.STRIPE_WEBHOOK_SECRET, 255);
const STRIPE_PRICE_ID = sanitizePlainString(process.env.STRIPE_PRICE_ID, 255);
const STRIPE_CHECKOUT_MODE = sanitizePlainString(process.env.STRIPE_CHECKOUT_MODE || 'subscription', 24).toLowerCase() === 'payment' ? 'payment' : 'subscription';
const STRIPE_API_BASE_URL = sanitizePlainString(process.env.STRIPE_API_BASE_URL, 255) || 'https://api.stripe.com/v1';
const STRIPE_API_TIMEOUT_MS = parseEnvInt(process.env.STRIPE_API_TIMEOUT_MS, 10000, 1000, 60000);
const STRIPE_ALLOW_PROMOTION_CODES = parseEnvBool(process.env.STRIPE_ALLOW_PROMOTION_CODES, true);
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = parseEnvInt(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS, 300, 30, 7200);
const STRIPE_AUTO_REVOKE_ON_CANCELLATION = parseEnvBool(process.env.STRIPE_AUTO_REVOKE_ON_CANCELLATION, false);

const PAYMENTS_API_BASE_PATH = normalizeBasePath(process.env.PAYMENTS_API_BASE_PATH || process.env.STRIPE_PAYMENT_API_BASE_PATH, '/api/payments');
const PAYMENTS_WEB_PATH = normalizeBasePath(process.env.PAYMENTS_WEB_PATH || process.env.STRIPE_PAYMENT_WEB_PATH, '/pagamentos');
const STRIPE_CHECKOUT_SUCCESS_URL = toHttpUrl(process.env.STRIPE_CHECKOUT_SUCCESS_URL);
const STRIPE_CHECKOUT_CANCEL_URL = toHttpUrl(process.env.STRIPE_CHECKOUT_CANCEL_URL);
const STRIPE_PLAN_NAME = sanitizePlainString(process.env.STRIPE_PLAN_NAME, 120) || 'Plano Premium';
const STRIPE_PLAN_PRICE_LABEL = sanitizePlainString(process.env.STRIPE_PLAN_PRICE_LABEL, 120) || 'Assinatura recorrente';
const STRIPE_PIX_ENABLED = parseEnvBool(process.env.STRIPE_PIX_ENABLED, true);
const STRIPE_PIX_PRICE_ID = sanitizePlainString(process.env.STRIPE_PIX_PRICE_ID || STRIPE_PRICE_ID, 255);
const STRIPE_PIX_EXPIRES_AFTER_SECONDS = parseEnvInt(process.env.STRIPE_PIX_EXPIRES_AFTER_SECONDS, 86400, 10, 1209600);

const stripeHttpClient = axios.create({
  baseURL: STRIPE_API_BASE_URL,
  timeout: STRIPE_API_TIMEOUT_MS,
  validateStatus: () => true,
});

class HttpError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const createHttpError = (message, statusCode = 500, code = null) => new HttpError(message, statusCode, code);

const assertPaymentsEnabled = () => {
  if (STRIPE_PAYMENTS_ENABLED) return;
  throw createHttpError('Pagamentos Stripe estao desativados no servidor.', 503, 'stripe_payments_disabled');
};

const assertStripeCheckoutReady = () => {
  assertPaymentsEnabled();
  if (!STRIPE_SECRET_KEY) {
    throw createHttpError('STRIPE_SECRET_KEY nao configurada.', 503, 'stripe_secret_key_missing');
  }
  if (!STRIPE_PRICE_ID) {
    throw createHttpError('STRIPE_PRICE_ID nao configurado.', 503, 'stripe_price_id_missing');
  }
};

const assertStripeWebhookReady = () => {
  assertPaymentsEnabled();
  if (!STRIPE_WEBHOOK_SECRET) {
    throw createHttpError('STRIPE_WEBHOOK_SECRET nao configurado.', 503, 'stripe_webhook_secret_missing');
  }
};

const assertStripePixReady = () => {
  assertPaymentsEnabled();
  if (!STRIPE_PIX_ENABLED) {
    throw createHttpError('PIX esta desativado no servidor.', 503, 'stripe_pix_disabled');
  }
  if (!STRIPE_SECRET_KEY) {
    throw createHttpError('STRIPE_SECRET_KEY nao configurada.', 503, 'stripe_secret_key_missing');
  }
  if (!STRIPE_PIX_PRICE_ID) {
    throw createHttpError('STRIPE_PIX_PRICE_ID nao configurado.', 503, 'stripe_pix_price_id_missing');
  }
};

const resolveRequestOrigin = (req) => {
  const envOrigin = toHttpOrigin(process.env.SITE_ORIGIN) || toHttpOrigin(process.env.PUBLIC_WEB_BASE_URL) || toHttpOrigin(process.env.APP_BASE_URL);
  if (envOrigin) return envOrigin;

  const host = sanitizePlainString(req?.headers?.host, 255);
  if (!host) return 'http://localhost';

  const protocol = isRequestSecure(req) ? 'https' : 'http';
  return `${protocol}://${host}`;
};

const withCheckoutSessionPlaceholder = (url) => {
  const raw = toHttpUrl(url);
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    if (!parsed.searchParams.has('session_id')) {
      parsed.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
    }
    return parsed.toString();
  } catch {
    return raw;
  }
};

const resolveCheckoutSuccessUrl = (req) => {
  if (STRIPE_CHECKOUT_SUCCESS_URL) {
    return withCheckoutSessionPlaceholder(STRIPE_CHECKOUT_SUCCESS_URL);
  }

  const origin = resolveRequestOrigin(req);
  return `${origin}${PAYMENTS_WEB_PATH}/sucesso?session_id={CHECKOUT_SESSION_ID}`;
};

const resolveCheckoutCancelUrl = (req) => {
  if (STRIPE_CHECKOUT_CANCEL_URL) {
    return STRIPE_CHECKOUT_CANCEL_URL;
  }

  const origin = resolveRequestOrigin(req);
  return `${origin}${PAYMENTS_WEB_PATH}/cancelado`;
};

const normalizeWhatsappIdentity = (value) => {
  const raw = sanitizePlainString(value, 120).toLowerCase();
  if (!raw) {
    throw createHttpError('Informe um numero WhatsApp para ativar o Premium.', 400, 'whatsapp_required');
  }

  const normalizedJidInput = raw.endsWith('@c.us') ? raw.replace('@c.us', '@s.whatsapp.net') : raw;
  if (normalizedJidInput.includes('@')) {
    const jid = normalizedJidInput.replace(/\s+/g, '');
    if (!/^[a-z0-9._-]{5,80}@s\.whatsapp\.net$/.test(jid)) {
      throw createHttpError('WhatsApp invalido. Use numero com DDI/DD ou JID valido.', 400, 'whatsapp_invalid');
    }

    const ownerPhone = jid.split('@')[0].replace(/\D+/g, '').slice(0, 20);
    return {
      ownerJid: jid,
      ownerPhone,
    };
  }

  const digits = raw.replace(/\D+/g, '').slice(0, 20);
  if (digits.length < 10) {
    throw createHttpError('WhatsApp invalido. Envie o numero completo com DDI e DDD.', 400, 'whatsapp_invalid');
  }

  return {
    ownerJid: `${digits}@s.whatsapp.net`,
    ownerPhone: digits,
  };
};

const normalizeWhatsappIdentitySafe = (value) => {
  try {
    return normalizeWhatsappIdentity(value);
  } catch {
    return null;
  }
};

const normalizeCheckoutEmail = (value) => {
  const email = sanitizePlainString(value, 255).toLowerCase();
  if (!email) return '';
  if (!isValidEmail(email)) {
    throw createHttpError('E-mail invalido. Verifique e tente novamente.', 400, 'email_invalid');
  }
  return email;
};

const normalizeCustomerName = (value) => sanitizePlainString(value, 120);

const callStripeApi = async ({ method, path, formData = null }) => {
  if (!STRIPE_SECRET_KEY) {
    throw createHttpError('STRIPE_SECRET_KEY nao configurada.', 503, 'stripe_secret_key_missing');
  }

  const headers = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
  };

  let payload = undefined;
  if (formData) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = formData.toString();
  }

  const response = await stripeHttpClient.request({
    method,
    url: path,
    data: payload,
    headers,
  });

  if (response.status >= 200 && response.status < 300) {
    return response.data;
  }

  const upstreamStatus = Number(response.status || 0);
  const stripeErrorMessage = sanitizePlainString(response?.data?.error?.message, 255) || 'Falha na API Stripe.';
  const statusCode = upstreamStatus >= 400 && upstreamStatus < 500 ? 400 : 502;

  logger.warn('Stripe API retornou erro.', {
    action: 'stripe_api_request_failed',
    method,
    path,
    stripe_status: upstreamStatus,
    stripe_error_type: response?.data?.error?.type || null,
    stripe_error_code: response?.data?.error?.code || null,
  });

  throw createHttpError(stripeErrorMessage, statusCode, 'stripe_api_error');
};

const createStripeCheckoutSession = async ({ req, ownerJid, ownerPhone, customerEmail, customerName }) => {
  const formData = new URLSearchParams();
  formData.set('mode', STRIPE_CHECKOUT_MODE);
  formData.set('line_items[0][price]', STRIPE_PRICE_ID);
  formData.set('line_items[0][quantity]', '1');
  formData.set('success_url', resolveCheckoutSuccessUrl(req));
  formData.set('cancel_url', resolveCheckoutCancelUrl(req));
  formData.set('client_reference_id', ownerJid);
  formData.set('metadata[owner_jid]', ownerJid);
  if (ownerPhone) formData.set('metadata[owner_phone]', ownerPhone);

  if (customerEmail) formData.set('customer_email', customerEmail);
  if (customerName) formData.set('metadata[customer_name]', customerName);
  if (STRIPE_ALLOW_PROMOTION_CODES) formData.set('allow_promotion_codes', 'true');

  if (STRIPE_CHECKOUT_MODE === 'subscription') {
    formData.set('subscription_data[metadata][owner_jid]', ownerJid);
    if (ownerPhone) formData.set('subscription_data[metadata][owner_phone]', ownerPhone);
  }

  return callStripeApi({
    method: 'POST',
    path: '/checkout/sessions',
    formData,
  });
};

const getStripeCheckoutSession = async (sessionId) => {
  const normalizedSessionId = sanitizePlainString(sessionId, 255);
  if (!normalizedSessionId) {
    throw createHttpError('session_id e obrigatorio.', 400, 'session_id_required');
  }

  return callStripeApi({
    method: 'GET',
    path: `/checkout/sessions/${encodeURIComponent(normalizedSessionId)}`,
  });
};

const getStripePrice = async (priceId) => {
  const normalizedPriceId = sanitizePlainString(priceId, 255);
  if (!normalizedPriceId) {
    throw createHttpError('price_id e obrigatorio.', 400, 'price_id_required');
  }

  return callStripeApi({
    method: 'GET',
    path: `/prices/${encodeURIComponent(normalizedPriceId)}`,
  });
};

const resolvePixAmountFromPrice = (priceObject) => {
  const amount = Number(priceObject?.unit_amount);
  const currency = sanitizePlainString(priceObject?.currency, 12).toLowerCase();

  if (!Number.isInteger(amount) || amount <= 0) {
    throw createHttpError('Preco Stripe invalido para PIX (unit_amount).', 400, 'stripe_pix_price_invalid');
  }

  if (currency !== 'brl') {
    throw createHttpError('PIX exige preco em BRL.', 400, 'stripe_pix_currency_invalid');
  }

  return {
    amount,
    currency,
  };
};

const createStripePixPaymentIntent = async ({ ownerJid, ownerPhone, customerEmail, customerName }) => {
  const price = await getStripePrice(STRIPE_PIX_PRICE_ID);
  const { amount, currency } = resolvePixAmountFromPrice(price);

  const formData = new URLSearchParams();
  formData.set('amount', String(amount));
  formData.set('currency', currency);
  formData.set('confirm', 'true');
  formData.set('payment_method_types[0]', 'pix');
  formData.set('payment_method_data[type]', 'pix');
  formData.set('payment_method_options[pix][expires_after_seconds]', String(STRIPE_PIX_EXPIRES_AFTER_SECONDS));
  formData.set('description', STRIPE_PLAN_NAME);
  formData.set('metadata[owner_jid]', ownerJid);
  if (ownerPhone) formData.set('metadata[owner_phone]', ownerPhone);
  if (customerName) formData.set('metadata[customer_name]', customerName);
  if (customerEmail) {
    formData.set('metadata[customer_email]', customerEmail);
    formData.set('receipt_email', customerEmail);
    formData.set('payment_method_data[billing_details][email]', customerEmail);
  }

  try {
    return await callStripeApi({
      method: 'POST',
      path: '/payment_intents',
      formData,
    });
  } catch (error) {
    const normalizedErrorMessage = sanitizePlainString(error?.message, 255).toLowerCase();
    if (normalizedErrorMessage.includes('payment method type "pix" is invalid')) {
      throw createHttpError('PIX nao esta ativado na sua conta Stripe. Ative o metodo em Configuracoes > Payment methods.', 400, 'stripe_pix_not_activated');
    }
    throw error;
  }
};

const extractPixQrPayload = (paymentIntent = {}) => {
  const pixQr = paymentIntent?.next_action?.pix_display_qr_code || {};
  const qrPayload = {
    data: String(pixQr?.data || '').trim(),
    image_url_png: toHttpUrl(pixQr?.image_url_png),
    image_url_svg: toHttpUrl(pixQr?.image_url_svg),
    hosted_instructions_url: toHttpUrl(pixQr?.hosted_instructions_url),
    expires_at: Number.isFinite(Number(pixQr?.expires_at)) ? Number(pixQr.expires_at) : null,
  };

  if (!qrPayload.data && !qrPayload.image_url_png && !qrPayload.hosted_instructions_url) {
    throw createHttpError('Stripe nao retornou QR Code PIX para este pagamento.', 502, 'stripe_pix_qr_missing');
  }

  return qrPayload;
};

const normalizeFromMetadata = (metadata = {}, key) => sanitizePlainString(metadata?.[key], 255);

const extractOwnerJidFromStripeObject = (object = {}) => {
  if (!object || typeof object !== 'object') return '';

  const metadata = object?.metadata || {};
  const directCandidates = [normalizeFromMetadata(metadata, 'owner_jid'), sanitizePlainString(object?.client_reference_id, 255), normalizeFromMetadata(object?.subscription_details?.metadata, 'owner_jid')].filter(Boolean);

  for (const candidate of directCandidates) {
    const normalized = normalizeWhatsappIdentitySafe(candidate);
    if (normalized?.ownerJid) return normalized.ownerJid;
  }

  const phoneCandidates = [normalizeFromMetadata(metadata, 'owner_phone'), normalizeFromMetadata(object?.subscription_details?.metadata, 'owner_phone')].filter(Boolean);

  for (const phoneCandidate of phoneCandidates) {
    const normalized = normalizeWhatsappIdentitySafe(phoneCandidate);
    if (normalized?.ownerJid) return normalized.ownerJid;
  }

  const lines = Array.isArray(object?.lines?.data) ? object.lines.data : [];
  for (const line of lines) {
    const lineMetadata = line?.metadata || {};
    const lineJid = normalizeWhatsappIdentitySafe(normalizeFromMetadata(lineMetadata, 'owner_jid'));
    if (lineJid?.ownerJid) return lineJid.ownerJid;
    const linePhone = normalizeWhatsappIdentitySafe(normalizeFromMetadata(lineMetadata, 'owner_phone'));
    if (linePhone?.ownerJid) return linePhone.ownerJid;
  }

  return '';
};

const parseStripeSignatureHeader = (headerValue) => {
  const parts = String(headerValue || '')
    .split(',')
    .map((part) => String(part || '').trim())
    .filter(Boolean);

  const result = {
    timestamp: null,
    signatures: [],
  };

  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;

    if (key === 't') {
      const parsedTs = Number(value);
      if (Number.isFinite(parsedTs)) {
        result.timestamp = Math.floor(parsedTs);
      }
      continue;
    }

    if (key === 'v1') {
      result.signatures.push(value);
    }
  }

  return result;
};

const timingSafeHexEquals = (left, right) => {
  const leftHex = String(left || '').trim();
  const rightHex = String(right || '').trim();
  if (!leftHex || !rightHex || leftHex.length !== rightHex.length) return false;
  if (!/^[0-9a-f]+$/i.test(leftHex) || !/^[0-9a-f]+$/i.test(rightHex)) return false;

  try {
    const leftBuffer = Buffer.from(leftHex, 'hex');
    const rightBuffer = Buffer.from(rightHex, 'hex');
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
};

const verifyStripeWebhookSignature = (rawBodyBuffer, signatureHeader) => {
  assertStripeWebhookReady();

  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!parsed.timestamp || parsed.signatures.length === 0) {
    throw createHttpError('Stripe-Signature invalido.', 400, 'stripe_signature_invalid');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    throw createHttpError('Webhook Stripe expirado.', 400, 'stripe_signature_expired');
  }

  const signedPayload = `${parsed.timestamp}.${rawBodyBuffer.toString('utf8')}`;
  const expectedSignature = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(signedPayload).digest('hex');

  const valid = parsed.signatures.some((candidate) => timingSafeHexEquals(candidate, expectedSignature));
  if (!valid) {
    throw createHttpError('Assinatura Stripe invalida.', 400, 'stripe_signature_mismatch');
  }
};

const activatePremiumOwner = async ({ ownerJid, eventType, eventId }) => {
  if (!ownerJid) {
    return {
      action: 'ignored',
      reason: 'owner_jid_missing',
      ownerJid: '',
    };
  }

  await premiumUserStore.addPremiumUsers([ownerJid]);

  logger.info('Premium ativado via Stripe webhook.', {
    action: 'stripe_premium_activated',
    event_id: eventId,
    event_type: eventType,
    owner_jid: ownerJid,
  });

  return {
    action: 'premium_activated',
    reason: 'ok',
    ownerJid,
  };
};

const revokePremiumOwner = async ({ ownerJid, eventType, eventId }) => {
  if (!ownerJid) {
    return {
      action: 'ignored',
      reason: 'owner_jid_missing',
      ownerJid: '',
    };
  }

  await premiumUserStore.removePremiumUsers([ownerJid]);

  logger.info('Premium removido via Stripe webhook.', {
    action: 'stripe_premium_revoked',
    event_id: eventId,
    event_type: eventType,
    owner_jid: ownerJid,
  });

  return {
    action: 'premium_revoked',
    reason: 'ok',
    ownerJid,
  };
};

const shouldActivateCheckoutEvent = (sessionObject) => {
  const paymentStatus = sanitizePlainString(sessionObject?.payment_status, 32).toLowerCase();
  return paymentStatus === 'paid' || paymentStatus === 'no_payment_required';
};

const shouldActivateSubscriptionStatus = (status) => ['active', 'trialing', 'past_due'].includes(status);
const shouldDeactivateSubscriptionStatus = (status) => ['canceled', 'incomplete_expired', 'unpaid'].includes(status);

const processStripeWebhookEvent = async (event) => {
  const eventType = sanitizePlainString(event?.type, 120);
  const eventId = sanitizePlainString(event?.id, 120);
  const object = event?.data?.object || {};

  if (!eventType) {
    return {
      action: 'ignored',
      reason: 'event_type_missing',
      ownerJid: '',
    };
  }

  if (eventType === 'checkout.session.completed' || eventType === 'checkout.session.async_payment_succeeded') {
    if (eventType === 'checkout.session.completed' && !shouldActivateCheckoutEvent(object)) {
      return {
        action: 'ignored',
        reason: 'checkout_not_paid',
        ownerJid: '',
      };
    }

    const ownerJid = extractOwnerJidFromStripeObject(object);
    return activatePremiumOwner({ ownerJid, eventType, eventId });
  }

  if (eventType === 'payment_intent.succeeded') {
    const ownerJid = extractOwnerJidFromStripeObject(object);
    return activatePremiumOwner({ ownerJid, eventType, eventId });
  }

  if (eventType === 'invoice.paid' || eventType === 'invoice.payment_succeeded') {
    const ownerJid = extractOwnerJidFromStripeObject(object);
    return activatePremiumOwner({ ownerJid, eventType, eventId });
  }

  if (eventType === 'customer.subscription.created' || eventType === 'customer.subscription.updated') {
    const status = sanitizePlainString(object?.status, 48).toLowerCase();
    const ownerJid = extractOwnerJidFromStripeObject(object);

    if (shouldActivateSubscriptionStatus(status)) {
      return activatePremiumOwner({ ownerJid, eventType, eventId });
    }

    if (STRIPE_AUTO_REVOKE_ON_CANCELLATION && shouldDeactivateSubscriptionStatus(status)) {
      return revokePremiumOwner({ ownerJid, eventType, eventId });
    }

    return {
      action: 'ignored',
      reason: 'subscription_status_not_supported',
      ownerJid: ownerJid || '',
    };
  }

  if (eventType === 'customer.subscription.deleted') {
    if (!STRIPE_AUTO_REVOKE_ON_CANCELLATION) {
      return {
        action: 'ignored',
        reason: 'auto_revoke_disabled',
        ownerJid: '',
      };
    }

    const ownerJid = extractOwnerJidFromStripeObject(object);
    return revokePremiumOwner({ ownerJid, eventType, eventId });
  }

  return {
    action: 'ignored',
    reason: 'event_not_handled',
    ownerJid: '',
  };
};

const buildPublicConfigPayload = () => ({
  ok: true,
  enabled: STRIPE_PAYMENTS_ENABLED,
  api_base_path: PAYMENTS_API_BASE_PATH,
  web_path: PAYMENTS_WEB_PATH,
  checkout_mode: STRIPE_CHECKOUT_MODE,
  plan_name: STRIPE_PLAN_NAME,
  plan_price_label: STRIPE_PLAN_PRICE_LABEL,
  stripe_ready: Boolean(STRIPE_SECRET_KEY && STRIPE_PRICE_ID && STRIPE_WEBHOOK_SECRET),
  pix_enabled: STRIPE_PIX_ENABLED,
  pix_ready: Boolean(STRIPE_SECRET_KEY && STRIPE_PIX_PRICE_ID),
  pix_expires_after_seconds: STRIPE_PIX_EXPIRES_AFTER_SECONDS,
  auto_revoke_on_cancellation: STRIPE_AUTO_REVOKE_ON_CANCELLATION,
});

const handlePaymentsControllerError = (req, res, error, { pathname }) => {
  const statusCode = Number(error?.statusCode || 500);
  const code = sanitizePlainString(error?.code, 80) || null;
  const message = sanitizePlainString(error?.message, 255) || 'Falha interna no modulo de pagamentos.';

  if (statusCode >= 500) {
    logger.error('Falha no controller de pagamentos Stripe.', {
      action: 'stripe_payments_controller_failed',
      path: pathname,
      method: req?.method,
      error: error?.message,
      stack: error?.stack,
      code,
    });
  }

  return sendJson(req, res, statusCode, {
    error: message,
    code,
  });
};

export const getPaymentsRouteConfig = () => ({
  apiBasePath: PAYMENTS_API_BASE_PATH,
});

export const maybeHandlePaymentsRequest = async (req, res, { pathname, url }) => {
  if (!['GET', 'HEAD', 'POST'].includes(req.method || '')) return false;

  const healthPath = `${PAYMENTS_API_BASE_PATH}/health`;
  const configPath = `${PAYMENTS_API_BASE_PATH}/config`;
  const checkoutPath = `${PAYMENTS_API_BASE_PATH}/checkout-session`;
  const pixQrPath = `${PAYMENTS_API_BASE_PATH}/pix-qr`;
  const webhookPath = `${PAYMENTS_API_BASE_PATH}/webhook`;
  const sessionStatusPath = `${PAYMENTS_API_BASE_PATH}/session-status`;

  try {
    if (pathname === healthPath) {
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }

      return sendJson(req, res, 200, {
        ok: true,
        payments_enabled: STRIPE_PAYMENTS_ENABLED,
        stripe_checkout_ready: Boolean(STRIPE_SECRET_KEY && STRIPE_PRICE_ID),
        stripe_webhook_ready: Boolean(STRIPE_WEBHOOK_SECRET),
        stripe_pix_ready: Boolean(STRIPE_SECRET_KEY && STRIPE_PIX_PRICE_ID),
        api_base_path: PAYMENTS_API_BASE_PATH,
      });
    }

    if (pathname === configPath) {
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }

      return sendJson(req, res, 200, buildPublicConfigPayload());
    }

    if (pathname === checkoutPath) {
      if (req.method !== 'POST') {
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }

      assertStripeCheckoutReady();
      const body = await readJsonBody(req, { maxBytes: 32 * 1024 });
      const identity = normalizeWhatsappIdentity(body?.whatsapp || body?.owner_jid || body?.ownerPhone || body?.phone);
      const customerEmail = normalizeCheckoutEmail(body?.email);
      const customerName = normalizeCustomerName(body?.name);

      const checkoutSession = await createStripeCheckoutSession({
        req,
        ownerJid: identity.ownerJid,
        ownerPhone: identity.ownerPhone,
        customerEmail,
        customerName,
      });

      if (!checkoutSession?.url) {
        throw createHttpError('Stripe nao retornou URL de checkout.', 502, 'stripe_checkout_url_missing');
      }

      return sendJson(req, res, 201, {
        ok: true,
        checkout_url: checkoutSession.url,
        session_id: checkoutSession.id || null,
        owner_jid: identity.ownerJid,
      });
    }

    if (pathname === pixQrPath) {
      if (req.method !== 'POST') {
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }

      assertStripePixReady();
      const body = await readJsonBody(req, { maxBytes: 32 * 1024 });
      const identity = normalizeWhatsappIdentity(body?.whatsapp || body?.owner_jid || body?.ownerPhone || body?.phone);
      const customerEmail = normalizeCheckoutEmail(body?.email);
      if (!customerEmail) {
        throw createHttpError('E-mail obrigatorio para gerar o PIX.', 400, 'stripe_pix_email_required');
      }
      const customerName = normalizeCustomerName(body?.name);

      const paymentIntent = await createStripePixPaymentIntent({
        ownerJid: identity.ownerJid,
        ownerPhone: identity.ownerPhone,
        customerEmail,
        customerName,
      });

      const pixQr = extractPixQrPayload(paymentIntent);

      return sendJson(req, res, 201, {
        ok: true,
        mode: 'pix',
        payment_intent_id: paymentIntent?.id || null,
        payment_status: paymentIntent?.status || null,
        owner_jid: identity.ownerJid,
        pix_qr: pixQr,
      });
    }

    if (pathname === sessionStatusPath) {
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }

      assertStripeCheckoutReady();
      const sessionId = sanitizePlainString(url?.searchParams?.get('session_id') || '', 255);
      if (!sessionId) {
        throw createHttpError('session_id e obrigatorio.', 400, 'session_id_required');
      }

      const session = await getStripeCheckoutSession(sessionId);

      return sendJson(req, res, 200, {
        ok: true,
        session: {
          id: session?.id || null,
          status: session?.status || null,
          payment_status: session?.payment_status || null,
          customer_email: session?.customer_details?.email || session?.customer_email || null,
          mode: session?.mode || null,
        },
      });
    }

    if (pathname === webhookPath) {
      if (req.method !== 'POST') {
        return sendJson(req, res, 405, { error: 'Method Not Allowed' });
      }

      assertStripeWebhookReady();
      const rawBody = await readRawBody(req, { maxBytes: 1024 * 1024 });
      const signatureHeader = sanitizePlainString(req.headers?.['stripe-signature'], 1024);
      verifyStripeWebhookSignature(rawBody, signatureHeader);

      let eventPayload;
      try {
        eventPayload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw createHttpError('Payload JSON do webhook invalido.', 400, 'stripe_webhook_json_invalid');
      }

      const processing = await processStripeWebhookEvent(eventPayload);
      return sendJson(req, res, 200, {
        received: true,
        event_id: sanitizePlainString(eventPayload?.id, 120) || null,
        action: processing?.action || 'ignored',
        reason: processing?.reason || null,
        owner_jid: processing?.ownerJid || null,
      });
    }

    return false;
  } catch (error) {
    return handlePaymentsControllerError(req, res, error, { pathname });
  }
};
