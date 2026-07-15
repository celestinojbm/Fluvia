import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../lib/csrf';

/**
 * Crear una API key por sesión (F6.5B2). Reenvía la cookie httpOnly como Bearer
 * al endpoint EXISTENTE `POST /v1/organizations/:orgId/api-keys` (RBAC
 * `keys:manage` + step-up MFA — impuestos por el API, no aquí). La respuesta
 * incluye el secreto UNA vez; se transmite tal cual al cliente (que lo revela
 * una sola vez). Este handler NO loguea el cuerpo ni persiste el secreto.
 * `cache: 'no-store'`. Si falta step-up, el API responde 403 mfa_step_up_required
 * y el cliente abre el modal de step-up.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  // RA-F65B-EXT-002: procedencia same-origin ANTES de tocar cookie o body.
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;
  const { orgId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ ok: false }, { status: 401 });

  const res = await fetch(`${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/api-keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: await req.text(),
    cache: 'no-store',
  });
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}
