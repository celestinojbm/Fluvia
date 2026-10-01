import { orgContext } from '../../../lib/org-context';
import { orgPath, readApi, type CashSummary } from '../../../lib/commerce-api';
import { Callout, Empty, PageHead, ReadProblem, dateOnly, money } from '../../../lib/ui';

export const dynamic = 'force-dynamic';

const REFUND_LABEL: Record<string, string> = {
  succeeded: 'Confirmadas',
  created: 'Registradas (sin enviar)',
  processing: 'En proceso',
  indeterminate: 'Sin confirmar (incierto)',
  failed: 'Fallidas',
  canceled: 'Canceladas',
};
const PLAN_LABEL: Record<string, string> = {
  approved: 'Aprobados',
  pending: 'Pendientes',
  declined: 'Rechazados',
};

/**
 * Caja: resumen OPERATIVO de un día (UTC) con los datos que el sistema puede
 * demostrar. No es un arqueo ni un cierre contable: no hay efectivo, fondo de
 * caja, turnos ni conteo físico en esta versión (se declara en pantalla).
 */
export default async function CashPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { orgId } = await params;
  const { date: rawDate } = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && rawDate <= today ? rawDate : today;
  const { token } = await orgContext(orgId);
  const cash = await readApi<CashSummary>(
    token,
    orgPath(orgId, `/commerce/cash?from=${date}&to=${date}`)
  );
  const prev = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const o = `/o/${orgId}`;

  return (
    <main className="fx-page" aria-labelledby="cash-title">
      <PageHead
        id="cash-title"
        title="Caja"
        description={`Resumen operativo del ${dateOnly(date)} (día UTC).`}
        actions={
          <nav aria-label="Cambiar de día" className="fx-actions">
            <a className="fx-btn fx-btn-sm" href={`${o}/cash?date=${prev}`}>
              ← Día anterior
            </a>
            {date < today ? (
              <a className="fx-btn fx-btn-sm" href={`${o}/cash?date=${next}`}>
                Día siguiente →
              </a>
            ) : null}
          </nav>
        }
      />
      <form className="fx-toolbar" method="get" aria-label="Elegir día">
        <div className="fx-field" style={{ flex: '0 1 14rem' }}>
          <label htmlFor="cash-date">Día</label>
          <input
            id="cash-date"
            name="date"
            type="date"
            className="fx-input"
            defaultValue={date}
            max={today}
          />
        </div>
        <button type="submit" className="fx-btn">
          Ver
        </button>
      </form>
      <Callout tone="info" title="Qué es y qué no es este resumen">
        <p>
          Suma cobros y devoluciones registrados por el sistema ese día.{' '}
          <strong>No es un arqueo</strong> ni un cierre contable: no hay efectivo, fondo de caja,
          turnos ni conteo físico en esta versión. El «neto operativo» no es saldo disponible.
        </p>
        <p>
          Método de pago: la API no registra hoy el método usado en cada cobro (tarjeta o
          transferencia de prueba); se distingue por <strong>canal</strong> (venta del POS u otro).
        </p>
      </Callout>
      {cash.kind !== 'ok' ? (
        <ReadProblem kind={cash.kind} what="la caja" />
      ) : (
        <div className="fx-grid fx-grid-2">
          <section className="fx-panel" aria-labelledby="cash-in">
            <header>
              <h2 id="cash-in">Cobros confirmados</h2>
            </header>
            <div className="fx-panel-body">
              {cash.data.confirmed_by_channel.length === 0 ? (
                <Empty title="Sin cobros confirmados este día" />
              ) : (
                <table className="fx-table">
                  <caption className="sr-only">Cobros confirmados por canal</caption>
                  <thead>
                    <tr>
                      <th scope="col">Canal</th>
                      <th scope="col" className="num">
                        Operaciones
                      </th>
                      <th scope="col" className="num">
                        Importe
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cash.data.confirmed_by_channel.map((f) => (
                      <tr key={`${f.channel}-${f.currency}`}>
                        <td>
                          {f.channel === 'pos_order' ? 'Ventas del POS' : 'Otros (enlaces, API)'}
                        </td>
                        <td className="num">{f.count}</td>
                        <td className="num">{money(f.amount, f.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
          <section className="fx-panel" aria-labelledby="cash-out">
            <header>
              <h2 id="cash-out">Devoluciones</h2>
            </header>
            <div className="fx-panel-body">
              {cash.data.refunds_by_status.length === 0 ? (
                <Empty title="Sin devoluciones este día" />
              ) : (
                <table className="fx-table">
                  <caption className="sr-only">Devoluciones por estado</caption>
                  <thead>
                    <tr>
                      <th scope="col">Estado</th>
                      <th scope="col" className="num">
                        Operaciones
                      </th>
                      <th scope="col" className="num">
                        Importe
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cash.data.refunds_by_status.map((f) => (
                      <tr key={`${f.status}-${f.currency}`}>
                        <td>{REFUND_LABEL[f.status] ?? f.status}</td>
                        <td className="num">{f.count}</td>
                        <td className="num">{money(f.amount, f.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
          <section className="fx-panel" aria-labelledby="cash-net">
            <header>
              <h2 id="cash-net">Neto operativo</h2>
            </header>
            <div className="fx-panel-body">
              {cash.data.net_operational.length === 0 ? (
                <Empty title="Sin movimientos" />
              ) : (
                cash.data.net_operational.map((n) => (
                  <p key={n.currency} className="fx-kpi-value">
                    {money(n.amount, n.currency)}
                  </p>
                ))
              )}
              <p className="fx-panel-note">
                Cobros confirmados − devoluciones confirmadas del día, por moneda. No descuenta
                comisiones ni representa fondos liquidados.
              </p>
            </div>
          </section>
          <section className="fx-panel" aria-labelledby="cash-sim">
            <header>
              <h2 id="cash-sim">
                Cuotas <span className="fx-pill-sim">Simulación</span>
              </h2>
            </header>
            <div className="fx-panel-body">
              {cash.data.installments_sandbox_by_status.length === 0 ? (
                <Empty title="Sin planes de cuotas este día" />
              ) : (
                <table className="fx-table">
                  <caption className="sr-only">Planes de cuotas simulados por estado</caption>
                  <tbody>
                    {cash.data.installments_sandbox_by_status.map((f) => (
                      <tr key={`${f.status}-${f.currency}`}>
                        <td>{PLAN_LABEL[f.status] ?? f.status}</td>
                        <td className="num">{f.count}</td>
                        <td className="num">{money(f.amount, f.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="fx-panel-note">Excluidos del neto: una simulación no mueve dinero.</p>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
