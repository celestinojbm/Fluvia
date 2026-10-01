import { orgContext } from '../../../lib/org-context';
import { orgPath, readApi, type Category, type Product } from '../../../lib/commerce-api';
import { CATALOG_ROLES, Empty, PageHead, ReadProblem, Status, money } from '../../../lib/ui';

export const dynamic = 'force-dynamic';

const STATUS_FILTERS = {
  active: 'Activos',
  available: 'Disponibles para vender',
  unavailable: 'No disponibles',
  archived: 'Archivados',
} as const;
type StatusFilter = keyof typeof STATUS_FILTERS;

/**
 * Catálogo: búsqueda (nombre o SKU) y categoría filtradas EN SERVIDOR; el
 * estado se filtra sobre el resultado. Formulario GET: funciona sin JS, con
 * teclado y deja la búsqueda en la URL.
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
  const [products, categories] = await Promise.all([
    readApi<{ data: Product[] }>(token, orgPath(orgId, `/catalog/products?${qs}`)),
    readApi<{ data: Category[] }>(token, orgPath(orgId, '/catalog/categories')),
  ]);
  const canEdit = role !== undefined && CATALOG_ROLES.has(role);
  const o = `/o/${orgId}`;
  const rows =
    products.kind === 'ok'
      ? products.data.data.filter((p) =>
          status === 'archived'
            ? p.archived
            : status === 'available'
              ? p.available
              : status === 'unavailable'
                ? !p.available
                : true
        )
      : [];
  const filtered = q !== '' || category !== '' || status !== 'active';

  return (
    <main className="fx-page" aria-labelledby="catalog-title">
      <PageHead
        id="catalog-title"
        title="Catálogo"
        description="Productos y precios que el cajero usa al vender. Cambiar un precio no altera ventas ya hechas."
        actions={
          canEdit ? (
            <a className="fx-btn fx-btn-primary" href={`${o}/catalog/new`}>
              Nuevo producto
            </a>
          ) : null
        }
      />

      <form className="fx-toolbar" method="get" role="search" aria-label="Buscar en el catálogo">
        <div className="fx-field">
          <label htmlFor="c-q">Buscar</label>
          <input
            id="c-q"
            name="q"
            className="fx-input"
            defaultValue={q}
            placeholder="Nombre o SKU"
          />
        </div>
        <div className="fx-field">
          <label htmlFor="c-cat">Categoría</label>
          <select id="c-cat" name="category" className="fx-select" defaultValue={category}>
            <option value="">Todas</option>
            {categories.kind === 'ok'
              ? categories.data.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.product_count})
                  </option>
                ))
              : null}
          </select>
        </div>
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
          <a className="fx-btn" href={`${o}/catalog`}>
            Limpiar
          </a>
        ) : null}
      </form>

      <section className="fx-panel" aria-labelledby="catalog-list-title">
        <header>
          <h2 id="catalog-list-title">
            Productos <span className="fx-hint">({rows.length})</span>
          </h2>
        </header>
        <div className="fx-panel-body" style={{ paddingTop: 8 }}>
          {products.kind !== 'ok' ? (
            <ReadProblem kind={products.kind} what="el catálogo" />
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
            <div className="fx-table-wrap">
              <table className="fx-table is-stack">
                <caption className="sr-only">Productos del catálogo</caption>
                <thead>
                  <tr>
                    <th scope="col">Producto</th>
                    <th scope="col">Categoría</th>
                    <th scope="col">Estado</th>
                    <th scope="col" className="num">
                      Precio
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Producto">
                        <a className="fx-link" href={`${o}/catalog/${p.id}`}>
                          {p.name}
                        </a>
                        {p.sku ? <span className="fx-cell-sub">SKU {p.sku}</span> : null}
                      </td>
                      <td data-label="Categoría">{p.category_name ?? 'Sin categoría'}</td>
                      <td data-label="Estado">
                        {p.archived ? (
                          <Status tone="neutral" code="archived">
                            Archivado
                          </Status>
                        ) : p.available ? (
                          <Status tone="ok" code="available">
                            Disponible
                          </Status>
                        ) : (
                          <Status tone="warn" code="unavailable">
                            No disponible
                          </Status>
                        )}
                      </td>
                      <td data-label="Precio" className="num">
                        {money(p.price, p.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
