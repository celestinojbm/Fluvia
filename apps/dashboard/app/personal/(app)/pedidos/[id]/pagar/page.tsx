import { notFound, redirect } from 'next/navigation';
import { readPersonal } from '../../../../lib/server';
import { ErrorPanel } from '../../../../lib/panels';
import { PayOrderForm, type PaymentOption } from '../../../../lib/shop-actions';
import { Money, ScreenHead } from '../../../../lib/shop-ui';
import type { ShopOrder } from '../../../../lib/shop-types';
import { Equivalence } from '../../../../../lib/fx-ui';

export const dynamic = 'force-dynamic';

/**
 * Elegir el método de pago de un pedido y confirmarlo. Los métodos y su
 * disponibilidad los decide la API (`payment-options`): capacidades del
 * mercado del comercio, tarjeta, saldo, línea de crédito y política.
 */
export default async function PayOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [o, opts] = await Promise.all([
    readPersonal<ShopOrder>(`/shop/orders/${id}`),
    readPersonal<{ market: string; options: PaymentOption[] }>(
      `/shop/orders/${id}/payment-options`
    ),
  ]);
  if (o.kind === 'not_found') notFound();
  if (o.kind !== 'ok' || opts.kind !== 'ok') return <ErrorPanel />;
  // Pagado, en confirmación o anulado: no se ofrece pagar otra vez.
  if (o.data.outcome !== 'unpaid' && o.data.outcome !== 'declined')
    redirect(`/personal/pedidos/${id}`);
  return (
    <main aria-labelledby="pm-pay-title">
      <ScreenHead
        title="Pagar pedido"
        id="pm-pay-title"
        back={`/personal/pedidos/${id}`}
        backLabel={`Pedido #${o.data.number}`}
      />
      <div className="pm-two">
        <div>
          {o.data.outcome === 'declined' ? (
            <p className="pm-banner is-bad" style={{ marginBottom: 12 }}>
              El intento anterior fue rechazado y no se cobró nada.
            </p>
          ) : null}
          <PayOrderForm order={o.data} options={opts.data.options} />
        </div>
        <aside className="pm-card" aria-label="Resumen">
          <h2>{o.data.shop_name}</h2>
          <ul className="pm-lines">
            {o.data.lines.map((l) => (
              <li key={l.position} className="pm-line">
                <div className="pm-line-body">
                  <p className="pm-line-name">{l.name}</p>
                  <p className="pm-muted">{l.quantity} ×</p>
                </div>
                <Money minor={l.line_total} currency={o.data.currency} />
              </li>
            ))}
          </ul>
          <dl className="pm-totals">
            <div className="is-total">
              <dt>Total</dt>
              <dd>
                <Money minor={o.data.total} currency={o.data.currency} />
                <Equivalence minor={o.data.total} currency={o.data.currency} />
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </main>
  );
}
