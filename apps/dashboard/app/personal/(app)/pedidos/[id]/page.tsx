import { notFound } from 'next/navigation';
import { Icon } from '../../../../lib/icons';
import { readPersonal } from '../../../lib/server';
import { ErrorPanel } from '../../../lib/panels';
import { dateTime } from '../../../lib/format';
import { OrderActions } from '../../../lib/shop-actions';
import { Money, ScreenHead } from '../../../lib/shop-ui';
import { JourneyPanel, type Journey } from '../../../lib/journey';
import {
  FULFILLMENT,
  OUTCOME,
  type FulfillmentStatus,
  type ShopOrder,
} from '../../../lib/shop-types';

export const dynamic = 'force-dynamic';

const FLOW: FulfillmentStatus[] = ['received', 'preparing', 'ready', 'delivered'];

/**
 * Seguimiento de un pedido de Tiendas. El pago y la entrega son estados
 * SEPARADOS y ambos vienen del servidor: volver del checkout no marca nada.
 */
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pago?: string }>;
}) {
  const { id } = await params;
  const { pago } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [r, jr] = await Promise.all([
    readPersonal<ShopOrder>(`/shop/orders/${id}`),
    readPersonal<Journey>(`/journeys/${id}`),
  ]);
  if (r.kind === 'not_found') notFound();
  if (r.kind !== 'ok') return <ErrorPanel />;
  const o = r.data;
  const out = OUTCOME[o.outcome];
  const paid =
    o.outcome === 'approved' || o.outcome === 'partially_refunded' || o.outcome === 'refunded';
  const flow: FulfillmentStatus[] =
    o.fulfillment === 'delivery' ? ['received', 'preparing', 'shipped', 'delivered'] : FLOW;
  const at = flow.indexOf(o.fulfillment_status);

  return (
    <main aria-labelledby="pm-order-title">
      <ScreenHead
        title={`Pedido #${o.number}`}
        id="pm-order-title"
        back="/personal/actividad"
        backLabel="Actividad"
      />
      <p className="pm-muted" style={{ marginTop: -12 }}>
        {o.shop_slug ? <a href={`/personal/tiendas/${o.shop_slug}`}>{o.shop_name}</a> : o.shop_name}{' '}
        · {dateTime(o.created_at)}
      </p>

      <div className="pm-two" style={{ marginTop: 16 }}>
        <div>
          <div
            className={`pm-banner is-${out.tone}`}
            role={pago ? 'status' : undefined}
            aria-live="polite"
          >
            <Icon
              name={
                out.tone === 'ok'
                  ? 'check'
                  : out.tone === 'bad'
                    ? 'alert'
                    : out.tone === 'warn'
                      ? 'clock'
                      : 'receipt'
              }
            />
            <p>
              <strong>{out.label}</strong>
              {out.text}
            </p>
          </div>
          {jr.kind === 'ok' ? (
            <div style={{ marginTop: 12 }}>
              <JourneyPanel j={jr.data} />
            </div>
          ) : (
            <p className="pm-banner is-info" role="status" style={{ marginTop: 12 }}>
              <Icon name="alert" />
              <span>
                No pudimos leer el detalle del pago ahora. El estado del pedido de arriba es el
                vigente; recarga en unos segundos.
              </span>
            </p>
          )}
          {o.installments ? (
            <p className="pm-banner is-info" style={{ marginTop: 8 }}>
              <Icon name="calendar" />
              <span>
                Pagado en {o.installments.installments_count} cuotas con tu crédito. Ver el
                calendario en <a href="/personal/cuotas">Cuotas</a>.
              </span>
            </p>
          ) : null}

          <section className="pm-card" style={{ marginTop: 12 }} aria-labelledby="pm-fulfil">
            <h2 id="pm-fulfil">{o.fulfillment === 'pickup' ? 'Retiro en tienda' : 'Entrega'}</h2>
            {o.fulfillment_status === 'cancelled' ? (
              <p style={{ margin: 0 }}>Pedido anulado. Las existencias reservadas se liberaron.</p>
            ) : (
              <ol className="pm-steps">
                {flow.map((s, i) => (
                  <li
                    key={s}
                    className={paid && i < at ? 'is-done' : paid && i === at ? 'is-now' : ''}
                  >
                    <span className="pm-step-dot" aria-hidden="true">
                      {paid && i < at ? <Icon name="check" size={14} /> : null}
                    </span>
                    <div>
                      <p className="pm-step-title">{FULFILLMENT[s]}</p>
                      {i === 0 && !paid ? (
                        <p className="pm-muted">La tienda empieza cuando el pago se confirma.</p>
                      ) : null}
                      {paid && i === at ? <p className="pm-muted">Estado actual</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {o.delivery_address ? (
              <p className="pm-muted">Dirección: {o.delivery_address}</p>
            ) : null}
          </section>

          <section className="pm-card" aria-labelledby="pm-lines">
            <h2 id="pm-lines">Productos</h2>
            <ul className="pm-lines">
              {o.lines.map((l) => (
                <li key={l.position} className="pm-line">
                  <div className="pm-line-body">
                    <p className="pm-line-name">{l.name}</p>
                    <p className="pm-muted">
                      {l.quantity} × <Money minor={l.unit_price} currency={o.currency} />
                    </p>
                  </div>
                  <span style={{ fontWeight: 800 }}>
                    <Money minor={l.line_total} currency={o.currency} />
                  </span>
                </li>
              ))}
            </ul>
            <dl className="pm-totals">
              {BigInt(o.payment.amount_refunded) > 0n ? (
                <div>
                  <dt>Devuelto</dt>
                  <dd>
                    <Money minor={o.payment.amount_refunded} currency={o.currency} />
                  </dd>
                </div>
              ) : null}
              <div className="is-total">
                <dt>Total</dt>
                <dd>
                  <Money minor={o.total} currency={o.currency} />
                </dd>
              </div>
            </dl>
            <p className="pm-muted" style={{ margin: '8px 0 0' }}>
              Precios del momento de la compra. Comprobante no fiscal.
            </p>
          </section>
          {o.return_requested_at ? (
            <p className="pm-banner is-info" style={{ marginTop: 12 }}>
              <Icon name="undo" />
              <span>
                Pediste una devolución ({o.return_reason}). La tienda la revisa; si procede, verás
                el reembolso aquí.
              </span>
            </p>
          ) : null}
        </div>
        <aside>
          <OrderActions order={o} />
        </aside>
      </div>
    </main>
  );
}
