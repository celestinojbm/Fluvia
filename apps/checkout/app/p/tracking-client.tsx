'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatAmount } from '../lib/money-format';
import { BuyerAssistant } from '../buyer-assistant';

/**
 * Seguimiento del PROPIO pedido (token privado en el fragmento de la URL):
 * estado del pedido, preparación de cada plato, llamar al personal y pagar su
 * cuenta (completa o su parte) con el checkout existente. «Listo» en cocina
 * no significa «pagado»: el pago lo confirma el servidor.
 */

interface View {
  number: number;
  table_label: string | null;
  status: string;
  currency: string;
  total: number;
  attention_requested: boolean;
  lines: Array<{
    name: string;
    quantity: number;
    modifiers: string[];
    note: string | null;
    line_total: number;
    prep_status: string;
  }>;
}
interface BillView {
  currency: string;
  total: number;
  status: string;
  remainder: number;
  charged: number;
  parts: Array<{ label: string | null; amount: number; charge: string; pay_url: string | null }>;
}

const STATUS: Record<string, string> = {
  pending_acceptance: 'Esperando confirmación del personal',
  open: 'Pedido confirmado',
  bill_requested: 'Cuenta solicitada',
  closed: 'Pagado. ¡Gracias!',
  rejected: 'El local no pudo aceptar tu pedido',
  cancelled: 'Pedido anulado',
};
const PREP: Record<string, string> = {
  draft: 'Por confirmar',
  queued: 'En cola',
  accepted: 'Recibido en cocina',
  preparing: 'Preparándose',
  ready: 'Listo',
  delivered: 'Entregado',
};
const CHARGE: Record<string, string> = {
  none: 'Por pagar',
  failed: 'Pago rechazado — puedes reintentar',
  in_progress: 'Pago en confirmación',
  charged: 'Pagado',
};
const money = (n: number, c: string) => formatAmount(n, c, 'es');

export function TrackingClient() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [bill, setBill] = useState<BillView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'offline'>('loading');
  const [called, setCalled] = useState<string | null>(null);

  useEffect(() => {
    const t = window.location.hash.slice(1);
    if (/^[A-Za-z0-9_-]{20,64}$/.test(t)) setToken(t);
    else setState('missing');
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`/api/mesa/o/${token}`, { cache: 'no-store' });
      if (r.status === 404) return setState('missing');
      if (!r.ok) return setState('offline');
      setView(await r.json());
      setState('ok');
      const b = await fetch(`/api/mesa/o/${token}/bill`, { cache: 'no-store' });
      setBill(b.ok ? await b.json() : null);
    } catch {
      setState('offline');
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [token, load]);

  async function callStaff() {
    try {
      const r = await fetch(`/api/mesa/o/${token}/attention`, { method: 'POST' });
      setCalled(
        r.ok
          ? 'Avisamos al personal. Enseguida te atienden.'
          : 'No pudimos avisar. Inténtalo de nuevo.'
      );
    } catch {
      setCalled('Sin conexión. Inténtalo de nuevo.');
    }
    void load();
  }

  if (state === 'missing') {
    return (
      <main className="mesa">
        <h1>No encontramos tu pedido</h1>
        <p>Usa el enlace que recibiste al pedir, o pide ayuda al personal.</p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="mesa">
        <p role="status">
          {state === 'offline' ? 'Sin conexión, reintentando…' : 'Cargando tu pedido…'}
        </p>
      </main>
    );
  }
  return (
    <main className="mesa" aria-labelledby="trk-title">
      <header className="mesa-head" id="estado">
        <p className="co-muted">
          Pedido #{view.number}
          {view.table_label ? ` · Mesa ${view.table_label}` : ''}
        </p>
        <h1 id="trk-title">{STATUS[view.status] ?? view.status}</h1>
        {state === 'offline' ? (
          <p className="notice" role="status">
            Sin conexión: mostramos lo último que sabemos.
          </p>
        ) : null}
      </header>
      {token ? <BuyerAssistant credential={{ tracking_token: token }} /> : null}
      <ul className="order-lines" aria-label="Tus platos" id="pedido">
        {view.lines.map((l, i) => (
          <li key={i}>
            <span>
              {l.quantity}× {l.name}
              {l.modifiers.length ? (
                <small className="co-muted"> · {l.modifiers.join(', ')}</small>
              ) : null}
            </span>
            <span className="mesa-prep" data-s={l.prep_status}>
              {PREP[l.prep_status] ?? l.prep_status}
            </span>
          </li>
        ))}
      </ul>
      <p className="mesa-total">
        <span>Total</span>
        <strong>{money(view.total, view.currency)}</strong>
      </p>
      {['pending_acceptance', 'open', 'bill_requested'].includes(view.status) ? (
        <button
          id="llamar"
          type="button"
          className="secondary"
          onClick={() => void callStaff()}
          disabled={view.attention_requested}
        >
          {view.attention_requested ? 'El personal ya fue avisado' : 'Llamar al personal'}
        </button>
      ) : null}
      {called ? <p role="status">{called}</p> : null}

      <section aria-labelledby="bill-title" className="mesa-review" id="pagar">
        <h2 id="bill-title">Cuenta</h2>
        {!bill ? (
          <p className="co-muted">
            Cuando pidas la cuenta al personal, aquí podrás pagarla completa o tu parte desde tu
            teléfono.
          </p>
        ) : (
          <>
            <p>
              {bill.status === 'paid'
                ? `Pagada: ${money(bill.charged, bill.currency)}. Confirmado por el sistema de pagos.`
                : `Pagado y confirmado: ${money(bill.charged, bill.currency)} de ${money(bill.total, bill.currency)}.`}
            </p>
            <ul className="order-lines">
              {bill.parts.map((p, i) => (
                <li key={i}>
                  <span>
                    {p.label ?? (bill.parts.length === 1 ? 'Cuenta completa' : `Parte ${i + 1}`)} ·{' '}
                    {money(p.amount, bill.currency)}
                  </span>
                  <span className="mesa-prep" data-s={p.charge === 'charged' ? 'ready' : 'x'}>
                    {CHARGE[p.charge] ?? p.charge}
                  </span>
                  {p.pay_url ? (
                    <a className="pay mesa-pay" href={p.pay_url}>
                      Pagar {money(p.amount, bill.currency)}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
