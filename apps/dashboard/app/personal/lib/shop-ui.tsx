import { Icon } from '../../lib/icons';
import { money } from './format';
import { CATEGORY_LABEL, type ShopProduct, type ShopSummary } from './shop-types';

/** Importe con moneda inequívoca, ocultable («Ocultar importes»). */
export function Money({
  minor,
  currency,
  className,
}: {
  minor: string | number | bigint;
  currency: string;
  className?: string;
}) {
  return (
    <span className={`pm-money${className ? ` ${className}` : ''}`}>{money(minor, currency)}</span>
  );
}

/** Ruta pública de una imagen del conjunto cerrado (`catalog/…`, `presentacion/…`). */
export const img = (ref: string | null | undefined) => (ref ? `/${ref}` : null);

export const initial = (name: string) => (name.trim()[0] ?? 'F').toUpperCase();

export function ShopCard({ shop }: { shop: ShopSummary }) {
  const photo = img(shop.banner_ref ?? shop.photo_ref);
  return (
    <a className="pm-shop-card" href={`/personal/tiendas/${shop.slug}`}>
      <div className="pm-shop-media">
        {photo ? <img src={photo} alt="" loading="lazy" /> : null}
        <span className="pm-shop-mark" aria-hidden="true">
          {initial(shop.name)}
        </span>
      </div>
      <div className="pm-shop-info">
        <p className="pm-shop-name">
          {shop.name}
          {shop.favorite ? <span className="sr-only"> (favorita)</span> : null}
        </p>
        <p className="pm-shop-meta">
          {CATEGORY_LABEL[shop.category] ?? shop.category} · {shop.city}
          {shop.area ? `, ${shop.area}` : ''}
        </p>
        <div className="pm-tags">
          {shop.pickup ? <span className="pm-tag">Retiro en tienda</span> : null}
          {shop.delivery ? <span className="pm-tag">Entrega</span> : null}
          {shop.favorite ? (
            <span className="pm-tag is-lime">
              <Icon name="heart" size={12} /> Favorita
            </span>
          ) : null}
          {shop.is_demo ? <span className="pm-tag is-sim">Demo</span> : null}
        </div>
      </div>
    </a>
  );
}

export function ProductCard({ product, showShop }: { product: ShopProduct; showShop?: boolean }) {
  const photo = img(product.image_ref);
  const from =
    product.variants.length > 1 && new Set(product.variants.map((v) => v.price)).size > 1;
  return (
    <a
      className={`pm-product${product.in_stock ? '' : ' pm-soldout'}`}
      href={`/personal/tiendas/${product.shop_slug}/${product.id}`}
    >
      <div className="pm-product-media">
        {photo ? (
          <img src={photo} alt="" loading="lazy" />
        ) : (
          <span className="pm-product-ph" aria-hidden="true">
            <Icon name="bag" size={28} />
          </span>
        )}
        {!product.in_stock ? (
          <span className="pm-product-badge pm-tag">Agotado</span>
        ) : product.featured ? (
          <span className="pm-product-badge pm-tag is-lime">Destacado</span>
        ) : null}
      </div>
      <p className="pm-product-name">{product.name}</p>
      <p className="pm-product-price">
        {from ? <span className="pm-muted">Desde </span> : null}
        <Money minor={product.price} currency={product.currency} />
      </p>
      {showShop && product.shop_name ? (
        <p className="pm-product-shop">{product.shop_name}</p>
      ) : null}
    </a>
  );
}

export function ScreenHead({
  title,
  id,
  back,
  backLabel = 'Volver',
  children,
}: {
  title: string;
  /** id del h1 (para `aria-labelledby` del main). */
  id?: string;
  back?: string;
  backLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      {back ? (
        <a className="pm-back" href={back}>
          <Icon name="chevron-left" size={20} /> {backLabel}
        </a>
      ) : null}
      <div className="pm-screen-head">
        <h1 id={id}>{title}</h1>
        {children}
      </div>
    </>
  );
}

export function CartButton({ count }: { count: number }) {
  return (
    <a
      className="pm-icon-btn pm-cart-btn"
      href="/personal/carrito"
      aria-label={count ? `Carrito: ${count} artículos` : 'Carrito vacío'}
    >
      <Icon name="cart" size={20} />
      {count > 0 ? (
        <span className="pm-badge" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </a>
  );
}
