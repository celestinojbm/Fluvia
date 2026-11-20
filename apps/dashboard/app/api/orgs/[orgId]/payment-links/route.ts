import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../lib/csrf';

/**
 * Crear un payment link por sesión (F6.5A-bis, G2). Reenvía la cookie httpOnly
 * como Bearer y PROPAGA la `Idempotency-Key` generada en el cliente. El API
 * (`reconciliation:manage`) es la fuente de verdad del permiso.
 *
 * Guard CSRF (same-origin estricto) ANTES de leer cookie/body: crear un link
 * inicia cobros y es el primer paso del POS sandbox. Cierra, para ESTA ruta,
 * la deuda CSRF registrada en HANDOFF (las demás rutas `proxySessionPost`
 * siguen pendientes de su propia autorización).
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;

  const { orgId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });
  const idempotencyKey = req.headers.get('idempotency-key');
  if (!idempotencyKey) return NextResponse.json({ ok: false }, { status: 400 });

  const res = await fetch(
    `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/payment_links`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: await req.text(),
      cache: 'no-store',
    }
  );
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
