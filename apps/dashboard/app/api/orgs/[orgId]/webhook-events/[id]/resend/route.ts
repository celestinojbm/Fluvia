import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../../../lib/csrf';

/**
 * Reenvío de un evento `dead` (F3-09b-iii). Reenvía la cookie de sesión a la ruta
 * de operación por sesión de la API (`webhooks:manage`); el navegador nunca
 * sostiene el token ni conoce la URL de la API. Sin sesión → 401.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  // RA-F65B-DELTA2-001: procedencia same-origin ANTES de tocar la cookie o
  // convertirla en Bearer (un sibling same-site podría forzar el replay).
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;
  const { orgId, id } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });

  const res = await fetch(
    `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/webhook_events/${encodeURIComponent(id)}/resend`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    }
  );
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
