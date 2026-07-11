'use client';

import { useState } from 'react';
import { MESSAGES, type Locale } from '../messages';

/**
 * Copiar una URL sandbox al portapapeles (F6.5A). Acción NO mutante: no toca el
 * API ni mueve estado del backend; solo `navigator.clipboard` en el navegador
 * del operador. Sin clipboard disponible (o denegado) degrada a un error visible.
 */
export function CopyUrlButton({ url, locale }: { url: string; locale: Locale }) {
  const t = MESSAGES[locale];
  const [phase, setPhase] = useState<'idle' | 'done' | 'error'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setPhase('done');
    } catch {
      setPhase('error');
    }
  }

  if (phase === 'done') return <span className="resent">{t.copied}</span>;
  return (
    <span className="resend-cell">
      <button type="button" className="resend" onClick={copy}>
        {t.copyUrl}
      </button>
      {phase === 'error' && (
        <span className="error" role="alert">
          {t.copyError}
        </span>
      )}
    </span>
  );
}
