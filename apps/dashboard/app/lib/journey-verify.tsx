'use client';

import { useState } from 'react';
import { clientCall, errorMessage } from './client-call';

interface VerifyResult {
  results: Array<{ kind: 'payment' | 'refund'; verdict: string; applied: boolean }>;
}

const VERDICT: Record<string, string> = {
  approved: 'la red lo confirmó',
  declined: 'la red lo rechazó',
  pending: 'la red aún no decide',
  unknown: 'la red no lo conoce',
  no_response: 'la red no respondió',
};

/**
 * Verificar los inciertos de UNA operación (API: `reconciliation:manage`).
 * El resultado lo da el proveedor; si no responde, el caso sigue abierto.
 */
export function VerifyJourney({ orgId, journeyRef }: { orgId: string; journeyRef: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <p className="fx-verify">
      <button
        type="button"
        className="fx-btn fx-btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const r = await clientCall<VerifyResult>(
            `/api/orgs/${orgId}/journeys/${journeyRef}/verify`,
            { method: 'POST', body: {} }
          );
          setBusy(false);
          if (r.kind !== 'ok') return setMsg(errorMessage(r));
          setMsg(
            r.body.results
              .map(
                (x) =>
                  `${x.kind === 'payment' ? 'Cobro' : 'Devolución'}: ${VERDICT[x.verdict] ?? x.verdict}${x.applied ? ' (aplicado)' : ' (sigue sin confirmar)'}`
              )
              .join(' · ') || 'Nada que verificar.'
          );
          setTimeout(() => window.location.reload(), 1500);
        }}
      >
        {busy ? 'Consultando a la red…' : 'Verificar con la red'}
      </button>{' '}
      {msg ? <span role="status">{msg}</span> : null}
    </p>
  );
}
