import { CustomerForm } from '../../../../lib/customer-form';
import { orgContext } from '../../../../lib/org-context';
import { orgPath, readApi, type CustomerDetail } from '../../../../lib/commerce-api';
import {
  Empty,
  OrderState,
  PageHead,
  ReadProblem,
  SELL_ROLES,
  dateTime,
  money,
} from '../../../../lib/ui';
import { formatAmount } from '../../../../lib/money-format';

export const dynamic = 'force-dynamic';

export default async function CustomerPage({
  params,
}: {
  params: Promise<{ orgId: string; customerId: string }>;
}) {
  const { orgId, customerId } = await params;
  const { token, role } = await orgContext(orgId);
  const read = /^[0-9a-f-]{36}$/i.test(customerId)
    ? await readApi<CustomerDetail>(token, orgPath(orgId, `/customers/${customerId}`))
    : ({ kind: 'not_found' } as const);
  const o = `/o/${orgId}`;
  if (read.kind !== 'ok') {
    return (
      <main className="fx-page" aria-labelledby="c-title">
        <PageHead
          id="c-title"
          title="Cliente"
          crumb={{ href: `${o}/customers`, label: 'Clientes' }}
        />
        <ReadProblem kind={read.kind} what="este cliente" />
      </main>
    );
  }
  const c = read.data;
  // Totales por moneda de las compras COBRADAS (no se suman monedas).
  const paid = new Map<string, number>();
  const CHARGED = new Set(['paid', 'partially_refunded', 'refunded']);
  for (const ord of c.orders) {
    if (!CHARGED.has(ord.payment.state)) continue; // pendiente, en curso o anulada: no cobrado
    paid.set(ord.currency, (paid.get(ord.currency) ?? 0) + ord.total - ord.payment.amount_refunded);
  }
  const last = c.orders[0]?.created_at ?? null;
  return (
    <main className="fx-page" aria-labelledby="c-title">
      <PageHead
        id="c-title"
        title={c.name ?? c.email ?? c.phone ?? 'Cliente'}
        eyebrow="Cliente"
        description={`Cliente desde ${dateTime(c.created_at)}`}
        crumb={{ href: `${o}/customers`, label: 'Clientes' }}
      />
      <section className="fx-strip" aria-label="Resumen del cliente">
        <div>
          <h3>Compras</h3>
          <p className="fx-strip-value">{c.order_count}</p>
          <p className="fx-strip-meta">registradas</p>
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <h3>Cobrado neto</h3>
          <p className="fx-strip-value">
            {paid.size === 0
              ? '—'
              : [...paid.entries()]
                  .map(([cur, v]) => formatAmount(v, cur, 'es', { code: true }))
                  .join(' · ')}
          </p>
          <p className="fx-strip-meta">por moneda, sin sumar monedas · menos devoluciones</p>
        </div>
        <div>
          <h3>Última compra</h3>
          <p className="fx-strip-value" style={{ fontSize: '1rem' }}>
            {last ? dateTime(last) : '—'}
          </p>
          <p className="fx-strip-meta">{c.email ?? c.phone ?? 'Sin contacto'}</p>
        </div>
      </section>
      <div className="fx-grid fx-grid-main">
        <section className="fx-panel" aria-labelledby="c-orders-title">
          <header>
            <h2 id="c-orders-title">Historial de compras ({c.order_count})</h2>
          </header>
          <div className="fx-panel-body" style={{ paddingTop: 8 }}>
            {c.orders.length === 0 ? (
              <Empty title="Sin compras vinculadas">
                <p>Asigna este cliente al registrar una venta.</p>
              </Empty>
            ) : (
              <div className="fx-table-wrap">
                <table className="fx-table is-stack">
                  <caption className="sr-only">Compras del cliente</caption>
                  <thead>
                    <tr>
                      <th scope="col">Venta</th>
                      <th scope="col">Estado</th>
                      <th scope="col" className="num">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.orders.map((ord) => (
                      <tr key={ord.id}>
                        <td data-label="Venta">
                          <a className="fx-link" href={`${o}/orders/${ord.id}`}>
                            Venta #{ord.number}
                          </a>
                          <span className="fx-cell-sub">{dateTime(ord.created_at)}</span>
                        </td>
                        <td data-label="Estado">
                          <OrderState state={ord.payment.state} />
                        </td>
                        <td data-label="Total" className="num">
                          {money(ord.total, ord.currency)}
                          {ord.payment.payment_intent_id && CHARGED.has(ord.payment.state) ? (
                            <a
                              className="fx-cell-sub fx-link"
                              href={`${o}/pos/receipts/${ord.payment.payment_intent_id}`}
                            >
                              Justificante
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {c.orders_has_more ? (
              <p className="fx-hint">Se muestran las 50 compras más recientes.</p>
            ) : null}
          </div>
        </section>
        <section className="fx-panel" aria-labelledby="c-card-title">
          <header>
            <h2 id="c-card-title">Ficha</h2>
          </header>
          <div className="fx-panel-body">
            <CustomerForm
              orgId={orgId}
              customer={c}
              canEdit={role !== undefined && SELL_ROLES.has(role)}
            />
          </div>
        </section>
      </div>
    </main>
  );
}
