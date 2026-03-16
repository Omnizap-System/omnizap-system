import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);

const CATALOG_URL = '/comandos/commands-catalog.json';

const _RequirementIcon = ({ type, active }) => {
  if (!active) return null;
  const config = {
    group: { icon: '👥', label: 'Grupo' },
    admin: { icon: '👮', label: 'Admin' },
    owner: { icon: '👑', label: 'Owner' },
    google_login: { icon: '📧', label: 'Google' },
    nsfw: { icon: '🔞', label: 'NSFW' },
    media: { icon: '🖼️', label: 'Mídia' },
    reply: { icon: '↩️', label: 'Resposta' },
  };
  const { icon, label } = config[type] || { icon: '❓', label: type };
  return html`
    <span className="flex items-center gap-1.5 bg-base-300/50 px-2 py-1 rounded-lg text-[10px] font-bold text-base-content/70 border border-base-300" title=${label}>
      <span>${icon}</span>
      <span>${label}</span>
    </span>
  `;
};

const CommandDetailsPage = ({ command, onClose, devMode }) => {
  if (!command) return null;
  const [copyStatus, setCopyStatus] = useState({});

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopyStatus({ ...copyStatus, [id]: true });
    setTimeout(() => {
      setCopyStatus({ ...copyStatus, [id]: false });
    }, 2000);
  };

  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = `/${command.name} - Detalhes do Comando | OmniZap`;
    return () => {
      document.title = 'Comandos do Bot para WhatsApp | OmniZap';
    };
  }, [command]);

  return html`
    <div className="min-h-screen bg-[#020617] text-white selection:bg-primary selection:text-primary-content animate-in fade-in duration-700 overflow-x-hidden">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-primary/10 blur-[120px] rounded-full animate-pulse"></div>
        <div className="absolute top-[20%] -right-[10%] w-[30%] h-[30%] bg-secondary/10 blur-[100px] rounded-full"></div>
      </div>

      <div className="sticky top-0 z-50 bg-[#020617]/60 backdrop-blur-xl border-b border-white/5">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <button onClick=${onClose} className="btn btn-ghost group pl-0 hover:bg-transparent min-h-0 h-auto py-2">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center group-hover:bg-primary group-hover:text-primary-content group-hover:border-primary transition-all duration-300">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M15 19l-7-7 7-7" /></svg>
            </div>
            <span className="hidden sm:inline text-xs font-black uppercase tracking-widest ml-3 opacity-50 group-hover:opacity-100 transition-opacity">Voltar ao Catálogo</span>
            <span className="sm:hidden text-[10px] font-black uppercase tracking-widest ml-2 opacity-50">Voltar</span>
          </button>

          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] text-primary">${command.category_label}</p>
              <p className="text-[8px] font-bold opacity-30 uppercase tracking-widest hidden sm:block">Ref. Doc V3.5</p>
            </div>
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-primary/10 flex items-center justify-center text-lg sm:text-xl border border-primary/20 shadow-[0_0_20px_rgba(34,197,94,0.1)]">${command.category_icon || '🧩'}</div>
          </div>
        </div>
      </div>

      <main className="container mx-auto max-w-4xl px-4 py-8 lg:py-16 relative z-10">
        <div className="space-y-12 sm:space-y-16">
          <header className="space-y-6 text-center sm:text-left">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-black uppercase tracking-widest">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
              Documentação Oficial
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-4">
                <h1 className="text-4xl sm:text-7xl lg:text-8xl font-black tracking-tighter text-white break-words">/<span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-emerald-400">${command.name}</span></h1>
                ${command.premium && html` <div className="badge badge-warning h-8 sm:h-10 px-4 sm:px-6 font-black text-[9px] sm:text-[10px] uppercase tracking-[0.2em] shadow-[0_0_30px_rgba(251,191,36,0.2)] border-none">Premium</div> `}
              </div>
              <p className="text-lg sm:text-xl lg:text-2xl text-white/60 leading-relaxed font-medium max-w-3xl mx-auto sm:mx-0 break-words">${command.descricao}</p>
            </div>

            <div className="flex flex-wrap justify-center sm:justify-start gap-2 pt-2">
              <${_RequirementIcon} type="group" active=${command.requirements?.group} />
              <${_RequirementIcon} type="admin" active=${command.requirements?.admin} />
              <${_RequirementIcon} type="owner" active=${command.requirements?.owner} />
              <${_RequirementIcon} type="google_login" active=${command.requirements?.google_login} />
              <${_RequirementIcon} type="nsfw" active=${command.requirements?.nsfw} />
              <${_RequirementIcon} type="media" active=${command.requirements?.media} />
              <${_RequirementIcon} type="reply" active=${command.requirements?.reply} />
            </div>
          </header>

          <section className="space-y-6">
            <div className="flex items-center gap-4">
              <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-white/20">Como usar agora</h3>
              <div className="flex-1 h-px bg-white/5"></div>
            </div>
            <div className="grid gap-4">
              ${(command.metodos_de_uso || []).map(
                (usage, idx) => html`
                  <div key=${idx} className="group relative">
                    <div className="absolute inset-0 bg-primary/5 blur-xl opacity-0 group-hover:opacity-100 transition-opacity rounded-[1.5rem] sm:rounded-[2.5rem]"></div>
                    <div className="relative flex flex-col sm:flex-row items-stretch sm:items-center gap-0 sm:gap-4 p-1 rounded-[1.5rem] sm:rounded-[2rem] bg-white/[0.03] border border-white/5 group-hover:border-primary/30 transition-all duration-300">
                      <code className="flex-1 px-5 py-4 sm:px-6 sm:py-6 font-mono text-sm sm:text-base text-primary/80 break-all leading-relaxed"> ${usage} </code>
                      <button onClick=${() => handleCopy(usage, `usage-${idx}`)} className=${`px-8 py-3.5 sm:py-6 rounded-2xl sm:rounded-r-[1.8rem] sm:rounded-l-none font-black text-[10px] uppercase tracking-widest transition-all ${copyStatus[`usage-${idx}`] ? 'bg-success text-white' : 'bg-white/5 hover:bg-primary hover:text-primary-content'}`}>${copyStatus[`usage-${idx}`] ? 'Copiado!' : 'Copiar'}</button>
                    </div>
                  </div>
                `,
              )}
            </div>
          </section>

          ${command.arguments?.length > 0 &&
          html`
            <section className="space-y-6">
              <div className="flex items-center gap-4">
                <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-white/20">Configurações e Argumentos</h3>
                <div className="flex-1 h-px bg-white/5"></div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${command.arguments.map(
                  (arg) => html`
                    <div key=${arg.name} className="group p-5 sm:p-6 rounded-[1.5rem] sm:rounded-[2rem] bg-white/[0.02] border border-white/5 hover:border-primary/20 transition-all duration-300">
                      <div className="flex items-start justify-between mb-4">
                        <div className="space-y-1">
                          <h4 className="text-base sm:text-lg font-black text-white group-hover:text-primary transition-colors">${arg.name}</h4>
                          <span className="inline-block text-[9px] font-bold text-white/30 font-mono uppercase tracking-widest bg-white/5 px-2 py-0.5 rounded"> Type: ${arg.type} </span>
                        </div>
                        <span className=${`text-[8px] font-black uppercase px-2.5 py-1 rounded-full border ${arg.required ? 'bg-error/10 text-error border-error/20' : 'bg-white/5 text-white/30 border-white/10'}`}> ${arg.required ? 'Obrigatório' : 'Opcional'} </span>
                      </div>
                      <p className="text-xs sm:text-sm text-white/50 font-medium leading-relaxed">${arg.description}</p>
                    </div>
                  `,
                )}
              </div>
            </section>
          `}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-6">
            <section className="p-6 sm:p-8 rounded-[1.5rem] sm:rounded-[2.5rem] bg-white/[0.02] border border-white/5 space-y-6 relative overflow-hidden group">
              <div className="absolute -right-8 -bottom-8 w-32 h-32 bg-primary/5 blur-2xl rounded-full group-hover:bg-primary/10 transition-colors"></div>
              <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30 relative z-10">Specs Técnicas</h3>
              <div className="grid grid-cols-2 gap-y-6 sm:gap-y-8 relative z-10">
                <div>
                  <p className="text-[9px] font-bold uppercase text-white/20 mb-1 tracking-widest">Versão</p>
                  <p className="text-sm sm:text-base font-black text-white">${command.technical?.version || '1.0.0'}</p>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase text-white/20 mb-1 tracking-widest">Estabilidade</p>
                  <p className="text-sm sm:text-base font-black text-emerald-400">${command.technical?.stability || 'Stable'}</p>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase text-white/20 mb-1 tracking-widest">Risco</p>
                  <p className="text-sm sm:text-base font-black ${command.technical?.risk_level !== 'low' ? 'text-rose-500' : 'text-emerald-400'}">${command.technical?.risk_level?.toUpperCase() || 'LOW'}</p>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase text-white/20 mb-1 tracking-widest">ID Sistema</p>
                  <p className="text-[10px] font-mono font-bold text-white/40 truncate" title=${command.id}>${command.id}</p>
                </div>
              </div>
            </section>

            ${command.technical?.collected_data?.length > 0 &&
            html`
              <section className="p-6 sm:p-8 rounded-[1.5rem] sm:rounded-[2.5rem] bg-white/[0.02] border border-white/5 space-y-6 relative overflow-hidden group">
                <div className="absolute -right-8 -bottom-8 w-32 h-32 bg-emerald-500/5 blur-2xl rounded-full group-hover:bg-emerald-500/10 transition-colors"></div>
                <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30 relative z-10">Privacidade e Dados</h3>
                <div className="flex flex-wrap gap-2 relative z-10">${command.technical.collected_data.map((data) => html` <span key=${data} className="text-[10px] font-bold bg-white/5 px-4 py-2 rounded-xl border border-white/10 text-white/60">${data}</span> `)}</div>
                <p className="text-[9px] text-white/20 font-medium leading-relaxed italic relative z-10">* Estes dados são processados apenas para execução do comando.</p>
              </section>
            `}
          </div>

          ${devMode &&
          html`
            <section className="space-y-6 animate-in slide-in-from-bottom-8 duration-1000">
              <div className="flex items-center gap-4">
                <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-warning/30">Developer Metadata</h3>
                <div className="flex-1 h-px bg-warning/10"></div>
              </div>
              <div className="relative group">
                <div className="absolute inset-0 bg-warning/5 blur-3xl opacity-20"></div>
                <div className="relative bg-[#020617] border border-warning/10 rounded-[1.5rem] sm:rounded-[2.5rem] overflow-hidden">
                  <div className="bg-warning/5 px-6 sm:px-8 py-3 border-b border-warning/10 flex items-center justify-between">
                    <span className="text-[9px] font-black uppercase tracking-widest text-warning/60 font-mono">command_schema.json</span>
                    <button onClick=${() => handleCopy(JSON.stringify(command, null, 2), 'raw-json')} className=${`text-[9px] font-black uppercase tracking-widest transition-colors ${copyStatus['raw-json'] ? 'text-success' : 'text-warning/40 hover:text-warning'}`}>${copyStatus['raw-json'] ? 'Copiado!' : 'Copiar JSON'}</button>
                  </div>
                  <pre className="p-6 sm:p-8 font-mono text-[9px] sm:text-[11px] text-warning/70 overflow-x-auto max-h-[400px] scrollbar-thin scrollbar-thumb-warning/20">
                    ${JSON.stringify(command, null, 2)}
                  </pre
                  >
                </div>
              </div>
            </section>
          `}

          <div className="pt-8 sm:pt-12 pb-20 text-center">
            <button onClick=${onClose} className="group relative inline-flex items-center justify-center w-full sm:w-auto">
              <div className="absolute inset-0 bg-primary/20 blur-2xl group-hover:bg-primary/40 transition-colors rounded-2xl"></div>
              <div className="relative bg-primary text-primary-content px-12 py-5 rounded-2xl font-black text-xs uppercase tracking-[0.3em] shadow-2xl hover:scale-105 active:scale-95 transition-all w-full sm:w-auto text-center">Voltar ao Catálogo</div>
            </button>
          </div>
        </div>
      </main>
    </div>
  `;
};

const App = () => {
  const [catalog, setCatalog] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeModule, setActiveModule] = useState('all');
  const [selectedCommand, setSelectedCommand] = useState(null);
  const [devMode, setDevMode] = useState(false);
  const carouselRef = React.useRef(null);
  const searchInputRef = React.useRef(null);

  const scrollCarousel = (direction) => {
    if (!carouselRef.current) return;
    const scrollAmount = 300;
    carouselRef.current.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  // Keyboard shortcut for search
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === '/' && document.activeElement !== searchInputRef.current) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    fetch(CATALOG_URL)
      .then((r) => r.json())
      .then((data) => {
        setCatalog(data);
        setLoading(false);

        const hash = window.location.hash;
        if (hash.startsWith('#/cmd/')) {
          const cmdName = hash.replace('#/cmd/', '');
          const allCmds = data.categories.flatMap((c) => c.commands.map((cmd) => ({ ...cmd, cat: c })));
          const found = allCmds.find((c) => c.name === cmdName);
          if (found) {
            setSelectedCommand({ ...found, category_icon: found.cat.icon, category_label: found.cat.label });
          }
        }
      })
      .catch((err) => {
        console.error('Failed to load commands', err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const handleHash = () => {
      if (!catalog) return;
      const hash = window.location.hash;
      if (hash.startsWith('#/cmd/')) {
        const cmdName = hash.replace('#/cmd/', '');
        const allCmds = catalog.categories.flatMap((c) => c.commands.map((cmd) => ({ ...cmd, cat: c })));
        const found = allCmds.find((c) => c.name === cmdName);
        if (found) {
          setSelectedCommand({ ...found, category_icon: found.cat.icon, category_label: found.cat.label });
        }
      } else if (hash === '' || hash === '#/') {
        setSelectedCommand(null);
      }
    };
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [catalog]);

  const openDetails = (cmd, cat) => {
    const commandWithCat = { ...cmd, category_icon: cat.icon, category_label: cat.label };
    setSelectedCommand(commandWithCat);
    window.location.hash = `#/cmd/${cmd.name}`;
  };

  const closeDetails = () => {
    setSelectedCommand(null);
    window.location.hash = '/';
  };

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
            { threshold: 0.05, rootMargin: '0px 0px -50px 0px' },
          )
        : null;

    document.querySelectorAll('[data-reveal]').forEach((el, i) => {
      el.style.setProperty('--reveal-delay', `${Math.min(i * 20, 200)}ms`);
      if (observer) {
        observer.observe(el);
      } else {
        el.classList.add('is-visible');
      }
    });

    return () => {
      if (observer) observer.disconnect();
    };
  }, [catalog, search, activeModule, selectedCommand]);

  const filteredCategories = useMemo(() => {
    if (!catalog) return [];
    const query = search.toLowerCase().trim();

    return catalog.categories
      .map((cat) => {
        if (activeModule !== 'all' && cat.key !== activeModule) return null;

        const commands = cat.commands.filter((cmd) => cmd.name.toLowerCase().includes(query) || cmd.descricao.toLowerCase().includes(query) || (cmd.aliases && cmd.aliases.some((a) => a.toLowerCase().includes(query))) || (cmd.discovery?.keywords && cmd.discovery.keywords.some((k) => k.toLowerCase().includes(query))));

        if (!commands.length) return null;
        return { ...cat, commands };
      })
      .filter(Boolean);
  }, [catalog, search, activeModule]);

  const modules = useMemo(() => {
    if (!catalog) return [];
    return catalog.categories.map((cat) => ({
      id: cat.key,
      label: cat.label,
      count: cat.commands.length,
    }));
  }, [catalog]);

  if (selectedCommand) {
    return html`<${CommandDetailsPage} command=${selectedCommand} onClose=${closeDetails} devMode=${devMode} />`;
  }

  return html`
    <div className="min-h-screen bg-base-100 font-sans selection:bg-primary selection:text-primary-content overflow-x-hidden">
      <header className="sticky top-0 z-50 border-b border-base-200 bg-base-100/80 backdrop-blur-xl">
        <div className="container mx-auto px-4">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex-1">
              <a href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
                <img src="/assets/images/brand-logo-128.webp" className="w-8 h-8 rounded-xl shadow-sm" alt="Logo" />
                <span className="text-base sm:text-lg font-black tracking-tight">OmniZap<span className="text-primary">.</span></span>
              </a>
            </div>
            <div className="flex items-center gap-3">
              <a href="/login/" className="btn btn-primary btn-sm h-9 min-h-0 rounded-xl font-bold px-4 text-[10px] uppercase"> Adicionar Bot </a>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12 lg:py-20">
        <section className="text-center space-y-6 mb-12">
          <div data-reveal="fade-up" className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-widest">Biblioteca V3.5</div>
          <h1 data-reveal="fade-up" className="text-4xl lg:text-6xl font-black tracking-tight text-balance leading-[1.1]">
            Comandos de <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-secondary text-nowrap">Alta Performance</span>.
          </h1>

          <div data-reveal="fade-up" className="max-w-4xl mx-auto space-y-8 pt-4">
            <div className="flex flex-col lg:flex-row gap-4 items-center">
              <div className="relative group flex-1 w-full">
                <div className="absolute inset-y-0 left-5 flex items-center pointer-events-none text-base-content/30 group-focus-within:text-primary transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                </div>
                <input ref=${searchInputRef} type="text" placeholder="Pressione '/' para buscar..." className="w-full bg-base-200/50 border border-base-300 focus:border-primary/50 focus:bg-base-200 outline-none rounded-3xl h-14 lg:h-16 pl-14 pr-12 font-medium transition-all text-sm lg:text-base shadow-xl shadow-black/5" value=${search} onInput=${(e) => setSearch(e.target.value)} />
                ${search &&
                html`
                  <button onClick=${() => setSearch('')} className="absolute right-4 top-1/2 -translate-y-1/2 btn btn-ghost btn-circle btn-xs opacity-50 hover:opacity-100">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                `}
              </div>

              <div className="flex items-center gap-3 bg-base-200/50 px-4 py-2 rounded-2xl border border-base-300 self-stretch lg:self-auto justify-between lg:justify-center h-14 lg:h-16 shadow-xl shadow-black/5">
                <div className="flex flex-col -gap-1 text-left">
                  <span className="text-[10px] font-black uppercase tracking-widest text-primary">Modo Dev</span>
                  <span className="text-[8px] font-bold opacity-30 uppercase tracking-tighter">Specs Técnicas</span>
                </div>
                <input type="checkbox" className="toggle toggle-primary toggle-sm" checked=${devMode} onChange=${(e) => setDevMode(e.target.checked)} />
              </div>
            </div>

            <div className="relative group/carousel max-w-5xl mx-auto">
              <button onClick=${() => scrollCarousel('left')} className="hidden lg:flex absolute -left-12 top-1/2 -translate-y-1/2 w-10 h-10 items-center justify-center rounded-xl bg-base-200 border border-base-300 text-base-content/50 hover:text-primary hover:border-primary/30 transition-all z-10 shadow-xl">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M15 19l-7-7 7-7" /></svg>
              </button>

              <div ref=${carouselRef} className="w-full overflow-x-auto no-scrollbar snap-x snap-mandatory scroll-smooth">
                <div className="flex flex-nowrap gap-2 pb-4 px-4 w-fit mx-auto">
                  <button onClick=${() => setActiveModule('all')} className=${`snap-start px-5 py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all border shrink-0 flex items-center gap-2 ${activeModule === 'all' ? 'bg-primary text-primary-content border-primary shadow-lg shadow-primary/20' : 'bg-base-200/50 border-base-300 text-base-content/40 hover:border-primary/30'}`}>
                    Todos
                    <span className=${`px-1.5 py-0.5 rounded-md text-[8px] ${activeModule === 'all' ? 'bg-primary-content/20' : 'bg-base-300'}`}> ${catalog?.categories.reduce((acc, c) => acc + c.commands.length, 0)} </span>
                  </button>
                  ${modules.map(
                    (mod) => html`
                      <button key=${mod.id} onClick=${() => setActiveModule(mod.id)} className=${`snap-start px-5 py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all border shrink-0 flex items-center gap-2 ${activeModule === mod.id ? 'bg-primary text-primary-content border-primary shadow-lg shadow-primary/20' : 'bg-base-200/50 border-base-300 text-base-content/40 hover:border-primary/30'}`}>
                        ${mod.label}
                        <span className=${`px-1.5 py-0.5 rounded-md text-[8px] ${activeModule === mod.id ? 'bg-primary-content/20' : 'bg-base-300'}`}> ${mod.count} </span>
                      </button>
                    `,
                  )}
                </div>
              </div>

              <button onClick=${() => scrollCarousel('right')} className="hidden lg:flex absolute -right-12 top-1/2 -translate-y-1/2 w-10 h-10 items-center justify-center rounded-xl bg-base-200 border border-base-300 text-base-content/50 hover:text-primary hover:border-primary/30 transition-all z-10 shadow-xl">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
          </div>
        </section>

        ${loading
          ? html`
              <div className="flex flex-col items-center justify-center py-20 gap-4 opacity-30">
                <span className="loading loading-ring loading-lg text-primary"></span>
                <span className="text-[10px] font-black uppercase tracking-widest">Carregando Biblioteca</span>
              </div>
            `
          : html`
              <div className="space-y-16">
                ${filteredCategories.length === 0
                  ? html`
                      <div className="text-center py-24 glass-card rounded-[3rem]">
                        <div className="text-4xl mb-4 opacity-20">🔍</div>
                        <p className="text-base-content/30 font-bold">Nenhum comando encontrado.</p>
                        <button
                          onClick=${() => {
                            setSearch('');
                            setActiveModule('all');
                          }}
                          className="btn btn-primary btn-sm mt-4 rounded-xl"
                        >
                          Limpar Filtros
                        </button>
                      </div>
                    `
                  : filteredCategories.map(
                      (cat) => html`
                        <div key=${cat.module} className="space-y-8">
                          <div data-reveal="fade-right" className="flex items-center gap-4 px-2">
                            <span className="text-2xl">${cat.icon || '🧩'}</span>
                            <h2 className="text-xl font-black uppercase tracking-widest text-base-content/80">${cat.label}</h2>
                            <div className="flex-1 h-px bg-base-content/5"></div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 sm:gap-6">
                            ${cat.commands.map(
                              (cmd) => html`
                                <article key=${cmd.key} data-reveal="fade-up" onClick=${() => openDetails(cmd, cat)} className="glass-card group relative rounded-[2rem] p-6 flex flex-col gap-5 hover:scale-[1.02] hover:-translate-y-1 hover:border-primary/40 transition-all duration-500 cursor-pointer overflow-hidden active:scale-95">
                                  <div className="absolute -right-4 -top-4 text-6xl opacity-[0.03] group-hover:opacity-[0.08] group-hover:scale-125 transition-all duration-700 pointer-events-none select-none">${cat.icon || '🧩'}</div>

                                  <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

                                  <div className="relative space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex items-center gap-2">
                                        <span className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse"></span>
                                        <code className="text-xl font-black tracking-tighter text-base-content group-hover:text-primary transition-colors">/${cmd.name}</code>
                                      </div>
                                      ${cmd.premium && html` <span className="badge badge-warning badge-xs font-black text-[8px] px-2 py-1.5 h-auto shadow-lg shadow-warning/20">PREMIUM</span> `}
                                    </div>
                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-primary/40">${cat.label}</p>
                                  </div>

                                  <div className="relative">
                                    <p className="text-xs text-base-content/50 font-medium leading-relaxed line-clamp-2 min-h-[2.5rem]">${cmd.descricao}</p>
                                  </div>

                                  <div className="relative flex flex-wrap gap-2">${cmd.requirements?.admin && html` <span className="flex items-center gap-1 bg-base-300/50 px-2 py-1 rounded-lg text-[9px] font-bold text-base-content/60 border border-base-300 group-hover:border-primary/20 transition-colors" title="Requer Admin"> <span>👮</span> Admin </span> `} ${cmd.requirements?.group && html` <span className="flex items-center gap-1 bg-base-300/50 px-2 py-1 rounded-lg text-[9px] font-bold text-base-content/60 border border-base-300 group-hover:border-primary/20 transition-colors" title="Requer Grupo"> <span>👥</span> Grupo </span> `} ${cmd.requirements?.nsfw && html` <span className="flex items-center gap-1 bg-error/10 px-2 py-1 rounded-lg text-[9px] font-bold text-error border border-error/20" title="Conteúdo Adulto"> <span>🔞</span> NSFW </span> `}</div>

                                  <div className="relative pt-4 mt-auto border-t border-base-content/5 flex items-center justify-between group/btn">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-base-content/20 group-hover:text-primary/50 transition-colors">Documentação</span>
                                    <div className="w-8 h-8 rounded-full bg-base-200 flex items-center justify-center group-hover:bg-primary group-hover:text-primary-content transition-all transform group-hover:rotate-45">
                                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 12h14M12 5l7 7-7 7" /></svg>
                                    </div>
                                  </div>
                                </article>
                              `,
                            )}
                          </div>
                        </div>
                      `,
                    )}
              </div>
            `}
      </main>

      <footer className="mt-20 py-16 border-t border-base-200 bg-base-200/20">
        <div className="container mx-auto px-4 text-center">
          <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-base-content/20">© 2026 OMNIZAP · COMMANDS LIBRARY V3.5</p>
        </div>
      </footer>
    </div>
  `;
};

const rootElement = document.getElementById('commands-react-root');
if (rootElement) {
  createRoot(rootElement).render(html`<${App} />`);
}
