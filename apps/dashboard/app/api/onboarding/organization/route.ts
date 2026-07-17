import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../lib/api';
import { assertTrustedMutationRequest } from '../../../lib/csrf';

/**
 * Onboarding Paso A (F6.5C2): crear la organizacion del operador. Proxy
 * server-side hacia `POST /v1/organizations` (plano de sesion). Reglas:
 *
 *  - El guard CSRF (`assertTrustedMutationRequest`) corre PRIMERO: antes de
 *    leer body o cookies, construir headers o invocar fetch. Un rechazo (403
 *    estable) jamas llega al backend.
 *  - La cookie httpOnly `fluvia_session` se convierte en Bearer SOLO tras el
 *    guard; el token jamas llega al navegador.
 *  - Contrato de exito ESTRICTO (jamas `res.ok`): SOLO status exacto 201 con
 *    `replayed === false` (creacion) o status exacto 200 con
 *    `replayed === true` (recuperacion natural), con body completo y valido.
 *    Cualquier otro 2xx (202/204/...), un redirect 3xx, un body
 *    vacio/malformado, `replayed` ausente/no-boolean/incoherente con el
 *    status, un role distinto de `owner` o un campo contractual invalido
 *    responde 502 `internal_error`.
 *  - La respuesta de exito se RE-EMITE con campos whitelisted (jamas
 *    passthrough). Los errores solo se aceptan si el PAR code/status coincide
 *    EXACTAMENTE con el mapa cerrado del proxy (RA-F65C2-EXT-004); la
 *    respuesta se reconstruye con el status CANONICO del mapa. Code
 *    desconocido, code con status incorrecto, code del otro proxy o
 *    `internal_error` con status distinto de 500 ⇒ 502 sin reflejarse.
 *  - Sin stack/SQL/body interno; el payload no se loguea; Host/
 *    X-Forwarded-Host jamas son fuente de confianza (la politica de origin
 *    vive en el guard).
 */

// RA-F65C2-EXT-004: mapa CERRADO code → status canonico. Un error solo es
// contractual si el code pertenece al mapa Y el status del backend coincide
// exactamente; la respuesta se reconstruye SIEMPRE con el status del mapa
// (jamas se preserva un status backend engañoso).
const ORGANIZATION_ERROR_STATUS: Record<string, number> = {
  validation_error: 400,
  invalid_session: 401,
  email_not_verified: 403,
  organization_slug_taken: 409,
  onboarding_already_completed: 409,
  internal_error: 500,
};

const badGateway = () =>
  NextResponse.json({ ok: false, error: { code: 'internal_error' } }, { status: 502 });

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
    return badGateway();
  }

  // Exito: SOLO 201 (creacion) o 200 (recuperacion natural). Un redirect 3xx
  // o cualquier otro 2xx no es un contrato valido de este proxy.
  if (res.status === 201 || res.status === 200) {
    const body = (await res.json().catch(() => null)) as {
      organization?: { id?: unknown; name?: unknown; slug?: unknown };
      membership?: { role?: unknown };
      replayed?: unknown;
    } | null;
    const org = body?.organization;
    const replayed = body?.replayed;
    if (
      !org ||
      typeof org.id !== 'string' ||
      org.id === '' ||
      typeof org.name !== 'string' ||
      typeof org.slug !== 'string' ||
      body?.membership?.role !== 'owner' ||
      typeof replayed !== 'boolean' ||
      // Coherencia status/replayed: 201 = creacion nueva; 200 = replay.
      (res.status === 201 && replayed !== false) ||
      (res.status === 200 && replayed !== true)
    ) {
      return badGateway();
    }
    // Whitelist estricta: solo los campos del contrato del wizard.
    return NextResponse.json(
      {
        organization: { id: org.id, name: org.name, slug: org.slug },
        membership: { role: 'owner' },
        replayed,
      },
      { status: res.status }
    );
  }

  if (res.status < 400) {
    // 2xx no contractual (202/204/...) o redirect 3xx no seguido.
    return badGateway();
  }

  const body = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
  const code = body.error?.code;
  const canonicalStatus = typeof code === 'string' ? ORGANIZATION_ERROR_STATUS[code] : undefined;
  if (typeof code !== 'string' || canonicalStatus === undefined || res.status !== canonicalStatus) {
    // Code desconocido, del otro proxy, o conocido con status incorrecto:
    // jamas se refleja ni se preserva el status backend.
    return badGateway();
  }
  return NextResponse.json({ ok: false, error: { code } }, { status: canonicalStatus });
}
