import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../lib/csrf';

/**
 * Crear un webhook endpoint por sesión (F6.5B1). Reenvía la cookie httpOnly
 * como Bearer al plano de sesión (`webhooks:manage`). La respuesta incluye el
 * secreto `whsec_` UNA vez; se transmite tal cual al cliente (que lo revela una
 * sola vez) — este handler NO lo loguea ni lo persiste. `cache: 'no-store'`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  // RA-F65B-EXT-002: procedencia same-origin ANTES de tocar cookie o body.
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;
  const { orgId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });

  const res = await fetch(
    `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/webhook_endpoints`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
