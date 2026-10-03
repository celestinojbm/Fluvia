import { orgPath, readApi } from '../../../lib/commerce-api';
import { formatAmount } from '../../../lib/money-format';
import { orgContext } from '../../../lib/org-context';
import { PRESENTATION_CREDITS } from '../../../lib/presentation-credits';
import {
  FulfillmentControl,
  ShopListingRow,
  ShopSettingsEditor,
  type ShopAdmin,
} from '../../../lib/shop-editor';
import {
  CATALOG_ROLES,
  Callout,
  Empty,
  OrderState,
  PageHead,
  Status,
  dateTime,
} from '../../../lib/ui';
import type { Merchant } from '../../../lib/api';
import type { OrderPaymentState } from '../../../lib/commerce-api';

export const dynamic = 'force-dynamic';

interface AdminOrder {
  order_id: string;
  number: number;
  created_at: string;
  currency: string;
  total: string;
  payment_state: OrderPaymentState;
  buyer_name: string;
  buyer_email: string;
  fulfillment: 'pickup' | 'delivery';
  delivery_address: string | null;
  fulfillment_status: string;
  return_requested_at: string | null;
  return_reason: string | null;
}

const FULFILLMENT: Record<string, { label: string; tone: 'ok' | 'warn' | 'neutral' | 'info' }> = {
  received: { label: 'Recibido', tone: 'neutral' },
  preparing: { label: 'Preparando', tone: 'info' },
  ready: { label: 'Listo', tone: 'info' },
  shipped: { label: 'Enviado', tone: 'info' },
  delivered: { label: 'Entregado', tone: 'ok' },
  cancelled: { label: 'Entrega cancelada', tone: 'neutral' },
};

/**
 * Tienda en línea del comercio (Fluvia Personal · Tiendas). El comercio decide
 * qué se publica; los pedidos llegan como ventas de su organización y solo se
 * preparan cuando el cobro está confirmado.
 */
export default async function ShopAdminPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { token, role } = await orgContext(orgId);
  const canEdit = role !== undefined && CATALOG_ROLES.has(role);
  const merchants = await readApi<{ merchants?: Merchant[] }>(token, orgPath(orgId, '/merchants'));
  const list =
    merchants.kind === 'ok'
      ? (merchants.data.merchants ?? []).filter((m) => m.status === 'active')
      : [];
  const [views, orders] = await Promise.all([
    Promise.all(
      list.map((m) => readApi<ShopAdmin>(token, orgPath(orgId, `/shop/merchants/${m.id}`)))
    ),
    readApi<{ data: AdminOrder[] }>(token, orgPath(orgId, '/shop/orders')),
  ]);
  const failed = merchants.kind !== 'ok' || views.some((v) => v.kind !== 'ok');
  const banners = PRESENTATION_CREDITS.map((p) => ({ ref: p.ref, label: p.label }));
  const o = `/o/${orgId}`;

  return (
    <main className="fx-page" aria-labelledby="shop-title">
      <PageHead
        id="shop-title"
        title="Tienda en línea"
        description="Lo que publiques aquí aparece en Tiendas de Fluvia Personal. Nada se publica por defecto."
      />
      {failed ? (
        <Callout tone="bad" title="No pudimos cargar tu tienda" role="alert">
          <p>Es un fallo temporal. Recarga la página; no se ha cambiado nada.</p>
        </Callout>
      ) : list.length === 0 ? (
        <Empty title="No hay comercios en esta organización">
          <p>Crea un comercio en la puesta en marcha para abrir su tienda.</p>
        </Empty>
      ) : (
        list.map((m, i) => {
          const v = views[i]!;
          if (v.kind !== 'ok') return null;
          const items = v.data.listings;
          return (
            <div key={m.id} className="fx-section">
              <ShopSettingsEditor
                orgId={orgId}
                merchantId={m.id}
                merchantName={m.name}
                admin={v.data}
                canEdit={canEdit}
                banners={banners}
              />
              <section className="fx-panel" aria-labelledby={`lst-${m.id}`}>
                <header>
                  <h2 id={`lst-${m.id}`}>Productos en la tienda</h2>
                  <span className="fx-status" data-tone="neutral">
                    {items.filter((x) => x.listed && x.visible).length} de {items.length} publicados
                  </span>
                </header>
                <p className="fx-hint">
                  Los clientes ven precio, foto y si hay existencias; nunca la cantidad exacta. Las
                  variantes se publican con su producto. Precios y fotos se editan en{' '}
                  <a href={`${o}/catalog`}>Catálogo</a>.
                </p>
                {items.length === 0 ? (
                  <p>Aún no hay productos en el catálogo.</p>
                ) : (
                  <div className="fx-table-wrap">
                    <table className="fx-table is-stack">
                      <caption className="sr-only">Productos y su publicación</caption>
                      <thead>
                        <tr>
                          <th scope="col">Producto</th>
                          <th scope="col" className="num">
                            Precio
                          </th>
                          <th scope="col">En la tienda</th>
                          <th scope="col">Destacado</th>
                          <th scope="col">Colección</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it) => (
                          <ShopListingRow
                            key={it.product_id}
                            orgId={orgId}
                            item={it}
                            canEdit={canEdit}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          );
        })
      )}

      <section className="fx-panel" aria-labelledby="shop-orders">
        <header>
          <h2 id="shop-orders">Pedidos en línea</h2>
        </header>
        {orders.kind !== 'ok' ? (
          <p role="alert">No pudimos cargar los pedidos. Recarga en unos segundos.</p>
        ) : orders.data.data.length === 0 ? (
          <p className="fx-hint">Todavía no hay pedidos desde Fluvia Personal.</p>
        ) : (
          <div className="fx-table-wrap">
            <table className="fx-table is-stack">
              <caption className="sr-only">Pedidos en línea</caption>
              <thead>
                <tr>
                  <th scope="col">Pedido</th>
                  <th scope="col">Cliente</th>
                  <th scope="col">Cobro</th>
                  <th scope="col">Entrega</th>
                  <th scope="col" className="num">
                    Total
                  </th>
                  <th scope="col">Acción</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.data.map((ord) => {
                  const f = FULFILLMENT[ord.fulfillment_status] ?? {
                    label: ord.fulfillment_status,
                    tone: 'neutral' as const,
                  };
                  return (
                    <tr key={ord.order_id}>
                      <td data-label="Pedido">
                        <a className="fx-link" href={`${o}/orders/${ord.order_id}`}>
                          Venta #{ord.number}
                        </a>
                        <span className="fx-cell-sub">{dateTime(ord.created_at)}</span>
                      </td>
                      <td data-label="Cliente">
                        {ord.buyer_name}
                        <span className="fx-cell-sub">{ord.buyer_email}</span>
                      </td>
                      <td data-label="Cobro">
                        <OrderState state={ord.payment_state} />
                      </td>
                      <td data-label="Entrega">
                        <Status tone={f.tone}>{f.label}</Status>
                        <span className="fx-cell-sub">
                          {ord.fulfillment === 'pickup'
                            ? 'Retiro en tienda'
                            : `Envío · ${ord.delivery_address ?? ''}`}
                        </span>
                        {ord.return_requested_at ? (
                          <span className="fx-cell-sub">
                            <Status tone="warn">Devolución solicitada</Status> {ord.return_reason}
                          </span>
                        ) : null}
                      </td>
                      <td data-label="Total" className="num">
                        <strong>
                          {formatAmount(ord.total, ord.currency, 'es', { code: true })}
                        </strong>
                      </td>
                      <td data-label="Acción">
                        <FulfillmentControl
                          orgId={orgId}
                          orderId={ord.order_id}
                          status={ord.fulfillment_status}
                          fulfillment={ord.fulfillment}
                          paid={
                            ord.payment_state === 'paid' ||
                            ord.payment_state === 'partially_refunded'
                          }
                          canEdit={canEdit}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="fx-hint">
          Para devolver un pago, abre la venta: si el cobro lo admite verás «Devolver desde el
          terminal». Marcar la entrega como cancelada no devuelve dinero.
        </p>
      </section>
    </main>
  );
}
