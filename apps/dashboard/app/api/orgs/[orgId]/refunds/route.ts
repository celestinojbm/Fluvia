import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../lib/csrf';

/**
 * Crear un reembolso por sesión (F6.5A-bis, G1). Reenvía la cookie httpOnly
 * como Bearer y PROPAGA la `Idempotency-Key` generada en el cliente: un retry
 * del operador no duplica el reembolso. El API (`reconciliation:manage`) es la
 * fuente de verdad del permiso; status y sobre de error se transmiten tal cual.
 *
 * Mueve dinero: pasa por el guard CSRF same-origin ANTES de leer cookie o body
 * (lo usan la página de pago y la devolución del POS; ambas envían
 * `X-Fluvia-CSRF`). Sin respuesta del API ⇒ 502 `upstream_unavailable`: el
 * cliente lo trata como resultado INCIERTO y reintenta con la MISMA key.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;

  const { orgId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) {
    return NextResponse.json({ ok: false, error: { code: 'invalid_session' } }, { status: 401 });
  }
  const idempotencyKey = req.headers.get('idempotency-key');
  if (!idempotencyKey) return NextResponse.json({ ok: false }, { status: 400 });

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/refunds`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: await req.text(),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'upstream_unavailable' } },
      { status: 502 }
    );
  }
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
