'use client';

import { useCallback, useState } from 'react';
import { errorMessage } from '../client-call';
import { money } from '../ui';
import { vcall, MODE_LABEL, ORDER_STATUS_LABEL, type DiningOrder, type VenueLayout } from './api';
import { useDiningStream } from './use-dining-stream';

/**
 * Sala: mapa de mesas con su estado (libre / abierta / cuenta pedida /
 * llamado), pedidos para llevar y pedidos de clientes por QR que esperan
 * aceptación. Se actualiza en vivo; cada dato viene del servidor.
 */
export function SalaWorkspace({
  orgId,
  branches,
  initialOrders,
  initialBranch,
  vocabulary,
}: {
  orgId: string;
  branches: VenueLayout['branches'];
  initialOrders: DiningOrder[];
  initialBranch: string;
  vocabulary: { newSale: string };
}) {
  const [branchId, setBranchId] = useState(initialBranch);
  const [orders, setOrders] = useState(initialOrders);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const branch = branches.find((b) => b.id === branchId);

  const reload = useCallback(async () => {
    const r = await vcall<{ data: DiningOrder[] }>(orgId, `dining/orders?branch_id=${branchId}`);
    if (r.kind === 'ok') setOrders(r.body.data);
  }, [orgId, branchId]);
  const conn = useDiningStream(orgId, branchId, () => void reload());

  const byTable = new Map(orders.filter((o) => o.table_id).map((o) => [o.table_id!, o]));
  const pending = orders.filter((o) => o.status === 'pending_acceptance');
  const counter = orders.filter((o) => !o.table_id && o.status !== 'pending_acceptance');

  async function open(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const r = await vcall<DiningOrder>(orgId, 'dining/orders', {
      method: 'POST',
      body: { branch_id: branchId, ...body },
    });
    setBusy(false);
    if (r.kind === 'ok') window.location.href = `/o/${orgId}/sala/${r.body.id}`;
    else
      setError(
        r.kind === 'http' && r.code === 'table_occupied'
          ? 'Esa mesa ya tiene un pedido abierto. Se actualizó el mapa.'
          : errorMessage(r)
      );
    if (r.kind !== 'ok') void reload();
  }

  async function decide(o: DiningOrder, accept: boolean) {
    const r = await vcall<DiningOrder>(orgId, `dining/orders/${o.id}/decision`, {
      method: 'POST',
      body: { expected_version: o.version, accept, ...(accept ? {} : { reason: 'No disponible' }) },
    });
    if (r.kind !== 'ok') setError(errorMessage(r));
    void reload();
  }

  return (
    <div className="vn-stack">
      <div className="vn-row" style={{ alignItems: 'center' }}>
        {branches.length > 1 ? (
          <div className="vn-chips" role="group" aria-label="Sucursal">
            {branches.map((b) => (
              <button
                key={b.id}
                type="button"
                className="vn-chip"
                aria-pressed={b.id === branchId}
                onClick={() => setBranchId(b.id)}
              >
                {b.name}
              </button>
            ))}
          </div>
        ) : null}
        <span className="vn-pill" data-tone={conn === 'live' ? 'ok' : 'warn'} role="status">
          {conn === 'live' ? 'En vivo' : 'Reconectando…'}
        </span>
        <button
          type="button"
          className="vn-cta vn-cta-sm"
          disabled={busy}
          onClick={() => void open({ mode: 'takeaway' })}
        >
          {vocabulary.newSale === 'Abrir mesa' ? 'Pedido para llevar' : vocabulary.newSale}
        </button>
      </div>
      {error ? (
        <p className="vn-error" role="alert">
          {error}
        </p>
      ) : null}

      {pending.length ? (
        <section className="vn-card" aria-labelledby="pend-title">
          <h2 id="pend-title">Pedidos de clientes por aceptar ({pending.length})</h2>
          <ul className="vn-lines">
            {pending.map((o) => (
              <li key={o.id} className="vn-line">
                <span>
                  <strong>
                    #{o.number} · {o.table_label ? `Mesa ${o.table_label}` : MODE_LABEL[o.mode]}
                  </strong>
                  <small>
                    {' '}
                    {o.lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')} ·{' '}
                    {money(o.total, o.currency)}
                  </small>
                </span>
                <span className="vn-alt">
                  <button
                    type="button"
                    className="fx-btn fx-btn-primary"
                    onClick={() => void decide(o, true)}
                  >
                    Aceptar y enviar a cocina
                  </button>
                  <button
                    type="button"
                    className="fx-btn fx-btn-ghost"
                    onClick={() => void decide(o, false)}
                  >
                    Rechazar
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="vn-card" aria-labelledby="mesas-title">
        <h2 id="mesas-title">Mesas{branch ? ` · ${branch.name}` : ''}</h2>
        {branch?.areas.map((a) => (
          <div key={a.id}>
            <h3>{a.name}</h3>
            <ul className="vn-tables">
              {branch.tables
                .filter((t) => t.area_id === a.id)
                .map((t) => {
                  const o = byTable.get(t.id);
                  const state = o ? o.status : 'free';
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        className="vn-tile"
                        data-state={state}
                        data-attention={!!o?.attention_requested_at}
                        disabled={busy}
                        onClick={() =>
                          o
                            ? (window.location.href = `/o/${orgId}/sala/${o.id}`)
                            : void open({
                                mode: 'dine_in',
                                table_id: t.id,
                                guest_count: t.capacity,
                              })
                        }
                      >
                        <strong>{t.label}</strong>
                        <span>
                          {o
                            ? `${ORDER_STATUS_LABEL[o.status]} · ${money(o.total, o.currency)}`
                            : `Libre · ${t.capacity} personas`}
                        </span>
                        {o?.attention_requested_at ? <span>⚑ Llamado del cliente</span> : null}
                      </button>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </section>

      {counter.length ? (
        <section className="vn-card" aria-labelledby="llevar-title">
          <h2 id="llevar-title">Para llevar y recoger</h2>
          <ul className="vn-lines">
            {counter.map((o) => (
              <li key={o.id} className="vn-line">
                <a href={`/o/${orgId}/sala/${o.id}`}>
                  #{o.number} · {MODE_LABEL[o.mode]}
                  {o.customer_name ? ` · ${o.customer_name}` : ''}
                </a>
                <span>
                  {ORDER_STATUS_LABEL[o.status]} · {money(o.total, o.currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
