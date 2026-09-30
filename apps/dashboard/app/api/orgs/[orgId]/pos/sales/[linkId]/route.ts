import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../../lib/api';
import { pickSale, UUID_RE, type PosErrorCode } from '../../../../../../lib/pos-contract';

/**
 * POS — la VENTA (LECTURA): `GET /v1/organizations/:orgId/payment_links/:id/sale`
 * del plano de sesión (`payments:read`, RLS + membresía: una venta de otra org
 * responde 404). Es la fuente de verdad de «qué checkouts tiene esta venta y
 * si ya cobró», para cualquier pestaña o dispositivo (vínculo persistente 0046).
 *
 * Como el BFF de estado: distingue «no existe» (404), «sesión caducada» (401)
 * y «no sabemos» (502) — el POS jamás decide recuperar una venta sobre un
 * fallo de lectura. Respuesta reconstruida por WHITELIST (sin passthrough).
 */

function fail(code: PosErrorCode, status: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code } },
    { status, headers: { 'cache-control': 'no-store' } }
  );
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ orgId: string; linkId: string }> }
) {
  const { orgId, linkId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return fail('invalid_session', 401);
  if (!UUID_RE.test(orgId) || !UUID_RE.test(linkId)) return fail('validation_error', 400);

  let res: Response;
  try {
    res = await fetch(
      `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/payment_links/${encodeURIComponent(linkId)}/sale`,
      { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'manual' }
    );
  } catch {
    return fail('upstream_unavailable', 502);
  }
  if (res.status === 401) return fail('invalid_session', 401);
  if (res.status === 403 || res.status === 404) return fail('not_found', 404);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* cuerpo no JSON */
  }
  const sale = res.status === 200 ? pickSale(body) : null;
  if (!sale || sale.link_id !== linkId) return fail('upstream_unavailable', 502);
  return NextResponse.json(sale, { status: 200, headers: { 'cache-control': 'no-store' } });
}
