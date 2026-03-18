import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);

const DEFAULT_API_BASE_PATH = '/api';
const DEFAULT_LOGIN_PATH = '/login';
const DEFAULT_PANEL_PATH = '/user';
const DEFAULT_PASSWORD_RESET_WEB_PATH = '/user/password-reset';

const PASSWORD_RECOVERY_SESSION_QUERY_KEYS = Object.freeze(['session_token', 'recovery_session_token', 'password_recovery_session', 'session', 'token']);

const normalizeRoutePath = (value, fallback) => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (/^\/\//.test(raw)) return fallback;
  return raw;
};

const normalizeSessionToken = (value) =>
  String(value || '')
    .trim()
    .slice(0, 4096);

const normalizeCode = (value) =>
  String(value || '')
    .replace(/\D+/g, '')
    .slice(0, 6);

const readSessionTokenFromLocation = () => {
  const url = new URL(window.location.href);
  for (const key of PASSWORD_RECOVERY_SESSION_QUERY_KEYS) {
    const token = normalizeSessionToken(url.searchParams.get(key));
    if (token) return token;
  }
  return '';
};

const persistSessionTokenInUrl = (sessionToken) => {
  const normalizedToken = normalizeSessionToken(sessionToken);
  if (!normalizedToken) return;
  const url = new URL(window.location.href);
  const current = normalizeSessionToken(url.searchParams.get('session_token'));
  if (current === normalizedToken) return;
  url.searchParams.set('session_token', normalizedToken);
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
};

const formatDateTime = (value) => {
  const parsedMs = Date.parse(String(value || ''));
  if (!Number.isFinite(parsedMs)) return 'n/d';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(parsedMs));
};

const buildLoginRedirectPath = (loginPath, nextPath) => {
  const safeLoginPath = normalizeRoutePath(loginPath, DEFAULT_LOGIN_PATH);
  const safeNextPath = normalizeRoutePath(nextPath, DEFAULT_PANEL_PATH);
  const loginUrl = new URL(safeLoginPath, window.location.origin);
  loginUrl.searchParams.set('next', safeNextPath);
  return `${loginUrl.pathname}${loginUrl.search}`;
};

const resolvePasswordResetConfig = (rootElement) => {
  const apiBasePath = String(rootElement?.dataset?.apiBasePath || DEFAULT_API_BASE_PATH).trim() || DEFAULT_API_BASE_PATH;
  const loginPath = normalizeRoutePath(rootElement?.dataset?.loginPath, DEFAULT_LOGIN_PATH);
  const panelPath = normalizeRoutePath(rootElement?.dataset?.panelPath, DEFAULT_PANEL_PATH);
  const passwordResetWebPath = normalizeRoutePath(rootElement?.dataset?.passwordResetWebPath, DEFAULT_PASSWORD_RESET_WEB_PATH);
  return {
    apiBasePath,
    loginPath,
    panelPath,
    passwordResetWebPath,
  };
};

const createPasswordResetApi = (apiBasePath) => {
  const sessionPath = `${apiBasePath}/auth/password/recovery/session`;
  const sessionRequestPath = `${sessionPath}/request`;
  const sessionVerifyPath = `${sessionPath}/verify`;

  const fetchJson = async (url, init = {}, { sessionToken = '' } = {}) => {
    const headers = {
      ...(init?.headers || {}),
    };
    const normalizedSessionToken = normalizeSessionToken(sessionToken);
    if (normalizedSessionToken) {
      headers['x-password-recovery-session'] = normalizedSessionToken;
    }

    const response = await fetch(url, {
      credentials: 'include',
      ...init,
      headers,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(payload?.error || `Falha HTTP ${response.status}`);
      error.statusCode = response.status;
      error.code = payload?.code || null;
      error.details = payload?.details || null;
      throw error;
    }
    return payload || {};
  };

  return {
    createSession: () => fetchJson(sessionPath, { method: 'POST' }),
    getSessionStatus: (sessionToken) => fetchJson(sessionPath, { method: 'GET' }, { sessionToken }),
    requestCode: (sessionToken) =>
      fetchJson(
        sessionRequestPath,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({}),
        },
        { sessionToken },
      ),
    verifyCode: (sessionToken, { code = '', password = '' } = {}) =>
      fetchJson(
        sessionVerifyPath,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            code: normalizeCode(code),
            password: String(password || ''),
          }),
        },
        { sessionToken },
      ),
  };
};

const PasswordResetApp = ({ config }) => {
  const api = useMemo(() => createPasswordResetApi(config.apiBasePath), [config.apiBasePath]);

  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [sessionToken, setSessionToken] = useState('');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [requestBusy, setRequestBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      setIsBootstrapping(true);
      setRequiresLogin(false);
      setErrorMessage('');
      setSuccessMessage('');

      let resolvedSessionToken = readSessionTokenFromLocation();
      if (!resolvedSessionToken) {
        try {
          const createPayload = await api.createSession();
          const sessionData = createPayload?.data || {};
          resolvedSessionToken = normalizeSessionToken(sessionData?.session_token);
          if (!resolvedSessionToken) {
            throw new Error('Sessão de redefinição não foi criada corretamente.');
          }
          if (!active) return;
          persistSessionTokenInUrl(resolvedSessionToken);
          setMaskedEmail(String(sessionData?.masked_email || '').trim());
          setExpiresAt(String(sessionData?.expires_at || '').trim());
        } catch (error) {
          if (!active) return;
          setRequiresLogin(Number(error?.statusCode || 0) === 401);
          setErrorMessage(error?.message || 'Não foi possível iniciar a sessão de redefinição.');
          setIsBootstrapping(false);
          return;
        }
      }

      try {
        const statusPayload = await api.getSessionStatus(resolvedSessionToken);
        const statusData = statusPayload?.data || {};
        if (!active) return;
        setSessionToken(resolvedSessionToken);
        setMaskedEmail(String(statusData?.masked_email || '').trim());
        setExpiresAt(String(statusData?.expires_at || '').trim());
        setErrorMessage('');
      } catch (error) {
        if (!active) return;
        setErrorMessage(error?.message || 'Sessão de redefinição inválida ou expirada.');
        setRequiresLogin(Number(error?.statusCode || 0) === 401);
      } finally {
        if (active) {
          setIsBootstrapping(false);
        }
      }
    };

    void bootstrap();
    return () => {
      active = false;
    };
  }, [api, bootstrapAttempt]);

  const handleSendCode = async () => {
    if (!sessionToken || requestBusy) return;
    setErrorMessage('');
    setSuccessMessage('');
    setRequestBusy(true);

    try {
      const payload = await api.requestCode(sessionToken);
      const data = payload?.data || {};
      const emailHint = String(data?.masked_email || maskedEmail || '').trim();
      const cooldownActive = Boolean(data?.cooldown_active);
      const expiresInSeconds = Number(data?.expires_in_seconds || 0);
      const expiresInMinutes = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? Math.max(1, Math.ceil(expiresInSeconds / 60)) : null;

      let message = emailHint ? `Código enviado para ${emailHint}.` : 'Código de verificação enviado.';
      if (cooldownActive) {
        message = 'Já existe um código ativo. Use o código mais recente enviado por e-mail.';
      } else if (expiresInMinutes) {
        message = `${message} Validade aproximada: ${expiresInMinutes} minuto(s).`;
      }
      setSuccessMessage(message);
    } catch (error) {
      setErrorMessage(error?.message || 'Não foi possível enviar o código de verificação.');
    } finally {
      setRequestBusy(false);
    }
  };

  const handleVerify = async (event) => {
    event.preventDefault();
    if (!sessionToken || verifyBusy) return;

    const normalizedCode = normalizeCode(code);
    const safePassword = String(password || '');
    const safePasswordConfirm = String(passwordConfirm || '');

    if (!/^\d{6}$/.test(normalizedCode)) {
      setErrorMessage('Informe o código de 6 dígitos enviado por e-mail.');
      setSuccessMessage('');
      return;
    }

    if (safePassword.trim().length < 8) {
      setErrorMessage('Use uma senha com pelo menos 8 caracteres.');
      setSuccessMessage('');
      return;
    }

    if (safePassword !== safePasswordConfirm) {
      setErrorMessage('A confirmação da senha não confere.');
      setSuccessMessage('');
      return;
    }

    setErrorMessage('');
    setSuccessMessage('');
    setVerifyBusy(true);

    try {
      const payload = await api.verifyCode(sessionToken, {
        code: normalizedCode,
        password: safePassword,
      });
      const data = payload?.data || {};
      const isAuthenticated = Boolean(data?.session?.authenticated);
      setSuccessMessage('Senha atualizada com sucesso. Redirecionando...');
      setPassword('');
      setPasswordConfirm('');
      setCode('');

      const destination = isAuthenticated ? config.panelPath : buildLoginRedirectPath(config.loginPath, config.panelPath);
      window.setTimeout(() => {
        window.location.assign(destination);
      }, 900);
    } catch (error) {
      setErrorMessage(error?.message || 'Falha ao validar o código.');
    } finally {
      setVerifyBusy(false);
    }
  };

  const loginRedirectPath = useMemo(() => buildLoginRedirectPath(config.loginPath, config.passwordResetWebPath), [config.loginPath, config.passwordResetWebPath]);

  return html`
    <div className="min-h-screen bg-base-100 font-sans selection:bg-primary selection:text-primary-content">
      <header className="sticky top-0 z-40 border-b border-base-200 bg-base-100/80 backdrop-blur-xl">
        <div className="container mx-auto px-4">
          <div className="flex h-16 items-center justify-between gap-4">
            <a href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
              <img src="/assets/images/brand-logo-128.webp" className="w-8 h-8 rounded-xl shadow-sm" alt="Logo" />
              <span className="text-base sm:text-lg font-black tracking-tight">OmniZap<span className="text-primary">.</span></span>
            </a>
            <a href=${config.panelPath} className="btn btn-ghost btn-sm h-9 min-h-0 rounded-xl border border-base-300 hover:border-primary transition-all px-3">
              <span className="text-[10px] sm:text-xs font-bold uppercase tracking-wider">Voltar ao Painel</span>
            </a>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12 lg:py-20 flex flex-col items-center">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center space-y-4">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold uppercase tracking-widest">Segurança da Conta</div>
            <h1 className="text-4xl font-black tracking-tight text-balance">Redefinir <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-secondary">Senha</span></h1>
            <p className="text-base-content/60 leading-relaxed">Solicite um código por e-mail e confirme sua nova senha com validação segura.</p>
          </div>

          <div className="glass-card rounded-[2.5rem] p-8 space-y-6 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full blur-3xl -mr-16 -mt-16"></div>

            ${isBootstrapping
              ? html`
                  <div className="relative z-10 py-8 text-center space-y-4">
                    <span className="loading loading-ring loading-lg text-primary"></span>
                    <p className="text-sm text-base-content/60">Preparando sessão de redefinição...</p>
                  </div>
                `
              : html`
                  <div className="relative z-10 space-y-6">
                    ${sessionToken
                      ? html`
                          <div className="rounded-2xl border border-base-300 bg-base-200/50 p-4 space-y-2">
                            <p className="text-[10px] font-bold uppercase tracking-widest text-base-content/40">Sessão ativa</p>
                            <p className="text-sm text-base-content/80">E-mail de destino: <b>${maskedEmail || 'não informado'}</b></p>
                            <p className="text-xs text-base-content/55">Expira em: <b>${formatDateTime(expiresAt)}</b></p>
                          </div>

                          <button type="button" className="btn btn-outline btn-primary btn-block rounded-2xl h-12 font-bold" disabled=${requestBusy || verifyBusy} onClick=${handleSendCode}>${requestBusy ? 'Enviando código...' : 'Enviar código por e-mail'}</button>

                          <form className="space-y-4" onSubmit=${handleVerify}>
                            <div className="form-control gap-2">
                              <label className="label py-0">
                                <span className="label-text text-[11px] font-bold uppercase tracking-widest text-base-content/50">Código de verificação</span>
                              </label>
                              <input type="text" inputmode="numeric" maxlength="6" value=${code} onInput=${(event) => setCode(normalizeCode(event.target.value))} placeholder="000000" className="input input-bordered h-12 rounded-2xl font-mono tracking-[0.3em] text-center text-lg" />
                            </div>
                            <div className="form-control gap-2">
                              <label className="label py-0">
                                <span className="label-text text-[11px] font-bold uppercase tracking-widest text-base-content/50">Nova senha</span>
                              </label>
                              <input type="password" autocomplete="new-password" value=${password} onInput=${(event) => setPassword(String(event.target.value || ''))} placeholder="Pelo menos 8 caracteres" className="input input-bordered h-12 rounded-2xl" />
                            </div>
                            <div className="form-control gap-2">
                              <label className="label py-0">
                                <span className="label-text text-[11px] font-bold uppercase tracking-widest text-base-content/50">Confirmar senha</span>
                              </label>
                              <input type="password" autocomplete="new-password" value=${passwordConfirm} onInput=${(event) => setPasswordConfirm(String(event.target.value || ''))} placeholder="Repita a nova senha" className="input input-bordered h-12 rounded-2xl" />
                            </div>
                            <button type="submit" className="btn btn-primary btn-block h-12 rounded-2xl font-black uppercase tracking-widest text-xs" disabled=${verifyBusy || requestBusy}>${verifyBusy ? 'Validando...' : 'Confirmar nova senha'}</button>
                          </form>
                        `
                      : html`
                          <div className="alert alert-warning rounded-2xl bg-warning/15 border border-warning/30 text-warning-content text-sm">
                            <span>Não foi possível carregar uma sessão de redefinição válida.</span>
                          </div>
                          <button type="button" className="btn btn-outline btn-block rounded-2xl" onClick=${() => setBootstrapAttempt((value) => value + 1)}>Tentar novamente</button>
                        `}
                    ${errorMessage
                      ? html`
                          <div className="alert alert-error rounded-2xl bg-error/20 border-none text-error-content text-sm">
                            <span>${errorMessage}</span>
                          </div>
                        `
                      : null}
                    ${successMessage
                      ? html`
                          <div className="alert alert-success rounded-2xl bg-success/20 border-none text-success-content text-sm">
                            <span>${successMessage}</span>
                          </div>
                        `
                      : null}
                    ${requiresLogin ? html` <a href=${loginRedirectPath} className="btn btn-ghost btn-block rounded-2xl border border-base-300"> Entrar para continuar </a> ` : null}
                  </div>
                `}
          </div>
        </div>
      </main>
    </div>
  `;
};

const rootElement = document.getElementById('user-password-reset-root');
if (rootElement) {
  const config = resolvePasswordResetConfig(rootElement);
  createRoot(rootElement).render(html`<${PasswordResetApp} config=${config} />`);
}
