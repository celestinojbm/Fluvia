import { orgContext } from '../../../lib/org-context';
import {
  orgPath,
  readApi,
  type OrderList,
  type OrderPaymentState,
} from '../../../lib/commerce-api';
import {
  Empty,
  ORDER_STATE_LABEL,
  OrderState,
  PageHead,
  PlanStatus,
  ReadProblem,
  SELL_ROLES,
  dateTime,
} from '../../../lib/ui';
import { Icon } from '../../../lib/icons';
import { formatAmount } from '../../../lib/money-format';

export const dynamic = 'force-dynamic';

/**
 * Ventas: búsqueda (número «#12», nombre de cliente o nota) y estado filtrados
 * EN SERVIDOR, paginación por número (cursor), 25 por página.
 */
export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ q?: string; state?: string; before?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { token, role } = await orgContext(orgId);
  const q = (sp.q ?? '').slice(0, 120);
  const state = sp.state && sp.state in ORDER_STATE_LABEL ? (sp.state as OrderPaymentState) : '';
  const before = sp.before && /^\d{1,15}$/.test(sp.before) ? sp.before : '';
  const qs = new URLSearchParams({ limit: '25' });
  if (q) qs.set('q', q);
  if (state) qs.set('state', state);
  if (before) qs.set('before_number', before);
  const list = await readApi<OrderList>(token, orgPath(orgId, `/orders?${qs}`));
  const o = `/o/${orgId}`;
  const filtered = q !== '' || state !== '';
  const nextHref = (n: number) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (state) p.set('state', state);
    p.set('before', String(n));
    return `${o}/orders?${p}`;
  };

  return (
    <main className="fx-page" aria-labelledby="orders-title">
      <PageHead
        id="orders-title"
        title="Ventas"
        eyebrow="Historial"
        description="Cada venta guarda sus productos y precios del momento; su estado sale de los cobros reales."
        actions={
          role && SELL_ROLES.has(role) ? (
            <a className="fx-btn fx-btn-primary" href={`${o}/sell`}>
              <Icon name="plus" /> Nueva venta
            </a>
          ) : null
        }
      />
      <form className="fx-toolbar" method="get" role="search" aria-label="Buscar ventas">
        <div className="fx-field" style={{ flex: '2 1 16rem' }}>
          <label htmlFor="o-q">Buscar</label>
          <div className="fx-search">
            <Icon name="search" />
            <input
              id="o-q"
              name="q"
              className="fx-input"
              defaultValue={q}
              placeholder="#número, cliente, producto o SKU"
            />
          </div>
        </div>
        <div className="fx-field">
          <label htmlFor="o-state">Estado</label>
          <select id="o-state" name="state" className="fx-select" defaultValue={state}>
            <option value="">Todos</option>
            {(Object.keys(ORDER_STATE_LABEL) as OrderPaymentState[]).map((k) => (
              <option key={k} value={k}>
                {ORDER_STATE_LABEL[k].label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="fx-btn">
          Aplicar
        </button>
        {filtered ? (
          <a className="fx-btn" href={`${o}/orders`}>
            Limpiar
          </a>
        ) : null}
      </form>

      <section className="fx-panel" aria-labelledby="orders-list-title">
        <header>
          <h2 id="orders-list-title">
            {before ? `Ventas anteriores a la #${before}` : 'Ventas recientes'}
          </h2>
        </header>
        <div className="fx-panel-body" style={{ paddingTop: 8 }}>
          {list.kind !== 'ok' ? (
            <ReadProblem kind={list.kind} what="las ventas" />
          ) : list.data.data.length === 0 ? (
            filtered ? (
              <Empty title="Sin coincidencias">
                <p>Ninguna venta coincide con la búsqueda o el estado.</p>
              </Empty>
            ) : (
              <Empty title="Aún no hay ventas">
                <p>Las ventas registradas desde «Nueva venta» aparecerán aquí.</p>
              </Empty>
            )
          ) : (
            <div className="fx-table-wrap">
              <table className="fx-table is-stack">
                <caption className="sr-only">Ventas</caption>
                <thead>
                  <tr>
                    <th scope="col">Venta</th>
                    <th scope="col">Cliente</th>
                    <th scope="col">Estado</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((ord) => (
                    <tr key={ord.id}>
                      <td data-label="Venta">
                        <a className="fx-link" href={`${o}/orders/${ord.id}`}>
                          Venta #{ord.number}
                        </a>
                        <span className="fx-cell-sub">
                          {dateTime(ord.created_at)} · {ord.line_count}{' '}
                          {ord.line_count === 1 ? 'línea' : 'líneas'}
                        </span>
                      </td>
                      <td data-label="Cliente">{ord.customer_name ?? 'Sin cliente'}</td>
                      <td data-label="Estado">
                        <OrderState state={ord.payment.state} />
                        {ord.installments_sandbox ? (
                          <span className="fx-cell-sub">
                            <PlanStatus status={ord.installments_sandbox.status} />
                          </span>
                        ) : null}
                      </td>
                      <td data-label="Total" className="num">
                        <strong>
                          {formatAmount(ord.total, ord.currency, 'es', { code: true })}
                        </strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {list.kind === 'ok' && (list.data.has_more || before) ? (
          <nav className="fx-pager" aria-label="Paginación de ventas">
            {before ? (
              <a
                className="fx-link"
                href={`${o}/orders${filtered ? `?${new URLSearchParams({ ...(q ? { q } : {}), ...(state ? { state } : {}) })}` : ''}`}
              >
                ← Más recientes
              </a>
            ) : (
              <span />
            )}
            {list.data.has_more && list.data.next_before_number ? (
              <a className="fx-link" href={nextHref(list.data.next_before_number)}>
                Más antiguas →
              </a>
            ) : (
              <span>No hay más ventas</span>
            )}
          </nav>
        ) : null}
      </section>
    </main>
  );
}
