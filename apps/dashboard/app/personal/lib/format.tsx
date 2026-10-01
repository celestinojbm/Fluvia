import { formatAmount } from '../../lib/money-format';

/** Importe exacto (unidades menores → texto) con código ISO si el símbolo es ambiguo. */
export function money(minor: string | number | bigint, currency: string): string {
  return formatAmount(minor, currency, 'es', { code: true });
}

const DATE = new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const DATE_TIME = new Intl.DateTimeFormat('es-VE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function shortDate(iso: string): string {
  return DATE.format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso));
}

export function dateTime(iso: string): string {
  return `${DATE_TIME.format(new Date(iso))} UTC`;
}

export const CARD_STATUS: Record<string, { label: string; tone: string }> = {
  requested: { label: 'Solicitada', tone: 'info' },
  inactive: { label: 'Por activar', tone: 'warn' },
  active: { label: 'Activa', tone: 'ok' },
  blocked: { label: 'Bloqueada', tone: 'bad' },
  replaced: { label: 'Reemplazada', tone: 'neutral' },
  closed: { label: 'Cerrada', tone: 'neutral' },
};

export const INSTALLMENT_STATUS: Record<string, { label: string; tone: string }> = {
  scheduled: { label: 'Pendiente', tone: 'info' },
  partially_paid: { label: 'Pago parcial', tone: 'warn' },
  paid: { label: 'Pagada', tone: 'ok' },
  overdue: { label: 'Vencida', tone: 'bad' },
  cancelled: { label: 'Anulada por devolución', tone: 'neutral' },
};

export const PURCHASE_STATUS: Record<string, { label: string; tone: string }> = {
  approved: { label: 'Autorizada', tone: 'info' },
  partially_captured: { label: 'Cobro parcial', tone: 'info' },
  captured: { label: 'Pagada', tone: 'ok' },
  reversed: { label: 'Liberada', tone: 'neutral' },
  expired: { label: 'Vencida', tone: 'neutral' },
  declined: { label: 'Rechazada', tone: 'bad' },
};

export const DECLINE_TEXT: Record<string, string> = {
  insufficient_funds: 'Saldo insuficiente',
  credit_limit_exceeded: 'Supera tu crédito disponible',
  card_blocked: 'Tarjeta bloqueada',
  card_inactive: 'Tarjeta sin activar',
  card_closed: 'Tarjeta cerrada o reemplazada',
  card_limit_exceeded: 'Supera el límite de la tarjeta',
  currency_not_supported: 'Moneda no admitida',
  consumer_inactive: 'Cuenta suspendida',
  amount_above_code_limit: 'Supera el máximo del código',
};

export function Status({ tone, label }: { tone: string; label: string }) {
  return (
    <span className={`px-status px-status-${tone}`}>
      <span className="px-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
