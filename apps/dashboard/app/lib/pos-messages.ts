import type { Locale } from '../messages';
import type { AmountError } from './pos-money';
import type { SalePhase } from './pos-contract';

/**
 * Textos del POS sandbox (es/en). Módulo propio para no inflar `messages.ts`.
 * Tono: claro para un cajero, honesto sobre el entorno (dinero simulado) y sin
 * afirmar capacidades que Fluvia no tiene (no es banco ni procesador).
 */

export interface PosMessages {
  navLabel: string;
  title: string;
  subtitle: string;
  back: string;
  newSaleTitle: string;
  merchantLabel: string;
  amountLabel: string;
  amountHintMinor: (exp: number) => string;
  currencyLabel: string;
  conceptLabel: string;
  conceptHint: string;
  preview: (formatted: string, minor: number) => string;
  charge: (formatted: string) => string;
  chargeIdle: string;
  creatingSale: string;
  openingCheckout: string;
  amountErrors: Record<AmountError, string>;
  noRoleTitle: string;
  noRoleText: string;
  noMerchantsTitle: string;
  noMerchantsText: string;
  noMerchantsCta: string;
  createFailed: string;
  createUncertainTitle: string;
  createUncertainText: string;
  retrySafe: string;
  discardDraft: string;
  openFailed: string;
  openUncertainTitle: string;
  openUncertainText: string;
  openAgain: string;
  errorCodes: Record<string, string>;
  presentTitle: string;
  presentText: string;
  openCheckout: string;
  copyUrl: string;
  copied: string;
  urlLostText: string;
  statusTitle: string;
  phase: Record<SalePhase, string>;
  phaseDetail: Record<SalePhase, string>;
  lastChecked: (time: string) => string;
  pollError: string;
  pollStopped: string;
  refreshStatus: string;
  refreshing: string;
  sessionNotFound: string;
  sessionExpiredLogin: string;
  signInAgain: string;
  failureCode: (code: string) => string;
  refundedNote: string;
  expiresLabel: string;
  nextSale: string;
  newCheckoutForSale: string;
  viewPayment: string;
  viewSession: string;
  saleRef: string;
  paymentRef: string;
  noCancelNote: string;
  recentTitle: string;
  recentScope: string;
  recentEmpty: string;
  recentLoadError: string;
  refreshList: string;
  colPayment: string;
  colCheckout: string;
  track: string;
  detail: string;
  sandboxNotice: string;
}

const ES: PosMessages = {
  navLabel: 'Cobrar (POS)',
  title: 'Punto de venta',
  subtitle: 'Cobra una venta con checkout alojado. Entorno sandbox: dinero simulado.',
  back: 'Volver al panel',
  newSaleTitle: 'Nueva venta',
  merchantLabel: 'Comercio',
  amountLabel: 'Importe',
  amountHintMinor: (exp) =>
    exp === 0 ? 'Sin decimales. Ejemplo: 12500' : 'Hasta 2 decimales. Ejemplo: 12.50',
  currencyLabel: 'Moneda',
  conceptLabel: 'Concepto (opcional)',
  conceptHint: 'Lo verás en el historial de payment links. Máximo 500 caracteres.',
  preview: (formatted, minor) =>
    `Se cobrará ${formatted} · enviado a la API como ${minor} (unidades menores)`,
  charge: (formatted) => `Cobrar ${formatted}`,
  chargeIdle: 'Cobrar',
  creatingSale: 'Creando venta…',
  openingCheckout: 'Abriendo checkout…',
  amountErrors: {
    empty: 'Introduce el importe.',
    format: 'Usa solo números y, si aplica, un separador decimal (punto o coma).',
    decimals: 'Esta moneda no admite tantos decimales.',
    zero: 'El importe debe ser mayor que cero.',
    too_large: 'El importe es demasiado grande.',
  },
  noRoleTitle: 'Tu rol no puede cobrar',
  noRoleText:
    'Crear un cobro requiere el rol owner, admin o finance. Pide acceso a un administrador de la organización.',
  noMerchantsTitle: 'No hay comercios activos',
  noMerchantsText: 'Necesitas un comercio activo para cobrar.',
  noMerchantsCta: 'Configurar comercio',
  createFailed: 'No se pudo crear la venta.',
  createUncertainTitle: 'No sabemos si la venta se creó',
  createUncertainText:
    'Se perdió la respuesta del servidor. Reintentar es seguro: usa la misma clave de idempotencia y nunca crea una venta duplicada.',
  retrySafe: 'Reintentar de forma segura',
  discardDraft: 'Descartar y editar',
  openFailed: 'No se pudo abrir el checkout.',
  openUncertainTitle: 'No sabemos si el checkout se abrió',
  openUncertainText:
    'La venta existe, pero se perdió la respuesta al abrir el checkout. Un checkout abierto y no pagado no cobra nada y expira solo. Puedes abrir uno nuevo para esta venta.',
  openAgain: 'Abrir un checkout nuevo para esta venta',
  errorCodes: {
    validation_error: 'Datos no válidos. Revisa el importe y la moneda.',
    invalid_session: 'Tu sesión caducó. Vuelve a iniciar sesión.',
    insufficient_permissions: 'Tu rol no permite esta acción.',
    not_found: 'No encontramos el recurso en esta organización.',
    link_unavailable: 'El enlace de la venta ya no está activo. Crea un cobro nuevo.',
    rate_limited: 'Demasiadas solicitudes. Espera unos segundos y reintenta.',
    upstream_unavailable: 'El servicio no respondió. Nada se ha cobrado; reintenta.',
    origin_not_allowed: 'Solicitud bloqueada por seguridad. Recarga la página.',
    idempotency_key_reuse: 'La venta cambió desde el último intento. Vuelve a enviarla.',
    merchant_not_found: 'El comercio no existe o no está activo.',
  },
  presentTitle: 'Presenta el checkout al cliente',
  presentText:
    'Abre el checkout en este dispositivo o comparte el enlace. El cliente elige el método de pago de prueba.',
  openCheckout: 'Abrir checkout',
  copyUrl: 'Copiar enlace',
  copied: 'Copiado',
  urlLostText:
    'El enlace de pago no se conserva al recargar (contiene un secreto que no se guarda). Si el cliente aún no pagó, abre un checkout nuevo.',
  statusTitle: 'Estado del cobro',
  phase: {
    awaiting_payment: 'Esperando al cliente',
    processing: 'Pago en proceso',
    succeeded: 'Pago aprobado',
    failed: 'Pago rechazado',
    canceled: 'Pago cancelado',
    expired: 'Checkout expirado',
    unknown: 'Estado no reconocido',
  },
  phaseDetail: {
    awaiting_payment: 'El checkout está abierto. Esta pantalla se actualiza sola.',
    processing:
      'El proveedor simulado aún no confirma el resultado. No cobres de nuevo: espera la confirmación.',
    succeeded: 'Cobro confirmado en sandbox. Ningún dinero real se ha movido.',
    failed: 'El método de pago fue rechazado. Puedes abrir un checkout nuevo para esta venta.',
    canceled: 'El pago fue cancelado. Puedes abrir un checkout nuevo para esta venta.',
    expired: 'El cliente no pagó a tiempo. Puedes abrir un checkout nuevo para esta venta.',
    unknown: 'Revisa el detalle del pago antes de repetir el cobro.',
  },
  lastChecked: (time) => `Última comprobación: ${time}`,
  pollError: 'No pudimos actualizar el estado. Seguimos intentándolo…',
  pollStopped: 'Dejamos de actualizar automáticamente.',
  refreshStatus: 'Consultar estado',
  refreshing: 'Consultando…',
  sessionNotFound: 'No encontramos este cobro en la organización.',
  sessionExpiredLogin:
    'Tu sesión caducó. El cobro sigue su curso; inicia sesión para ver el resultado.',
  signInAgain: 'Iniciar sesión',
  failureCode: (code) => `Código: ${code}`,
  refundedNote: 'Este pago tiene reembolsos registrados.',
  expiresLabel: 'Expira',
  nextSale: 'Nuevo cobro',
  newCheckoutForSale: 'Abrir checkout nuevo',
  viewPayment: 'Ver detalle del pago',
  viewSession: 'Ver sesión de checkout',
  saleRef: 'Sesión',
  paymentRef: 'Pago',
  noCancelNote:
    'La API no permite cancelar un cobro abierto desde el panel: si el cliente no paga, el checkout expira solo.',
  recentTitle: 'Cobros recientes',
  recentScope:
    'Sesiones de checkout de la organización con el estado de su pago (datos de la API).',
  recentEmpty: 'Aún no hay cobros. El primero aparecerá aquí.',
  recentLoadError: 'No pudimos cargar los cobros recientes. Actualiza para reintentar.',
  refreshList: 'Actualizar',
  colPayment: 'Pago',
  colCheckout: 'Checkout',
  track: 'Seguir',
  detail: 'Detalle',
  sandboxNotice: 'Sandbox: MockProvider, dinero simulado. Fluvia no es banco ni procesador.',
};

const EN: PosMessages = {
  navLabel: 'Charge (POS)',
  title: 'Point of sale',
  subtitle: 'Charge a sale with hosted checkout. Sandbox environment: simulated money.',
  back: 'Back to dashboard',
  newSaleTitle: 'New sale',
  merchantLabel: 'Merchant',
  amountLabel: 'Amount',
  amountHintMinor: (exp) =>
    exp === 0 ? 'No decimals. Example: 12500' : 'Up to 2 decimals. Example: 12.50',
  currencyLabel: 'Currency',
  conceptLabel: 'Description (optional)',
  conceptHint: 'Shown in the payment links history. Up to 500 characters.',
  preview: (formatted, minor) =>
    `Will charge ${formatted} · sent to the API as ${minor} (minor units)`,
  charge: (formatted) => `Charge ${formatted}`,
  chargeIdle: 'Charge',
  creatingSale: 'Creating sale…',
  openingCheckout: 'Opening checkout…',
  amountErrors: {
    empty: 'Enter the amount.',
    format: 'Use digits only and, if needed, one decimal separator (dot or comma).',
    decimals: 'This currency does not allow that many decimals.',
    zero: 'The amount must be greater than zero.',
    too_large: 'The amount is too large.',
  },
  noRoleTitle: 'Your role cannot charge',
  noRoleText:
    'Creating a charge requires the owner, admin or finance role. Ask an organization administrator for access.',
  noMerchantsTitle: 'No active merchants',
  noMerchantsText: 'You need an active merchant to charge.',
  noMerchantsCta: 'Set up merchant',
  createFailed: 'The sale could not be created.',
  createUncertainTitle: 'We do not know whether the sale was created',
  createUncertainText:
    'The server response was lost. Retrying is safe: it reuses the same idempotency key and never creates a duplicate sale.',
  retrySafe: 'Retry safely',
  discardDraft: 'Discard and edit',
  openFailed: 'The checkout could not be opened.',
  openUncertainTitle: 'We do not know whether the checkout opened',
  openUncertainText:
    'The sale exists, but the response to opening the checkout was lost. An open, unpaid checkout charges nothing and expires on its own. You can open a new one for this sale.',
  openAgain: 'Open a new checkout for this sale',
  errorCodes: {
    validation_error: 'Invalid data. Check the amount and currency.',
    invalid_session: 'Your session expired. Sign in again.',
    insufficient_permissions: 'Your role does not allow this action.',
    not_found: 'We could not find the resource in this organization.',
    link_unavailable: 'The sale link is no longer active. Create a new charge.',
    rate_limited: 'Too many requests. Wait a few seconds and retry.',
    upstream_unavailable: 'The service did not respond. Nothing was charged; retry.',
    origin_not_allowed: 'Request blocked for security. Reload the page.',
    idempotency_key_reuse: 'The sale changed since the last attempt. Submit it again.',
    merchant_not_found: 'The merchant does not exist or is not active.',
  },
  presentTitle: 'Present the checkout to the customer',
  presentText:
    'Open the checkout on this device or share the link. The customer picks a test payment method.',
  openCheckout: 'Open checkout',
  copyUrl: 'Copy link',
  copied: 'Copied',
  urlLostText:
    'The payment link is not kept after a reload (it contains a secret that is not stored). If the customer has not paid yet, open a new checkout.',
  statusTitle: 'Charge status',
  phase: {
    awaiting_payment: 'Waiting for the customer',
    processing: 'Payment processing',
    succeeded: 'Payment approved',
    failed: 'Payment declined',
    canceled: 'Payment canceled',
    expired: 'Checkout expired',
    unknown: 'Unrecognized status',
  },
  phaseDetail: {
    awaiting_payment: 'The checkout is open. This screen updates by itself.',
    processing:
      'The simulated provider has not confirmed the outcome yet. Do not charge again: wait for confirmation.',
    succeeded: 'Charge confirmed in sandbox. No real money has moved.',
    failed: 'The payment method was declined. You can open a new checkout for this sale.',
    canceled: 'The payment was canceled. You can open a new checkout for this sale.',
    expired: 'The customer did not pay in time. You can open a new checkout for this sale.',
    unknown: 'Check the payment detail before charging again.',
  },
  lastChecked: (time) => `Last checked: ${time}`,
  pollError: 'We could not refresh the status. Still trying…',
  pollStopped: 'Automatic updates stopped.',
  refreshStatus: 'Check status',
  refreshing: 'Checking…',
  sessionNotFound: 'We could not find this charge in the organization.',
  sessionExpiredLogin: 'Your session expired. The charge continues; sign in to see the outcome.',
  signInAgain: 'Sign in',
  failureCode: (code) => `Code: ${code}`,
  refundedNote: 'This payment has refunds recorded.',
  expiresLabel: 'Expires',
  nextSale: 'New charge',
  newCheckoutForSale: 'Open new checkout',
  viewPayment: 'View payment detail',
  viewSession: 'View checkout session',
  saleRef: 'Session',
  paymentRef: 'Payment',
  noCancelNote:
    'The API does not allow canceling an open charge from the dashboard: if the customer does not pay, the checkout expires on its own.',
  recentTitle: 'Recent charges',
  recentScope: "The organization's checkout sessions with their payment status (API data).",
  recentEmpty: 'No charges yet. The first one will show up here.',
  recentLoadError: 'We could not load recent charges. Refresh to retry.',
  refreshList: 'Refresh',
  colPayment: 'Payment',
  colCheckout: 'Checkout',
  track: 'Track',
  detail: 'Detail',
  sandboxNotice: 'Sandbox: MockProvider, simulated money. Fluvia is not a bank or a processor.',
};

export const POS_MESSAGES: Record<Locale, PosMessages> = { es: ES, en: EN };

export function posErrorText(t: PosMessages, code: string | undefined, fallback: string): string {
  return (code && t.errorCodes[code]) || fallback;
}
