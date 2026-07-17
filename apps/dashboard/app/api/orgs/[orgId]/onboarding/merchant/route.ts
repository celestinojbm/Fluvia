import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../../lib/csrf';

/**
 * Onboarding Paso B (F6.5C2): merchant inicial + chart. Proxy server-side
 * hacia `POST /v1/organizations/:orgId/onboarding/merchant` (plano de sesion;
 * RBAC/RLS los aplica el API). Mismas reglas que el proxy de organizacion:
 * guard CSRF PRIMERO (antes de body/cookies/Bearer/fetch), respuesta re-emitida
 * por whitelist, sin redirects, errores con `code` estable sin detalle interno,
 * payload jamas logueado.
 */
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
    return NextResponse.json({ ok: false, error: { code: 'internal_error' } }, { status: 502 });
  }

  if (res.status >= 300 && res.status < 400) {
    return NextResponse.json({ ok: false, error: { code: 'internal_error' } }, { status: 502 });
  }

  if (res.ok) {
    const body = (await res.json().catch(() => null)) as {
      merchant?: { id?: unknown; name?: unknown; country?: unknown; defaultCurrency?: unknown };
      chartReady?: unknown;
      replayed?: unknown;
    } | null;
    const m = body?.merchant;
    if (
      !m ||
      typeof m.id !== 'string' ||
      typeof m.name !== 'string' ||
      typeof m.country !== 'string' ||
      typeof m.defaultCurrency !== 'string' ||
      body?.chartReady !== true
    ) {
      return NextResponse.json({ ok: false, error: { code: 'internal_error' } }, { status: 502 });
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
        replayed: body.replayed === true,
      },
      { status: res.status === 201 ? 201 : 200 }
    );
  }

  const body = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
  const code = typeof body.error?.code === 'string' ? body.error.code : 'internal_error';
  return NextResponse.json({ ok: false, error: { code } }, { status: res.status });
}
