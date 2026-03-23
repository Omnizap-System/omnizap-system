import fs from 'node:fs/promises';
import path from 'node:path';

import logger from '#logger';
import { buildWhatsappUrl, formatWhatsappDisplay, resolvePublicWhatsappNumber } from '../../utils/publicContact.js';

const normalizeBasePath = (value, fallback) => {
  const raw = String(value || '').trim() || fallback;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const withoutTrailingSlash = withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
  return withoutTrailingSlash || fallback;
};

const normalizeRoutePath = (pathname) => {
  const rawPath = String(pathname || '').trim();
  if (!rawPath || rawPath === '/') return '/';
  return rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
};

const STICKER_LOGIN_WEB_PATH = normalizeBasePath(process.env.STICKER_LOGIN_WEB_PATH, '/login');
const PUBLIC_PAGES_DIR = path.join(process.cwd(), 'public', 'pages');
const SEO_ROUTE_PREFIX = '/seo/';
const SEO_SLUG_REGEX = /^[a-z0-9-]+$/;
const INDEX_FILE_SUFFIX = '/index.html';
const LGPD_DEFAULT_TEXT = 'Olá, gostaria de exercer meus direitos de titular de dados (LGPD).';
const SUPPORT_WHATSAPP_NUMBER = resolvePublicWhatsappNumber();
const SUPPORT_WHATSAPP_URL = buildWhatsappUrl(SUPPORT_WHATSAPP_NUMBER);
const SUPPORT_WHATSAPP_URL_LGPD = buildWhatsappUrl(SUPPORT_WHATSAPP_NUMBER, process.env.WHATSAPP_SUPPORT_LGPD_TEXT || LGPD_DEFAULT_TEXT);
const SUPPORT_WHATSAPP_DISPLAY = formatWhatsappDisplay(SUPPORT_WHATSAPP_NUMBER);

const STATIC_PAGE_ROUTE_TO_FILE = new Map(
  [
    ['/', 'home.html'],
    ['/api-docs', 'api-docs.html'],
    ['/aup', 'aup.html'],
    ['/comandos', 'comandos.html'],
    ['/dpa', 'dpa.html'],
    ['/licenca', 'licenca.html'],
    ['/notice-and-takedown', 'notice-and-takedown.html'],
    ['/pagamentos', 'pagamentos.html'],
    ['/pagamentos/sucesso', 'pagamentos-sucesso.html'],
    ['/pagamentos/cancelado', 'pagamentos-cancelado.html'],
    ['/politica-de-privacidade', 'politica-de-privacidade.html'],
    ['/suboperadores', 'suboperadores.html'],
    ['/termos-de-uso', 'termos-de-uso.html'],
    ['/termos-de-uso/texto-integral', 'termos-de-uso-texto-integral.html'],
    ['/termos-de-uso/texto-integral.html', 'termos-de-uso-texto-integral.html'],
    [STICKER_LOGIN_WEB_PATH, 'login.html'],
  ].map(([routePath, fileName]) => [normalizeRoutePath(routePath), fileName]),
);

const resolveMappedTemplateName = (normalizedPath) => {
  const mappedTemplate = STATIC_PAGE_ROUTE_TO_FILE.get(normalizedPath);
  if (mappedTemplate) return mappedTemplate;

  if (normalizedPath.startsWith(SEO_ROUTE_PREFIX)) {
    const seoSlug = normalizedPath.slice(SEO_ROUTE_PREFIX.length);
    if (seoSlug && SEO_SLUG_REGEX.test(seoSlug)) {
      return `seo-${seoSlug}.html`;
    }
  }

  return null;
};

const resolveStaticTemplateName = (pathname) => {
  const normalizedPath = normalizeRoutePath(pathname);
  const mappedTemplate = resolveMappedTemplateName(normalizedPath);
  if (mappedTemplate) return mappedTemplate;

  if (normalizedPath.endsWith(INDEX_FILE_SUFFIX)) {
    const withoutIndex = normalizedPath.slice(0, -INDEX_FILE_SUFFIX.length);
    const aliasPath = withoutIndex || '/';
    return resolveMappedTemplateName(aliasPath);
  }

  return null;
};

const sendHtml = (req, res, html) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(html);
};

const sendJson = (req, res, statusCode, payload) => {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
};

const injectStaticTemplateTokens = (html) => {
  let rendered = String(html || '');
  const replacements = {
    __WHATSAPP_SUPPORT_NUMBER__: SUPPORT_WHATSAPP_NUMBER,
    __WHATSAPP_SUPPORT_URL__: SUPPORT_WHATSAPP_URL,
    __WHATSAPP_SUPPORT_URL_LGPD__: SUPPORT_WHATSAPP_URL_LGPD,
    __WHATSAPP_SUPPORT_DISPLAY__: SUPPORT_WHATSAPP_DISPLAY,
    __WHATSAPP_PUBLIC_CONTACT_NUMBER__: SUPPORT_WHATSAPP_NUMBER,
    __WHATSAPP_PUBLIC_CONTACT_URL__: SUPPORT_WHATSAPP_URL,
    __WHATSAPP_PUBLIC_CONTACT_URL_LGPD__: SUPPORT_WHATSAPP_URL_LGPD,
    __WHATSAPP_PUBLIC_CONTACT_DISPLAY__: SUPPORT_WHATSAPP_DISPLAY,
  };

  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, String(value || ''));
  }

  return rendered;
};

export const shouldHandleStaticPagePath = (pathname) => Boolean(resolveStaticTemplateName(pathname));

export const maybeHandleStaticPageRequest = async (req, res, { pathname } = {}) => {
  if (!['GET', 'HEAD'].includes(req.method || '')) return false;

  const normalizedPath = normalizeRoutePath(pathname);
  const templateName = resolveStaticTemplateName(normalizedPath);
  if (!templateName) return false;

  // Redireciona usuário logado tentando acessar página de login
  if (templateName === 'login.html') {
    try {
      const session = await globalThis.resolveGoogleWebSessionFromRequestBridge?.(req);
      if (session?.sub && (session.ownerJid || session.ownerPhone || session.email)) {
        res.statusCode = 302;
        res.setHeader('Location', '/user/');
        res.end();
        return true;
      }
    } catch (error) {
      logger.warn('Falha ao verificar sessao para redirecionamento de login.', { error: error?.message });
    }
  }

  const templatePath = path.join(PUBLIC_PAGES_DIR, templateName);
  try {
    const html = await fs.readFile(templatePath, 'utf8');
    sendHtml(req, res, injectStaticTemplateTokens(html));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(req, res, 404, { error: 'Template da pagina nao encontrado.' });
      return true;
    }
    logger.error('Falha ao renderizar pagina estatica.', {
      action: 'static_page_render_failed',
      path: normalizedPath,
      template: templateName,
      error: error?.message,
    });
    sendJson(req, res, 500, { error: 'Falha interna ao renderizar pagina.' });
  }
  return true;
};
