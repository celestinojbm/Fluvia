import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../../../lib/csrf';

/**
 * Rotar el secreto de un webhook endpoint por sesión (F6.5B1). La respuesta
 * trae el NUEVO secreto `whsec_` UNA vez; se transmite tal cual (revelado una
 * sola vez en el cliente). No se loguea ni persiste. `cache: 'no-store'`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  // RA-F65B-EXT-002: procedencia same-origin ANTES de tocar la cookie.
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;
  const { orgId, id } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });

  const res = await fetch(
    `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/webhook_endpoints/${encodeURIComponent(id)}/rotate`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }
  );
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
