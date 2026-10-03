'use client';

import { useMemo, useRef, useState } from 'react';
import { Icon } from '../../lib/icons';
import { newKey, personalCall, personalError } from './client';
import { money, shortDate } from './format';
import type { ShopOrder, ShopProduct } from './shop-types';

/** Favorito persistente (servidor), con estado optimista y reversión si falla. */
export function FavoriteButton({
  slug,
  initial,
  name,
}: {
  slug: string;
  initial: boolean;
  name: string;
}) {
  const [fav, setFav] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async () => {
    const next = !fav;
    setFav(next);
    setBusy(true);
    setErr(null);
    const r = await personalCall('shop/favorites', {
      method: 'POST',
      body: { slug, favorite: next },
    });
    setBusy(false);
    if (r.kind !== 'ok') {
      setFav(!next);
      setErr(personalError(r));
    }
  };
  return (
    <>
      <button
        type="button"
        className="pm-icon-btn"
        aria-pressed={fav}
        onClick={toggle}
        disabled={busy}
        style={{ background: 'var(--fl-white)' }}
      >
        <Icon name="heart" size={20} />
        <span className="sr-only">
          {fav ? `Quitar ${name} de favoritas` : `Guardar ${name} en favoritas`}
        </span>
      </button>
      {err ? (
        <p className="pm-line-warn is-bad" role="alert">
          {err}
        </p>
      ) : null}
    </>
  );
}

/**
 * Elegir variante y cantidad y añadir al carrito. El precio que se guarda es
 * el del servidor; si cambia antes de pagar, el carrito lo marca.
 */
export function AddToCart({ product }: { product: ShopProduct }) {
  const options = product.variants;
  const firstLive = options.find((v) => v.in_stock);
  const [variant, setVariant] = useState<string | null>(
    options.length ? (firstLive?.id ?? null) : null
  );
  const [qty, setQty] = useState(1);
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; msg?: string }>({
    kind: 'idle',
  });
  const chosen = options.find((v) => v.id === variant) ?? null;
  const price = chosen ? chosen.price : product.price;
  const inStock = chosen ? chosen.in_stock : product.in_stock;
  const canBuy = (options.length ? Boolean(chosen) : product.sellable) && inStock;

  const add = async () => {
    setState({ kind: 'busy' });
    const r = await personalCall('shop/cart/items', {
      method: 'POST',
      body: { slug: product.shop_slug, product_id: chosen?.id ?? product.id, quantity: qty },
    });
    if (r.kind === 'ok') setState({ kind: 'done' });
    else setState({ kind: 'error', msg: personalError(r) });
  };

  return (
    <div>
      {options.length ? (
        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="pm-option-label">Elige una opción</legend>
          <div className="pm-variants">
            {options.map((v) => (
              <button
                key={v.id}
                type="button"
                className="pm-variant"
                aria-pressed={variant === v.id}
                disabled={!v.in_stock}
                onClick={() => setVariant(v.id)}
              >
                {v.label}
                {!v.in_stock ? <span className="sr-only"> (agotado)</span> : null}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      <p className="pm-option-label">Cantidad</p>
      <div className="pm-stepper">
        <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1}>
          <Icon name="minus" />
          <span className="sr-only">Menos</span>
        </button>
        <output aria-live="polite" aria-label="Cantidad">
          {qty}
        </output>
        <button
          type="button"
          onClick={() => setQty((q) => Math.min(99, q + 1))}
          disabled={qty >= 99}
        >
          <Icon name="plus" />
          <span className="sr-only">Más</span>
        </button>
      </div>

      <div className="pm-actionbar">
        <div className="pm-actionbar-total">
          <p className="pm-muted">{inStock ? 'Total' : 'Sin existencias'}</p>
          <p>
            <span className="pm-amount pm-money">
              {money(BigInt(price) * BigInt(qty), product.currency)}
            </span>
          </p>
        </div>
        {state.kind === 'done' ? (
          <a className="pm-cta" href="/personal/carrito">
            Ver carrito <Icon name="arrow-right" />
          </a>
        ) : (
          <button
            type="button"
            className="pm-cta"
            onClick={add}
            disabled={!canBuy || state.kind === 'busy'}
          >
            <Icon name="cart" /> {state.kind === 'busy' ? 'Añadiendo…' : 'Añadir al carrito'}
          </button>
        )}
      </div>
      <p role="status" aria-live="polite" className="pm-muted" style={{ marginTop: 8 }}>
        {state.kind === 'done'
          ? 'Añadido. Puedes seguir comprando en esta tienda.'
          : state.kind === 'error'
            ? state.msg
            : options.length && !firstLive
              ? 'Todas las opciones están agotadas.'
              : ''}
      </p>
    </div>
  );
}

/** Cambiar o quitar una línea del carrito (vuelve a cargar con el estado del servidor). */
export function CartLineControls({
  slug,
  productId,
  quantity,
  removable,
}: {
  slug: string;
  productId: string;
  quantity: number;
  removable: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = async (q: number) => {
    setBusy(true);
    setErr(null);
    const r = await personalCall('shop/cart/items', {
      method: 'POST',
      body: { slug, product_id: productId, quantity: q },
    });
    if (r.kind === 'ok') window.location.reload();
    else {
      setBusy(false);
      setErr(personalError(r));
    }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
      {removable ? (
        <div className="pm-stepper">
          <button type="button" onClick={() => set(quantity - 1)} disabled={busy}>
            <Icon name={quantity <= 1 ? 'trash' : 'minus'} />
            <span className="sr-only">{quantity <= 1 ? 'Quitar' : 'Menos'}</span>
          </button>
          <output aria-label="Cantidad">{quantity}</output>
          <button type="button" onClick={() => set(quantity + 1)} disabled={busy || quantity >= 99}>
            <Icon name="plus" />
            <span className="sr-only">Más</span>
          </button>
        </div>
      ) : (
        <button type="button" className="pm-chip" onClick={() => set(0)} disabled={busy}>
          <Icon name="trash" size={16} /> Quitar del carrito
        </button>
      )}
      {err ? (
        <span className="pm-line-warn is-bad" role="alert">
          {err}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Revisión → crear pedido (idempotente: la misma clave en reintentos) →
 * ir a pagar. Exige aceptar compartir nombre y correo con la tienda.
 */
export function CreateOrderForm({
  slug,
  currency,
  total,
  pickup,
  delivery,
  shopName,
}: {
  slug: string;
  currency: string;
  total: string;
  pickup: boolean;
  delivery: boolean;
  shopName: string;
}) {
  const key = useRef(newKey());
  const [mode, setMode] = useState<'pickup' | 'delivery'>(pickup ? 'pickup' : 'delivery');
  const [address, setAddress] = useState('');
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'error'; msg?: string }>({
    kind: 'idle',
  });
  const valid = consent && (mode === 'pickup' || address.trim().length >= 5);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setState({ kind: 'busy' });
    const r = await personalCall<{ order_id: string }>('shop/orders', {
      method: 'POST',
      idempotencyKey: key.current,
      body: {
        slug,
        currency,
        expected_total: total,
        fulfillment: mode,
        ...(mode === 'delivery' ? { delivery_address: address.trim() } : {}),
        share_contact: true,
      },
    });
    if (r.kind === 'ok') {
      window.location.href = `/personal/pedidos/${r.body.order_id}/pagar`;
      return;
    }
    setState({ kind: 'error', msg: personalError(r) });
  };

  return (
    <form onSubmit={submit} noValidate>
      <fieldset className="pm-options">
        <legend>¿Cómo lo recibes?</legend>
        {pickup ? (
          <label className="pm-option">
            <input
              type="radio"
              name="fulfillment"
              checked={mode === 'pickup'}
              onChange={() => setMode('pickup')}
            />
            <span className="pm-option-body">
              <span className="pm-option-title" style={{ display: 'block' }}>
                Retiro en tienda
              </span>
              <span className="pm-option-sub">Te avisan cuando esté listo.</span>
            </span>
          </label>
        ) : null}
        {delivery ? (
          <label className="pm-option">
            <input
              type="radio"
              name="fulfillment"
              checked={mode === 'delivery'}
              onChange={() => setMode('delivery')}
            />
            <span className="pm-option-body">
              <span className="pm-option-title" style={{ display: 'block' }}>
                Entrega
              </span>
              <span className="pm-option-sub">
                La tienda coordina contigo; condiciones en su página.
              </span>
            </span>
          </label>
        ) : null}
      </fieldset>
      {mode === 'delivery' ? (
        <div style={{ marginTop: 12 }}>
          <label
            htmlFor="pm-address"
            className="pm-option-title"
            style={{ display: 'block', marginBottom: 6 }}
          >
            Dirección de entrega
          </label>
          <textarea
            id="pm-address"
            className="pm-field"
            rows={2}
            maxLength={240}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoComplete="street-address"
            required
          />
        </div>
      ) : null}
      <label className="pm-option" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span className="pm-option-body">
          <span className="pm-option-title" style={{ display: 'block' }}>
            Compartir mi nombre y correo con {shopName}
          </span>
          <span className="pm-option-sub">Solo para este pedido (entrega y contacto).</span>
        </span>
      </label>
      {state.kind === 'error' ? (
        <p className="pm-banner is-bad" role="alert" style={{ marginTop: 12 }}>
          {state.msg}
        </p>
      ) : null}
      <div className="pm-actionbar">
        <div className="pm-actionbar-total">
          <p className="pm-muted">Total del pedido</p>
          <p>
            <span className="pm-amount pm-money">{money(total, currency)}</span>
          </p>
        </div>
        <button type="submit" className="pm-cta" disabled={!valid || state.kind === 'busy'}>
          {state.kind === 'busy' ? 'Creando pedido…' : 'Continuar al pago'}
        </button>
      </div>
    </form>
  );
}

interface PayCard {
  id: string;
  last4: string | null;
  currency: string;
  funding_mode: string;
}
interface Offer {
  amount: string;
  down_payment: string;
  financed: string;
  installments: Array<{ seq: number; amount: string; due_date: string }>;
  terms: { installments_count: number; interval_days: number; interest_bps: number };
}

/**
 * Elegir cómo pagar (tarjeta Fluvia: saldo o cuotas; u otra tarjeta en el
 * checkout alojado) con el total y la acción principal fijos. El resultado
 * viene del servidor (estado derivado), nunca se supone.
 */
export function PayOrderForm({
  order,
  cards,
  installmentCounts,
}: {
  order: ShopOrder;
  cards: PayCard[];
  installmentCounts: number[];
}) {
  const usable = cards.filter((c) => c.currency === order.currency);
  const [method, setMethod] = useState<string>(usable[0] ? `wallet:${usable[0].id}` : 'checkout');
  const [count, setCount] = useState<number>(installmentCounts[0] ?? 3);
  const [offer, setOffer] = useState<{ count: number; data: Offer | null; error?: string } | null>(
    null
  );
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'error'; msg?: string }>({
    kind: 'idle',
  });
  const key = useRef(newKey());
  const [kind, cardId] = method.split(':') as [
    'wallet' | 'installments' | 'checkout',
    string | undefined,
  ];

  const loadOffer = async (n: number) => {
    setOffer({ count: n, data: null });
    const r = await personalCall<Offer>(
      `offers/installments?count=${n}&amount=${order.total}&currency=${order.currency}`
    );
    setOffer(
      r.kind === 'ok'
        ? { count: n, data: r.body }
        : { count: n, data: null, error: personalError(r) }
    );
  };

  const pay = async () => {
    setState({ kind: 'busy' });
    if (kind === 'checkout') {
      const r = await personalCall<{ url: string }>(`shop/orders/${order.order_id}/checkout`, {
        method: 'POST',
      });
      if (r.kind === 'ok') {
        window.location.href = r.body.url;
        return;
      }
      setState({ kind: 'error', msg: personalError(r) });
      return;
    }
    const r = await personalCall<ShopOrder>(`shop/orders/${order.order_id}/pay`, {
      method: 'POST',
      idempotencyKey: key.current,
      body: {
        card_id: cardId,
        mode: kind,
        ...(kind === 'installments' ? { installments_count: count } : {}),
      },
    });
    if (r.kind === 'ok' || r.kind === 'network') {
      // Con o sin respuesta, el estado VIGENTE se lee del servidor.
      window.location.href = `/personal/pedidos/${order.order_id}?pago=1`;
      return;
    }
    setState({ kind: 'error', msg: personalError(r) });
  };

  const installmentsLabel = useMemo(() => {
    if (!offer || offer.count !== count || !offer.data) return null;
    return offer.data;
  }, [offer, count]);

  return (
    <div>
      <fieldset className="pm-options">
        <legend>Método de pago</legend>
        {usable.map((c) => (
          <div key={c.id} style={{ display: 'grid', gap: 8 }}>
            <label className="pm-option">
              <input
                type="radio"
                name="method"
                checked={method === `wallet:${c.id}`}
                onChange={() => setMethod(`wallet:${c.id}`)}
              />
              <span className="pm-minicard" aria-hidden="true" style={{ width: 48, height: 32 }} />
              <span className="pm-option-body">
                <span className="pm-option-title" style={{ display: 'block' }}>
                  Tarjeta Fluvia •••• {c.last4 ?? '····'} · saldo
                </span>
                <span className="pm-option-sub">
                  Se descuenta de tu saldo propio en {c.currency}.
                </span>
              </span>
            </label>
            {installmentCounts.length ? (
              <label className="pm-option">
                <input
                  type="radio"
                  name="method"
                  checked={method === `installments:${c.id}`}
                  onChange={() => {
                    setMethod(`installments:${c.id}`);
                    void loadOffer(count);
                  }}
                />
                <span
                  className="pm-icon-btn"
                  aria-hidden="true"
                  style={{
                    width: 40,
                    height: 40,
                    background: 'var(--fl-credit-soft)',
                    color: 'var(--fl-credit)',
                  }}
                >
                  <Icon name="calendar" />
                </span>
                <span className="pm-option-body">
                  <span className="pm-option-title" style={{ display: 'block' }}>
                    Tarjeta Fluvia •••• {c.last4 ?? '····'} · en cuotas
                  </span>
                  <span className="pm-option-sub">Usa tu crédito; sujeto a tu línea aprobada.</span>
                </span>
              </label>
            ) : null}
          </div>
        ))}
        <label className="pm-option">
          <input
            type="radio"
            name="method"
            checked={method === 'checkout'}
            onChange={() => setMethod('checkout')}
          />
          <span className="pm-icon-btn" aria-hidden="true" style={{ width: 40, height: 40 }}>
            <Icon name="card" />
          </span>
          <span className="pm-option-body">
            <span className="pm-option-title" style={{ display: 'block' }}>
              Otra tarjeta
            </span>
            <span className="pm-option-sub">
              Abre el checkout seguro de la tienda (tarjetas de prueba).
            </span>
          </span>
        </label>
      </fieldset>

      {kind === 'installments' ? (
        <div className="pm-card" style={{ marginTop: 12 }}>
          <p className="pm-option-title" style={{ margin: '0 0 8px' }}>
            Número de cuotas
          </p>
          <div className="pm-variants">
            {installmentCounts.map((n) => (
              <button
                key={n}
                type="button"
                className="pm-variant"
                aria-pressed={count === n}
                onClick={() => {
                  setCount(n);
                  void loadOffer(n);
                }}
              >
                {n} cuotas
              </button>
            ))}
          </div>
          {offer?.error ? (
            <p className="pm-line-warn is-bad">{offer.error}</p>
          ) : installmentsLabel ? (
            <>
              <dl className="pm-totals" aria-live="polite">
                <div>
                  <dt>Inicial hoy</dt>
                  <dd className="pm-money">
                    {money(installmentsLabel.down_payment, order.currency)}
                  </dd>
                </div>
                {installmentsLabel.installments.length ? (
                  <div>
                    <dt>
                      Luego {installmentsLabel.installments.length} cuotas cada{' '}
                      {installmentsLabel.terms.interval_days} días
                    </dt>
                    <dd>
                      <span className="pm-money">
                        {money(installmentsLabel.installments[0]!.amount, order.currency)}
                      </span>
                    </dd>
                  </div>
                ) : null}
                {installmentsLabel.installments.length ? (
                  <div>
                    <dt>Primera cuota</dt>
                    <dd>{shortDate(installmentsLabel.installments[0]!.due_date)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Interés</dt>
                  <dd>{(installmentsLabel.terms.interest_bps / 100).toLocaleString('es-VE')} %</dd>
                </div>
                <div className="is-total">
                  <dt>Total</dt>
                  <dd className="pm-money">{money(installmentsLabel.amount, order.currency)}</dd>
                </div>
              </dl>
              <p className="pm-muted" style={{ margin: '8px 0 0' }}>
                Condiciones del programa de PRUEBA, pendientes de validación comercial. Se aprueba o
                rechaza al pagar, según tu línea de crédito.
              </p>
            </>
          ) : (
            <p className="pm-muted">Calculando…</p>
          )}
        </div>
      ) : null}

      {usable.length === 0 ? (
        <p className="pm-banner is-info" style={{ marginTop: 12 }}>
          No tienes una tarjeta Fluvia activa en {order.currency}. Puedes pagar con otra tarjeta o{' '}
          <a href="/personal/tarjetas">pedir tu tarjeta</a>.
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p className="pm-banner is-bad" role="alert" style={{ marginTop: 12 }}>
          {state.msg}
        </p>
      ) : null}

      <div className="pm-actionbar">
        <div className="pm-actionbar-total">
          <p className="pm-muted">Total · {order.shop_name}</p>
          <p>
            <span className="pm-amount pm-money">{money(order.total, order.currency)}</span>
          </p>
        </div>
        <button type="button" className="pm-cta" onClick={pay} disabled={state.kind === 'busy'}>
          {state.kind === 'busy' ? 'Procesando…' : kind === 'checkout' ? 'Ir al checkout' : 'Pagar'}
        </button>
      </div>
    </div>
  );
}

/** Anular un pedido sin cobro o pedir una devolución de uno cobrado. */
export function OrderActions({ order }: { order: ShopOrder }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const run = async (path: string, body?: unknown) => {
    setBusy(true);
    setErr(null);
    const r = await personalCall(`shop/orders/${order.order_id}/${path}`, {
      method: 'POST',
      ...(body ? { body } : {}),
    });
    if (r.kind === 'ok') window.location.reload();
    else {
      setBusy(false);
      setErr(personalError(r));
    }
  };
  const canPay = order.outcome === 'unpaid' || order.outcome === 'declined';
  const canReturn =
    (order.outcome === 'approved' || order.outcome === 'partially_refunded') &&
    !order.return_requested_at;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {canPay ? (
        <a className="pm-cta is-block" href={`/personal/pedidos/${order.order_id}/pagar`}>
          {order.outcome === 'declined' ? 'Intentar el pago de nuevo' : 'Pagar pedido'}
        </a>
      ) : null}
      {canPay ? (
        <button
          type="button"
          className="pm-cta is-ghost is-block"
          onClick={() => run('cancel')}
          disabled={busy}
        >
          Anular pedido
        </button>
      ) : null}
      {canReturn && !asking ? (
        <button type="button" className="pm-cta is-ghost is-block" onClick={() => setAsking(true)}>
          Solicitar devolución
        </button>
      ) : null}
      {asking ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run('return', { reason });
          }}
        >
          <label
            htmlFor="pm-reason"
            className="pm-option-title"
            style={{ display: 'block', marginBottom: 6 }}
          >
            ¿Qué pasó?
          </label>
          <textarea
            id="pm-reason"
            className="pm-field"
            rows={3}
            maxLength={280}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="pm-muted">
            La tienda revisa la solicitud y, si procede, devuelve el pago por el mismo medio.
          </p>
          <button
            type="submit"
            className="pm-cta is-block"
            disabled={busy || reason.trim().length < 5}
          >
            Enviar solicitud
          </button>
        </form>
      ) : null}
      {err ? (
        <p className="pm-banner is-bad" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
