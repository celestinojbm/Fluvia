import { NextResponse } from 'next/server';
import { apiBase } from '../../lib/api';
import { assertTrustedMutationRequest } from '../../lib/csrf';

/**
 * Signup sandbox (F6.5C1/B6). Proxy server-side hacia el endpoint local/test
 * `POST /v1/auth/register-sandbox` del API — el navegador jamás conoce la URL
 * del API. Reglas:
 *
 *  - El guard CSRF (`assertTrustedMutationRequest`) corre PRIMERO: antes de
 *    leer body, cookies, construir headers o invocar fetch. Un rechazo (403
 *    estable) jamás llega al backend.
 *  - Pre-sesión: NO lee cookie, NO construye Bearer, NO crea sesión, NO emite
 *    Set-Cookie. El registro sandbox no inicia sesión — el flujo sigue en
 *    /login.
 *  - La respuesta se RE-EMITE con campos whitelisted (jamás passthrough):
 *    aunque el backend cambiara su contrato, ningún token de verificación ni
 *    de sesión puede cruzar hacia el navegador por aquí.
 *  - No se loguea el password ni el body; los errores conservan el `code`
 *    estable del catálogo sin stack/SQL/secretos.
 */
export async function POST(req: Request) {
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;

  const raw = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  if (typeof raw.email !== 'string' || typeof raw.password !== 'string') {
    return NextResponse.json({ ok: false, error: { code: 'validation_error' } }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/auth/register-sandbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: raw.email, password: raw.password }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ ok: false, error: { code: 'internal_error' } }, { status: 502 });
  }

  if (res.ok) {
    // Whitelist estricta: nada más que la confirmación mínima.
    return NextResponse.json({ registered: true, email_verified: true }, { status: 201 });
  }

  const body = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
  const code = typeof body.error?.code === 'string' ? body.error.code : 'internal_error';
  return NextResponse.json({ ok: false, error: { code } }, { status: res.status });
}
