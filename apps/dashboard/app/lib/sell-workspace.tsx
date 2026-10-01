'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatAmount } from '../messages';
import type { Merchant } from './api';
import { clientCall, errorMessage } from './client-call';
import type { Category, Customer, OrderDetail, Product } from './commerce-api';

/**
 * Nueva venta: catálogo → carrito → cliente (opcional) → revisión → registrar.
 *
 * Reglas de dinero:
 *  - El total mostrado es una PREVISIÓN; el servidor lo recalcula con los
 *    precios vigentes y rechaza (409) si no coincide con el que vio el cajero:
 *    nunca se cobra un importe distinto del revisado.
 *  - Una `Idempotency-Key` por carrito revisado: reintentar tras un resultado
 *    incierto devuelve la MISMA venta; cambiar el carrito genera otra key.
 *  - Tras un resultado incierto el carrito queda BLOQUEADO hasta comprobarlo.
 *  - Una venta = una moneda (la del primer producto).
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

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const lines = cart.map((l) => {
    const p = byId.get(l.productId);
    return { ...l, product: p, total: p ? p.price * l.qty : 0 };
  });
  const total = lines.reduce((a, l) => a + l.total, 0);
  const missing = lines.filter((l) => !l.product);
  const locked = step.kind === 'creating' || step.kind === 'uncertain' || step.kind === 'created';
  const totalTooLarge = !Number.isSafeInteger(total);

  const visible = products.filter(
    (p) =>
      p.currency === currency &&
      (cat === null || p.category_id === cat) &&
      (q.trim() === '' ||
        p.name.toLowerCase().includes(q.trim().toLowerCase()) ||
        (p.sku ?? '').toLowerCase().includes(q.trim().toLowerCase()))
  );

  useEffect(() => {
    if (step.kind === 'failed' || step.kind === 'uncertain') alertRef.current?.focus();
    if (step.kind === 'review') reviewRef.current?.focus();
    if (step.kind === 'created') alertRef.current?.focus();
  }, [step.kind]);

  const add = useCallback(
    (p: Product) => {
      if (locked) return;
      setCart((c) => {
        const found = c.find((l) => l.productId === p.id);
        if (found) {
          return c.map((l) =>
            l.productId === p.id ? { ...l, qty: Math.min(MAX_QTY, l.qty + 1) } : l
          );
        }
        if (c.length >= MAX_LINES) return c;
        return [...c, { productId: p.id, qty: 1 }];
      });
      setAnnounce(`${p.name} añadido al carrito.`);
      if (step.kind !== 'cart') setStep({ kind: 'cart' });
    },
    [locked, step.kind]
  );

  const setQty = (productId: string, qty: number) => {
    if (locked) return;
    if (!Number.isInteger(qty) || qty < 1) qty = 1;
    setCart((c) =>
      c.map((l) => (l.productId === productId ? { ...l, qty: Math.min(MAX_QTY, qty) } : l))
    );
    if (step.kind !== 'cart') setStep({ kind: 'cart' });
  };

  const remove = (productId: string) => {
    if (locked) return;
    const name = byId.get(productId)?.name ?? 'Producto';
    setCart((c) => c.filter((l) => l.productId !== productId));
    setAnnounce(`${name} quitado del carrito.`);
    if (step.kind !== 'cart') setStep({ kind: 'cart' });
  };

  const changeCurrency = (c: string) => {
    if (cart.length > 0 && c !== currency) return; // una venta = una moneda
    setCurrency(c);
  };

  const refreshPrices = useCallback(async () => {
    const r = await clientCall<{ data: Product[] }>(`/api/orgs/${o}/catalog/products`);
    if (r.kind === 'ok') {
      setProducts(r.body.data);
      setAnnounce('Precios actualizados con el catálogo vigente.');
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
      if (r.code === 'order_total_changed' || r.code === 'product_unavailable') {
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
      <section className="fx-panel" aria-labelledby="created-title">
        <div className="fx-panel-body">
          <div ref={alertRef} tabIndex={-1} className="fx-callout" data-tone="ok" role="status">
            <div>
              <p>
                <strong id="created-title">Venta #{ord.number} registrada</strong>
              </p>
              <p>
                Total {fmt(ord.total, ord.currency)} · {ord.line_count}{' '}
                {ord.line_count === 1 ? 'línea' : 'líneas'}
                {ord.customer_name ? ` · ${ord.customer_name}` : ''}. Aún no se ha cobrado.
              </p>
            </div>
          </div>
          <div className="fx-actions">
            <a className="fx-btn fx-btn-primary" href={posHref}>
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
              <div className="fx-field">
                <label htmlFor="s-q">Buscar producto</label>
                <input
                  id="s-q"
                  type="search"
                  className="fx-input"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Nombre o SKU"
                />
              </div>
              {currencies.length > 1 ? (
                <div className="fx-field" style={{ flex: '0 1 9rem' }}>
                  <label htmlFor="s-cur">Moneda</label>
                  <select
                    id="s-cur"
                    className="fx-select"
                    value={currency}
                    onChange={(e) => changeCurrency(e.target.value)}
                    disabled={cart.length > 0}
                    aria-describedby="s-cur-hint"
                  >
                    {currencies.map((c) => (
                      <option key={c}>{c}</option>
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
            ) : visible.length === 0 ? (
              <div className="fx-empty">
                <h3>Sin coincidencias</h3>
                <p>Ningún producto disponible coincide con la búsqueda.</p>
              </div>
            ) : (
              <ul className="fx-products" aria-label="Productos disponibles">
                {visible.map((p) => {
                  const inCart = cart.find((l) => l.productId === p.id)?.qty ?? 0;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="fx-product"
                        onClick={() => add(p)}
                        disabled={locked}
                        aria-label={`Añadir ${p.name}, ${fmt(p.price, p.currency)}${inCart ? `, ${inCart} en el carrito` : ''}`}
                      >
                        <span className="fx-product-name">{p.name}</span>
                        <span className="fx-product-meta">
                          {p.category_name ?? 'Sin categoría'}
                          {p.sku ? ` · ${p.sku}` : ''}
                        </span>
                        <span className="fx-product-price">{fmt(p.price, p.currency)}</span>
                        {inCart ? <span className="fx-product-qty">× {inCart}</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="fx-panel fx-cart" aria-labelledby="cart-title">
          <header>
            <h2 id="cart-title" ref={reviewRef} tabIndex={-1}>
              {reviewing ? 'Revisar la venta' : 'Carrito'}
            </h2>
            {cart.length > 0 && !locked ? (
              <button type="button" className="fx-btn fx-btn-sm" onClick={reset}>
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
                <p>Elige productos de la lista para empezar.</p>
              </div>
            ) : (
              <ul className="fx-cart-lines" aria-label="Líneas de la venta">
                {lines.map((l) => (
                  <li key={l.productId} className="fx-cart-line">
                    <div>
                      <span className="fx-cell-main">
                        {l.product?.name ?? 'Producto no disponible'}
                      </span>
                      <span className="fx-cell-sub">
                        {l.product
                          ? `${fmt(l.product.price, currency)} c/u`
                          : 'Ya no está a la venta: quítalo'}
                      </span>
                    </div>
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(l.total, currency)}
                    </strong>
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
                        max={MAX_QTY}
                        value={l.qty}
                        onChange={(e) => setQty(l.productId, Number.parseInt(e.target.value, 10))}
                        disabled={locked}
                        aria-label="Cantidad"
                      />
                      <button
                        type="button"
                        onClick={() => setQty(l.productId, l.qty + 1)}
                        disabled={locked || l.qty >= MAX_QTY}
                        aria-label="Sumar uno"
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      className="fx-btn fx-btn-sm"
                      onClick={() => remove(l.productId)}
                      disabled={locked}
                      aria-label={`Quitar ${l.product?.name ?? 'producto'}`}
                    >
                      Quitar
                    </button>
                  </li>
                ))}
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
                  {merchant?.name ? `${merchant.name} · ` : ''}Sin impuestos desglosados (pendiente
                  de la decisión de mercado). El servidor recalcula el total con los precios
                  vigentes.
                </p>
                {totalTooLarge ? (
                  <p className="fx-error-text">El total excede el máximo permitido.</p>
                ) : null}
                {step.kind === 'cart' || step.kind === 'failed' ? (
                  <button
                    type="button"
                    className="fx-btn fx-btn-primary fx-btn-block"
                    onClick={() => setStep({ kind: 'review' })}
                    disabled={missing.length > 0 || totalTooLarge}
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
                      className="fx-btn fx-btn-primary fx-btn-block"
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
