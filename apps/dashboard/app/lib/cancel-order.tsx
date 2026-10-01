'use client';

import { useRef, useState } from 'react';
import { clientCall, errorMessage } from './client-call';

/**
 * Anular una venta sin cobro. Pide un motivo y confirmación explícita. El
 * servidor decide (409 si un cobro la retiene); reenviar es seguro: una
 * venta ya anulada se devuelve tal cual. Sin respuesta ⇒ resultado incierto:
 * se pide comprobar antes de repetir.
 */
export function CancelOrder({
  orgId,
  orderId,
  number,
}: {
  orgId: string;
  orderId: string;
  number: number;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'bad' | 'warn'; text: string } | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (busy || reason.trim().length < 3) return;
    setBusy(true);
    setMsg(null);
    const r = await clientCall(`/api/orgs/${encodeURIComponent(orgId)}/orders/${orderId}/cancel`, {
      method: 'POST',
      body: { reason: reason.trim() },
    });
    setBusy(false);
    if (r.kind === 'ok') {
      window.location.reload();
      return;
    }
    if (r.kind === 'network' || r.status >= 500) {
      setMsg({
        tone: 'warn',
        text: 'No sabemos si se anuló. Recarga la página para ver el estado; repetir es seguro.',
      });
      return;
    }
    setMsg({ tone: 'bad', text: errorMessage(r) });
  }

  if (!open) {
    return (
      <button
        type="button"
        className="fx-btn fx-btn-danger"
        onClick={() => {
          setOpen(true);
          setTimeout(() => reasonRef.current?.focus(), 0);
        }}
      >
        Anular venta
      </button>
    );
  }
  return (
    <form
      className="fx-panel"
      style={{ padding: 16, width: '100%', maxWidth: '28rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-labelledby="cancel-title"
    >
      <h2 id="cancel-title" style={{ fontSize: '1rem', margin: '0 0 4px' }}>
        Anular la venta #{number}
      </h2>
      <p className="fx-hint" style={{ marginBottom: 12 }}>
        La venta queda anulada: sus checkouts abiertos ya no podrán cobrar y las existencias
        reservadas vuelven a estar libres. No se puede deshacer.
      </p>
      <div className="fx-field">
        <label htmlFor="cancel-reason">Motivo</label>
        <input
          id="cancel-reason"
          ref={reasonRef}
          className="fx-input"
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="El cliente desistió, venta duplicada…"
          disabled={busy}
        />
      </div>
      {msg ? (
        <p
          className={msg.tone === 'bad' ? 'fx-error-text' : 'fx-hint'}
          role="alert"
          style={{ marginBottom: 12 }}
        >
          {msg.text}
        </p>
      ) : null}
      <div className="fx-actions">
        <button
          type="submit"
          className="fx-btn fx-btn-danger"
          disabled={busy || reason.trim().length < 3}
        >
          {busy ? 'Anulando…' : 'Confirmar anulación'}
        </button>
        <button
          type="button"
          className="fx-btn fx-btn-ghost"
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          No anular
        </button>
      </div>
    </form>
  );
}
