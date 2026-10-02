import { InstallmentActions } from '../../../../lib/installment-actions';
import { orgContext } from '../../../../lib/org-context';
import { orgPath, readApi, type InstallmentPlan } from '../../../../lib/commerce-api';
import {
  Callout,
  INSTALLMENT_LABEL,
  PageHead,
  PlanStatus,
  ReadProblem,
  SELL_ROLES,
  Status,
  dateOnly,
  dateTime,
  money,
} from '../../../../lib/ui';

export const dynamic = 'force-dynamic';

const EVENT_LABEL: Record<string, string> = {
  plan_requested: 'El comprador confirmó el plan',
  plan_approved: 'Proveedor simulado: aprobado',
  plan_declined: 'Proveedor simulado: rechazado',
  installment_paid_simulated: 'Cuota pagada (evento simulado)',
  installment_overdue_simulated: 'Cuota vencida (evento simulado)',
};
const ACTOR_LABEL = {
  buyer: 'Comprador',
  simulated_provider: 'Proveedor simulado',
  operator: 'Operador del sandbox',
};

export default async function PlanPage({
  params,
}: {
  params: Promise<{ orgId: string; planId: string }>;
}) {
  const { orgId, planId } = await params;
  const { token, role } = await orgContext(orgId);
  const read = /^[0-9a-f-]{36}$/i.test(planId)
    ? await readApi<InstallmentPlan>(token, orgPath(orgId, `/installment_plans/${planId}`))
    : ({ kind: 'not_found' } as const);
  const o = `/o/${orgId}`;
  if (read.kind !== 'ok') {
    return (
      <main className="fx-page" aria-labelledby="plan-title">
        <PageHead
          id="plan-title"
          title="Plan de cuotas"
          crumb={{ href: `${o}/installments`, label: 'Cuotas' }}
        />
        <ReadProblem kind={read.kind} what="este plan" />
      </main>
    );
  }
  const p = read.data;
  return (
    <main className="fx-page" aria-labelledby="plan-title">
      <PageHead
        id="plan-title"
        title={`Cuotas · Venta #${p.order_number}`}
        description={`Confirmado por el comprador ${dateTime(p.buyer_confirmed_at)}`}
        crumb={{ href: `${o}/installments`, label: 'Cuotas' }}
        actions={
          <a className="fx-btn" href={`${o}/orders/${p.order_id}`}>
            Ver la venta
          </a>
        }
      />
      <Callout tone="sim" title="Simulación">
        <p>
          Este plan no es un cobro ni un crédito: la venta sigue sin cobrar y ningún saldo cambia.
          Parámetros de demostración <code>{p.terms_version}</code>: {p.installments_count} cuotas
          cada {p.interval_days} días, sin intereses ni comisiones. Escenario de prueba elegido:{' '}
          <strong>{p.scenario}</strong>.
        </p>
      </Callout>
      <div className="fx-grid fx-grid-main">
        <section className="fx-panel" aria-labelledby="sched-title">
          <header>
            <h2 id="sched-title">Calendario</h2>
            <PlanStatus status={p.status} />
          </header>
          <div className="fx-panel-body">
            <ol className="fx-schedule" aria-label="Cuotas del plan">
              {p.installments.map((i) => {
                const s = INSTALLMENT_LABEL[i.status] ?? {
                  label: i.status,
                  tone: 'neutral' as const,
                };
                return (
                  <li key={i.seq}>
                    <span className="fx-seq" aria-hidden="true">
                      {i.seq}
                    </span>
                    <span>
                      <span className="fx-cell-main">
                        {i.seq === 1 ? 'Importe inicial' : `Cuota ${i.seq}`} · vence{' '}
                        {dateOnly(i.due_date)}
                      </span>
                      <span className="fx-cell-sub">
                        <Status tone={s.tone} code={i.status}>
                          {s.label}
                        </Status>
                      </span>
                    </span>
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {money(i.amount, p.currency)}
                    </strong>
                  </li>
                );
              })}
            </ol>
            <p
              className="fx-cell-main"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                borderTop: '2px solid var(--fl-black)',
                paddingTop: 12,
              }}
            >
              <span>Total del plan</span>
              <span>{money(p.total, p.currency)}</span>
            </p>
            <p className="fx-hint">
              Las fechas son informativas: el estado de cada cuota solo cambia por un evento
              simulado explícito, nunca por el paso del tiempo.
            </p>
          </div>
        </section>
        <div className="fx-grid">
          <section className="fx-panel" aria-labelledby="sim-title">
            <header>
              <h2 id="sim-title">Eventos simulados</h2>
            </header>
            <div className="fx-panel-body">
              <InstallmentActions
                orgId={orgId}
                plan={p}
                canAct={role !== undefined && SELL_ROLES.has(role)}
              />
            </div>
          </section>
          <section className="fx-panel" aria-labelledby="hist-title">
            <header>
              <h2 id="hist-title">Historial</h2>
            </header>
            <div className="fx-panel-body">
              <ol className="fx-cart-lines">
                {p.events.map((e, idx) => (
                  <li key={idx} className="fx-cart-line" style={{ gridTemplateColumns: '1fr' }}>
                    <span>
                      <span className="fx-cell-main">
                        {EVENT_LABEL[e.kind] ?? e.kind}
                        {e.seq ? ` · cuota ${e.seq}` : ''}
                      </span>
                      <span className="fx-cell-sub">
                        {ACTOR_LABEL[e.actor]} · {dateTime(e.created_at)}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
