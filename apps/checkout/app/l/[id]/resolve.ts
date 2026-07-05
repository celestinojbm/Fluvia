import { normalizeLocale } from '../../messages';

/**
 * Lógica pura de F3-06-b: abrir un payment link. Hace el `POST :id/sessions`
 * PÚBLICO server-side (F3-06) y devuelve el destino de redirección hacia el
 * flujo alojado `/c/{sessionId}#{clientSecret}` (F3-05c-iv) — o `null` cuando el
 * link no resuelve (inexistente/deshabilitado/API caída → mismo resultado,
 * anti-enumeración).
 *
 * El `client_secret` viaja en el FRAGMENTO (`#…`) del destino: nunca llega a los
 * logs del servidor en la navegación posterior a `/c/{id}`. El comprador nunca
 * conoce la URL de la API ni una API key.
 */

export interface ResolveLinkOptions {
  apiBase: string;
  linkId: string;
  lang?: string;
  /** Inyectable en tests; por defecto el `fetch` global. */
  fetchImpl?: typeof fetch;
}

export async function resolveLinkSession(opts: ResolveLinkOptions): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(
      `${opts.apiBase}/v1/payment_links/${encodeURIComponent(opts.linkId)}/sessions`,
      { method: 'POST', cache: 'no-store' }
    );
    if (res.status !== 200) return null;
    const body = (await res.json()) as { checkout_session_id?: unknown; client_secret?: unknown };
    const sid = body.checkout_session_id;
    const secret = body.client_secret;
    if (typeof sid !== 'string' || typeof secret !== 'string' || !sid || !secret) return null;
    // Preserva un idioma explícito no-default (es es el default → URL limpia).
    const query = normalizeLocale(opts.lang) === 'en' ? '?lang=en' : '';
    return `/c/${encodeURIComponent(sid)}${query}#${encodeURIComponent(secret)}`;
  } catch {
    return null;
  }
}
