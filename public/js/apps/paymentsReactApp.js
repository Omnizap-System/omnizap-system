import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);

const GOOGLE_AUTH_CACHE_KEY = 'omnizap_google_web_auth_cache_v1';
const GOOGLE_AUTH_CACHE_MAX_STALE_MS = 8 * 24 * 60 * 60 * 1000;
const DEFAULT_HOME_BOOTSTRAP_ENDPOINT = '/api/home-bootstrap';
const DEFAULT_LOGIN_PATH = '/login/';
const DEFAULT_PAYMENTS_API_BASE_PATH = '/api/payments';
const DEFAULT_PLAN_NAME = 'Plano Premium';
const DEFAULT_PLAN_PRICE = 'Assinatura recorrente';

const normalizeDigits = (value) =>
  String(value || '')
    .replace(/\D+/g, '')
    .slice(0, 20);

const normalizeGoogleAuthState = (value) => {
  const user = value?.user && typeof value.user === 'object' ? value.user : null;
  const sub = String(user?.sub || '').trim();
  if (!sub) return null;

  return {
    user: {
      sub,
      email: String(user?.email || '').trim(),
      name: String(user?.name || '').trim(),
      picture: String(user?.picture || '').trim(),
    },
    ownerPhone: normalizeDigits(value?.ownerPhone || ''),
    ownerJid: String(value?.ownerJid || '').trim(),
    expiresAt: String(value?.expiresAt || '').trim(),
  };
};

const readGoogleAuthCache = () => {
  try {
    const raw = localStorage.getItem(GOOGLE_AUTH_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const savedAt = Number(parsed?.savedAt || 0);
    if (savedAt && Date.now() - savedAt > GOOGLE_AUTH_CACHE_MAX_STALE_MS) {
      localStorage.removeItem(GOOGLE_AUTH_CACHE_KEY);
      return null;
    }

    const normalized = normalizeGoogleAuthState(parsed?.auth || null);
    if (!normalized?.user?.sub) {
      localStorage.removeItem(GOOGLE_AUTH_CACHE_KEY);
      return null;
    }

    if (normalized.expiresAt) {
      const expiresAt = Number(new Date(normalized.expiresAt));
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        localStorage.removeItem(GOOGLE_AUTH_CACHE_KEY);
        return null;
      }
    }

    return normalized;
  } catch {
    return null;
  }
};

const writeGoogleAuthCache = (authState) => {
  try {
    const normalized = normalizeGoogleAuthState(authState);
    if (!normalized?.user?.sub) return;

    localStorage.setItem(
      GOOGLE_AUTH_CACHE_KEY,
      JSON.stringify({
        auth: normalized,
        savedAt: Date.now(),
      }),
    );
  } catch {
    // ignore storage errors
  }
};

const clearGoogleAuthCache = () => {
  try {
    localStorage.removeItem(GOOGLE_AUTH_CACHE_KEY);
  } catch {
    // ignore storage errors
  }
};

const resolveOwnerPhone = ({ ownerPhone = '', ownerJid = '' } = {}) => {
  const fromPhone = normalizeDigits(ownerPhone);
  if (fromPhone.length >= 10) return fromPhone;

  return normalizeDigits(String(ownerJid || '').split('@')[0]);
};

const buildLoginRedirectUrl = (loginPath) => {
  const nextPath = `${window.location.pathname || '/pagamentos/'}${window.location.search || ''}`;
  const loginUrl = new URL(loginPath || DEFAULT_LOGIN_PATH, window.location.origin);
  loginUrl.searchParams.set('next', nextPath);
  return `${loginUrl.pathname}${loginUrl.search}`;
};

const resolveConfig = (rootElement) => {
  const dataset = rootElement?.dataset || {};

  return {
    loginPath: String(dataset.loginPath || DEFAULT_LOGIN_PATH).trim() || DEFAULT_LOGIN_PATH,
    homeBootstrapPath:
      String(dataset.homeBootstrapPath || DEFAULT_HOME_BOOTSTRAP_ENDPOINT).trim() ||
      DEFAULT_HOME_BOOTSTRAP_ENDPOINT,
    paymentsApiBasePath:
      String(dataset.paymentsApiBasePath || DEFAULT_PAYMENTS_API_BASE_PATH).trim() ||
      DEFAULT_PAYMENTS_API_BASE_PATH,
  };
};

const PaymentsReactApp = ({ config }) => {
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState('');
  const [planName, setPlanName] = useState(DEFAULT_PLAN_NAME);
  const [planPriceLabel, setPlanPriceLabel] = useState(DEFAULT_PLAN_PRICE);
  const [paymentsEnabled, setPaymentsEnabled] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [loadingCheckout, setLoadingCheckout] = useState(false);

  const [formValues, setFormValues] = useState({
    name: '',
    email: '',
    whatsapp: '',
  });

  const [lockedFields, setLockedFields] = useState({
    name: false,
    email: false,
    whatsapp: false,
  });

  const setStatus = useCallback((message, type = '') => {
    setStatusMessage(String(message || ''));
    setStatusType(String(type || ''));
  }, []);

  const fillFormWithUserData = useCallback(({ name = '', email = '', ownerPhone = '', ownerJid = '' } = {}) => {
    const normalizedName = String(name || '').trim();
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const normalizedPhone = resolveOwnerPhone({ ownerPhone, ownerJid });

    setFormValues((previous) => ({
      ...previous,
      name: normalizedName || previous.name,
      email: normalizedEmail || previous.email,
      whatsapp: normalizedPhone || previous.whatsapp,
    }));

    setLockedFields({
      name: Boolean(normalizedName),
      email: Boolean(normalizedEmail),
      whatsapp: Boolean(normalizedPhone),
    });
  }, []);

  const redirectToLogin = useCallback(() => {
    window.location.replace(buildLoginRedirectUrl(config.loginPath));
  }, [config.loginPath]);

  const loadAuthenticatedUser = useCallback(async () => {
    const cachedAuth = readGoogleAuthCache();
    if (cachedAuth?.user?.sub) {
      fillFormWithUserData({
        name: cachedAuth.user?.name,
        email: cachedAuth.user?.email,
        ownerPhone: cachedAuth.ownerPhone,
        ownerJid: cachedAuth.ownerJid,
      });
    }

    let response = null;
    try {
      response = await fetch(config.homeBootstrapPath, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
    } catch {
      if (cachedAuth?.user?.sub) {
        setAuthenticated(true);
        return true;
      }
      redirectToLogin();
      return false;
    }

    const payload = await response.json().catch(() => ({}));
    const session = payload?.data?.session || null;
    const isAuthenticated = Boolean(response.ok && session?.authenticated && session?.user?.sub);

    if (!isAuthenticated) {
      clearGoogleAuthCache();
      redirectToLogin();
      return false;
    }

    const authState = {
      user: {
        sub: String(session?.user?.sub || ''),
        email: String(session?.user?.email || ''),
        name: String(session?.user?.name || ''),
        picture: String(session?.user?.picture || ''),
      },
      ownerPhone: String(session?.owner_phone || ''),
      ownerJid: String(session?.owner_jid || ''),
      expiresAt: String(session?.expires_at || ''),
    };

    writeGoogleAuthCache(authState);
    fillFormWithUserData(authState);
    setAuthenticated(true);
    return true;
  }, [config.homeBootstrapPath, fillFormWithUserData, redirectToLogin]);

  const loadPublicConfig = useCallback(async () => {
    try {
      const response = await fetch(`${config.paymentsApiBasePath}/config`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload || payload.ok !== true) return true;

      if (payload.plan_name) setPlanName(String(payload.plan_name));
      if (payload.plan_price_label) setPlanPriceLabel(String(payload.plan_price_label));

      if (payload.enabled === false) {
        setPaymentsEnabled(false);
        setStatus('Pagamentos estao temporariamente indisponiveis.', 'error');
        return false;
      }

      return true;
    } catch {
      return true;
    }
  }, [config.paymentsApiBasePath, setStatus]);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      setStatus('Validando sua sessao...', 'success');
      const [configEnabled] = await Promise.all([loadPublicConfig(), loadAuthenticatedUser()]);
      if (!active) return;
      if (configEnabled) {
        setStatus('', '');
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, [loadAuthenticatedUser, loadPublicConfig, setStatus]);

  const onInputChange = useCallback((field) => (event) => {
    const value = String(event?.target?.value || '');
    setFormValues((previous) => ({ ...previous, [field]: value }));
  }, []);

  const onSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      setStatus('', '');

      const whatsapp = String(formValues.whatsapp || '').trim();
      const email = String(formValues.email || '').trim();
      const name = String(formValues.name || '').trim();

      if (!whatsapp) {
        setStatus('Informe seu WhatsApp para continuar.', 'error');
        return;
      }

      setLoadingCheckout(true);
      setStatus('Preparando checkout seguro...', 'success');

      try {
        const response = await fetch(`${config.paymentsApiBasePath}/checkout-session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({ whatsapp, email, name }),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || 'Nao foi possivel iniciar o checkout.');
        }

        if (!payload?.checkout_url) {
          throw new Error('Checkout criado sem URL de redirecionamento.');
        }

        window.location.href = payload.checkout_url;
      } catch (error) {
        setStatus(error?.message || 'Falha ao iniciar checkout.', 'error');
        setLoadingCheckout(false);
      }
    },
    [config.paymentsApiBasePath, formValues.email, formValues.name, formValues.whatsapp, setStatus],
  );

  const submitDisabled = useMemo(
    () => loadingCheckout || !authenticated || !paymentsEnabled,
    [authenticated, loadingCheckout, paymentsEnabled],
  );

  const statusClassName = useMemo(() => {
    const list = ['payments-status'];
    if (statusType) list.push(statusType);
    return list.join(' ');
  }, [statusType]);

  return html`
    <main className="payments-page">
      <section className="payments-hero">
        <span className="payments-eyebrow">Pagamento Automatico Stripe</span>
        <h1>Ative o Premium em minutos</h1>
        <p>
          Preencha seu WhatsApp e siga para o checkout seguro. Assim que o
          pagamento confirmar no webhook, seu acesso Premium e liberado
          automaticamente.
        </p>
      </section>

      <section className="payments-layout">
        <article className="payments-card payments-checkout">
          <form onSubmit=${onSubmit} noValidate=${true}>
            <div className="payments-row">
              <label htmlFor="checkout-name">Nome</label>
              <input
                id="checkout-name"
                name="name"
                type="text"
                maxLength="120"
                autoComplete="name"
                placeholder="Seu nome"
                value=${formValues.name}
                onChange=${onInputChange('name')}
                readOnly=${lockedFields.name}
                title=${lockedFields.name
                  ? 'Campo preenchido automaticamente pela sua sessao.'
                  : undefined}
              />
            </div>

            <div className="payments-row">
              <label htmlFor="checkout-email">E-mail</label>
              <input
                id="checkout-email"
                name="email"
                type="email"
                maxLength="255"
                autoComplete="email"
                placeholder="voce@empresa.com"
                value=${formValues.email}
                onChange=${onInputChange('email')}
                readOnly=${lockedFields.email}
                title=${lockedFields.email
                  ? 'Campo preenchido automaticamente pela sua sessao.'
                  : undefined}
              />
            </div>

            <div className="payments-row">
              <label htmlFor="checkout-whatsapp"
                >WhatsApp para liberar Premium</label
              >
              <input
                id="checkout-whatsapp"
                name="whatsapp"
                type="text"
                required=${true}
                autoComplete="tel"
                placeholder="5511999999999"
                value=${formValues.whatsapp}
                onChange=${onInputChange('whatsapp')}
                readOnly=${lockedFields.whatsapp}
                title=${lockedFields.whatsapp
                  ? 'Campo preenchido automaticamente pela sua sessao.'
                  : undefined}
              />
              <p className="payments-hint">
                Use com DDI e DDD. Exemplo:
                <code>5511999999999</code>
                ou
                <code>5511999999999@s.whatsapp.net</code>
              </p>
            </div>

            <div className="payments-actions">
              <button
                className="payments-button payments-button-primary"
                type="submit"
                disabled=${submitDisabled}
              >
                ${loadingCheckout ? 'Criando checkout...' : 'Ir para checkout'}
              </button>
              <a className="payments-button payments-button-secondary" href="/"
                >Voltar para home</a
              >
            </div>

            <p className=${statusClassName} aria-live="polite">${statusMessage}</p>
          </form>
        </article>

        <aside className="payments-card payments-aside">
          <p className="payments-plan-badge">Plano ativo no checkout</p>
          <h2 className="payments-plan-title">${planName}</h2>
          <p className="payments-plan-price">${planPriceLabel}</p>

          <ul className="payments-feature-list">
            <li>
              Ativacao automatica apos pagamento confirmado no Stripe.
            </li>
            <li>
              Fluxo seguro com assinatura de webhook validada no backend.
            </li>
            <li>
              Checkout hospedado no Stripe para reduzir risco e fraude.
            </li>
          </ul>

          <p className="payments-small">
            Ao continuar, voce concorda com os
            <a href="/termos-de-uso/">Termos de Uso</a>
            e
            <a href="/politica-de-privacidade/">Politica de Privacidade</a>.
          </p>
        </aside>
      </section>
    </main>
  `;
};

const rootElement = document.getElementById('payments-react-root');
if (rootElement) {
  const config = resolveConfig(rootElement);
  createRoot(rootElement).render(html`<${PaymentsReactApp} config=${config} />`);
}
