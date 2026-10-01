import { orgContext } from '../../lib/org-context';
import {
  orgPath,
  readApi,
  type CommerceInsights,
  type CommerceSummary,
  type Figure,
  type OrderList,
  type Product,
  type Read,
} from '../../lib/commerce-api';
import { DayBars, LOW_STOCK, ProductThumb, Segmented, stockLevel } from '../../lib/commerce-ui';
import { Icon } from '../../lib/icons';
import { currencyName, formatAmount } from '../../lib/money-format';
import {
  Empty,
  OrderState,
  PageHead,
  PlanStatus,
  ReadProblem,
  SELL_ROLES,
  dateTime,
} from '../../lib/ui';

export const dynamic = 'force-dynamic';

const PERIODS = {
  today: { label: 'Hoy', days: 1 },
  '7d': { label: '7 días', days: 7 },
  '30d': { label: '30 días', days: 30 },
} as const;
type PeriodKey = keyof typeof PERIODS;

function range(key: PeriodKey): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - (PERIODS[key].days - 1) * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const pick = (list: Figure[], currency: string) =>
  list.find((f) => f.currency === currency) ?? { currency, count: 0, amount: 0 };

/** Importe con código ISO cuando el símbolo es ambiguo (panel multimoneda). */
const amount = (minor: number, currency: string) =>
  formatAmount(minor, currency, 'es', { code: true });

/**
 * Panel del comercio. Una cifra protagonista (lo COBRADO y confirmado, en la
 * moneda elegida) + evolución diaria + saldo real del ledger + franja de
 * métricas. Nunca se suman monedas; lo vendido no se presenta como saldo, ni
 * un cobro en curso como ingreso, ni un plan de cuotas simulado como cobro.
 */
export default async function OrgHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ period?: string; currency?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const key: PeriodKey = sp.period && sp.period in PERIODS ? (sp.period as PeriodKey) : 'today';
  const wanted = sp.currency && /^[A-Z]{3}$/.test(sp.currency) ? sp.currency : undefined;
  const { token, role } = await orgContext(orgId);
  const r = range(key);
  const q = `from=${r.from}&to=${r.to}`;
  const [summary, insights, recent, products] = await Promise.all([
    readApi<CommerceSummary>(token, orgPath(orgId, `/commerce/summary?${q}`)),
    readApi<CommerceInsights>(
      token,
      orgPath(orgId, `/commerce/insights?${q}${wanted ? `&currency=${wanted}` : ''}`)
    ),
    readApi<OrderList>(token, orgPath(orgId, '/orders?limit=6')),
    readApi<{ data: Product[] }>(token, orgPath(orgId, '/catalog/products?limit=500')),
  ]);
  const o = `/o/${orgId}`;
  const canSell = role !== undefined && SELL_ROLES.has(role);
  const href = (p: PeriodKey, c?: string | null) =>
    `${o}?period=${p}${c ? `&currency=${encodeURIComponent(c)}` : ''}`;

  const ins = insights.kind === 'ok' ? insights.data : null;
  const sum = summary.kind === 'ok' ? summary.data : null;
  // Monedas con actividad en el periodo (o con saldo): el selector nunca mezcla.
  const currencies = [
    ...new Set([
      ...(ins?.currencies ?? []),
      ...(sum?.orders_created.map((f) => f.currency) ?? []),
      ...(sum?.confirmed_charges.map((f) => f.currency) ?? []),
    ]),
  ];
  const cur = ins?.currency ?? currencies[0] ?? null;
  const productsById = new Map(
    (products.kind === 'ok' ? products.data.data : []).map((p) => [p.id, p])
  );
  const lowStock =
    products.kind === 'ok'
      ? products.data.data.filter((p) => !p.archived && stockLevel(p) !== 'ok' && p.track_stock)
      : [];
  const topMax = Math.max(1, ...(ins?.top_products.map((t) => t.quantity) ?? [1]));

  return (
    <main className="fx-page" aria-labelledby="home-title">
      <PageHead
        id="home-title"
        title="Inicio"
        eyebrow={`Panel · ${PERIODS[key].label}${cur ? ` · ${currencyName(cur, 'es')}` : ''}`}
        actions={
          canSell ? (
            <>
              <a className="fx-btn" href={`${o}/pos`}>
                <Icon name="terminal" /> Cobrar
              </a>
              <a className="fx-btn fx-btn-primary" href={`${o}/sell`}>
                <Icon name="plus" /> Nueva venta
              </a>
            </>
          ) : null
        }
      />

      <div className="fx-controls" style={{ marginBottom: 20 }}>
        <Segmented
          label="Periodo de los indicadores"
          items={(Object.keys(PERIODS) as PeriodKey[]).map((k) => ({
            href: href(k, cur),
            label: PERIODS[k].label,
            current: k === key,
          }))}
        />
        {currencies.length > 0 ? (
          <Segmented
            label="Moneda de los indicadores"
            items={currencies.map((c) => ({
              href: href(key, c),
              label: c,
              current: c === cur,
              title: currencyName(c, 'es'),
            }))}
          />
        ) : null}
      </div>

      {summary.kind !== 'ok' ? (
        <ReadProblem kind={summary.kind} what="los indicadores" />
      ) : insights.kind !== 'ok' ? (
        <ReadProblem kind={insights.kind} what="la evolución de ventas" />
      ) : !cur ? (
        <section className="fx-panel" aria-labelledby="empty-title">
          <div className="fx-panel-body">
            <Empty title="Todavía no hay movimientos en este periodo">
              <p>
                Cuando registres y cobres ventas, aquí verás lo cobrado, la evolución y lo más
                vendido.
              </p>
              {canSell ? (
                <a className="fx-btn fx-btn-primary" href={`${o}/sell`}>
                  Registrar la primera venta
                </a>
              ) : null}
            </Empty>
            <h2 id="empty-title" className="sr-only">
              Sin movimientos
            </h2>
          </div>
        </section>
      ) : (
        <>
          <div className="fx-hero">
            <section className="fx-hero-main" aria-labelledby="hero-title">
              <div>
                <h2 id="hero-title" className="fx-hero-label">
                  <span className="fx-dot" /> Cobrado · confirmado
                </h2>
                <p className="fx-hero-value">
                  {amount(pick(sum!.confirmed_charges, cur).amount, cur)}
                </p>
                <p className="fx-hero-sub">
                  {pick(sum!.confirmed_charges, cur).count} cobros confirmados · registrado{' '}
                  {amount(pick(sum!.orders_created, cur).amount, cur)} en{' '}
                  {pick(sum!.orders_created, cur).count} ventas. Pendiente de liquidación: no es
                  saldo disponible.
                </p>
              </div>
              {ins!.series.length >= 2 && ins!.active_days >= 2 ? (
                <div>
                  <ul className="fx-legend" aria-hidden="true">
                    <li>
                      <span className="fx-swatch" data-k="orders" /> Registrado
                    </li>
                    <li>
                      <span className="fx-swatch" /> Cobrado
                    </li>
                  </ul>
                  <DayBars series={ins!.series} currency={cur} />
                </div>
              ) : (
                <p className="fx-chart-empty">
                  {key === 'today'
                    ? 'Elige 7 o 30 días para ver la evolución diaria.'
                    : 'Aún no hay datos suficientes: la evolución aparece con actividad en al menos dos días del periodo.'}
                </p>
              )}
            </section>

            <section className="fx-balance" aria-labelledby="balance-title">
              <h2 id="balance-title">Saldo en Fluvia</h2>
              {ins!.balances.length === 0 ? (
                <p>Aún no hay saldo registrado en el libro contable.</p>
              ) : (
                <dl>
                  {ins!.balances.map((b) => (
                    <BalanceRows key={b.currency} b={b} />
                  ))}
                </dl>
              )}
              <p>
                Libro contable del sandbox, ahora mismo. Lo cobrado entra como pendiente de
                liquidación; solo «disponible» se puede usar.
              </p>
            </section>
          </div>

          <section className="fx-strip" aria-label={`Métricas del periodo en ${cur}`}>
            <Metric
              title="Ventas registradas"
              tone="orders"
              f={pick(sum!.orders_created, cur)}
              meta="cobradas o no"
            />
            <Metric
              title="Sin confirmar"
              tone="warn"
              f={pick(sum!.charges_in_flight, cur)}
              meta="ahora · no cobres de nuevo"
            />
            <Metric
              title="Devoluciones"
              tone="bad"
              f={pick(sum!.refunds_confirmed, cur)}
              meta="confirmadas"
            />
            <Metric
              title="Pendientes de cobro"
              tone="neutral"
              f={pick(sum!.orders_awaiting_payment, cur)}
              meta={`${pick(sum!.orders_cancelled, cur).count} anuladas en el periodo`}
            />
          </section>

          <Alerts
            o={o}
            sum={sum!}
            lowStock={lowStock.length}
            lowStockNames={lowStock.slice(0, 3).map((p) => p.name)}
          />

          <div className="fx-cols">
            <section className="fx-panel" aria-labelledby="top-title">
              <header>
                <h2 id="top-title">Más vendidos</h2>
                <span className="fx-hint">Ventas cobradas · {cur}</span>
              </header>
              <div className="fx-panel-body" style={{ paddingTop: 8 }}>
                {ins!.top_products.length === 0 ? (
                  <p className="fx-hint" style={{ padding: '16px 0' }}>
                    Aún no hay ventas cobradas en {cur} en este periodo.
                  </p>
                ) : (
                  <ol className="fx-rank">
                    {ins!.top_products.map((t) => {
                      const p = t.product_id ? productsById.get(t.product_id) : undefined;
                      return (
                        <li key={`${t.product_id ?? t.name}`}>
                          <ProductThumb
                            product={{
                              name: t.name,
                              image_ref: p?.image_ref ?? null,
                              category_name: p?.category_name ?? null,
                            }}
                          />
                          <div style={{ minWidth: 0 }}>
                            <span className="fx-rank-name">
                              {t.name}
                              {t.variant_label ? ` · ${t.variant_label}` : ''}
                            </span>
                            <span className="fx-rank-bar" aria-hidden="true">
                              <span style={{ width: `${(t.quantity / topMax) * 100}%` }} />
                            </span>
                          </div>
                          <span className="fx-rank-num">
                            {t.quantity} u.
                            <small>{amount(t.amount, cur)}</small>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </section>

            <section className="fx-panel" aria-labelledby="recent-title">
              <header>
                <h2 id="recent-title">Actividad reciente</h2>
                <a className="fx-link" href={`${o}/orders`}>
                  Ver todas las ventas
                </a>
              </header>
              <div className="fx-panel-body" style={{ paddingTop: 4 }}>
                <RecentFeed o={o} recent={recent} canSell={canSell} />
              </div>
            </section>
          </div>

          <details className="fx-details">
            <summary>Qué mide cada cifra</summary>
            <div>
              <p style={{ marginTop: 0 }}>
                Periodo en UTC: {dateTime(sum!.period.start)} – {dateTime(sum!.period.end)} (fin
                exclusivo). Cada moneda se muestra por separado: nunca se suman bolívares, dólares y
                pesos.
              </p>
              <dl>
                <dt>Cobrado · confirmado</dt>
                <dd>
                  Pagos confirmados por el proveedor (todos los canales), por fecha de creación del
                  cobro. Importe bruto pendiente de liquidación: no es saldo disponible.
                </dd>
                <dt>Ventas registradas</dt>
                <dd>Pedidos creados en el periodo, cobrados o no.</dd>
                <dt>Sin confirmar</dt>
                <dd>
                  Cobros en curso o con resultado incierto (instantánea actual, sin periodo). No son
                  ingresos; no se ofrece cobrar otra vez.
                </dd>
                <dt>Devoluciones</dt>
                <dd>Devoluciones con desenlace confirmado creadas en el periodo.</dd>
                <dt>Pendientes de cobro</dt>
                <dd>
                  Pedidos del periodo sin cobro en curso ni hecho y no anulados. Las anuladas se
                  cuentan aparte.
                </dd>
                <dt>Saldo en Fluvia</dt>
                <dd>
                  Cuentas del comercio en el libro contable del sandbox: pendiente de liquidación,
                  disponible y reserva, por moneda.
                </dd>
                <dt>Más vendidos</dt>
                <dd>Unidades de ventas del periodo con un cobro confirmado (precio histórico).</dd>
                <dt>Cuotas (simulación)</dt>
                <dd>
                  {sum!.installments_sandbox_approved.length === 0
                    ? 'Ningún plan simulado aprobado en el periodo.'
                    : sum!.installments_sandbox_approved
                        .map((f) => `${f.count} planes · ${amount(f.amount, f.currency)}`)
                        .join(' · ')}{' '}
                  Planes SIMULADOS: no son cobros, ingresos ni saldo.
                </dd>
              </dl>
            </div>
          </details>
        </>
      )}
    </main>
  );
}

function BalanceRows({ b }: { b: CommerceInsights['balances'][number] }) {
  return (
    <>
      <dt className="fx-balance-cur">{currencyName(b.currency, 'es')}</dt>
      <dd className="sr-only">{b.currency}</dd>
      <dt>Pendiente de liquidación</dt>
      <dd>{amount(b.pending, b.currency)}</dd>
      <dt>Disponible</dt>
      <dd>{amount(b.available, b.currency)}</dd>
      {b.reserve !== 0 ? (
        <>
          <dt>Reserva</dt>
          <dd>{amount(b.reserve, b.currency)}</dd>
        </>
      ) : null}
    </>
  );
}

function Metric({
  title,
  f,
  meta,
  tone,
}: {
  title: string;
  f: Figure;
  meta: string;
  tone: 'orders' | 'warn' | 'bad' | 'neutral';
}) {
  return (
    <div>
      <h3>
        <span className="fx-dot" data-tone={tone} /> {title}
      </h3>
      <p className="fx-strip-value">{amount(f.amount, f.currency)}</p>
      <p className="fx-strip-meta">
        {f.count} {f.count === 1 ? 'operación' : 'operaciones'} · {meta}
      </p>
    </div>
  );
}

function Alerts({
  o,
  sum,
  lowStock,
  lowStockNames,
}: {
  o: string;
  sum: CommerceSummary;
  lowStock: number;
  lowStockNames: string[];
}) {
  const inFlight = sum.charges_in_flight.reduce((a, f) => a + f.count, 0);
  const refundsOpen = sum.refunds_open.reduce((a, f) => a + f.count, 0);
  if (lowStock === 0 && inFlight === 0 && refundsOpen === 0) return null;
  return (
    <section className="fx-alerts" aria-label="Requiere atención">
      {lowStock > 0 ? (
        <div className="fx-alert">
          <Icon name="box" />
          <p>
            <strong>
              {lowStock} {lowStock === 1 ? 'producto' : 'productos'} con {LOW_STOCK} unidades o
              menos
            </strong>
            {lowStockNames.join(', ')}. <a href={`${o}/catalog?status=low`}>Revisar existencias</a>
          </p>
        </div>
      ) : null}
      {inFlight > 0 ? (
        <div className="fx-alert">
          <Icon name="clock" />
          <p>
            <strong>
              {inFlight} {inFlight === 1 ? 'cobro sin confirmar' : 'cobros sin confirmar'}
            </strong>
            Resultado pendiente o incierto: no cobres de nuevo.{' '}
            <a href={`${o}/orders?state=payment_in_progress`}>Ver ventas</a>
          </p>
        </div>
      ) : null}
      {refundsOpen > 0 ? (
        <div className="fx-alert" data-tone="bad">
          <Icon name="undo" />
          <p>
            <strong>
              {refundsOpen} {refundsOpen === 1 ? 'devolución' : 'devoluciones'} sin desenlace
            </strong>
            <a href={`${o}/refunds`}>Revisar devoluciones</a>
          </p>
        </div>
      ) : null}
    </section>
  );
}

function RecentFeed({
  o,
  recent,
  canSell,
}: {
  o: string;
  recent: Read<OrderList>;
  canSell: boolean;
}) {
  if (recent.kind !== 'ok') return <ReadProblem kind={recent.kind} what="las ventas" />;
  if (recent.data.data.length === 0) {
    return (
      <Empty title="Aún no hay ventas">
        <p>Elige productos, revisa el total y cobra: la venta aparecerá aquí.</p>
        {canSell ? (
          <a className="fx-btn fx-btn-primary" href={`${o}/sell`}>
            Nueva venta
          </a>
        ) : null}
      </Empty>
    );
  }
  return (
    <ul className="fx-feed">
      {recent.data.data.map((ord) => (
        <li key={ord.id}>
          <div style={{ minWidth: 0 }}>
            <a href={`${o}/orders/${ord.id}`}>Venta #{ord.number}</a>
            <span className="fx-cell-sub">
              {ord.customer_name ?? 'Sin cliente'} · {dateTime(ord.created_at)}
            </span>
          </div>
          <span className="amt">{amount(ord.total, ord.currency)}</span>
          <span style={{ gridColumn: '1 / -1' }}>
            <OrderState state={ord.payment.state} />{' '}
            {ord.installments_sandbox ? (
              <PlanStatus status={ord.installments_sandbox.status} />
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
