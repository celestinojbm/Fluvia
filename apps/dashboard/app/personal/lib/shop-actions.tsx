'use client';

import { currencyLabel } from '../../lib/fx';
import { useMemo, useRef, useState } from 'react';
import { Icon } from '../../lib/icons';
import { newKey, personalCall, personalError } from './client';
import { money, shortDate } from './format';
import type { ShopOrder, ShopProduct } from './shop-types';
import { Equivalence } from '../../lib/fx-ui';

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
        {/* Botón conmutador: el nombre es fijo y el estado lo da aria-pressed. */}
        <span className="sr-only">{`Favorita: ${name}`}</span>
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
          <Equivalence minor={total} currency={currency} />
        </div>
        <button type="submit" className="pm-cta" disabled={!valid || state.kind === 'busy'}>
          {state.kind === 'busy' ? 'Creando pedido…' : 'Continuar al pago'}
        </button>
      </div>
    </form>
  );
}

interface Offer {
  amount: string;
  down_payment: string;
  financed: string;
  installments: Array<{ seq: number; amount: string; due_date: string }>;
  terms: { installments_count: number; interval_days: number; interest_bps: number };
}

/** Método de pago decidido por el SERVIDOR (`GET …/payment-options`). */
export interface PaymentOption {
  method: 'wallet' | 'installments' | 'external_card';
  available: boolean;
  reason: string | null;
  capability: { status: string; simulated: boolean; label: string; live_dependency: string };
  card_id?: string;
  card_last4?: string | null;
  balance_available?: string;
  credit_available?: string;
  down_payment?: string;
  financed?: string;
  installment_counts?: number[];
}

/** Por qué un método no se ofrece (el motivo lo decide la API). */
function reasonText(o: PaymentOption, currency: string): React.ReactNode {
  switch (o.reason) {
    case 'capability_not_offered':
      return 'No se ofrece en este mercado en este momento.';
    case 'order_not_payable':
      return 'Este pedido ya no admite un pago nuevo.';
    case 'no_card_in_currency':
      return (
        <>
          Necesitas una tarjeta Fluvia activa en {currencyLabel(currency)}.{' '}
          <a href="/personal/tarjetas">Pedir tarjeta</a>
        </>
      );
    case 'insufficient_balance':
      return (
        <>
          Tu saldo propio ({money(o.balance_available ?? '0', currency)}) no alcanza.{' '}
          <a href="/personal/movimientos?accion=ingresar">Ingresar fondos</a>
        </>
      );
    case 'no_credit_line':
      return (
        <>
          Necesitas una línea de crédito aprobada. <a href="/personal/credito">Ver crédito</a>
        </>
      );
    case 'credit_insufficient':
      return `Tu crédito disponible (${money(o.credit_available ?? '0', currency)}) no cubre la parte financiada.`;
    case 'down_payment_insufficient':
      return `Tu saldo no alcanza para la inicial de ${money(o.down_payment ?? '0', currency)}.`;
    case 'no_installment_plans':
      return 'El programa no tiene planes de cuotas activos.';
    default:
      return 'No disponible.';
  }
}

const METHOD_TITLE: Record<PaymentOption['method'], string> = {
  wallet: 'Tarjeta Fluvia · saldo propio',
  installments: 'Tarjeta Fluvia · en cuotas',
  external_card: 'Otra tarjeta',
};

/**
 * Elegir cómo pagar y CONFIRMAR. Los métodos, su disponibilidad y el motivo
 * cuando no lo están vienen del servidor (capacidades del mercado, tarjeta,
 * saldo, línea y política). Nada se marca pagado aquí: tras confirmar, el
 * estado se lee del servidor.
 */
export function PayOrderForm({ order, options }: { order: ShopOrder; options: PaymentOption[] }) {
  const firstAvailable = options.find((o) => o.available)?.method ?? null;
  const [method, setMethod] = useState<PaymentOption['method'] | null>(firstAvailable);
  const inst = options.find((o) => o.method === 'installments');
  const counts = inst?.installment_counts ?? [];
  const [count, setCount] = useState<number>(counts[0] ?? 3);
  const [offer, setOffer] = useState<{ count: number; data: Offer | null; error?: string } | null>(
    null
  );
  const [step, setStep] = useState<'choose' | 'confirm'>('choose');
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'error'; msg?: string }>({
    kind: 'idle',
  });
  const key = useRef(newKey());
  const chosen = options.find((o) => o.method === method) ?? null;

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
    if (!chosen) return;
    setState({ kind: 'busy' });
    if (chosen.method === 'external_card') {
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
        card_id: chosen.card_id,
        mode: chosen.method,
        ...(chosen.method === 'installments' ? { installments_count: count } : {}),
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
  const charge = money(order.total, order.currency);

  if (step === 'confirm' && chosen) {
    return (
      <section className="pm-card pm-confirm" aria-labelledby="pm-confirm-title">
        <h2 id="pm-confirm-title">Confirma el pago</h2>
        <dl className="pm-totals">
          <div>
            <dt>Comercio</dt>
            <dd>{order.shop_name}</dd>
          </div>
          <div>
            <dt>Método</dt>
            <dd>
              {METHOD_TITLE[chosen.method]}
              {chosen.card_last4 ? ` •••• ${chosen.card_last4}` : ''}
              {chosen.method === 'installments' ? ` · ${count} cuotas` : ''}
            </dd>
          </div>
          {chosen.method === 'installments' && chosen.down_payment ? (
            <div>
              <dt>Hoy, de tu saldo propio</dt>
              <dd className="pm-money">{money(chosen.down_payment, order.currency)}</dd>
            </div>
          ) : null}
          {chosen.method === 'installments' && chosen.financed ? (
            <div className="is-credit">
              <dt>Con tu crédito (deuda en cuotas)</dt>
              <dd className="pm-money">{money(chosen.financed, order.currency)}</dd>
            </div>
          ) : null}
          <div className="is-total">
            <dt>Total</dt>
            <dd className="pm-money">{charge}</dd>
          </div>
        </dl>
        {chosen.capability.simulated ? (
          <p className="pm-banner is-sim" role="note">
            <Icon name="flag" />
            <span>
              <strong>Sandbox: dinero simulado.</strong> {chosen.capability.label} no mueve dinero
              real. Para hacerlo falta: {chosen.capability.live_dependency}
            </span>
          </p>
        ) : null}
        {state.kind === 'error' ? (
          <p className="pm-banner is-bad" role="alert">
            {state.msg}
          </p>
        ) : null}
        <div className="pm-confirm-actions">
          <button
            type="button"
            className="pm-cta is-ghost"
            onClick={() => {
              setStep('choose');
              setState({ kind: 'idle' });
            }}
            disabled={state.kind === 'busy'}
          >
            Cambiar
          </button>
          <button
            type="button"
            className="pm-cta"
            onClick={pay}
            disabled={state.kind === 'busy'}
            aria-describedby="pm-confirm-title"
          >
            {state.kind === 'busy'
              ? 'Procesando…'
              : chosen.method === 'external_card'
                ? 'Ir al checkout'
                : `Confirmar y pagar ${charge}`}
          </button>
        </div>
        <p className="pm-muted" style={{ margin: '8px 0 0' }}>
          Si la red no responde, verás el pago «en confirmación»: no pagues de nuevo.
        </p>
      </section>
    );
  }

  return (
    <div>
      <fieldset className="pm-options">
        <legend>Método de pago</legend>
        {options.map((o) => {
          const id = `pm-method-${o.method}`;
          return (
            <div key={o.method} className={`pm-option${o.available ? '' : ' is-off'}`}>
              <input
                id={id}
                type="radio"
                name="method"
                checked={method === o.method}
                disabled={!o.available}
                aria-describedby={`${id}-sub`}
                onChange={() => {
                  setMethod(o.method);
                  if (o.method === 'installments') void loadOffer(count);
                }}
              />
              <span className={`pm-option-ico is-${o.method}`} aria-hidden="true">
                <Icon
                  name={
                    o.method === 'installments'
                      ? 'calendar'
                      : o.method === 'wallet'
                        ? 'wallet'
                        : 'card'
                  }
                />
              </span>
              <label htmlFor={id} className="pm-option-body">
                <span className="pm-option-title">
                  {METHOD_TITLE[o.method]}
                  {o.card_last4 && o.method !== 'external_card' ? ` •••• ${o.card_last4}` : ''}
                  {o.capability.simulated ? <span className="pm-tag is-sim">Simulado</span> : null}
                </span>
                <span className="pm-option-sub" id={`${id}-sub`}>
                  {!o.available
                    ? reasonText(o, order.currency)
                    : o.method === 'wallet'
                      ? `Se descuenta de tu saldo propio (disponible ${money(o.balance_available ?? '0', order.currency)}).`
                      : o.method === 'installments'
                        ? `Inicial ${money(o.down_payment ?? '0', order.currency)} con tu saldo; el resto con tu línea (disponible ${money(o.credit_available ?? '0', order.currency)}).`
                        : 'Abre el checkout seguro de la tienda (tarjetas de prueba).'}
                </span>
              </label>
            </div>
          );
        })}
      </fieldset>

      {method === 'installments' && counts.length ? (
        <div className="pm-card" style={{ marginTop: 12 }}>
          <p className="pm-option-title" style={{ margin: '0 0 8px' }}>
            Número de cuotas
          </p>
          <div className="pm-variants">
            {counts.map((n) => (
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
                Condiciones del programa de PRUEBA, pendientes de validación comercial. El emisor
                decide al confirmar según tu línea aprobada.
              </p>
            </>
          ) : (
            <p className="pm-muted">Calculando…</p>
          )}
        </div>
      ) : null}

      {!firstAvailable ? (
        <p className="pm-banner is-info" style={{ marginTop: 12 }} role="status">
          Ahora mismo no hay un método disponible para este pedido. Los motivos están en cada
          opción.
        </p>
      ) : null}

      <p className="rt-charge" data-testid="charge-line">
        Se cobrará exactamente <strong className="pm-money">{charge}</strong>, en{' '}
        {order.currency === 'VES' ? 'bolívares (Bs)' : currencyLabel(order.currency)}, la moneda del
        pedido. La moneda de visualización solo cambia las equivalencias de referencia, nunca este
        importe.
      </p>
      <div className="pm-actionbar">
        <div className="pm-actionbar-total">
          <p className="pm-muted">Total · {order.shop_name}</p>
          <p>
            <span className="pm-amount pm-money">{charge}</span>
          </p>
        </div>
        <button
          type="button"
          className="pm-cta"
          onClick={() => setStep('confirm')}
          disabled={!chosen?.available}
        >
          Revisar y confirmar
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
