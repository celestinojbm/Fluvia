import { orgContext } from '../../lib/org-context';
import { orgPath, readApi, type CommerceSummary, type OrderList } from '../../lib/commerce-api';
import {
  Callout,
  Empty,
  Kpi,
  OrderState,
  PageHead,
  PlanStatus,
  ReadProblem,
  SELL_ROLES,
  dateTime,
  money,
} from '../../lib/ui';

export const dynamic = 'force-dynamic';

const PERIODS = {
  today: { label: 'Hoy', days: 1 },
  '7d': { label: 'Últimos 7 días', days: 7 },
  '30d': { label: 'Últimos 30 días', days: 30 },
} as const;
type PeriodKey = keyof typeof PERIODS;

function range(key: PeriodKey): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - (PERIODS[key].days - 1) * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * Inicio del comercio. Cada indicador dice QUÉ mide, de DÓNDE sale y en qué
 * PERIODO. Nunca se presenta lo vendido como saldo disponible, ni un cobro en
 * curso como ingreso, ni un plan de cuotas simulado como cobro.
 */
export default async function OrgHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { orgId } = await params;
  const { period } = await searchParams;
  const key: PeriodKey = period && period in PERIODS ? (period as PeriodKey) : 'today';
  const { token, role } = await orgContext(orgId);
  const r = range(key);
  const [summary, recent] = await Promise.all([
    readApi<CommerceSummary>(token, orgPath(orgId, `/commerce/summary?from=${r.from}&to=${r.to}`)),
    readApi<OrderList>(token, orgPath(orgId, '/orders?limit=8')),
  ]);
  const o = `/o/${orgId}`;
  const canSell = role !== undefined && SELL_ROLES.has(role);

  return (
    <main className="fx-page" aria-labelledby="home-title">
      <PageHead
        id="home-title"
        title="Inicio"
        description="Resumen operativo del comercio. Datos de sandbox: dinero simulado."
        actions={
          canSell ? (
            <a className="fx-btn fx-btn-primary" href={`${o}/sell`}>
              Nueva venta
            </a>
          ) : null
        }
      />

      <nav aria-label="Accesos rápidos" className="fx-quick" style={{ marginBottom: 24 }}>
        <a className="is-primary" href={`${o}/sell`}>
          Nueva venta
        </a>
        <a href={`${o}/catalog`}>Catálogo</a>
        <a href={`${o}/customers`}>Clientes</a>
        <a href={`${o}/cash`}>Caja</a>
        <a href={`${o}/orders`}>Ventas</a>
      </nav>

      <section aria-labelledby="kpi-title">
        <div className="fx-head" style={{ marginBottom: 12 }}>
          <h2 id="kpi-title" style={{ margin: 0, fontSize: '1.15rem' }}>
            Indicadores · {PERIODS[key].label}
          </h2>
          <nav aria-label="Periodo de los indicadores" className="fx-actions">
            {(Object.keys(PERIODS) as PeriodKey[]).map((k) => (
              <a
                key={k}
                className="fx-btn fx-btn-sm"
                href={`${o}?period=${k}`}
                aria-current={k === key ? 'true' : undefined}
                style={k === key ? { borderColor: 'var(--fx-river)', fontWeight: 800 } : undefined}
              >
                {PERIODS[k].label}
              </a>
            ))}
          </nav>
        </div>
        {summary.kind !== 'ok' ? (
          <ReadProblem kind={summary.kind} what="los indicadores" />
        ) : (
          <>
            <p className="fx-hint" style={{ marginBottom: 12 }}>
              Periodo en UTC: {dateTime(summary.data.period.start)} –{' '}
              {dateTime(summary.data.period.end)} (fin exclusivo). Las cifras se agrupan por moneda:
              nunca se suman monedas distintas.
            </p>
            <div className="fx-kpis">
              <Kpi
                title="Cobros confirmados"
                list={summary.data.confirmed_charges}
                meaning="importe bruto cobrado; NO es saldo disponible (pendiente de liquidación)"
                source="pagos confirmados por el proveedor (todos los canales), por fecha de creación"
              />
              <Kpi
                title="Cobros sin confirmar"
                tone="warn"
                list={summary.data.charges_in_flight}
                meaning="en curso o con resultado incierto: no son ingresos, no cobres de nuevo"
                source="pagos en proceso ahora mismo (instantánea, sin periodo)"
                emptyLabel="Ninguno ahora"
              />
              <Kpi
                title="Devoluciones confirmadas"
                tone="neutral"
                list={summary.data.refunds_confirmed}
                meaning="importe devuelto al comprador"
                source="devoluciones con desenlace confirmado, por fecha de creación"
              />
              <Kpi
                title="Ventas registradas"
                tone="neutral"
                list={summary.data.orders_created}
                meaning="importe de los pedidos creados, cobrados o no"
                source="pedidos del comercio creados en el periodo"
              />
              <Kpi
                title="Ventas pendientes de cobro"
                tone="neutral"
                list={summary.data.orders_awaiting_payment}
                meaning="pedidos del periodo sin cobro en curso ni hecho"
                source="pedidos del periodo × estado real de sus cobros"
                emptyLabel="Ninguna"
              />
              <Kpi
                title="Cuotas aprobadas (simulación)"
                tone="sim"
                list={summary.data.installments_sandbox_approved}
                meaning="planes SIMULADOS: no son cobros, ingresos ni saldo"
                source="proveedor de cuotas simulado del sandbox"
                emptyLabel="Ninguna"
              />
            </div>
            {summary.data.refunds_open.length > 0 ? (
              <Callout tone="warn" title="Devoluciones sin desenlace">
                <p>
                  Hay devoluciones registradas que aún no tienen resultado confirmado. Revísalas en{' '}
                  <a href={`${o}/refunds`}>Devoluciones</a>.
                </p>
              </Callout>
            ) : null}
          </>
        )}
      </section>

      <section className="fx-panel" aria-labelledby="recent-title">
        <header>
          <h2 id="recent-title">Actividad reciente de ventas</h2>
          <a className="fx-link" href={`${o}/orders`}>
            Ver todas las ventas
          </a>
        </header>
        <div className="fx-panel-body" style={{ paddingTop: 8 }}>
          {recent.kind !== 'ok' ? (
            <ReadProblem kind={recent.kind} what="las ventas" />
          ) : recent.data.data.length === 0 ? (
            <Empty title="Aún no hay ventas">
              <p>Crea la primera desde el catálogo: elige productos, revisa y cobra.</p>
              {canSell ? (
                <a className="fx-btn fx-btn-primary" href={`${o}/sell`}>
                  Nueva venta
                </a>
              ) : null}
            </Empty>
          ) : (
            <div className="fx-table-wrap">
              <table className="fx-table is-stack">
                <caption className="sr-only">Últimas ventas del comercio</caption>
                <thead>
                  <tr>
                    <th scope="col">Venta</th>
                    <th scope="col">Cliente</th>
                    <th scope="col">Estado</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recent.data.data.map((ord) => (
                    <tr key={ord.id}>
                      <td data-label="Venta">
                        <a className="fx-link" href={`${o}/orders/${ord.id}`}>
                          Venta #{ord.number}
                        </a>
                        <span className="fx-cell-sub">{dateTime(ord.created_at)}</span>
                      </td>
                      <td data-label="Cliente">{ord.customer_name ?? 'Sin cliente'}</td>
                      <td data-label="Estado">
                        <OrderState state={ord.payment.state} />
                        {ord.installments_sandbox ? (
                          <span className="fx-cell-sub">
                            <PlanStatus status={ord.installments_sandbox.status} />
                          </span>
                        ) : null}
                      </td>
                      <td data-label="Total" className="num">
                        {money(ord.total, ord.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
