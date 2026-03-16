import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import fs from 'node:fs/promises';

export const createStickerCatalogSeoContext = ({ executeQuery, tables, listStickerPacksForCatalog, logger, sendJson, toSiteAbsoluteUrl, isPackPubliclyVisible, buildPackWebUrl, config }) => {
  const { stickerWebPath, stickerApiBasePath, stickerOrphanApiPath, stickerLoginWebPath, stickerCreateWebPath, stickerDataPublicPath, defaultListLimit, defaultOrphanListLimit, catalogTemplatePath, createPackTemplatePath, catalogStylesFilePath, catalogScriptFilePath, stickerWebAssetVersion, catalogStylesWebPath, catalogScriptWebPath, nsfwStickerPlaceholderUrl, packCommandPrefix, staticTextCacheSeconds, immutableAssetCacheSeconds, sitemapMaxPacks, sitemapCacheSeconds, seoDiscoveryLinkLimit, seoDiscoveryCacheSeconds } = config;

  const SITEMAP_CACHE = {
    expiresAt: 0,
    xml: '',
  };
  const SEO_DISCOVERY_CACHE = {
    expiresAt: 0,
    html: '',
  };

  const escapeHtmlAttribute = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const escapeXml = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  const normalizeWhitespace = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();

  const truncateText = (value, maxLength = 160) => {
    const normalized = normalizeWhitespace(value);
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
  };

  const toDateOnly = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  };

  const appendAssetVersionQuery = (assetPath) => (stickerWebAssetVersion ? `${assetPath}?v=${encodeURIComponent(stickerWebAssetVersion)}` : assetPath);
  const buildCatalogStylesUrl = () => appendAssetVersionQuery(catalogStylesWebPath);
  const buildCatalogScriptUrl = () => appendAssetVersionQuery(catalogScriptWebPath);
  const buildStickersReactBundleUrl = () => appendAssetVersionQuery('/assets/js/stickers-react.bundle.js');

  const buildCatalogDiscoveryLinksHtml = async () => {
    if (SEO_DISCOVERY_CACHE.expiresAt > __timeNowMs() && SEO_DISCOVERY_CACHE.html) {
      return SEO_DISCOVERY_CACHE.html;
    }

    try {
      const { packs } = await listStickerPacksForCatalog({
        visibility: 'public',
        search: '',
        limit: seoDiscoveryLinkLimit,
        offset: 0,
      });

      const links = (Array.isArray(packs) ? packs : []).filter((pack) => pack?.pack_key && isPackPubliclyVisible(pack)).slice(0, seoDiscoveryLinkLimit);

      if (!links.length) {
        SEO_DISCOVERY_CACHE.expiresAt = __timeNowMs() + seoDiscoveryCacheSeconds * 1000;
        SEO_DISCOVERY_CACHE.html = '';
        return '';
      }

      const linksMarkup = links
        .map((pack) => {
          const href = escapeHtmlAttribute(buildPackWebUrl(pack.pack_key));
          const label = escapeHtmlAttribute(truncateText(pack.name || pack.pack_key, 80));
          return `<li><a href="${href}">${label}</a></li>`;
        })
        .join('');

      const html = `
<noscript>
  <section id="seo-discovery-links" style="padding:16px;color:#e5e7eb;background:#020617;">
    <h2 style="margin:0 0 8px;font-size:18px;">Packs populares</h2>
    <p style="margin:0 0 12px;">Navegue direto pelos packs mais recentes:</p>
    <ul style="margin:0;padding-left:18px;display:grid;gap:6px;">
      ${linksMarkup}
    </ul>
  </section>
</noscript>`;

      SEO_DISCOVERY_CACHE.expiresAt = __timeNowMs() + seoDiscoveryCacheSeconds * 1000;
      SEO_DISCOVERY_CACHE.html = html;
      return html;
    } catch (error) {
      logger.warn('Falha ao gerar links SEO de descoberta do catalogo.', {
        action: 'sticker_catalog_seo_discovery_links_failed',
        error: error?.message,
      });
      return '';
    }
  };

  const renderCatalogHtml = async ({ initialPackKey }) => {
    const template = await fs.readFile(catalogTemplatePath, 'utf8');
    const replacements = {
      __STICKER_WEB_PATH__: escapeHtmlAttribute(stickerWebPath),
      __STICKER_API_BASE_PATH__: escapeHtmlAttribute(stickerApiBasePath),
      __STICKER_ORPHAN_API_PATH__: escapeHtmlAttribute(stickerOrphanApiPath),
      __STICKER_LOGIN_WEB_PATH__: escapeHtmlAttribute(stickerLoginWebPath),
      __STICKER_DATA_PUBLIC_PATH__: escapeHtmlAttribute(stickerDataPublicPath),
      __DEFAULT_LIST_LIMIT__: String(defaultListLimit),
      __DEFAULT_ORPHAN_LIST_LIMIT__: String(defaultOrphanListLimit),
      __INITIAL_PACK_KEY__: escapeHtmlAttribute(initialPackKey || ''),
      __CATALOG_STYLES_PATH__: escapeHtmlAttribute(buildCatalogStylesUrl()),
      __CATALOG_SCRIPT_PATH__: escapeHtmlAttribute(buildCatalogScriptUrl()),
      __CURRENT_YEAR__: String(__timeNow().getFullYear()),
    };

    let html = template;
    for (const [token, value] of Object.entries(replacements)) {
      html = html.replaceAll(token, value);
    }

    const initialPackKeyAttr = `data-initial-pack-key="${escapeHtmlAttribute(initialPackKey || '')}"`;
    html = html.replace(/data-initial-pack-key="[^"]*"/i, initialPackKeyAttr);

    if (!/rel="canonical"/i.test(html)) {
      html = html.replace('</head>', `  <link rel="canonical" href="${escapeHtmlAttribute(toSiteAbsoluteUrl(`${stickerWebPath}/`))}" />\n</head>`);
    }

    const discoveryLinks = await buildCatalogDiscoveryLinksHtml();
    if (discoveryLinks && html.includes('</body>')) {
      html = html.replace('</body>', `${discoveryLinks}\n</body>`);
    }

    return html;
  };

  const renderPackSeoHtml = ({ packSummary }) => {
    const packName = truncateText(packSummary?.name || packSummary?.pack_key || 'Pack', 95);
    const packDescription = truncateText(packSummary?.description || `Pack de stickers "${packName}" disponível no catálogo OmniZap para uso em bots e automações WhatsApp via API.`, 180);
    const canonicalUrl = toSiteAbsoluteUrl(buildPackWebUrl(packSummary?.pack_key || ''));
    const catalogUrl = toSiteAbsoluteUrl(`${stickerWebPath}/`);
    const homeUrl = toSiteAbsoluteUrl('/');
    const apiDocsUrl = toSiteAbsoluteUrl('/api-docs/');
    const fallbackCoverUrl = packSummary?.is_nsfw ? nsfwStickerPlaceholderUrl : 'https://iili.io/fSNGag2.png';
    const coverUrl = toSiteAbsoluteUrl(packSummary?.cover_url || fallbackCoverUrl);
    const publisher = truncateText(packSummary?.publisher || 'Criador OmniZap', 80);
    const stickerCount = Math.max(0, Number(packSummary?.sticker_count || 0));
    const updatedAt = packSummary?.updated_at || packSummary?.created_at || __timeNowIso();
    const schemaJson = JSON.stringify(
      {
        '@context': 'https://schema.org',
        '@type': 'CreativeWork',
        name: packName,
        description: packDescription,
        url: canonicalUrl,
        image: coverUrl,
        dateModified: updatedAt,
        author: {
          '@type': 'Person',
          name: publisher,
        },
        inLanguage: 'pt-BR',
      },
      null,
      0,
    ).replace(/</g, '\\u003c');
    const faqSchemaJson = JSON.stringify(
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: `Como usar o pack ${packName} no meu bot?`,
            acceptedAnswer: {
              '@type': 'Answer',
              text: `Use o pack ${packName} como recurso de engajamento e consulte exemplos de integração em ${apiDocsUrl}.`,
            },
          },
          {
            '@type': 'Question',
            name: 'Onde encontro mais packs de stickers?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: `Veja o catálogo completo em ${catalogUrl}.`,
            },
          },
          {
            '@type': 'Question',
            name: 'Onde vejo a plataforma principal do OmniZap?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: `A página principal do OmniZap está em ${homeUrl}.`,
            },
          },
        ],
      },
      null,
      0,
    ).replace(/</g, '\\u003c');

    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtmlAttribute(`${packName} | Stickers para Bot WhatsApp OmniZap`)}</title>
  <meta name="description" content="${escapeHtmlAttribute(packDescription)}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <link rel="canonical" href="${escapeHtmlAttribute(canonicalUrl)}" />
  <link rel="icon" type="image/jpeg" href="https://iili.io/FC3FABe.jpg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji']
          },
          colors: {
            slateApp: '#0f172a',
            slateCard: '#1e293b',
            borderApp: 'rgba(255,255,255,0.05)',
            accent: '#2563eb',
            accentTech: '#7c3aed',
            cta: '#22c55e'
          },
          boxShadow: {
            soft: '0 8px 24px rgba(2, 6, 23, 0.22)'
          }
        }
      }
    };
  </script>

  <meta property="og:type" content="website" />
  <meta property="og:locale" content="pt_BR" />
  <meta property="og:site_name" content="Omnizap" />
  <meta property="og:title" content="${escapeHtmlAttribute(packName)}" />
  <meta property="og:description" content="${escapeHtmlAttribute(packDescription)}" />
  <meta property="og:url" content="${escapeHtmlAttribute(canonicalUrl)}" />
  <meta property="og:image" content="${escapeHtmlAttribute(coverUrl)}" />
  <meta property="og:image:alt" content="${escapeHtmlAttribute(`Capa do pack ${packName}`)}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtmlAttribute(packName)}" />
  <meta name="twitter:description" content="${escapeHtmlAttribute(packDescription)}" />
  <meta name="twitter:image" content="${escapeHtmlAttribute(coverUrl)}" />

  <script type="application/ld+json">${schemaJson}</script>
  <script type="application/ld+json">${faqSchemaJson}</script>
  <style>
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", sans-serif; background: #0f172a; color: #f8fafc; }
    .seo-shell { max-width: 880px; margin: 0 auto; padding: 18px 14px 12px; }
    .seo-card { border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 12px; background: #1e293b; padding: 16px; }
    .seo-card h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.2; }
    .seo-card p { margin: 0 0 10px; line-height: 1.55; color: #94a3b8; }
    .seo-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .seo-row a { color: #2563eb; text-decoration: none; border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 8px; padding: 8px 10px; }
    .seo-row a:hover { background: #111827; }
  </style>
</head>
<body class="bg-slateApp text-slate-100 font-sans min-h-screen">
  <noscript>
    <main class="seo-shell">
      <section class="seo-card">
        <h1>${escapeHtmlAttribute(packName)}</h1>
        <p>${escapeHtmlAttribute(packDescription)}</p>
        <p>Criador: <strong>${escapeHtmlAttribute(publisher)}</strong> • Stickers: <strong>${stickerCount}</strong></p>
        <p>Use este pack como recurso integrado no seu bot. Consulte endpoints e exemplos na área de desenvolvedor da API OmniZap.</p>
        <h2 style="margin:12px 0 6px;font-size:18px;">FAQ rápido</h2>
        <p style="margin-bottom:6px;"><strong>Como usar no bot?</strong> Consulte a documentação técnica e exemplos na área de desenvolvedor.</p>
        <p style="margin-bottom:6px;"><strong>Tem mais packs?</strong> Sim, explore o catálogo completo para encontrar packs relacionados.</p>
        <div class="seo-row">
          <a href="${escapeHtmlAttribute(canonicalUrl)}">Abrir este pack</a>
          <a href="${escapeHtmlAttribute(catalogUrl)}">Voltar ao catálogo</a>
          <a href="${escapeHtmlAttribute(apiDocsUrl)}">Área de Desenvolvedor</a>
          <a href="${escapeHtmlAttribute(homeUrl)}">Plataforma OmniZap</a>
        </div>
      </section>
    </main>
  </noscript>

  <div id="stickers-react-root"
    data-web-path="${escapeHtmlAttribute(stickerWebPath)}"
    data-api-base-path="${escapeHtmlAttribute(stickerApiBasePath)}"
    data-orphan-api-path="${escapeHtmlAttribute(stickerOrphanApiPath)}"
    data-login-path="${escapeHtmlAttribute(stickerLoginWebPath)}"
    data-default-limit="${defaultListLimit}"
    data-default-orphan-limit="${defaultOrphanListLimit}"
    data-initial-pack-key="${escapeHtmlAttribute(packSummary?.pack_key || '')}"
  ></div>
  <script type="module" src="${escapeHtmlAttribute(buildStickersReactBundleUrl())}"></script>
</body>
</html>`;
  };

  const renderPackNotFoundHtml = (packKey = '') => `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pack não encontrado | OmniZap</title>
  <meta name="robots" content="noindex, nofollow" />
  <link rel="canonical" href="${escapeHtmlAttribute(toSiteAbsoluteUrl(`${stickerWebPath}/`))}" />
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #f8fafc; }
    main { max-width: 760px; margin: 0 auto; padding: 20px 14px; }
    article { border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 12px; background: #1e293b; padding: 16px; }
    a { color: #2563eb; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <article>
      <h1>Pack não encontrado</h1>
      <p>Não localizamos o pack <strong>${escapeHtmlAttribute(packKey || 'informado')}</strong>.</p>
      <p><a href="${escapeHtmlAttribute(toSiteAbsoluteUrl(`${stickerWebPath}/`))}">Ir para o catálogo</a></p>
    </article>
  </main>
</body>
</html>`;

  const renderCreatePackHtml = async () => {
    const template = await fs.readFile(createPackTemplatePath, 'utf8');
    const replacements = {
      __STICKER_WEB_PATH__: escapeHtmlAttribute(stickerWebPath),
      __STICKER_CREATE_WEB_PATH__: escapeHtmlAttribute(stickerCreateWebPath),
      __STICKER_LOGIN_WEB_PATH__: escapeHtmlAttribute(stickerLoginWebPath),
      __STICKER_API_BASE_PATH__: escapeHtmlAttribute(stickerApiBasePath),
      __PACK_COMMAND_PREFIX__: escapeHtmlAttribute(packCommandPrefix),
      __CURRENT_YEAR__: String(__timeNow().getFullYear()),
    };

    let html = template;
    for (const [token, value] of Object.entries(replacements)) {
      html = html.replaceAll(token, value);
    }
    return html;
  };

  const buildSitemapXml = async () => {
    if (SITEMAP_CACHE.expiresAt > __timeNowMs() && SITEMAP_CACHE.xml) {
      return SITEMAP_CACHE.xml;
    }

    const staticUrls = [
      { loc: toSiteAbsoluteUrl('/'), changefreq: 'daily', priority: '1.0' },
      { loc: toSiteAbsoluteUrl(`${stickerWebPath}/`), changefreq: 'hourly', priority: '0.9' },
      { loc: toSiteAbsoluteUrl('/api-docs/'), changefreq: 'weekly', priority: '0.8' },
      { loc: toSiteAbsoluteUrl('/comandos/'), changefreq: 'weekly', priority: '0.78' },
      { loc: toSiteAbsoluteUrl('/termos-de-uso/'), changefreq: 'monthly', priority: '0.5' },
      {
        loc: toSiteAbsoluteUrl('/politica-de-privacidade/'),
        changefreq: 'monthly',
        priority: '0.5',
      },
      { loc: toSiteAbsoluteUrl('/aup/'), changefreq: 'monthly', priority: '0.45' },
      { loc: toSiteAbsoluteUrl('/dpa/'), changefreq: 'monthly', priority: '0.45' },
      { loc: toSiteAbsoluteUrl('/notice-and-takedown/'), changefreq: 'monthly', priority: '0.45' },
      { loc: toSiteAbsoluteUrl('/suboperadores/'), changefreq: 'monthly', priority: '0.45' },
      { loc: toSiteAbsoluteUrl('/licenca/'), changefreq: 'monthly', priority: '0.5' },
      {
        loc: toSiteAbsoluteUrl('/seo/bot-whatsapp-para-grupo/'),
        changefreq: 'weekly',
        priority: '0.75',
      },
      {
        loc: toSiteAbsoluteUrl('/seo/como-moderar-grupo-whatsapp/'),
        changefreq: 'weekly',
        priority: '0.72',
      },
      {
        loc: toSiteAbsoluteUrl('/seo/como-evitar-spam-no-whatsapp/'),
        changefreq: 'weekly',
        priority: '0.72',
      },
      {
        loc: toSiteAbsoluteUrl('/seo/como-organizar-comunidade-whatsapp/'),
        changefreq: 'weekly',
        priority: '0.72',
      },
      {
        loc: toSiteAbsoluteUrl('/seo/como-automatizar-avisos-no-whatsapp/'),
        changefreq: 'weekly',
        priority: '0.72',
      },
      {
        loc: toSiteAbsoluteUrl('/seo/como-criar-comandos-whatsapp/'),
        changefreq: 'weekly',
        priority: '0.71',
      },
      {
        loc: toSiteAbsoluteUrl('/seo/melhor-bot-whatsapp-para-grupos/'),
        changefreq: 'weekly',
        priority: '0.74',
      },
      {
        loc: toSiteAbsoluteUrl('/seo/bot-whatsapp-sem-programar/'),
        changefreq: 'weekly',
        priority: '0.73',
      },
    ];

    const packRows = await executeQuery(
      `SELECT pack_key, updated_at, created_at
     FROM ${tables.STICKER_PACK}
     WHERE deleted_at IS NULL
       AND status = 'published'
       AND COALESCE(pack_status, 'ready') = 'ready'
       AND visibility IN ('public', 'unlisted')
     ORDER BY updated_at DESC
     LIMIT ?`,
      [sitemapMaxPacks],
    );

    const packUrls = (Array.isArray(packRows) ? packRows : [])
      .filter((row) => String(row?.pack_key || '').trim())
      .map((row) => ({
        loc: toSiteAbsoluteUrl(buildPackWebUrl(row.pack_key)),
        lastmod: toDateOnly(row.updated_at || row.created_at || null),
        changefreq: 'daily',
        priority: '0.7',
      }));

    const xmlItems = [...staticUrls, ...packUrls]
      .map((entry) => {
        const lastmod = entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '';
        const changefreq = entry.changefreq ? `\n    <changefreq>${escapeXml(entry.changefreq)}</changefreq>` : '';
        const priority = entry.priority ? `\n    <priority>${escapeXml(entry.priority)}</priority>` : '';
        return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}${changefreq}${priority}\n  </url>`;
      })
      .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xmlItems}\n</urlset>\n`;
    SITEMAP_CACHE.expiresAt = __timeNowMs() + sitemapCacheSeconds * 1000;
    SITEMAP_CACHE.xml = xml;
    return xml;
  };

  const handleSitemapRequest = async (req, res) => {
    const xml = await buildSitemapXml();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${sitemapCacheSeconds}`);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    res.end(xml);
    return true;
  };

  const sendStaticTextFile = async (req, res, filePath, contentType) => {
    try {
      const body = await fs.readFile(filePath, 'utf8');
      const hasVersionQuery = /(?:\?|&)v=/.test(String(req.url || ''));
      const cacheControl = hasVersionQuery ? `public, max-age=${immutableAssetCacheSeconds}, immutable` : `public, max-age=${staticTextCacheSeconds}, stale-while-revalidate=${Math.min(86400, staticTextCacheSeconds * 4)}`;
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', cacheControl);
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      res.end(body);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendJson(req, res, 404, { error: 'Arquivo estatico nao encontrado.' });
        return true;
      }

      logger.error('Falha ao servir asset estatico do catalogo.', {
        action: 'sticker_catalog_static_asset_failed',
        path: filePath,
        error: error?.message,
      });
      sendJson(req, res, 500, { error: 'Falha ao servir arquivo estatico.' });
      return true;
    }
  };

  const handleCatalogStaticAssetRequest = async (req, res, pathname) => {
    if (pathname === catalogStylesWebPath) {
      return sendStaticTextFile(req, res, catalogStylesFilePath, 'text/css; charset=utf-8');
    }

    if (pathname === catalogScriptWebPath) {
      return sendStaticTextFile(req, res, catalogScriptFilePath, 'application/javascript; charset=utf-8');
    }

    return false;
  };

  return {
    buildCatalogStylesUrl,
    buildCatalogScriptUrl,
    handleCatalogStaticAssetRequest,
    renderCatalogHtml,
    renderPackSeoHtml,
    renderPackNotFoundHtml,
    renderCreatePackHtml,
    handleSitemapRequest,
  };
};
