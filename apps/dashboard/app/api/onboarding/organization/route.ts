import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../lib/api';
import { assertTrustedMutationRequest } from '../../../lib/csrf';

/**
 * Onboarding Paso A (F6.5C2): crear la organizacion del operador. Proxy
 * server-side hacia `POST /v1/organizations` (plano de sesion). Reglas:
 *
 *  - El guard CSRF (`assertTrustedMutationRequest`) corre PRIMERO: antes de
 *    leer body o cookies, construir el Bearer o invocar fetch. Un rechazo
 *    (403 estable) jamas llega al backend.
 *  - La cookie httpOnly `fluvia_session` se convierte en Bearer SOLO tras el
 *    guard; el token jamas llega al navegador.
 *  - La respuesta se RE-EMITE con campos whitelisted (jamas passthrough) y
 *    los redirects del backend NO se siguen (`redirect: 'manual'` ⇒ error).
 *  - Errores con `code` estable del catalogo, sin stack/SQL/body interno; el
 *    payload no se loguea. Host/X-Forwarded-Host jamas son fuente de confianza
 *    (la politica de origin vive en el guard).
 */
export async function POST(req: Request) {
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;

  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) {
    return NextResponse.json({ ok: false, error: { code: 'invalid_session' } }, { status: 401 });
  }

  const raw = (await req.json().catch(() => ({}))) as {
    organizationName?: unknown;
    slug?: unknown;
  };
  if (typeof raw.organizationName !== 'string' || typeof raw.slug !== 'string') {
    return NextResponse.json({ ok: false, error: { code: 'validation_error' } }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/organizations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationName: raw.organizationName, slug: raw.slug }),
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return NextResponse.json({ ok: false, error: { code: 'internal_error' } }, { status: 502 });
  }

  if (res.status >= 300 && res.status < 400) {
    // Un redirect del backend no es un contrato valido de este proxy.
    return NextResponse.json({ ok: false, error: { code: 'internal_error' } }, { status: 502 });
  }

  if (res.ok) {
    const body = (await res.json().catch(() => null)) as {
      organization?: { id?: unknown; name?: unknown; slug?: unknown };
      membership?: { role?: unknown };
      replayed?: unknown;
    } | null;
    const org = body?.organization;
    if (
      !org ||
      typeof org.id !== 'string' ||
      typeof org.name !== 'string' ||
      typeof org.slug !== 'string' ||
      body?.membership?.role !== 'owner'
    ) {
      return NextResponse.json({ ok: false, error: { code: 'internal_error' } }, { status: 502 });
    }
    // Whitelist estricta: solo los campos del contrato del wizard.
    return NextResponse.json(
      {
        organization: { id: org.id, name: org.name, slug: org.slug },
        membership: { role: 'owner' },
        replayed: body.replayed === true,
      },
      { status: res.status === 201 ? 201 : 200 }
    );
  }

  const body = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
  const code = typeof body.error?.code === 'string' ? body.error.code : 'internal_error';
  return NextResponse.json({ ok: false, error: { code } }, { status: res.status });
}
