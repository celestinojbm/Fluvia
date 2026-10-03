import { currencyLabel } from '../../../../lib/fx';
import { notFound, redirect } from 'next/navigation';
import { readPersonal } from '../../../lib/server';
import { ErrorPanel } from '../../../lib/panels';
import { CreateOrderForm } from '../../../lib/shop-actions';
import { Money, ScreenHead, img } from '../../../lib/shop-ui';
import type { CartGroup, ShopProfile } from '../../../lib/shop-types';
import { Equivalence } from '../../../../lib/fx-ui';

export const dynamic = 'force-dynamic';

/**
 * Revisión del pedido de UNA tienda y moneda, con precios vigentes del
 * servidor. Si algo cambió, se ve aquí antes de pagar; el servidor vuelve a
 * comprobar precio y existencias al crear el pedido.
 */
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ moneda?: string }>;
}) {
  const { slug } = await params;
  const { moneda } = await searchParams;
  const [cart, store] = await Promise.all([
    readPersonal<{ data: CartGroup[] }>('/shop/cart'),
    readPersonal<{ shop: ShopProfile }>(`/shop/stores/${encodeURIComponent(slug)}`),
  ]);
  if (store.kind === 'not_found') notFound();
  if (cart.kind !== 'ok' || store.kind !== 'ok') return <ErrorPanel />;
  const g = cart.data.data.find((x) => x.shop_slug === slug && (!moneda || x.currency === moneda));
  if (!g) redirect('/personal/carrito');
  const blocked = g.lines.some((l) => l.status === 'out_of_stock' || l.status === 'unavailable');
  const changed = g.lines.some((l) => l.status === 'price_changed');
  const shop = store.data.shop;

  return (
    <main aria-labelledby="pm-review-title">
      <ScreenHead
        title="Revisar pedido"
        id="pm-review-title"
        back="/personal/carrito"
        backLabel="Carrito"
      />
      <div className="pm-two">
        <div>
          {changed ? (
            <p className="pm-banner is-warn" role="status" style={{ marginBottom: 12 }}>
              <span>
                <strong>Un precio cambió desde que lo añadiste.</strong>
                El total ya usa los precios actuales de la tienda.
              </span>
            </p>
          ) : null}
          <section className="pm-card" aria-label="Productos">
            <h2>{g.shop_name}</h2>
            <ul className="pm-lines">
              {g.lines.map((l) => (
                <li key={l.product_id} className="pm-line">
                  <span className="pm-line-img">
                    {img(l.image_ref) ? <img src={img(l.image_ref)!} alt="" /> : null}
                  </span>
                  <div className="pm-line-body">
                    <p className="pm-line-name">{l.name}</p>
                    <p className="pm-muted">
                      {l.variant_label ? `${l.variant_label} · ` : ''}
                      {l.quantity} ×{' '}
                      <Money minor={l.unit_price ?? l.unit_price_seen} currency={l.currency} />
                    </p>
                  </div>
                  <span className="pm-amount" style={{ fontWeight: 800 }}>
                    <Money
                      minor={(
                        BigInt(l.unit_price ?? l.unit_price_seen) * BigInt(l.quantity)
                      ).toString()}
                      currency={l.currency}
                    />
                  </span>
                </li>
              ))}
            </ul>
            <dl className="pm-totals">
              <div className="is-total">
                <dt>Total</dt>
                <dd>
                  <Money minor={g.total} currency={g.currency} />
                  <Equivalence minor={g.total} currency={g.currency} />
                </dd>
              </div>
            </dl>
            <p className="pm-muted" style={{ margin: '8px 0 0' }}>
              Moneda: {currencyLabel(g.currency)}. Sin cargos adicionales de Fluvia en este entorno
              de prueba.
            </p>
          </section>
        </div>
        <aside className="pm-card" aria-label="Entrega y confirmación">
          {blocked ? (
            <p className="pm-banner is-bad" role="alert">
              Hay productos agotados o retirados. Vuelve al carrito para quitarlos.
            </p>
          ) : (
            <CreateOrderForm
              slug={g.shop_slug}
              currency={g.currency}
              total={g.total}
              pickup={shop.pickup}
              delivery={shop.delivery}
              shopName={shop.name}
            />
          )}
        </aside>
      </div>
    </main>
  );
}
