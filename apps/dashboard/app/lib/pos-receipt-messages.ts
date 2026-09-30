import type { Locale } from '../messages';

/**
 * Textos del justificante de cobro del POS (es/en). Es un justificante
 * OPERATIVO del sandbox: nunca se presenta como factura ni documento fiscal
 * (sin numeración fiscal, sin impuestos, sin requisitos legales de un país —
 * PEND-007/PEND-008 siguen abiertas).
 */
export interface PosReceiptMessages {
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
  back: string;
  open: string;
  loading: string;
  loadError: string;
  retry: string;
  notFound: string;
  notCharged: string;
  authLost: string;
  signIn: string;
}

const ES: PosReceiptMessages = {
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
};

const EN: PosReceiptMessages = {
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
};

export const POS_RECEIPT_MESSAGES: Record<Locale, PosReceiptMessages> = { es: ES, en: EN };
