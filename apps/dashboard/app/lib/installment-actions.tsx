'use client';

import { useRef, useState } from 'react';
import { clientCall, errorMessage } from './client-call';
import type { InstallmentPlan } from './commerce-api';

/**
 * Eventos SIMULADOS del proveedor de cuotas (solo sandbox). Cada botón dice
 * que es una simulación; nada aquí cobra, ni mueve dinero, ni ocurre solo con
 * el paso del tiempo. Solo la cuota pendiente más antigua admite eventos.
 */
export function InstallmentActions({
  orgId,
  plan,
  canAct,
}: {
  orgId: string;
  plan: InstallmentPlan;
  canAct: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const lock = useRef(false);
  const base = `/api/orgs/${encodeURIComponent(orgId)}/installment-plans/${plan.id}`;
  const next = plan.installments.find((i) => i.status !== 'paid_simulated');

  async function run(url: string, body: unknown, ok: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const r = await clientCall<InstallmentPlan>(url, { method: 'POST', body });
      if (r.kind === 'ok') {
        setMsg({ tone: 'ok', text: ok });
        window.location.reload();
      } else setMsg({ tone: 'bad', text: errorMessage(r) });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (!canAct) {
    return <p className="fx-hint">Tu rol no puede disparar eventos simulados.</p>;
  }
  return (
    <div>
      <p className="fx-hint" style={{ marginBottom: 8 }}>
        Herramientas del sandbox: simulan lo que informaría un proveedor real.
      </p>
      <div className="fx-actions" aria-busy={busy}>
        {plan.status === 'pending' ? (
          <>
            <button
              type="button"
              className="fx-btn fx-btn-sim"
              disabled={busy}
              onClick={() =>
                void run(`${base}/decision`, { decision: 'approved' }, 'Plan aprobado (simulado).')
              }
            >
              Simular aprobación
            </button>
            <button
              type="button"
              className="fx-btn fx-btn-danger"
              disabled={busy}
              onClick={() =>
                void run(`${base}/decision`, { decision: 'declined' }, 'Plan rechazado (simulado).')
              }
            >
              Simular rechazo
            </button>
          </>
        ) : null}
        {plan.status === 'approved' && next ? (
          <>
            <button
              type="button"
              className="fx-btn fx-btn-sim"
              disabled={busy}
              onClick={() =>
                void run(
                  `${base}/installments/${next.seq}`,
                  { outcome: 'paid' },
                  `Cuota ${next.seq} marcada pagada (simulado).`
                )
              }
            >
              Simular pago de la cuota {next.seq}
            </button>
            {next.status === 'scheduled' ? (
              <button
                type="button"
                className="fx-btn fx-btn-danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    `${base}/installments/${next.seq}`,
                    { outcome: 'overdue' },
                    `Cuota ${next.seq} marcada vencida (simulado).`
                  )
                }
              >
                Simular cuota {next.seq} vencida
              </button>
            ) : null}
          </>
        ) : null}
        {plan.status === 'approved' && !next ? (
          <p className="fx-hint">Todas las cuotas figuran pagadas (simulación).</p>
        ) : null}
        {plan.status === 'declined' ? (
          <p className="fx-hint">Plan rechazado: no admite eventos.</p>
        ) : null}
      </div>
      <div aria-live="polite">
        {msg ? (
          <p
            className={msg.tone === 'bad' ? 'fx-error-text' : 'fx-hint'}
            role={msg.tone === 'bad' ? 'alert' : undefined}
          >
            {msg.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
