import { Icon } from '../../../lib/icons';
import { orgContext } from '../../../lib/org-context';
import { orgPath, readApi, type Customer } from '../../../lib/commerce-api';
import { Empty, PageHead, ReadProblem, SELL_ROLES, dateTime } from '../../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { orgId } = await params;
  const { q: rawQ } = await searchParams;
  const { token, role } = await orgContext(orgId);
  const q = (rawQ ?? '').slice(0, 120);
  const list = await readApi<{ data: Customer[] }>(
    token,
    orgPath(orgId, `/customers?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`)
  );
  const o = `/o/${orgId}`;
  const canEdit = role !== undefined && SELL_ROLES.has(role);
  return (
    <main className="fx-page" aria-labelledby="cust-title">
      <PageHead
        id="cust-title"
        title="Clientes"
        eyebrow="Relación"
        description="Fichas, historial de compras y justificantes. Datos sintéticos en el sandbox."
        actions={
          canEdit ? (
            <a className="fx-btn fx-btn-primary" href={`${o}/customers/new`}>
              Nuevo cliente
            </a>
          ) : null
        }
      />
      <form className="fx-toolbar" method="get" role="search" aria-label="Buscar clientes">
        <div className="fx-field" style={{ flex: '2 1 16rem' }}>
          <label htmlFor="cu-q">Buscar</label>
          <div className="fx-search">
            <Icon name="search" />
            <input
              id="cu-q"
              name="q"
              className="fx-input"
              defaultValue={q}
              placeholder="Nombre, email o teléfono"
            />
          </div>
        </div>
        <button type="submit" className="fx-btn">
          Buscar
        </button>
        {q ? (
          <a className="fx-btn" href={`${o}/customers`}>
            Limpiar
          </a>
        ) : null}
      </form>
      <section className="fx-panel" aria-labelledby="cust-list-title">
        <header>
          <h2 id="cust-list-title">Clientes</h2>
          <span className="fx-hint">Hasta 100 por búsqueda</span>
        </header>
        <div className="fx-panel-body" style={{ paddingTop: 8 }}>
          {list.kind !== 'ok' ? (
            <ReadProblem kind={list.kind} what="los clientes" />
          ) : list.data.data.length === 0 ? (
            q ? (
              <Empty title="Sin coincidencias">
                <p>Ningún cliente coincide con «{q}».</p>
              </Empty>
            ) : (
              <Empty title="Aún no hay clientes">
                <p>Crea fichas aquí o asigna un cliente nuevo al registrar una venta.</p>
              </Empty>
            )
          ) : (
            <div className="fx-table-wrap">
              <table className="fx-table is-stack">
                <caption className="sr-only">Clientes</caption>
                <thead>
                  <tr>
                    <th scope="col">Cliente</th>
                    <th scope="col">Contacto</th>
                    <th scope="col" className="num">
                      Compras
                    </th>
                    <th scope="col">Última compra</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((c) => (
                    <tr key={c.id}>
                      <td data-label="Cliente">
                        <span className="fx-cell-flex">
                          <span
                            className="fx-thumb"
                            aria-hidden="true"
                            style={{ borderRadius: '50%' }}
                          >
                            {(c.name ?? c.email ?? '?').trim()[0]?.toUpperCase()}
                          </span>
                          <a className="fx-link" href={`${o}/customers/${c.id}`}>
                            {c.name ?? c.email ?? c.phone ?? 'Sin nombre'}
                          </a>
                        </span>
                      </td>
                      <td data-label="Contacto">
                        {[c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td data-label="Compras" className="num">
                        {c.order_count}
                      </td>
                      <td data-label="Última compra">
                        {c.last_order_at ? dateTime(c.last_order_at) : '—'}
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
