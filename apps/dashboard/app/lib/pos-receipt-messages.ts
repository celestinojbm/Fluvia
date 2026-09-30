import type { Locale } from '../messages';
import type { RefundStatus } from './pos-refund-contract';

/**
 * Textos del justificante de cobro del POS (es/en). Es un justificante
 * OPERATIVO del sandbox: nunca se presenta como factura ni documento fiscal
 * (sin numeración fiscal, sin impuestos, sin requisitos legales de un país —
 * PEND-007/PEND-008 siguen abiertas).
 */
export interface PosReceiptMessages {
  pageTitle: string;
  docTitle: string;
  notFiscal: string;
  sandbox: string;
  organization: string;
  merchant: string;
  concept: string;
  noConcept: string;
  saleUnlinked: string;
  amountCharged: string;
  saleAmount: string;
  statusLabel: string;
  status: Record<string, string>;
  checkoutCompleted: string;
  checkoutCompletedMissing: string;
  paymentCreated: string;
  reference: string;
  referenceHint: string;
  readAt: (time: string) => string;
  print: string;
  printHint: string;
  printStale: string;
  back: string;
  open: string;
  loading: string;
  loadError: string;
  retry: string;
  notFound: string;
  notCharged: string;
  authLost: string;
  signIn: string;
  docTitleRefunds: string;
  refundsTitle: string;
  refundsNone: string;
  refundedConfirmed: string;
  refundStatus: Record<RefundStatus, string>;
  refundDetail: Record<RefundStatus, string>;
  uncertainBanner: string;
  openBanner: string;
  truncatedNote: string;
  refresh: string;
  refreshing: string;
  updated: string;
  stale: (time: string) => string;
}

const ES: PosReceiptMessages = {
  pageTitle: 'Justificante',
  docTitle: 'Justificante de cobro',
  notFiscal:
    'Justificante operativo del entorno de pruebas. No es una factura ni un documento fiscal: no lleva numeración fiscal ni impuestos.',
  sandbox: 'Dinero simulado (sandbox).',
  organization: 'Organización',
  merchant: 'Comercio',
  concept: 'Concepto',
  noConcept: 'Sin concepto',
  saleUnlinked: 'Cobro sin venta vinculada (anterior al registro de ventas).',
  amountCharged: 'Importe cobrado',
  saleAmount: 'Importe de la venta',
  statusLabel: 'Estado',
  status: {
    succeeded: 'Cobro confirmado',
    partially_refunded: 'Cobro confirmado · devolución parcial',
    refunded: 'Cobro confirmado · devuelto por completo',
  },
  checkoutCompleted: 'Checkout completado',
  checkoutCompletedMissing: 'No informado por la API',
  paymentCreated: 'Cobro iniciado',
  reference: 'Referencia',
  referenceHint: 'Últimos 8 caracteres del identificador del cobro.',
  readAt: (t) => `Consultado: ${t}`,
  print: 'Imprimir justificante',
  printStale:
    'JUSTIFICANTE NO VÁLIDO: la última lectura falló y estos datos pueden estar desactualizados. Vuelve a leerlo antes de imprimir.',
  printHint:
    'Al imprimir, la dirección de esta página se sustituye por una sin identificadores. Aun así, desactiva «Encabezados y pies de página» en el diálogo de impresión: esa casilla la controla el navegador, no la aplicación.',
  back: 'Volver al POS',
  open: 'Ver justificante',
  loading: 'Cargando justificante…',
  loadError: 'No pudimos leer este cobro. No se muestra un justificante incompleto.',
  retry: 'Reintentar',
  notFound: 'No encontramos este cobro en la organización.',
  notCharged:
    'Este cobro no está confirmado por la API: no hay justificante. Consulta su estado en el POS.',
  authLost: 'Tu sesión caducó. Por seguridad no se muestra el justificante.',
  signIn: 'Vuelve a iniciar sesión',
  docTitleRefunds: 'Justificante de cobro y devoluciones',
  refundsTitle: 'Devoluciones',
  refundsNone: 'Sin devoluciones registradas.',
  refundedConfirmed: 'Devuelto (confirmado)',
  refundStatus: {
    created: 'En curso',
    processing: 'En curso',
    indeterminate: 'Pendiente de verificación',
    succeeded: 'Devuelta',
    failed: 'No devuelta (rechazada)',
    canceled: 'No devuelta (cancelada)',
  },
  refundDetail: {
    created: 'Registrada; aún no se ha devuelto.',
    processing: 'El proveedor de prueba la está procesando; aún no se ha devuelto.',
    indeterminate:
      'El proveedor no confirmó el resultado. No se da por devuelta hasta que se verifique.',
    succeeded: 'Importe devuelto al método de pago de prueba.',
    failed: 'El importe no se devolvió.',
    canceled: 'El importe no se devolvió.',
  },
  uncertainBanner:
    'Hay devoluciones pendientes de verificación. Este justificante NO las cuenta como devueltas: el importe devuelto solo incluye las confirmadas.',
  openBanner:
    'Hay devoluciones en curso. Aún no cuentan como devueltas; actualiza el justificante más tarde.',
  truncatedNote:
    'Este cobro tiene 100 devoluciones o más y la API solo entrega las 100 más recientes, así que este justificante NO incluye el desglose. «Devuelto (confirmado)» es el total que informa la API. Desde aquí no se puede saber si hay devoluciones en curso o pendientes de verificación: consulta el detalle del pago.',
  refresh: 'Actualizar',
  refreshing: 'Actualizando…',
  updated: 'Justificante actualizado.',
  stale: (time) =>
    `No pudimos actualizar el justificante. Lo que ves es de las ${time} y puede estar desactualizado: no se puede imprimir hasta leerlo de nuevo.`,
};

const EN: PosReceiptMessages = {
  pageTitle: 'Receipt',
  docTitle: 'Payment receipt',
  notFiscal:
    'Operational receipt from the test environment. It is not an invoice or a tax document: no tax numbering, no taxes.',
  sandbox: 'Simulated money (sandbox).',
  organization: 'Organization',
  merchant: 'Merchant',
  concept: 'Description',
  noConcept: 'No description',
  saleUnlinked: 'Charge without a linked sale (predates sale tracking).',
  amountCharged: 'Amount charged',
  saleAmount: 'Sale amount',
  statusLabel: 'Status',
  status: {
    succeeded: 'Charge confirmed',
    partially_refunded: 'Charge confirmed · partially refunded',
    refunded: 'Charge confirmed · fully refunded',
  },
  checkoutCompleted: 'Checkout completed',
  checkoutCompletedMissing: 'Not reported by the API',
  paymentCreated: 'Charge started',
  reference: 'Reference',
  referenceHint: 'Last 8 characters of the charge identifier.',
  readAt: (t) => `Read at: ${t}`,
  print: 'Print receipt',
  printStale:
    'RECEIPT NOT VALID: the last read failed and this data may be out of date. Read it again before printing.',
  printHint:
    'When printing, this page address is replaced with one without identifiers. Still, turn off "Headers and footers" in the print dialog: that setting belongs to the browser, not the app.',
  back: 'Back to POS',
  open: 'View receipt',
  loading: 'Loading receipt…',
  loadError: 'We could not read this charge. An incomplete receipt is never shown.',
  retry: 'Retry',
  notFound: 'We could not find this charge in the organization.',
  notCharged:
    'The API has not confirmed this charge: there is no receipt. Check its status in the POS.',
  authLost: 'Your session expired. For security the receipt is hidden.',
  signIn: 'Sign in again',
  docTitleRefunds: 'Payment and refund receipt',
  refundsTitle: 'Refunds',
  refundsNone: 'No refunds recorded.',
  refundedConfirmed: 'Refunded (confirmed)',
  refundStatus: {
    created: 'In progress',
    processing: 'In progress',
    indeterminate: 'Pending verification',
    succeeded: 'Refunded',
    failed: 'Not refunded (declined)',
    canceled: 'Not refunded (canceled)',
  },
  refundDetail: {
    created: 'Recorded; not refunded yet.',
    processing: 'The test provider is processing it; not refunded yet.',
    indeterminate:
      'The provider did not confirm the outcome. It is not treated as refunded until verified.',
    succeeded: 'Amount returned to the test payment method.',
    failed: 'The amount was not refunded.',
    canceled: 'The amount was not refunded.',
  },
  uncertainBanner:
    'Some refunds are pending verification. This receipt does NOT count them as refunded: the refunded amount only includes confirmed ones.',
  openBanner: 'Some refunds are in progress. They do not count as refunded yet; refresh later.',
  truncatedNote:
    'This charge has 100 or more refunds and the API only returns the 100 most recent, so this receipt does NOT include the breakdown. "Refunded (confirmed)" is the total reported by the API. From here it cannot be known whether refunds are in progress or pending verification: check the payment detail.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  updated: 'Receipt refreshed.',
  stale: (time) =>
    `We could not refresh the receipt. What you see is from ${time} and may be out of date: it cannot be printed until it is read again.`,
};

export const POS_RECEIPT_MESSAGES: Record<Locale, PosReceiptMessages> = { es: ES, en: EN };
