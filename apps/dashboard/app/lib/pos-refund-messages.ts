import type { Locale } from '../messages';
import type { RefundStatus } from './pos-refund-contract';

/**
 * Textos de la devolución de una venta del POS (es/en). Tono de cajero y
 * honesto con el entorno: dinero simulado, MockProvider, sin prometer plazos
 * bancarios ni reglas de un país (PEND-007/PEND-008 siguen abiertas).
 */
export interface PosRefundMessages {
  title: string;
  intro: string;
  summaryCaptured: string;
  summaryRefunded: string;
  summaryPending: string;
  summaryRemaining: string;
  start: string;
  modeLabel: string;
  modeFull: (formatted: string) => string;
  modePartial: string;
  amountLabel: string;
  amountHint: (exp: number, max: string) => string;
  reasonLabel: string;
  reasonHint: string;
  review: string;
  cancel: string;
  confirmTitle: string;
  confirmText: (formatted: string, total: string) => string;
  confirmIrreversible: string;
  confirm: (formatted: string) => string;
  submitting: string;
  back: string;
  amountErrors: {
    empty: string;
    format: string;
    decimals: string;
    zero: string;
    too_large: string;
    over_remaining: (max: string) => string;
  };
  uncertainTitle: string;
  uncertainText: string;
  retrySafe: string;
  checkRefunds: string;
  failed: string;
  errorCodes: Record<string, string>;
  status: Record<RefundStatus, string>;
  statusDetail: Record<RefundStatus, string>;
  listTitle: string;
  listEmpty: string;
  listTruncated: string;
  failureCode: (code: string) => string;
  /** Explicación para el cajero de los `failure_code` conocidos. */
  failureReasons: Record<string, string>;
  reasonShown: (reason: string) => string;
  fullyRefunded: string;
  openBlock: string;
  uncertainBlock: string;
  noRole: string;
  notVerified: string;
  noCaptured: string;
  loading: string;
  loadError: string;
  retry: string;
  authLost: string;
  signIn: string;
  forbidden: string;
  resultTitle: Record<RefundStatus, string>;
  saleStaysClosed: string;
  badgeRefunded: string;
  badgePartial: string;
}

const ES: PosRefundMessages = {
  title: 'Devolución',
  intro:
    'Devuelve todo o parte de este cobro al método de pago de prueba del cliente. La venta sigue cobrada: devolver no permite cobrarla otra vez.',
  summaryCaptured: 'Cobrado',
  summaryRefunded: 'Devuelto',
  summaryPending: 'En curso',
  summaryRemaining: 'Disponible para devolver',
  start: 'Devolver…',
  modeLabel: '¿Cuánto devuelves?',
  modeFull: (f) => `Todo lo disponible (${f})`,
  modePartial: 'Una parte',
  amountLabel: 'Importe a devolver',
  amountHint: (exp, max) => `${exp === 0 ? 'Sin decimales.' : 'Hasta 2 decimales.'} Máximo ${max}.`,
  reasonLabel: 'Motivo (opcional)',
  reasonHint: 'Queda registrado en la devolución y en la auditoría. Máximo 500 caracteres.',
  review: 'Revisar devolución',
  cancel: 'Cancelar',
  confirmTitle: 'Confirma la devolución',
  confirmText: (f, total) => `Vas a devolver ${f} de un cobro de ${total}.`,
  confirmIrreversible: 'Una devolución confirmada no se puede deshacer.',
  confirm: (f) => `Devolver ${f}`,
  submitting: 'Registrando devolución…',
  back: 'Volver y editar',
  amountErrors: {
    empty: 'Introduce el importe a devolver.',
    format: 'Usa solo números y, si aplica, un separador decimal (punto o coma).',
    decimals: 'Esta moneda no admite tantos decimales.',
    zero: 'El importe debe ser mayor que cero.',
    too_large: 'El importe es demasiado grande.',
    over_remaining: (max) => `No puedes devolver más de ${max}.`,
  },
  uncertainTitle: 'No sabemos si la devolución se registró',
  uncertainText:
    'Se perdió la respuesta del servidor. Reintentar es seguro: usa la misma clave de idempotencia y nunca registra una segunda devolución.',
  retrySafe: 'Reintentar de forma segura',
  checkRefunds: 'Consultar devoluciones',
  failed: 'No se pudo registrar la devolución.',
  errorCodes: {
    invalid_session: 'Tu sesión caducó. Vuelve a iniciar sesión.',
    insufficient_permissions: 'Tu rol no permite devolver cobros.',
    not_found: 'No encontramos este cobro en la organización.',
    refund_amount_exceeds_remaining:
      'El importe supera lo que queda por devolver (puede haber otra devolución reciente). Revisa el disponible.',
    invalid_state_transition: 'Este cobro ya no admite devoluciones.',
    idempotency_key_reuse:
      'La devolución cambió desde el último intento. Revísala y confírmala otra vez.',
    idempotency_conflict: 'Esta devolución ya se está procesando. Consulta las devoluciones.',
    processing_in_flight: 'Esta devolución ya se está procesando. Consulta las devoluciones.',
    rate_limited: 'Demasiadas solicitudes. Espera unos segundos y reintenta.',
    origin_not_allowed: 'Solicitud bloqueada por seguridad. Recarga la página.',
    validation_error: 'Datos no válidos. Revisa el importe.',
  },
  status: {
    created: 'Registrada',
    processing: 'En proceso',
    indeterminate: 'Sin confirmar',
    succeeded: 'Devuelta',
    failed: 'Fallida',
    canceled: 'Cancelada',
  },
  statusDetail: {
    created: 'Registrada; esperando al proveedor de prueba.',
    processing: 'El proveedor de prueba la está procesando.',
    indeterminate:
      'El proveedor no confirmó el resultado. Solo una confirmación verificada la cierra: no la repitas.',
    succeeded: 'El importe se devolvió al método de pago de prueba.',
    failed: 'El proveedor la rechazó. El importe no se devolvió.',
    canceled: 'No se ejecutó. El importe no se devolvió.',
  },
  listTitle: 'Devoluciones de este cobro',
  listEmpty: 'Este cobro no tiene devoluciones.',
  listTruncated:
    'Hay más devoluciones de las que se pueden leer de una vez: el disponible no es calculable aquí. Revisa el detalle del pago.',
  failureCode: (c) => `Motivo técnico: ${c}`,
  failureReasons: {
    insufficient_merchant_balance:
      'El comercio no tiene saldo disponible suficiente: los fondos de los cobros aún no se han liquidado. No se contactó al proveedor y nada se devolvió; el importe sigue disponible para devolver más adelante.',
    provider_unavailable:
      'El proveedor de prueba no estaba disponible y no recibió la solicitud. Nada se devolvió; puedes intentarlo de nuevo.',
  },
  reasonShown: (r) => `Motivo: ${r}`,
  fullyRefunded: 'Este cobro está devuelto por completo.',
  openBlock: 'Hay una devolución en curso. Espera a que termine antes de registrar otra.',
  uncertainBlock:
    'Hay una devolución sin confirmar por el proveedor. No registres otra hasta que se resuelva.',
  noRole: 'Devolver un cobro requiere el rol owner, admin o finance.',
  notVerified: 'Consulta el estado del cobro antes de devolver: la última lectura no se verificó.',
  noCaptured: 'No pudimos leer cuánto se capturó de este cobro: no se ofrece devolver.',
  loading: 'Cargando devoluciones…',
  loadError: 'No pudimos leer las devoluciones de este cobro.',
  retry: 'Reintentar',
  authLost: 'Tu sesión caducó.',
  signIn: 'Vuelve a iniciar sesión',
  forbidden: 'No tienes acceso a las devoluciones de este cobro.',
  resultTitle: {
    created: 'Devolución registrada',
    processing: 'Devolución en proceso',
    indeterminate: 'Devolución sin confirmar',
    succeeded: 'Devolución completada',
    failed: 'Devolución fallida',
    canceled: 'Devolución cancelada',
  },
  saleStaysClosed: 'La venta sigue cobrada: no se puede volver a cobrar.',
  badgeRefunded: 'Devuelta',
  badgePartial: 'Devolución parcial',
};

const EN: PosRefundMessages = {
  title: 'Refund',
  intro:
    "Refund all or part of this charge to the customer's test payment method. The sale stays charged: refunding does not allow charging it again.",
  summaryCaptured: 'Charged',
  summaryRefunded: 'Refunded',
  summaryPending: 'In progress',
  summaryRemaining: 'Available to refund',
  start: 'Refund…',
  modeLabel: 'How much are you refunding?',
  modeFull: (f) => `Everything available (${f})`,
  modePartial: 'Part of it',
  amountLabel: 'Amount to refund',
  amountHint: (exp, max) => `${exp === 0 ? 'No decimals.' : 'Up to 2 decimals.'} Maximum ${max}.`,
  reasonLabel: 'Reason (optional)',
  reasonHint: 'Stored on the refund and in the audit log. Up to 500 characters.',
  review: 'Review refund',
  cancel: 'Cancel',
  confirmTitle: 'Confirm the refund',
  confirmText: (f, total) => `You are about to refund ${f} of a ${total} charge.`,
  confirmIrreversible: 'A confirmed refund cannot be undone.',
  confirm: (f) => `Refund ${f}`,
  submitting: 'Recording refund…',
  back: 'Go back and edit',
  amountErrors: {
    empty: 'Enter the amount to refund.',
    format: 'Use digits only and, if needed, one decimal separator (dot or comma).',
    decimals: 'This currency does not allow that many decimals.',
    zero: 'The amount must be greater than zero.',
    too_large: 'The amount is too large.',
    over_remaining: (max) => `You cannot refund more than ${max}.`,
  },
  uncertainTitle: "We don't know whether the refund was recorded",
  uncertainText:
    'The server response was lost. Retrying is safe: it reuses the same idempotency key and never records a second refund.',
  retrySafe: 'Retry safely',
  checkRefunds: 'Check refunds',
  failed: 'The refund could not be recorded.',
  errorCodes: {
    invalid_session: 'Your session expired. Sign in again.',
    insufficient_permissions: 'Your role cannot refund charges.',
    not_found: 'We could not find this charge in the organization.',
    refund_amount_exceeds_remaining:
      'The amount exceeds what is left to refund (there may be a recent refund). Check the available amount.',
    invalid_state_transition: 'This charge no longer accepts refunds.',
    idempotency_key_reuse:
      'The refund changed since the last attempt. Review and confirm it again.',
    idempotency_conflict: 'This refund is already being processed. Check the refunds.',
    processing_in_flight: 'This refund is already being processed. Check the refunds.',
    rate_limited: 'Too many requests. Wait a few seconds and retry.',
    origin_not_allowed: 'Request blocked for security. Reload the page.',
    validation_error: 'Invalid data. Check the amount.',
  },
  status: {
    created: 'Recorded',
    processing: 'Processing',
    indeterminate: 'Unconfirmed',
    succeeded: 'Refunded',
    failed: 'Failed',
    canceled: 'Canceled',
  },
  statusDetail: {
    created: 'Recorded; waiting for the test provider.',
    processing: 'The test provider is processing it.',
    indeterminate:
      'The provider did not confirm the outcome. Only a verified confirmation closes it: do not repeat it.',
    succeeded: 'The amount was returned to the test payment method.',
    failed: 'The provider declined it. The amount was not refunded.',
    canceled: 'It did not run. The amount was not refunded.',
  },
  listTitle: 'Refunds of this charge',
  listEmpty: 'This charge has no refunds.',
  listTruncated:
    'There are more refunds than can be read at once: the available amount cannot be computed here. Check the payment detail.',
  failureCode: (c) => `Technical reason: ${c}`,
  failureReasons: {
    insufficient_merchant_balance:
      "The merchant does not have enough available balance: the charges' funds have not been settled yet. The provider was not contacted and nothing was refunded; the amount remains available to refund later.",
    provider_unavailable:
      'The test provider was unavailable and did not receive the request. Nothing was refunded; you can try again.',
  },
  reasonShown: (r) => `Reason: ${r}`,
  fullyRefunded: 'This charge is fully refunded.',
  openBlock: 'A refund is in progress. Wait for it to finish before recording another.',
  uncertainBlock:
    'A refund is unconfirmed by the provider. Do not record another until it is resolved.',
  noRole: 'Refunding a charge requires the owner, admin or finance role.',
  notVerified: 'Check the charge status before refunding: the last read was not verified.',
  noCaptured: 'We could not read how much of this charge was captured: refunding is not offered.',
  loading: 'Loading refunds…',
  loadError: 'We could not read the refunds of this charge.',
  retry: 'Retry',
  authLost: 'Your session expired.',
  signIn: 'Sign in again',
  forbidden: 'You do not have access to the refunds of this charge.',
  resultTitle: {
    created: 'Refund recorded',
    processing: 'Refund processing',
    indeterminate: 'Refund unconfirmed',
    succeeded: 'Refund completed',
    failed: 'Refund failed',
    canceled: 'Refund canceled',
  },
  saleStaysClosed: 'The sale stays charged: it cannot be charged again.',
  badgeRefunded: 'Refunded',
  badgePartial: 'Partially refunded',
};

export const POS_REFUND_MESSAGES: Record<Locale, PosRefundMessages> = { es: ES, en: EN };

export function refundErrorText(t: PosRefundMessages, code: string | undefined): string {
  return (code && t.errorCodes[code]) || t.failed;
}
