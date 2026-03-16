import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { createGoogleWebAuthRuntime, normalizeGoogleSubject } from './googleWebAuth/googleWebAuthRuntime.js';
import { isWebAuthJwtEnabled, signWebAuthJwt, verifyWebAuthJwt } from './jwt/webJwtService.js';
import userPasswordAuthService from './userPassword/index.js';
import { createUserPasswordRecoveryService } from './userPassword/userPasswordRecoveryService.js';
import { createTermsAcceptanceHandler } from './termsAcceptance/termsAcceptanceHandler.js';
import { createWebAccountAuthHandlers } from './webAccount/webAccountHandlers.js';
import { parseTermsAcceptancePayload, parseUserPasswordLoginPayload, parseUserPasswordRecoveryRequestPayload, parseUserPasswordRecoveryVerifyPayload, parseUserPasswordUpsertPayload } from './validation/authSchemas.js';

export const createStickerCatalogAuthContext = ({ executeQuery, runSqlTransaction, tables, logger, sendJson, readJsonBody, parseCookies, getCookieValuesFromRequest, appendSetCookie, buildCookieString, normalizeEmail, normalizeJid, sanitizeText, toIsoOrNull, toWhatsAppPhoneDigits, resolveWhatsAppOwnerJidFromLoginPayload, assertGoogleIdentityNotBanned, queueAutomatedEmail, queueWelcomeEmail, resolveRequestRemoteIp, toSiteAbsoluteUrl, listStickerPacksByOwner, listStickerPackEngagementByPackIds, mapPackSummary, isPackPubliclyVisible, resolveMyProfileOwnerCandidates, shouldHidePackFromMyProfileDefault, parseEnvBool, clampInt, userProfileWebPath, userPasswordResetWebPath, passwordRecoverySessionAuthMethod, passwordRecoverySessionTtlSeconds, webSessionCookieName, notAllowedErrorCode, stickerWebGoogleClientId, stickerWebGoogleAuthRequired, stickerWebGoogleSessionTtlMs, stickerApiBasePath, stickerWebPath, stickerLoginWebPath, siteOrigin }) => {
  const enqueueGoogleWebWelcomeEmail = ({ email, name, ownerJid }) => {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !normalizedEmail.includes('@')) return;

    const safeName = sanitizeText(name || '', 80, { allowEmpty: true }) || '';
    const normalizedOwnerJid = normalizeJid(ownerJid) || null;
    const idempotencyKey = `google_web_welcome:${normalizedEmail}:${__timeNowIso().slice(0, 10)}`;

    void queueWelcomeEmail({
      to: normalizedEmail,
      name: safeName,
      redirectUrl: `${siteOrigin}/user/`,
      homeUrl: `${siteOrigin}/`,
      metadata: {
        trigger: 'google_web_auth',
        owner_jid: normalizedOwnerJid,
      },
      idempotencyKey,
    }).catch((error) => {
      logger.warn('Falha ao enfileirar e-mail de boas-vindas pós-login Google Web.', {
        action: 'google_web_welcome_email_enqueue_failed',
        email: normalizedEmail,
        owner_jid: normalizedOwnerJid,
        error: error?.message,
      });
    });
  };

  const googleWebAuth = createGoogleWebAuthRuntime({
    executeQuery,
    runSqlTransaction,
    tables,
    logger,
    sendJson,
    readJsonBody,
    parseCookies,
    getCookieValuesFromRequest,
    appendSetCookie,
    buildCookieString,
    normalizeEmail,
    normalizeJid,
    sanitizeText,
    toIsoOrNull,
    toWhatsAppPhoneDigits,
    resolveWhatsAppOwnerJidFromLoginPayload,
    assertGoogleIdentityNotBanned,
    googleClientId: stickerWebGoogleClientId,
    sessionTtlMs: stickerWebGoogleSessionTtlMs,
    apiBasePath: stickerApiBasePath,
    webPath: stickerWebPath,
    loginWebPath: stickerLoginWebPath,
    configuredSessionCookiePath: process.env.STICKER_WEB_GOOGLE_SESSION_COOKIE_PATH,
    notAllowedErrorCode,
    onGoogleWebSessionCreated: ({ email, name, ownerJid }) => {
      enqueueGoogleWebWelcomeEmail({ email, name, ownerJid });
    },
  });

  const { upsertGoogleWebUserRecord, resolveGoogleWebSessionFromRequest, mapGoogleSessionResponseData, setGoogleWebSessionCookie, issueAccessTokenForSession, createPersistedGoogleWebSessionFromIdentity, handleGoogleAuthSessionRequest, revokeGoogleWebSessionsByIdentity, buildGoogleOwnerJid } = googleWebAuth;

  const userPasswordRecoveryService = createUserPasswordRecoveryService({
    executeQuery,
    userPasswordAuthService,
    queueAutomatedEmail,
    revokeWebSessionsByIdentity: revokeGoogleWebSessionsByIdentity,
    tables,
    logger,
    runSqlTransaction,
  });

  const handleTermsAcceptanceRequest = createTermsAcceptanceHandler({
    executeQuery,
    tables,
    logger,
    sendJson,
    readJsonBody,
    parseTermsAcceptancePayload,
    parseCookies,
    resolveGoogleWebSessionFromRequest,
    normalizeGoogleSubject,
    normalizeEmail,
    normalizeJid,
    resolveRequestRemoteIp,
    sanitizeText,
    webSessionCookieName,
  });

  const { handlePasswordAuthRequest, handlePasswordRecoveryRequest, handlePasswordRecoveryVerifyRequest, handlePasswordRecoverySessionCreateRequest, handlePasswordRecoverySessionStatusRequest, handlePasswordRecoverySessionRequest, handlePasswordRecoverySessionVerifyRequest, handlePasswordLoginRequest, handleMyProfileRequest } = createWebAccountAuthHandlers({
    sendJson,
    readJsonBody,
    logger,
    parseUserPasswordUpsertPayload,
    parseUserPasswordRecoveryRequestPayload,
    parseUserPasswordRecoveryVerifyPayload,
    parseUserPasswordLoginPayload,
    resolveGoogleWebSessionFromRequest,
    mapGoogleSessionResponseData,
    revokeGoogleWebSessionsByIdentity,
    createPersistedGoogleWebSessionFromIdentity,
    setGoogleWebSessionCookie,
    issueAccessTokenForSession,
    userPasswordAuthService,
    userPasswordRecoveryService,
    resolveRequestRemoteIp,
    normalizeEmail,
    normalizeGoogleSubject,
    normalizeJid,
    isWebAuthJwtEnabled,
    signWebAuthJwt,
    verifyWebAuthJwt,
    passwordRecoverySessionAuthMethod,
    passwordRecoverySessionTtlSeconds: passwordRecoverySessionTtlSeconds,
    userProfileWebPath: userProfileWebPath,
    userPasswordResetWebPath: userPasswordResetWebPath,
    toSiteAbsoluteUrl,
    executeQuery,
    tables,
    toIsoOrNull,
    sanitizeText,
    listStickerPacksByOwner,
    listStickerPackEngagementByPackIds,
    mapPackSummary,
    isPackPubliclyVisible,
    resolveMyProfileOwnerCandidates,
    shouldHidePackFromMyProfileDefault,
    parseEnvBool,
    clampInt,
    stickerWebGoogleClientId,
    stickerWebGoogleAuthRequired,
    toWhatsAppPhoneDigits,
    getActiveSocket: () => globalThis.getActiveSocketBridge?.() || null,
    profilePictureUrlFromActiveSocket: (jid, type, timeout) => globalThis.profilePictureUrlFromActiveSocketBridge?.(jid, type, timeout) || Promise.resolve(null),
  });

  return {
    upsertGoogleWebUserRecord,
    resolveGoogleWebSessionFromRequest,
    mapGoogleSessionResponseData,
    setGoogleWebSessionCookie,
    issueAccessTokenForSession,
    createPersistedGoogleWebSessionFromIdentity,
    handleGoogleAuthSessionRequest,
    revokeGoogleWebSessionsByIdentity,
    buildGoogleOwnerJid,
    handleTermsAcceptanceRequest,
    handlePasswordAuthRequest,
    handlePasswordRecoveryRequest,
    handlePasswordRecoveryVerifyRequest,
    handlePasswordRecoverySessionCreateRequest,
    handlePasswordRecoverySessionStatusRequest,
    handlePasswordRecoverySessionRequest,
    handlePasswordRecoverySessionVerifyRequest,
    handlePasswordLoginRequest,
    handleMyProfileRequest,
  };
};
