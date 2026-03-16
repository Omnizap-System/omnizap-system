#!/usr/bin/env node
import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CONFIG_PATH = 'docs/seo/satellite-pages-phase1.json';
const DEFAULT_OUTPUT_DIR = 'public/pages';
const DEFAULT_ROUTE_PREFIX = '/seo';
const SITE_ORIGIN = 'https://omnizap.shop';

const getArgValue = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
};

const configPath = getArgValue('--config') || DEFAULT_CONFIG_PATH;
const outputDir = getArgValue('--out') || DEFAULT_OUTPUT_DIR;
const routePrefix = getArgValue('--route-prefix') || DEFAULT_ROUTE_PREFIX;

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const toSafeJson = (value) => JSON.stringify(value, null, 0).replace(/</g, '\\u003c');

const normalizeSlug = (slug) =>
  String(slug || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

const normalizeRoutePrefix = (value) => {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, '');
};

const buildPageRoutePath = (slug, prefix = '') => {
  const normalizedPrefix = normalizeRoutePrefix(prefix);
  const normalizedSlug = normalizeSlug(slug);
  if (!normalizedSlug) return normalizedPrefix || '/';
  return normalizedPrefix ? `${normalizedPrefix}/${normalizedSlug}/` : `/${normalizedSlug}/`;
};

const rewriteSatelliteHref = (href, slugSet, prefix) => {
  const rawHref = String(href || '').trim();
  if (!rawHref || !rawHref.startsWith('/')) return rawHref;
  const pathOnly = rawHref.split('#')[0].split('?')[0];
  const maybeSlug = normalizeSlug(pathOnly);
  if (!maybeSlug || !slugSet.has(maybeSlug)) return rawHref;
  return buildPageRoutePath(maybeSlug, prefix);
};

const ensurePageConfig = (page) => {
  const slug = normalizeSlug(page?.slug);
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`slug invalido: ${page?.slug || '<vazio>'}`);
  }

  const requiredFields = ['title', 'description', 'h1', 'intro'];
  for (const field of requiredFields) {
    const value = String(page?.[field] || '').trim();
    if (!value) {
      throw new Error(`campo obrigatorio ausente em ${slug}: ${field}`);
    }
  }

  return {
    ...page,
    slug,
    title: String(page.title).trim(),
    description: String(page.description).trim(),
    h1: String(page.h1).trim(),
    intro: String(page.intro).trim(),
    intent_label: String(page.intent_label || 'Guia pratico').trim(),
    keywords: Array.isArray(page.keywords)
      ? page.keywords
          .filter(Boolean)
          .map((item) => String(item).trim())
          .filter(Boolean)
      : [],
    sections: Array.isArray(page.sections) ? page.sections : [],
    faq: Array.isArray(page.faq) ? page.faq : [],
    related_links: Array.isArray(page.related_links) ? page.related_links : [],
  };
};

const renderSection = (section) => {
  const title = String(section?.title || '').trim();
  const paragraphs = Array.isArray(section?.paragraphs) ? section.paragraphs.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const bullets = Array.isArray(section?.bullets) ? section.bullets.map((item) => String(item || '').trim()).filter(Boolean) : [];

  if (!title && paragraphs.length === 0 && bullets.length === 0) return '';

  const paragraphsHtml = paragraphs.map((paragraph) => `        <p>${escapeHtml(paragraph)}</p>`).join('\n');
  const bulletsHtml = bullets.length ? `\n        <ul>\n${bullets.map((bullet) => `          <li>${escapeHtml(bullet)}</li>`).join('\n')}\n        </ul>` : '';

  return `<section class="glass-card">\n      ${title ? `<h2>${escapeHtml(title)}</h2>` : ''}\n${paragraphsHtml}${bulletsHtml}\n    </section>`;
};

const renderFaq = (faqEntries) => {
  if (!faqEntries.length) return '';

  const items = faqEntries
    .map((entry) => {
      const question = String(entry?.q || '').trim();
      const answer = String(entry?.a || '').trim();
      if (!question || !answer) return '';
      return `        <details class="faq-item">\n          <summary>${escapeHtml(question)}</summary>\n          <div class="faq-content"><p>${escapeHtml(answer)}</p></div>\n        </details>`;
    })
    .filter(Boolean)
    .join('\n');

  if (!items) return '';

  return `<section class="glass-card">\n      <h2>Perguntas frequentes</h2>\n      <div class="faq-list">\n${items}\n      </div>\n    </section>`;
};

const withRequiredLinks = (relatedLinks, { slugSet, prefix }) => {
  const requiredLinks = [
    { href: '/', label: 'Início' },
    { href: '/stickers/', label: 'Marketplace' },
    { href: '/comandos/', label: 'Comandos' },
    { href: '/login/', label: 'Adicionar Bot' },
  ];

  const allLinks = [...requiredLinks, ...relatedLinks];
  const dedup = new Map();
  for (const link of allLinks) {
    const href = rewriteSatelliteHref(link?.href, slugSet, prefix);
    const label = String(link?.label || '').trim();
    if (!href || !label) continue;
    if (!dedup.has(href)) dedup.set(href, { href, label });
  }

  return Array.from(dedup.values());
};

const renderLinks = (links) => {
  if (!links.length) return '';

  return `<section class="glass-card">\n      <h2>Conteúdo relacionado</h2>\n      <div class="links-grid">\n${links.map((link) => `        <a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join('\n')}\n      </div>\n    </section>`;
};

const renderPageHtml = (page, generatedAt, { slugSet, prefix }) => {
  const canonicalPath = buildPageRoutePath(page.slug, prefix);
  const canonicalUrl = `${SITE_ORIGIN}${canonicalPath}`;
  const keywordsContent = page.keywords.join(', ');

  const faqEntities = page.faq
    .map((entry) => ({
      '@type': 'Question',
      name: String(entry?.q || '').trim(),
      acceptedAnswer: {
        '@type': 'Answer',
        text: String(entry?.a || '').trim(),
      },
    }))
    .filter((item) => item.name && item.acceptedAnswer.text);

  const webPageSchema = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: page.title,
    description: page.description,
    inLanguage: 'pt-BR',
    url: canonicalUrl,
    isPartOf: {
      '@type': 'WebSite',
      name: 'Omnizap',
      url: SITE_ORIGIN,
    },
  };

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqEntities,
  };

  const sectionsHtml = page.sections.map(renderSection).filter(Boolean).join('\n\n');
  const faqHtml = renderFaq(page.faq);
  const linksHtml = renderLinks(withRequiredLinks(page.related_links, { slugSet, prefix }));

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  ${keywordsContent ? `<meta name="keywords" content="${escapeHtml(keywordsContent)}" />` : ''}
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Sora:wght@100..800&display=swap" rel="stylesheet">

  <meta property="og:type" content="article" />
  <meta property="og:locale" content="pt_BR" />
  <meta property="og:site_name" content="Omnizap" />
  <meta property="og:title" content="${escapeHtml(page.title)}" />
  <meta property="og:description" content="${escapeHtml(page.description)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:image" content="https://omnizap.shop/assets/images/hero-banner-1280.jpg" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(page.title)}" />
  <meta name="twitter:description" content="${escapeHtml(page.description)}" />
  <meta name="twitter:image" content="https://omnizap.shop/assets/images/hero-banner-1280.jpg" />

  <script type="application/ld+json">${toSafeJson(webPageSchema)}</script>
  ${faqEntities.length ? `<script type="application/ld+json">${toSafeJson(faqSchema)}</script>` : ''}

  <style>
    :root {
      --bc: 210 40% 96%;
      --p: 142 71% 45%;
      --s: 217 91% 60%;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #020617;
      background-image: 
        radial-gradient(at 0% 0%, hsla(142, 71%, 45%, 0.12) 0px, transparent 50%),
        radial-gradient(at 100% 0%, hsla(217, 91%, 60%, 0.12) 0px, transparent 50%);
      color: hsl(var(--bc));
      font-family: 'Sora', sans-serif;
      line-height: 1.6;
      min-height: 100vh;
    }
    .container {
      width: min(1100px, 94vw);
      margin: 0 auto;
      padding: 40px 0 80px;
    }
    .navbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 0;
      margin-bottom: 3rem;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .logo {
      display: flex;
      align-items: center; gap: 10px;
      text-decoration: none; color: inherit;
      font-weight: 800; font-size: 1.2rem;
    }
    .logo img { width: 32px; height: 32px; border-radius: 8px; }
    .nav-links { display: flex; gap: 12px; }
    .nav-links a {
      padding: 6px 14px; border-radius: 999px;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.6); text-decoration: none;
      font-size: 0.8rem; font-weight: 600; transition: all 0.2s;
    }
    .nav-links a:hover { color: #fff; border-color: rgba(255,255,255,0.2); }
    
    .hero { text-align: center; margin-bottom: 4rem; }
    .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; background: hsla(142, 71%, 45%, 0.1); border: 1px solid hsla(142, 71%, 45%, 0.2); color: hsla(142, 71%, 45%, 1); font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 1rem; }
    h1 { font-family: 'Space Grotesk', sans-serif; font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 800; margin: 0 0 1rem; line-height: 1.1; letter-spacing: -0.02em; }
    .hero p { color: rgba(255,255,255,0.5); font-size: 1.1rem; max-width: 700px; margin: 0 auto 2rem; }

    .glass-card {
      background: rgba(255, 255, 255, 0.02);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 2rem;
      padding: 2.5rem;
      margin-bottom: 1.5rem;
    }
    h2 { font-family: 'Space Grotesk', sans-serif; font-size: 1.5rem; font-weight: 700; margin: 0 0 1.2rem; color: hsla(142, 71%, 45%, 1); }
    p, li { color: rgba(255,255,255,0.6); font-size: 0.95rem; }
    ul { padding-left: 1.2rem; }
    li { margin-bottom: 0.8rem; }

    .cta { display: flex; gap: 1rem; justify-content: center; }
    .btn { padding: 12px 24px; border-radius: 1rem; font-weight: 800; text-decoration: none; transition: transform 0.2s; }
    .btn:hover { transform: translateY(-2px); }
    .btn-primary { background: hsla(142, 71%, 45%, 1); color: #000; }
    .btn-outline { border: 1px solid rgba(255,255,255,0.1); color: #fff; }

    .faq-list { display: grid; gap: 1rem; }
    .faq-item { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 1rem; overflow: hidden; }
    .faq-item summary { padding: 1.2rem; cursor: pointer; font-weight: 700; color: #fff; list-style: none; }
    .faq-item summary::-webkit-details-marker { display: none; }
    .faq-content { padding: 0 1.2rem 1.2rem; }

    .links-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
    .links-grid a { 
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05);
      padding: 1rem; border-radius: 1rem; text-decoration: none; color: #fff; font-weight: 600; font-size: 0.85rem;
      text-align: center; transition: all 0.2s;
    }
    .links-grid a:hover { background: rgba(255,255,255,0.06); border-color: hsla(142, 71%, 45%, 0.3); }

    .footer-meta { text-align: center; margin-top: 4rem; opacity: 0.2; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.2em; }

    @media (max-width: 768px) {
      .container { padding: 20px 0 40px; }
      .navbar { margin-bottom: 2rem; }
      .nav-links { display: none; }
      .glass-card { padding: 1.5rem; }
      .cta { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="navbar">
      <a href="/" class="logo">
        <img src="/assets/images/brand-logo-128.webp" alt="OmniZap">
        <span>OmniZap<span style="color:hsla(142, 71%, 45%, 1)">.</span></span>
      </a>
      <nav class="nav-links">
        <a href="/">Início</a>
        <a href="/stickers/">Marketplace</a>
        <a href="/comandos/">Comandos</a>
        <a href="/login/">Adicionar Bot</a>
      </nav>
    </header>

    <main>
      <header class="hero">
        <span class="pill">${escapeHtml(page.intent_label)}</span>
        <h1>${escapeHtml(page.h1)}</h1>
        <p>${escapeHtml(page.intro)}</p>
        <div class="cta">
          <a class="btn btn-primary" href="/login/">Adicionar ao meu grupo</a>
          <a class="btn btn-outline" href="/">Conhecer OmniZap</a>
        </div>
      </header>

      ${sectionsHtml}

      ${faqHtml}

      ${linksHtml}
    </main>

    <footer class="footer-meta">
      © 2026 OMNIZAP · SEO SATELLITE V2 · ATUALIZADO EM ${escapeHtml(generatedAt)}
    </footer>
  </div>
</body>
</html>`;
};

const run = async () => {
  const absoluteConfigPath = path.resolve(configPath);
  const absoluteOutputDir = path.resolve(outputDir);
  const normalizedRoutePrefix = normalizeRoutePrefix(routePrefix);

  const rawConfig = await fs.readFile(absoluteConfigPath, 'utf8');
  const parsedConfig = JSON.parse(rawConfig);
  const pages = Array.isArray(parsedConfig?.pages) ? parsedConfig.pages : [];
  const generatedAt = String(parsedConfig?.generated_at || __timeNowIso().slice(0, 10)).trim();

  if (!pages.length) {
    throw new Error('config sem paginas');
  }

  const resolvedPages = pages.map(ensurePageConfig);
  const slugSet = new Set(resolvedPages.map((entry) => entry.slug));
  const generatedFiles = [];

  for (const page of resolvedPages) {
    const html = renderPageHtml(page, generatedAt, {
      slugSet,
      prefix: normalizedRoutePrefix,
    });
    const targetFile = path.join(absoluteOutputDir, `seo-${page.slug}.html`);

    await fs.mkdir(absoluteOutputDir, { recursive: true });
    await fs.writeFile(targetFile, html, 'utf8');
    generatedFiles.push(targetFile);
  }

  process.stdout.write(`Paginas geradas: ${generatedFiles.length}\n`);
  process.stdout.write(`Prefixo de rota: ${normalizedRoutePrefix || '/'}\n`);
  process.stdout.write(`Diretorio de saida: ${path.relative(process.cwd(), absoluteOutputDir)}\n`);
  for (const filePath of generatedFiles) {
    process.stdout.write(`- ${path.relative(process.cwd(), filePath)}\n`);
  }
};

run().catch((error) => {
  process.stderr.write(`Erro ao gerar paginas satelite: ${error.message}\n`);
  process.exitCode = 1;
});
