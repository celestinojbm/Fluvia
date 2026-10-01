'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatAmount } from '../messages';
import type { Merchant } from './api';
import { clientCall, errorMessage } from './client-call';
import type { Category, Customer, OrderDetail, Product } from './commerce-api';
import { ProductThumb, StockBadge, stockLevel } from './commerce-ui';
import { Icon } from './icons';
import { currencyName } from './money-format';

/**
 * Nueva venta: mostrador (catálogo con fotos y variantes) → ticket → cliente
 * (opcional) → revisión → registrar.
 *
 * Reglas de dinero:
 *  - El total mostrado es una PREVISIÓN; el servidor lo recalcula con los
 *    precios vigentes y rechaza (409) si no coincide con el que vio el cajero:
 *    nunca se cobra un importe distinto del revisado.
 *  - Una `Idempotency-Key` por carrito revisado: reintentar tras un resultado
 *    incierto devuelve la MISMA venta; cambiar el carrito genera otra key.
 *  - Tras un resultado incierto el carrito queda BLOQUEADO hasta comprobarlo.
 *  - Una venta = una moneda (selector de moneda; bloqueado con carrito).
 *  - Existencias: el tope de cantidad por línea es una AYUDA (libre según el
 *    último catálogo leído); la reserva real la hace el servidor al registrar
 *    (422 insufficient_stock ⇒ se relee el catálogo). Nada se descuenta aquí.
 */

const MAX_QTY = 999;
const MAX_LINES = 50;

type Step =
  | { kind: 'cart' }
  | { kind: 'review' }
  | { kind: 'creating' }
  | { kind: 'failed'; message: string; code?: string }
  | { kind: 'uncertain' }
  | { kind: 'created'; order: OrderDetail };

function fmt(amount: number, currency: string) {
  return formatAmount(amount, currency, 'es');
}

/** Nombre visible de un producto: «Café molido · 500 g». */
export function productLabel(p: Pick<Product, 'name' | 'variant_label'>): string {
  return p.variant_label ? `${p.name} · ${p.variant_label}` : p.name;
}

/** Tope de unidades vendibles por línea según el catálogo leído. */
function maxFor(p: Product | undefined): number {
  if (!p) return MAX_QTY;
  if (p.track_stock && p.stock) return Math.max(0, Math.min(MAX_QTY, p.stock.free));
  return MAX_QTY;
}

interface Family {
  key: string;
  head: Product;
  members: Product[];
}

export function SellWorkspace({
  orgId,
  products: initialProducts,
  categories,
  merchants,
  canSell,
}: {
  orgId: string;
  products: Product[];
  categories: Category[];
  merchants: Merchant[];
  canSell: boolean;
}) {
  const o = encodeURIComponent(orgId);
  const [products, setProducts] = useState(initialProducts);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [merchantId, setMerchantId] = useState(merchants[0]?.id ?? '');
  const merchant = merchants.find((m) => m.id === merchantId);
  const currencies = useMemo(
    () => [...new Set(products.map((p) => p.currency))].sort(),
    [products]
  );
  const [currency, setCurrency] = useState<string>(() => {
    const def = merchants[0]?.defaultCurrency;
    return def && initialProducts.some((p) => p.currency === def)
      ? def
      : (initialProducts[0]?.currency ?? def ?? 'USD');
  });
  const [cart, setCart] = useState<Array<{ productId: string; qty: number }>>([]);
  const [customer, setCustomer] = useState<Pick<Customer, 'id' | 'name' | 'email'> | null>(null);
  const [note, setNote] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'cart' });
  const [announce, setAnnounce] = useState('');
  const idem = useRef<{ key: string; fingerprint: string } | null>(null);
  const lock = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const lines = cart.map((l) => {
    const p = byId.get(l.productId);
    return { ...l, product: p, total: p ? p.price * l.qty : 0, max: maxFor(p) };
  });
  const total = lines.reduce((a, l) => a + l.total, 0);
  const missing = lines.filter((l) => !l.product);
  const overStock = lines.filter((l) => l.product && l.qty > l.max);
  const locked = step.kind === 'creating' || step.kind === 'uncertain' || step.kind === 'created';
  const totalTooLarge = !Number.isSafeInteger(total);
  const units = cart.reduce((a, l) => a + l.qty, 0);

  const needle = q.trim().toLowerCase();
  const matches = (p: Product) =>
    needle === '' ||
    p.name.toLowerCase().includes(needle) ||
    (p.sku ?? '').toLowerCase().includes(needle) ||
    (p.variant_label ?? '').toLowerCase().includes(needle);
  const visible = products.filter(
    (p) => p.currency === currency && (cat === null || p.category_id === cat) && matches(p)
  );
  // Variantes juntas: la familia es la base (o el primer miembro visible).
  const families: Family[] = [];
  const famIdx = new Map<string, Family>();
  for (const p of visible) {
    const key = p.variant_of ?? p.id;
    let f = famIdx.get(key);
    if (!f) {
      const head = byId.get(key) ?? p;
      f = { key, head, members: [] };
      famIdx.set(key, f);
      families.push(f);
    }
    f.members.push(p);
  }

  useEffect(() => {
    if (step.kind === 'failed' || step.kind === 'uncertain') alertRef.current?.focus();
    if (step.kind === 'review') reviewRef.current?.focus();
    if (step.kind === 'created') alertRef.current?.focus();
  }, [step.kind]);

  const add = useCallback(
    (p: Product) => {
      if (locked) return;
      const max = maxFor(p);
      if (max <= 0) {
        setAnnounce(`${productLabel(p)}: agotado.`);
        return;
      }
      let capped = false;
      setCart((c) => {
        const found = c.find((l) => l.productId === p.id);
        if (found) {
          if (found.qty >= max) capped = true;
          return c.map((l) => (l.productId === p.id ? { ...l, qty: Math.min(max, l.qty + 1) } : l));
        }
        if (c.length >= MAX_LINES) return c;
        return [...c, { productId: p.id, qty: 1 }];
      });
      setAnnounce(
        capped
          ? `${productLabel(p)}: no quedan más unidades libres.`
          : `${productLabel(p)} añadido al carrito.`
      );
      if (step.kind !== 'cart') setStep({ kind: 'cart' });
    },
    [locked, step.kind]
  );

  const setQty = (productId: string, qty: number) => {
    if (locked) return;
    if (!Number.isInteger(qty) || qty < 1) qty = 1;
    const max = maxFor(byId.get(productId));
    setCart((c) =>
      c.map((l) =>
        l.productId === productId
          ? { ...l, qty: Math.min(MAX_QTY, Math.max(1, Math.min(qty, max || 1))) }
          : l
      )
    );
    if (step.kind !== 'cart') setStep({ kind: 'cart' });
  };

  const remove = (productId: string) => {
    if (locked) return;
    const p = byId.get(productId);
    const name = p ? productLabel(p) : 'Producto';
    setCart((c) => c.filter((l) => l.productId !== productId));
    setAnnounce(`${name} quitado del carrito.`);
    if (step.kind !== 'cart') setStep({ kind: 'cart' });
  };

  const changeCurrency = (c: string) => {
    if (cart.length > 0 && c !== currency) return; // una venta = una moneda
    setCurrency(c);
  };

  /** Enter en la búsqueda: SKU exacto, o el único producto visible, al ticket. */
  const addFromSearch = () => {
    if (needle === '') return;
    const exact = visible.filter((p) => (p.sku ?? '').toLowerCase() === needle);
    const pick = exact.length === 1 ? exact[0] : visible.length === 1 ? visible[0] : undefined;
    if (pick) {
      add(pick);
      setQ('');
    } else {
      setAnnounce(
        visible.length === 0
          ? 'Ningún producto coincide.'
          : `${visible.length} productos coinciden: elige uno de la lista.`
      );
    }
  };

  const refreshPrices = useCallback(async () => {
    const r = await clientCall<{ data: Product[] }>(`/api/orgs/${o}/catalog/products`);
    if (r.kind === 'ok') {
      setProducts(r.body.data.filter((p) => p.available && !p.archived));
      setAnnounce('Precios y existencias actualizados con el catálogo vigente.');
      return true;
    }
    return false;
  }, [o]);

  const payload = () => ({
    merchant_id: merchantId,
    currency,
    lines: cart.map((l) => ({ product_id: l.productId, quantity: l.qty })),
    expected_total: total,
    ...(customer ? { customer_id: customer.id } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  });

  const create = async () => {
    if (lock.current || !canSell) return;
    if (cart.length === 0 || missing.length > 0 || totalTooLarge || !merchantId) return;
    lock.current = true;
    try {
      const body = payload();
      const fingerprint = JSON.stringify(body);
      if (!idem.current || idem.current.fingerprint !== fingerprint) {
        idem.current = { key: crypto.randomUUID(), fingerprint };
      }
      setStep({ kind: 'creating' });
      const r = await clientCall<OrderDetail>(`/api/orgs/${o}/orders`, {
        method: 'POST',
        body,
        idempotencyKey: idem.current.key,
      });
      if (r.kind === 'ok' && r.body?.id) {
        setStep({ kind: 'created', order: r.body });
        return;
      }
      if (r.kind === 'network' || (r.kind === 'http' && r.status >= 500) || r.kind === 'ok') {
        setStep({ kind: 'uncertain' });
        return;
      }
      if (
        r.code === 'order_total_changed' ||
        r.code === 'product_unavailable' ||
        r.code === 'insufficient_stock'
      ) {
        await refreshPrices();
        idem.current = null;
      }
      if (r.code === 'idempotency_key_reuse') idem.current = null;
      setStep({ kind: 'failed', message: errorMessage(r), code: r.code });
    } finally {
      lock.current = false;
    }
  };

  const reset = () => {
    idem.current = null;
    setCart([]);
    setCustomer(null);
    setNote('');
    setStep({ kind: 'cart' });
    setAnnounce('Venta nueva. El carrito está vacío.');
    void refreshPrices();
  };

  if (!canSell) {
    return (
      <div className="fx-callout" data-tone="info">
        <p>
          Tu rol no puede registrar ventas (requiere propietario, administrador o finanzas). Puedes
          consultar el <a href={`/o/${orgId}/catalog`}>catálogo</a> y las{' '}
          <a href={`/o/${orgId}/orders`}>ventas</a>.
        </p>
      </div>
    );
  }
  if (merchants.length === 0) {
    return (
      <div className="fx-callout" data-tone="warn">
        <p>
          No hay un comercio activo para vender. Revisa{' '}
          <a href={`/o/${orgId}/settings`}>Configuración</a>.
        </p>
      </div>
    );
  }

  if (step.kind === 'created') {
    const ord = step.order;
    const posHref = `/o/${orgId}/pos?link=${ord.payment_link_id}&order=${ord.id}`;
    return (
      <section className="fx-panel" aria-labelledby="created-title" style={{ maxWidth: '40rem' }}>
        <div className="fx-panel-body">
          <div ref={alertRef} tabIndex={-1} className="fx-done" role="status">
            <span className="fx-done-ico" aria-hidden="true">
              <Icon name="check" size={28} />
            </span>
            <div>
              <p style={{ margin: 0 }}>
                <strong id="created-title" style={{ fontSize: '1.2rem' }}>
                  Venta #{ord.number} registrada
                </strong>
              </p>
              <p style={{ margin: '4px 0 0' }}>
                Total <strong>{fmt(ord.total, ord.currency)}</strong> · {ord.line_count}{' '}
                {ord.line_count === 1 ? 'línea' : 'líneas'}
                {ord.customer_name ? ` · ${ord.customer_name}` : ''}. Aún no se ha cobrado
                {ord.stock && ord.stock.length > 0 ? '; las existencias quedan reservadas' : ''}.
              </p>
            </div>
          </div>
          <div className="fx-actions" style={{ marginTop: 20 }}>
            <a className="fx-btn fx-btn-primary fx-btn-lg" href={posHref}>
              Cobrar ahora
            </a>
            <a className="fx-btn" href={`/o/${orgId}/orders/${ord.id}`}>
              Ver la venta
            </a>
            <button type="button" className="fx-btn" onClick={reset}>
              Nueva venta
            </button>
          </div>
        </div>
      </section>
    );
  }

  const reviewing = step.kind !== 'cart';

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <ol className="fx-steps" aria-label="Pasos de la venta">
        <li aria-current={!reviewing ? 'step' : undefined}>Productos</li>
        <li aria-current={reviewing ? 'step' : undefined}>Revisar</li>
        <li>Cobrar</li>
      </ol>
      <div className="fx-sell">
        <section className="fx-panel" aria-labelledby="pick-title">
          <header>
            <h2 id="pick-title">Productos</h2>
            <a className="fx-link" href={`/o/${orgId}/catalog`}>
              Gestionar catálogo
            </a>
          </header>
          <div className="fx-panel-body">
            <div className="fx-toolbar">
              <div className="fx-field" style={{ flex: '3 1 16rem' }}>
                <label htmlFor="s-q">Buscar producto</label>
                <div className="fx-search">
                  <Icon name="search" />
                  <input
                    id="s-q"
                    ref={searchRef}
                    type="search"
                    className="fx-input fx-input-lg"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addFromSearch();
                      }
                    }}
                    placeholder="Nombre o SKU · Enter añade"
                    aria-describedby="s-q-hint"
                    autoComplete="off"
                  />
                </div>
                <p id="s-q-hint" className="sr-only">
                  Escribe un SKU exacto y pulsa Enter para añadirlo al carrito.
                </p>
              </div>
              {currencies.length > 1 ? (
                <div className="fx-field" style={{ flex: '0 1 9rem' }}>
                  <label htmlFor="s-cur">Moneda</label>
                  <select
                    id="s-cur"
                    className="fx-select fx-input-lg"
                    value={currency}
                    onChange={(e) => changeCurrency(e.target.value)}
                    disabled={cart.length > 0}
                    aria-describedby="s-cur-hint"
                  >
                    {currencies.map((c) => (
                      <option key={c} value={c} title={currencyName(c, 'es')}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <p id="s-cur-hint" className="fx-hint">
                    {cart.length > 0
                      ? 'Vacía el carrito para cambiarla.'
                      : 'Una venta, una moneda.'}
                  </p>
                </div>
              ) : null}
            </div>
            {categories.length > 0 ? (
              <ul className="fx-chips" aria-label="Filtrar por categoría">
                <li>
                  <button
                    type="button"
                    className="fx-chip"
                    aria-pressed={cat === null}
                    onClick={() => setCat(null)}
                  >
                    Todas
                  </button>
                </li>
                {categories.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="fx-chip"
                      aria-pressed={cat === c.id}
                      onClick={() => setCat(c.id)}
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {products.length === 0 ? (
              <div className="fx-empty">
                <h3>No hay productos disponibles</h3>
                <p>Agrega productos al catálogo (o márcalos como disponibles) para vender.</p>
                <a className="fx-btn fx-btn-primary" href={`/o/${orgId}/catalog/new`}>
                  Nuevo producto
                </a>
              </div>
            ) : families.length === 0 ? (
              <div className="fx-empty">
                <h3>Sin coincidencias</h3>
                <p>Ningún producto disponible coincide con la búsqueda.</p>
              </div>
            ) : (
              <ul className="fx-products" aria-label="Productos disponibles">
                {families.map((f) => (
                  <ProductCard key={f.key} family={f} cart={cart} locked={locked} onAdd={add} />
                ))}
              </ul>
            )}
          </div>
        </section>

        {cart.length > 0 && !reviewing ? (
          <div className="fx-cartbar">
            <span>
              {units} art. · <strong>{fmt(total, currency)}</strong>
            </span>
            <a className="fx-btn fx-btn-sm" href="#cart-title">
              Ver carrito
            </a>
          </div>
        ) : null}

        <section className="fx-panel fx-cart" aria-labelledby="cart-title">
          <header>
            <h2 id="cart-title" ref={reviewRef} tabIndex={-1}>
              {reviewing ? 'Revisar la venta' : 'Carrito'}
              {cart.length > 0 ? (
                <span className="fx-hint" style={{ marginLeft: 8, fontWeight: 500 }}>
                  {units} art.
                </span>
              ) : null}
            </h2>
            {cart.length > 0 && !locked ? (
              <button type="button" className="fx-btn fx-btn-sm fx-btn-ghost" onClick={reset}>
                Vaciar
              </button>
            ) : null}
          </header>
          <div className="fx-panel-body">
            <div ref={alertRef} tabIndex={-1}>
              {step.kind === 'failed' ? (
                <div className="fx-callout" data-tone="bad" role="alert">
                  <p>{step.message}</p>
                </div>
              ) : null}
              {step.kind === 'uncertain' ? (
                <div className="fx-callout" data-tone="warn" role="alert">
                  <div>
                    <p>
                      <strong>No sabemos si la venta se registró.</strong>
                    </p>
                    <p>
                      Reintentar es seguro: usa la misma clave y, si ya se creó, devuelve la misma
                      venta (no se duplica). El carrito queda bloqueado mientras tanto.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            {merchants.length > 1 ? (
              <div className="fx-field">
                <label htmlFor="s-merchant">Comercio</label>
                <select
                  id="s-merchant"
                  className="fx-select"
                  value={merchantId}
                  onChange={(e) => setMerchantId(e.target.value)}
                  disabled={locked}
                >
                  {merchants.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {cart.length === 0 ? (
              <div className="fx-empty" style={{ padding: '24px 8px' }}>
                <h3>El carrito está vacío</h3>
                <p>Toca un producto o escribe su SKU y pulsa Enter.</p>
              </div>
            ) : (
              <ul className="fx-cart-lines" aria-label="Líneas de la venta">
                {lines.map((l) => {
                  const label = l.product ? productLabel(l.product) : 'producto';
                  return (
                    <li key={l.productId} className="fx-cart-line">
                      {l.product ? (
                        <ProductThumb product={l.product} />
                      ) : (
                        <span className="fx-thumb" aria-hidden="true">
                          ?
                        </span>
                      )}
                      <div style={{ minWidth: 0 }}>
                        <span className="fx-cell-main">
                          {l.product ? label : 'Producto no disponible'}
                        </span>
                        <span className="fx-cell-sub">
                          {l.product
                            ? `${fmt(l.product.price, currency)} c/u${
                                l.product.track_stock ? ` · libres ${l.max}` : ''
                              }`
                            : 'Ya no está a la venta: quítalo'}
                        </span>
                      </div>
                      <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(l.total, currency)}
                      </strong>
                      <div className="fx-cart-line-ctl">
                        <div
                          className="fx-qty"
                          role="group"
                          aria-label={`Cantidad de ${l.product?.name ?? 'producto'}`}
                        >
                          <button
                            type="button"
                            onClick={() => setQty(l.productId, l.qty - 1)}
                            disabled={locked || l.qty <= 1}
                            aria-label="Restar uno"
                          >
                            −
                          </button>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={l.max || 1}
                            value={l.qty}
                            onChange={(e) =>
                              setQty(l.productId, Number.parseInt(e.target.value, 10))
                            }
                            disabled={locked}
                            aria-label="Cantidad"
                          />
                          <button
                            type="button"
                            onClick={() => setQty(l.productId, l.qty + 1)}
                            disabled={locked || l.qty >= l.max}
                            aria-label="Sumar uno"
                          >
                            +
                          </button>
                        </div>
                        <button
                          type="button"
                          className="fx-btn fx-btn-sm fx-btn-ghost"
                          onClick={() => remove(l.productId)}
                          disabled={locked}
                          aria-label={`Quitar ${l.product?.name ?? 'producto'}`}
                        >
                          <Icon name="trash" size={16} /> Quitar
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {cart.length > 0 ? (
              <>
                <CustomerPicker
                  orgId={orgId}
                  value={customer}
                  onChange={setCustomer}
                  disabled={locked}
                />
                <div className="fx-field">
                  <label htmlFor="s-note">Nota interna (opcional)</label>
                  <input
                    id="s-note"
                    className="fx-input"
                    maxLength={280}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={locked}
                  />
                </div>
                <div className="fx-cart-total">
                  <span>Total</span>
                  <output aria-live="polite">{fmt(total, currency)}</output>
                </div>
                <p className="fx-hint" style={{ marginBottom: 12 }}>
                  {merchant?.name ? `${merchant.name} · ` : ''}
                  {currencyName(currency, 'es')}. Sin impuestos desglosados. El servidor confirma el
                  total y las existencias al registrar.
                </p>
                {totalTooLarge ? (
                  <p className="fx-error-text">El total excede el máximo permitido.</p>
                ) : null}
                {overStock.length > 0 ? (
                  <p className="fx-error-text">
                    Hay más unidades que existencias libres: ajusta las cantidades.
                  </p>
                ) : null}
                {step.kind === 'cart' || step.kind === 'failed' ? (
                  <button
                    type="button"
                    className="fx-btn fx-btn-primary fx-btn-block fx-btn-lg"
                    onClick={() => setStep({ kind: 'review' })}
                    disabled={missing.length > 0 || totalTooLarge || overStock.length > 0}
                  >
                    Revisar venta
                  </button>
                ) : null}
                {step.kind === 'review' || step.kind === 'creating' || step.kind === 'uncertain' ? (
                  <div className="fx-actions" style={{ flexDirection: 'column' }}>
                    <p className="fx-hint">
                      Al confirmar se registra la venta por <strong>{fmt(total, currency)}</strong>
                      {customer ? ` para ${customer.name ?? customer.email}` : ' sin cliente'}. El
                      cobro es el paso siguiente.
                    </p>
                    <button
                      type="button"
                      className="fx-btn fx-btn-primary fx-btn-block fx-btn-lg"
                      onClick={() => void create()}
                      disabled={step.kind === 'creating'}
                    >
                      {step.kind === 'creating'
                        ? 'Registrando…'
                        : step.kind === 'uncertain'
                          ? 'Reintentar de forma segura'
                          : 'Confirmar venta'}
                    </button>
                    {step.kind === 'review' ? (
                      <button
                        type="button"
                        className="fx-btn fx-btn-block"
                        onClick={() => setStep({ kind: 'cart' })}
                      >
                        Volver a editar
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}

/**
 * Tarjeta del mostrador. Producto simple: toda la tarjeta es el botón.
 * Familia con variantes: foto + nombre y un chip por variante (cada uno su
 * botón, con precio). Agotado ⇒ deshabilitado con su motivo en texto.
 */
function ProductCard({
  family,
  cart,
  locked,
  onAdd,
}: {
  family: Family;
  cart: Array<{ productId: string; qty: number }>;
  locked: boolean;
  onAdd: (p: Product) => void;
}) {
  const inCartOf = (id: string) => cart.find((l) => l.productId === id)?.qty ?? 0;
  const famQty = family.members.reduce((a, m) => a + inCartOf(m.id), 0);
  const single = family.members.length === 1 ? family.members[0]! : null;
  if (single) {
    const p = single;
    const out = stockLevel(p) === 'out';
    const inCart = inCartOf(p.id);
    return (
      <li>
        <div
          className="fx-pcard"
          data-in-cart={inCart > 0 ? 'true' : undefined}
          data-out={out ? 'true' : undefined}
        >
          <button
            type="button"
            className="fx-product"
            onClick={() => onAdd(p)}
            disabled={locked || out}
            aria-label={`Añadir ${productLabel(p)}, ${fmt(p.price, p.currency)}${
              out ? ', agotado' : ''
            }${inCart ? `, ${inCart} en el carrito` : ''}`}
          >
            <ProductThumb product={p} />
            <span className="fx-product-body">
              <span className="fx-product-name">{productLabel(p)}</span>
              <span className="fx-product-meta">
                {p.category_name ?? 'Sin categoría'}
                {p.sku ? ` · ${p.sku}` : ''}
              </span>
              <span className="fx-product-price">{fmt(p.price, p.currency)}</span>
            </span>
          </button>
          <StockBadge product={p} />
          {inCart ? (
            <span className="fx-product-qty" aria-hidden="true">
              × {inCart}
            </span>
          ) : null}
        </div>
      </li>
    );
  }
  const head = family.head;
  const prices = family.members.map((m) => m.price);
  const min = Math.min(...prices);
  return (
    <li>
      <div className="fx-pcard" data-in-cart={famQty > 0 ? 'true' : undefined}>
        <ProductThumb product={head} />
        <div className="fx-product-body">
          <span className="fx-product-name">{head.name}</span>
          <span className="fx-product-meta">
            {family.members.length} presentaciones · desde {fmt(min, head.currency)}
          </span>
        </div>
        <ul className="fx-vchips" aria-label={`Presentaciones de ${head.name}`}>
          {family.members.map((m) => {
            const out = stockLevel(m) === 'out';
            const inCart = inCartOf(m.id);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onAdd(m)}
                  disabled={locked || out}
                  aria-label={`Añadir ${productLabel(m)}, ${fmt(m.price, m.currency)}${
                    out ? ', agotado' : ''
                  }${inCart ? `, ${inCart} en el carrito` : ''}`}
                >
                  <span>
                    {m.variant_label ?? m.name}
                    {out ? ' · agotado' : inCart ? ` · ×${inCart}` : ''}
                  </span>
                  <span>{fmt(m.price, m.currency)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {famQty ? (
          <span className="fx-product-qty" aria-hidden="true">
            × {famQty}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Cliente opcional: buscar uno existente o crear una ficha mínima. */
function CustomerPicker({
  orgId,
  value,
  onChange,
  disabled,
}: {
  orgId: string;
  value: Pick<Customer, 'id' | 'name' | 'email'> | null;
  onChange: (c: Pick<Customer, 'id' | 'name' | 'email'> | null) => void;
  disabled: boolean;
}) {
  const o = encodeURIComponent(orgId);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Customer[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  async function search() {
    setMsg(null);
    const r = await clientCall<{ data: Customer[] }>(
      `/api/orgs/${o}/customers?q=${encodeURIComponent(q.trim())}`
    );
    if (r.kind === 'ok') setResults(r.body.data);
    else setMsg(errorMessage(r));
  }

  async function createCustomer() {
    if (!name.trim()) {
      setMsg('Escribe al menos el nombre.');
      return;
    }
    const r = await clientCall<Customer>(`/api/orgs/${o}/customers`, {
      method: 'POST',
      body: { name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) },
    });
    if (r.kind === 'ok') {
      onChange({ id: r.body.id, name: r.body.name, email: r.body.email });
      setCreating(false);
      setName('');
      setPhone('');
      setMsg(`Cliente ${r.body.name} creado y asignado.`);
    } else setMsg(errorMessage(r));
  }

  if (value) {
    return (
      <div className="fx-field">
        <span className="fx-label">Cliente</span>
        <div className="fx-row" style={{ alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{value.name ?? value.email}</span>
          <button
            type="button"
            className="fx-btn fx-btn-sm"
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            Quitar cliente
          </button>
        </div>
      </div>
    );
  }
  return (
    <fieldset className="fx-field" style={{ border: 0, padding: 0, margin: '16px 0' }}>
      <legend>Cliente (opcional)</legend>
      <div className="fx-row" style={{ alignItems: 'stretch' }}>
        <input
          className="fx-input"
          style={{ flex: '1 1 8rem' }}
          aria-label="Buscar cliente por nombre, email o teléfono"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void search();
            }
          }}
          disabled={disabled}
          placeholder="Nombre, email o teléfono"
        />
        <button
          type="button"
          className="fx-btn fx-btn-sm"
          onClick={() => void search()}
          disabled={disabled}
        >
          Buscar
        </button>
      </div>
      {results !== null ? (
        results.length === 0 ? (
          <p className="fx-hint">Sin resultados.</p>
        ) : (
          <ul className="fx-cart-lines" aria-label="Clientes encontrados">
            {results.slice(0, 6).map((c) => (
              <li key={c.id} className="fx-row" style={{ alignItems: 'center', padding: '6px 0' }}>
                <span style={{ flex: 1 }}>
                  {c.name ?? c.email ?? c.phone}
                  <span className="fx-cell-sub">{c.email ?? c.phone ?? ''}</span>
                </span>
                <button
                  type="button"
                  className="fx-btn fx-btn-sm"
                  onClick={() => onChange({ id: c.id, name: c.name, email: c.email })}
                  disabled={disabled}
                >
                  Asignar
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {creating ? (
        <div style={{ marginTop: 8 }}>
          <div className="fx-field">
            <label htmlFor="nc-name">Nombre del cliente</label>
            <input
              id="nc-name"
              className="fx-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="fx-field">
            <label htmlFor="nc-phone">Teléfono (opcional)</label>
            <input
              id="nc-phone"
              className="fx-input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="fx-actions">
            <button
              type="button"
              className="fx-btn fx-btn-sm"
              onClick={() => void createCustomer()}
            >
              Crear y asignar
            </button>
            <button type="button" className="fx-btn fx-btn-sm" onClick={() => setCreating(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="fx-btn fx-btn-sm"
          style={{ marginTop: 8 }}
          onClick={() => setCreating(true)}
          disabled={disabled}
        >
          Cliente nuevo
        </button>
      )}
      <p className="fx-hint" aria-live="polite">
        {msg}
      </p>
    </fieldset>
  );
}
