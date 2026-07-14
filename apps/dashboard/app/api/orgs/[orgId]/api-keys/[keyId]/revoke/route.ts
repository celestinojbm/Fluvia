import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../../lib/api';

/**
 * Revocar una API key por sesión (F6.5B2). Reenvía la cookie httpOnly como
 * Bearer al endpoint EXISTENTE `POST /v1/organizations/:orgId/api-keys/:id/revoke`
 * (`keys:manage` + step-up). No revela secreto; el revoke es idempotente en el
 * servicio (`COALESCE(revoked_at, now())`). `cache: 'no-store'`, sin log.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ orgId: string; keyId: string }> }
) {
  const { orgId, keyId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });

  const res = await fetch(
    `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(keyId)}/revoke`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }
  );
  // 204 sin cuerpo, o el sobre de error estable (403/404/…) tal cual.
  const body = await res.text();
  return new NextResponse(body || null, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
