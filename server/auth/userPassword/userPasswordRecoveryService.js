import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { createHash, pbkdf2 as pbkdf2Callback, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(pbkdf2Callback);

const clampInt = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
};

const normalizeGoogleSubject = (value) =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);

const normalizeEmail = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 255);

const normalizeJid = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .slice(0, 255);

const normalizePurpose = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'setup') return 'setup';
  return 'reset';
};

const normalizeIp = (value) =>
  String(value || '')
    .trim()
    .slice(0, 64);

const normalizeUserAgent = (value) =>
  String(value || '')
    .trim()
    .slice(0, 255);

const normalizeCode = (value) => {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits.slice(0, 6);
};

const maskEmail = (value) => {
  const normalized = normalizeEmail(value);
  if (!normalized || !normalized.includes('@')) return null;
  const [localRaw, domainRaw] = normalized.split('@');
  const local = String(localRaw || '');
  const domain = String(domainRaw || '');
  if (!local || !domain) return null;
  const maskedLocal = local.length <= 2 ? `${local.charAt(0) || '*'}*` : `${local.slice(0, 2)}***`;
  const [domainHead, ...domainRest] = domain.split('.');
  const maskedDomainHead = domainHead.length <= 2 ? `${domainHead.charAt(0) || '*'}*` : `${domainHead.slice(0, 2)}***`;
  const domainSuffix = domainRest.length ? `.${domainRest.join('.')}` : '';
  return `${maskedLocal}@${maskedDomainHead}${domainSuffix}`;
};

const buildHttpError = (message, { statusCode = 400, code = 'BAD_REQUEST', details = undefined } = {}) => {
  const error = new Error(String(message || 'Erro interno.'));
  error.statusCode = Number(statusCode) || 400;
  error.code = String(code || 'BAD_REQUEST');
  if (details !== undefined) {
    error.details = details;
  }
  return error;
};

const normalizeIdentity = ({ googleSub = '', email = '', ownerJid = '' } = {}) => {
  const normalizedGoogleSub = normalizeGoogleSubject(googleSub);
  const normalizedEmail = normalizeEmail(email);
  const normalizedOwnerJid = normalizeJid(ownerJid);
  return {
    googleSub: normalizedGoogleSub,
    email: normalizedEmail,
    ownerJid: normalizedOwnerJid,
    hasIdentity: Boolean(normalizedGoogleSub || normalizedEmail || normalizedOwnerJid),
  };
};

const buildIdentityFilterClause = ({ googleSub = '', email = '', ownerJid = '' } = {}, tableAlias = 'c') => {
  const clauses = [];
  const params = [];

  if (googleSub) {
    clauses.push(`${tableAlias}.google_sub = ?`);
    params.push(googleSub);
  }

  if (email) {
    clauses.push(`${tableAlias}.email = ?`);
    params.push(email);
  }

  if (ownerJid) {
    clauses.push(`${tableAlias}.owner_jid = ?`);
    params.push(ownerJid);
  }

  if (!clauses.length) return null;
  return {
    clause: clauses.join(' OR '),
    params,
  };
};

const normalizeRecoveryRow = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: Number(row.id || 0),
    google_sub: normalizeGoogleSubject(row.google_sub),
    email: normalizeEmail(row.email),
    owner_jid: normalizeJid(row.owner_jid),
    purpose: normalizePurpose(row.purpose),
    code_hash: String(row.code_hash || '')
      .trim()
      .toLowerCase()
      .slice(0, 64),
    attempts: Math.max(0, Number(row.attempts || 0)),
    max_attempts: Math.max(1, Number(row.max_attempts || 1)),
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    consumed_at: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
    revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    last_attempt_at: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
  };
};

const generateSixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

const secureHexEquals = (leftHex, rightHex) => {
  const left = String(leftHex || '').trim();
  const right = String(rightHex || '').trim();
  if (!left || !right) return false;

  let leftBuffer;
  let rightBuffer;
  try {
    leftBuffer = Buffer.from(left, 'hex');
    rightBuffer = Buffer.from(right, 'hex');
  } catch {
    return false;
  }

  if (!leftBuffer.length || !rightBuffer.length || leftBuffer.length !== rightBuffer.length) return false;

  try {
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
};

const DEFAULT_CODE_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RESEND_COOLDOWN_SECONDS = 60;
const DEFAULT_HOURLY_REQUEST_LIMIT = 4;
const DEFAULT_DAILY_REQUEST_LIMIT = 8;
const DEFAULT_RECOVERY_HASH_ITERATIONS = 210_000;
const MIN_RECOVERY_HASH_ITERATIONS = 100_000;
const MAX_RECOVERY_HASH_ITERATIONS = 2_000_000;
const RECOVERY_HASH_KEYLEN_BYTES = 32;

export const createUserPasswordRecoveryService = ({ executeQuery, userPasswordAuthService, queueAutomatedEmail = null, revokeWebSessionsByIdentity = null, tables = {}, logger = null, runSqlTransaction = null } = {}) => {
  if (typeof executeQuery !== 'function') {
    throw new TypeError('createUserPasswordRecoveryService requer executeQuery valido.');
  }

  if (!userPasswordAuthService || typeof userPasswordAuthService.findKnownGoogleUserByIdentity !== 'function' || typeof userPasswordAuthService.setPasswordForIdentity !== 'function' || typeof userPasswordAuthService.validatePassword !== 'function') {
    throw new TypeError('createUserPasswordRecoveryService requer userPasswordAuthService valido.');
  }

  const recoveryTable = String(tables.STICKER_WEB_USER_PASSWORD_RECOVERY_CODE || 'web_user_password_recovery_code').trim() || 'web_user_password_recovery_code';
  const ttlSeconds = clampInt(process.env.WEB_USER_PASSWORD_RECOVERY_CODE_TTL_SECONDS, DEFAULT_CODE_TTL_SECONDS, 180, 60 * 60);
  const maxAttempts = clampInt(process.env.WEB_USER_PASSWORD_RECOVERY_CODE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 10);
  const resendCooldownSeconds = clampInt(process.env.WEB_USER_PASSWORD_RECOVERY_CODE_RESEND_COOLDOWN_SECONDS, DEFAULT_RESEND_COOLDOWN_SECONDS, 15, 10 * 60);
  const hourlyRequestLimit = clampInt(process.env.WEB_USER_PASSWORD_RECOVERY_CODE_HOURLY_LIMIT, DEFAULT_HOURLY_REQUEST_LIMIT, 1, 30);
  const dailyRequestLimit = clampInt(process.env.WEB_USER_PASSWORD_RECOVERY_CODE_DAILY_LIMIT, DEFAULT_DAILY_REQUEST_LIMIT, 1, 40);
  const recoveryHashIterations = clampInt(process.env.WEB_USER_PASSWORD_RECOVERY_HASH_ITERATIONS, DEFAULT_RECOVERY_HASH_ITERATIONS, MIN_RECOVERY_HASH_ITERATIONS, MAX_RECOVERY_HASH_ITERATIONS);
  const hashSecret =
    String(process.env.WEB_USER_PASSWORD_RECOVERY_HASH_SECRET || process.env.WEB_AUTH_JWT_SECRET || process.env.WHATSAPP_LOGIN_LINK_SECRET || '')
      .trim()
      .slice(0, 512) || randomUUID();

  if (!process.env.WEB_USER_PASSWORD_RECOVERY_HASH_SECRET && !process.env.WEB_AUTH_JWT_SECRET && !process.env.WHATSAPP_LOGIN_LINK_SECRET && logger && typeof logger.warn === 'function') {
    logger.warn('Segredo dedicado de recuperacao de senha nao configurado. Usando segredo efemero em memoria.', {
      action: 'web_user_password_recovery_secret_fallback',
    });
  }

  const withTransaction = async (handler) => {
    if (typeof runSqlTransaction === 'function') {
      return runSqlTransaction(handler);
    }
    return handler(null);
  };

  const buildSensitiveMetadataHash = (value, { scope = 'generic' } = {}) => {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) return null;
    return createHash('sha256').update(`${hashSecret}|recovery_sensitive|${scope}|${normalizedValue}`).digest();
  };

  const buildCodeHashV2 = async ({ code = '', googleSub = '', email = '', purpose = 'reset' } = {}) => {
    const normalizedPurpose = normalizePurpose(purpose);
    const normalizedGoogleSub = normalizeGoogleSubject(googleSub);
    const normalizedEmail = normalizeEmail(email);
    const normalizedCode = normalizeCode(code);

    const material = `${normalizedPurpose}|${normalizedGoogleSub}|${normalizedEmail}|${normalizedCode}`;
    const salt = `${hashSecret}|web_user_password_recovery_code|v2`;
    const derived = await pbkdf2(material, salt, recoveryHashIterations, RECOVERY_HASH_KEYLEN_BYTES, 'sha256');
    return Buffer.from(derived).toString('hex');
  };

  const buildCodeHashV3 = async ({ code = '', googleSub = '', purpose = 'reset' } = {}) => {
    const normalizedPurpose = normalizePurpose(purpose);
    const normalizedGoogleSub = normalizeGoogleSubject(googleSub);
    const normalizedCode = normalizeCode(code);

    const material = `${normalizedPurpose}|${normalizedGoogleSub}|${normalizedCode}`;
    const salt = `${hashSecret}|web_user_password_recovery_code|v3`;
    const derived = await pbkdf2(material, salt, recoveryHashIterations, RECOVERY_HASH_KEYLEN_BYTES, 'sha256');
    return Buffer.from(derived).toString('hex');
  };

  const findLatestActiveCodeByIdentity = async ({ googleSub = '', email = '', ownerJid = '', purpose = '' } = {}, connection = null) => {
    const normalizedIdentity = normalizeIdentity({ googleSub, email, ownerJid });
    if (!normalizedIdentity.hasIdentity) return null;

    const filter = buildIdentityFilterClause(normalizedIdentity, 'c');
    if (!filter) return null;

    const normalizedPurpose = String(purpose || '')
      .trim()
      .toLowerCase();
    const purposeClause = normalizedPurpose ? 'AND c.purpose = ?' : '';
    const params = normalizedPurpose ? [...filter.params, normalizedPurpose] : [...filter.params];

    const rows = await executeQuery(
      `SELECT
         c.id,
         c.google_sub,
         c.email,
         c.owner_jid,
         c.purpose,
         c.code_hash,
         c.attempts,
         c.max_attempts,
         c.last_attempt_at,
         c.expires_at,
         c.consumed_at,
         c.revoked_at,
         c.created_at
       FROM ${recoveryTable} c
      WHERE (${filter.clause})
        ${purposeClause}
        AND c.revoked_at IS NULL
        AND c.consumed_at IS NULL
        AND c.expires_at > UTC_TIMESTAMP()
      ORDER BY c.id DESC
      LIMIT 1`,
      params,
      connection,
    );

    return normalizeRecoveryRow(Array.isArray(rows) ? rows[0] : null);
  };

  const countRequestsByGoogleSubInWindow = async (googleSub, windowSeconds, connection = null) => {
    const normalizedGoogleSub = normalizeGoogleSubject(googleSub);
    if (!normalizedGoogleSub) return 0;
    const safeWindowSeconds = clampInt(windowSeconds, 24 * 60 * 60, 60, 7 * 24 * 60 * 60);

    const rows = await executeQuery(
      `SELECT COUNT(*) AS total
         FROM ${recoveryTable}
        WHERE google_sub = ?
          AND created_at >= (UTC_TIMESTAMP() - INTERVAL ${safeWindowSeconds} SECOND)`,
      [normalizedGoogleSub],
      connection,
    );
    return Math.max(0, Number(rows?.[0]?.total || 0));
  };

  const countDailyRequestsByGoogleSub = async (googleSub, connection = null) => countRequestsByGoogleSubInWindow(googleSub, 24 * 60 * 60, connection);

  const countHourlyRequestsByGoogleSub = async (googleSub, connection = null) => countRequestsByGoogleSubInWindow(googleSub, 60 * 60, connection);

  const getRetryAfterForWindowByGoogleSub = async (googleSub, windowSeconds, connection = null) => {
    const normalizedGoogleSub = normalizeGoogleSubject(googleSub);
    if (!normalizedGoogleSub) return clampInt(windowSeconds, 60, 1, 7 * 24 * 60 * 60);
    const safeWindowSeconds = clampInt(windowSeconds, 24 * 60 * 60, 60, 7 * 24 * 60 * 60);

    const rows = await executeQuery(
      `SELECT MIN(created_at) AS oldest_created_at
         FROM ${recoveryTable}
        WHERE google_sub = ?
          AND created_at >= (UTC_TIMESTAMP() - INTERVAL ${safeWindowSeconds} SECOND)`,
      [normalizedGoogleSub],
      connection,
    );
    const oldestCreatedAt = rows?.[0]?.oldest_created_at ? Date.parse(rows[0].oldest_created_at) : NaN;
    if (!Number.isFinite(oldestCreatedAt)) return safeWindowSeconds;

    const elapsedSeconds = Math.max(0, Math.floor((__timeNowMs() - oldestCreatedAt) / 1000));
    return Math.max(1, safeWindowSeconds - elapsedSeconds);
  };

  const getRecentRequestWithinCooldown = async (googleSub, connection = null) => {
    const normalizedGoogleSub = normalizeGoogleSubject(googleSub);
    if (!normalizedGoogleSub) return null;

    const rows = await executeQuery(
      `SELECT id, created_at
         FROM ${recoveryTable}
        WHERE google_sub = ?
          AND created_at >= (UTC_TIMESTAMP() - INTERVAL ${resendCooldownSeconds} SECOND)
        ORDER BY id DESC
        LIMIT 1`,
      [normalizedGoogleSub],
      connection,
    );

    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    const createdAtMs = row.created_at ? Date.parse(row.created_at) : NaN;
    const elapsedSeconds = Number.isFinite(createdAtMs) ? Math.max(0, Math.floor((__timeNowMs() - createdAtMs) / 1000)) : resendCooldownSeconds;
    const retryAfterSeconds = Math.max(0, resendCooldownSeconds - elapsedSeconds);
    return {
      id: Number(row.id || 0),
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      retry_after_seconds: retryAfterSeconds,
    };
  };

  const revokeActiveCodesForGoogleSub = async (googleSub, connection = null) => {
    const normalizedGoogleSub = normalizeGoogleSubject(googleSub);
    if (!normalizedGoogleSub) return 0;

    const result = await executeQuery(
      `UPDATE ${recoveryTable}
          SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()),
              updated_at = UTC_TIMESTAMP()
        WHERE google_sub = ?
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > UTC_TIMESTAMP()`,
      [normalizedGoogleSub],
      connection,
    );

    return Number(result?.affectedRows || 0);
  };

  const requestPasswordRecoveryCode = async ({ googleSub = '', email = '', ownerJid = '', purpose = 'reset', requestMeta = {} } = {}, connection = null) => {
    const identity = normalizeIdentity({ googleSub, email, ownerJid });
    if (!identity.hasIdentity) {
      throw buildHttpError('Informe google_sub, email ou owner_jid.', {
        statusCode: 400,
        code: 'IDENTITY_REQUIRED',
      });
    }

    const knownUser = await userPasswordAuthService.findKnownGoogleUserByIdentity(identity, connection);
    if (!knownUser?.google_sub) {
      return {
        accepted: true,
        queued: false,
        expires_in_seconds: ttlSeconds,
        masked_email: null,
      };
    }

    const recipientEmail = normalizeEmail(knownUser.email || identity.email);
    if (!recipientEmail || !recipientEmail.includes('@')) {
      return {
        accepted: true,
        queued: false,
        expires_in_seconds: ttlSeconds,
        masked_email: null,
      };
    }

    if (typeof queueAutomatedEmail !== 'function') {
      throw buildHttpError('Servico de e-mail indisponivel para recuperacao de senha.', {
        statusCode: 503,
        code: 'EMAIL_AUTOMATION_UNAVAILABLE',
      });
    }

    const requestsInLastDay = await countDailyRequestsByGoogleSub(knownUser.google_sub, connection);
    if (requestsInLastDay >= dailyRequestLimit) {
      const retryAfterSeconds = await getRetryAfterForWindowByGoogleSub(knownUser.google_sub, 24 * 60 * 60, connection).catch(() => 24 * 60 * 60);
      throw buildHttpError('Limite diario de solicitacoes atingido. Tente novamente amanha.', {
        statusCode: 429,
        code: 'PASSWORD_RECOVERY_DAILY_LIMIT',
        details: {
          retry_after_seconds: retryAfterSeconds,
          limit: dailyRequestLimit,
          window_seconds: 24 * 60 * 60,
        },
      });
    }

    const requestsInLastHour = await countHourlyRequestsByGoogleSub(knownUser.google_sub, connection);
    if (requestsInLastHour >= hourlyRequestLimit) {
      const retryAfterSeconds = await getRetryAfterForWindowByGoogleSub(knownUser.google_sub, 60 * 60, connection).catch(() => 60 * 60);
      throw buildHttpError('Muitas solicitacoes em pouco tempo. Aguarde alguns minutos para tentar novamente.', {
        statusCode: 429,
        code: 'PASSWORD_RECOVERY_HOURLY_LIMIT',
        details: {
          retry_after_seconds: retryAfterSeconds,
          limit: hourlyRequestLimit,
          window_seconds: 60 * 60,
        },
      });
    }

    const recentRequest = await getRecentRequestWithinCooldown(knownUser.google_sub, connection);
    if (recentRequest?.id) {
      const retryAfterSeconds = Math.max(1, Number(recentRequest.retry_after_seconds || resendCooldownSeconds));
      throw buildHttpError(`Aguarde ${retryAfterSeconds}s antes de solicitar um novo codigo.`, {
        statusCode: 429,
        code: 'PASSWORD_RECOVERY_COOLDOWN_ACTIVE',
        details: {
          retry_after_seconds: retryAfterSeconds,
          cooldown_seconds: resendCooldownSeconds,
        },
      });
    }

    const verificationCode = generateSixDigitCode();
    const normalizedPurpose = normalizePurpose(purpose);
    const codeHash = await buildCodeHashV3({
      code: verificationCode,
      googleSub: knownUser.google_sub,
      purpose: normalizedPurpose,
    });
    const recipientEmailHash = buildSensitiveMetadataHash(recipientEmail, { scope: 'email' });
    const requestIpHash = buildSensitiveMetadataHash(normalizeIp(requestMeta?.remoteIp), {
      scope: 'ip',
    });
    const requestUserAgentHash = buildSensitiveMetadataHash(normalizeUserAgent(requestMeta?.userAgent), { scope: 'user_agent' });

    await revokeActiveCodesForGoogleSub(knownUser.google_sub, connection);

    await executeQuery(
      `INSERT INTO ${recoveryTable}
        (
          google_sub,
          email,
          email_hash,
          owner_jid,
          purpose,
          code_hash,
          attempts,
          max_attempts,
          requested_ip,
          requested_ip_hash,
          requested_user_agent,
          requested_user_agent_hash,
          expires_at
        )
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ${ttlSeconds} SECOND)`,
      [knownUser.google_sub, '', recipientEmailHash, normalizeJid(knownUser.owner_jid || identity.ownerJid) || null, normalizedPurpose, codeHash, maxAttempts, null, requestIpHash, null, requestUserAgentHash],
      connection,
    );

    try {
      await queueAutomatedEmail({
        to: recipientEmail,
        name: knownUser.name || '',
        templateKey: 'password_reset_code',
        templateData: {
          name: knownUser.name || '',
          code: verificationCode,
          email: recipientEmail,
          purpose: normalizedPurpose,
          expiresInMinutes: Math.max(1, Math.ceil(ttlSeconds / 60)),
        },
        metadata: {
          trigger: 'web_user_password_recovery_code',
          purpose: normalizedPurpose,
          google_sub: knownUser.google_sub,
          owner_jid: normalizeJid(knownUser.owner_jid || '') || null,
          remote_ip: normalizeIp(requestMeta?.remoteIp) || null,
        },
        priority: 95,
        idempotencyKey: `web_user_password_recovery:${knownUser.google_sub}:${normalizedPurpose}:${__timeNowIso().slice(0, 16)}`,
      });
    } catch (error) {
      await executeQuery(
        `UPDATE ${recoveryTable}
            SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()),
                updated_at = UTC_TIMESTAMP()
          WHERE google_sub = ?
            AND code_hash = ?
            AND consumed_at IS NULL
            AND revoked_at IS NULL`,
        [knownUser.google_sub, codeHash],
        connection,
      ).catch(() => {});

      if (logger && typeof logger.warn === 'function') {
        logger.warn('Falha ao enfileirar e-mail de recuperacao de senha.', {
          action: 'web_user_password_recovery_email_enqueue_failed',
          google_sub: knownUser.google_sub,
          email: recipientEmail,
          error: error?.message,
        });
      }

      throw buildHttpError('Falha ao enviar codigo de verificacao por e-mail.', {
        statusCode: 502,
        code: 'RECOVERY_EMAIL_SEND_FAILED',
      });
    }

    return {
      accepted: true,
      queued: true,
      expires_in_seconds: ttlSeconds,
      masked_email: maskEmail(recipientEmail),
    };
  };

  const verifyPasswordRecoveryCode = async ({ googleSub = '', email = '', ownerJid = '', purpose = '', code = '', password = '', requestMeta = {} } = {}) => {
    const identity = normalizeIdentity({ googleSub, email, ownerJid });
    if (!identity.hasIdentity) {
      throw buildHttpError('Informe google_sub, email ou owner_jid.', {
        statusCode: 400,
        code: 'IDENTITY_REQUIRED',
      });
    }

    const normalizedCode = normalizeCode(code);
    if (!/^\d{6}$/.test(normalizedCode)) {
      throw buildHttpError('Codigo de verificacao invalido.', {
        statusCode: 400,
        code: 'INVALID_VERIFICATION_CODE',
      });
    }

    const passwordValidation = userPasswordAuthService.validatePassword(password);
    if (!passwordValidation?.valid) {
      throw buildHttpError(passwordValidation?.errors?.[0]?.message || 'Senha invalida.', {
        statusCode: 400,
        code: 'INVALID_PASSWORD',
        details: Array.isArray(passwordValidation?.errors) ? passwordValidation.errors : undefined,
      });
    }

    const knownUser = await userPasswordAuthService.findKnownGoogleUserByIdentity(identity);
    if (!knownUser?.google_sub) {
      throw buildHttpError('Codigo de verificacao invalido ou expirado.', {
        statusCode: 401,
        code: 'INVALID_VERIFICATION_CODE',
      });
    }

    const normalizedPurpose = String(purpose || '').trim() ? normalizePurpose(purpose) : '';
    const activeCode = await findLatestActiveCodeByIdentity(
      {
        googleSub: knownUser.google_sub,
        email: knownUser.email || identity.email,
        ownerJid: knownUser.owner_jid || identity.ownerJid,
        purpose: normalizedPurpose,
      },
      null,
    );

    if (!activeCode?.id || !activeCode.google_sub) {
      throw buildHttpError('Codigo de verificacao invalido ou expirado.', {
        statusCode: 401,
        code: 'INVALID_VERIFICATION_CODE',
      });
    }

    const expectedHashV3 = await buildCodeHashV3({
      code: normalizedCode,
      googleSub: activeCode.google_sub,
      purpose: activeCode.purpose,
    });
    let isCodeValid = secureHexEquals(expectedHashV3, activeCode.code_hash);

    if (!isCodeValid && activeCode.email) {
      const expectedHashV2 = await buildCodeHashV2({
        code: normalizedCode,
        googleSub: activeCode.google_sub,
        email: activeCode.email,
        purpose: activeCode.purpose,
      });
      isCodeValid = secureHexEquals(expectedHashV2, activeCode.code_hash);
    }

    if (!isCodeValid) {
      await executeQuery(
        `UPDATE ${recoveryTable}
            SET attempts = attempts + 1,
                last_attempt_at = UTC_TIMESTAMP(),
                revoked_at = IF(attempts + 1 >= max_attempts, COALESCE(revoked_at, UTC_TIMESTAMP()), revoked_at),
                updated_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [activeCode.id],
      ).catch(() => {});

      throw buildHttpError('Codigo de verificacao invalido ou expirado.', {
        statusCode: 401,
        code: 'INVALID_VERIFICATION_CODE',
      });
    }

    const credential = await withTransaction(async (connection) => {
      const consumeResult = await executeQuery(
        `UPDATE ${recoveryTable}
            SET consumed_at = UTC_TIMESTAMP(),
                last_attempt_at = UTC_TIMESTAMP(),
                updated_at = UTC_TIMESTAMP()
          WHERE id = ?
            AND consumed_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > UTC_TIMESTAMP()`,
        [activeCode.id],
        connection,
      );

      if (Number(consumeResult?.affectedRows || 0) <= 0) {
        throw buildHttpError('Codigo de verificacao invalido ou expirado.', {
          statusCode: 401,
          code: 'INVALID_VERIFICATION_CODE',
        });
      }

      const updatedCredential = await userPasswordAuthService.setPasswordForIdentity(
        {
          googleSub: activeCode.google_sub,
          email: knownUser.email || activeCode.email,
          ownerJid: activeCode.owner_jid || knownUser.owner_jid,
          password,
        },
        connection,
      );

      await userPasswordAuthService
        .clearFailuresForIdentity(
          {
            googleSub: activeCode.google_sub,
          },
          connection,
        )
        .catch(() => null);

      await executeQuery(
        `UPDATE ${recoveryTable}
            SET requested_ip = NULL,
                requested_ip_hash = COALESCE(?, requested_ip_hash),
                requested_user_agent = NULL,
                requested_user_agent_hash = COALESCE(?, requested_user_agent_hash),
                updated_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [
          buildSensitiveMetadataHash(normalizeIp(requestMeta?.remoteIp), {
            scope: 'ip',
          }),
          buildSensitiveMetadataHash(normalizeUserAgent(requestMeta?.userAgent), {
            scope: 'user_agent',
          }),
          activeCode.id,
        ],
        connection,
      ).catch(() => null);

      return updatedCredential;
    });

    if (credential?.google_sub && typeof revokeWebSessionsByIdentity === 'function') {
      try {
        await revokeWebSessionsByIdentity({
          googleSub: credential.google_sub,
          email: credential.email || knownUser.email || activeCode.email,
          ownerJid: credential.owner_jid || activeCode.owner_jid || knownUser.owner_jid,
        });
      } catch (error) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('Senha redefinida, mas falhou ao revogar sessoes web ativas.', {
            action: 'web_user_password_recovery_session_revoke_failed',
            google_sub: credential.google_sub,
            error: error?.message,
          });
        }
        throw buildHttpError('Senha atualizada, mas nao foi possivel revogar sessoes ativas.', {
          statusCode: 503,
          code: 'SESSION_REVOKE_FAILED',
        });
      }
    }

    return {
      updated: true,
      credential,
      purpose: activeCode.purpose,
      masked_email: maskEmail(knownUser.email || activeCode.email),
    };
  };

  return {
    getPolicy: () => ({
      code_ttl_seconds: ttlSeconds,
      max_attempts: maxAttempts,
      resend_cooldown_seconds: resendCooldownSeconds,
      hourly_request_limit: hourlyRequestLimit,
      daily_request_limit: dailyRequestLimit,
    }),
    requestPasswordRecoveryCode,
    verifyPasswordRecoveryCode,
    findLatestActiveCodeByIdentity,
  };
};
