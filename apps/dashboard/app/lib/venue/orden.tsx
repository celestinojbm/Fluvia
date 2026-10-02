'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { errorMessage, type CallResult } from '../client-call';
import { parseMajorAmount } from '../pos-money';
import { money } from '../ui';
import { QrCode } from './qr';
import {
  CHARGE_LABEL,
  MODE_LABEL,
  ORDER_STATUS_LABEL,
  PREP_LABEL,
  newClientKey,
  vcall,
  type Bill,
  type DiningOrder,
  type InPersonPayment,
  type MenuItem,
  type VenueLayout,
} from './api';
import { useDiningStream } from './use-dining-stream';

/**
 * Pedido de mesa / mostrador: abrir → agregar con modificadores → guardar →
 * enviar a cocina → agregados posteriores (nueva revisión) → pedir la cuenta
 * → dividir y cobrar. Los precios y totales que valen son los del SERVIDOR
 * (precio histórico por línea); el carrito local es solo un borrador visible.
 * Cada escritura lleva la versión del pedido: si otro dispositivo cambió algo,
 * el servidor responde 409 y la pantalla se recarga con el estado real.
 */

interface CartLine {
  key: string;
  item: MenuItem;
  quantity: number;
  optionIds: string[];
  note: string;
}

const lineUnit = (c: CartLine) =>
  c.item.price +
  c.item.modifier_groups
    .flatMap((g) => g.options)
    .filter((o) => c.optionIds.includes(o.id))
    .reduce((s, o) => s + o.price_delta, 0);

export function OrderWorkspace({
  orgId,
  initialOrder,
  menu,
  tables,
  initialBill,
}: {
  orgId: string;
  initialOrder: DiningOrder;
  menu: MenuItem[];
  tables: VenueLayout['branches'][number]['tables'];
  initialBill: Bill | null;
}) {
  const [order, setOrder] = useState(initialOrder);
  const [bill, setBill] = useState(initialBill);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [picking, setPicking] = useState<MenuItem | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const r = await vcall<DiningOrder>(orgId, `dining/orders/${order.id}`);
    if (r.kind === 'ok') setOrder(r.body);
    const b = await vcall<Bill>(orgId, `dining/orders/${order.id}/bill`);
    if (b.kind === 'ok') setBill(b.body);
  }, [orgId, order.id]);
  const conn = useDiningStream(orgId, order.branch_id, () => void reload());

  const fail = (r: Exclude<CallResult, { kind: 'ok' }>) => {
    setMsg({
      tone: 'bad',
      text:
        r.kind === 'http' && r.code === 'version_conflict'
          ? 'Otro dispositivo cambió este pedido. Se recargó con el estado real; revisa y repite.'
          : r.kind === 'http' && r.code === 'modifier_selection_invalid'
            ? 'Falta elegir una opción obligatoria o hay una opción no disponible.'
            : r.kind === 'http' && r.code === 'product_unavailable'
              ? 'Un producto ya no está disponible.'
              : errorMessage(r),
    });
    void reload();
  };

  const categories = useMemo(
    () => [...new Set(menu.map((m) => m.category_name ?? 'Otros'))],
    [menu]
  );
  const shown = menu.filter((m) => !category || (m.category_name ?? 'Otros') === category);
  const editable = order.status === 'open' || order.status === 'pending_acceptance';
  const cartTotal = cart.reduce((s, c) => s + lineUnit(c) * c.quantity, 0);

  async function save(): Promise<DiningOrder | null> {
    if (!cart.length) return order;
    const r = await vcall<DiningOrder>(orgId, `dining/orders/${order.id}/lines`, {
      method: 'POST',
      body: {
        expected_version: order.version,
        lines: cart.map((c) => ({
          product_id: c.item.id,
          quantity: c.quantity,
          option_ids: c.optionIds,
          ...(c.note.trim() ? { note: c.note.trim() } : {}),
        })),
      },
    });
    if (r.kind !== 'ok') {
      fail(r);
      return null;
    }
    setCart([]);
    setOrder(r.body);
    return r.body;
  }

  async function send() {
    setBusy(true);
    setMsg(null);
    const saved = await save();
    if (saved) {
      const r = await vcall<{ order: DiningOrder; tickets: unknown[] }>(
        orgId,
        `dining/orders/${order.id}/send`,
        { method: 'POST', body: { expected_version: saved.version } }
      );
      if (r.kind === 'ok') {
        setOrder(r.body.order);
        setMsg({
          tone: 'ok',
          text: r.body.tickets.length
            ? `Enviado a cocina (${r.body.tickets.length} comanda${r.body.tickets.length > 1 ? 's' : ''}).`
            : 'No había nada nuevo que enviar.',
        });
      } else fail(r);
    }
    setBusy(false);
  }

  async function orderAction(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setMsg(null);
    const r = await vcall<DiningOrder>(orgId, `dining/orders/${order.id}/${path}`, {
      method: 'POST',
      body: { expected_version: order.version, ...body },
    });
    setBusy(false);
    if (r.kind === 'ok') setOrder(r.body);
    else fail(r);
    return r.kind === 'ok';
  }

  return (
    <div className="vn-stack">
      <div className="vn-row" style={{ alignItems: 'center' }}>
        <span className="vn-pill">
          {ORDER_STATUS_LABEL[order.status]} · v{order.version}
        </span>
        <span className="vn-pill" data-tone={conn === 'live' ? 'ok' : 'warn'} role="status">
          {conn === 'live' ? 'En vivo' : 'Reconectando…'}
        </span>
        {order.attention_requested_at ? (
          <button
            type="button"
            className="fx-btn fx-btn-danger"
            onClick={() => void orderAction('attention/clear')}
          >
            ⚑ El cliente llamó · Atendido
          </button>
        ) : null}
      </div>
      {msg ? (
        <p
          className={msg.tone === 'ok' ? 'vn-pill' : 'vn-error'}
          data-tone="ok"
          role={msg.tone === 'ok' ? 'status' : 'alert'}
        >
          {msg.text}
        </p>
      ) : null}

      <div className={editable ? 'vn-pos' : 'vn-pos vn-pos-single'}>
        {editable ? (
          <section aria-labelledby="menu-title" className="vn-card">
            <h2 id="menu-title">Menú</h2>
            <div className="vn-chips" role="group" aria-label="Categorías">
              <button
                type="button"
                className="vn-chip"
                aria-pressed={category === null}
                onClick={() => setCategory(null)}
              >
                Todo
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="vn-chip"
                  aria-pressed={category === c}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="vn-menu">
              {shown.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="vn-item"
                  disabled={!m.available}
                  onClick={() =>
                    m.modifier_groups.length
                      ? setPicking(m)
                      : setCart((c) => [
                          ...c,
                          {
                            key: crypto.randomUUID(),
                            item: m,
                            quantity: 1,
                            optionIds: [],
                            note: '',
                          },
                        ])
                  }
                >
                  <strong>{m.name}</strong>
                  <span>{money(m.price, m.currency)}</span>
                  {!m.available ? (
                    <small>No disponible</small>
                  ) : m.modifier_groups.length ? (
                    <small>Con opciones</small>
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="vn-ticket" aria-labelledby="ticket-title">
          <h2 id="ticket-title">
            Pedido #{order.number} ·{' '}
            {order.table_label ? `Mesa ${order.table_label}` : MODE_LABEL[order.mode]}
          </h2>
          <ul className="vn-lines" aria-label="Líneas guardadas">
            {order.lines.map((l) => (
              <li key={l.id} className="vn-line" data-voided={l.voided}>
                <span>
                  {l.quantity}× {l.name}
                  {l.modifiers.length ? (
                    <small> · {l.modifiers.map((m) => m.name).join(', ')}</small>
                  ) : null}
                  {l.note ? <small> · {l.note}</small> : null}
                </span>
                <span>{money(l.line_total, order.currency)}</span>
                <span className="vn-status" data-s={l.voided ? 'x' : l.prep_status}>
                  {l.voided ? `Anulado: ${l.void_reason}` : PREP_LABEL[l.prep_status]}
                </span>
                {!l.voided && editable ? (
                  <VoidButton
                    onVoid={(reason) => void orderAction(`lines/${l.id}/void`, { reason })}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {cart.length ? (
            <ul className="vn-lines" aria-label="Sin guardar">
              {cart.map((c) => (
                <li key={c.key} className="vn-line">
                  <span>
                    {c.quantity}× {c.item.name}
                    {c.optionIds.length ? (
                      <small>
                        {' '}
                        ·{' '}
                        {c.item.modifier_groups
                          .flatMap((g) => g.options)
                          .filter((o) => c.optionIds.includes(o.id))
                          .map((o) => o.name)
                          .join(', ')}
                      </small>
                    ) : null}
                  </span>
                  <span>{money(lineUnit(c) * c.quantity, c.item.currency)}</span>
                  <span className="vn-status" data-s="draft">
                    Sin guardar
                  </span>
                  <button
                    type="button"
                    className="fx-btn fx-btn-sm fx-btn-ghost"
                    onClick={() => setCart((x) => x.filter((y) => y.key !== c.key))}
                  >
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="vn-total">
            <span>Total confirmado</span>
            <span>{money(order.total, order.currency)}</span>
          </p>
          {cart.length ? (
            <p className="vn-help">
              + {money(cartTotal, order.currency)} sin guardar (el servidor confirma el precio al
              guardar).
            </p>
          ) : null}
          {editable ? (
            <div className="vn-alt">
              <button
                type="button"
                className="fx-btn"
                disabled={busy || !cart.length}
                onClick={() => void save()}
              >
                Guardar
              </button>
              <button
                type="button"
                className="vn-cta vn-cta-sm"
                disabled={busy || order.status !== 'open'}
                onClick={() => void send()}
              >
                Enviar a cocina
              </button>
            </div>
          ) : null}
          {order.status === 'open' ? (
            <div className="vn-alt">
              {order.mode === 'dine_in' ? (
                <label className="fx-field">
                  <span>Mover a</span>
                  <select
                    defaultValue=""
                    onChange={(e) =>
                      e.target.value && void orderAction('move', { to_table_id: e.target.value })
                    }
                  >
                    <option value="">—</option>
                    {tables
                      .filter((t) => t.id !== order.table_id)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          Mesa {t.label}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              <button
                type="button"
                className="fx-btn"
                disabled={
                  busy ||
                  cart.length > 0 ||
                  order.lines.some((l) => !l.voided && l.prep_status === 'draft')
                }
                onClick={() => void orderAction('request-bill')}
                title="Envía primero lo pendiente a cocina"
              >
                Pedir la cuenta
              </button>
            </div>
          ) : null}
        </section>
      </div>

      {order.status === 'bill_requested' || order.status === 'closed' ? (
        <BillPanel orgId={orgId} order={order} bill={bill} setBill={setBill} onChange={reload} />
      ) : null}

      {picking ? (
        <ModifierDialog
          item={picking}
          onClose={() => setPicking(null)}
          onAdd={(optionIds, quantity, note) => {
            setCart((c) => [
              ...c,
              { key: crypto.randomUUID(), item: picking, quantity, optionIds, note },
            ]);
            setPicking(null);
          }}
        />
      ) : null}
    </div>
  );
}

function VoidButton({ onVoid }: { onVoid: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open)
    return (
      <button type="button" className="fx-btn fx-btn-sm fx-btn-ghost" onClick={() => setOpen(true)}>
        Anular…
      </button>
    );
  return (
    <form
      className="vn-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length >= 3) onVoid(reason.trim());
      }}
    >
      <label className="fx-field vn-grow">
        <span>Motivo (queda auditado)</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={3}
          maxLength={200}
          autoFocus
        />
      </label>
      <button
        type="submit"
        className="fx-btn fx-btn-danger fx-btn-sm"
        disabled={reason.trim().length < 3}
      >
        Confirmar anulación
      </button>
    </form>
  );
}

function ModifierDialog({
  item,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  onClose: () => void;
  onAdd: (optionIds: string[], quantity: number, note: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const setRef = (el: HTMLDialogElement | null) => {
    ref.current = el;
    if (el && !el.open) el.showModal();
  };
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
    <dialog ref={setRef} className="vn-dialog" aria-labelledby="mod-title" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onAdd(Object.values(sel).flat(), qty, note);
        }}
      >
        <h2 id="mod-title">{item.name}</h2>
        {item.modifier_groups.map((g) => (
          <fieldset key={g.id}>
            <legend>
              {g.name}{' '}
              <small className="vn-help">
                {g.min_select > 0
                  ? `obligatorio, elige ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`}`
                  : `opcional, hasta ${g.max_select}`}
              </small>
            </legend>
            <div className="vn-chips">
              {g.options.map((o) => {
                const on = (sel[g.id] ?? []).includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    className="vn-chip"
                    aria-pressed={on}
                    disabled={!o.available}
                    onClick={() =>
                      setSel((s) => {
                        const cur = s[g.id] ?? [];
                        if (on) return { ...s, [g.id]: cur.filter((x) => x !== o.id) };
                        const next =
                          g.max_select === 1 ? [o.id] : [...cur, o.id].slice(0, g.max_select);
                        return { ...s, [g.id]: next };
                      })
                    }
                  >
                    {o.name}
                    {o.price_delta ? ` +${money(o.price_delta, item.currency)}` : ''}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
        <div className="vn-row">
          <label className="fx-field">
            <span>Cantidad</span>
            <input
              inputMode="numeric"
              size={3}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
            />
          </label>
          <label className="fx-field vn-grow">
            <span>Nota para cocina</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} />
          </label>
        </div>
        <p className="vn-total">
          <span>Subtotal</span>
          <span>{money(unit * qty, item.currency)}</span>
        </p>
        <div className="vn-alt">
          <button type="submit" className="vn-cta vn-cta-sm" disabled={!valid}>
            Agregar
          </button>
          <button
            type="button"
            className="fx-btn fx-btn-ghost"
            onClick={() => ref.current?.close()}
          >
            Cancelar
          </button>
        </div>
      </form>
    </dialog>
  );
}

function BillPanel({
  orgId,
  order,
  bill,
  setBill,
  onChange,
}: {
  orgId: string;
  order: DiningOrder;
  bill: Bill | null;
  setBill: (b: Bill) => void;
  onChange: () => Promise<void>;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [parts, setParts] = useState('2');
  const [amountText, setAmountText] = useState('');
  const [items, setItems] = useState<string[]>([]);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [inPerson, setInPerson] = useState<Record<string, InPersonPayment>>({});

  const call = async (path: string, body: Record<string, unknown>) => {
    if (!bill) return;
    setErr(null);
    const r = await vcall<Bill>(orgId, `dining/bills/${bill.id}/${path}`, {
      method: 'POST',
      body: { expected_version: bill.version, ...body },
    });
    if (r.kind === 'ok') setBill(r.body);
    else {
      setErr(
        r.kind === 'http' && r.code === 'bill_allocation_invalid'
          ? 'Esa división no cabe en lo que falta por asignar o ya se asignó ese artículo.'
          : r.kind === 'http' && r.code === 'allocation_payment_held'
            ? 'Esa parte tiene un cobro hecho o en curso: no se puede anular. Si hay que devolver dinero, usa Devoluciones.'
            : r.kind === 'http' && r.code === 'version_conflict'
              ? 'Otro cajero cambió la cuenta. Se recargó.'
              : errorMessage(r)
      );
      void onChange();
    }
  };

  async function collectInPerson(allocationId: string) {
    const key = newClientKey(`mesa-${allocationId.slice(0, 8)}`);
    const r = await vcall<InPersonPayment>(orgId, 'in-person/payments', {
      method: 'POST',
      body: {
        method: 'simulator',
        client_key: key,
        source: { kind: 'allocation', allocation_id: allocationId },
      },
    });
    if (r.kind !== 'ok') return setErr(errorMessage(r));
    let p = r.body;
    for (const to of ['ready', 'waiting_card'] as const) {
      const s = await vcall<InPersonPayment>(orgId, `in-person/payments/${p.id}/state`, {
        method: 'POST',
        body: { to, expected_version: p.version },
      });
      if (s.kind === 'ok') p = s.body;
    }
    setInPerson((m) => ({ ...m, [allocationId]: p }));
  }
  async function simulate(allocationId: string, outcome: 'approve' | 'decline' | 'pending') {
    const p = inPerson[allocationId];
    if (!p) return;
    const r = await vcall<InPersonPayment>(orgId, `in-person/payments/${p.id}/simulate`, {
      method: 'POST',
      body: { outcome },
    });
    if (r.kind === 'ok') setInPerson((m) => ({ ...m, [allocationId]: r.body }));
    else setErr(errorMessage(r));
    void onChange();
  }

  if (!bill) {
    return (
      <section className="vn-card" aria-labelledby="bill-title">
        <h2 id="bill-title">Cuenta</h2>
        <p>El cliente pidió la cuenta. Ábrela para cobrarla completa o dividida.</p>
        <button
          type="button"
          className="vn-cta vn-cta-sm"
          onClick={async () => {
            const r = await vcall<Bill>(orgId, `dining/orders/${order.id}/bill`, {
              method: 'POST',
            });
            if (r.kind === 'ok') setBill(r.body);
            else setErr(errorMessage(r));
          }}
        >
          Abrir cuenta
        </button>
        {err ? (
          <p className="vn-error" role="alert">
            {err}
          </p>
        ) : null}
      </section>
    );
  }
  const amount = parseMajorAmount(amountText, bill.currency);
  const live = bill.allocations.filter((a) => !a.voided);
  return (
    <section className="vn-card" aria-labelledby="bill-title">
      <h2 id="bill-title">
        Cuenta · {money(bill.total, bill.currency)}{' '}
        <span className="vn-pill" data-tone={bill.status === 'paid' ? 'ok' : 'warn'}>
          {bill.status === 'paid' ? 'Pagada (verificada)' : 'Abierta'}
        </span>
      </h2>
      <p className="vn-help">
        Asignado {money(bill.allocated, bill.currency)} · Falta asignar{' '}
        {money(bill.remainder, bill.currency)} · Cobrado y confirmado{' '}
        {money(bill.charged, bill.currency)}. «Listo» en cocina no significa pagado: la cuenta se
        cierra sola cuando el servidor confirma los cobros.
      </p>
      {bill.anomalies.length ? (
        <p className="vn-error" role="alert">
          Hay un cobro confirmado sobre una parte anulada: revísalo en Pagos y devuélvelo si
          corresponde.
        </p>
      ) : null}

      {bill.status === 'open' && bill.remainder > 0 ? (
        <div className="vn-split">
          {live.length === 0 ? (
            <button
              type="button"
              className="vn-cta vn-cta-sm"
              onClick={() => void call('allocations', { kind: 'full' })}
            >
              Cobrar la cuenta completa
            </button>
          ) : null}
          <div className="vn-row">
            <label className="fx-field">
              <span>Partes iguales</span>
              <input
                inputMode="numeric"
                size={3}
                value={parts}
                onChange={(e) => setParts(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="fx-btn"
              onClick={() => void call('allocations/equal', { parts: Number(parts) })}
            >
              Dividir lo que falta
            </button>
          </div>
          <div className="vn-row">
            <label className="fx-field">
              <span>Por monto</span>
              <input
                inputMode="decimal"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                placeholder="0,00"
              />
            </label>
            <button
              type="button"
              className="fx-btn"
              disabled={!amount.ok}
              onClick={() =>
                amount.ok && void call('allocations', { kind: 'amount', amount: amount.minor })
              }
            >
              Crear parte
            </button>
          </div>
          <fieldset className="vn-fieldset">
            <legend>Por artículos</legend>
            <div className="vn-chips">
              {bill.lines.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className="vn-chip"
                  aria-pressed={items.includes(l.id)}
                  disabled={!!l.allocation_id}
                  onClick={() =>
                    setItems((x) => (x.includes(l.id) ? x.filter((y) => y !== l.id) : [...x, l.id]))
                  }
                >
                  {l.quantity}× {l.name} · {money(l.line_total, bill.currency)}
                  {l.allocation_id ? ' (asignado)' : ''}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="fx-btn"
              disabled={!items.length}
              onClick={() => {
                void call('allocations', { kind: 'items', bill_line_ids: items });
                setItems([]);
              }}
            >
              Crear parte con los artículos elegidos
            </button>
          </fieldset>
        </div>
      ) : null}

      <ul className="vn-lines" aria-label="Partes de la cuenta">
        {bill.allocations.map((a) => {
          const ip = inPerson[a.id];
          return (
            <li key={a.id} className="vn-line" data-voided={a.voided}>
              <span>
                <strong>
                  {a.label ??
                    (a.kind === 'full'
                      ? 'Cuenta completa'
                      : a.kind === 'items'
                        ? 'Artículos'
                        : 'Parte')}
                </strong>{' '}
                · {money(a.amount, bill.currency)}
              </span>
              <span className="vn-status" data-s={a.charge === 'charged' ? 'ready' : 'x'}>
                {a.voided ? `Anulada: ${a.void_reason}` : CHARGE_LABEL[a.charge]}
              </span>
              {!a.voided && a.pay_url && (a.charge === 'none' || a.charge === 'failed') ? (
                <span className="vn-alt" style={{ gridColumn: '1 / -1' }}>
                  <button
                    type="button"
                    className="fx-btn fx-btn-sm"
                    aria-expanded={qrFor === a.id}
                    onClick={() => setQrFor(qrFor === a.id ? null : a.id)}
                  >
                    {qrFor === a.id ? 'Ocultar QR' : 'QR para pagar'}
                  </button>
                  <button
                    type="button"
                    className="fx-btn fx-btn-sm fx-btn-sim"
                    onClick={() => void collectInPerson(a.id)}
                  >
                    Cobro presencial (simulado)
                  </button>
                  <button
                    type="button"
                    className="fx-btn fx-btn-sm fx-btn-ghost"
                    onClick={() =>
                      void call(`allocations/${a.id}/void`, { reason: 'Reorganizar la división' })
                    }
                  >
                    Anular parte
                  </button>
                </span>
              ) : null}
              {qrFor === a.id && a.pay_url ? (
                <span style={{ gridColumn: '1 / -1' }}>
                  <QrCode
                    value={a.pay_url}
                    label={`QR para pagar ${money(a.amount, bill.currency)}`}
                    size={168}
                  />
                  <a className="vn-mono" href={a.pay_url} target="_blank" rel="noreferrer">
                    {a.pay_url}
                  </a>
                </span>
              ) : null}
              {ip ? (
                <span className="vn-sim-panel" style={{ gridColumn: '1 / -1' }}>
                  <span>
                    <strong>Simulado</strong> ·{' '}
                    {ip.state === 'waiting_card' ? 'Esperando tarjeta (simulador)' : ip.state}
                  </span>
                  {ip.state === 'waiting_card' ? (
                    <span className="vn-alt">
                      <button
                        type="button"
                        className="fx-btn fx-btn-sm fx-btn-sim"
                        onClick={() => void simulate(a.id, 'approve')}
                      >
                        Proveedor aprueba
                      </button>
                      <button
                        type="button"
                        className="fx-btn fx-btn-sm fx-btn-sim"
                        onClick={() => void simulate(a.id, 'decline')}
                      >
                        Proveedor rechaza
                      </button>
                      <button
                        type="button"
                        className="fx-btn fx-btn-sm fx-btn-sim"
                        onClick={() => void simulate(a.id, 'pending')}
                      >
                        Queda pendiente
                      </button>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button type="button" className="fx-btn" onClick={() => void onChange()}>
        Verificar cobros ahora
      </button>
      {err ? (
        <p className="vn-error" role="alert">
          {err}
        </p>
      ) : null}
    </section>
  );
}
