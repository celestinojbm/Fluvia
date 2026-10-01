/**
 * i18n mínimo (es/en) sin dependencias: un diccionario por locale. La página
 * de checkout es una superficie acotada; no justifica una librería de i18n.
 * El locale llega por `?lang=` (default es — Colombia).
 */

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export function normalizeLocale(raw: string | null | undefined): Locale {
  return raw === 'en' ? 'en' : 'es';
}

interface Messages {
  title: string;
  amountLabel: string;
  methodLegend: string;
  methodApprove: string;
  methodDecline: string;
  methodAsync: string;
  methodFluvia: string;
  fluviaCodeLabel: string;
  fluviaCodeHint: string;
  fluviaCodeInvalid: string;
  pay: string;
  paying: string;
  statusOpen: string;
  statusCompleted: string;
  statusExpired: string;
  paymentFailed: string;
  paymentPending: string;
  saleClosed: string;
  saleCancelled: string;
  payTo: string;
  securedBy: string;
  loadError: string;
  retry: string;
  paymentUncertain: string;
  checkStatus: string;
  checking: string;
  notFound: string;
  sandboxNotice: string;
}

export const MESSAGES: Record<Locale, Messages> = {
  es: {
    title: 'Finalizar pago',
    amountLabel: 'Total a pagar',
    methodLegend: 'Elige un método de pago (sandbox)',
    methodApprove: 'Tarjeta de prueba (aprobada)',
    methodDecline: 'Tarjeta de prueba (rechazada)',
    methodAsync: 'Transferencia de prueba (asíncrona)',
    methodFluvia: 'Fluvia Personal (saldo o cuotas)',
    fluviaCodeLabel: 'Código de pago de Fluvia Personal',
    fluviaCodeHint:
      'Genéralo en tu app Fluvia Personal (Tarjetas → Pagar en comercio). Es de un solo uso y caduca en 10 minutos.',
    fluviaCodeInvalid: 'Pega el código completo (empieza por fcp_).',
    pay: 'Pagar',
    paying: 'Procesando…',
    statusOpen: 'Pago pendiente',
    statusCompleted: '¡Pago completado! Puedes cerrar esta ventana.',
    statusExpired: 'Esta sesión de pago expiró.',
    paymentFailed: 'El pago fue rechazado. Pide al comercio un nuevo enlace de pago.',
    paymentPending: 'Tu pago se está procesando. Esta página se actualiza sola.',
    saleClosed:
      'Esta compra ya tiene otro pago aprobado o en curso. No pagues aquí: si tienes dudas, consulta con el comercio.',
    saleCancelled: 'El comercio anuló esta compra: ya no se puede pagar. No se te cobró nada.',
    payTo: 'Pagas a',
    securedBy: 'Pago procesado con Fluvia',
    loadError: 'No pudimos cargar el pago. Reintenta en unos segundos.',
    retry: 'Reintentar',
    paymentUncertain:
      'No pudimos confirmar el resultado del pago. No lo repitas: consulta el estado primero.',
    checkStatus: 'Consultar estado',
    checking: 'Consultando…',
    notFound: 'Enlace de pago inválido o expirado.',
    sandboxNotice: 'Entorno de pruebas — no se mueve dinero real.',
  },
  en: {
    title: 'Complete payment',
    amountLabel: 'Amount due',
    methodLegend: 'Choose a payment method (sandbox)',
    methodApprove: 'Test card (approved)',
    methodDecline: 'Test card (declined)',
    methodAsync: 'Test bank transfer (asynchronous)',
    methodFluvia: 'Fluvia Personal (balance or installments)',
    fluviaCodeLabel: 'Fluvia Personal payment code',
    fluviaCodeHint:
      'Create it in your Fluvia Personal app (Cards → Pay at a store). Single use, expires in 10 minutes.',
    fluviaCodeInvalid: 'Paste the full code (starts with fcp_).',
    pay: 'Pay',
    paying: 'Processing…',
    statusOpen: 'Payment pending',
    statusCompleted: 'Payment complete! You can close this window.',
    statusExpired: 'This payment session has expired.',
    paymentFailed: 'The payment was declined. Ask the merchant for a new payment link.',
    paymentPending: 'Your payment is processing. This page updates by itself.',
    saleClosed:
      'This purchase already has another approved or in-progress payment. Do not pay here: if in doubt, ask the merchant.',
    saleCancelled:
      'The merchant cancelled this purchase: it can no longer be paid. You were not charged.',
    payTo: 'Paying',
    securedBy: 'Payment processed by Fluvia',
    loadError: 'We could not load the payment. Retry in a few seconds.',
    retry: 'Retry',
    paymentUncertain:
      'We could not confirm the payment outcome. Do not repeat it: check the status first.',
    checkStatus: 'Check status',
    checking: 'Checking…',
    notFound: 'Invalid or expired payment link.',
    sandboxNotice: 'Test environment — no real money moves.',
  },
};

/** Formato exacto de importes: `lib/money-format` (idéntico al del dashboard). */
export { displayExponent, formatAmount } from './lib/money-format';
