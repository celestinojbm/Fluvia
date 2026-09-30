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
  recentWindow: (returned: number, limit: number, truncated: boolean) => string;
  filterStatus: string;
  filterMerchant: string;
  filterAll: string;
  clearFilters: string;
  filteredCount: (shown: number, total: number) => string;
  filteredEmpty: string;
  outsideWindow: string;
  goToPayments: string;
  recentLoading: string;
  recentUpdating: string;
  recentUpdatedAt: (time: string) => string;
  recentStale: (time: string | null) => string;
  recentAuthLost: string;
  recentForbidden: string;
  retry: string;
  showMore: (n: number) => string;
  trackLocked: string;
  trackingNow: string;
  unknownMerchant: string;
  paymentOutsideWindow: string;
  attemptsTitle: string;
  attemptsScope: string;
  attemptLabel: (n: number) => string;
  attemptCurrent: string;
  attemptPending: string;
  recoveryTitle: string;
  recoveryText: Record<'failed' | 'expired' | 'canceled', string>;
  reopenNoLink: string;
  unverifiedTitle: string;
  lastKnownPhase: string;
  unverifiedText: string;
  processingBlock: string;
  heldTitle: string;
  heldText: (time: string) => string;
  heldTextProtected: (time: string) => string;
  heldCustomer: string;
  heldWait: (time: string) => string;
  heldOtherSale: string;
  recoveryBlockedOther: string;
  recoveryBlockedPaid: string;
  saleUnverified: string;
  legacyNoRecovery: string;
  protectedNote: string;
  saleInFlightElsewhere: string;
  superseded: string;
  heldProtected: string;
  substituteCheckout: string;
  attemptsScopePartial: (since: string) => string;
  attemptsTruncated: string;
  colSale: string;
  saleCheckouts: (n: number) => string;
  saleUnlinked: string;
  recentUnlinkedNote: string;
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
    sale_already_charged:
      'Esta venta ya tiene un pago aprobado o en curso: no se abrió otro checkout.',
  },
  presentTitle: 'Presenta el checkout al cliente',
  presentText:
    'Abre el checkout en este dispositivo o comparte el enlace. El cliente elige el método de pago de prueba.',
  openCheckout: 'Abrir checkout',
  copyUrl: 'Copiar enlace',
  copied: 'Copiado',
  urlLostText:
    'El enlace de pago no se conserva al recargar (contiene un secreto que no se guarda).',
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
  recentLoadError:
    'No pudimos cargar los cobros recientes. Esto no significa que no haya cobros: reintenta.',
  refreshList: 'Actualizar',
  colPayment: 'Pago',
  colCheckout: 'Checkout',
  track: 'Seguir',
  detail: 'Detalle',
  sandboxNotice: 'Sandbox: MockProvider, dinero simulado. Fluvia no es banco ni procesador.',
  recentWindow: (returned, limit, truncated) =>
    truncated
      ? `Ventana: las ${returned} sesiones más recientes (máximo que devuelve la API: ${limit}). Los filtros buscan solo aquí, no en todo el historial.`
      : `Ventana: ${returned} ${returned === 1 ? 'sesión' : 'sesiones'} (todas las de la organización; la API devuelve hasta ${limit}).`,
  filterStatus: 'Estado',
  filterMerchant: 'Comercio',
  filterAll: 'Todos',
  clearFilters: 'Quitar filtros',
  filteredCount: (shown, total) => `${shown} de ${total} en la ventana`,
  filteredEmpty: 'Ningún cobro de la ventana coincide con estos filtros.',
  outsideWindow:
    'Puede haber cobros más antiguos fuera de la ventana; el historial completo está en Pagos.',
  goToPayments: 'Ir a Pagos',
  recentLoading: 'Cargando cobros…',
  recentUpdating: 'Actualizando…',
  recentUpdatedAt: (time) => `Actualizado: ${time}`,
  recentStale: (time) =>
    `No pudimos actualizar la lista. Lo que ves ${time ? `es de las ${time}` : 'es de la carga inicial'} y puede estar desactualizado.`,
  recentAuthLost: 'Tu sesión caducó: no podemos mostrar los cobros.',
  recentForbidden: 'No tienes acceso a los cobros de esta organización.',
  retry: 'Reintentar',
  showMore: (n) => `Mostrar ${n} más`,
  trackLocked: 'Termina o descarta la venta en curso para seguir otro cobro.',
  trackingNow: 'En seguimiento',
  unknownMerchant: 'Comercio no disponible',
  paymentOutsideWindow: 'Pago fuera de la ventana leída',
  attemptsTitle: 'Checkouts de esta venta',
  attemptsScope:
    'Todos los checkouts de esta venta según el servidor, abiertos desde cualquier pestaña o dispositivo.',
  attemptLabel: (n) => `Checkout ${n}`,
  attemptCurrent: 'actual',
  attemptPending: 'sin consultar',
  recoveryTitle: 'Recuperar la venta',
  recoveryText: {
    failed:
      'Pide al cliente otro método de pago y abre un checkout nuevo. Es la misma venta: no se crea otra.',
    expired: 'El checkout caducó sin pago. Abre uno nuevo para la misma venta: no se crea otra.',
    canceled: 'Abre un checkout nuevo para la misma venta: no se crea otra.',
  },
  reopenNoLink:
    'Este cobro es anterior al registro de ventas del servidor: no sabemos a qué venta pertenece. Revisa Pagos antes de volver a cobrar; si hace falta, crea un cobro nuevo.',
  unverifiedTitle: 'Resultado sin verificar',
  lastKnownPhase: 'Último estado leído. Ya no se actualiza sola: consulta el estado.',
  unverifiedText:
    'No pudimos confirmar el estado actual del pago. No cobres de nuevo hasta verificarlo.',
  processingBlock:
    'Mientras el pago esté en proceso no se puede iniciar otro cobro: podría cobrarse dos veces.',
  heldTitle: 'El checkout de esta venta sigue abierto',
  heldText: (time) =>
    `El cliente todavía puede pagarlo (expira: ${time}). No abras otro checkout para esta venta: si paga los dos, se cobraría dos veces.`,
  heldTextProtected: (time) => `El cliente todavía puede pagarlo (expira: ${time}).`,
  heldCustomer:
    'Pide al cliente que termine el pago en la pantalla donde lo abrió. Este estado se actualiza solo; si deja de hacerlo, usa «Consultar estado».',
  heldWait: (time) =>
    `Si el cliente cerró el checkout, espera a que expire (${time}); entonces podrás abrir uno nuevo para esta misma venta.`,
  heldOtherSale: '«Nuevo cobro» es solo para otra venta distinta, no para repetir esta.',
  recoveryBlockedOther:
    'Otro checkout de esta venta sigue abierto, en proceso o sin verificar. No abras uno nuevo hasta que ese termine o expire.',
  recoveryBlockedPaid:
    'Otro checkout de esta venta ya fue aprobado: la venta está cobrada. No la cobres de nuevo.',
  saleUnverified:
    'No pudimos verificar los demás checkouts de esta venta. Consulta el estado antes de volver a cobrar.',
  legacyNoRecovery:
    'Esta venta es anterior al registro de checkouts del servidor: no podemos verificar si otro checkout suyo sigue abierto. Revisa Pagos antes de volver a cobrar; si hace falta, crea un cobro nuevo.',
  protectedNote:
    'Venta protegida: el servidor solo permite un cobro por venta, aunque haya varios checkouts abiertos.',
  superseded: 'Este checkout ya no puede cobrar: la venta se cobró con otro checkout.',
  saleInFlightElsewhere:
    'Otro checkout de esta venta tiene un pago en curso. No presentes este: espera el resultado.',
  heldProtected:
    'Si el cliente no puede volver a ese checkout, abre uno sustituto: esta venta está protegida y el servidor solo permite un cobro, así que el primero que se pague bloquea al otro.',
  substituteCheckout: 'Abrir checkout sustituto',
  attemptsScopePartial: (since) =>
    `Registro del servidor desde ${since}: los checkouts abiertos antes no están vinculados a la venta y no aparecen aquí.`,
  attemptsTruncated: 'Se muestran los más recientes.',
  colSale: 'Venta',
  saleCheckouts: (n) => `${n} checkouts en la ventana`,
  saleUnlinked: 'Sin venta vinculada',
  recentUnlinkedNote:
    'Los cobros anteriores al registro de ventas del servidor aparecen «sin venta vinculada»: no se pueden agrupar por venta ni recuperar desde el POS.',
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
    sale_already_charged:
      'This sale already has an approved or in-progress payment: no other checkout was opened.',
  },
  presentTitle: 'Present the checkout to the customer',
  presentText:
    'Open the checkout on this device or share the link. The customer picks a test payment method.',
  openCheckout: 'Open checkout',
  copyUrl: 'Copy link',
  copied: 'Copied',
  urlLostText:
    'The payment link is not kept after a reload (it contains a secret that is not stored).',
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
  recentLoadError: 'We could not load recent charges. This does not mean there are none: retry.',
  refreshList: 'Refresh',
  colPayment: 'Payment',
  colCheckout: 'Checkout',
  track: 'Track',
  detail: 'Detail',
  sandboxNotice: 'Sandbox: MockProvider, simulated money. Fluvia is not a bank or a processor.',
  recentWindow: (returned, limit, truncated) =>
    truncated
      ? `Window: the ${returned} most recent sessions (the API returns at most ${limit}). Filters only search here, not the whole history.`
      : `Window: ${returned} ${returned === 1 ? 'session' : 'sessions'} (all of the organization's; the API returns up to ${limit}).`,
  filterStatus: 'Status',
  filterMerchant: 'Merchant',
  filterAll: 'All',
  clearFilters: 'Clear filters',
  filteredCount: (shown, total) => `${shown} of ${total} in the window`,
  filteredEmpty: 'No charge in the window matches these filters.',
  outsideWindow: 'Older charges may be outside the window; the full history is in Payments.',
  goToPayments: 'Go to Payments',
  recentLoading: 'Loading charges…',
  recentUpdating: 'Refreshing…',
  recentUpdatedAt: (time) => `Updated: ${time}`,
  recentStale: (time) =>
    `We could not refresh the list. What you see ${time ? `is from ${time}` : 'is from the initial load'} and may be out of date.`,
  recentAuthLost: 'Your session expired: we cannot show the charges.',
  recentForbidden: "You do not have access to this organization's charges.",
  retry: 'Retry',
  showMore: (n) => `Show ${n} more`,
  trackLocked: 'Finish or discard the current sale to track another charge.',
  trackingNow: 'Tracking',
  unknownMerchant: 'Merchant unavailable',
  paymentOutsideWindow: 'Payment outside the read window',
  attemptsTitle: 'Checkouts for this sale',
  attemptsScope:
    "All of this sale's checkouts according to the server, opened from any tab or device.",
  attemptLabel: (n) => `Checkout ${n}`,
  attemptCurrent: 'current',
  attemptPending: 'not checked',
  recoveryTitle: 'Recover the sale',
  recoveryText: {
    failed:
      'Ask the customer for another payment method and open a new checkout. It is the same sale: no new sale is created.',
    expired:
      'The checkout expired unpaid. Open a new one for the same sale: no new sale is created.',
    canceled: 'Open a new checkout for the same sale: no new sale is created.',
  },
  reopenNoLink:
    "This charge predates the server's sale registry: we do not know which sale it belongs to. Review Payments before charging again; if needed, create a new charge.",
  unverifiedTitle: 'Outcome not verified',
  lastKnownPhase: 'Last status read. It no longer updates by itself: check the status.',
  unverifiedText:
    'We could not confirm the current payment status. Do not charge again until it is verified.',
  processingBlock:
    'While the payment is processing no other charge can be started: it could be charged twice.',
  heldTitle: "This sale's checkout is still open",
  heldText: (time) =>
    `The customer can still pay it (expires: ${time}). Do not open another checkout for this sale: if they pay both, they would be charged twice.`,
  heldTextProtected: (time) => `The customer can still pay it (expires: ${time}).`,
  heldCustomer:
    'Ask the customer to finish paying on the screen where they opened it. This status updates by itself; if it stops, use «Check status».',
  heldWait: (time) =>
    `If the customer closed the checkout, wait until it expires (${time}); then you can open a new one for this same sale.`,
  heldOtherSale: '«New charge» is only for a different sale, not to repeat this one.',
  recoveryBlockedOther:
    'Another checkout for this sale is still open, processing or unverified. Do not open a new one until it finishes or expires.',
  recoveryBlockedPaid:
    'Another checkout for this sale was already approved: the sale is paid. Do not charge it again.',
  saleUnverified:
    "We could not verify this sale's other checkouts. Check the status before charging again.",
  legacyNoRecovery:
    "This sale predates the server's checkout registry: we cannot verify whether another of its checkouts is still open. Review Payments before charging again; if needed, create a new charge.",
  protectedNote:
    'Protected sale: the server allows only one charge per sale, even with several open checkouts.',
  superseded: 'This checkout can no longer charge: the sale was paid with another checkout.',
  saleInFlightElsewhere:
    'Another checkout for this sale has a payment in progress. Do not present this one: wait for the outcome.',
  heldProtected:
    'If the customer cannot get back to that checkout, open a replacement: this sale is protected and the server allows only one charge, so whichever is paid first blocks the other.',
  substituteCheckout: 'Open replacement checkout',
  attemptsScopePartial: (since) =>
    `Server registry since ${since}: checkouts opened earlier are not linked to the sale and do not show here.`,
  attemptsTruncated: 'Showing the most recent ones.',
  colSale: 'Sale',
  saleCheckouts: (n) => `${n} checkouts in the window`,
  saleUnlinked: 'No linked sale',
  recentUnlinkedNote:
    "Charges that predate the server's sale registry show as «no linked sale»: they cannot be grouped by sale or recovered from the POS.",
};

export const POS_MESSAGES: Record<Locale, PosMessages> = { es: ES, en: EN };

export function posErrorText(t: PosMessages, code: string | undefined, fallback: string): string {
  return (code && t.errorCodes[code]) || fallback;
}
