import { orgContext } from '../../../lib/org-context';
import { orgPath, readApi, type Category, type Product } from '../../../lib/commerce-api';
import { LOW_STOCK, ProductThumb, StockBadge, stockLevel } from '../../../lib/commerce-ui';
import { Icon } from '../../../lib/icons';
import { formatAmount } from '../../../lib/money-format';
import { CATALOG_ROLES, Empty, PageHead, ReadProblem, Status } from '../../../lib/ui';

export const dynamic = 'force-dynamic';

const STATUS_FILTERS = {
  active: 'Activos',
  available: 'Disponibles para vender',
  unavailable: 'No disponibles',
  low: 'Existencias bajas o agotadas',
  archived: 'Archivados',
} as const;
type StatusFilter = keyof typeof STATUS_FILTERS;

const money = (p: Product) => formatAmount(p.price, p.currency, 'es');

/**
 * Catálogo: lista rica (foto, nombre y variantes, SKU, categoría,
 * existencias, precio). Búsqueda (nombre, SKU o variante) y categoría
 * filtradas EN SERVIDOR; las variantes se agrupan bajo su producto base.
 * Formulario GET: funciona sin JS, con teclado y deja la búsqueda en la URL.
 */
export default async function CatalogPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ q?: string; category?: string; status?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { token, role } = await orgContext(orgId);
  const q = (sp.q ?? '').slice(0, 120);
  const status: StatusFilter =
    sp.status && sp.status in STATUS_FILTERS ? (sp.status as StatusFilter) : 'active';
  const category = sp.category && /^[0-9a-f-]{36}$/i.test(sp.category) ? sp.category : '';
  const qs = new URLSearchParams({ limit: '500' });
  if (q) qs.set('q', q);
  if (category) qs.set('category_id', category);
  if (status === 'archived') qs.set('include_archived', 'true');
  if (status === 'low') qs.set('low_stock', String(LOW_STOCK));
  const [products, categories] = await Promise.all([
    readApi<{ data: Product[] }>(token, orgPath(orgId, `/catalog/products?${qs}`)),
    readApi<{ data: Category[] }>(token, orgPath(orgId, '/catalog/categories')),
  ]);
  const canEdit = role !== undefined && CATALOG_ROLES.has(role);
  const o = `/o/${orgId}`;
  const all = products.kind === 'ok' ? products.data.data : [];
  const rows = all.filter((p) =>
    status === 'archived'
      ? p.archived
      : status === 'available'
        ? p.available
        : status === 'unavailable'
          ? !p.available
          : true
  );
  // Agrupar variantes bajo su base (si la base está en el resultado).
  const ids = new Set(rows.map((p) => p.id));
  const children = new Map<string, Product[]>();
  for (const p of rows) {
    if (p.variant_of && ids.has(p.variant_of)) {
      children.set(p.variant_of, [...(children.get(p.variant_of) ?? []), p]);
    }
  }
  const heads = rows.filter((p) => !(p.variant_of && ids.has(p.variant_of)));
  const filtered = q !== '' || category !== '' || status !== 'active';
  const tracked = all.filter((p) => p.track_stock && !p.archived);
  const low = tracked.filter((p) => stockLevel(p) === 'low').length;
  const out = tracked.filter((p) => stockLevel(p) === 'out').length;
  const link = (extra: Record<string, string>) => {
    const u = new URLSearchParams();
    if (q) u.set('q', q);
    if (status !== 'active') u.set('status', status);
    for (const [k, v] of Object.entries(extra)) {
      if (v) u.set(k, v);
      else u.delete(k);
    }
    const s = u.toString();
    return `${o}/catalog${s ? `?${s}` : ''}`;
  };

  return (
    <main className="fx-page" aria-labelledby="catalog-title">
      <PageHead
        id="catalog-title"
        title="Catálogo"
        eyebrow="Productos y precios"
        description="Lo que el cajero ve al vender. Cambiar un precio no altera las ventas ya hechas."
        actions={
          canEdit ? (
            <a className="fx-btn fx-btn-primary" href={`${o}/catalog/new`}>
              <Icon name="plus" /> Nuevo producto
            </a>
          ) : null
        }
      />

      <form className="fx-toolbar" method="get" role="search" aria-label="Buscar en el catálogo">
        <div className="fx-field" style={{ flex: '2 1 16rem' }}>
          <label htmlFor="c-q">Buscar</label>
          <div className="fx-search">
            <Icon name="search" />
            <input
              id="c-q"
              name="q"
              className="fx-input"
              defaultValue={q}
              placeholder="Nombre, SKU o variante"
            />
          </div>
        </div>
        {category ? <input type="hidden" name="category" value={category} /> : null}
        <div className="fx-field">
          <label htmlFor="c-status">Estado</label>
          <select id="c-status" name="status" className="fx-select" defaultValue={status}>
            {(Object.keys(STATUS_FILTERS) as StatusFilter[]).map((k) => (
              <option key={k} value={k}>
                {STATUS_FILTERS[k]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="fx-btn">
          Aplicar
        </button>
        {filtered ? (
          <a className="fx-btn fx-btn-ghost" href={`${o}/catalog`}>
            Limpiar
          </a>
        ) : null}
      </form>

      {categories.kind === 'ok' && categories.data.data.length > 0 ? (
        <nav aria-label="Categorías">
          <ul className="fx-chips">
            <li>
              <a
                className="fx-chip"
                href={link({ category: '' })}
                aria-current={!category ? 'true' : undefined}
              >
                Todas
              </a>
            </li>
            {categories.data.data.map((c) => (
              <li key={c.id}>
                <a
                  className="fx-chip"
                  href={link({ category: c.id })}
                  aria-current={category === c.id ? 'true' : undefined}
                >
                  {c.name} <small>{c.product_count}</small>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {products.kind === 'ok' && !filtered ? (
        <ul className="fx-summary-line" aria-label="Resumen del catálogo">
          <li>
            <strong>{all.length}</strong> productos activos
          </li>
          <li>
            <strong>{tracked.length}</strong> con control de existencias
          </li>
          {low > 0 ? (
            <li>
              <a className="fx-link" href={`${o}/catalog?status=low`}>
                <strong>{low}</strong> con existencias bajas
              </a>
            </li>
          ) : null}
          {out > 0 ? (
            <li>
              <a className="fx-link" href={`${o}/catalog?status=low`}>
                <strong>{out}</strong> agotados
              </a>
            </li>
          ) : null}
        </ul>
      ) : null}

      <section className="fx-panel" aria-labelledby="catalog-list-title">
        <header>
          <h2 id="catalog-list-title">
            Productos <span className="fx-hint">({rows.length})</span>
          </h2>
        </header>
        <div style={{ paddingTop: 8 }}>
          {products.kind !== 'ok' ? (
            <div className="fx-panel-body">
              <ReadProblem kind={products.kind} what="el catálogo" />
            </div>
          ) : rows.length === 0 ? (
            filtered ? (
              <Empty title="Sin coincidencias">
                <p>Ningún producto coincide con la búsqueda o los filtros.</p>
                <a className="fx-btn" href={`${o}/catalog`}>
                  Ver todo el catálogo
                </a>
              </Empty>
            ) : (
              <Empty title="El catálogo está vacío">
                <p>Agrega productos con su precio para poder venderlos desde «Nueva venta».</p>
                {canEdit ? (
                  <a className="fx-btn fx-btn-primary" href={`${o}/catalog/new`}>
                    Crear el primer producto
                  </a>
                ) : null}
              </Empty>
            )
          ) : (
            <ul className="fx-catalog" aria-label="Productos del catálogo">
              {heads.map((p) => {
                const kids = children.get(p.id) ?? [];
                return (
                  <li key={p.id}>
                    <div className="fx-item" data-archived={p.archived ? 'true' : undefined}>
                      <ProductThumb product={p} />
                      <div style={{ minWidth: 0 }}>
                        <span className="fx-item-name">
                          <a href={`${o}/catalog/${p.id}`}>{p.name}</a>
                        </span>
                        <span className="fx-cell-sub">
                          {[p.variant_label, p.sku ? `SKU ${p.sku}` : null]
                            .filter(Boolean)
                            .join(' · ') || 'Sin SKU'}
                        </span>
                        {kids.length > 0 ? (
                          <ul className="fx-variants" aria-label={`Variantes de ${p.name}`}>
                            {kids.map((k) => (
                              <li key={k.id}>
                                <a href={`${o}/catalog/${k.id}`}>
                                  {k.variant_label} · {money(k)}
                                </a>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      <span className="fx-item-cat fx-cell-sub">
                        {p.category_name ?? 'Sin categoría'}
                      </span>
                      <span className="fx-item-stock">
                        {p.archived ? (
                          <Status tone="neutral" code="archived">
                            Archivado
                          </Status>
                        ) : !p.available ? (
                          <Status tone="warn" code="unavailable">
                            No disponible
                          </Status>
                        ) : (
                          <StockBadge product={p} showUntracked />
                        )}
                      </span>
                      <span className="fx-item-price">{money(p)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
