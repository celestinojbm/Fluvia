import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../lib/csrf';

/**
 * BFF de Fluvia Operaciones: reenvía a `/v1/programs/:orgId/<ruta>` con la
 * sesión del operador (cookie `fluvia_session`). Rutas acotadas (no es un
 * proxy abierto); mutaciones con guard CSRF antes de leer cookie o body. La
 * API decide permisos (`program:*`) y step-up; aquí solo se transporta.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ALLOWED: RegExp[] = [
  /^setup$/,
  new RegExp(`^consumers/${UUID}/(status|collateral-applications)$`),
  new RegExp(`^applications/${UUID}/decision$`),
  new RegExp(`^lines/${UUID}/(limit|status)$`),
  /^policies$/,
  new RegExp(`^policies/${UUID}/propose-activation$`),
  new RegExp(`^approvals/${UUID}/decision$`),
  new RegExp(`^cards/${UUID}/(block|unblock|close|shipment)$`),
  /^cases$/,
  new RegExp(`^cases/${UUID}/(acknowledge|resolve)$`),
  /^uncertain\/resolve$/,
  new RegExp(`^events/${UUID}/reprocess$`),
  /^reconciliation\/run$/,
  /^maintenance\/(overdue|expire-authorizations)$/,
  /^sandbox\/provider-events$/,
];

export async function POST(
  req: Request,
  ctx: { params: Promise<{ orgId: string; path: string[] }> }
) {
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;
  const { orgId, path } = await ctx.params;
  const sub = path.join('/');
  if (!new RegExp(`^${UUID}$`).test(orgId) || !ALLOWED.some((re) => re.test(sub))) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return NextResponse.json({ error: { code: 'invalid_session' } }, { status: 401 });
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/programs/${orgId}/${sub}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: (await req.text()) || '{}',
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable' } }, { status: 502 });
  }
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
