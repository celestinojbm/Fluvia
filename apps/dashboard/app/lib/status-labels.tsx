import type { Locale } from '../messages';
import { POS_REFUND_MESSAGES } from './pos-refund-messages';

/**
 * Estados en lenguaje del comercio (es/en) para las superficies del recorrido
 * panel → POS → pagos → devoluciones. El código técnico de la API NO se pierde:
 * viaja en `data-status`, en `title` y, donde ayuda (detalle), visible en
 * `<code>`. Un estado que la UI no conoce se muestra tal cual (nunca se
 * inventa un significado).
 *
 * Fuente de los estados: FSMs de `@fluvia/payments-core` (fsm.ts) y el DDL de
 * checkout sessions / payment links. Las devoluciones reutilizan los textos
 * del POS (`pos-refund-messages.ts`) para que el cajero vea la MISMA palabra en
 * el terminal, el detalle y el justificante.
 */

export type StatusKind = 'intent' | 'session' | 'refund' | 'link';

const INTENT: Record<Locale, Record<string, string>> = {
  es: {
    created: 'Creado',
    requires_payment_method: 'Esperando al cliente',
    requires_confirmation: 'Pendiente de confirmar',
    requires_action: 'Requiere acción del cliente',
    processing: 'En proceso',
    authorized: 'Autorizado',
    partially_captured: 'Capturado en parte',
    succeeded: 'Aprobado',
    failed: 'Rechazado',
    canceled: 'Cancelado',
    partially_refunded: 'Devuelto en parte',
    refunded: 'Devuelto',
  },
  en: {
    created: 'Created',
    requires_payment_method: 'Waiting for the customer',
    requires_confirmation: 'Awaiting confirmation',
    requires_action: 'Customer action required',
    processing: 'Processing',
    authorized: 'Authorized',
    partially_captured: 'Partially captured',
    succeeded: 'Approved',
    failed: 'Declined',
    canceled: 'Canceled',
    partially_refunded: 'Partially refunded',
    refunded: 'Refunded',
  },
};

const SESSION: Record<Locale, Record<string, string>> = {
  es: { open: 'Checkout abierto', completed: 'Checkout completado', expired: 'Checkout expirado' },
  en: { open: 'Checkout open', completed: 'Checkout completed', expired: 'Checkout expired' },
};

const LINK: Record<Locale, Record<string, string>> = {
  es: { active: 'Activo', disabled: 'Desactivado' },
  en: { active: 'Active', disabled: 'Disabled' },
};

const CAPTURE: Record<Locale, Record<string, string>> = {
  es: { automatic: 'Automática', manual: 'Manual' },
  en: { automatic: 'Automatic', manual: 'Manual' },
};

function table(kind: StatusKind, locale: Locale): Record<string, string> {
  if (kind === 'intent') return INTENT[locale];
  if (kind === 'session') return SESSION[locale];
  if (kind === 'link') return LINK[locale];
  return POS_REFUND_MESSAGES[locale].status as Record<string, string>;
}

/** Etiqueta legible; un estado desconocido se devuelve sin traducir. */
export function statusLabel(kind: StatusKind, status: string, locale: Locale): string {
  return Object.hasOwn(table(kind, locale), status) ? table(kind, locale)[status]! : status;
}

export function captureMethodLabel(method: string, locale: Locale): string {
  return Object.hasOwn(CAPTURE[locale], method) ? CAPTURE[locale][method]! : method;
}

/**
 * Insignia de estado. Mantiene la clase `badge badge-<estado>` (colores
 * existentes) y el código técnico en `data-status`/`title`; `showCode` lo
 * muestra además junto a la etiqueta (vistas de detalle).
 */
export function StatusBadge({
  kind,
  status,
  locale,
  showCode = false,
}: {
  kind: StatusKind;
  status: string;
  locale: Locale;
  showCode?: boolean;
}) {
  const label = statusLabel(kind, status, locale);
  return (
    <>
      <span className={`badge badge-${status}`} data-status={status} title={status}>
        {label}
      </span>
      {showCode && label !== status && (
        <>
          {' '}
          <code className="status-code">{status}</code>
        </>
      )}
    </>
  );
}
