'use client';

import { useState } from 'react';
import { MESSAGES, type Locale } from '../messages';

/**
 * Botón de reenvío de un evento de webhook `dead` (F3-09b-iii). POSTea al route
 * handler `/api/orgs/{orgId}/webhook-events/{id}/resend` (server-side, reenvía la
 * cookie de sesión); en éxito recarga la vista server-rendered para reflejar el
 * evento fresco encolado. El API es la fuente de verdad del permiso; este botón
 * solo se muestra a roles que pueden reenviar (hint de UX).
 */
export function ResendButton({
  orgId,
  eventId,
  locale,
}: {
  orgId: string;
  eventId: string;
  locale: Locale;
}) {
  const t = MESSAGES[locale];
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  async function resend() {
    setPhase('busy');
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/webhook-events/${encodeURIComponent(eventId)}/resend`,
        { method: 'POST' }
      );
      if (res.status === 201) {
        setPhase('done');
        // Refresca la lista server-rendered (aparece el evento pending fresco).
        setTimeout(() => window.location.reload(), 400);
      } else {
        setPhase('error');
      }
    } catch {
      setPhase('error');
    }
  }

  if (phase === 'done') return <span className="resent">{t.resent}</span>;
  return (
    <span className="resend-cell">
      <button type="button" className="resend" onClick={resend} disabled={phase === 'busy'}>
        {phase === 'busy' ? t.resending : t.resend}
      </button>
      {phase === 'error' && (
        <span className="error" role="alert">
          {t.resendError}
        </span>
      )}
    </span>
  );
}
