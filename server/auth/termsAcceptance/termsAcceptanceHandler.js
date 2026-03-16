import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_LEGAL_VERSION = '2026-03-07';

const normalizeLegalDocumentKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);

const normalizeLegalDocumentVersion = (value) =>
  String(value || '')
    .trim()
    .slice(0, 64);

const normalizeTermsAcceptanceSource = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);

const normalizeTermsAcceptanceSessionKey = (value) =>
  String(value || '')
    .trim()
    .slice(0, 80);

const normalizeRequestUserAgent = (value) =>
  String(value || '')
    .trim()
    .slice(0, 512) || null;

const parseAcceptedAtClientDate = (value) => {
  const parsedAt = Date.parse(String(value || '').trim());
  if (!Number.isFinite(parsedAt)) return null;
  return new Date(parsedAt);
};

const buildLegalDocumentVersionHash = (documentKey, documentVersion) => createHash('sha256').update(`${documentKey}:${documentVersion}`).digest('hex');

const defaultSanitizeText = (value, maxLength, { allowEmpty = true } = {}) => {
  const normalized = String(value || '')
    .trim()
    .slice(0, Math.max(0, Number(maxLength) || 0));
  if (!normalized && !allowEmpty) return '';
  return normalized;
};

export const createTermsAcceptanceHandler = ({ executeQuery, tables, logger, sendJson, readJsonBody, parseTermsAcceptancePayload, parseCookies, resolveGoogleWebSessionFromRequest, normalizeGoogleSubject, normalizeEmail, normalizeJid, resolveRequestRemoteIp, sanitizeText, webSessionCookieName = 'omnizap_sid' }) => {
  const sanitize = typeof sanitizeText === 'function' ? sanitizeText : defaultSanitizeText;

  const legalTermsVersion =
    sanitize(process.env.LEGAL_TERMS_VERSION || DEFAULT_LEGAL_VERSION, 64, {
      allowEmpty: false,
    }) || DEFAULT_LEGAL_VERSION;
  const legalPrivacyVersion =
    sanitize(process.env.LEGAL_PRIVACY_VERSION || DEFAULT_LEGAL_VERSION, 64, {
      allowEmpty: false,
    }) || DEFAULT_LEGAL_VERSION;
  const legalAupVersion =
    sanitize(process.env.LEGAL_AUP_VERSION || DEFAULT_LEGAL_VERSION, 64, {
      allowEmpty: false,
    }) || DEFAULT_LEGAL_VERSION;
  const legalDefaultAcceptanceSource =
    sanitize(process.env.LEGAL_TERMS_ACCEPTANCE_SOURCE || 'login_web', 32, {
      allowEmpty: false,
    }) || 'login_web';
  const legalDocumentRegistry = Object.freeze({
    termos_de_uso: legalTermsVersion,
    politica_de_privacidade: legalPrivacyVersion,
    politica_uso_aceitavel: legalAupVersion,
  });

  const resolveTermsAcceptanceDocuments = (documents = []) => {
    const uniqueByVersion = new Map();
    for (const doc of Array.isArray(documents) ? documents : []) {
      const documentKey = normalizeLegalDocumentKey(doc?.document_key);
      if (!documentKey) continue;
      const fallbackVersion = legalDocumentRegistry[documentKey] || '';
      const documentVersion = normalizeLegalDocumentVersion(doc?.document_version) || fallbackVersion;
      if (!documentVersion) continue;
      const uniqueKey = `${documentKey}:${documentVersion}`;
      if (uniqueByVersion.has(uniqueKey)) continue;
      uniqueByVersion.set(uniqueKey, {
        documentKey,
        documentVersion,
        documentVersionHash: buildLegalDocumentVersionHash(documentKey, documentVersion),
        isCurrentVersion: fallbackVersion ? fallbackVersion === documentVersion : false,
      });
    }
    return Array.from(uniqueByVersion.values());
  };

  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Metodo nao permitido.' });
      return;
    }

    let payload = {};
    try {
      payload = await readJsonBody(req);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Body invalido.',
      });
      return;
    }

    try {
      payload = parseTermsAcceptancePayload(payload);
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode || 400), {
        error: error?.message || 'Payload de aceite juridico invalido.',
        code: error?.code || 'INVALID_PAYLOAD',
        details: Array.isArray(error?.details) ? error.details : undefined,
      });
      return;
    }

    const acceptedDocuments = resolveTermsAcceptanceDocuments(payload.documents);
    if (!acceptedDocuments.length) {
      sendJson(req, res, 400, {
        error: 'Nenhum documento valido para registrar aceite.',
        code: 'TERMS_ACCEPTANCE_EMPTY',
      });
      return;
    }

    const source = normalizeTermsAcceptanceSource(payload.source) || legalDefaultAcceptanceSource;
    const acceptedAt = __timeNow();
    const acceptedAtClient = parseAcceptedAtClientDate(payload.accepted_at);
    const cookies = parseCookies(req);
    const sessionKey = normalizeTermsAcceptanceSessionKey(cookies[webSessionCookieName] || '');
    const remoteIp = resolveRequestRemoteIp(req);
    const userAgent = normalizeRequestUserAgent(req.headers?.['user-agent'] || '');
    const session = await resolveGoogleWebSessionFromRequest(req).catch(() => null);

    const normalizedGoogleSub = normalizeGoogleSubject(session?.sub || '');
    const normalizedEmail = normalizeEmail(session?.email || '');
    const normalizedOwnerJid = normalizeJid(session?.ownerJid || '') || '';
    const metadata = JSON.stringify({
      accepted: true,
      context: payload.context || null,
      legal_document_registry: legalDocumentRegistry,
    });

    const valueRows = acceptedDocuments.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const doc of acceptedDocuments) {
      params.push(randomUUID(), doc.documentKey, doc.documentVersion, doc.documentVersionHash, acceptedAt, acceptedAtClient, source, normalizedGoogleSub || null, normalizedEmail || null, normalizedOwnerJid || null, sessionKey || null, remoteIp || null, userAgent, metadata);
    }

    try {
      await executeQuery(
        `INSERT INTO ${tables.STICKER_WEB_TERMS_ACCEPTANCE_EVENT}
          (event_id, document_key, document_version, document_version_hash, accepted_at, accepted_at_client, source, google_sub, email, owner_jid, session_key, ip_address, user_agent, metadata)
         VALUES ${valueRows}`,
        params,
      );

      sendJson(req, res, 201, {
        data: {
          accepted: true,
          source,
          accepted_at: acceptedAt.toISOString(),
          accepted_documents: acceptedDocuments.map((doc) => ({
            document_key: doc.documentKey,
            document_version: doc.documentVersion,
            document_version_hash: doc.documentVersionHash,
            current_version: doc.isCurrentVersion,
          })),
        },
      });
    } catch (error) {
      logger.warn('Falha ao registrar aceite juridico versionado.', {
        action: 'web_terms_acceptance_insert_failed',
        error: error?.message,
        source,
        document_count: acceptedDocuments.length,
      });
      sendJson(req, res, Number(error?.statusCode || 500), {
        error: 'Falha ao registrar aceite juridico.',
        code: 'TERMS_ACCEPTANCE_INSERT_FAILED',
      });
    }
  };
};
