import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { createHash, randomUUID } from 'node:crypto';
import axios from 'axios';

import { signWebAuthJwt, verifyWebAuthJwt, extractBearerTokenFromRequest } from '../jwt/webJwtService.js';
import { parseGoogleAuthSessionPayload } from '../validation/authSchemas.js';
import { resolveClientIp } from '../../http/clientIp.js';

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_WEB_SESSION_COOKIE_NAME = 'omnizap_google_session';

const hashSessionToken = (value) => {
  const token = String(value || '').trim();
  if (!token) return null;
  return createHash('sha256').update(token).digest();
};

const buildSessionRowKeyFromHash = (hashValue) => {
  if (!Buffer.isBuffer(hashValue) || !hashValue.length) return '';
  return hashValue.toString('hex').slice(0, 36);
};

const normalizeCookiePath = (value, fallback = '/') => {
  const raw = String(value || '').trim();
  const base = raw || fallback;
  const withSlash = base.startsWith('/') ? base : `/${base}`;
  if (withSlash.length > 1 && withSlash.endsWith('/')) return withSlash.slice(0, -1);
  return withSlash || '/';
};

export const createGoogleWebAuthService = ({ executeQuery, runSqlTransaction, tables, logger, sendJson, readJsonBody, parseCookies, getCookieValuesFromRequest, appendSetCookie, buildCookieString, normalizeGoogleSubject, normalizeEmail, normalizeJid, sanitizeText, toIsoOrNull, toWhatsAppPhoneDigits, resolveWhatsAppOwnerJidFromLoginPayload, buildGoogleOwnerJid, assertGoogleIdentityNotBanned, googleClientId, sessionTtlMs, sessionDbTouchIntervalMs, sessionDbPruneIntervalMs, notAllowedErrorCode, onGoogleWebSessionCreated = null, sessionCookiePath = '/', legacyCookiePaths = [] }) => {
  const webGoogleSessionMap = new Map();
  let googleWebSessionDbPruneAt = 0;
  const normalizedSessionCookiePath = normalizeCookiePath(sessionCookiePath, '/');
  const normalizedLegacyCookiePaths = Array.from(new Set(['/', normalizedSessionCookiePath, ...legacyCookiePaths].map((pathValue) => normalizeCookiePath(pathValue, '/')).filter(Boolean)));
  const USER_PASSWORD_TABLE = String(tables.STICKER_WEB_USER_PASSWORD || 'web_user_password').trim() || 'web_user_password';

  const pruneExpiredGoogleSessions = () => {
    const now = __timeNowMs();
    for (const [token, session] of webGoogleSessionMap.entries()) {
      if (!session || Number(session.expiresAt || 0) <= now) {
        webGoogleSessionMap.delete(token);
      }
    }
  };

  const verifyGoogleIdToken = async (idToken) => {
    const token = String(idToken || '').trim();
    if (!token) {
      const error = new Error('Token Google ausente.');
      error.statusCode = 401;
      throw error;
    }

    let response;
    try {
      response = await axios.get(GOOGLE_TOKENINFO_URL, {
        params: { id_token: token },
        timeout: 5000,
        validateStatus: () => true,
      });
    } catch (error) {
      const wrapped = new Error('Falha ao validar login Google.');
      wrapped.statusCode = 502;
      wrapped.cause = error;
      throw wrapped;
    }

    if (response.status < 200 || response.status >= 300) {
      const reason = String(response?.data?.error_description || response?.data?.error || '').trim();
      const error = new Error(reason || 'Token Google inválido.');
      error.statusCode = 401;
      throw error;
    }

    const claims = response?.data && typeof response.data === 'object' ? response.data : {};
    const aud = String(claims.aud || '').trim();
    const iss = String(claims.iss || '').trim();
    const sub = normalizeGoogleSubject(claims.sub);
    const email = String(claims.email || '')
      .trim()
      .toLowerCase();
    const emailVerified = String(claims.email_verified || '')
      .trim()
      .toLowerCase();

    if (googleClientId && aud !== googleClientId) {
      const error = new Error('Login Google não pertence a este aplicativo.');
      error.statusCode = 403;
      throw error;
    }
    if (iss && !['accounts.google.com', 'https://accounts.google.com'].includes(iss)) {
      const error = new Error('Emissor do token Google inválido.');
      error.statusCode = 401;
      throw error;
    }
    if (!sub) {
      const error = new Error('Token Google sem identificador de usuário.');
      error.statusCode = 401;
      throw error;
    }
    if (email && emailVerified && !['true', '1'].includes(emailVerified)) {
      const error = new Error('Conta Google sem e-mail verificado.');
      error.statusCode = 403;
      throw error;
    }

    return {
      sub,
      email: email || null,
      name: sanitizeText(claims.name || claims.given_name || '', 120, { allowEmpty: true }) || null,
      picture: String(claims.picture || '').trim() || null,
    };
  };

  const getGoogleWebSessionTokensFromRequest = (req) => {
    const direct = getCookieValuesFromRequest(req, GOOGLE_WEB_SESSION_COOKIE_NAME);
    if (direct.length > 0) return direct;
    const cookies = parseCookies(req);
    const fallback = String(cookies[GOOGLE_WEB_SESSION_COOKIE_NAME] || '').trim();
    return fallback ? [fallback] : [];
  };

  const normalizeGoogleWebSessionRow = (row, { sessionToken = '' } = {}) => {
    if (!row || typeof row !== 'object') return null;
    const token = String(sessionToken || row.session_token || '').trim();
    const sub = normalizeGoogleSubject(row.google_sub);
    const ownerJid = normalizeJid(row.owner_jid) || '';
    const ownerPhone = toWhatsAppPhoneDigits(row.owner_phone || ownerJid) || '';
    const expiresAt = Number(new Date(row.expires_at || 0));
    if (!token || !sub || !ownerJid || !Number.isFinite(expiresAt)) return null;
    const createdAtRaw = Number(new Date(row.created_at || 0));
    const lastSeenAtRaw = Number(new Date(row.last_seen_at || 0));
    return {
      token,
      sessionRowKey:
        String(row.session_token || '')
          .trim()
          .slice(0, 36) || null,
      sub,
      email:
        String(row.email || '')
          .trim()
          .toLowerCase() || null,
      name: sanitizeText(row.name || '', 120, { allowEmpty: true }) || null,
      picture: String(row.picture_url || '').trim() || null,
      ownerJid,
      ownerPhone,
      createdAt: Number.isFinite(createdAtRaw) ? createdAtRaw : __timeNowMs(),
      expiresAt,
      lastSeenAt: Number.isFinite(lastSeenAtRaw) ? lastSeenAtRaw : 0,
      lastDbTouchAt: __timeNowMs(),
    };
  };

  const maybePruneExpiredGoogleSessionsFromDb = async () => {
    const now = __timeNowMs();
    if (now - googleWebSessionDbPruneAt < sessionDbPruneIntervalMs) return;
    googleWebSessionDbPruneAt = now;
    try {
      await executeQuery(
        `DELETE FROM ${tables.STICKER_WEB_GOOGLE_SESSION}
         WHERE revoked_at IS NOT NULL OR expires_at <= UTC_TIMESTAMP()`,
      );

      // Backfill hash for any old row that still doesn't have `session_token_hash`.
      await executeQuery(
        `UPDATE ${tables.STICKER_WEB_GOOGLE_SESSION}
            SET session_token_hash = UNHEX(SHA2(session_token, 256))
          WHERE session_token_hash IS NULL
            AND session_token IS NOT NULL`,
      ).catch(() => {});

      // `session_token` stores only a non-sensitive deterministic row key.
      await executeQuery(
        `UPDATE ${tables.STICKER_WEB_GOOGLE_SESSION}
            SET session_token = LOWER(SUBSTRING(HEX(session_token_hash), 1, 36))
          WHERE session_token_hash IS NOT NULL
            AND session_token <> LOWER(SUBSTRING(HEX(session_token_hash), 1, 36))`,
      ).catch(() => {});
    } catch (error) {
      logger.warn('Falha ao limpar sessões Google web expiradas do banco.', {
        action: 'sticker_pack_google_web_session_db_prune_failed',
        error: error?.message,
      });
    }
  };

  const upsertGoogleWebUserRecord = async (user, connection = null) => {
    const sub = normalizeGoogleSubject(user?.sub);
    const ownerJid = normalizeJid(user?.ownerJid) || '';
    if (!sub || !ownerJid) return;
    const ownerPhone = toWhatsAppPhoneDigits(ownerJid) || null;
    const email =
      String(user?.email || '')
        .trim()
        .toLowerCase() || null;
    const name = sanitizeText(user?.name || '', 120, { allowEmpty: true }) || null;
    const pictureUrl =
      String(user?.picture || '')
        .trim()
        .slice(0, 1024) || null;

    await executeQuery(
      `DELETE FROM ${tables.STICKER_WEB_GOOGLE_USER}
        WHERE owner_jid = ?
          AND google_sub <> ?`,
      [ownerJid, sub],
      connection,
    );

    await executeQuery(
      `INSERT INTO ${tables.STICKER_WEB_GOOGLE_USER}
        (google_sub, owner_jid, email, name, picture_url, last_login_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
        owner_jid = VALUES(owner_jid),
        email = VALUES(email),
        name = VALUES(name),
        picture_url = VALUES(picture_url),
        last_login_at = UTC_TIMESTAMP(),
        last_seen_at = UTC_TIMESTAMP()`,
      [sub, ownerJid, email, name, pictureUrl],
      connection,
    );

    await executeQuery(
      `UPDATE ${tables.STICKER_WEB_GOOGLE_USER}
          SET owner_phone = COALESCE(?, owner_phone)
        WHERE google_sub = ?`,
      [ownerPhone, sub],
      connection,
    ).catch(() => {});
  };

  const upsertGoogleWebSessionRecord = async (session, connection = null) => {
    const token = String(session?.token || '').trim();
    const tokenHash = hashSessionToken(token);
    const sessionRowKey = buildSessionRowKeyFromHash(tokenHash);
    const sub = normalizeGoogleSubject(session?.sub);
    const ownerJid = normalizeJid(session?.ownerJid) || '';
    const ownerPhone = toWhatsAppPhoneDigits(session?.ownerPhone || ownerJid) || null;
    const expiresAt = Number(session?.expiresAt || 0);
    if (!token || !tokenHash || !sessionRowKey || !sub || !ownerJid || !Number.isFinite(expiresAt) || expiresAt <= 0) return;
    const email =
      String(session?.email || '')
        .trim()
        .toLowerCase() || null;
    const name = sanitizeText(session?.name || '', 120, { allowEmpty: true }) || null;
    const pictureUrl =
      String(session?.picture || '')
        .trim()
        .slice(0, 1024) || null;

    await executeQuery(
      `INSERT INTO ${tables.STICKER_WEB_GOOGLE_SESSION}
        (session_token, session_token_hash, google_sub, owner_jid, email, name, picture_url, expires_at, revoked_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
        session_token_hash = VALUES(session_token_hash),
        google_sub = VALUES(google_sub),
        owner_jid = VALUES(owner_jid),
        email = VALUES(email),
        name = VALUES(name),
        picture_url = VALUES(picture_url),
        expires_at = VALUES(expires_at),
        revoked_at = NULL,
        last_seen_at = UTC_TIMESTAMP()`,
      [sessionRowKey, tokenHash, sub, ownerJid, email, name, pictureUrl, new Date(expiresAt)],
      connection,
    );

    await executeQuery(
      `UPDATE ${tables.STICKER_WEB_GOOGLE_SESSION}
          SET owner_phone = COALESCE(?, owner_phone)
        WHERE session_token_hash = ?`,
      [ownerPhone, tokenHash],
      connection,
    ).catch(() => {});
  };

  const persistGoogleWebSessionToDb = async (session) => {
    if (!session?.token || !session?.sub || !session?.ownerJid) return;
    await maybePruneExpiredGoogleSessionsFromDb();
    await runSqlTransaction(async (connection) => {
      await upsertGoogleWebUserRecord(
        {
          sub: session.sub,
          ownerJid: session.ownerJid,
          email: session.email,
          name: session.name,
          picture: session.picture,
        },
        connection,
      );
      await upsertGoogleWebSessionRecord(session, connection);
    });
  };

  const findGoogleWebSessionInDbByToken = async (sessionToken) => {
    const token = String(sessionToken || '').trim();
    const tokenHash = hashSessionToken(token);
    if (!token) return null;
    await maybePruneExpiredGoogleSessionsFromDb();
    const rows = await executeQuery(
      `SELECT
         s.session_token,
         s.google_sub,
         s.owner_jid,
         s.owner_phone,
         s.email,
         s.name,
         s.picture_url,
         s.created_at,
         s.expires_at,
         s.last_seen_at
         FROM ${tables.STICKER_WEB_GOOGLE_SESSION} s
         LEFT JOIN ${USER_PASSWORD_TABLE} p
           ON p.google_sub = s.google_sub
          AND p.revoked_at IS NULL
        WHERE s.session_token_hash = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > UTC_TIMESTAMP()
          AND (p.password_changed_at IS NULL OR s.created_at >= p.password_changed_at)
        LIMIT 1`,
      [tokenHash],
    );
    return normalizeGoogleWebSessionRow(Array.isArray(rows) ? rows[0] : null, {
      sessionToken: token,
    });
  };

  const touchGoogleWebSessionSeenInDb = async (sessionToken) => {
    const token = String(sessionToken || '').trim();
    const tokenHash = hashSessionToken(token);
    if (!token) return;
    await executeQuery(
      `UPDATE ${tables.STICKER_WEB_GOOGLE_SESSION}
          SET last_seen_at = UTC_TIMESTAMP()
        WHERE session_token_hash = ?
          AND revoked_at IS NULL`,
      [tokenHash],
    );
  };

  const touchGoogleWebUserSeenInDb = async (googleSub) => {
    const sub = normalizeGoogleSubject(googleSub);
    if (!sub) return;
    await executeQuery(
      `UPDATE ${tables.STICKER_WEB_GOOGLE_USER}
          SET last_seen_at = UTC_TIMESTAMP()
        WHERE google_sub = ?`,
      [sub],
    );
  };

  const deleteGoogleWebSessionFromDb = async (sessionToken) => {
    const token = String(sessionToken || '').trim();
    const tokenHash = hashSessionToken(token);
    if (!token) return 0;
    const result = await executeQuery(
      `DELETE FROM ${tables.STICKER_WEB_GOOGLE_SESSION}
        WHERE session_token_hash = ?`,
      [tokenHash],
    );
    return Number(result?.affectedRows || 0);
  };

  const createGoogleWebSession = (claims, { ownerJid } = {}) => {
    pruneExpiredGoogleSessions();
    const token = randomUUID();
    const now = __timeNowMs();
    const resolvedOwnerJid = normalizeJid(ownerJid) || buildGoogleOwnerJid(claims.sub);
    const resolvedOwnerPhone = toWhatsAppPhoneDigits(resolvedOwnerJid) || '';
    return {
      token,
      sub: claims.sub,
      email: claims.email || null,
      name: claims.name || null,
      picture: claims.picture || null,
      ownerJid: resolvedOwnerJid,
      ownerPhone: resolvedOwnerPhone,
      createdAt: now,
      expiresAt: now + sessionTtlMs,
      lastSeenAt: now,
      lastDbTouchAt: 0,
    };
  };

  const activateGoogleWebSession = (session) => {
    if (!session?.token) return;
    pruneExpiredGoogleSessions();
    webGoogleSessionMap.set(session.token, session);
  };

  const issueAccessTokenForSession = (session) => {
    if (!session?.sub) return '';
    const expiresInSeconds = Math.max(60, Math.floor((Number(session.expiresAt || 0) - __timeNowMs()) / 1000));
    return (
      signWebAuthJwt(
        {
          sub: session.sub,
          sessionToken: session.token,
          ownerJid: session.ownerJid,
          ownerPhone: session.ownerPhone,
          email: session.email,
          name: session.name,
          authMethod: 'google',
        },
        { expiresInSeconds },
      ) || ''
    );
  };

  const setGoogleWebSessionCookie = (req, res, sessionToken, maxAgeSeconds = Math.floor(sessionTtlMs / 1000)) => {
    const token = String(sessionToken || '').trim();
    if (!token) return;
    appendSetCookie(
      res,
      buildCookieString(GOOGLE_WEB_SESSION_COOKIE_NAME, token, req, {
        path: normalizedSessionCookiePath,
        maxAgeSeconds,
      }),
    );
  };

  const createPersistedGoogleWebSessionFromIdentity = async ({ sub = '', email = '', name = '', picture = '', ownerJid = '', requestMeta = null } = {}) => {
    const normalizedSub = normalizeGoogleSubject(sub);
    const normalizedOwnerJid = normalizeJid(ownerJid) || '';
    if (!normalizedSub || !normalizedOwnerJid) {
      const error = new Error('Nao foi possivel criar sessao para a identidade informada.');
      error.statusCode = 400;
      throw error;
    }

    await assertGoogleIdentityNotBanned({
      sub: normalizedSub,
      email: normalizeEmail(email),
      ownerJid: normalizedOwnerJid,
    });

    const session = createGoogleWebSession(
      {
        sub: normalizedSub,
        email: normalizeEmail(email) || null,
        name: sanitizeText(name || '', 120, { allowEmpty: true }) || null,
        picture: String(picture || '').trim() || null,
      },
      { ownerJid: normalizedOwnerJid },
    );

    if (!session.ownerJid) {
      const error = new Error('Nao foi possivel vincular a conta ao owner informado.');
      error.statusCode = 400;
      throw error;
    }

    await persistGoogleWebSessionToDb(session);
    activateGoogleWebSession(session);

    if (typeof onGoogleWebSessionCreated === 'function') {
      Promise.resolve(
        onGoogleWebSessionCreated({
          sub: session.sub,
          email: session.email,
          name: session.name,
          ownerJid: session.ownerJid,
          ownerPhone: session.ownerPhone,
          expiresAt: session.expiresAt,
          request: requestMeta || null,
        }),
      ).catch((hookError) => {
        logger.warn('Falha ao executar callback pós-criacao de sessao Google web.', {
          action: 'sticker_pack_google_web_session_created_hook_failed',
          error: hookError?.message,
        });
      });
    }

    return session;
  };

  const resolveGoogleWebSessionFromBearerToken = async (req) => {
    const bearerToken = extractBearerTokenFromRequest(req);
    if (!bearerToken) return null;

    const claims = verifyWebAuthJwt(bearerToken);
    if (!claims?.sub) return null;

    const sessionToken = String(claims.sid || '').trim();
    if (!sessionToken) return null;
    return resolvePersistedGoogleWebSessionByToken(sessionToken, {
      expectedSub: claims.sub,
    });
  };

  const touchGoogleWebSessionActivity = (session) => {
    if (!session?.token || !session?.sub) return;
    const now = __timeNowMs();
    session.lastSeenAt = now;
    if (now - Number(session.lastDbTouchAt || 0) < sessionDbTouchIntervalMs) {
      return;
    }
    session.lastDbTouchAt = now;
    void touchGoogleWebSessionSeenInDb(session.token).catch((error) => {
      logger.warn('Falha ao atualizar last_seen da sessão Google web.', {
        action: 'sticker_pack_google_web_session_touch_failed',
        error: error?.message,
      });
    });
    void touchGoogleWebUserSeenInDb(session.sub).catch(() => {});
  };

  const resolvePersistedGoogleWebSessionByToken = async (sessionToken, { expectedSub = '' } = {}) => {
    const token = String(sessionToken || '').trim();
    if (!token) return null;
    const normalizedExpectedSub = normalizeGoogleSubject(expectedSub);

    let persistedSession = null;
    try {
      persistedSession = await findGoogleWebSessionInDbByToken(token);
    } catch (error) {
      logger.warn('Falha ao resolver sessão Google web no banco.', {
        action: 'sticker_pack_google_web_session_db_resolve_failed',
        error: error?.message,
      });
      return null;
    }

    if (!persistedSession) {
      webGoogleSessionMap.delete(token);
      return null;
    }

    if (normalizedExpectedSub && normalizeGoogleSubject(persistedSession.sub) !== normalizedExpectedSub) {
      return null;
    }

    try {
      await assertGoogleIdentityNotBanned({
        sub: persistedSession.sub,
        email: persistedSession.email,
        ownerJid: persistedSession.ownerJid,
      });
    } catch {
      webGoogleSessionMap.delete(token);
      await deleteGoogleWebSessionFromDb(token).catch(() => {});
      return null;
    }

    touchGoogleWebSessionActivity(persistedSession);
    activateGoogleWebSession(persistedSession);
    return persistedSession;
  };

  const resolveGoogleWebSessionFromRequest = async (req) => {
    pruneExpiredGoogleSessions();
    const sessionTokens = getGoogleWebSessionTokensFromRequest(req);
    if (!sessionTokens.length) {
      return resolveGoogleWebSessionFromBearerToken(req);
    }

    for (const sessionToken of sessionTokens) {
      const resolvedSession = await resolvePersistedGoogleWebSessionByToken(sessionToken);
      if (resolvedSession) return resolvedSession;
    }

    return resolveGoogleWebSessionFromBearerToken(req);
  };

  const clearGoogleWebSessionCookie = (req, res) => {
    for (const pathValue of normalizedLegacyCookiePaths) {
      appendSetCookie(
        res,
        buildCookieString(GOOGLE_WEB_SESSION_COOKIE_NAME, '', req, {
          path: pathValue,
          maxAgeSeconds: 0,
        }),
      );
      appendSetCookie(
        res,
        buildCookieString(GOOGLE_WEB_SESSION_COOKIE_NAME, '', req, {
          path: pathValue,
          maxAgeSeconds: 0,
          domain: false,
        }),
      );
    }
  };

  const mapGoogleSessionResponseData = (session, { accessToken = '' } = {}) => {
    if (!session) {
      return {
        authenticated: false,
        provider: 'google',
        user: null,
        owner_jid: null,
        owner_phone: null,
        expires_at: null,
      };
    }

    const payload = {
      authenticated: true,
      provider: 'google',
      user: {
        sub: session.sub,
        email: session.email,
        name: session.name,
        picture: session.picture,
      },
      owner_jid: session.ownerJid,
      owner_phone: toWhatsAppPhoneDigits(session.ownerPhone || session.ownerJid) || null,
      expires_at: toIsoOrNull(session.expiresAt),
    };

    const normalizedAccessToken = String(accessToken || '').trim();
    if (normalizedAccessToken) {
      payload.token_type = 'Bearer';
      payload.access_token = normalizedAccessToken;
    }

    return payload;
  };

  const revokeGoogleWebSessionsByIdentity = async ({ googleSub = '', email = '', ownerJid = '' } = {}) => {
    const normalizedSub = normalizeGoogleSubject(googleSub);
    const normalizedEmail = normalizeEmail(email);
    const normalizedOwnerJid = normalizeJid(ownerJid) || '';

    const clauses = [];
    const params = [];
    if (normalizedSub) {
      clauses.push('google_sub = ?');
      params.push(normalizedSub);
    }
    if (normalizedEmail) {
      clauses.push('email = ?');
      params.push(normalizedEmail);
    }
    if (normalizedOwnerJid) {
      clauses.push('owner_jid = ?');
      params.push(normalizedOwnerJid);
    }
    if (!clauses.length) return 0;

    let removed = 0;
    for (const [token, session] of webGoogleSessionMap.entries()) {
      if (!session) continue;
      const sessionSub = normalizeGoogleSubject(session.sub);
      const sessionEmail = normalizeEmail(session.email);
      const sessionOwner = normalizeJid(session.ownerJid) || '';
      if ((normalizedSub && sessionSub === normalizedSub) || (normalizedEmail && sessionEmail === normalizedEmail) || (normalizedOwnerJid && sessionOwner === normalizedOwnerJid)) {
        webGoogleSessionMap.delete(token);
        removed += 1;
      }
    }

    try {
      await executeQuery(
        `DELETE FROM ${tables.STICKER_WEB_GOOGLE_SESSION}
          WHERE ${clauses.join(' OR ')}`,
        params,
      );
    } catch (error) {
      const wrapped = new Error('Nao foi possivel revogar sessoes web persistidas.');
      wrapped.statusCode = 503;
      wrapped.code = 'SESSION_REVOKE_FAILED';
      wrapped.cause = error;
      throw wrapped;
    }

    return removed;
  };

  const handleGoogleAuthSessionRequest = async (req, res) => {
    if (!googleClientId) {
      sendJson(req, res, 404, { error: 'Login Google desabilitado.' });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const session = await resolveGoogleWebSessionFromRequest(req);
      sendJson(req, res, 200, {
        data: mapGoogleSessionResponseData(session),
      });
      return;
    }

    if (req.method === 'DELETE') {
      const tokens = getGoogleWebSessionTokensFromRequest(req);
      for (const token of tokens) {
        webGoogleSessionMap.delete(token);
        await deleteGoogleWebSessionFromDb(token).catch((error) => {
          logger.warn('Falha ao remover sessão Google web do banco.', {
            action: 'sticker_pack_google_web_session_db_delete_failed',
            error: error?.message,
          });
        });
      }
      clearGoogleWebSessionCookie(req, res);
      sendJson(req, res, 200, { data: { cleared: true } });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    let payload = {};
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Body inválido.',
      });
      return;
    }

    try {
      payload = parseGoogleAuthSessionPayload(payload);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Payload de login invalido.',
        code: error?.code || 'INVALID_PAYLOAD',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
      return;
    }

    try {
      const claims = await verifyGoogleIdToken(payload?.google_id_token || payload?.id_token);
      const linkedOwner = resolveWhatsAppOwnerJidFromLoginPayload(payload);
      if (!linkedOwner.ownerJid) {
        if (!linkedOwner.hasPayload) {
          sendJson(req, res, 400, {
            error: 'Abra esta pagina pelo link enviado no WhatsApp. Envie "iniciar" no bot para gerar o link de login.',
            code: 'WHATSAPP_LOGIN_LINK_REQUIRED',
            reason: 'missing_link',
          });
          return;
        }

        const reason = String(linkedOwner.reason || '')
          .trim()
          .toLowerCase();
        const isUnauthorizedAttempt = ['invalid_signature', 'missing_signature'].includes(reason);
        const statusCode = isUnauthorizedAttempt ? 403 : 400;
        const errorMessage = reason === 'expired' ? 'Link de login expirado. Envie "iniciar" novamente no WhatsApp.' : isUnauthorizedAttempt ? 'Tentativa de login sem permissao detectada. Gere um novo link enviando "iniciar" no privado do bot.' : 'Link de login invalido. Envie "iniciar" novamente no WhatsApp.';

        logger.warn('Tentativa de login web bloqueada por validacao do link WhatsApp.', {
          action: 'sticker_pack_google_web_login_link_blocked',
          reason: reason || 'unknown',
          remote_ip: resolveClientIp(req, { fallback: null }),
          user_agent: req.headers?.['user-agent'] || null,
        });

        sendJson(req, res, statusCode, {
          error: errorMessage,
          code: 'WHATSAPP_LOGIN_LINK_INVALID',
          reason: reason || 'invalid_link',
        });
        return;
      }
      const ownerJid = linkedOwner.ownerJid;

      const session = await createPersistedGoogleWebSessionFromIdentity({
        sub: claims.sub,
        email: claims.email || '',
        name: claims.name || '',
        picture: claims.picture || '',
        ownerJid,
        requestMeta: {
          remoteIp: resolveClientIp(req, { fallback: null }),
          userAgent: req.headers?.['user-agent'] || null,
        },
      });

      setGoogleWebSessionCookie(req, res, session.token, Math.floor(sessionTtlMs / 1000));
      const accessToken = issueAccessTokenForSession(session);
      sendJson(req, res, 200, {
        data: mapGoogleSessionResponseData(session, { accessToken }),
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      sendJson(req, res, statusCode, {
        error: error?.message || 'Login Google inválido.',
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : notAllowedErrorCode,
      });
    }
  };

  return {
    cookieName: GOOGLE_WEB_SESSION_COOKIE_NAME,
    getGoogleWebSessionTokensFromRequest,
    upsertGoogleWebUserRecord,
    resolveGoogleWebSessionFromRequest,
    clearGoogleWebSessionCookie,
    setGoogleWebSessionCookie,
    deleteGoogleWebSessionFromDb,
    mapGoogleSessionResponseData,
    issueAccessTokenForSession,
    createPersistedGoogleWebSessionFromIdentity,
    handleGoogleAuthSessionRequest,
    revokeGoogleWebSessionsByIdentity,
  };
};
