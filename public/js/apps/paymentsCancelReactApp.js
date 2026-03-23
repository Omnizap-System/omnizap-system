import React from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);

const DEFAULT_PAYMENTS_PATH = '/pagamentos/';
const DEFAULT_HOME_PATH = '/';

const normalizeRoutePath = (value, fallback) => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (/^\/\//.test(raw)) return fallback;
  return raw;
};

const resolveConfig = (rootElement) => {
  const dataset = rootElement?.dataset || {};

  return {
    paymentsPath: normalizeRoutePath(dataset.paymentsPath, DEFAULT_PAYMENTS_PATH),
    homePath: normalizeRoutePath(dataset.homePath, DEFAULT_HOME_PATH),
  };
};

const PaymentsCancelReactApp = ({ config }) => html`
  <main className="payments-cancel-card">
    <h1 className="payments-cancel-title">Pagamento cancelado</h1>
    <p className="payments-cancel-subtitle">
      Nenhuma cobranca foi finalizada. Se quiser, voce pode tentar novamente agora.
    </p>

    <div className="payments-cancel-note">
      Quando o checkout for concluido, o webhook do Stripe libera seu Premium automaticamente.
    </div>

    <div className="payments-cancel-actions">
      <a className="payments-cancel-button retry" href=${config.paymentsPath}>Tentar novamente</a>
      <a className="payments-cancel-button home" href=${config.homePath}>Voltar para home</a>
    </div>
  </main>
`;

const rootElement = document.getElementById('payments-cancel-react-root');
if (rootElement) {
  const config = resolveConfig(rootElement);
  createRoot(rootElement).render(html`<${PaymentsCancelReactApp} config=${config} />`);
}
