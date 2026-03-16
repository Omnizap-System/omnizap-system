import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { hashUserPassword, resolveUserPasswordPolicy, validateUserPassword, verifyUserPasswordHash } from './userPasswordCrypto.js';

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

const normalizeName = (value) =>
  String(value || '')
    .trim()
    .slice(0, 120) || null;

const toIsoOrNull = (value) => {
  const timestamp = Number(new Date(value || 0));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toISOString();
};

const buildHttpError = (message, { statusCode = 400, code = 'BAD_REQUEST' } = {}) => {
  const error = new Error(String(message || 'Erro interno.'));
  error.statusCode = Number(statusCode) || 400;
  error.code = String(code || 'BAD_REQUEST');
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

const buildIdentityFilterClause = ({ googleSub = '', email = '', ownerJid = '' } = {}, tableAlias = 'u') => {
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

const mapCredentialRow = (row, { includeHash = false } = {}) => {
  if (!row || typeof row !== 'object') return null;

  const payload = {
    google_sub: normalizeGoogleSubject(row.google_sub),
    email: normalizeEmail(row.email),
    owner_jid: normalizeJid(row.owner_jid),
    name: normalizeName(row.name),
    picture:
      String(row.picture_url || '')
        .trim()
        .slice(0, 1024) || null,
    password_algo:
      String(row.password_algo || '')
        .trim()
        .toLowerCase() || 'argon2id',
    password_cost: Math.max(0, Number(row.password_cost || 0)),
    failed_attempts: Math.max(0, Number(row.failed_attempts || 0)),
    last_failed_at: toIsoOrNull(row.last_failed_at),
    last_login_at: toIsoOrNull(row.last_login_at),
    password_changed_at: toIsoOrNull(row.password_changed_at),
    revoked_at: toIsoOrNull(row.revoked_at),
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at),
    has_password: Boolean(row.password_hash),
    active: !row.revoked_at,
  };

  if (includeHash) {
    payload.password_hash = String(row.password_hash || '');
  }

  return payload;
};

export const createUserPasswordAuthService = ({ executeQuery, tables = {}, logger = null, policy = {} } = {}) => {
  if (typeof executeQuery !== 'function') {
    throw new TypeError('createUserPasswordAuthService requer executeQuery valido.');
  }

  const resolvedPolicy = resolveUserPasswordPolicy(policy);

  const GOOGLE_USER_TABLE = String(tables.STICKER_WEB_GOOGLE_USER || 'web_google_user').trim() || 'web_google_user';
  const USER_PASSWORD_TABLE = String(tables.STICKER_WEB_USER_PASSWORD || 'web_user_password').trim() || 'web_user_password';
  const maxFailedAttempts = clampInt(process.env.WEB_USER_PASSWORD_MAX_FAILED_ATTEMPTS, 8, 3, 100);
  const lockoutSeconds = clampInt(process.env.WEB_USER_PASSWORD_LOCKOUT_SECONDS, 900, 30, 86_400);

  const resolveCredentialLockState = (credential) => {
    const failures = Math.max(0, Number(credential?.failed_attempts || 0));
    if (failures < maxFailedAttempts) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    const lastFailedAtMs = Date.parse(String(credential?.last_failed_at || ''));
    if (!Number.isFinite(lastFailedAtMs) || lastFailedAtMs <= 0) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    const elapsedSeconds = Math.max(0, Math.floor((__timeNowMs() - lastFailedAtMs) / 1000));
    const retryAfterSeconds = Math.max(0, lockoutSeconds - elapsedSeconds);
    if (retryAfterSeconds <= 0) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    return { locked: true, retryAfterSeconds };
  };

  const findKnownGoogleUserByIdentity = async (identity = {}, connection = null) => {
    const normalizedIdentity = normalizeIdentity(identity);
    if (!normalizedIdentity.hasIdentity) return null;

    const filter = buildIdentityFilterClause(normalizedIdentity, 'u');
    if (!filter) return null;

    const rows = await executeQuery(
      `SELECT u.google_sub, u.email, u.owner_jid, u.name, u.picture_url, u.last_login_at, u.last_seen_at, u.created_at, u.updated_at
         FROM ${GOOGLE_USER_TABLE} u
        WHERE ${filter.clause}
        ORDER BY COALESCE(u.last_seen_at, u.last_login_at, u.updated_at, u.created_at) DESC
        LIMIT 1`,
      filter.params,
      connection,
    );

    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;

    return {
      google_sub: normalizeGoogleSubject(row.google_sub),
      email: normalizeEmail(row.email),
      owner_jid: normalizeJid(row.owner_jid),
      name: normalizeName(row.name),
      picture:
        String(row.picture_url || '')
          .trim()
          .slice(0, 1024) || null,
      last_login_at: toIsoOrNull(row.last_login_at),
      last_seen_at: toIsoOrNull(row.last_seen_at),
      created_at: toIsoOrNull(row.created_at),
      updated_at: toIsoOrNull(row.updated_at),
    };
  };

  const findCredentialByIdentityInternal = async (identity = {}, { includeRevoked = false, includeHash = false } = {}, connection = null) => {
    const normalizedIdentity = normalizeIdentity(identity);
    if (!normalizedIdentity.hasIdentity) return null;

    const filter = buildIdentityFilterClause(normalizedIdentity, 'u');
    if (!filter) return null;

    const revokedClause = includeRevoked ? '' : 'AND p.revoked_at IS NULL';

    const rows = await executeQuery(
      `SELECT
         p.google_sub,
         p.password_hash,
         p.password_algo,
         p.password_cost,
         p.failed_attempts,
         p.last_failed_at,
         p.last_login_at,
         p.password_changed_at,
         p.revoked_at,
         p.created_at,
         p.updated_at,
         u.email,
         u.owner_jid,
         u.name,
         u.picture_url
       FROM ${USER_PASSWORD_TABLE} p
       INNER JOIN ${GOOGLE_USER_TABLE} u ON u.google_sub = p.google_sub
      WHERE (${filter.clause})
        ${revokedClause}
      ORDER BY p.updated_at DESC
      LIMIT 1`,
      filter.params,
      connection,
    );

    return mapCredentialRow(Array.isArray(rows) ? rows[0] : null, { includeHash });
  };

  const touchCredentialSuccess = async (googleSub, connection = null) => {
    const normalizedSub = normalizeGoogleSubject(googleSub);
    if (!normalizedSub) return 0;

    const result = await executeQuery(
      `UPDATE ${USER_PASSWORD_TABLE}
          SET failed_attempts = 0,
              last_failed_at = NULL,
              last_login_at = UTC_TIMESTAMP(),
              updated_at = UTC_TIMESTAMP()
        WHERE google_sub = ?
          AND revoked_at IS NULL`,
      [normalizedSub],
      connection,
    );

    return Number(result?.affectedRows || 0);
  };

  const touchCredentialFailure = async (googleSub, connection = null) => {
    const normalizedSub = normalizeGoogleSubject(googleSub);
    if (!normalizedSub) return 0;

    const result = await executeQuery(
      `UPDATE ${USER_PASSWORD_TABLE}
          SET failed_attempts = failed_attempts + 1,
              last_failed_at = UTC_TIMESTAMP(),
              updated_at = UTC_TIMESTAMP()
        WHERE google_sub = ?
          AND revoked_at IS NULL`,
      [normalizedSub],
      connection,
    );

    return Number(result?.affectedRows || 0);
  };

  const setPasswordForIdentity = async ({ googleSub = '', email = '', ownerJid = '', password = '' } = {}, connection = null) => {
    const knownUser = await findKnownGoogleUserByIdentity({ googleSub, email, ownerJid }, connection);
    if (!knownUser?.google_sub) {
      throw buildHttpError('Usuario web nao encontrado. O usuario precisa autenticar no site antes de cadastrar senha.', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }

    const hashData = await hashUserPassword(password, resolvedPolicy);

    await executeQuery(
      `INSERT INTO ${USER_PASSWORD_TABLE}
        (google_sub, password_hash, password_algo, password_cost, failed_attempts, last_failed_at, last_login_at, password_changed_at, revoked_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, UTC_TIMESTAMP(), NULL)
       ON DUPLICATE KEY UPDATE
        password_hash = VALUES(password_hash),
        password_algo = VALUES(password_algo),
        password_cost = VALUES(password_cost),
        failed_attempts = 0,
        last_failed_at = NULL,
        password_changed_at = UTC_TIMESTAMP(),
        revoked_at = NULL,
        updated_at = UTC_TIMESTAMP()`,
      [knownUser.google_sub, hashData.hash, hashData.algorithm, hashData.cost],
      connection,
    );

    const credential = await findCredentialByIdentityInternal({ googleSub: knownUser.google_sub }, { includeRevoked: true }, connection);
    if (!credential) {
      throw buildHttpError('Falha ao salvar credencial de senha do usuario.', {
        statusCode: 500,
        code: 'PASSWORD_SAVE_FAILED',
      });
    }

    if (logger && typeof logger.info === 'function') {
      logger.info('Credencial de senha do usuario registrada/atualizada.', {
        action: 'web_user_password_upsert',
        google_sub: credential.google_sub,
      });
    }

    return credential;
  };

  const verifyPasswordForIdentity = async ({ googleSub = '', email = '', ownerJid = '', password = '' } = {}, connection = null) => {
    const rawPassword = typeof password === 'string' ? password : '';
    if (!rawPassword) {
      return {
        authenticated: false,
        reason: 'PASSWORD_REQUIRED',
        credential: null,
      };
    }

    const credentialWithHash = await findCredentialByIdentityInternal({ googleSub, email, ownerJid }, { includeRevoked: true, includeHash: true }, connection);
    if (!credentialWithHash?.google_sub) {
      return {
        authenticated: false,
        reason: 'CREDENTIAL_NOT_FOUND',
        credential: null,
      };
    }

    if (credentialWithHash.revoked_at) {
      return {
        authenticated: false,
        reason: 'CREDENTIAL_REVOKED',
        credential: mapCredentialRow(credentialWithHash),
      };
    }

    const lockState = resolveCredentialLockState(credentialWithHash);
    if (lockState.locked) {
      return {
        authenticated: false,
        reason: 'ACCOUNT_LOCKED',
        retryAfterSeconds: lockState.retryAfterSeconds,
        credential: mapCredentialRow(credentialWithHash),
      };
    }

    const isValid = await verifyUserPasswordHash(rawPassword, credentialWithHash.password_hash);

    if (isValid) {
      await touchCredentialSuccess(credentialWithHash.google_sub, connection);
      const updatedCredential = await findCredentialByIdentityInternal({ googleSub: credentialWithHash.google_sub }, { includeRevoked: true }, connection);
      return {
        authenticated: true,
        reason: null,
        credential: updatedCredential,
      };
    }

    await touchCredentialFailure(credentialWithHash.google_sub, connection);
    const updatedCredential = await findCredentialByIdentityInternal({ googleSub: credentialWithHash.google_sub }, { includeRevoked: true }, connection);
    const updatedLockState = resolveCredentialLockState(updatedCredential);

    return {
      authenticated: false,
      reason: updatedLockState.locked ? 'ACCOUNT_LOCKED' : 'INVALID_PASSWORD',
      retryAfterSeconds: updatedLockState.retryAfterSeconds,
      credential: updatedCredential,
    };
  };

  const revokePasswordForIdentity = async ({ googleSub = '', email = '', ownerJid = '' } = {}, connection = null) => {
    const existing = await findCredentialByIdentityInternal({ googleSub, email, ownerJid }, { includeRevoked: true }, connection);
    if (!existing?.google_sub) return null;

    await executeQuery(
      `UPDATE ${USER_PASSWORD_TABLE}
          SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP()),
              updated_at = UTC_TIMESTAMP()
        WHERE google_sub = ?`,
      [existing.google_sub],
      connection,
    );

    return findCredentialByIdentityInternal({ googleSub: existing.google_sub }, { includeRevoked: true }, connection);
  };

  const clearFailuresForIdentity = async ({ googleSub = '', email = '', ownerJid = '' } = {}, connection = null) => {
    const existing = await findCredentialByIdentityInternal({ googleSub, email, ownerJid }, { includeRevoked: true }, connection);
    if (!existing?.google_sub) return null;

    await executeQuery(
      `UPDATE ${USER_PASSWORD_TABLE}
          SET failed_attempts = 0,
              last_failed_at = NULL,
              updated_at = UTC_TIMESTAMP()
        WHERE google_sub = ?`,
      [existing.google_sub],
      connection,
    );

    return findCredentialByIdentityInternal({ googleSub: existing.google_sub }, { includeRevoked: true }, connection);
  };

  return {
    policy: {
      ...resolvedPolicy,
      maxFailedAttempts,
      lockoutSeconds,
    },
    getPolicy: () => ({
      ...resolvedPolicy,
      maxFailedAttempts,
      lockoutSeconds,
    }),
    validatePassword: (password) => validateUserPassword(password, resolvedPolicy),
    findKnownGoogleUserByIdentity,
    findCredentialByIdentity: (identity = {}, options = {}, connection = null) => findCredentialByIdentityInternal(identity, options, connection),
    setPasswordForIdentity,
    verifyPasswordForIdentity,
    revokePasswordForIdentity,
    clearFailuresForIdentity,
  };
};
