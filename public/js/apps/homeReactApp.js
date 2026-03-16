import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);

const FALLBACK_THUMB_URL = '/apple-touch-icon.png';
const HOME_BOOTSTRAP_ENDPOINT = '/api/home-bootstrap';
const COMMANDS_CATALOG_ENDPOINT = '/comandos/commands-catalog.json';
const SOCIAL_PROOF_REFRESH_MS = 15_000;
const COUNTUP_DURATION_MS = 1200;
const COUNTABLE_METRICS = ['users', 'messages', 'commands', 'packs', 'stickers'];
const REVEAL_STAGGER_MS = 60;
const MAX_REVEAL_DELAY_MS = 400;
const REAL_METRIC_BASELINE = {
  users: 5700,
  messages: 534900,
  commands: 1700,
};

const DEFAULT_METRICS = {
  users: '5,7 mil',
  messages: '534,9 mil',
  commands: '1,7 mil',
  packs: '10k+',
  stickers: '500k+',
  latency: '...',
  status: 'online',
};

const NAV_ITEMS = [
  { href: '#recursos', label: 'Recursos' },
  { href: '/comandos/', label: 'Biblioteca de Comandos' },
  { href: '#guias', label: 'Guias' },
  { href: '/api-docs/', label: 'API Docs' },
  { href: '#faq', label: 'FAQ' },
];

const GUIDES = [
  { href: '/seo/bot-whatsapp-para-grupo/', title: 'Bot para Grupos', desc: 'Guia de entrada rápida para iniciantes.' },
  { href: '/seo/como-moderar-grupo-whatsapp/', title: 'Guia de Moderação', desc: 'Como manter seu grupo limpo e seguro.' },
  { href: '/seo/como-evitar-spam-no-whatsapp/', title: 'Anti-Spam 101', desc: 'Proteja sua comunidade de bots invasores.' },
  { href: '/seo/melhor-bot-whatsapp-para-grupos/', title: 'Comparativo', desc: 'Por que o OmniZap é a melhor escolha.' },
];

const FAQS = [
  { q: 'Preciso saber programar?', a: 'Não. O bot é plug-and-play. Basta adicionar ao grupo e enviar /iniciar.' },
  { q: 'É seguro para meus dados?', a: 'Sim. Seguimos a LGPD rigorosamente. Veja nossa política de privacidade para detalhes.' },
  { q: 'Funciona em comunidades?', a: 'Com certeza! O OmniZap escala perfeitamente de pequenos grupos a grandes comunidades.' },
];

const FEATURES = [
  { title: 'IA Generativa', desc: 'Respostas inteligentes e comandos de visão computacional direto no chat.', icon: '🤖' },
  { title: 'Gestão de Packs', desc: 'Crie e organize coleções de figurinhas via web ou comandos.', icon: '🎨' },
  { title: 'Moderação 24/7', desc: 'Anti-link, captcha e proteção automática contra spam em tempo real.', icon: '🛡️' },
  { title: 'Engajamento', desc: 'Rankings, jogos e sistemas de reputação para sua comunidade.', icon: '📈' },
  { title: 'Multi-Mídia', desc: 'Download de vídeos, músicas e conversões instantâneas.', icon: '🎵' },
  { title: 'Privacidade', desc: 'Segurança total e conformidade com LGPD para seus dados.', icon: '🔐' },
];

const STEPS = [
  { step: '01', title: 'Adicione o Bot', desc: 'Clique em Adicionar e escolha seu grupo ou chat privado.' },
  { step: '02', title: 'Envie /iniciar', desc: 'O bot irá configurar o ambiente e liberar os comandos básicos.' },
  { step: '03', title: 'Explore a IA', desc: 'Use comandos como /ia ou /s para sentir o poder da automação.' },
];

const COMMAND_BLOCKS = [
  {
    title: 'Figurinhas',
    items: [
      ['/s', 'Cria figurinha'],
      ['/st', 'Figurinha rápida'],
      ['/pack create', 'Cria pack web'],
      ['/toimg', 'Sticker para imagem'],
    ],
  },
  {
    title: 'Administração',
    items: [
      ['/ban', 'Remove usuário'],
      ['/captcha', 'Ativa proteção'],
      ['/noticias', 'Broadcast de news'],
      ['/setgroup', 'Configura grupo'],
    ],
  },
  {
    title: 'Utilidades',
    items: [
      ['/play', 'Toca música'],
      ['/tiktok', 'Baixa vídeo'],
      ['/user perfil', 'Dados da conta'],
      ['/menu ia', 'Menu de IA'],
    ],
  },
];

let homeBootstrapPayloadPromise = null;

const loadHomeBootstrapPayload = async () => {
  const response = await fetch(HOME_BOOTSTRAP_ENDPOINT, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.data || {};
};

const fetchHomeBootstrapPayload = async ({ forceRefresh = false } = {}) => {
  if (forceRefresh) {
    const freshData = await loadHomeBootstrapPayload();
    homeBootstrapPayloadPromise = Promise.resolve(freshData);
    return freshData;
  }
  if (!homeBootstrapPayloadPromise) {
    homeBootstrapPayloadPromise = loadHomeBootstrapPayload().catch((err) => {
      homeBootstrapPayloadPromise = null;
      throw err;
    });
  }
  return homeBootstrapPayloadPromise;
};

const shortNum = (value) =>
  new Intl.NumberFormat('pt-BR', {
    notation: Number(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(Math.max(0, Number(value) || 0));

const toPositiveNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
};

const normalizeSearchText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const scoreCommandMatch = (command, term) => {
  const name = normalizeSearchText(command.name);
  const description = normalizeSearchText(command.descricao);
  const aliases = (command.aliases || []).map(normalizeSearchText).filter(Boolean);
  const keywords = (command.keywords || []).map(normalizeSearchText).filter(Boolean);

  if (name === term) return 120;
  if (aliases.includes(term)) return 110;
  if (name.startsWith(term)) return 95;
  if (aliases.some((alias) => alias.startsWith(term))) return 85;
  if (name.includes(term)) return 70;
  if (aliases.some((alias) => alias.includes(term))) return 62;
  if (keywords.some((keyword) => keyword.includes(term))) return 45;
  if (description.includes(term)) return 35;
  return 0;
};

const App = () => {
  const [session, setSession] = useState(null);
  const [botMenuUrl, setBotMenuUrl] = useState('/login/');
  const [metrics, setMetrics] = useState(DEFAULT_METRICS);
  const [commandBlocks, setCommandBlocks] = useState(COMMAND_BLOCKS);
  const [fullCatalog, setFullCatalog] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [simulationIndex, setSimulationIndex] = useState(0);
  const counterValuesRef = useRef({ users: 0, messages: 0, commands: 0, packs: 0, stickers: 0 });
  const counterFramesRef = useRef({});

  const simulationMessages = [
    { visitor: 'Como faço stickers?', bot: 'Envie uma imagem com o comando /s e eu faço o resto! ✨' },
    { visitor: 'E pra moderar o grupo?', bot: 'Use /captcha ou /ban. Proteção 24/7 ativa. 🛡️' },
    { visitor: 'Baixa vídeo do TikTok?', bot: 'Sim! Mande o link e eu converto na hora. ⚡' },
    { visitor: 'Tem IA?', bot: 'Claro! Use /ia para conversar comigo agora. 🤖' },
  ];

  const searchableCommands = useMemo(() => {
    if (fullCatalog?.categories?.length) {
      return fullCatalog.categories.flatMap((cat) =>
        (cat.commands || []).map((cmd) => ({
          key: `${cat.key || cat.label || 'cat'}:${cmd.name || cmd.key || ''}`,
          name: String(cmd.name || ''),
          descricao: String(cmd.descricao || ''),
          aliases: Array.isArray(cmd.aliases) ? cmd.aliases : [],
          keywords: Array.isArray(cmd.discovery?.keywords) ? cmd.discovery.keywords : [],
          categoryLabel: String(cat.label || cmd.category_label || ''),
        })),
      );
    }

    // Fallback enquanto o catálogo completo não estiver disponível.
    return commandBlocks.flatMap((block) =>
      (block.items || []).map(([command, descricao], idx) => ({
        key: `${block.title || 'cat'}:${idx}:${command || ''}`,
        name: String(command || '').replace(/^\//, ''),
        descricao: String(descricao || ''),
        aliases: [],
        keywords: [],
        categoryLabel: String(block.title || ''),
      })),
    );
  }, [fullCatalog, commandBlocks]);

  const filteredCommandBlocks = useMemo(() => {
    const rawTerm = String(searchTerm || '').trim();
    const term = normalizeSearchText(rawTerm);
    if (!term) return commandBlocks;

    const rankedMatches = searchableCommands
      .map((cmd) => ({ cmd, score: scoreCommandMatch(cmd, term) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name, 'pt-BR'));

    if (!rankedMatches.length) {
      return [
        {
          title: `Nenhum resultado para "${rawTerm}"`,
          items: [['/menu', 'Tente termos como sticker, admin, musica ou IA']],
        },
      ];
    }

    const seen = new Set();
    const items = [];

    rankedMatches.forEach(({ cmd }) => {
      if (items.length >= 12) return;
      const dedupeKey = `${cmd.categoryLabel}|${cmd.name}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const categorySuffix = cmd.categoryLabel ? ` • ${cmd.categoryLabel}` : '';
      items.push([`/${cmd.name}`, `${cmd.descricao}${categorySuffix}`]);
    });

    return [{ title: `Resultados para "${rawTerm}"`, items }];
  }, [searchTerm, commandBlocks, searchableCommands]);

  useEffect(() => {
    const simInterval = setInterval(() => {
      setSimulationIndex((prev) => (prev + 1) % simulationMessages.length);
    }, 4000);
    return () => clearInterval(simInterval);
  }, []);

  useEffect(() => {
    let active = true;
    const requestAnimation = typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame.bind(globalThis) : null;
    const cancelAnimation = typeof globalThis.cancelAnimationFrame === 'function' ? globalThis.cancelAnimationFrame.bind(globalThis) : null;

    const animateCounter = (key, target) => {
      if (!active || typeof requestAnimation !== 'function') {
        setMetrics((m) => ({ ...m, [key]: shortNum(target) }));
        return;
      }
      const startValue = counterValuesRef.current[key] || 0;
      const startTime = performance.now();

      const step = (now) => {
        const progress = Math.min(1, (now - startTime) / COUNTUP_DURATION_MS);
        const eased = 1 - Math.pow(1 - progress, 4); // Quart ease-out
        const current = startValue + (target - startValue) * eased;

        setMetrics((m) => ({ ...m, [key]: shortNum(current) }));

        if (progress < 1) {
          counterFramesRef.current[key] = requestAnimation(step);
        } else {
          counterValuesRef.current[key] = target;
        }
      };
      if (typeof cancelAnimation === 'function') {
        cancelAnimation(counterFramesRef.current[key]);
      }
      counterFramesRef.current[key] = requestAnimation(step);
    };

    const runLoad = async ({ forceRefresh = false } = {}) => {
      try {
        const data = await fetchHomeBootstrapPayload({ forceRefresh });
        if (!active) return;

        const realtime = data?.home_realtime || {};
        const stats = data?.marketplace_stats?.data || data?.stats || {};
        const summary = data?.system_summary || {};
        const botContact = data?.bot_contact || {};

        setSession(data?.session?.authenticated ? data.session : null);

        // Tenta resolver a URL do bot de múltiplas fontes possíveis na resposta
        const contactUrl = botContact?.urls?.menu || botContact?.url || '/login/';
        setBotMenuUrl(contactUrl);

        const targetValues = {
          users: toPositiveNumber(realtime?.total_users) || REAL_METRIC_BASELINE.users,
          messages: toPositiveNumber(realtime?.total_messages) || REAL_METRIC_BASELINE.messages,
          commands: toPositiveNumber(realtime?.total_commands) || REAL_METRIC_BASELINE.commands,
          packs: Number(stats?.packs_total || stats?.total_packs || 0),
          stickers: Number(stats?.stickers_total || stats?.total_stickers || 0),
        };

        COUNTABLE_METRICS.forEach((key) => animateCounter(key, targetValues[key]));

        setMetrics((m) => ({
          ...m,
          latency: realtime?.system_latency_ms ? `${Math.round(realtime.system_latency_ms)}ms` : '...',
          status: (summary?.system_status || summary?.bot?.connection_status || 'online').toLowerCase(),
        }));

        // Início da parte que consome o catálogo
        try {
          const catalogRes = await fetch(COMMANDS_CATALOG_ENDPOINT);
          if (catalogRes.ok) {
            const catalog = await catalogRes.json();
            setFullCatalog(catalog);
            const featuredKeys = ['figurinhas', 'admin', 'midia']; // Featured categories from catalog
            const blocks = (catalog.categories || [])
              .filter((cat) => featuredKeys.includes(cat.key))
              .sort((a, b) => featuredKeys.indexOf(a.key) - featuredKeys.indexOf(b.key))
              .map((cat) => ({
                title: cat.label,
                items: (cat.commands || []).slice(0, 4).map((cmd) => [`/${cmd.name}`, cmd.descricao]),
              }));
            if (blocks.length > 0) setCommandBlocks(blocks);
          }
        } catch (catErr) {
          console.warn('Catalog load error', catErr);
        }
        // Fim da parte que consome o catálogo
      } catch (err) {
        console.warn('Home bootstrap error', err);
      }
    };

    runLoad();
    const interval = setInterval(() => runLoad({ forceRefresh: true }), SOCIAL_PROOF_REFRESH_MS);

    // Reveal Observer
    const observer =
      typeof globalThis.IntersectionObserver === 'function'
        ? new globalThis.IntersectionObserver(
            (entries) => {
              entries.forEach((entry) => {
                if (entry.isIntersecting) {
                  entry.target.classList.add('is-visible');
                  observer.unobserve(entry.target);
                }
              });
            },
            { threshold: 0.1, rootMargin: '0px 0px -50px 0px' },
          )
        : null;

    document.querySelectorAll('[data-reveal]').forEach((el, i) => {
      el.style.setProperty('--reveal-delay', `${Math.min(i * REVEAL_STAGGER_MS, MAX_REVEAL_DELAY_MS)}ms`);
      if (observer) {
        observer.observe(el);
      } else {
        el.classList.add('is-visible');
      }
    });

    return () => {
      active = false;
      clearInterval(interval);
      if (observer) observer.disconnect();
    };
  }, []);

  const authInfo = useMemo(() => {
    if (!session?.user) return { href: '/login/', label: 'Entrar', image: null };
    return {
      href: '/user/',
      label: 'Perfil',
      image: session.user.picture || FALLBACK_THUMB_URL,
    };
  }, [session]);

  return html`
    <style>
      @keyframes marquee {
        0% {
          transform: translateX(0);
        }
        100% {
          transform: translateX(-50%);
        }
      }
      .animate-marquee-infinite {
        display: flex;
        width: max-content;
        animation: marquee 40s linear infinite;
      }
      @keyframes float {
        0%,
        100% {
          transform: translateY(0) rotate(0deg);
        }
        50% {
          transform: translateY(-20px) rotate(5deg);
        }
      }
      .animate-float {
        animation: float 6s ease-in-out infinite;
      }
      @keyframes bounce-y {
        0%,
        100% {
          transform: translateY(0);
          opacity: 0.3;
        }
        50% {
          transform: translateY(10px);
          opacity: 1;
        }
      }
      .scroll-indicator-anim {
        animation: bounce-y 2s infinite;
      }
      @keyframes gradient-x {
        0%,
        100% {
          background-position: 0% 50%;
        }
        50% {
          background-position: 100% 50%;
        }
      }
      .animate-gradient-x {
        background-size: 200% 200%;
        animation: gradient-x 15s ease infinite;
      }
      @keyframes shine {
        0% {
          transform: translateX(-100%) translateY(-100%) rotate(45deg);
        }
        100% {
          transform: translateX(100%) translateY(100%) rotate(45deg);
        }
      }
      .hover-shine {
        position: relative;
        overflow: hidden;
      }
      .hover-shine::after {
        content: '';
        position: absolute;
        top: -50%;
        left: -50%;
        width: 200%;
        height: 200%;
        background: linear-gradient(rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.05) 50%, rgba(255, 255, 255, 0) 100%);
        transform: translateX(-100%) translateY(-100%) rotate(45deg);
        transition: transform 0.6s;
        pointer-events: none;
      }
      .hover-shine:hover::after {
        transform: translateX(100%) translateY(100%) rotate(45deg);
      }
      .no-scrollbar::-webkit-scrollbar {
        display: none;
      }
      .no-scrollbar {
        -ms-overflow-style: none;
        scrollbar-width: none;
      }
    </style>

    <div className="min-h-screen bg-[#020617] text-white font-sans selection:bg-primary selection:text-primary-content overflow-x-hidden">
      <!-- Background Glow Orbs -->
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-primary/10 blur-[120px] rounded-full animate-pulse"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-secondary/10 blur-[100px] rounded-full"></div>
        <div className="absolute top-[40%] left-[20%] w-[20%] h-[20%] bg-emerald-500/5 blur-[80px] rounded-full animate-float"></div>
      </div>

      <!-- Navbar -->
      <header className="sticky top-0 z-50 border-b border-white/5 bg-[#020617]/60 backdrop-blur-xl transition-all">
        <div className="container mx-auto px-4">
          <!-- Top Row: Logo & Auth -->
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex-1">
              <a href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
                <img src="/apple-touch-icon.png" className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl shadow-sm" alt="Logo" />
                <span className="text-base sm:text-lg font-black tracking-tight">OmniZap<span className="text-primary">.</span></span>
              </a>
            </div>

            <!-- Desktop Nav Items (Middle) -->
            <nav className="hidden lg:flex items-center gap-1 mx-4">${NAV_ITEMS.map((item) => html` <a href=${item.href} className="btn btn-ghost btn-sm rounded-lg font-medium text-white/50 hover:text-primary hover:bg-white/5 transition-all uppercase text-[10px] tracking-widest"> ${item.label} </a> `)}</nav>

            <div className="flex items-center">
              ${session?.user
                ? html`
                    <a href="/user/" className="group relative flex items-center h-11 gap-3 pl-1.5 pr-1.5 sm:pr-5 rounded-2xl bg-white/5 border border-white/10 hover:border-primary/40 hover:bg-primary/5 transition-all duration-500 hover:shadow-[0_0_20px_rgba(34,197,94,0.15)]">
                      <div className="relative flex-shrink-0">
                        <img src=${authInfo.image} className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl object-cover border border-white/10 group-hover:border-primary/50 transition-all duration-500 group-hover:scale-105" />
                        <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-success border-2 border-[#020617] rounded-full shadow-[0_0_8px_rgba(34,197,94,0.8)] group-hover:animate-pulse"></div>
                      </div>
                      <div className="hidden sm:flex flex-col items-start gap-0.5">
                        <span className="text-[10px] font-black uppercase tracking-widest text-white/40 group-hover:text-primary transition-colors leading-tight">${authInfo.label}</span>
                        <span className="text-[8px] font-bold text-white/20 uppercase tracking-tighter leading-tight group-hover:text-white/40 transition-colors">Painel de Controle</span>
                      </div>
                      <div className="absolute inset-0 rounded-2xl bg-gradient-to-r from-primary/0 via-primary/5 to-primary/0 opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none"></div>
                    </a>
                  `
                : html`
                    <a href="/login/" className="group relative overflow-hidden btn btn-primary btn-sm h-11 min-h-0 rounded-2xl px-8 font-black text-[10px] uppercase tracking-[0.2em] shadow-lg shadow-primary/20 hover:shadow-primary/40 hover:scale-105 active:scale-95 transition-all border-none">
                      <span className="relative z-10">Entrar</span>
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000"></div>
                    </a>
                  `}
            </div>
          </div>

          <!-- Bottom Row (Mobile Only): Horizontal Scroll Links -->
          <nav className="flex lg:hidden items-center gap-3 overflow-x-auto no-scrollbar pb-4 -mx-4 px-4">${NAV_ITEMS.map((item) => html` <a href=${item.href} className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest whitespace-nowrap bg-white/5 border border-white/5 text-white/40 active:bg-primary/20 active:text-primary transition-all"> ${item.label} </a> `)}</nav>
        </div>
      </header>

      <main className="relative z-10">
        <!-- Hero Section -->
        <section className="relative overflow-hidden py-10 lg:py-32 min-h-[70vh] lg:min-h-[80vh] flex items-center">
          <div className="container mx-auto px-4 relative z-10">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div data-reveal="fade-right" className="text-center lg:text-left space-y-8">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] sm:text-[11px] font-bold uppercase tracking-widest">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                  </span>
                  Sistema Operacional · ${metrics.status}
                </div>

                <h1 className="text-[2.75rem] sm:text-6xl lg:text-8xl font-black leading-[1.1] sm:leading-[1.05] tracking-tighter text-balance">
                  Automatize seu <br className="hidden sm:block" />
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary via-emerald-400 to-secondary animate-gradient-x">WhatsApp</span>.
                </h1>

                <p className="text-base sm:text-xl text-white/50 max-w-xl mx-auto lg:mx-0 leading-relaxed font-medium">O bot mais poderoso do Brasil para gerenciar grupos, criar figurinhas e automatizar fluxos inteligentes via IA.</p>

                <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start pt-4">
                  <a href=${botMenuUrl} className="btn btn-primary btn-lg rounded-2xl shadow-2xl shadow-primary/30 gap-3 group px-8 h-14 sm:h-16 text-base sm:text-lg font-black">
                    Adicionar ao WhatsApp
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 sm:h-6 sm:w-6 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                  </a>
                  <a href="/comandos/" className="btn btn-outline btn-lg rounded-2xl border-white/10 hover:bg-white/5 hover:border-primary/40 px-8 h-14 sm:h-16 text-base sm:text-lg font-black gap-2 transition-all"> ⚡ Ver Comandos </a>
                </div>

                <div className="grid grid-cols-2 sm:flex sm:flex-wrap justify-center lg:justify-start gap-y-8 gap-x-12 pt-10 sm:pt-12">
                  <div className="relative group text-left sm:text-center">
                    <div className="text-3xl sm:text-5xl font-black text-white group-hover:text-primary transition-colors">${metrics.users}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase font-black text-white/30 tracking-[0.2em] sm:tracking-[0.3em] mt-1">Usuários Reais</div>
                  </div>
                  <div className="w-px h-12 bg-white/5 hidden sm:block"></div>
                  <div className="relative group text-left sm:text-center">
                    <div className="text-3xl sm:text-5xl font-black text-white">${metrics.messages}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase font-black text-white/30 tracking-[0.2em] sm:tracking-[0.3em] mt-1">Mensagens</div>
                  </div>
                  <div className="w-px h-12 bg-white/5 hidden lg:block"></div>
                  <div className="relative group col-span-2 sm:col-auto text-center lg:text-left pt-2 sm:pt-0 border-t border-white/5 sm:border-none">
                    <div className="text-3xl sm:text-5xl font-black text-white/80 group-hover:text-primary transition-colors">${metrics.commands}</div>
                    <div className="text-[9px] sm:text-[10px] uppercase font-black text-white/30 tracking-[0.2em] sm:tracking-[0.3em] mt-1">comandos usados</div>
                  </div>
                </div>
              </div>

              <div data-reveal="fade-left" className="relative group hidden lg:block">
                <div className="absolute -inset-4 bg-gradient-to-r from-primary/20 to-secondary/20 rounded-[2.5rem] blur-3xl opacity-50 group-hover:opacity-100 transition-opacity"></div>
                <div className="relative bg-white/[0.03] backdrop-blur-2xl rounded-[2rem] border border-white/10 p-6 shadow-2xl animate-float">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-error/20"></div>
                      <div className="w-3 h-3 rounded-full bg-warning/20"></div>
                      <div className="w-3 h-3 rounded-full bg-success/20"></div>
                    </div>
                    <div className="text-[10px] font-mono text-white/20 tracking-tighter uppercase">LATENCY: ${metrics.latency}</div>
                  </div>

                  <div key=${simulationIndex} className="space-y-4 font-mono text-sm sm:text-base transition-all duration-500 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex gap-3">
                      <span className="text-primary font-bold">visitor:</span>
                      <span className="text-white/60">"${simulationMessages[simulationIndex].visitor}"</span>
                    </div>
                    <div className="flex gap-3 bg-primary/10 p-4 rounded-xl border border-primary/20">
                      <span className="text-success font-bold">omnizap:</span>
                      <span className="text-primary/90 italic">"${simulationMessages[simulationIndex].bot}"</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Scroll Indicator -->
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 hidden lg:flex flex-col items-center gap-2 cursor-pointer group scroll-indicator-anim">
            <span className="text-[9px] font-black uppercase tracking-[0.4em] text-white/20 group-hover:text-primary transition-colors">Explorar</span>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-primary/40 group-hover:text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M19 14l-7 7-7-7" /></svg>
          </div>
        </section>

        <!-- Stats Marquee (Social Proof) -->
        <div className="bg-primary/5 border-y border-white/5 overflow-hidden py-5">
          <div className="animate-marquee-infinite gap-12 items-center text-[11px] font-black uppercase tracking-[0.4em] text-primary/50">
            <span>5,7 mil usuarios reais</span>
            <span className="text-white/10">•</span>
            <span>534,9 mil mensagens processadas</span>
            <span className="text-white/10">•</span>
            <span>IA de Última Geração</span>
            <span className="text-white/10">•</span>
            <span>Segurança Total LGPD</span>
            <span className="text-white/10">•</span>
            <span>Figurinhas Instantâneas</span>
            <span className="text-white/10">•</span>
            <span>Moderação Ativa 24/7</span>
            <span className="text-white/10">•</span>
            {/* Duplicating for seamless loop */}
            <span>5,7 mil usuarios reais</span>
            <span className="text-white/10">•</span>
            <span>534,9 mil mensagens processadas</span>
            <span className="text-white/10">•</span>
            <span>IA de Última Geração</span>
            <span className="text-white/10">•</span>
            <span>Segurança Total LGPD</span>
            <span className="text-white/10">•</span>
            <span>Figurinhas Instantâneas</span>
            <span className="text-white/10">•</span>
            <span>Moderação Ativa 24/7</span>
            <span className="text-white/10">•</span>
          </div>
        </div>

        <!-- Sticker Gallery (Live Preview) -->
        <div className="py-12 bg-[#020617] relative overflow-hidden">
          <div className="flex gap-4 animate-marquee-infinite opacity-50 hover:opacity-100 transition-opacity">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8].map(
              (i) => html`
                <div key=${i} className="w-20 h-20 sm:w-28 sm:h-28 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center group hover:border-primary/40 transition-all p-2">
                  <div className="w-full h-full rounded-xl bg-gradient-to-br from-white/5 to-white/[0.02] flex items-center justify-center text-2xl group-hover:scale-110 transition-transform grayscale hover:grayscale-0">${['🎨', '🎭', '🐱', '🔥', '🚀', '💎', '🎮', '🍕'][i - 1] || '✨'}</div>
                </div>
              `,
            )}
          </div>
        </div>

        <!-- Steps Section (Mobile First) -->
        <section className="py-20 relative">
          <div className="container mx-auto px-4">
            <div data-reveal="fade-up" className="text-center mb-16 space-y-4">
              <h2 className="text-3xl sm:text-5xl font-black tracking-tight">Comece em Segundos</h2>
              <p className="text-white/40 max-w-xl mx-auto font-medium">O processo é simples, rápido e não requer conhecimento técnico.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              ${STEPS.map(
                (s) => html`
                  <div key=${s.step} data-reveal="fade-up" className="relative group p-8 rounded-[2.5rem] bg-white/[0.02] border border-white/5 hover:border-primary/30 hover:-translate-y-2 hover:shadow-2xl hover:shadow-primary/10 transition-all duration-500 overflow-hidden">
                    <div className="absolute top-8 right-8 text-4xl font-black text-primary/10 group-hover:text-primary/30 group-hover:scale-150 group-hover:-rotate-12 transition-all duration-700">${s.step}</div>
                    <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary font-black mb-6 border border-primary/20 group-hover:bg-primary group-hover:text-primary-content group-hover:scale-110 transition-all duration-500">${s.step}</div>
                    <h3 className="text-xl font-bold mb-3 group-hover:text-primary transition-colors">${s.title}</h3>
                    <p className="text-white/40 leading-relaxed text-sm font-medium">${s.desc}</p>
                  </div>
                `,
              )}
            </div>
          </div>
        </section>

        <!-- Features Section -->
        <section id="recursos" className="py-24 bg-white/[0.02] relative">
          <div className="container mx-auto px-4 relative z-10">
            <div data-reveal="fade-up" className="text-center max-w-3xl mx-auto mb-20 space-y-6">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-black uppercase tracking-widest">Features V3.5</div>
              <h2 className="text-4xl sm:text-6xl font-black tracking-tighter">
                Tecnologia de <br />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-emerald-400">Ponta</span>.
              </h2>
              <p className="text-white/40 text-lg sm:text-xl font-medium">Desenvolvido para máxima performance e facilidade de uso.</p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              ${FEATURES.map(
                (f) => html`
                  <div data-reveal="fade-up" className="group p-8 rounded-[2.5rem] bg-[#020617] border border-white/5 hover:border-primary/40 hover:-translate-y-2 transition-all duration-500 hover:shadow-2xl hover:shadow-primary/10 relative overflow-hidden">
                    <div className="absolute -right-10 -bottom-10 w-32 h-32 bg-primary/5 blur-3xl group-hover:bg-primary/10 transition-colors duration-700 rounded-full"></div>
                    <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center text-3xl mb-6 group-hover:scale-110 group-hover:rotate-6 group-hover:bg-primary/10 transition-all border border-white/5 group-hover:border-primary/20">${f.icon}</div>
                    <h3 className="text-xl font-bold mb-3 group-hover:text-primary transition-colors">${f.title}</h3>
                    <p className="text-white/40 leading-relaxed text-sm font-medium group-hover:text-white/60 transition-colors">${f.desc}</p>
                  </div>
                `,
              )}
            </div>
          </div>
        </section>

        <!-- Commands Section -->
        <section id="comandos" className="py-16 sm:py-24">
          <div className="container mx-auto px-4">
            <div className="flex flex-col lg:flex-row gap-10 lg:gap-16 items-start">
              <div className="w-full lg:w-1/3 lg:sticky lg:top-32 space-y-4 sm:space-y-6 text-center lg:text-left">
                <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-balance">
                  Comandos de <br className="hidden lg:block" />
                  Resposta Rápida
                </h2>
                <p className="text-white/40 leading-relaxed text-sm sm:text-base max-w-xl mx-auto lg:mx-0 font-medium">Interaja com o bot através de comandos intuitivos. Dezenas de ferramentas poderosas ao seu alcance.</p>

                <div className="relative group max-w-sm mx-auto lg:mx-0">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                    <svg className="w-4 h-4 text-white/20 group-focus-within:text-primary transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  </div>
                  <input type="text" placeholder="Buscar comando..." className="w-full bg-white/[0.03] border border-white/10 rounded-xl py-3 pl-11 pr-4 text-sm font-medium focus:outline-none focus:border-primary/50 focus:bg-white/5 transition-all" value=${searchTerm} onInput=${(e) => setSearchTerm(e.target.value)} />
                </div>

                <div className="hidden lg:block p-6 rounded-2xl bg-primary/5 border border-primary/10">
                  <div className="text-primary font-black text-xl mb-1">${metrics.commands}</div>
                  <div className="text-[10px] uppercase font-bold tracking-widest opacity-50">comandos usados</div>
                </div>
                <a href="/comandos/" className="btn btn-outline border-white/10 btn-block rounded-xl hidden lg:flex font-black text-[10px] uppercase tracking-widest h-12">Ver Todos os Comandos</a>
              </div>

              <div className="w-full lg:w-2/3 grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                ${filteredCommandBlocks.map(
                  (block) => html`
                    <div data-reveal="fade-up" className="bg-white/[0.02] border border-white/5 rounded-3xl overflow-hidden group hover:border-primary/30 transition-all hover:bg-white/[0.04] hover:scale-[1.02] duration-500 hover-shine">
                      <div className="p-5 sm:p-8">
                        <h3 className="text-xs sm:text-sm font-black uppercase tracking-[0.2em] text-primary/60 mb-5 sm:mb-6 flex items-center gap-2 group-hover:text-primary transition-colors">
                          <span className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_8px_rgba(34,197,94,0.5)] group-hover:animate-ping"></span>
                          ${block.title}
                        </h3>
                        <div className="grid gap-4 sm:gap-5">
                          ${block.items.map(
                            ([cmd, label]) => html`
                              <div className="flex items-start gap-3 group/item">
                                <div className="flex-1">
                                  <div className="font-mono text-sm font-bold text-white/90 group-hover/item:text-primary transition-colors transform group-hover/item:translate-x-1 duration-300">${cmd}</div>
                                  <div className="text-[11px] sm:text-xs text-white/30 font-medium leading-tight group-hover/item:text-white/50 transition-colors">${label}</div>
                                </div>
                              </div>
                            `,
                          )}
                        </div>
                      </div>
                    </div>
                  `,
                )}

                <!-- Mobile Only CTA -->
                <div className="lg:hidden mt-2">
                  <a href="/comandos/" className="btn btn-block btn-outline border-white/10 rounded-2xl h-14 font-black text-[10px] uppercase tracking-widest active:bg-primary active:text-primary-content active:border-primary"> Ver Todos os Comandos </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Resources Section -->
        <section id="guias" className="py-20 bg-white/[0.01]">
          <div className="container mx-auto px-4">
            <div data-reveal="fade-up" className="mb-12">
              <h2 className="text-3xl sm:text-4xl font-black tracking-tight mb-4">Guias e Recursos</h2>
              <p className="text-white/40 max-w-2xl font-medium">Aprenda a extrair o máximo do seu bot com nossos guias práticos de operação e crescimento.</p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              ${GUIDES.map(
                (guide) => html`
                  <a href=${guide.href} data-reveal="fade-up" className="p-6 rounded-3xl bg-white/[0.02] border border-white/5 hover:border-primary/40 hover:-translate-y-1 transition-all duration-500 group hover:bg-white/[0.04] hover-shine">
                    <h3 className="font-black mb-2 group-hover:text-primary transition-colors text-white/80">${guide.title}</h3>
                    <p className="text-xs text-white/30 leading-relaxed font-medium group-hover:text-white/50 transition-colors">${guide.desc}</p>
                  </a>
                `,
              )}
            </div>
          </div>
        </section>

        <!-- Pricing / Comparison Section -->
        <section id="planos" className="py-24 bg-white/[0.01]">
          <div className="container mx-auto px-4">
            <div data-reveal="fade-up" className="text-center mb-16 space-y-4">
              <h2 className="text-3xl sm:text-5xl font-black tracking-tight">Escolha seu Plano</h2>
              <p className="text-white/40 font-medium">Recursos poderosos para todos os tamanhos de grupos.</p>
            </div>

            <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
              <div data-reveal="fade-up" className="p-8 rounded-[2.5rem] bg-white/[0.02] border border-white/5 flex flex-col hover:border-white/20 transition-all duration-500 hover:bg-white/[0.04] group/free hover-shine">
                <div className="mb-8">
                  <h3 className="text-xl font-bold mb-2 group-hover/free:text-white transition-colors">Plano Gratuito</h3>
                  <div className="text-4xl font-black mb-4 group-hover/free:scale-105 origin-left transition-transform duration-500">R$ 0<span className="text-sm text-white/20 font-medium italic">/sempre</span></div>
                  <p className="text-sm text-white/40">Ideal para grupos pequenos e iniciantes.</p>
                </div>
                <ul className="space-y-4 mb-10 flex-1">
                  ${['Moderação básica', 'Figurinhas ilimitadas', 'Comandos de utilidades', 'Uso compartilhado de IA'].map(
                    (item) => html`
                      <li className="flex items-center gap-3 text-sm font-medium text-white/60 group-hover/free:text-white/80 transition-colors">
                        <svg className="w-5 h-5 text-emerald-500 group-hover/free:scale-125 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" /></svg>
                        ${item}
                      </li>
                    `,
                  )}
                </ul>
                <a href=${botMenuUrl} className="btn btn-outline border-white/10 rounded-xl font-black hover:bg-white hover:text-[#020617] hover:border-white transition-all">Adicionar Grátis</a>
              </div>

              <div data-reveal="fade-up" className="p-8 rounded-[2.5rem] bg-primary/5 border border-primary/20 flex flex-col relative overflow-hidden group hover:border-primary/60 transition-all duration-500 hover:scale-[1.03] hover:shadow-2xl hover:shadow-primary/20 hover-shine">
                <div className="absolute top-6 right-6 px-3 py-1 rounded-full bg-primary text-[#020617] text-[10px] font-black uppercase tracking-widest group-hover:scale-110 transition-transform">Recomendado</div>
                <div className="mb-8">
                  <h3 className="text-xl font-bold mb-2 text-primary">Plano Premium</h3>
                  <div className="text-4xl font-black mb-4 text-white group-hover:scale-105 origin-left transition-transform duration-500">R$ 14,90<span className="text-sm text-white/20 font-medium italic">/mês</span></div>
                  <p className="text-sm text-white/40">Potência máxima para administradores profissionais.</p>
                </div>
                <ul className="space-y-4 mb-10 flex-1">
                  ${['IA sem limites (GPT-4o)', 'Webhooks & API Docs', 'Backup de mensagens', 'Rankings customizados', 'Suporte prioritário'].map(
                    (item) => html`
                      <li className="flex items-center gap-3 text-sm font-medium text-white/90 group-hover:translate-x-1 transition-transform duration-300">
                        <svg className="w-5 h-5 text-primary group-hover:scale-125 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" /></svg>
                        ${item}
                      </li>
                    `,
                  )}
                </ul>
                <a href=${botMenuUrl} className="btn btn-primary rounded-xl font-black shadow-lg shadow-primary/20 group-hover:shadow-primary/40 transition-all hover:scale-105">Quero ser Premium</a>
              </div>
            </div>
          </div>
        </section>

        <!-- FAQ Section -->
        <section id="faq" className="py-24">
          <div className="container mx-auto px-4 max-w-4xl">
            <div data-reveal="fade-up" className="text-center mb-16 space-y-4">
              <h2 className="text-3xl sm:text-5xl font-black tracking-tight">Dúvidas Frequentes</h2>
              <p className="text-white/40 font-medium text-lg">Tudo o que você precisa saber para começar agora mesmo.</p>
            </div>

            <div className="space-y-4">
              ${FAQS.map(
                (faq) => html`
                  <div data-reveal="fade-up" className="collapse collapse-plus bg-white/[0.02] border border-white/5 rounded-3xl group">
                    <input type="checkbox" />
                    <div className="collapse-title text-base font-bold text-white/70 p-6 group-hover:text-primary transition-colors">${faq.q}</div>
                    <div className="collapse-content px-6 pb-6 border-t border-white/5 pt-4">
                      <p className="text-sm text-white/40 leading-relaxed font-medium">${faq.a}</p>
                    </div>
                  </div>
                `,
              )}
            </div>
          </div>
        </section>

        <!-- Compliance Strip -->
        <section className="py-12 border-y border-white/5 bg-white/[0.01]">
          <div className="container mx-auto px-4 text-center space-y-6">
            <div className="flex flex-wrap justify-center gap-x-8 gap-y-4 opacity-40 hover:opacity-100 transition-opacity">
              <a href="/politica-de-privacidade/" className="text-[10px] font-bold uppercase tracking-widest hover:text-primary">Privacidade LGPD</a>
              <a href="/termos-de-uso/" className="text-[10px] font-bold uppercase tracking-widest hover:text-primary">Termos de Uso</a>
              <a href="/aup/" className="text-[10px] font-bold uppercase tracking-widest hover:text-primary">Uso Aceitável</a>
              <a href="/dpa/" className="text-[10px] font-bold uppercase tracking-widest hover:text-primary">DPA B2B</a>
              <a href="/suboperadores/" className="text-[10px] font-bold uppercase tracking-widest hover:text-primary">Suboperadores</a>
            </div>
          </div>
        </section>

        <!-- CTA Final -->
        <section className="py-24 container mx-auto px-4">
          <div data-reveal="fade-up" className="relative p-12 sm:p-20 rounded-[3rem] overflow-hidden text-center text-primary-content shadow-[0_0_80px_rgba(34,197,94,0.1)]">
            <div className="absolute inset-0 bg-gradient-to-br from-primary via-emerald-500 to-secondary animate-gradient-x"></div>
            <div className="absolute inset-0 opacity-20 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]"></div>

            <div className="relative z-10 space-y-8">
              <h2 className="text-3xl sm:text-5xl lg:text-6xl font-black leading-tight text-balance">Pronto para transformar seu grupo?</h2>
              <p className="text-base sm:text-lg opacity-80 max-w-2xl mx-auto font-medium">Junte-se a milhares de administradores que já automatizaram suas comunidades com o OmniZap Bot.</p>
              <div className="pt-4">
                <a href=${botMenuUrl} className="btn btn-lg bg-white border-none text-[#020617] rounded-2xl hover:scale-105 active:scale-95 transition-all shadow-2xl px-8 sm:px-12 h-14 sm:h-16 text-base sm:text-lg font-black uppercase tracking-widest"> Adicionar Agora </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <!-- Footer -->
      <footer className="bg-[#020617] border-t border-white/5 pt-20 pb-10 relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent"></div>

        <div className="container mx-auto px-4">
          <div className="grid grid-cols-2 lg:grid-cols-12 gap-12 mb-20">
            <!-- Brand Column -->
            <div className="col-span-2 lg:col-span-4 space-y-6">
              <div className="flex items-center gap-3 justify-center lg:justify-start">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20 shadow-[0_0_20px_rgba(34,197,94,0.1)]">
                  <img src="/apple-touch-icon.png" className="w-7 h-7 rounded-lg" />
                </div>
                <span className="text-2xl font-black tracking-tighter">OmniZap<span className="text-primary">.</span></span>
              </div>
              <p className="text-sm text-white/30 leading-relaxed font-medium text-center lg:text-left max-w-sm mx-auto lg:mx-0">A próxima geração de automação para WhatsApp. Unindo IA Generativa, segurança LGPD e alta performance para escalar sua comunidade.</p>
              <div className="flex items-center gap-4 justify-center lg:justify-start pt-2">
                <a href="https://github.com/Omnizap-System/omnizap" target="_blank" className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-primary/10 hover:text-primary transition-all border border-white/5 hover:border-primary/30 group">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.02-1.04-.032-2.037-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
                </a>
                <a href=${botMenuUrl} target="_blank" className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-primary/10 hover:text-primary transition-all border border-white/5 hover:border-primary/30 group">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.397-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.506-.173-.007-.371-.007-.57-.007-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.131.57-.074 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-2.578l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L0 24l6.335-1.662c1.72 1.017 3.691 1.553 5.7 1.553h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" /></svg>
                </a>
              </div>
            </div>

            <!-- Links Sections -->
            <div className="col-span-2 lg:col-span-8 grid grid-cols-2 md:grid-cols-4 gap-8">
              <div className="space-y-6">
                <h4 className="font-bold text-xs uppercase tracking-widest text-primary/60 cursor-default">Plataforma</h4>
                <ul className="space-y-3">
                  <li>
                    <a href="/login/" className="text-sm font-medium text-white/40 hover:text-white transition-colors flex items-center gap-2 group"><span className="w-1.5 h-1.5 rounded-full bg-white/10 group-hover:bg-primary transition-colors"></span> Painel Web</a>
                  </li>
                  <li>
                    <a href="/comandos/" className="text-sm font-medium text-white/40 hover:text-white transition-colors flex items-center gap-2 group"><span className="w-1.5 h-1.5 rounded-full bg-white/10 group-hover:bg-primary transition-colors"></span> Comandos</a>
                  </li>
                  <li>
                    <a href="/stickers/" className="text-sm font-medium text-white/40 hover:text-white transition-colors flex items-center gap-2 group"><span className="w-1.5 h-1.5 rounded-full bg-white/10 group-hover:bg-primary transition-colors"></span> Catálogo</a>
                  </li>
                  <li>
                    <a href="/api-docs/" className="text-sm font-medium text-white/40 hover:text-white transition-colors flex items-center gap-2 group"><span className="w-1.5 h-1.5 rounded-full bg-white/10 group-hover:bg-primary transition-colors"></span> API Docs</a>
                  </li>
                </ul>
              </div>

              <div className="space-y-6">
                <h4 className="font-bold text-xs uppercase tracking-widest text-primary/60 cursor-default">Recursos</h4>
                <ul className="space-y-3">
                  <li><a href="#recursos" className="text-sm font-medium text-white/40 hover:text-white transition-colors">IA Generativa</a></li>
                  <li><a href="#recursos" className="text-sm font-medium text-white/40 hover:text-white transition-colors">Moderação</a></li>
                  <li><a href="#recursos" className="text-sm font-medium text-white/40 hover:text-white transition-colors">Downloads</a></li>
                  <li><a href="#guias" className="text-sm font-medium text-white/40 hover:text-white transition-colors">Guias SEO</a></li>
                </ul>
              </div>

              <div className="space-y-6">
                <h4 className="font-bold text-xs uppercase tracking-widest text-primary/60 cursor-default">Suporte</h4>
                <ul className="space-y-3">
                  <li><a href="#faq" className="text-sm font-medium text-white/40 hover:text-white transition-colors">FAQ</a></li>
                  <li><a href=${botMenuUrl} className="text-sm font-medium text-white/40 hover:text-white transition-colors">Central de Ajuda</a></li>
                  <li><a href="https://github.com/Omnizap-System/omnizap/issues" target="_blank" className="text-sm font-medium text-white/40 hover:text-white transition-colors">Reportar Bug</a></li>
                  <li><a href="/suboperadores/" className="text-sm font-medium text-white/40 hover:text-white transition-colors">Transparência</a></li>
                </ul>
              </div>

              <div className="space-y-6">
                <h4 className="font-bold text-xs uppercase tracking-widest text-primary/60 cursor-default">Legal</h4>
                <ul className="space-y-3">
                  <li><a href="/termos-de-uso/" className="text-sm font-medium text-white/40 hover:text-white transition-colors">Termos</a></li>
                  <li><a href="/politica-de-privacidade/" className="text-sm font-medium text-white/40 hover:text-white transition-colors">Privacidade</a></li>
                  <li><a href="/aup/" className="text-sm font-medium text-white/40 hover:text-white transition-colors">Uso Aceitável</a></li>
                  <li><a href="/licenca/" className="text-sm font-medium text-white/40 hover:text-white transition-colors">Licença MIT</a></li>
                </ul>
              </div>
            </div>
          </div>

          <!-- Bottom Bar -->
          <div className="border-t border-white/5 pt-8 flex flex-col sm:flex-row justify-between items-center gap-6">
            <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-8 text-[10px] font-bold uppercase tracking-[0.2em] text-white/20">
              <span>© 2026 OMNIZAP · ALL RIGHTS RESERVED</span>
              <div className="hidden sm:block w-px h-3 bg-white/10"></div>
              <div className="flex items-center gap-4">
                <span>STATUS: <span className="text-success">${metrics.status}</span></span>
                <span className="text-white/10">•</span>
                <span>LATENCY: <span className="text-primary">${metrics.latency}</span></span>
              </div>
            </div>

            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></div>
                <span className="text-[9px] font-black uppercase tracking-widest text-white/40">v2.6.0 Stable</span>
              </div>
              <a href="#top" className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center hover:bg-primary hover:text-primary-content transition-all border border-white/5 active:scale-90">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 15l7-7 7 7" /></svg>
              </a>
            </div>
          </div>
        </div>
      </footer>

      <!-- Floating Action (WhatsApp Button Overlay) -->
      <a href=${botMenuUrl} target="_blank" className="flex btn btn-primary btn-circle fixed bottom-6 right-6 sm:bottom-8 sm:right-8 z-50 w-14 h-14 sm:w-16 sm:h-16 shadow-[0_0_40px_rgba(34,197,94,0.3)] hover:scale-110 active:scale-95 transition-all border-none group">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 sm:h-7 sm:w-7 transition-transform group-hover:rotate-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      </a>
    </div>
  `;
};

const rootElement = document.getElementById('home-react-root');
if (rootElement) {
  createRoot(rootElement).render(html`<${App} />`);
}
