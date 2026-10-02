'use client';

import { useEffect, useState } from 'react';
import {
  AssistantRoot,
  AssistantTrigger,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  assistantError,
} from '@fluvia/assistant-ui';

/**
 * Asistente del COMPRADOR en esta página (checkout o seguimiento). Registra
 * la credencial de la página en el BFF (que la valida contra la API y la
 * guarda en una cookie httpOnly de ruta propia) y monta el MISMO asistente
 * del panel con la superficie `buyer`: solo su checkout o su pedido, sin
 * billetera ni datos del comercio. Si la credencial venció o el asistente no
 * está disponible, lo dice y la página sigue funcionando.
 */
export type BuyerCredential =
  { checkout_session_id: string; client_secret: string } | { tracking_token: string };

export function BuyerAssistant({ credential }: { credential: BuyerCredential | null }) {
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = credential ? JSON.stringify(credential) : '';

  useEffect(() => {
    if (!key) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/asistente/sesion', {
          method: 'POST',
          headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
          body: key,
          cache: 'no-store',
        });
        const body = (await res.json().catch(() => null)) as {
          base?: string;
          error?: { code?: string };
        } | null;
        if (!alive) return;
        if (res.ok && body?.base) setBase(body.base);
        else setError(assistantError(res.status, body?.error?.code));
      } catch {
        if (alive) setError(assistantError(0));
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  if (!credential) return null;
  if (error) {
    return (
      <p className="ba-off" role="status">
        Asistente no disponible: {error}
      </p>
    );
  }
  if (!base) return null;
  return (
    <AssistantRoot base={base} surface="buyer">
      <div className="ba-bar">
        <AssistantTrigger className="ba-trigger" />
      </div>
    </AssistantRoot>
  );
}
