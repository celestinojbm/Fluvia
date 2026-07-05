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
  pay: string;
  paying: string;
  statusOpen: string;
  statusCompleted: string;
  statusExpired: string;
  paymentFailed: string;
  paymentPending: string;
  loadError: string;
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
    methodAsync: 'PSE de prueba (asíncrono)',
    pay: 'Pagar',
    paying: 'Procesando…',
    statusOpen: 'Pago pendiente',
    statusCompleted: '¡Pago completado! Puedes cerrar esta ventana.',
    statusExpired: 'Esta sesión de pago expiró.',
    paymentFailed: 'El pago fue rechazado. Inténtalo con otro método.',
    paymentPending: 'Tu pago se está procesando. Te avisaremos cuando se confirme.',
    loadError: 'No pudimos cargar el pago. Reintenta en unos segundos.',
    notFound: 'Enlace de pago inválido o expirado.',
    sandboxNotice: 'Entorno de pruebas — no se mueve dinero real.',
  },
  en: {
    title: 'Complete payment',
    amountLabel: 'Amount due',
    methodLegend: 'Choose a payment method (sandbox)',
    methodApprove: 'Test card (approved)',
    methodDecline: 'Test card (declined)',
    methodAsync: 'Test PSE (asynchronous)',
    pay: 'Pay',
    paying: 'Processing…',
    statusOpen: 'Payment pending',
    statusCompleted: 'Payment complete! You can close this window.',
    statusExpired: 'This payment session has expired.',
    paymentFailed: 'The payment was declined. Try another method.',
    paymentPending: 'Your payment is processing. We will confirm shortly.',
    loadError: 'We could not load the payment. Retry in a few seconds.',
    notFound: 'Invalid or expired payment link.',
    sandboxNotice: 'Test environment — no real money moves.',
  },
};

const MINOR_UNIT_CURRENCIES = new Set(['COP', 'JPY', 'CLP']); // exponente 0

/** Formatea unidades menores según la moneda y el locale. */
export function formatAmount(amountMinor: number, currency: string, locale: Locale): string {
  const zeroExponent = MINOR_UNIT_CURRENCIES.has(currency);
  const value = zeroExponent ? amountMinor : amountMinor / 100;
  try {
    return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'es-CO', {
      style: 'currency',
      currency,
      minimumFractionDigits: zeroExponent ? 0 : 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}
