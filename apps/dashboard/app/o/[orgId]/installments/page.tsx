import { orgContext } from '../../../lib/org-context';
import { orgPath, readApi, type InstallmentPlan } from '../../../lib/commerce-api';
import {
  Callout,
  Empty,
  PageHead,
  PlanStatus,
  ReadProblem,
  dateTime,
  money,
} from '../../../lib/ui';

export const dynamic = 'force-dynamic';

const SIM_NOTICE =
  'Simulación de experiencia. No hay financiador, crédito real, cobro externo, intereses ni mora. Un plan aprobado NO cobra la venta ni aumenta saldos.';

export default async function InstallmentsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { token } = await orgContext(orgId);
  const list = await readApi<{ data: InstallmentPlan[] }>(
    token,
    orgPath(orgId, '/installment_plans')
  );
  const o = `/o/${orgId}`;
  return (
    <main className="fx-page" aria-labelledby="inst-title">
      <PageHead
        id="inst-title"
        title="Pagar en cuotas"
        description="Planes solicitados por compradores desde el checkout (proveedor simulado)."
      />
      <Callout tone="sim" title="Módulo en simulación">
        <p>{SIM_NOTICE}</p>
        <p>
          Número de cuotas, periodicidad y condiciones son{' '}
          <strong>parámetros de demostración</strong>, no una política comercial aprobada.
        </p>
      </Callout>
      <section className="fx-panel" aria-labelledby="inst-list-title">
        <header>
          <h2 id="inst-list-title">Planes recientes</h2>
          <span className="fx-hint">Últimos 50</span>
        </header>
        <div className="fx-panel-body" style={{ paddingTop: 8 }}>
          {list.kind !== 'ok' ? (
            <ReadProblem kind={list.kind} what="los planes de cuotas" />
          ) : list.data.data.length === 0 ? (
            <Empty title="Aún no hay planes">
              <p>El comprador elige «Pagar en cuotas» en el checkout de una venta con productos.</p>
            </Empty>
          ) : (
            <div className="fx-table-wrap">
              <table className="fx-table is-stack">
                <caption className="sr-only">Planes de cuotas simulados</caption>
                <thead>
                  <tr>
                    <th scope="col">Plan</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Cuotas</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((p) => {
                    const paid = p.installments.filter((i) => i.status === 'paid_simulated').length;
                    const overdue = p.installments.filter(
                      (i) => i.status === 'overdue_simulated'
                    ).length;
                    return (
                      <tr key={p.id}>
                        <td data-label="Plan">
                          <a className="fx-link" href={`${o}/installments/${p.id}`}>
                            Venta #{p.order_number}
                          </a>
                          <span className="fx-cell-sub">{dateTime(p.created_at)}</span>
                        </td>
                        <td data-label="Estado">
                          <PlanStatus status={p.status} />
                        </td>
                        <td data-label="Cuotas">
                          {paid}/{p.installments_count} pagadas
                          {overdue ? ` · ${overdue} vencida${overdue > 1 ? 's' : ''}` : ''}
                        </td>
                        <td data-label="Total" className="num">
                          {money(p.total, p.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
