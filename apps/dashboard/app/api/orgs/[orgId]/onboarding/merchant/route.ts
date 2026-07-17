import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../../lib/csrf';

/**
 * Onboarding Paso B (F6.5C2): merchant inicial + chart. Proxy server-side
 * hacia `POST /v1/organizations/:orgId/onboarding/merchant` (plano de sesion;
 * RBAC/RLS los aplica el API). Mismas reglas que el proxy de organizacion:
 * guard CSRF PRIMERO (antes de body/cookies/Bearer/fetch) y contrato de exito
 * ESTRICTO (jamas `res.ok`): SOLO status exacto 201 con `replayed === false`
 * (creacion) o status exacto 200 con `replayed === true` (recuperacion), y
 * SIEMPRE `chartReady === true`; cualquier otro 2xx, redirect 3xx, body
 * incompleto/malformado o incoherencia status/replayed responde 502
 * `internal_error`. Exito re-emitido por whitelist; errores solo con el PAR
 * code/status EXACTO del mapa cerrado del proxy (RA-F65C2-EXT-004) — code
 * desconocido, del otro proxy o con status incorrecto ⇒ 502, jamas reflejado
 * ni con status backend preservado; sin stack/SQL/body interno; payload jamas
 * logueado.
 */

// RA-F65C2-EXT-004: mapa CERRADO code → status canonico (ver proxy de
// organizacion). La respuesta de error se reconstruye con el status del mapa.
const MERCHANT_ERROR_STATUS: Record<string, number> = {
  validation_error: 400,
  invalid_session: 401,
  insufficient_permissions: 403,
  not_found: 404,
  merchant_onboarding_already_completed: 409,
  internal_error: 500,
};

const badGateway = () =>
  NextResponse.json({ ok: false, error: { code: 'internal_error' } }, { status: 502 });

export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;

  const { orgId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) {
    return NextResponse.json({ ok: false, error: { code: 'invalid_session' } }, { status: 401 });
  }

  const raw = (await req.json().catch(() => ({}))) as {
    name?: unknown;
    country?: unknown;
    defaultCurrency?: unknown;
  };
  if (
    typeof raw.name !== 'string' ||
    (raw.country !== undefined && typeof raw.country !== 'string') ||
    (raw.defaultCurrency !== undefined && typeof raw.defaultCurrency !== 'string')
  ) {
    return NextResponse.json({ ok: false, error: { code: 'validation_error' } }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(
      `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/onboarding/merchant`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: raw.name,
          ...(raw.country !== undefined ? { country: raw.country } : {}),
          ...(raw.defaultCurrency !== undefined ? { defaultCurrency: raw.defaultCurrency } : {}),
        }),
        cache: 'no-store',
        redirect: 'manual',
      }
    );
  } catch {
    return badGateway();
  }

  // Exito: SOLO 201 (creacion) o 200 (recuperacion natural), chart listo.
  if (res.status === 201 || res.status === 200) {
    const body = (await res.json().catch(() => null)) as {
      merchant?: { id?: unknown; name?: unknown; country?: unknown; defaultCurrency?: unknown };
      chartReady?: unknown;
      replayed?: unknown;
    } | null;
    const m = body?.merchant;
    const replayed = body?.replayed;
    if (
      !m ||
      typeof m.id !== 'string' ||
      m.id === '' ||
      typeof m.name !== 'string' ||
      typeof m.country !== 'string' ||
      typeof m.defaultCurrency !== 'string' ||
      body?.chartReady !== true ||
      typeof replayed !== 'boolean' ||
      // Coherencia status/replayed: 201 = creacion nueva; 200 = replay.
      (res.status === 201 && replayed !== false) ||
      (res.status === 200 && replayed !== true)
    ) {
      return badGateway();
    }
    return NextResponse.json(
      {
        merchant: {
          id: m.id,
          name: m.name,
          country: m.country,
          defaultCurrency: m.defaultCurrency,
        },
        chartReady: true,
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
  const canonicalStatus = typeof code === 'string' ? MERCHANT_ERROR_STATUS[code] : undefined;
  if (typeof code !== 'string' || canonicalStatus === undefined || res.status !== canonicalStatus) {
    // Code desconocido, del otro proxy, o conocido con status incorrecto:
    // jamas se refleja ni se preserva el status backend.
    return badGateway();
  }
  return NextResponse.json({ ok: false, error: { code } }, { status: canonicalStatus });
}
