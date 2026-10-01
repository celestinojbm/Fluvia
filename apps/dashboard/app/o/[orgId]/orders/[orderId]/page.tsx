import { orgContext } from '../../../../lib/org-context';
import { orgPath, readApi, type OrderDetail } from '../../../../lib/commerce-api';
import { CancelOrder } from '../../../../lib/cancel-order';
import { OrderLinesTable } from '../../../../lib/order-summary';
import {
  Callout,
  OrderState,
  PageHead,
  PlanStatus,
  ReadProblem,
  SELL_ROLES,
  ShortId,
  Status,
  dateTime,
  money,
} from '../../../../lib/ui';

export const dynamic = 'force-dynamic';

/** Detalle de una venta: líneas históricas, cobro real, cliente y acciones. */
export default async function OrderPage({
  params,
}: {
  params: Promise<{ orgId: string; orderId: string }>;
}) {
  const { orgId, orderId } = await params;
  const { token, role } = await orgContext(orgId);
  const read = /^[0-9a-f-]{36}$/i.test(orderId)
    ? await readApi<OrderDetail>(token, orgPath(orgId, `/orders/${orderId}`))
    : ({ kind: 'not_found' } as const);
  const o = `/o/${orgId}`;
  if (read.kind !== 'ok') {
    return (
      <main className="fx-page" aria-labelledby="order-title">
        <PageHead id="order-title" title="Venta" crumb={{ href: `${o}/orders`, label: 'Ventas' }} />
        <ReadProblem kind={read.kind} what="esta venta" />
      </main>
    );
  }
  const ord = read.data;
  const pay = ord.payment;
  const plan = ord.installments_sandbox;
  const canSell = role !== undefined && SELL_ROLES.has(role);
  const planBlocks = plan !== null && plan.status !== 'declined';
  const posHref = `${o}/pos?link=${ord.payment_link_id}&order=${ord.id}`;
  const charged =
    pay.state === 'paid' || pay.state === 'partially_refunded' || pay.state === 'refunded';

  return (
    <main className="fx-page" aria-labelledby="order-title">
      <PageHead
        id="order-title"
        title={`Venta #${ord.number}`}
        eyebrow={<OrderState state={pay.state} />}
        description={`${dateTime(ord.created_at)} · ${ord.merchant_name ?? 'Comercio'} · ${money(ord.total, ord.currency)}`}
        crumb={{ href: `${o}/orders`, label: 'Ventas' }}
        actions={
          <>
            {canSell && pay.state === 'awaiting_payment' && !planBlocks ? (
              <a className="fx-btn fx-btn-primary" href={posHref}>
                {pay.checkout_count > 0 ? 'Cobrar de nuevo' : 'Cobrar'}
              </a>
            ) : null}
            {pay.state === 'payment_in_progress' && pay.latest_checkout_session_id ? (
              <a
                className="fx-btn fx-btn-primary"
                href={`${o}/pos?session=${pay.latest_checkout_session_id}&link=${ord.payment_link_id}`}
              >
                Seguir el cobro
              </a>
            ) : null}
            {charged && pay.payment_intent_id ? (
              <>
                <a
                  className="fx-btn fx-btn-primary"
                  href={`${o}/pos/receipts/${pay.payment_intent_id}`}
                >
                  Ver justificante
                </a>
                {pay.latest_checkout_session_id ? (
                  <a
                    className="fx-btn"
                    href={`${o}/pos?session=${pay.latest_checkout_session_id}&link=${ord.payment_link_id}`}
                  >
                    Devolver desde el terminal
                  </a>
                ) : null}
              </>
            ) : null}
          </>
        }
      />

      {ord.cancellation ? (
        <Callout tone="info" title="Venta anulada" role="status">
          <p>
            {dateTime(ord.cancellation.created_at)} · Motivo: {ord.cancellation.reason}. Sus
            checkouts ya no pueden cobrar y las existencias reservadas se liberaron.
          </p>
        </Callout>
      ) : null}
      {pay.state === 'payment_in_progress' ? (
        <Callout tone="warn" title="Cobro en curso o sin confirmar" role="status">
          <p>
            Hay un cobro sin desenlace verificado. No cobres de nuevo: el sistema mantiene la venta
            retenida hasta que el proveedor confirme o rechace.
          </p>
        </Callout>
      ) : null}
      {pay.state === 'awaiting_payment' && pay.latest_intent_status === 'failed' ? (
        <Callout tone="bad" title="El último intento de cobro fue rechazado">
          <p>La venta sigue sin cobrar. Puedes abrir otro checkout para la misma venta.</p>
        </Callout>
      ) : null}
      {planBlocks ? (
        <Callout tone="sim" title="Plan de cuotas activo (simulación)">
          <p>
            Esta venta no está cobrada: el plan es una simulación y no mueve dinero. Mientras siga
            pendiente o aprobado, no se puede cobrar con tarjeta o transferencia.{' '}
            <a href={`${o}/installments/${plan!.plan_id}`}>Ver el plan</a>
          </p>
        </Callout>
      ) : null}

      <div className="fx-grid fx-grid-main">
        <section className="fx-panel" aria-labelledby="lines-title">
          <header>
            <h2 id="lines-title">Productos</h2>
            <span className="fx-hint">Precios en el momento de la venta</span>
          </header>
          <div className="fx-panel-body">
            <OrderLinesTable order={ord} />
            {ord.note ? (
              <p className="fx-hint" style={{ marginTop: 12 }}>
                Nota: {ord.note}
              </p>
            ) : null}
          </div>
        </section>

        <div className="fx-grid">
          <section className="fx-panel" aria-labelledby="pay-title">
            <header>
              <h2 id="pay-title">Cobro</h2>
            </header>
            <div className="fx-panel-body">
              <dl className="fx-dl">
                <dt>Estado</dt>
                <dd>
                  <OrderState state={pay.state} />
                </dd>
                <dt>Total</dt>
                <dd>{money(ord.total, ord.currency)}</dd>
                {pay.amount_refunded > 0 ? (
                  <>
                    <dt>Devuelto</dt>
                    <dd>{money(pay.amount_refunded, ord.currency)}</dd>
                  </>
                ) : null}
                <dt>Checkouts</dt>
                <dd>{pay.checkout_count}</dd>
                {pay.payment_intent_id ? (
                  <>
                    <dt>Pago</dt>
                    <dd>
                      <a href={`${o}/payments/${pay.payment_intent_id}`}>
                        Detalle del pago <ShortId id={pay.payment_intent_id} />
                      </a>
                    </dd>
                  </>
                ) : null}
                {plan ? (
                  <>
                    <dt>Cuotas</dt>
                    <dd>
                      <PlanStatus status={plan.status} />{' '}
                      <a href={`${o}/installments/${plan.plan_id}`}>Ver plan</a>
                    </dd>
                  </>
                ) : null}
              </dl>
            </div>
          </section>
          <section className="fx-panel" aria-labelledby="cust-title">
            <header>
              <h2 id="cust-title">Cliente</h2>
            </header>
            <div className="fx-panel-body">
              {ord.customer_id ? (
                <a className="fx-link" href={`${o}/customers/${ord.customer_id}`}>
                  {ord.customer_name ?? 'Ver ficha'}
                </a>
              ) : (
                <p className="fx-hint">Venta sin cliente asignado.</p>
              )}
            </div>
          </section>
          {ord.stock.length > 0 ? (
            <section className="fx-panel" aria-labelledby="stock-title">
              <header>
                <h2 id="stock-title">Existencias</h2>
              </header>
              <div className="fx-panel-body">
                <ul className="fx-feed">
                  {ord.stock.map((s) => {
                    const line = ord.lines.find((l) => l.product_id === s.product_id);
                    return (
                      <li key={s.product_id}>
                        <a href={`${o}/catalog/${s.product_id}`}>
                          {line
                            ? `${line.name}${line.variant_label ? ` · ${line.variant_label}` : ''}`
                            : 'Producto'}
                        </a>
                        <span className="amt">{s.quantity} u.</span>
                        <span style={{ gridColumn: '1 / -1' }}>
                          {s.status === 'sold' ? (
                            <Status tone="ok" code="sold">
                              Descontadas (cobro confirmado)
                            </Status>
                          ) : s.status === 'released' ? (
                            <Status tone="neutral" code="released">
                              Liberadas (venta anulada)
                            </Status>
                          ) : (
                            <Status tone="warn" code="reserved">
                              Reservadas hasta el cobro
                            </Status>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          ) : null}
          <section className="fx-panel" aria-labelledby="tl-title">
            <header>
              <h2 id="tl-title">Historial</h2>
            </header>
            <div className="fx-panel-body">
              <ol className="fx-timeline">
                <li>
                  <strong>Venta registrada</strong>
                  <span>
                    {dateTime(ord.created_at)} · {ord.line_count}{' '}
                    {ord.line_count === 1 ? 'línea' : 'líneas'}
                  </span>
                </li>
                {pay.checkout_count > 0 ? (
                  <li style={{ ['--tone' as string]: 'var(--fx-sun)' }}>
                    <strong>
                      {pay.checkout_count}{' '}
                      {pay.checkout_count === 1 ? 'checkout abierto' : 'checkouts abiertos'}
                    </strong>
                    <span>Enlaces de cobro de esta venta</span>
                  </li>
                ) : null}
                {charged ? (
                  <li style={{ ['--tone' as string]: 'var(--fx-ok)' }}>
                    <strong>Cobro confirmado</strong>
                    <span>
                      {pay.amount_refunded > 0
                        ? `Devuelto ${money(pay.amount_refunded, ord.currency)}`
                        : 'Sin devoluciones'}
                    </span>
                  </li>
                ) : null}
                {ord.cancellation ? (
                  <li style={{ ['--tone' as string]: 'var(--fx-line-strong)' }}>
                    <strong>Venta anulada</strong>
                    <span>
                      {dateTime(ord.cancellation.created_at)} · {ord.cancellation.reason}
                    </span>
                  </li>
                ) : null}
              </ol>
            </div>
          </section>
          {canSell && pay.state === 'awaiting_payment' && !planBlocks ? (
            <section aria-label="Anular la venta">
              <CancelOrder orgId={orgId} orderId={ord.id} number={ord.number} />
              <p className="fx-hint" style={{ marginTop: 6 }}>
                Solo ventas sin cobro en curso ni hecho.
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
