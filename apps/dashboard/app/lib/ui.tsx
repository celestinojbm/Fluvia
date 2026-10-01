import type { ReactNode } from 'react';
import { formatAmount } from '../messages';
import type { Figure, OrderPaymentState } from './commerce-api';

/**
 * Piezas de presentación compartidas de la plataforma (server-safe, sin
 * estado). Un solo lugar para el lenguaje del comercio: estados, importes,
 * fechas y los estados de página (vacío, error, sin acceso, sesión caducada).
 */

export const ROLE_LABELS: Record<string, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  developer: 'Desarrollo',
  finance: 'Finanzas',
  support: 'Soporte',
  analyst: 'Análisis',
  read_only: 'Solo lectura',
};

export const roleLabel = (role: string | undefined) =>
  role ? (ROLE_LABELS[role] ?? role) : 'Sin rol';

/** Roles que crean ventas, clientes y eventos simulados (`reconciliation:manage`). */
export const SELL_ROLES = new Set(['owner', 'admin', 'finance']);
/** Roles que editan el catálogo (`merchants:write`). */
export const CATALOG_ROLES = new Set(['owner', 'admin']);

export function money(amount: number, currency: string): string {
  return formatAmount(amount, currency, 'es');
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return (
      new Intl.DateTimeFormat('es-CO', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(iso)) + ' UTC'
    );
  } catch {
    return iso;
  }
}

export function dateOnly(isoDate: string): string {
  try {
    return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(`${isoDate.slice(0, 10)}T00:00:00Z`)
    );
  } catch {
    return isoDate;
  }
}

type Tone = 'ok' | 'warn' | 'bad' | 'sim' | 'info' | 'neutral';

export function Status({
  tone,
  children,
  code,
}: {
  tone: Tone;
  children: ReactNode;
  code?: string;
}) {
  return (
    <span className="fx-status" data-tone={tone} data-status={code} title={code}>
      {children}
    </span>
  );
}

export const ORDER_STATE_LABEL: Record<OrderPaymentState, { label: string; tone: Tone }> = {
  awaiting_payment: { label: 'Pendiente de cobro', tone: 'neutral' },
  payment_in_progress: { label: 'Cobro en curso · sin confirmar', tone: 'warn' },
  paid: { label: 'Cobrada', tone: 'ok' },
  partially_refunded: { label: 'Devolución parcial', tone: 'info' },
  refunded: { label: 'Devuelta', tone: 'info' },
  cancelled: { label: 'Anulada', tone: 'neutral' },
};

export function OrderState({ state }: { state: OrderPaymentState }) {
  const s = ORDER_STATE_LABEL[state] ?? { label: state, tone: 'neutral' as Tone };
  return (
    <Status tone={s.tone} code={state}>
      {s.label}
    </Status>
  );
}

export const PLAN_STATUS_LABEL: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Cuotas · pendiente (simulación)', tone: 'warn' },
  approved: { label: 'Cuotas · aprobado (simulación)', tone: 'sim' },
  declined: { label: 'Cuotas · rechazado (simulación)', tone: 'bad' },
};

export function PlanStatus({ status }: { status: string }) {
  const s = PLAN_STATUS_LABEL[status] ?? { label: status, tone: 'neutral' as Tone };
  return (
    <Status tone={s.tone} code={status}>
      {s.label}
    </Status>
  );
}

export const INSTALLMENT_LABEL: Record<string, { label: string; tone: Tone }> = {
  scheduled: { label: 'Programada', tone: 'neutral' },
  paid_simulated: { label: 'Pagada (simulada)', tone: 'ok' },
  overdue_simulated: { label: 'Vencida (simulada)', tone: 'bad' },
};

export function PageHead({
  title,
  description,
  crumb,
  actions,
  id,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  crumb?: { href: string; label: string };
  actions?: ReactNode;
  id?: string;
  /** Antetítulo de contexto (organización, periodo…). */
  eyebrow?: ReactNode;
}) {
  return (
    <header className="fx-head">
      <div>
        {crumb ? (
          <p className="fx-crumb">
            <a href={crumb.href}>← {crumb.label}</a>
          </p>
        ) : null}
        {eyebrow ? <p className="fx-eyebrow">{eyebrow}</p> : null}
        <h1 id={id}>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="fx-actions">{actions}</div> : null}
    </header>
  );
}

export function Callout({
  tone,
  title,
  children,
  role,
}: {
  tone: 'warn' | 'bad' | 'ok' | 'sim' | 'info';
  title?: string;
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div className="fx-callout" data-tone={tone} role={role}>
      <div>
        {title ? (
          <p>
            <strong>{title}</strong>
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="fx-empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** Estado de página para una lectura fallida (nunca se presenta como «vacío»). */
export function ReadProblem({
  kind,
  what,
}: {
  kind: 'unauthorized' | 'not_found' | 'forbidden' | 'error';
  what: string;
}) {
  if (kind === 'unauthorized') {
    return (
      <Callout tone="warn" title="Tu sesión caducó" role="alert">
        <p>
          Para seguir, <a href="/login">vuelve a iniciar sesión</a>. No se guardó ningún cambio
          pendiente de esta pantalla.
        </p>
      </Callout>
    );
  }
  if (kind === 'forbidden') {
    return (
      <Callout tone="warn" title="Tu rol no tiene acceso" role="alert">
        <p>No puedes ver {what} con tu rol actual. Pide acceso a un propietario o administrador.</p>
      </Callout>
    );
  }
  if (kind === 'not_found') {
    return (
      <Callout tone="warn" title="No encontrado" role="alert">
        <p>No existe {what} en esta organización (o pertenece a otra a la que no tienes acceso).</p>
      </Callout>
    );
  }
  return (
    <Callout tone="bad" title="No pudimos cargar los datos" role="alert">
      <p>
        Falló la lectura de {what}. Esto no significa que no haya datos: recarga la página para
        reintentar.
      </p>
    </Callout>
  );
}

/** Importes por moneda: jamás se suman monedas distintas. */
export function Figures({ list, emptyLabel }: { list: Figure[]; emptyLabel: string }) {
  if (list.length === 0) return <p className="fx-kpi-empty">{emptyLabel}</p>;
  return (
    <>
      {list.map((f) => (
        <p className="fx-kpi-value" key={f.currency}>
          {money(f.amount, f.currency)}
          <span className="sr-only"> en {f.count} operaciones</span>
        </p>
      ))}
    </>
  );
}

export function Kpi({
  title,
  list,
  meaning,
  source,
  tone = 'ok',
  emptyLabel = 'Sin movimientos',
}: {
  title: string;
  list: Figure[];
  meaning: string;
  source: string;
  tone?: 'ok' | 'warn' | 'bad' | 'sim' | 'neutral';
  emptyLabel?: string;
}) {
  const count = list.reduce((a, f) => a + f.count, 0);
  return (
    <section className="fx-kpi" data-tone={tone} aria-label={title}>
      <h3>{title}</h3>
      <Figures list={list} emptyLabel={emptyLabel} />
      <p className="fx-kpi-meta">
        {count} {count === 1 ? 'operación' : 'operaciones'} · {meaning}
      </p>
      <p className="fx-kpi-meta">Fuente: {source}</p>
    </section>
  );
}

/** Id abreviado para mostrar (••••1234). El completo queda en `title`. */
export function ShortId({ id }: { id: string }) {
  return (
    <code title={id} aria-label={`Identificador terminado en ${id.slice(-4)}`}>
      ••••{id.slice(-4)}
    </code>
  );
}
