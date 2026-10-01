'use client';

import { useRef, useState } from 'react';
import { clientCall, errorMessage } from './client-call';
import type { Movement, Product } from './commerce-api';
import { Icon, type IconName } from './icons';

/**
 * Existencias de un producto: cifras (existencia, reservado, libre), entrada o
 * ajuste con motivo, y movimientos. La entrada es IDEMPOTENTE: una key por
 * contenido enviado; reintentar tras un resultado incierto reusa la key y el
 * servidor devuelve el mismo movimiento (nunca suma dos veces). El nivel lo
 * calcula el motor: aquí no se resta ni se suma nada en el navegador.
 */

const KIND: Record<Movement['kind'], { label: string; icon: IconName }> = {
  receipt: { label: 'Entrada', icon: 'in' },
  adjustment: { label: 'Ajuste', icon: 'tools' },
  reservation: { label: 'Reservado por venta', icon: 'clock' },
  release: { label: 'Liberado (venta anulada)', icon: 'undo' },
  sale: { label: 'Vendido (cobro confirmado)', icon: 'out' },
};

function when(iso: string) {
  try {
    return new Intl.DateTimeFormat('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function StockPanel({
  orgId,
  product,
  movements,
  canEdit,
}: {
  orgId: string;
  product: Product;
  movements: Movement[];
  canEdit: boolean;
}) {
  const [kind, setKind] = useState<'receipt' | 'adjustment'>('receipt');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef<{ key: string; fingerprint: string } | null>(null);

  if (!product.track_stock || !product.stock) {
    return (
      <section className="fx-panel" aria-labelledby="stock-title">
        <header>
          <h2 id="stock-title">Existencias</h2>
        </header>
        <div className="fx-panel-body">
          <p className="fx-hint">
            Este producto no controla existencias: se vende mientras esté disponible. Activa
            «Controlar existencias» en el formulario para registrar entradas y reservas.
          </p>
        </div>
      </section>
    );
  }

  const n = Number.parseInt(qty, 10);
  const valid =
    /^-?\d{1,7}$/.test(qty.trim()) &&
    n !== 0 &&
    (kind === 'adjustment' || n > 0) &&
    reason.trim().length >= 3;

  async function submit() {
    if (!valid || busy) return;
    const body = { kind, quantity: n, reason: reason.trim() };
    const fingerprint = JSON.stringify(body);
    if (!idem.current || idem.current.fingerprint !== fingerprint) {
      idem.current = { key: crypto.randomUUID(), fingerprint };
    }
    setBusy(true);
    setMsg(null);
    const r = await clientCall<{ stock: { on_hand: number } }>(
      `/api/orgs/${encodeURIComponent(orgId)}/catalog/products/${product.id}/stock`,
      { method: 'POST', body, idempotencyKey: idem.current.key }
    );
    setBusy(false);
    if (r.kind === 'ok') {
      idem.current = null;
      setMsg({ tone: 'ok', text: 'Movimiento registrado. Actualizando…' });
      window.location.reload();
      return;
    }
    if (r.kind === 'network' || (r.kind === 'http' && r.status >= 500)) {
      setMsg({
        tone: 'warn',
        text: 'No sabemos si se registró. Reintentar es seguro: usa la misma clave y no suma dos veces.',
      });
      return;
    }
    idem.current = null;
    setMsg({ tone: 'bad', text: errorMessage(r) });
  }

  const s = product.stock;
  return (
    <section className="fx-panel" aria-labelledby="stock-title">
      <header>
        <h2 id="stock-title">Existencias</h2>
      </header>
      <div className="fx-panel-body">
        <dl className="fx-stock-figs">
          <div>
            <dt>En tienda</dt>
            <dd>{s.on_hand}</dd>
          </div>
          <div>
            <dt>Reservado</dt>
            <dd>{s.reserved}</dd>
          </div>
          <div>
            <dt>Libre para vender</dt>
            <dd>{s.free}</dd>
          </div>
        </dl>
        <p className="fx-hint" style={{ marginBottom: 16 }}>
          Reservado = ventas registradas aún sin cobro confirmado. Un cobro rechazado o incierto
          mantiene la reserva; solo anular la venta la libera.
        </p>

        {canEdit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            aria-label="Registrar movimiento de existencias"
          >
            <div className="fx-row">
              <div className="fx-field">
                <label htmlFor="st-kind">Movimiento</label>
                <select
                  id="st-kind"
                  className="fx-select"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as 'receipt' | 'adjustment')}
                  disabled={busy}
                >
                  <option value="receipt">Entrada (compra, reposición)</option>
                  <option value="adjustment">Ajuste (conteo, merma: ±)</option>
                </select>
              </div>
              <div className="fx-field" style={{ flex: '0 1 8rem' }}>
                <label htmlFor="st-qty">Unidades</label>
                <input
                  id="st-qty"
                  className="fx-input"
                  inputMode="numeric"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder={kind === 'receipt' ? '12' : '-2'}
                  disabled={busy}
                />
              </div>
            </div>
            <div className="fx-field">
              <label htmlFor="st-reason">Motivo</label>
              <input
                id="st-reason"
                className="fx-input"
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Compra a proveedor, conteo semanal…"
                disabled={busy}
              />
            </div>
            <button type="submit" className="fx-btn fx-btn-primary" disabled={!valid || busy}>
              {busy ? 'Registrando…' : 'Registrar movimiento'}
            </button>
            <p
              className={msg?.tone === 'bad' ? 'fx-error-text' : 'fx-hint'}
              role={msg ? (msg.tone === 'ok' ? 'status' : 'alert') : undefined}
              style={{ marginTop: 8 }}
            >
              {msg?.text}
            </p>
          </form>
        ) : null}

        <h3 style={{ fontSize: '0.95rem', margin: '16px 0 4px' }}>Movimientos recientes</h3>
        {movements.length === 0 ? (
          <p className="fx-hint">Sin movimientos todavía.</p>
        ) : (
          <ul className="fx-moves">
            {movements.slice(0, 20).map((m) => {
              const k = KIND[m.kind];
              const sign = m.kind === 'sale' ? -m.quantity : m.quantity;
              return (
                <li key={m.id}>
                  <span className="fx-move-ico" data-kind={m.kind}>
                    <Icon name={k.icon} size={16} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    {k.label}
                    {m.order_number ? (
                      <>
                        {' · '}
                        <a className="fx-link" href={`/o/${orgId}/orders/${m.order_id}`}>
                          Venta #{m.order_number}
                        </a>
                      </>
                    ) : null}
                    <span className="fx-cell-sub">
                      {when(m.created_at)} UTC{m.reason ? ` · ${m.reason}` : ''}
                    </span>
                  </span>
                  <span className="fx-move-qty">
                    {m.kind === 'reservation' || m.kind === 'release'
                      ? `${m.quantity} u.`
                      : `${sign > 0 ? '+' : ''}${sign}`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
