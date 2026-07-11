'use client';

import { useEffect, useState } from 'react';
import { MESSAGES, type Locale } from '../messages';

/**
 * F6.5B1 — revela un secreto (whsec_… de un endpoint, o el secreto de una API
 * key en B2) UNA SOLA VEZ tras crearlo/rotarlo. Garantías:
 *  - el secreto vive SOLO en state efímero de React (nunca server-rendered en
 *    HTML persistente, nunca en storage, nunca en la URL, nunca en analytics);
 *  - copiar es una acción EXPLÍCITA del usuario (`navigator.clipboard`);
 *  - al cerrar (`onDismiss`) o al DESMONTAR el componente, el state se limpia.
 * El llamador pasa el secreto ya recibido de la respuesta de creación; este
 * componente no lo persiste ni lo vuelve a pedir al servidor.
 */
export function SecretRevealOnce({
  secret,
  locale,
  onDismiss,
}: {
  secret: string;
  locale: Locale;
  onDismiss: () => void;
}) {
  const t = MESSAGES[locale];
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  // Defensa: si el componente se desmonta (navegación), no queda nada que
  // limpiar en storage porque nunca escribimos ahí; este efecto documenta la
  // invariante y resetea el estado de UI transitorio.
  useEffect(() => {
    return () => {
      setCopied(false);
      setCopyError(false);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <div className="secret-reveal" role="group" aria-label={t.secretOnceTitle}>
      <p className="secret-warning">
        <strong>{t.secretOnceWarning}</strong>
      </p>
      <div className="action-inline">
        <code className="secret-value">{secret}</code>
        <button type="button" className="resend" onClick={copy}>
          {copied ? t.copied : t.copyUrl}
        </button>
      </div>
      {copyError && (
        <p className="error" role="alert">
          {t.copyError}
        </p>
      )}
      <button type="button" className="btn" onClick={onDismiss}>
        {t.secretOnceDismiss}
      </button>
    </div>
  );
}
