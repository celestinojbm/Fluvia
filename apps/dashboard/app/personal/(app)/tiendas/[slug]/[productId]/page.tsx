import { notFound } from 'next/navigation';
import { Icon } from '../../../../../lib/icons';
import { readPersonal } from '../../../../lib/server';
import { ErrorPanel } from '../../../../lib/panels';
import { AddToCart } from '../../../../lib/shop-actions';
import { Money, img } from '../../../../lib/shop-ui';
import type { ShopProduct, ShopProfile } from '../../../../lib/shop-types';
import { Equivalence } from '../../../../../lib/fx-ui';

export const dynamic = 'force-dynamic';

/** Ficha de producto: foto 4:5, descripción, variantes, precio, moneda y disponibilidad. */
export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string; productId: string }>;
}) {
  const { slug, productId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(productId)) notFound();
  const r = await readPersonal<{ shop: ShopProfile; product: ShopProduct }>(
    `/shop/stores/${encodeURIComponent(slug)}/products/${productId}`
  );
  if (r.kind === 'not_found') notFound();
  if (r.kind !== 'ok') return <ErrorPanel />;
  const { shop, product } = r.data;
  const photo = img(product.image_ref);
  const range =
    product.variants.length > 1 && new Set(product.variants.map((v) => v.price)).size > 1;

  return (
    <main aria-labelledby="pm-pdp-title">
      <a className="pm-back" href={`/personal/tiendas/${shop.slug}`}>
        <Icon name="chevron-left" size={20} /> {shop.name}
      </a>
      <div className="pm-pdp" style={{ marginTop: 8 }}>
        <div className="pm-pdp-media">
          {photo ? (
            <img src={photo} alt={product.name} />
          ) : (
            <span className="pm-product-ph" aria-hidden="true">
              <Icon name="bag" size={40} />
            </span>
          )}
        </div>
        <div>
          {product.category ? (
            <p className="pm-muted" style={{ margin: 0 }}>
              {product.category}
            </p>
          ) : null}
          <h1 id="pm-pdp-title">{product.name}</h1>
          <p className="pm-pdp-price">
            {range ? (
              <span className="pm-muted" style={{ fontSize: '1rem' }}>
                Desde{' '}
              </span>
            ) : null}
            <Money minor={product.price} currency={product.currency} />
            <Equivalence minor={product.price} currency={product.currency} />
          </p>
          <p className="pm-muted" style={{ margin: '4px 0 0' }}>
            {product.in_stock ? 'Disponible' : 'Agotado por ahora'} · vendido por {shop.name}
          </p>
          {product.description ? (
            <p style={{ margin: '16px 0 0', maxWidth: '60ch' }}>{product.description}</p>
          ) : null}
          <AddToCart product={product} />
          <div className="pm-card" style={{ marginTop: 16 }}>
            <p style={{ margin: 0 }}>
              <strong>
                {shop.pickup && shop.delivery
                  ? 'Retiro o entrega'
                  : shop.pickup
                    ? 'Retiro en tienda'
                    : 'Entrega'}
              </strong>
            </p>
            <p className="pm-muted" style={{ margin: '4px 0 0' }}>
              {shop.delivery_terms ?? 'Condiciones de entrega en la página de la tienda.'}
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
