import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const h = React.createElement;

function Icon({ cls }) {
  return h('i', { className: `icon ${cls}`, 'aria-hidden': 'true' });
}

function Card({ title, code, iconClass }) {
  return h('section', { className: 'card' }, h('h2', null, h(Icon, { cls: iconClass || 'fa-solid fa-file-code' }), title), h('pre', null, h('code', null, code)));
}

function SectionTitle({ iconClass, children }) {
  return h('h2', { className: 'section-title' }, h(Icon, { cls: iconClass }), children);
}

function StatusPanel() {
  const [state, setState] = useState({
    loading: true,
    ok: false,
    latencyMs: null,
    cpu: null,
    ram: null,
    uptime: null,
    error: '',
  });

  useEffect(() => {
    let active = true;

    const load = async () => {
      const start = __timeNowMs();
      try {
        const response = await fetch('/api/home-bootstrap');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const summary = payload?.data?.system_summary || {};
        const host = summary.host || {};
        const process = summary.process || {};

        if (!active) return;
        setState({
          loading: false,
          ok: true,
          latencyMs: __timeNowMs() - start,
          cpu: Number.isFinite(Number(host.cpu_percent)) ? `${Number(host.cpu_percent).toFixed(2)}%` : 'n/d',
          ram: host.memory_used && host.memory_total ? `${host.memory_used} / ${host.memory_total} (${Number(host.memory_percent || 0).toFixed(2)}%)` : 'n/d',
          uptime: process.uptime || 'n/d',
          error: '',
        });
      } catch (error) {
        if (!active) return;
        setState({
          loading: false,
          ok: false,
          latencyMs: null,
          cpu: null,
          ram: null,
          uptime: null,
          error: error?.message || 'Falha ao consultar status da API',
        });
      }
    };

    load();
    const timer = setInterval(load, 60 * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const statusLabel = state.loading ? 'Consultando...' : state.ok ? 'Online' : 'Instável';
  const statusClass = state.loading ? 'badge badge-warn' : state.ok ? 'badge badge-ok' : 'badge badge-bad';

  return h('section', { className: 'card' }, h('h3', { className: 'sub-title' }, h(Icon, { cls: 'fa-solid fa-heart-pulse' }), 'Status em tempo real'), h('div', { className: 'status-row' }, h('span', { className: statusClass }, statusLabel), state.latencyMs ? h('span', { className: 'status-meta' }, `Latência: ${state.latencyMs}ms`) : null), h('div', { className: 'status-grid' }, h('div', { className: 'status-item' }, h('strong', null, 'CPU host'), h('span', null, state.cpu || 'n/d')), h('div', { className: 'status-item' }, h('strong', null, 'RAM host'), h('span', null, state.ram || 'n/d')), h('div', { className: 'status-item' }, h('strong', null, 'Uptime processo'), h('span', null, state.uptime || 'n/d'))), state.error ? h('p', { className: 'status-error' }, `Falha: ${state.error}`) : null);
}

function ApiDocsApp() {
  return h(
    'main',
    { className: 'wrap' },
    h(
      'div',
      { className: 'top' },
      h('a', { href: '/' }, h(Icon, { cls: 'fa-solid fa-house' }), 'Home'),
      h('a', { href: '/stickers/' }, h(Icon, { cls: 'fa-solid fa-icons' }), 'Stickers'),
      h('a', { href: '/termos-de-uso/' }, h(Icon, { cls: 'fa-solid fa-file-contract' }), 'Termos'),
      h('a', { href: '/licenca/' }, h(Icon, { cls: 'fa-solid fa-scale-balanced' }), 'Licença'),
      h(
        'a',
        {
          href: 'https://github.com/Omnizap-System/omnizap',
          target: '_blank',
          rel: 'noreferrer noopener',
        },
        h(Icon, { cls: 'fa-brands fa-github' }),
        'GitHub',
      ),
    ),
    h('h1', null, h(Icon, { cls: 'fa-solid fa-code' }), 'OmniZap API | Área de Desenvolvedor'),
    h('p', null, 'Documentação técnica da API OmniZap para bots e automação WhatsApp, com o catálogo de stickers como módulo integrável.'),
    h(SectionTitle, { iconClass: 'fa-solid fa-route' }, 'Casos de uso'),
    h('section', { className: 'card' }, h('ul', { className: 'list' }, h('li', null, 'Operar bot WhatsApp com endpoints públicos para conteúdo e interação.'), h('li', null, 'Integrar server-to-server para sincronizar packs, stickers e métricas.'), h('li', null, 'Conectar automações internas (CRM, suporte, marketing e comunidades).'))),
    h('section', { className: 'card' }, h('h2', null, h(Icon, { cls: 'fa-solid fa-diagram-project' }), 'Mapa da plataforma'), h('p', null, 'O domínio principal é a plataforma de bot + API. O catálogo de stickers funciona como feature integrada para distribuição e engajamento.'), h('ul', { className: 'list' }, h('li', null, 'Página principal: / (plataforma OmniZap)'), h('li', null, 'Catálogo: /stickers/ (módulo de stickers)'), h('li', null, 'Packs públicos: /stickers/{packKey} (landing de conteúdo)'))),
    h(StatusPanel),
    h(SectionTitle, { iconClass: 'fa-solid fa-plug-circle-check' }, 'Endpoints'),
    h(Card, {
      title: 'Base URL',
      code: 'https://omnizap.shop/api/sticker-packs',
      iconClass: 'fa-solid fa-link',
    }),
    h(Card, {
      title: 'Listar packs',
      code: 'GET /api/sticker-packs?q=&visibility=public|unlisted|all&limit=&offset=',
      iconClass: 'fa-solid fa-layer-group',
    }),
    h(Card, {
      title: 'Listar stickers sem pack',
      code: 'GET /api/sticker-packs/orphan-stickers?q=&categories=&limit=&offset=',
      iconClass: 'fa-solid fa-box-open',
    }),
    h(Card, {
      title: 'Detalhes de pack',
      code: 'GET /api/sticker-packs/:packKey',
      iconClass: 'fa-solid fa-circle-info',
    }),
    h(Card, {
      title: 'Interações do pack (dados reais)',
      code: 'POST /api/sticker-packs/:packKey/open\n' + 'POST /api/sticker-packs/:packKey/like\n' + 'POST /api/sticker-packs/:packKey/dislike',
      iconClass: 'fa-solid fa-thumbs-up',
    }),
    h(Card, {
      title: 'Contato de suporte',
      code: 'GET /api/support',
      iconClass: 'fa-brands fa-whatsapp',
    }),
    h(Card, {
      title: 'Imagem de sticker',
      code: 'GET /api/sticker-packs/:packKey/stickers/:stickerId.webp\nGET /data/stickers/:owner/:file.webp',
      iconClass: 'fa-solid fa-image',
    }),
    h(Card, {
      title: 'Resumo de métricas do sistema',
      code: 'GET /api/system-summary',
      iconClass: 'fa-solid fa-gauge-high',
    }),
    h(Card, {
      title: 'Resumo do projeto no GitHub',
      code: 'GET /api/project-summary',
      iconClass: 'fa-brands fa-github',
    }),
    h(Card, {
      title: 'Ranking global (cacheado)',
      code: 'GET /api/global-ranking-summary',
      iconClass: 'fa-solid fa-ranking-star',
    }),
    h(SectionTitle, { iconClass: 'fa-solid fa-brackets-curly' }, 'Como a API responde'),
    h(Card, {
      title: 'Padrão de resposta (sucesso)',
      code: '{\n' + '  "data": [ ... ],\n' + '  "pagination": { "limit": 24, "offset": 0, "has_more": true, "next_offset": 24 },\n' + '  "filters": { "q": "", "visibility": "public", "categories": [] }\n' + '}',
      iconClass: 'fa-solid fa-circle-check',
    }),
    h(Card, {
      title: 'Padrão de resposta (erro)',
      code: '{\n' + '  "ok": false,\n' + '  "error": "mensagem descritiva do erro"\n' + '}',
      iconClass: 'fa-solid fa-triangle-exclamation',
    }),
    h(Card, {
      title: 'Exemplo real de retorno (pack + engagement)',
      code: '{\n' + '  "data": {\n' + '    "pack_key": "auto-manga-panel-2-iu4n2",\n' + '    "name": "[AUTO] Manga Panel #2",\n' + '    "sticker_count": 30,\n' + '    "tags": ["manga-panel", "anime"],\n' + '    "engagement": {\n' + '      "open_count": 120,\n' + '      "like_count": 34,\n' + '      "dislike_count": 2,\n' + '      "score": 32\n' + '    }\n' + '  }\n' + '}',
      iconClass: 'fa-solid fa-database',
    }),
    h(SectionTitle, { iconClass: 'fa-solid fa-filter' }, 'Filtros e paginação'),
    h(Card, {
      title: 'Parâmetros principais',
      code: 'q: texto de busca (nome, publisher, descrição, pack_key)\n' + 'visibility: public | unlisted | all\n' + 'categories: lista separada por vírgula (ex: anime,meme)\n' + 'limit: tamanho da página\n' + 'offset: deslocamento para próxima página',
      iconClass: 'fa-solid fa-sliders',
    }),
    h(Card, {
      title: 'Exemplo de paginação incremental',
      code: 'GET /api/sticker-packs?visibility=public&limit=24&offset=0\n' + 'GET /api/sticker-packs?visibility=public&limit=24&offset=24\n' + 'GET /api/sticker-packs?visibility=public&limit=24&offset=48',
      iconClass: 'fa-solid fa-forward-step',
    }),
    h(SectionTitle, { iconClass: 'fa-solid fa-diagram-project' }, 'Como integrar no seu sistema'),
    h(Card, {
      title: 'Passo a passo de integração',
      code: '1) Defina a base URL: https://omnizap.shop/api/sticker-packs\n' + '2) Faça um health-check inicial em /system-summary\n' + '3) Liste packs com /?visibility=public&limit=24\n' + '4) Abra detalhes com /:packKey\n' + '5) Baixe stickers com /:packKey/stickers/:stickerId.webp\n' + '6) Trate paginação usando limit/offset e has_more',
      iconClass: 'fa-solid fa-list-check',
    }),
    h(Card, {
      title: 'Exemplo cURL',
      code: 'curl -sS "https://omnizap.shop/api/sticker-packs?visibility=public&limit=5"\n' + 'curl -sS "https://omnizap.shop/api/sticker-packs?categories=anime,meme&limit=12"\n' + 'curl -sS "https://omnizap.shop/api/sticker-packs/orphan-stickers?limit=20&offset=0"\n' + 'curl -sS -X POST "https://omnizap.shop/api/sticker-packs/<packKey>/open"\n' + 'curl -sS -X POST "https://omnizap.shop/api/sticker-packs/<packKey>/like"\n' + 'curl -sS "https://omnizap.shop/api/support"\n' + 'curl -sS "https://omnizap.shop/api/system-summary"\n' + 'curl -sS "https://omnizap.shop/api/project-summary"',
      iconClass: 'fa-solid fa-terminal',
    }),
    h(Card, {
      title: 'Exemplo JavaScript (fetch)',
      code: "const API_BASE = 'https://omnizap.shop/api/sticker-packs';\n\n" + 'async function getPublicPacks() {\n' + '  const url = `${API_BASE}?visibility=public&limit=24&offset=0`;\n' + '  const response = await fetch(url);\n' + '  if (!response.ok) throw new Error(`HTTP ${response.status}`);\n' + '  const payload = await response.json();\n' + '  return payload?.data || [];\n' + '}\n\n' + 'async function getPackDetails(packKey) {\n' + '  const response = await fetch(`${API_BASE}/${encodeURIComponent(packKey)}`);\n' + '  if (!response.ok) throw new Error(`HTTP ${response.status}`);\n' + '  const payload = await response.json();\n' + '  return payload?.data || null;\n' + '}\n\n' + '(async () => {\n' + '  try {\n' + '    const packs = await getPublicPacks();\n' + "    console.log('Packs encontrados:', packs.length);\n" + '    if (packs[0]?.pack_key) {\n' + '      const details = await getPackDetails(packs[0].pack_key);\n' + "      console.log('Primeiro pack:', details?.name, details?.pack_key);\n" + "      await fetch(`${API_BASE}/${encodeURIComponent(packs[0].pack_key)}/open`, { method: 'POST' });\n" + '    }\n' + '  } catch (error) {\n' + "    console.error('Falha ao consumir API:', error.message);\n" + '  }\n' + '})();',
      iconClass: 'fa-brands fa-js',
    }),
    h(Card, {
      title: 'Exemplo Node.js (backend / integração server-to-server)',
      code: "const API_BASE = 'https://omnizap.shop/api/sticker-packs';\n" + '\n' + 'export async function syncCatalogPage(offset = 0) {\n' + '  const url = `${API_BASE}?visibility=public&limit=50&offset=${offset}`;\n' + '  const response = await fetch(url, { headers: { Accept: "application/json" } });\n' + '  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);\n' + '  const payload = await response.json();\n' + '  const packs = payload?.data || [];\n' + '  const nextOffset = payload?.pagination?.next_offset;\n' + '  return { packs, nextOffset, hasMore: Boolean(payload?.pagination?.has_more) };\n' + '}\n' + '\n' + 'export async function markPackLike(packKey) {\n' + '  const response = await fetch(`${API_BASE}/${encodeURIComponent(packKey)}/like`, { method: "POST" });\n' + '  if (!response.ok) throw new Error(`Like HTTP ${response.status}`);\n' + '  return response.json();\n' + '}',
      iconClass: 'fa-solid fa-server',
    }),
    h(SectionTitle, { iconClass: 'fa-solid fa-circle-question' }, 'FAQ rápido'),
    h(Card, {
      title: 'Para que serve a API OmniZap?',
      code: 'Ela permite integrar bots e automações WhatsApp com catálogo de stickers, métricas e fluxos técnicos.',
      iconClass: 'fa-solid fa-circle-question',
    }),
    h(Card, {
      title: 'Posso usar packs no meu bot?',
      code: 'Sim. Consulte packs públicos, detalhe itens e registre interações para montar experiências no seu bot.',
      iconClass: 'fa-solid fa-puzzle-piece',
    }),
    h(Card, {
      title: 'Onde ver o catálogo web?',
      code: 'https://omnizap.shop/stickers/',
      iconClass: 'fa-solid fa-icons',
    }),
    h(Card, {
      title: 'Checklist de produção',
      code: '- Implementar retry com backoff (429/5xx)\n' + '- Cachear listagens por 30-120s no seu sistema\n' + '- Validar next_offset para paginação contínua\n' + '- Tratar 404 de pack removido/inválido\n' + '- Registrar métricas de latência e taxa de erro do consumo',
      iconClass: 'fa-solid fa-shield-heart',
    }),
  );
}

const rootEl = document.getElementById('api-docs-react-root');
if (rootEl) {
  const root = createRoot(rootEl);
  root.render(h(ApiDocsApp));
}
