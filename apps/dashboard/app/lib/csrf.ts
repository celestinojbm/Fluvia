import { NextResponse } from 'next/server';

/**
 * RA-F65B-EXT-002 — guard CSRF centralizado de los route handlers MUTANTES
 * respaldados por la cookie de sesión (`fluvia_session`, SameSite=Lax). La
 * cookie viaja también desde un SIBLING same-site (p. ej. `evil.example.com`
 * contra `dashboard.example.com`), así que la política exige procedencia
 * `same-origin` ESTRICTA, no `same-site`:
 *
 *  1. `Sec-Fetch-Site` (si el navegador lo envía) debe ser `same-origin`;
 *     `same-site`, `cross-site` y `none` se rechazan.
 *  2. `Origin` es OBLIGATORIO (fail-closed si falta: todo POST legítimo del
 *     dashboard —fetch/XHR/form— lo lleva) y debe coincidir EXACTAMENTE con el
 *     origin canónico: `FLUVIA_DASHBOARD_ORIGIN` si está configurado; si no,
 *     el origin derivado del `Host` del request. El fallback por Host NO es la
 *     única defensa (un cliente que pudiera falsear Host no porta la cookie, y
 *     los checks 1 y 3 siguen aplicando): con despliegue detrás de proxy se
 *     DEBE fijar `FLUVIA_DASHBOARD_ORIGIN`.
 *  3. Header no-simple `X-Fluvia-CSRF: 1` obligatorio (defensa en profundidad:
 *     un form HTML no puede añadirlo y un fetch cross-origin dispara un
 *     preflight CORS que este app jamás aprueba). El header por sí solo NO
 *     sustituye la comparación exacta de Origin.
 *
 * El guard corre ANTES de leer la cookie o el body: un request rechazado jamás
 * se reenvía al backend y la respuesta (403, sobre estable) no contiene Bearer,
 * cookie ni detalle sensible. Solo aplica a MUTACIONES: GET/list/detail no
 * pasan por aquí.
 */

import { CSRF_HEADER, CSRF_HEADER_VALUE } from './csrf-header';

export { CSRF_HEADER, CSRF_HEADER_VALUE };

/** Origin canónico permitido; null si `FLUVIA_DASHBOARD_ORIGIN` no está fijado. */
export function canonicalDashboardOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.FLUVIA_DASHBOARD_ORIGIN;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    // Configuración rota = origin imposible de igualar: el guard queda
    // fail-closed (rechaza todo) en vez de degradar al fallback por Host.
    return 'invalid://fluvia-dashboard-origin-misconfigured';
  }
}

export type CsrfRejectionReason =
  'sec_fetch_site' | 'missing_origin' | 'origin_mismatch' | 'missing_csrf_header';

/**
 * Decide si un request de mutación es de procedencia confiable (same-origin).
 * Pura y testeable: sin acceso a cookies ni red. Devuelve null si es confiable
 * o la razón del rechazo.
 */
export function untrustedMutationReason(
  headers: Headers,
  allowedOrigin: string | null
): CsrfRejectionReason | null {
  // 1. Metadata de fetch del navegador: solo `same-origin` es aceptable. El
  //    escenario sibling de Hermes llega como `same-site` — se rechaza.
  const secFetchSite = headers.get('sec-fetch-site');
  if (secFetchSite !== null && secFetchSite.toLowerCase() !== 'same-origin') {
    return 'sec_fetch_site';
  }

  // 2. Origin exacto, fail-closed si falta (un `Origin: null` opaco también
  //    se rechaza: no prueba procedencia same-origin).
  const origin = headers.get('origin');
  if (origin === null || origin === '' || origin === 'null') return 'missing_origin';
  if (allowedOrigin !== null) {
    if (origin !== allowedOrigin) return 'origin_mismatch';
  } else {
    // Fallback sin configuración canónica (local/dev con binding directo): el
    // host del Origin debe coincidir con el Host del propio request. Solo
    // `Host` (nunca `X-Forwarded-Host`, forjable por el cliente) y nunca como
    // única defensa: ver doc del módulo. Detrás de proxy se fija
    // FLUVIA_DASHBOARD_ORIGIN.
    const host = headers.get('host');
    if (host === null || host.trim() === '') return 'origin_mismatch';
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return 'origin_mismatch';
    }
    if (originHost.toLowerCase() !== host.trim().toLowerCase()) return 'origin_mismatch';
  }

  // 3. Header anti-CSRF no-simple, controlado por la aplicación.
  if (headers.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) return 'missing_csrf_header';

  return null;
}

/**
 * Guard para route handlers: devuelve la respuesta 403 estable si el request
 * NO es confiable, o null si puede continuar. Uso:
 *
 *   const rejected = assertTrustedMutationRequest(req);
 *   if (rejected) return rejected;   // jamás toca cookie/body/backend
 */
export function assertTrustedMutationRequest(req: Request): NextResponse | null {
  const reason = untrustedMutationReason(req.headers, canonicalDashboardOrigin());
  if (reason === null) return null;
  // Sobre estable y sin información sensible; `code` genérico único para no
  // darle al atacante un oráculo de qué check falló (la razón fina queda para
  // los tests vía `untrustedMutationReason`).
  return NextResponse.json({ ok: false, error: { code: 'origin_not_allowed' } }, { status: 403 });
}
