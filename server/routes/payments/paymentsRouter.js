let paymentsControllerPromise = null;

const loadPaymentsController = async () => {
  if (!paymentsControllerPromise) {
    paymentsControllerPromise = import('../../controllers/payments/paymentsController.js');
  }
  return paymentsControllerPromise;
};

const normalizeBasePath = (value, fallback) => {
  const raw = String(value || '').trim() || fallback;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const withoutTrailingSlash = withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
  return withoutTrailingSlash || fallback;
};

const startsWithPath = (pathname, prefix) => {
  if (!pathname || !prefix) return false;
  if (pathname === prefix) return true;
  return pathname.startsWith(`${prefix}/`);
};

const DEFAULT_PAYMENTS_API_BASE_PATH = '/api/payments';

export const getPaymentsRouterConfig = async () => {
  const controller = await loadPaymentsController();
  const routeConfig = (typeof controller?.getPaymentsRouteConfig === 'function' ? controller.getPaymentsRouteConfig() : null) || {};

  return {
    apiBasePath: normalizeBasePath(routeConfig.apiBasePath, DEFAULT_PAYMENTS_API_BASE_PATH),
  };
};

export const shouldHandlePaymentsPath = (pathname, config = null) => {
  const resolvedConfig = config || {
    apiBasePath: DEFAULT_PAYMENTS_API_BASE_PATH,
  };

  const apiBasePath = normalizeBasePath(resolvedConfig.apiBasePath, DEFAULT_PAYMENTS_API_BASE_PATH);
  return startsWithPath(pathname, apiBasePath);
};

export const maybeHandlePaymentsRequest = async (req, res, { pathname, url }) => {
  const controller = await loadPaymentsController();
  if (typeof controller?.maybeHandlePaymentsRequest !== 'function') return false;
  return controller.maybeHandlePaymentsRequest(req, res, { pathname, url });
};
