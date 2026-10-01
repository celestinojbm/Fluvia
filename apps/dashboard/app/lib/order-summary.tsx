import type { OrderDetail } from './commerce-api';
import { Callout, OrderState, PlanStatus, money } from './ui';

/**
 * Detalle de líneas de un pedido (precio HISTÓRICO guardado en la venta) +
 * su estado de pago derivado de los cobros reales. Se usa en el terminal y
 * en el detalle de la venta.
 */
export function OrderLinesTable({ order }: { order: OrderDetail }) {
  // Tres columnas (el precio unitario va bajo el nombre): legible a 390 px
  // sin desplazamiento horizontal.
  return (
    <div className="fx-table-wrap">
      <table className="fx-table">
        <caption className="sr-only">Líneas de la venta #{order.number}</caption>
        <thead>
          <tr>
            <th scope="col">Producto</th>
            <th scope="col" className="num">
              Cant.
            </th>
            <th scope="col" className="num">
              Importe
            </th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.position}>
              <td>
                <span className="fx-cell-main">
                  {l.name}
                  {l.variant_label ? ` · ${l.variant_label}` : ''}
                </span>
                <span className="fx-cell-sub">
                  {money(l.unit_price, order.currency)} c/u{l.sku ? ` · SKU ${l.sku}` : ''}
                </span>
              </td>
              <td className="num">{l.quantity}</td>
              <td className="num">{money(l.line_total, order.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Total</td>
            <td className="num">{money(order.total, order.currency)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function OrderSummaryCard({ orgId, order }: { orgId: string; order: OrderDetail }) {
  const plan = order.installments_sandbox;
  return (
    <section className="fx-panel" aria-labelledby="pos-order-title" style={{ marginBottom: 16 }}>
      <header>
        <h2 id="pos-order-title">
          Venta #{order.number}
          {order.customer_name ? ` · ${order.customer_name}` : ''}
        </h2>
        <span>
          <OrderState state={order.payment.state} />{' '}
          {plan ? <PlanStatus status={plan.status} /> : null}
        </span>
      </header>
      <div className="fx-panel-body">
        {plan && plan.status !== 'declined' ? (
          <Callout tone="sim" title="Esta venta tiene un plan de cuotas (simulación)">
            <p>
              Mientras el plan esté pendiente o aprobado, la venta no admite un cobro con tarjeta o
              transferencia (lo impide el servidor). El plan es una simulación: no es un cobro.{' '}
              <a href={`/o/${orgId}/installments/${plan.plan_id}`}>Ver el plan</a>
            </p>
          </Callout>
        ) : null}
        <OrderLinesTable order={order} />
        <p className="fx-hint" style={{ marginTop: 8 }}>
          <a href={`/o/${orgId}/orders/${order.id}`}>Ver el detalle de la venta</a>
        </p>
      </div>
    </section>
  );
}
