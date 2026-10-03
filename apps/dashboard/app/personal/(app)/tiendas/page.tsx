import { Icon } from '../../../lib/icons';
import { readPersonal } from '../../lib/server';
import { ErrorPanel } from '../../lib/panels';
import { CartButton, ProductCard, ScreenHead, ShopCard, img } from '../../lib/shop-ui';
import {
  CATEGORY_LABEL,
  type CartGroup,
  type ShopProduct,
  type ShopSummary,
} from '../../lib/shop-types';

export const dynamic = 'force-dynamic';

const CATS = ['hogar', 'moda', 'tecnologia', 'alimentacion'] as const;

/**
 * Tiendas: descubrir comercios con tienda en Fluvia y sus productos.
 * Solo tiendas que el comercio publicó y activó; los productos los elige cada
 * comercio. Las tiendas conectadas o externas no se muestran como activas sin
 * conexión real (ver «Otras tiendas»).
 */
export default async function TiendasPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; categoria?: string; favoritas?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, 80);
  const cat = CATS.find((c) => c === sp.categoria);
  const fav = sp.favoritas === '1';
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (cat) qs.set('category', cat);
  if (fav) qs.set('favorites', '1');
  const [stores, featured, cart, hits] = await Promise.all([
    readPersonal<{ data: ShopSummary[] }>(`/shop/stores${qs.size ? `?${qs}` : ''}`),
    q || cat || fav ? null : readPersonal<{ data: ShopProduct[] }>('/shop/featured'),
    readPersonal<{ data: CartGroup[] }>('/shop/cart'),
    q.length >= 2
      ? readPersonal<{ data: ShopProduct[] }>(`/shop/search?q=${encodeURIComponent(q)}`)
      : null,
  ]);
  if (stores.kind !== 'ok') return <ErrorPanel />;
  const cartCount =
    cart.kind === 'ok'
      ? cart.data.data.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.quantity, 0), 0)
      : 0;
  const shops = stores.data.data;
  const editorial = shops.find((s) => s.banner_ref?.startsWith('catalog/tienda-banner'));
  const filtered = Boolean(q || cat || fav);

  return (
    <main aria-labelledby="pm-shops-title">
      <ScreenHead title="Tiendas" id="pm-shops-title">
        <CartButton count={cartCount} />
      </ScreenHead>

      <form
        role="search"
        action="/personal/tiendas"
        className="pm-search"
        aria-label="Buscar tiendas y productos"
      >
        <Icon name="search" size={20} />
        <label htmlFor="pm-q" className="sr-only">
          Buscar tiendas y productos
        </label>
        <input
          id="pm-q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Busca «taza», «lino», «teclado»…"
          autoComplete="off"
        />
        {cat ? <input type="hidden" name="categoria" value={cat} /> : null}
        <button type="submit">Buscar</button>
      </form>

      <nav className="pm-chips" aria-label="Filtrar" style={{ marginTop: 12 }}>
        <a
          className="pm-chip"
          href="/personal/tiendas"
          aria-current={!cat && !fav ? 'true' : undefined}
        >
          Todas
        </a>
        <a
          className="pm-chip"
          href="/personal/tiendas?favoritas=1"
          aria-current={fav ? 'true' : undefined}
        >
          <Icon name="heart" size={16} /> Favoritas
        </a>
        {CATS.map((c) => (
          <a
            key={c}
            className="pm-chip"
            href={`/personal/tiendas?categoria=${c}`}
            aria-current={cat === c ? 'true' : undefined}
          >
            {CATEGORY_LABEL[c]}
          </a>
        ))}
      </nav>

      {hits && hits.kind === 'ok' ? (
        <section className="pm-section" aria-labelledby="pm-hits">
          <div className="pm-section-head">
            <h2 id="pm-hits">Productos para «{q}»</h2>
          </div>
          {hits.data.data.length ? (
            <ul className="pm-grid">
              {hits.data.data.map((p) => (
                <li key={p.id}>
                  <ProductCard product={p} showShop />
                </li>
              ))}
            </ul>
          ) : (
            <p className="pm-card">No encontramos productos con «{q}». Prueba con otra palabra.</p>
          )}
        </section>
      ) : null}

      {!filtered && editorial ? (
        <section className="pm-section" aria-label="Destacado de la semana">
          <a
            className="pm-shop-card"
            href={`/personal/tiendas/${editorial.slug}`}
            style={{ position: 'relative' }}
          >
            <div className="pm-shop-media" style={{ aspectRatio: '16 / 8' }}>
              <img src={img(editorial.banner_ref)!} alt="" />
            </div>
            <div className="pm-shop-info" style={{ paddingTop: 16 }}>
              <span className="pm-tag is-lime">Tienda de la semana</span>
              <p className="pm-shop-name" style={{ fontSize: '1.375rem', marginTop: 8 }}>
                {editorial.name}
              </p>
              <p className="pm-muted" style={{ margin: '4px 0 0' }}>
                {editorial.summary}
              </p>
            </div>
          </a>
        </section>
      ) : null}

      {featured && featured.kind === 'ok' && featured.data.data.length ? (
        <section className="pm-section" aria-labelledby="pm-featured">
          <div className="pm-section-head">
            <h2 id="pm-featured">Destacados</h2>
          </div>
          <ul className="pm-grid is-rail" aria-label="Productos destacados">
            {featured.data.data.slice(0, 8).map((p) => (
              <li key={p.id}>
                <ProductCard product={p} showShop />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="pm-section" aria-labelledby="pm-all-shops">
        <div className="pm-section-head">
          <h2 id="pm-all-shops">
            {fav
              ? 'Tus tiendas favoritas'
              : cat
                ? CATEGORY_LABEL[cat]
                : q
                  ? 'Tiendas'
                  : 'Todas las tiendas'}
          </h2>
          <span className="pm-muted">{shops.length}</span>
        </div>
        {shops.length ? (
          <ul className="pm-shop-rail">
            {shops.map((s) => (
              <li key={s.slug}>
                <ShopCard shop={s} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="pm-card">
            <p style={{ margin: 0 }}>
              {fav
                ? 'Aún no tienes tiendas favoritas. Toca el corazón en una tienda para guardarla.'
                : 'No hay tiendas con ese filtro todavía.'}
            </p>
          </div>
        )}
      </section>

      <section className="pm-section" aria-labelledby="pm-other">
        <div className="pm-section-head">
          <h2 id="pm-other">Otras tiendas</h2>
        </div>
        <div className="pm-card">
          <p style={{ margin: '0 0 8px' }}>
            <strong>Tiendas conectadas.</strong> Comercios con tienda en Shopify o WooCommerce
            podrán conectarla cuando la autoricen. Hoy no hay ninguna conexión activa.
          </p>
          <p className="pm-muted" style={{ margin: 0 }}>
            Fluvia no muestra tiendas externas sin un acuerdo con ellas, ni promete envío o
            financiación que no esté confirmada.
          </p>
        </div>
      </section>
    </main>
  );
}
