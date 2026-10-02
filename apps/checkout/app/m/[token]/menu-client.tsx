'use client';

import { useMemo, useRef, useState } from 'react';
import { formatAmount } from '../../lib/money-format';

/**
 * Menú de la mesa para el COMENSAL (QR). Muestra SOLO lo que el comercio cargó
 * en su catálogo: si no informó ingredientes o alérgenos, se dice tal cual
 * («no informado») — nunca se inventan ni se garantizan.
 * El total se muestra antes de confirmar y el servidor lo vuelve a calcular;
 * si cambió, el pedido no se crea. Un reintento usa la MISMA clave: nunca
 * duplica el pedido.
 */

export interface PublicMenuItem {
  id: string;
  name: string;
  description: string | null;
  ingredients: string | null;
  allergen_info: string | null;
  price: number;
  currency: string;
  category_name: string | null;
  modifier_groups: Array<{
    id: string;
    name: string;
    min_select: number;
    max_select: number;
    options: Array<{ id: string; name: string; price_delta: number; available: boolean }>;
  }>;
}

interface CartLine {
  key: string;
  item: PublicMenuItem;
  qty: number;
  options: string[];
  note: string;
}

const money = (n: number, c: string) => formatAmount(n, c, 'es');
const unitOf = (l: CartLine) =>
  l.item.price +
  l.item.modifier_groups
    .flatMap((g) => g.options)
    .filter((o) => l.options.includes(o.id))
    .reduce((s, o) => s + o.price_delta, 0);

export function MenuClient({
  token,
  merchant,
  table,
  menu,
  ordering,
}: {
  token: string;
  merchant: string;
  table: string;
  menu: PublicMenuItem[];
  ordering: { enabled: boolean; needs_acceptance: boolean };
}) {
  const [cat, setCat] = useState<string | null>(null);
  const [open, setOpen] = useState<PublicMenuItem | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [name, setName] = useState('');
  const [step, setStep] = useState<'menu' | 'review'>('menu');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const keyRef = useRef<string | null>(null);
  const cats = useMemo(() => [...new Set(menu.map((m) => m.category_name ?? 'Otros'))], [menu]);
  const currency = menu[0]?.currency ?? 'USD';
  const total = cart.reduce((s, l) => s + unitOf(l) * l.qty, 0);
  const shown = menu.filter((m) => !cat || (m.category_name ?? 'Otros') === cat);

  async function confirm() {
    setSending(true);
    setError(null);
    keyRef.current ??= `qr-${crypto.randomUUID()}`;
    let res: Response;
    try {
      res = await fetch(`/api/mesa/t/${token}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': keyRef.current },
        body: JSON.stringify({
          customer_name: name.trim() || null,
          expected_total: total,
          lines: cart.map((l) => ({
            product_id: l.item.id,
            quantity: l.qty,
            option_ids: l.options,
            ...(l.note.trim() ? { note: l.note.trim() } : {}),
          })),
        }),
      });
    } catch {
      setSending(false);
      return setError('Sin conexión. Toca «Confirmar» de nuevo: no se duplicará tu pedido.');
    }
    const body = (await res.json().catch(() => null)) as {
      tracking_token?: string;
      error?: { code?: string };
    } | null;
    setSending(false);
    if (res.ok && body?.tracking_token) {
      try {
        localStorage.setItem(`fluvia-mesa-${token}`, body.tracking_token);
      } catch {
        /* sin almacenamiento: el enlace sigue funcionando */
      }
      window.location.href = `/p#${body.tracking_token}`;
      return;
    }
    const code = body?.error?.code;
    setError(
      code === 'conflict' || code === 'invalid_state_transition'
        ? 'Los precios cambiaron. Revisa tu pedido: recargamos el menú.'
        : code === 'modifier_selection_invalid'
          ? 'Falta elegir una opción obligatoria.'
          : code === 'product_unavailable'
            ? 'Algo de tu pedido ya no está disponible.'
            : res.status === 502
              ? 'Sin respuesta. Toca «Confirmar» de nuevo: no se duplicará tu pedido.'
              : 'No pudimos crear el pedido. Pide ayuda al personal.'
    );
  }

  let previous: string | null = null;
  try {
    previous = typeof window !== 'undefined' ? localStorage.getItem(`fluvia-mesa-${token}`) : null;
  } catch {
    previous = null;
  }

  return (
    <main className="mesa" aria-labelledby="mesa-title">
      <header className="mesa-head">
        <p className="co-muted">{merchant}</p>
        <h1 id="mesa-title">Mesa {table}</h1>
        {previous ? (
          <p>
            <a className="mesa-link" href={`/p#${previous}`}>
              Ver mi pedido
            </a>
          </p>
        ) : null}
      </header>

      {step === 'menu' ? (
        <>
          <nav className="mesa-chips" aria-label="Categorías">
            <button
              type="button"
              className="mesa-chip"
              aria-pressed={cat === null}
              onClick={() => setCat(null)}
            >
              Todo
            </button>
            {cats.map((c) => (
              <button
                key={c}
                type="button"
                className="mesa-chip"
                aria-pressed={cat === c}
                onClick={() => setCat(c)}
              >
                {c}
              </button>
            ))}
          </nav>
          <ul className="mesa-list">
            {shown.map((m) => (
              <li key={m.id} className="mesa-item">
                <div>
                  <h2>{m.name}</h2>
                  {m.description ? <p>{m.description}</p> : null}
                  <p className="co-muted">
                    Ingredientes: {m.ingredients ?? 'no informado por el comercio'}
                  </p>
                  <p className="co-muted">
                    Alérgenos:{' '}
                    {m.allergen_info ?? 'no informado — consulta al personal antes de pedir'}
                  </p>
                </div>
                <div className="mesa-item-side">
                  <strong>{money(m.price, m.currency)}</strong>
                  {ordering.enabled ? (
                    <button
                      type="button"
                      className="mesa-add"
                      onClick={() => setOpen(m)}
                      aria-label={`Agregar ${m.name}`}
                    >
                      Agregar
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {!ordering.enabled ? (
            <p className="notice">Este local no recibe pedidos por QR: pide al personal.</p>
          ) : null}
          {cart.length ? (
            <div className="mesa-bar">
              <span>
                {cart.reduce((s, l) => s + l.qty, 0)} artículo(s) · {money(total, currency)}
              </span>
              <button type="button" className="pay" onClick={() => setStep('review')}>
                Revisar pedido
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <section aria-labelledby="rev-title" className="mesa-review">
          <h2 id="rev-title">Tu pedido</h2>
          <ul className="order-lines">
            {cart.map((l) => (
              <li key={l.key}>
                <span>
                  {l.qty}× {l.item.name}
                  {l.options.length ? (
                    <small className="co-muted">
                      {' '}
                      ·{' '}
                      {l.item.modifier_groups
                        .flatMap((g) => g.options)
                        .filter((o) => l.options.includes(o.id))
                        .map((o) => o.name)
                        .join(', ')}
                    </small>
                  ) : null}
                </span>
                <span className="num">{money(unitOf(l) * l.qty, currency)}</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setCart((c) => c.filter((x) => x.key !== l.key))}
                >
                  Quitar
                </button>
              </li>
            ))}
          </ul>
          <p className="mesa-total">
            <span>Total</span>
            <strong>{money(total, currency)}</strong>
          </p>
          <label className="mesa-field">
            <span>Tu nombre (opcional)</span>
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <p className="co-muted">
            {ordering.needs_acceptance
              ? 'El personal confirmará tu pedido antes de enviarlo a cocina.'
              : 'Tu pedido irá directo a cocina.'}{' '}
            Pagarás al final, desde tu teléfono o con el personal.
          </p>
          <button
            type="button"
            className="pay"
            disabled={sending || !cart.length}
            onClick={() => void confirm()}
          >
            {sending ? 'Enviando…' : `Confirmar pedido · ${money(total, currency)}`}
          </button>
          <button type="button" className="secondary" onClick={() => setStep('menu')}>
            Seguir eligiendo
          </button>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      )}

      {open ? (
        <ItemSheet
          item={open}
          onClose={() => setOpen(null)}
          onAdd={(options, qty, note) => {
            setCart((c) => [...c, { key: crypto.randomUUID(), item: open, qty, options, note }]);
            setOpen(null);
          }}
        />
      ) : null}
    </main>
  );
}

function ItemSheet({
  item,
  onClose,
  onAdd,
}: {
  item: PublicMenuItem;
  onClose: () => void;
  onAdd: (options: string[], qty: number, note: string) => void;
}) {
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const valid = item.modifier_groups.every((g) => {
    const n = (sel[g.id] ?? []).length;
    return n >= g.min_select && n <= g.max_select;
  });
  const unit =
    item.price +
    item.modifier_groups
      .flatMap((g) => g.options)
      .filter((o) => Object.values(sel).flat().includes(o.id))
      .reduce((s, o) => s + o.price_delta, 0);
  return (
    <dialog
      open
      className="mesa-sheet"
      aria-labelledby="sheet-title"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <h2 id="sheet-title">{item.name}</h2>
      {item.modifier_groups.map((g) => (
        <fieldset key={g.id}>
          <legend>
            {g.name}{' '}
            <small className="co-muted">
              {g.min_select > 0 ? 'obligatorio' : 'opcional'}
              {g.max_select > 1 ? `, hasta ${g.max_select}` : ''}
            </small>
          </legend>
          <div className="mesa-chips">
            {g.options.map((o) => {
              const on = (sel[g.id] ?? []).includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  className="mesa-chip"
                  aria-pressed={on}
                  disabled={!o.available}
                  onClick={() =>
                    setSel((s) => {
                      const cur = s[g.id] ?? [];
                      if (on) return { ...s, [g.id]: cur.filter((x) => x !== o.id) };
                      return {
                        ...s,
                        [g.id]: g.max_select === 1 ? [o.id] : [...cur, o.id].slice(0, g.max_select),
                      };
                    })
                  }
                >
                  {o.name}
                  {o.price_delta ? ` +${money(o.price_delta, item.currency)}` : ''}
                  {!o.available ? ' (agotado)' : ''}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      <label className="mesa-field">
        <span>Cantidad</span>
        <input
          inputMode="numeric"
          value={qty}
          onChange={(e) => setQty(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
        />
      </label>
      <label className="mesa-field">
        <span>Nota para cocina (opcional)</span>
        <input value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button
        type="button"
        className="pay"
        disabled={!valid}
        onClick={() => onAdd(Object.values(sel).flat(), qty, note)}
      >
        Agregar · {money(unit * qty, item.currency)}
      </button>
      <button type="button" className="secondary" onClick={onClose}>
        Cancelar
      </button>
    </dialog>
  );
}
