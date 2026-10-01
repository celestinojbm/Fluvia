'use client';

import { useState } from 'react';
import { clientCall, errorMessage } from '../../../lib/client-call';

export function ResolveUncertain({ orgId }: { orgId: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <p>
      <button
        type="button"
        className="fx-btn fx-btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await clientCall<{
            attempts: { resolved: number };
            refunds: { resolved: number };
          }>(`/api/orgs/${orgId}/uncertain/resolve`, { method: 'POST', body: {} });
          setBusy(false);
          if (r.kind !== 'ok') return setMsg(errorMessage(r));
          setMsg(
            `Consultado: ${r.body.attempts.resolved} cobro(s) y ${r.body.refunds.resolved} devolución(es) confirmados.`
          );
          setTimeout(() => window.location.reload(), 1200);
        }}
      >
        {busy ? 'Consultando al proveedor…' : 'Consultar al proveedor ahora'}
      </button>{' '}
      {msg ? <span role="status">{msg}</span> : null}
    </p>
  );
}
