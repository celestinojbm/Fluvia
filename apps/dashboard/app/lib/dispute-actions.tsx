'use client';

import { useState } from 'react';
import { MESSAGES, type Locale } from '../messages';

/**
 * Acción de operación sobre una disputa VIVA (F4-08e): RESPONDER con evidencia
 * (`open -> under_review`). Espeja `case-actions` (F4-03c-ii): POSTea a un route
 * handler server-side que reenvía la cookie de sesión (el navegador jamás
 * sostiene el token ni conoce la URL de la API); en éxito recarga la vista
 * server-rendered. Solo se ofrece mientras la disputa no es terminal — el
 * DESENLACE (won/lost) llega SOLO por fuente verificada (el webhook del banco,
 * V4 §23), jamás desde aquí. Es idempotente: re-responder sobre `under_review`
 * no falla (el API devuelve el estado actual); por eso, una vez respondida, la
 * isla muestra la confirmación en vez del botón. El API es la fuente de verdad
 * del permiso (`reconciliation:manage`); este control es un hint de UX.
 */

async function postEvidence(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export function RespondWithEvidence({
  orgId,
  disputeId,
  status,
  locale,
}: {
  orgId: string;
  disputeId: string;
  status: string;
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  const [phase, setPhase] = useState<'idle' | 'busy' | 'error'>('idle');

  // Ya respondida (`under_review`): la evidencia está enviada; no re-ofrecemos el
  // botón, solo la confirmación. `open` es el único estado que admite responder.
  if (status === 'under_review') {
    return <p className="hint">{t.disputeEvidenceSubmitted}</p>;
  }

  async function run() {
    setPhase('busy');
    const ok = await postEvidence(
      `/api/orgs/${encodeURIComponent(orgId)}/disputes/${encodeURIComponent(disputeId)}/evidence`
    );
    if (ok) setTimeout(() => window.location.reload(), 400);
    else setPhase('error');
  }

  return (
    <div className="action-form">
      <p className="hint">{t.disputeEvidenceHint}</p>
      <span className="action-inline">
        <button type="button" className="btn" onClick={run} disabled={phase === 'busy'}>
          {phase === 'busy' ? t.disputeResponding : t.disputeRespond}
        </button>
        {phase === 'error' && (
          <span className="error" role="alert">
            {t.actionError}
          </span>
        )}
      </span>
    </div>
  );
}
