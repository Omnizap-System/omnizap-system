import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);

const DEFAULT_PAYMENTS_API_BASE_PATH = '/api/payments';
const DEFAULT_PANEL_PATH = '/user/';
const DEFAULT_PAYMENTS_PATH = '/pagamentos/';

const normalizeRoutePath = (value, fallback) => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (/^\/\//.test(raw)) return fallback;
  return raw;
};

const normalizeSessionId = (value) =>
  String(value || '')
    .trim()
    .slice(0, 255);

const resolveConfig = (rootElement) => {
  const dataset = rootElement?.dataset || {};

  return {
    paymentsApiBasePath:
      String(dataset.paymentsApiBasePath || DEFAULT_PAYMENTS_API_BASE_PATH).trim() ||
      DEFAULT_PAYMENTS_API_BASE_PATH,
    panelPath: normalizeRoutePath(dataset.panelPath, DEFAULT_PANEL_PATH),
    paymentsPath: normalizeRoutePath(dataset.paymentsPath, DEFAULT_PAYMENTS_PATH),
  };
};

const PaymentsSuccessReactApp = ({ config }) => {
  const sessionId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return normalizeSessionId(params.get('session_id'));
  }, []);

  const [statusMessage, setStatusMessage] = useState('Consultando o status no Stripe...');
  const [statusType, setStatusType] = useState('');
  const [metaMessage, setMetaMessage] = useState('');

  useEffect(() => {
    let active = true;

    const setStatus = (message, type = '') => {
      if (!active) return;
      setStatusMessage(String(message || ''));
      setStatusType(String(type || ''));
    };

    const setMeta = (message) => {
      if (!active) return;
      setMetaMessage(String(message || ''));
    };

    if (!sessionId) {
      setStatus(
        'Pagamento concluido. Se o Premium ainda nao apareceu, aguarde alguns segundos e atualize o painel.',
        'pending',
      );
      setMeta('Dica: volte ao painel e confirme se o plano Premium ja foi liberado.');
      return () => {
        active = false;
      };
    }

    const loadStatus = async () => {
      try {
        const response = await fetch(`${config.paymentsApiBasePath}/finalize-session`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            session_id: sessionId,
          }),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || 'Nao foi possivel consultar o status da sessao.');
        }

        const status = String(payload?.session?.status || '').toLowerCase();
        const paymentStatus = String(payload?.session?.payment_status || '').toLowerCase();
        const customerEmail = String(payload?.session?.customer_email || '').trim();
        const ownerJid = String(payload?.owner_jid || payload?.session?.owner_jid || '').trim();
        const action = String(payload?.action || '').toLowerCase();
        const reason = String(payload?.reason || '').toLowerCase();

        if (action === 'premium_activated') {
          setStatus('Pagamento confirmado e Premium ativado com sucesso.');
        } else if (
          status === 'complete' &&
          (paymentStatus === 'paid' || paymentStatus === 'no_payment_required') &&
          reason === 'owner_jid_missing'
        ) {
          setStatus(
            'Pagamento confirmado, mas faltou o WhatsApp para liberar Premium. Fale com o suporte.',
            'error',
          );
        } else if (
          status === 'complete' &&
          (paymentStatus === 'paid' || paymentStatus === 'no_payment_required')
        ) {
          setStatus('Pagamento confirmado. Estamos finalizando a liberacao do Premium.', 'pending');
        } else {
          setStatus('Sessao concluida, aguardando confirmacao final de pagamento no Stripe.', 'pending');
        }

        const metaParts = [`Sessao: ${sessionId}`];
        if (customerEmail) metaParts.push(`Cliente: ${customerEmail}`);
        if (ownerJid) metaParts.push(`WhatsApp: ${ownerJid}`);
        if (status) metaParts.push(`Status checkout: ${status}`);
        if (paymentStatus) metaParts.push(`Status pagamento: ${paymentStatus}`);
        if (action) metaParts.push(`Acao: ${action}`);
        if (reason && reason !== 'ok') metaParts.push(`Motivo: ${reason}`);
        setMeta(metaParts.join(' | '));
      } catch (error) {
        setStatus(error?.message || 'Falha ao consultar status do pagamento.', 'error');
        setMeta(`Sessao: ${sessionId}`);
      }
    };

    void loadStatus();

    return () => {
      active = false;
    };
  }, [config.paymentsApiBasePath, sessionId]);

  const statusClassName = useMemo(() => {
    const list = ['payments-result-status'];
    if (statusType) list.push(statusType);
    return list.join(' ');
  }, [statusType]);

  return html`
    <main className="payments-result-card">
      <h1 className="payments-result-title">Pagamento recebido</h1>
      <p className="payments-result-subtitle">Estamos finalizando a ativacao do seu Premium.</p>

      <p className=${statusClassName} aria-live="polite">${statusMessage}</p>
      <p className="payments-result-meta">${metaMessage}</p>

      <div className="payments-result-actions">
        <a className="payments-result-button primary" href=${config.panelPath}>Ir para painel</a>
        <a className="payments-result-button" href=${config.paymentsPath}>Fazer outro pagamento</a>
      </div>
    </main>
  `;
};

const rootElement = document.getElementById('payments-success-react-root');
if (rootElement) {
  const config = resolveConfig(rootElement);
  createRoot(rootElement).render(html`<${PaymentsSuccessReactApp} config=${config} />`);
}
