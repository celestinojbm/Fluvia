'use client';

import { useRef, useState } from 'react';
import { clientCall, errorMessage } from './client-call';
import { formatAmount } from './money-format';

export interface ShopAdmin {
  settings: {
    merchant_id: string;
    enabled: boolean;
    pickup: boolean;
    delivery: boolean;
    delivery_terms: string | null;
    returns_policy: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    banner_ref: string | null;
    version: number;
  } | null;
  directory: { slug: string; display_name: string; visibility: string } | null;
  listings: Array<{
    product_id: string;
    name: string;
    price: string;
    currency: string;
    image_ref: string | null;
    available: boolean;
    listed: boolean;
    visible: boolean;
    featured: boolean;
    collection: string | null;
    position: number;
    variant_count: number;
  }>;
}

type Msg = { tone: 'ok' | 'bad'; text: string } | null;

function useRunner(canEdit: boolean) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    if (lock.current || !canEdit) return;
    lock.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}

/**
 * Ajustes de la tienda en línea de UN comercio. Activarla exige que el perfil
 * del directorio esté publicado (la API lo vuelve a comprobar y audita).
 */
export function ShopSettingsEditor({
  orgId,
  merchantId,
  merchantName,
  admin,
  canEdit,
  banners,
}: {
  orgId: string;
  merchantId: string;
  merchantName: string;
  admin: ShopAdmin;
  canEdit: boolean;
  banners: ReadonlyArray<{ ref: string; label: string }>;
}) {
  const s = admin.settings;
  const [version, setVersion] = useState(s?.version ?? 0);
  const [enabled, setEnabled] = useState(s?.enabled ?? false);
  const [form, setForm] = useState({
    pickup: s?.pickup ?? true,
    delivery: s?.delivery ?? false,
    delivery_terms: s?.delivery_terms ?? '',
    returns_policy: s?.returns_policy ?? '',
    contact_email: s?.contact_email ?? '',
    contact_phone: s?.contact_phone ?? '',
    banner_ref: s?.banner_ref ?? '',
  });
  const [msg, setMsg] = useState<Msg>(null);
  const msgRef = useRef<HTMLDivElement>(null);
  const { busy, run } = useRunner(canEdit);
  const id = (k: string) => `shop-${merchantId}-${k}`;
  const published = admin.directory?.visibility === 'published';
  const show = (m: Msg) => {
    setMsg(m);
    requestAnimationFrame(() => msgRef.current?.focus());
  };

  const save = (nextEnabled: boolean) =>
    run(async () => {
      if (!form.pickup && !form.delivery) {
        show({ tone: 'bad', text: 'Elige al menos una forma de entrega: retiro o envío.' });
        return;
      }
      const r = await clientCall<{ version: number; enabled: boolean }>(
        `/api/orgs/${encodeURIComponent(orgId)}/shop/merchants/${merchantId}`,
        {
          method: 'PUT',
          body: {
            enabled: nextEnabled,
            pickup: form.pickup,
            delivery: form.delivery,
            delivery_terms: form.delivery_terms.trim() || null,
            returns_policy: form.returns_policy.trim() || null,
            contact_email: form.contact_email.trim() || null,
            contact_phone: form.contact_phone.trim() || null,
            banner_ref: form.banner_ref || null,
            expected_version: version,
          },
        }
      );
      if (r.kind === 'ok') {
        setVersion(r.body.version);
        setEnabled(r.body.enabled);
        show({
          tone: 'ok',
          text: r.body.enabled
            ? 'Guardado. La tienda está activa en Fluvia Personal.'
            : 'Guardado. La tienda no está visible para los clientes.',
        });
      } else if (r.kind === 'http' && r.status === 409) {
        show({
          tone: 'bad',
          text: published
            ? 'Otra persona cambió estos ajustes. Recarga para ver la versión actual.'
            : 'Publica primero el perfil del comercio en Directorio.',
        });
      } else {
        show({
          tone: 'bad',
          text:
            r.kind === 'http' && r.status === 400
              ? 'Revisa los campos: correo válido y teléfono de 7 a 20 dígitos.'
              : errorMessage(r),
        });
      }
    });

  return (
    <section className="fx-panel" aria-labelledby={id('title')}>
      <header>
        <h2 id={id('title')}>{merchantName}</h2>
        <span className="fx-status" data-tone={enabled ? 'ok' : 'neutral'}>
          {enabled ? 'Tienda activa · visible en Personal' : 'Tienda inactiva · no visible'}
        </span>
      </header>
      {!published ? (
        <p className="fx-hint">
          El perfil del comercio no está publicado. Publícalo en{' '}
          <a href={`/o/${orgId}/directorio`}>Directorio</a> antes de activar la tienda.
        </p>
      ) : (
        <p className="fx-hint">
          Dirección pública: <code>/personal/tiendas/{admin.directory!.slug}</code>
        </p>
      )}
      <div className="action-form">
        <fieldset disabled={!canEdit || busy}>
          <legend>Formas de entrega</legend>
          <label className="scope-option">
            <input
              type="checkbox"
              checked={form.pickup}
              onChange={(e) => setForm({ ...form, pickup: e.target.checked })}
            />
            Retiro en tienda
          </label>
          <label className="scope-option">
            <input
              type="checkbox"
              checked={form.delivery}
              onChange={(e) => setForm({ ...form, delivery: e.target.checked })}
            />
            Envío o entrega a domicilio
          </label>
          <label htmlFor={id('terms')}>Condiciones de entrega</label>
          <textarea
            id={id('terms')}
            rows={2}
            maxLength={400}
            value={form.delivery_terms}
            onChange={(e) => setForm({ ...form, delivery_terms: e.target.value })}
          />
          <label htmlFor={id('returns')}>Cambios y devoluciones</label>
          <textarea
            id={id('returns')}
            rows={2}
            maxLength={600}
            value={form.returns_policy}
            onChange={(e) => setForm({ ...form, returns_policy: e.target.value })}
          />
          <label htmlFor={id('email')}>Correo de contacto</label>
          <input
            id={id('email')}
            type="email"
            autoComplete="off"
            value={form.contact_email}
            onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
          />
          <label htmlFor={id('phone')}>Teléfono de contacto</label>
          <input
            id={id('phone')}
            type="tel"
            autoComplete="off"
            value={form.contact_phone}
            onChange={(e) => setForm({ ...form, contact_phone: e.target.value })}
          />
          <label htmlFor={id('banner')}>Foto de portada</label>
          <select
            id={id('banner')}
            value={form.banner_ref}
            onChange={(e) => setForm({ ...form, banner_ref: e.target.value })}
          >
            <option value="">Sin foto (se usa la del perfil)</option>
            {form.banner_ref && !banners.some((b) => b.ref === form.banner_ref) ? (
              <option value={form.banner_ref}>Foto actual</option>
            ) : null}
            {banners.map((b) => (
              <option key={b.ref} value={b.ref}>
                {b.label}
              </option>
            ))}
          </select>
        </fieldset>
      </div>
      <div className="fx-actions">
        <button type="button" className="fx-btn" onClick={() => save(enabled)} disabled={busy}>
          Guardar
        </button>
        {enabled ? (
          <button
            type="button"
            className="fx-btn fx-btn-ghost"
            onClick={() => save(false)}
            disabled={busy}
          >
            Desactivar tienda
          </button>
        ) : (
          <button
            type="button"
            className="fx-btn fx-btn-primary"
            onClick={() => save(true)}
            disabled={busy || !published}
          >
            Activar tienda
          </button>
        )}
      </div>
      <div ref={msgRef} tabIndex={-1} aria-live="polite">
        {msg ? (
          <p
            className="fx-callout"
            data-tone={msg.tone}
            role={msg.tone === 'bad' ? 'alert' : undefined}
          >
            {msg.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Qué productos se ven en la tienda. Nada se publica por defecto: el comercio
 * marca cada producto. Las existencias exactas nunca se muestran al cliente.
 */
export function ShopListingRow({
  orgId,
  item,
  canEdit,
}: {
  orgId: string;
  item: ShopAdmin['listings'][number];
  canEdit: boolean;
}) {
  const [state, setState] = useState({
    visible: item.listed && item.visible,
    featured: item.listed && item.featured,
    collection: item.collection ?? '',
  });
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useRunner(canEdit);
  const save = (next: typeof state) =>
    run(async () => {
      setErr(null);
      const r = await clientCall(
        `/api/orgs/${encodeURIComponent(orgId)}/shop/listings/${item.product_id}`,
        {
          method: 'PUT',
          body: {
            visible: next.visible,
            featured: next.visible && next.featured,
            collection: next.collection.trim() || null,
            position: item.position,
          },
        }
      );
      if (r.kind === 'ok') setState({ ...next, featured: next.visible && next.featured });
      else setErr(errorMessage(r));
    });
  const rid = `lst-${item.product_id}`;
  return (
    <tr>
      <th scope="row" id={rid} data-label="Producto">
        {item.name}
        {item.variant_count ? (
          <span className="fx-hint"> · {item.variant_count} variantes</span>
        ) : null}
        {!item.available ? <span className="fx-hint"> · no disponible</span> : null}
        {err ? (
          <span className="fx-error-text" role="alert">
            {' '}
            {err}
          </span>
        ) : null}
      </th>
      <td data-label="Precio" className="num">
        {formatAmount(item.price, item.currency, 'es', { code: true })}
      </td>
      <td data-label="En la tienda">
        <label className="scope-option">
          <input
            type="checkbox"
            aria-describedby={rid}
            checked={state.visible}
            disabled={!canEdit || busy}
            onChange={(e) => void save({ ...state, visible: e.target.checked })}
          />
          Publicado
        </label>
      </td>
      <td data-label="Destacado">
        <label className="scope-option">
          <input
            type="checkbox"
            aria-describedby={rid}
            checked={state.featured}
            disabled={!canEdit || busy || !state.visible}
            onChange={(e) => void save({ ...state, featured: e.target.checked })}
          />
          Destacado
        </label>
      </td>
      <td data-label="Colección">
        <input
          aria-label={`Colección de ${item.name}`}
          className="fx-input"
          maxLength={40}
          value={state.collection}
          disabled={!canEdit || busy || !state.visible}
          onChange={(e) => setState({ ...state, collection: e.target.value })}
          onBlur={() => {
            if ((item.collection ?? '') !== state.collection) void save(state);
          }}
        />
      </td>
    </tr>
  );
}

const NEXT: Record<string, Array<{ status: string; label: string }>> = {
  received: [
    { status: 'preparing', label: 'Empezar a preparar' },
    { status: 'cancelled', label: 'Cancelar entrega' },
  ],
  preparing: [
    { status: 'ready', label: 'Listo' },
    { status: 'cancelled', label: 'Cancelar entrega' },
  ],
  ready: [
    { status: 'shipped', label: 'Enviado' },
    { status: 'delivered', label: 'Entregado' },
  ],
  shipped: [{ status: 'delivered', label: 'Entregado' }],
};

/** Avanzar la preparación de un pedido. Solo cobrados; la API lo vuelve a exigir. */
export function FulfillmentControl({
  orgId,
  orderId,
  status,
  fulfillment,
  paid,
  canEdit,
}: {
  orgId: string;
  orderId: string;
  status: string;
  fulfillment: 'pickup' | 'delivery';
  paid: boolean;
  canEdit: boolean;
}) {
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useRunner(canEdit);
  if (!paid) return <span className="fx-hint">Espera el cobro</span>;
  const options = (NEXT[status] ?? []).filter(
    (o) => !(fulfillment === 'pickup' && o.status === 'shipped')
  );
  if (!options.length) return null;
  const go = (next: string) =>
    run(async () => {
      setErr(null);
      const r = await clientCall(
        `/api/orgs/${encodeURIComponent(orgId)}/shop/orders/${orderId}/fulfillment`,
        { method: 'POST', body: { status: next } }
      );
      if (r.kind === 'ok') window.location.reload();
      else
        setErr(
          r.kind === 'http' && r.status === 409
            ? 'No se puede: el pedido cambió o la venta no está anulada.'
            : errorMessage(r)
        );
    });
  return (
    <div className="fx-actions" style={{ margin: 0 }}>
      {options.map((o) => (
        <button
          key={o.status}
          type="button"
          className={`fx-btn fx-btn-sm${o.status === 'cancelled' ? ' fx-btn-ghost' : ''}`}
          disabled={!canEdit || busy}
          onClick={() => void go(o.status)}
        >
          {o.label}
        </button>
      ))}
      {err ? (
        <p className="fx-error-text" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
