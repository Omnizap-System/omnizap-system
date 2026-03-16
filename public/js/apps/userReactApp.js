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

const UserApp = ({ config }) => {
  const [activeTab, setActiveTab] = useState('summary');
  const [isLoading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [session, setSession] = useState(null);
  const [isSidebarOpen, setSidebarOpen] = useState(false);

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
    setSidebarOpen(false);
  };

  return html`
    <div className="min-h-screen bg-[#020617] text-white font-sans selection:bg-primary selection:text-primary-content overflow-x-hidden">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 blur-[120px] rounded-full animate-pulse"></div>
        <div className="absolute bottom-[10%] right-[-5%] w-[30%] h-[30%] bg-secondary/5 blur-[100px] rounded-full"></div>
      </div>

      <!-- Backdrop for mobile sidebar (Solid overlay, no blur) -->
      <div onClick=${() => setSidebarOpen(false)} className=${`fixed inset-0 z-[90] bg-[#020617]/90 lg:hidden transition-opacity duration-300 ${isSidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}></div>

      <!-- Navbar -->
      <header className="sticky top-0 z-50 border-b border-white/5 bg-[#020617]">
        <div className="container mx-auto px-4">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <button onClick=${() => setSidebarOpen(true)} className="lg:hidden btn btn-ghost btn-square btn-sm bg-white/5 border border-white/10 rounded-xl">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M4 6h16M4 12h16M4 18h16" /></svg>
              </button>

              <a href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
                <img src="/assets/images/brand-logo-128.webp" className="w-8 h-8 rounded-xl shadow-sm" alt="Logo" />
                <span className="text-base sm:text-lg font-black tracking-tight">OmniZap<span className="text-primary">.</span></span>
              </a>
            </div>

            <div className="flex items-center gap-3">
              <button onClick=${() => window.location.assign('/login/')} className="btn btn-ghost btn-sm h-9 min-h-0 gap-2 rounded-xl bg-white/5 border border-white/10 hover:bg-error hover:text-white transition-all px-4 font-black text-[10px] uppercase tracking-widest">Sair</button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-6xl px-4 py-8 lg:py-16">
        <div className="grid lg:grid-cols-[300px_1fr] gap-8 items-start">
          <!-- Sidebar Navigation (Drawer on Mobile) -->
          <aside className=${`fixed lg:sticky top-0 lg:top-32 left-0 h-full lg:h-auto w-[280px] lg:w-auto z-[100] lg:z-0 bg-[#020617] lg:bg-transparent border-r lg:border-none border-white/10 p-6 lg:p-0 space-y-6 transform transition-transform duration-300 ease-out lg:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} shadow-[20px_0_60px_rgba(0,0,0,0.8)]`}>
            <div className="lg:hidden flex items-center justify-between mb-8">
              <span className="text-xs font-black uppercase tracking-[0.2em] text-white/30">Navegação</span>
              <button onClick=${() => setSidebarOpen(false)} className="btn btn-ghost btn-square btn-xs">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="hidden lg:block relative group p-8 rounded-[2.5rem] bg-white/[0.03] border border-white/5 text-center space-y-6 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

              <div className="relative">
                <div className="relative inline-block">
                  <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full animate-pulse"></div>
                  <img src=${authInfo.image} className="relative w-24 h-24 rounded-[2rem] border-2 border-white/10 p-1.5 object-cover mx-auto shadow-2xl" />
                  <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-success border-4 border-[#020617] rounded-full"></div>
                </div>
              </div>

              <div className="relative space-y-1">
                <h2 className="text-xl font-black tracking-tight truncate px-2">${session?.user?.name || 'Carregando...'}</h2>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-black uppercase tracking-widest">${summary?.plan_label || 'Plano Free'}</div>
              </div>

              <div className="relative grid grid-cols-2 gap-2 pt-2">
                <div className="p-3 rounded-2xl bg-white/5 border border-white/5 text-center">
                  <p className="text-[8px] font-black text-white/30 uppercase tracking-widest mb-1">Nível</p>
                  <p className="text-lg font-black text-primary">${rpgInfo.level}</p>
                </div>
                <div className="p-3 rounded-2xl bg-white/5 border border-white/5 text-center">
                  <p className="text-[8px] font-black text-white/30 uppercase tracking-widest mb-1">Gold</p>
                  <p className="text-lg font-black text-warning">💰 ${rpgInfo.gold}</p>
                </div>
              </div>
            </div>

            <nav className="p-2 rounded-[2rem] bg-white/[0.03] border border-white/5 space-y-1">
              ${TABS.map(
                (tab) => html`
                  <button onClick=${() => handleTabChange(tab.key)} className=${`w-full flex items-center gap-4 px-6 py-4 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${activeTab === tab.key ? 'bg-primary text-primary-content shadow-2xl shadow-primary/20 scale-[1.02]' : 'hover:bg-white/5 text-white/40 hover:text-white'}`}>
                    <span className="text-xl opacity-80">${tab.icon}</span>
                    ${tab.label}
                  </button>
                `,
              )}
            </nav>
          </aside>

          <!-- Content Area -->
          <div className="space-y-8">
            <div data-reveal="fade-up" className="space-y-2 text-center lg:text-left pt-4 lg:pt-0">
              <h1 className="text-4xl sm:text-5xl font-black tracking-tighter">Painel do <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-emerald-400">Usuário</span></h1>
              <p className="text-white/40 text-base font-medium">Bem-vindo de volta! Aqui estão suas estatísticas em tempo real.</p>
            </div>

            <div data-reveal="fade-up" className="relative p-1 rounded-[3rem] bg-gradient-to-br from-white/10 to-transparent">
              <div className="bg-[#020617] rounded-[2.9rem] p-6 lg:p-12 min-h-[500px] overflow-hidden relative">
                ${isLoading
                  ? html`
                      <div className="flex flex-col items-center justify-center h-full space-y-6 py-20 animate-in fade-in">
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
                          <div className="grid gap-10 animate-in fade-in slide-in-from-bottom-8 duration-700">
                            <!-- Main Metrics Row -->
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <div className="p-8 rounded-[2.5rem] bg-white/[0.03] border border-white/5 space-y-2 group hover:border-primary/30 transition-colors relative overflow-hidden">
                                <div className="absolute -right-4 -bottom-4 text-6xl opacity-5">💬</div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-white/20 group-hover:text-primary transition-colors relative z-10">Total de Mensagens</p>
                                <p className="text-4xl font-black text-white relative z-10">${usageInfo.messages.toLocaleString()}</p>
                              </div>
                              <div className="p-8 rounded-[2.5rem] bg-white/[0.03] border border-white/5 space-y-2 group hover:border-emerald-400/30 transition-colors relative overflow-hidden">
                                <div className="absolute -right-4 -bottom-4 text-6xl opacity-5">🖼️</div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-white/20 group-hover:text-emerald-400 transition-colors relative z-10">Stickers Criados</p>
                                <p className="text-4xl font-black text-white relative z-10">${usageInfo.stickers.toLocaleString()}</p>
                              </div>
                              <div className="p-8 rounded-[2.5rem] bg-white/[0.03] border border-white/5 space-y-2 group hover:border-warning/30 transition-colors relative overflow-hidden">
                                <div className="absolute -right-4 -bottom-4 text-6xl opacity-5">📦</div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-white/20 group-hover:text-warning transition-colors relative z-10">Packs de Stickers</p>
                                <p className="text-4xl font-black text-white relative z-10">${usageInfo.packs}</p>
                              </div>
                            </div>

                            <!-- Deep Insights Grid -->
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                              <div className="p-6 rounded-[2rem] bg-white/[0.02] border border-white/5 space-y-4">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30">Comandos</h4>
                                <div className="space-y-3">
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/50">Total Usados</span>
                                    <span className="text-sm font-black">${usageInfo.insights?.commands_total || 0}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/50">Favorito</span>
                                    <span className="text-sm font-black text-primary">${usageInfo.insights?.top_command || 'N/D'}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/50">Uso do Favorito</span>
                                    <span className="text-sm font-black">${usageInfo.insights?.top_command_count || 0}x</span>
                                  </div>
                                </div>
                              </div>

                              <div className="p-6 rounded-[2rem] bg-white/[0.02] border border-white/5 space-y-4">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30">Comunidade</h4>
                                <div className="space-y-3">
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/50">Grupos Ativos</span>
                                    <span className="text-sm font-black">${usageInfo.insights?.groups_active || 0}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/50">Grupo Principal</span>
                                    <span className="text-sm font-black text-emerald-400 truncate max-w-[120px]">${usageInfo.insights?.top_group || 'N/D'}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/50">Tipo mais comum</span>
                                    <span className="text-sm font-black capitalize">${usageInfo.insights?.top_message_type || 'texto'}</span>
                                  </div>
                                </div>
                              </div>

                              <div className="p-6 rounded-[2rem] bg-white/[0.02] border border-white/5 space-y-4">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30">Hábito de Uso</h4>
                                <div className="space-y-3">
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/50">Horário de Pico</span>
                                    <span className="text-sm font-black">${usageInfo.insights?.active_hour !== null ? usageInfo.insights.active_hour + ':00' : 'N/D'}</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/50">Média Diária</span>
                                    <span className="text-sm font-black text-info">${usageInfo.insights?.avg_daily || 0} msg</span>
                                  </div>
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-medium text-white/50">Karma Atual</span>
                                    <span className="text-sm font-black text-warning">${rpgInfo.karma?.score || 0}</span>
                                  </div>
                                </div>
                              </div>
                            </div>

                            <!-- Activity Chart -->
                            ${usageInfo.activity_chart && usageInfo.activity_chart.length > 0
                              ? html`
                                  <div className="p-8 rounded-[3rem] bg-white/[0.02] border border-white/5 space-y-6">
                                    <h3 className="font-black text-lg flex items-center gap-3">
                                      <span className="text-primary">📈</span>
                                      Fluxo de Mensagens (7 dias)
                                    </h3>
                                    <div className="flex items-end justify-between gap-2 h-40 pt-4 px-2">
                                      ${usageInfo.activity_chart.map((data) => {
                                        const maxCount = Math.max(...usageInfo.activity_chart.map((d) => d.count), 1);
                                        const heightPercent = Math.max((data.count / maxCount) * 100, 5);
                                        return html`
                                          <div key=${data.day} className="flex flex-col items-center gap-2 flex-1 group min-w-0">
                                            <div className="w-full relative flex justify-center h-full items-end">
                                              <div className="w-full max-w-[2rem] bg-primary/20 hover:bg-primary transition-all rounded-t-lg group-hover:shadow-[0_0_20px_rgba(34,197,94,0.4)]" style=${{ height: heightPercent + '%' }}>
                                                <div className="absolute -top-8 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-white text-[#020617] text-[10px] font-black px-2 py-1 rounded-lg pointer-events-none whitespace-nowrap z-20">${data.count} msgs</div>
                                              </div>
                                            </div>
                                            <span className="text-[8px] font-bold text-white/20 uppercase tracking-tighter truncate w-full text-center">${data.day.split('-').reverse().join('/')}</span>
                                          </div>
                                        `;
                                      })}
                                    </div>
                                  </div>
                                `
                              : null}

                            <!-- RPG & Social Snippet -->
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                              <div className="p-8 rounded-[2.5rem] bg-emerald-500/5 border border-emerald-500/10 space-y-4">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-emerald-400/40">Engajamento Social</h4>
                                <div className="grid grid-cols-2 gap-4">
                                  <div className="space-y-1">
                                    <p className="text-[8px] font-black text-white/20 uppercase">Votos Positivos</p>
                                    <p className="text-xl font-black text-emerald-400">+${rpgInfo.karma?.positive || 0}</p>
                                  </div>
                                  <div className="space-y-1">
                                    <p className="text-[8px] font-black text-white/20 uppercase">Votos Negativos</p>
                                    <p className="text-xl font-black text-rose-500">-${rpgInfo.karma?.negative || 0}</p>
                                  </div>
                                </div>
                              </div>
                              <div className="p-8 rounded-[2.5rem] bg-info/5 border border-info/10 space-y-4">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-info/40">Exploração</h4>
                                <div className="grid grid-cols-2 gap-4">
                                  <div className="space-y-1">
                                    <p className="text-[8px] font-black text-white/20 uppercase">Itens Inventário</p>
                                    <p className="text-xl font-black text-white">${rpgInfo.inventory_count || 0}</p>
                                  </div>
                                  <div className="space-y-1">
                                    <p className="text-[8px] font-black text-white/20 uppercase">Pokémons</p>
                                    <p className="text-xl font-black text-white">${rpgInfo.total_pokemons || 0}</p>
                                  </div>
                                </div>
                              </div>
                            </div>

                            <!-- Account Details -->
                            <div className="p-6 sm:p-10 rounded-[2.5rem] sm:rounded-[3rem] bg-primary/5 border border-primary/10 relative overflow-hidden">
                              <div className="absolute top-[-20%] right-[-10%] w-64 h-64 bg-primary/10 blur-[80px] rounded-full"></div>
                              <h3 className="relative font-black text-xl mb-8 flex items-center gap-3">
                                <span className="w-2 h-2 rounded-full bg-primary shadow-[0_0_10px_rgba(34,197,94,0.8)]"></span>
                                Detalhes da Identidade
                              </h3>
                              <div className="relative grid grid-cols-1 sm:grid-cols-2 gap-y-6 sm:gap-y-8 gap-x-12 border-b border-white/5 pb-8 mb-8">
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 tracking-[0.2em] mb-1">Endereço de E-mail</p>
                                  <p className="text-sm sm:text-lg font-bold text-white/80 break-all">${session?.user?.email}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 tracking-[0.2em] mb-1">WhatsApp Vinculado</p>
                                  <p className="text-sm sm:text-lg font-bold text-white/80">${summary?.owner_phone ? `+${formatPhone(summary.owner_phone)}` : 'Não vinculado'}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 tracking-[0.2em] mb-1">Última Atividade</p>
                                  <p className="text-sm sm:text-lg font-bold text-white/80">${formatDateTime(summary?.last_seen_at) || 'Ativo agora'}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 tracking-[0.2em] mb-1">Membro Desde</p>
                                  <p className="text-sm sm:text-lg font-bold text-white/80">${formatDateTime(rpgInfo.member_since) || 'Recentemente'}</p>
                                </div>
                              </div>

                              <div className="relative grid grid-cols-2 sm:grid-cols-3 gap-6">
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 mb-1">Tempo como Membro</p>
                                  <p className="text-sm font-black text-primary">${daysMember} dias</p>
                                </div>
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 mb-1">Primeira Mensagem</p>
                                  <p className="text-[10px] font-bold text-white/60">${formatDateTime(usageInfo.first_message_at) || 'N/D'}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] font-black uppercase text-white/20 mb-1">Última Mensagem</p>
                                  <p className="text-[10px] font-bold text-white/60">${formatDateTime(usageInfo.last_message_at) || 'N/D'}</p>
                                </div>
                              </div>
                            </div>
                          </div>
                        `}
                        ${activeTab === 'rpg' &&
                        html`
                          <div className="space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-700">
                            <!-- RPG Header -->
                            <div className="flex flex-col sm:flex-row gap-6 items-center sm:items-stretch">
                              <div className="flex-1 p-8 rounded-[3rem] bg-gradient-to-br from-primary/10 to-transparent border border-primary/20 relative overflow-hidden w-full">
                                <div className="absolute top-0 right-0 p-6 text-6xl opacity-10">⚔️</div>
                                <h3 className="text-sm font-black uppercase tracking-widest text-primary mb-6">Status do Treinador</h3>
                                <div className="flex items-baseline gap-4 mb-4">
                                  <span className="text-6xl font-black text-white">${rpgInfo.level}</span>
                                  <span className="text-sm font-bold text-white/40 uppercase tracking-widest">Nível Atual</span>
                                </div>

                                <div className="space-y-2 w-full max-w-sm">
                                  <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-white/50">
                                    <span>XP Atual: ${rpgInfo.xp}</span>
                                    <span>Próximo Nível</span>
                                  </div>
                                  <div className="h-3 w-full bg-[#020617] rounded-full overflow-hidden border border-white/5">
                                    <div className="h-full bg-gradient-to-r from-primary to-emerald-400 rounded-full transition-all duration-1000" style=${{ width: Math.min((rpgInfo.xp / (rpgInfo.level * 100)) * 100, 100) + '%' }}></div>
                                  </div>
                                </div>
                              </div>

                              <div className="p-8 rounded-[3rem] bg-warning/5 border border-warning/10 flex flex-col justify-center items-center sm:min-w-[200px] w-full sm:w-auto">
                                <span className="text-4xl mb-4 animate-bounce">💰</span>
                                <span className="text-4xl font-black text-warning mb-1">${rpgInfo.gold}</span>
                                <span className="text-[10px] font-black uppercase tracking-widest text-warning/50">Gold Acumulado</span>
                              </div>
                            </div>

                            <!-- Pokemon & PvP -->
                            <div className="grid md:grid-cols-2 gap-6">
                              <!-- Active Pokemon -->
                              <div className="p-8 rounded-[2.5rem] bg-white/[0.03] border border-white/5 space-y-6">
                                <div className="flex items-center gap-3">
                                  <span className="text-xl">🐉</span>
                                  <h3 className="font-black text-lg">Pokémon Ativo</h3>
                                </div>

                                ${rpgInfo.active_pokemon
                                  ? html`
                                      <div className="flex items-center gap-6 p-6 rounded-3xl bg-white/5 border border-white/5 group hover:border-primary/30 transition-colors">
                                        <div className="relative">
                                          <div className="w-16 h-16 bg-white/10 rounded-full flex items-center justify-center text-3xl">
                                            <img src=${'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/' + (rpgInfo.active_pokemon.is_shiny ? 'shiny/' : '') + rpgInfo.active_pokemon.poke_id + '.png'} alt="Pokemon" className="w-20 h-20 scale-125 object-contain" />
                                          </div>
                                          ${rpgInfo.active_pokemon.is_shiny && html`<div className="absolute -top-2 -right-2 text-warning animate-pulse">✨</div>`}
                                        </div>
                                        <div>
                                          <h4 className="text-xl font-black capitalize text-white group-hover:text-primary transition-colors">${rpgInfo.active_pokemon.nickname || 'Desconhecido'}</h4>
                                          <p className="text-xs font-bold text-white/50 uppercase tracking-widest mt-1">Nível ${rpgInfo.active_pokemon.level}</p>
                                        </div>
                                      </div>
                                    `
                                  : html`
                                      <div className="p-6 text-center rounded-3xl bg-white/5 border border-white/5 border-dashed">
                                        <p className="text-sm font-bold text-white/40">Nenhum Pokémon ativo no momento.</p>
                                      </div>
                                    `}

                                <div className="flex items-center justify-between p-4 rounded-2xl bg-white/5">
                                  <span className="text-[10px] font-black uppercase tracking-widest text-white/40">Total Capturados</span>
                                  <span className="text-lg font-black text-white">${rpgInfo.total_pokemons}</span>
                                </div>
                              </div>

                              <!-- PvP Stats -->
                              <div className="p-8 rounded-[2.5rem] bg-white/[0.03] border border-white/5 space-y-6">
                                <div className="flex items-center gap-3">
                                  <span className="text-xl">🏆</span>
                                  <h3 className="font-black text-lg">Arena PvP (Semanal)</h3>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                  <div className="p-4 rounded-2xl bg-white/5 text-center">
                                    <p className="text-3xl font-black text-white mb-1">${rpgInfo.pvp?.matches || 0}</p>
                                    <p className="text-[9px] font-black uppercase tracking-widest text-white/40">Batalhas</p>
                                  </div>
                                  <div className="p-4 rounded-2xl bg-success/10 border border-success/20 text-center">
                                    <p className="text-3xl font-black text-success mb-1">${rpgInfo.pvp?.matches > 0 ? Math.round(((rpgInfo.pvp?.wins || 0) / rpgInfo.pvp.matches) * 100) : 0}%</p>
                                    <p className="text-[9px] font-black uppercase tracking-widest text-success/60">Vitórias</p>
                                  </div>
                                  <div className="p-4 rounded-2xl bg-info/10 text-center">
                                    <p className="text-xl font-black text-info mb-1">${rpgInfo.pvp?.wins || 0}</p>
                                    <p className="text-[9px] font-black uppercase tracking-widest text-info/60">Ganha</p>
                                  </div>
                                  <div className="p-4 rounded-2xl bg-error/10 text-center">
                                    <p className="text-xl font-black text-error mb-1">${rpgInfo.pvp?.losses || 0}</p>
                                    <p className="text-[9px] font-black uppercase tracking-widest text-error/60">Perdida</p>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        `}
                        ${activeTab === 'account' &&
                        html`
                          <div className="space-y-10 max-w-2xl mx-auto lg:mx-0">
                            <div className="flex items-center gap-6">
                              <div className="w-16 h-16 rounded-3xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-3xl">🛡️</div>
                              <div>
                                <h3 className="text-2xl font-black tracking-tight">Segurança da Conta</h3>
                                <p className="text-white/40 font-medium text-sm leading-relaxed">Mantenha sua chave de acesso segura e atualizada.</p>
                              </div>
                            </div>

                            <form className="space-y-6">
                              <div className="grid sm:grid-cols-2 gap-6">
                                <div className="space-y-2">
                                  <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-4">Nova Senha</label>
                                  <input type="password" placeholder="••••••••" className="w-full h-14 bg-white/5 border border-white/10 rounded-2xl px-6 focus:border-primary outline-none transition-all font-mono" />
                                </div>
                                <div className="space-y-2">
                                  <label className="text-[10px] font-black uppercase tracking-widest text-white/30 ml-4">Confirmar</label>
                                  <input type="password" placeholder="••••••••" className="w-full h-14 bg-white/5 border border-white/10 rounded-2xl px-6 focus:border-primary outline-none transition-all font-mono" />
                                </div>
                              </div>
                              <button className="group relative inline-flex items-center justify-center">
                                <div className="absolute inset-0 bg-primary/20 blur-xl rounded-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                                <div className="relative bg-primary text-primary-content px-10 py-4 rounded-xl font-black text-[10px] uppercase tracking-[0.2em] shadow-xl hover:scale-105 transition-all">Atualizar Credenciais</div>
                              </button>
                            </form>
                          </div>
                        `}
                        ${activeTab === 'support' &&
                        html`
                          <div className="text-center max-w-lg mx-auto py-16 space-y-10 relative">
                            <div className="absolute inset-0 bg-primary/5 blur-[100px] rounded-full"></div>
                            <div className="relative w-24 h-24 rounded-[2.5rem] bg-primary/10 border border-primary/20 flex items-center justify-center text-5xl mx-auto shadow-2xl">🎧</div>
                            <div className="relative space-y-3">
                              <h3 className="text-3xl font-black tracking-tighter text-white">Canal de Suporte</h3>
                              <p className="text-white/40 font-medium leading-relaxed">Nosso time de especialistas está pronto para te ajudar com qualquer dúvida técnica ou financeira.</p>
                            </div>
                            <a href="https://wa.me/559591122954" target="_blank" className="relative flex group">
                              <div className="absolute inset-0 bg-success/20 blur-2xl rounded-2xl group-hover:bg-success/40 transition-all"></div>
                              <div className="relative w-full bg-success text-white py-5 rounded-2xl font-black text-xs uppercase tracking-[0.3em] shadow-2xl group-hover:scale-[1.02] active:scale-95 transition-all">Iniciar Chat no WhatsApp</div>
                            </a>
                          </div>
                        `}
                      </div>
                    `}
              </div>
            </div>
          </div>
        </div>
      </main>

      <!-- Footer Minimal -->
      <footer className="py-12 border-t border-white/5 mt-auto relative z-10 bg-[#020617]">
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
