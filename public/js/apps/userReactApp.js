import { now as __timeNow, nowIso as __timeNowIso, toUnixMs as __timeNowMs } from '#time';
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';
import { formatDateTime, formatPhone } from './userProfile/actions.js';

const html = htm.bind(React.createElement);

const DEFAULT_API_BASE_PATH = '/api';
const DEFAULT_LOGIN_PATH = '/login';
const DEFAULT_FALLBACK_AVATAR = '/assets/images/brand-logo-128.webp';

const TABS = [
  { key: 'summary', label: 'Estatísticas', icon: '📊' },
  { key: 'rpg', label: 'Sistema RPG', icon: '⚔️' },
  { key: 'account', label: 'Segurança', icon: '🛡️' },
  { key: 'support', label: 'Suporte', icon: '🎧' },
];

const shortNum = (value) =>
  new Intl.NumberFormat('pt-BR', {
    notation: Number(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(Math.max(0, Number(value) || 0));

const UserApp = ({ config }) => {
  const [activeTab, setActiveTab] = useState('summary');
  const [isLoading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [session, setSession] = useState(null);
  const [isSidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Lock scroll when mobile menu is open
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileMenuOpen]);

  useEffect(() => {
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
            { threshold: 0.1 },
          )
        : null;

    document.querySelectorAll('[data-reveal]').forEach((el, i) => {
      el.style.setProperty('--reveal-delay', `${i * 60}ms`);
      if (observer) {
        observer.observe(el);
      } else {
        el.classList.add('is-visible');
      }
    });

    return () => {
      if (observer) observer.disconnect();
    };
  }, [activeTab, isLoading]);

  useEffect(() => {
    const loadData = async () => {
      try {
        const res = await fetch(`${config.apiBasePath}/me?view=summary`, { credentials: 'include' });
        const payload = await res.json();
        if (payload?.data) {
          setSummary(payload.data.account);
          setSession(payload.data.session);
        }
      } catch (err) {
        console.error('Failed to load user data', err);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [config.apiBasePath]);

  const authInfo = useMemo(() => {
    if (!session?.user) return { href: '/login/', label: 'Entrar', image: null };
    return {
      href: '/user/',
      label: session.user.name?.split(' ')[0] || 'Perfil',
      image: summary?.picture || session.user.picture || DEFAULT_FALLBACK_AVATAR,
    };
  }, [session, summary]);

  const rpgInfo = useMemo(() => summary?.rpg || { level: 1, xp: 0, gold: 0, karma: { score: 0, positive: 0, negative: 0 }, pvp: { matches: 0, wins: 0, losses: 0 }, inventory_count: 0, total_pokemons: 0 }, [summary]);
  const usageInfo = useMemo(() => summary?.usage || { messages: 0, packs: 0, stickers: 0, activity_chart: [], insights: {}, first_message_at: null, last_message_at: null }, [summary]);

  const daysMember = useMemo(() => {
    if (!rpgInfo.member_since) return 0;
    const diff = __timeNow() - new Date(rpgInfo.member_since);
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }, [rpgInfo.member_since]);

  const handleTabChange = (key) => {
    setActiveTab(key);
    setMobileMenuOpen(false);
  };

  const toggleSidebar = () => {
    if (window.innerWidth < 1024) {
      setMobileMenuOpen(!isMobileMenuOpen);
    } else {
      setSidebarCollapsed(!isSidebarCollapsed);
    }
  };

  return html`
    <style>
      .sidebar-transition { transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1), transform 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
      .content-transition { transition: padding-left 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
    </style>

    <div className="min-h-screen bg-[#020617] text-white font-sans selection:bg-primary selection:text-primary-content overflow-x-hidden">
      <!-- Background Elements -->
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 blur-[120px] rounded-full animate-pulse"></div>
        <div className="absolute bottom-[10%] right-[-5%] w-[30%] h-[30%] bg-secondary/5 blur-[100px] rounded-full"></div>
      </div>

      <!-- Backdrop for mobile sidebar -->
      <div onClick=${() => setMobileMenuOpen(false)} className=${`fixed inset-0 z-[50] bg-[#020617]/80 lg:hidden transition-opacity duration-300 ${isMobileMenuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}></div>

      <!-- Navbar -->
      <header className="sticky top-0 z-[40] border-b border-white/5 bg-[#020617]/80 backdrop-blur-xl">
        <div className="px-4 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <button onClick=${toggleSidebar} className="btn btn-ghost btn-square btn-sm bg-white/5 border border-white/10 rounded-xl hover:bg-primary/10 hover:text-primary transition-all">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d=${isSidebarCollapsed ? 'M4 6h16M4 12h16M4 18h16' : 'M4 6h16M4 12h10M4 18h16'} />
                </svg>
              </button>

              <a href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
                <img src="/apple-touch-icon.png" className="w-8 h-8 rounded-xl shadow-sm" alt="Logo" />
                <span className="hidden xs:block text-base sm:text-lg font-black tracking-tight">OmniZap<span className="text-primary">.</span></span>
              </a>
            </div>

            <div className="flex items-center gap-3">
              <button onClick=${() => window.location.assign('/login/')} className="btn btn-ghost btn-sm h-10 min-h-0 gap-2 rounded-xl bg-white/5 border border-white/10 hover:bg-error hover:text-white transition-all px-5 font-black text-[10px] uppercase tracking-widest group">
                <span className="hidden sm:inline opacity-50 group-hover:opacity-100">Sair da Conta</span>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="flex relative">
        <!-- Sidebar -->
        <aside className=${`fixed lg:sticky top-0 lg:top-[65px] h-full lg:h-[calc(100vh-65px)] z-[60] lg:z-30 bg-[#020617] border-r border-white/5 sidebar-transition overflow-y-auto no-scrollbar ${isMobileMenuOpen ? 'translate-x-0 w-[280px]' : '-translate-x-full lg:translate-x-0'} ${isSidebarCollapsed ? 'lg:w-[85px]' : 'lg:w-[280px]'}`}>
          <div className="p-4 flex flex-col h-full">
            <!-- Mobile Header inside Sidebar -->
            <div className="lg:hidden flex items-center justify-between mb-6 px-2">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">Menu do Sistema</span>
              <button onClick=${() => setMobileMenuOpen(false)} className="btn btn-ghost btn-square btn-sm hover:bg-white/5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <!-- Profile Snippet -->
            <div className=${`mb-6 p-4 rounded-3xl bg-white/[0.03] border border-white/5 transition-all overflow-hidden ${isSidebarCollapsed ? 'items-center px-2' : ''}`}>
              <div className=${`flex items-center gap-4 ${isSidebarCollapsed ? 'flex-col' : ''}`}>
                <div className="relative flex-shrink-0">
                  <div className="absolute inset-0 bg-primary/20 blur-lg rounded-full animate-pulse"></div>
                  <img src=${authInfo.image} className="relative w-10 h-10 rounded-xl border border-white/10 p-0.5 object-cover" />
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-success border-2 border-[#020617] rounded-full"></div>
                </div>
                ${!isSidebarCollapsed &&
                html`
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-black tracking-tight truncate text-white">${session?.user?.name || 'User'}</h3>
                    <p className="text-[9px] font-black uppercase text-primary/60 tracking-wider">${summary?.plan_label || 'Plano Free'}</p>
                  </div>
                `}
              </div>
              ${!isSidebarCollapsed &&
              html`
                <div className="mt-4 pt-4 border-t border-white/5 grid grid-cols-2 gap-2">
                  <div className="text-center p-2 rounded-xl bg-white/5">
                    <p className="text-[7px] font-black text-white/20 uppercase">Nível</p>
                    <p className="text-xs font-black text-primary">${rpgInfo.level}</p>
                  </div>
                  <div className="text-center p-2 rounded-xl bg-white/5">
                    <p className="text-[7px] font-black text-white/20 uppercase">Gold</p>
                    <p className="text-xs font-black text-warning">${shortNum(rpgInfo.gold)}</p>
                  </div>
                </div>
              `}
            </div>

            <!-- Navigation -->
            <nav className="flex-1 space-y-1.5">
              ${TABS.map(
                (tab) => html`
                  <button onClick=${() => handleTabChange(tab.key)} className=${`w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl font-black text-[10px] uppercase tracking-[0.15em] transition-all relative group ${activeTab === tab.key ? 'bg-primary text-primary-content shadow-lg shadow-primary/10' : 'text-white/40 hover:bg-white/5 hover:text-white'}`}>
                    <span className=${`text-xl transition-transform duration-500 ${activeTab === tab.key ? 'scale-110' : 'group-hover:scale-110'}`}>${tab.icon}</span>
                    <span className=${`transition-all duration-300 ${isSidebarCollapsed ? 'opacity-0 w-0' : 'opacity-100'}`}>${tab.label}</span>
                    ${isSidebarCollapsed && activeTab === tab.key && html`<div className="absolute right-0 w-1 h-6 bg-primary rounded-l-full"></div>`}
                  </button>
                `,
              )}
            </nav>

            <!-- Sidebar Footer -->
            <div className=${`mt-auto pt-6 border-t border-white/5 ${isSidebarCollapsed ? 'text-center' : ''}`}>
              <div className="flex flex-col gap-2">
                <div className=${`flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5 ${isSidebarCollapsed ? 'justify-center' : ''}`}>
                  <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></div>
                  ${!isSidebarCollapsed && html`<span className="text-[8px] font-black uppercase tracking-widest text-white/30">v2.6.0 Connected</span>`}
                </div>
              </div>
            </div>
          </div>
        </aside>

        <!-- Main Content -->
        <main className=${`flex-1 min-w-0 content-transition px-4 lg:px-10 py-8 lg:py-12`}>
          <div className="max-w-5xl mx-auto space-y-10">
            <div data-reveal="fade-up" className="flex flex-col md:flex-row md:items-end justify-between gap-6">
              <div className="space-y-2">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[9px] font-black uppercase tracking-widest">Dashboard v3.0</div>
                <h1 className="text-4xl lg:text-6xl font-black tracking-tighter">Painel do <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-emerald-400">Usuário</span></h1>
                <p className="text-white/40 text-sm font-medium">Gerencie suas estatísticas, conquistas RPG e segurança em um só lugar.</p>
              </div>
              <div className="hidden md:flex items-center gap-4 text-right">
                <div>
                  <p className="text-[10px] font-black uppercase text-white/20 tracking-widest">Status da Sessão</p>
                  <p className="text-xs font-bold text-success">Encriptada e Ativa</p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-success/10 border border-success/20 flex items-center justify-center text-success">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                </div>
              </div>
            </div>

            <div data-reveal="fade-up" className="relative p-1 rounded-[3.5rem] bg-gradient-to-br from-white/10 via-transparent to-transparent group">
              <div className="bg-[#020617] rounded-[3.4rem] p-6 lg:p-12 min-h-[600px] overflow-hidden relative shadow-2xl">
                ${isLoading
                  ? html`
                      <div className="flex flex-col items-center justify-center h-full space-y-6 py-32 animate-in fade-in">
                        <div className="relative">
                          <div className="absolute inset-0 bg-primary/20 blur-2xl rounded-full animate-ping"></div>
                          <span className="loading loading-ring w-20 h-20 text-primary relative"></span>
                        </div>
                        <p className="text-[10px] font-black uppercase tracking-[0.4em] text-white/30 animate-pulse">Sincronizando com o Core...</p>
                      </div>
                    `
                  : html`
                      <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
                        ${activeTab === 'summary' &&
                        html`
                          <div className="grid gap-10">
                            <!-- Main Metrics Row -->
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <div className="p-8 rounded-[2.5rem] bg-white/[0.03] border border-white/5 space-y-2 group/card hover:border-primary/30 transition-all hover:bg-white/[0.05] relative overflow-hidden">
                                <div className="absolute -right-4 -bottom-4 text-6xl opacity-5 group-hover/card:scale-110 transition-transform">💬</div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-white/20 group-hover/card:text-primary transition-colors relative z-10">Total de Mensagens</p>
                                <p className="text-4xl font-black text-white relative z-10">${usageInfo.messages.toLocaleString()}</p>
                              </div>
                              <div className="p-8 rounded-[2.5rem] bg-white/[0.03] border border-white/5 space-y-2 group/card hover:border-emerald-400/30 transition-all hover:bg-white/[0.05] relative overflow-hidden">
                                <div className="absolute -right-4 -bottom-4 text-6xl opacity-5 group-hover/card:scale-110 transition-transform">🖼️</div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-white/20 group-hover/card:text-emerald-400 transition-colors relative z-10">Stickers Criados</p>
                                <p className="text-4xl font-black text-white relative z-10">${usageInfo.stickers.toLocaleString()}</p>
                              </div>
                              <div className="p-8 rounded-[2.5rem] bg-white/[0.03] border border-white/5 space-y-2 group/card hover:border-warning/30 transition-all hover:bg-white/[0.05] relative overflow-hidden">
                                <div className="absolute -right-4 -bottom-4 text-6xl opacity-5 group-hover/card:scale-110 transition-transform">📦</div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-white/20 group-hover/card:text-warning transition-colors relative z-10">Packs Ativos</p>
                                <p className="text-4xl font-black text-white relative z-10">${usageInfo.packs}</p>
                              </div>
                            </div>

                            <!-- Deep Insights Grid -->
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                              <div className="p-7 rounded-[2.5rem] bg-white/[0.02] border border-white/5 space-y-5 hover:border-white/10 transition-colors group/insight">
                                <div className="flex items-center justify-between">
                                  <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30 group-hover/insight:text-white/50 transition-colors">Comandos</h4>
                                  <span className="text-xs">⌨️</span>
                                </div>
                                <div className="space-y-3.5">
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/40">Total Usados</span>
                                    <span className="text-sm font-black">${usageInfo.insights?.commands_total || 0}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/40">Favorito</span>
                                    <span className="text-sm font-black text-primary truncate ml-4">${usageInfo.insights?.top_command || 'N/D'}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/40">Frequência</span>
                                    <span className="text-sm font-black">${usageInfo.insights?.top_command_count || 0} execs</span>
                                  </div>
                                </div>
                              </div>

                              <div className="p-7 rounded-[2.5rem] bg-white/[0.02] border border-white/5 space-y-5 hover:border-white/10 transition-colors group/insight">
                                <div className="flex items-center justify-between">
                                  <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30 group-hover/insight:text-white/50 transition-colors">Comunidade</h4>
                                  <span className="text-xs">👥</span>
                                </div>
                                <div className="space-y-3.5">
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/40">Grupos Ativos</span>
                                    <span className="text-sm font-black">${usageInfo.insights?.groups_active || 0}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/40">Hub Principal</span>
                                    <span className="text-sm font-black text-emerald-400 truncate ml-4">${usageInfo.insights?.top_group || 'N/D'}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/40">Perfil Social</span>
                                    <span className="text-sm font-black capitalize">${usageInfo.insights?.top_message_type || 'Texto'}</span>
                                  </div>
                                </div>
                              </div>

                              <div className="p-7 rounded-[2.5rem] bg-white/[0.02] border border-white/5 space-y-5 hover:border-white/10 transition-colors group/insight">
                                <div className="flex items-center justify-between">
                                  <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30 group-hover/insight:text-white/50 transition-colors">Hábitos</h4>
                                  <span className="text-xs">⚡</span>
                                </div>
                                <div className="space-y-3.5">
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/40">Pico de Atividade</span>
                                    <span className="text-sm font-black">${usageInfo.insights?.active_hour !== null ? usageInfo.insights.active_hour + ':00' : 'N/D'}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/40">Engajamento Médio</span>
                                    <span className="text-sm font-black text-info">${usageInfo.insights?.avg_daily || 0} msgs/dia</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/40">Reputação Karma</span>
                                    <span className="text-sm font-black text-warning">${rpgInfo.karma?.score || 0} pts</span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            <!-- Activity Chart Section -->
                            ${usageInfo.activity_chart && usageInfo.activity_chart.length > 0
                              ? html`
                                  <div className="p-8 lg:p-10 rounded-[3.5rem] bg-white/[0.02] border border-white/5 space-y-8 relative overflow-hidden">
                                    <div className="flex items-center justify-between">
                                      <h3 className="font-black text-xl flex items-center gap-3">
                                        <span className="w-2 h-2 rounded-full bg-primary shadow-[0_0_10px_rgba(34,197,94,0.5)]"></span>
                                        Fluxo de Atividade (7 dias)
                                      </h3>
                                      <span className="text-[9px] font-black uppercase text-white/20 tracking-widest">Update Realtime</span>
                                    </div>
                                    <div className="flex items-end justify-between gap-2 h-48 pt-4 px-2">
                                      ${usageInfo.activity_chart.map((data) => {
                                        const maxCount = Math.max(...usageInfo.activity_chart.map((d) => d.count), 1);
                                        const heightPercent = Math.max((data.count / maxCount) * 100, 5);
                                        return html`
                                          <div key=${data.day} className="flex flex-col items-center gap-3 flex-1 group min-w-0">
                                            <div className="w-full relative flex justify-center h-full items-end">
                                              <div className="w-full max-w-[2.5rem] bg-primary/10 hover:bg-primary transition-all rounded-t-xl group-hover:shadow-[0_0_30px_rgba(34,197,94,0.3)] relative" style=${{ height: heightPercent + '%' }}>
                                                <div className="absolute -top-10 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-all bg-white text-[#020617] text-[10px] font-black px-2.5 py-1.5 rounded-xl pointer-events-none whitespace-nowrap z-20 shadow-xl translate-y-2 group-hover:translate-y-0">${data.count} msgs</div>
                                              </div>
                                            </div>
                                            <span className="text-[8px] font-black text-white/20 uppercase tracking-tighter truncate w-full text-center">${data.day.split('-').reverse().slice(0, 2).join('/')}</span>
                                          </div>
                                        `;
                                      })}
                                    </div>
                                  </div>
                                `
                              : null}

                            <!-- Details Card -->
                            <div className="p-8 lg:p-12 rounded-[3.5rem] bg-white/[0.03] border border-white/5 relative overflow-hidden">
                              <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 blur-[80px] rounded-full -translate-y-1/2 translate-x-1/2"></div>
                              <h3 className="relative font-black text-2xl mb-10 flex items-center gap-4">
                                <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center text-lg">🪪</div>
                                Metadados da Identidade
                              </h3>
                              
                              <div className="relative grid grid-cols-1 sm:grid-cols-2 gap-10 border-b border-white/5 pb-10 mb-10">
                                <div className="space-y-1.5">
                                  <p className="text-[10px] font-black uppercase text-white/20 tracking-widest">E-mail de Autenticação</p>
                                  <p className="text-lg font-bold text-white/80">${session?.user?.email}</p>
                                </div>
                                <div className="space-y-1.5">
                                  <p className="text-[10px] font-black uppercase text-white/20 tracking-widest">WhatsApp Vinculado</p>
                                  <p className="text-lg font-bold text-primary">${summary?.owner_phone ? `+${formatPhone(summary.owner_phone)}` : 'Vincular Conta'}</p>
                                </div>
                                <div className="space-y-1.5">
                                  <p className="text-[10px] font-black uppercase text-white/20 tracking-widest">Última Conexão</p>
                                  <p className="text-lg font-bold text-white/80">${formatDateTime(summary?.last_seen_at) || 'Online agora'}</p>
                                </div>
                                <div className="space-y-1.5">
                                  <p className="text-[10px] font-black uppercase text-white/20 tracking-widest">Membro da Rede Desde</p>
                                  <p className="text-lg font-bold text-white/80">${formatDateTime(rpgInfo.member_since) || 'Recentemente'}</p>
                                </div>
                              </div>

                              <div className="relative grid grid-cols-2 sm:grid-cols-3 gap-8">
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 mb-1">Tempo de Rede</p>
                                  <p className="text-base font-black text-primary">${daysMember} dias ativos</p>
                                </div>
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 mb-1">Primeira Interação</p>
                                  <p className="text-[11px] font-bold text-white/50">${formatDateTime(usageInfo.first_message_at) || 'N/D'}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 mb-1">Última Interação</p>
                                  <p className="text-[11px] font-bold text-white/50">${formatDateTime(usageInfo.last_message_at) || 'N/D'}</p>
                                </div>
                              </div>
                            </div>
                          </div>
                        `}
                        
                        ${activeTab === 'rpg' && html` <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                          <div className="p-8 rounded-[3rem] bg-gradient-to-br from-primary/10 via-transparent to-transparent border border-primary/20">
                             <div className="flex flex-col md:flex-row items-center gap-8">
                                <div className="relative">
                                   <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full"></div>
                                   <div className="relative w-32 h-32 rounded-full border-4 border-primary/20 p-2 flex items-center justify-center bg-[#020617]">
                                      <span className="text-5xl font-black text-white">${rpgInfo.level}</span>
                                   </div>
                                   <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 bg-primary text-primary-content px-4 py-1 rounded-full text-[10px] font-black uppercase tracking-widest shadow-xl">Nível</div>
                                </div>
                                <div className="flex-1 text-center md:text-left space-y-4">
                                   <h3 className="text-2xl font-black tracking-tight">Status do Treinador</h3>
                                   <div className="space-y-2">
                                      <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-white/40">
                                         <span>Experiência: ${rpgInfo.xp} XP</span>
                                         <span>Próximo nível: ${(rpgInfo.level + 1) * 100}</span>
                                      </div>
                                      <div className="h-4 w-full bg-white/5 rounded-full overflow-hidden border border-white/5">
                                         <div className="h-full bg-gradient-to-r from-primary to-emerald-400 transition-all duration-1000" style=${{ width: Math.min((rpgInfo.xp / ((rpgInfo.level + 1) * 100)) * 100, 100) + '%' }}></div>
                                      </div>
                                   </div>
                                </div>
                                <div className="p-6 rounded-[2.5rem] bg-warning/5 border border-warning/10 text-center min-w-[160px]">
                                   <p className="text-[9px] font-black uppercase tracking-widest text-warning/50 mb-1">Tesouro</p>
                                   <p className="text-3xl font-black text-warning">💰 ${shortNum(rpgInfo.gold)}</p>
                                </div>
                             </div>
                          </div>

                          <div className="grid md:grid-cols-2 gap-6">
                             <div className="p-8 rounded-[3rem] bg-white/[0.03] border border-white/5 space-y-6">
                                <h4 className="text-lg font-black flex items-center gap-3">🐉 Pokémon em Destaque</h4>
                                ${rpgInfo.active_pokemon ? html`
                                  <div className="p-6 rounded-3xl bg-white/5 border border-white/10 flex items-center gap-6 group hover:border-primary/40 transition-all">
                                     <div className="relative">
                                        <img src=${'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/' + (rpgInfo.active_pokemon.is_shiny ? 'shiny/' : '') + rpgInfo.active_pokemon.poke_id + '.png'} className="w-24 h-24 object-contain drop-shadow-2xl" />
                                        ${rpgInfo.active_pokemon.is_shiny && html`<div className="absolute top-0 right-0 text-xl animate-pulse">✨</div>`}
                                     </div>
                                     <div>
                                        <h5 className="text-xl font-black capitalize text-white group-hover:text-primary transition-colors">${rpgInfo.active_pokemon.nickname}</h5>
                                        <p className="text-xs font-bold text-white/40 uppercase tracking-widest">Nível ${rpgInfo.active_pokemon.level}</p>
                                     </div>
                                  </div>
                                ` : html`<div className="p-10 text-center border-2 border-dashed border-white/5 rounded-3xl text-white/20 font-bold">Nenhum Pokémon ativo</div>`}
                             </div>

                             <div className="p-8 rounded-[3rem] bg-white/[0.03] border border-white/5 space-y-6 text-center">
                                <h4 className="text-lg font-black flex items-center gap-3 justify-center">🏆 Arena Competitiva</h4>
                                <div className="grid grid-cols-2 gap-4">
                                   <div className="bg-white/5 p-5 rounded-3xl">
                                      <p className="text-2xl font-black text-white">${rpgInfo.pvp?.wins || 0}</p>
                                      <p className="text-[9px] font-black uppercase text-white/30">Vitórias</p>
                                   </div>
                                   <div className="bg-white/5 p-5 rounded-3xl">
                                      <p className="text-2xl font-black text-white">${rpgInfo.pvp?.losses || 0}</p>
                                      <p className="text-[9px] font-black uppercase text-white/30">Derrotas</p>
                                   </div>
                                </div>
                                <div className="bg-primary/10 p-4 rounded-2xl border border-primary/20">
                                   <p className="text-sm font-black text-primary">${rpgInfo.karma?.score || 0} Karma Global</p>
                                </div>
                             </div>
                          </div>
                        </div> `}

                        ${activeTab === 'account' && html` <div className="max-w-xl animate-in fade-in slide-in-from-bottom-4 duration-500">
                           <div className="space-y-10">
                              <div className="flex items-center gap-6">
                                 <div className="w-16 h-16 rounded-[2rem] bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-3xl shadow-lg">🛡️</div>
                                 <div>
                                    <h3 className="text-2xl font-black tracking-tight">Segurança</h3>
                                    <p className="text-sm text-white/40 font-medium">Proteja seu acesso ao ecossistema OmniZap.</p>
                                 </div>
                              </div>
                              <div className="p-8 rounded-[3rem] bg-white/[0.03] border border-white/5 space-y-8">
                                 <div className="space-y-4">
                                    <div className="space-y-2">
                                       <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-4">Alterar Senha</label>
                                       <input type="password" placeholder="Sua nova senha forte" className="w-full h-14 bg-[#020617] border border-white/10 rounded-2xl px-6 focus:border-primary outline-none transition-all font-mono text-sm" />
                                    </div>
                                    <div className="space-y-2">
                                       <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-4">Confirmar Senha</label>
                                       <input type="password" placeholder="Repita a nova senha" className="w-full h-14 bg-[#020617] border border-white/10 rounded-2xl px-6 focus:border-primary outline-none transition-all font-mono text-sm" />
                                    </div>
                                 </div>
                                 <button className="btn btn-primary btn-block h-14 rounded-2xl font-black uppercase text-[10px] tracking-[0.2em] shadow-xl shadow-primary/20">Atualizar Credenciais</button>
                              </div>
                           </div>
                        </div> `}

                        ${activeTab === 'support' && html` <div className="py-16 text-center max-w-lg mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
                           <div className="relative inline-block mb-10">
                              <div className="absolute inset-0 bg-primary/20 blur-[60px] rounded-full animate-pulse"></div>
                              <div className="relative w-28 h-28 rounded-[3rem] bg-white/5 border border-white/10 flex items-center justify-center text-5xl shadow-2xl">🎧</div>
                           </div>
                           <h3 className="text-3xl font-black tracking-tighter mb-4">Central de Atendimento</h3>
                           <p className="text-white/40 font-medium leading-relaxed mb-10 text-lg">Dúvidas sobre o sistema, planos ou bugs? Fale diretamente com nossa equipe técnica.</p>
                           <a href="https://wa.me/559591122954" target="_blank" className="btn btn-primary btn-lg btn-block rounded-[2rem] font-black uppercase text-xs tracking-widest h-16 shadow-2xl shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all">Iniciar Chat Suporte</a>
                        </div> `}
                      </div>
                    `}
              </div>
            </div>
          </div>
        </main>
      </div>

      <!-- Footer -->
      <footer className="py-12 border-t border-white/5 mt-auto relative z-[70] bg-[#020617]">
        <div className="container mx-auto px-4 text-center">
          <p className="text-[10px] font-black uppercase tracking-[0.5em] text-white/10">© 2026 OMNIZAP CORE · SECURE USER ENVIRONMENT</p>
        </div>
      </footer>
    </div>
  `;
};

const rootElement = document.getElementById('user-react-root');
if (rootElement) {
  const config = {
    apiBasePath: rootElement.dataset.apiBasePath || DEFAULT_API_BASE_PATH,
    loginPath: rootElement.dataset.loginPath || DEFAULT_LOGIN_PATH,
    fallbackAvatar: DEFAULT_FALLBACK_AVATAR,
  };
  createRoot(rootElement).render(html`<${UserApp} config=${config} />`);
}
