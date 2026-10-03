import { notFound } from 'next/navigation';
import { Icon } from '../../../../lib/icons';
import { readPersonal } from '../../../lib/server';
import { ErrorPanel } from '../../../lib/panels';
import { FavoriteButton } from '../../../lib/shop-actions';
import { CartButton, ProductCard, img, initial } from '../../../lib/shop-ui';
import {
  CATEGORY_LABEL,
  type CartGroup,
  type ShopProduct,
  type ShopProfile,
} from '../../../lib/shop-types';

export const dynamic = 'force-dynamic';

/** Página de tienda: identidad, condiciones (entrega, contacto, políticas) y catálogo publicado. */
export default async function StorePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [r, cart] = await Promise.all([
    readPersonal<{ shop: ShopProfile; products: ShopProduct[] }>(
      `/shop/stores/${encodeURIComponent(slug)}`
    ),
    readPersonal<{ data: CartGroup[] }>('/shop/cart'),
  ]);
  if (r.kind === 'not_found') notFound();
  if (r.kind !== 'ok') return <ErrorPanel />;
  const { shop, products } = r.data;
  const cartCount =
    cart.kind === 'ok'
      ? cart.data.data.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.quantity, 0), 0)
      : 0;
  const banner = img(shop.banner_ref ?? shop.photo_ref);
  const collections = [...new Set(products.map((p) => p.collection ?? 'Catálogo'))];

  return (
    <main aria-labelledby="pm-store-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <a className="pm-back" href="/personal/tiendas">
          <Icon name="chevron-left" size={20} /> Tiendas
        </a>
        <CartButton count={cartCount} />
      </div>
      <div className="pm-store-hero" style={{ marginTop: 8 }}>
        {banner ? <img src={banner} alt="" /> : null}
      </div>
      <div className="pm-store-id">
        <span className="pm-shop-mark" aria-hidden="true">
          {initial(shop.name)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 id="pm-store-title">{shop.name}</h1>
          <p className="pm-muted" style={{ margin: 0 }}>
            {CATEGORY_LABEL[shop.category] ?? shop.category} · {shop.city}
            {shop.area ? `, ${shop.area}` : ''}
          </p>
        </div>
        <FavoriteButton slug={shop.slug} initial={shop.favorite} name={shop.name} />
      </div>
      {shop.summary ? <p style={{ margin: '12px 0 0', maxWidth: '60ch' }}>{shop.summary}</p> : null}
      <div className="pm-tags">
        {shop.pickup ? <span className="pm-tag">Retiro en tienda</span> : null}
        {shop.delivery ? <span className="pm-tag">Entrega</span> : null}
        {shop.currencies.map((c) => (
          <span key={c} className="pm-tag">
            Precios en {c}
          </span>
        ))}
        {shop.is_demo ? <span className="pm-tag is-sim">Tienda de demostración</span> : null}
      </div>

      <div className="pm-store-facts">
        <div className="pm-fact">
          <Icon name="truck" />
          <div>
            <strong>Entrega</strong>
            <p>{shop.delivery_terms ?? 'La tienda no publicó condiciones de entrega.'}</p>
          </div>
        </div>
        <div className="pm-fact">
          <Icon name="undo" />
          <div>
            <strong>Cambios y devoluciones</strong>
            <p>{shop.returns_policy ?? 'La tienda no publicó su política.'}</p>
          </div>
        </div>
        <div className="pm-fact">
          <Icon name="chat" />
          <div>
            <strong>Contacto</strong>
            <p>
              {shop.contact_phone ? (
                <a href={`tel:${shop.contact_phone.replace(/[^+0-9]/g, '')}`}>
                  {shop.contact_phone}
                </a>
              ) : null}
              {shop.contact_phone && shop.contact_email ? <br /> : null}
              {shop.contact_email ? (
                <a href={`mailto:${shop.contact_email}`}>{shop.contact_email}</a>
              ) : null}
              {!shop.contact_phone && !shop.contact_email
                ? 'Sin datos de contacto publicados.'
                : null}
            </p>
          </div>
        </div>
      </div>

      {products.length === 0 ? (
        <div className="pm-card pm-section">
          <p style={{ margin: 0 }}>Esta tienda todavía no publicó productos.</p>
        </div>
      ) : (
        collections.map((col) => (
          <section key={col} className="pm-section" aria-labelledby={`pm-col-${col}`}>
            <div className="pm-section-head">
              <h2 id={`pm-col-${col}`}>{col}</h2>
            </div>
            <ul className="pm-grid">
              {products
                .filter((p) => (p.collection ?? 'Catálogo') === col)
                .map((p) => (
                  <li key={p.id}>
                    <ProductCard product={p} />
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
