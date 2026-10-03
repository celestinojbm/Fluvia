import { currencyLabel } from '../../../lib/fx';
import { Icon } from '../../../lib/icons';
import { readPersonal } from '../../lib/server';
import { ErrorPanel } from '../../lib/panels';
import { CartLineControls } from '../../lib/shop-actions';
import { Money, ScreenHead, img } from '../../lib/shop-ui';
import type { CartGroup, CartLine } from '../../lib/shop-types';
import { Equivalence } from '../../../lib/fx-ui';

export const dynamic = 'force-dynamic';

function LineWarning({ l }: { l: CartLine }) {
  if (l.status === 'price_changed') {
    return (
      <p className="pm-line-warn">
        El precio cambió: antes <Money minor={l.unit_price_seen} currency={l.currency} />, ahora{' '}
        <Money minor={l.unit_price!} currency={l.currency} />.
      </p>
    );
  }
  if (l.status === 'out_of_stock')
    return <p className="pm-line-warn is-bad">Agotado: quítalo para continuar.</p>;
  if (l.status === 'unavailable')
    return <p className="pm-line-warn is-bad">Ya no está a la venta: quítalo para continuar.</p>;
  return null;
}

/**
 * Carrito: un grupo por tienda y moneda (cada uno es un pedido y un pago
 * separados). Revalidado contra el servidor en cada carga.
 */
export default async function CartPage() {
  const r = await readPersonal<{ data: CartGroup[] }>('/shop/cart');
  if (r.kind !== 'ok') return <ErrorPanel />;
  const groups = r.data.data;
  return (
    <main aria-labelledby="pm-cart-title">
      <ScreenHead title="Carrito" id="pm-cart-title" back="/personal/tiendas" backLabel="Tiendas" />
      {groups.length === 0 ? (
        <div className="pm-card">
          <p style={{ margin: '0 0 12px' }}>Tu carrito está vacío.</p>
          <a className="pm-cta" href="/personal/tiendas">
            Explorar tiendas
          </a>
        </div>
      ) : (
        <>
          {groups.length > 1 ? (
            <p className="pm-banner is-info" style={{ marginBottom: 12 }}>
              <Icon name="alert" />
              <span>Cada tienda (y cada moneda) se paga por separado: son pedidos distintos.</span>
            </p>
          ) : null}
          {groups.map((g) => {
            const changed = g.lines.some((l) => l.status === 'price_changed');
            const blocked = g.lines.some(
              (l) => l.status === 'out_of_stock' || l.status === 'unavailable'
            );
            return (
              <section
                key={`${g.shop_slug}-${g.currency}`}
                className="pm-card"
                aria-label={`Pedido en ${g.shop_name}`}
              >
                <h2 style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <a href={`/personal/tiendas/${g.shop_slug}`} style={{ color: 'inherit' }}>
                    {g.shop_name}
                  </a>
                  <span className="pm-tag">{currencyLabel(g.currency)}</span>
                </h2>
                <ul className="pm-lines">
                  {g.lines.map((l) => (
                    <li key={l.product_id} className="pm-line">
                      <span className="pm-line-img">
                        {img(l.image_ref) ? <img src={img(l.image_ref)!} alt="" /> : null}
                      </span>
                      <div className="pm-line-body">
                        <p className="pm-line-name">{l.name}</p>
                        {l.variant_label ? <p className="pm-muted">{l.variant_label}</p> : null}
                        <p>
                          <Money minor={l.unit_price ?? l.unit_price_seen} currency={l.currency} />{' '}
                          <span className="pm-muted">c/u</span>
                        </p>
                        <LineWarning l={l} />
                        <CartLineControls
                          slug={g.shop_slug}
                          productId={l.product_id}
                          quantity={l.quantity}
                          removable={l.status === 'ok' || l.status === 'price_changed'}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
                <dl className="pm-totals">
                  <div className="is-total">
                    <dt>Total {changed ? '(precios actuales)' : ''}</dt>
                    <dd>
                      <Money minor={g.total} currency={g.currency} />
                      <Equivalence minor={g.total} currency={g.currency} />
                    </dd>
                  </div>
                </dl>
                {!blocked ? (
                  <a
                    className="pm-cta is-block"
                    style={{ marginTop: 16 }}
                    href={`/personal/carrito/${g.shop_slug}?moneda=${g.currency}`}
                  >
                    Revisar pedido
                  </a>
                ) : (
                  <p className="pm-line-warn is-bad" style={{ marginTop: 12 }}>
                    Quita los productos agotados o retirados para continuar.
                  </p>
                )}
              </section>
            );
          })}
        </>
      )}
    </main>
  );
}
