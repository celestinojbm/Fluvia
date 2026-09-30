import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../../../lib/api';
import { UUID_RE, type PosErrorCode } from '../../../../../../../lib/pos-contract';
import { pickRefundList, REFUNDS_WINDOW } from '../../../../../../../lib/pos-refund-contract';

/**
 * POS — devoluciones de un cobro (LECTURA): `GET /v1/organizations/:orgId/refunds
 * ?payment_intent_id=&limit=100` del plano de sesión (`payments:read`, RLS +
 * membresía: un intent de otra org no devuelve nada).
 *
 * Como los demás BFF de lectura del POS: distingue «sesión caducada» (401),
 * «sin acceso» (403/404 ⇒ `not_found`) y «no sabemos» (502). La lista se
 * reconstruye por WHITELIST y es TODO o NADA: un refund malformado o de otro
 * intent invalida la lectura (el cupo devolvible no se calcula a medias).
 */

function fail(code: PosErrorCode, status: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code } },
    { status, headers: { 'cache-control': 'no-store' } }
  );
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ orgId: string; paymentId: string }> }
) {
  const { orgId, paymentId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return fail('invalid_session', 401);
  if (!UUID_RE.test(orgId) || !UUID_RE.test(paymentId)) return fail('validation_error', 400);

  const q = new URLSearchParams({ payment_intent_id: paymentId, limit: String(REFUNDS_WINDOW) });
  let res: Response;
  try {
    res = await fetch(
      `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}/refunds?${q.toString()}`,
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
  const list = res.status === 200 ? pickRefundList(body, paymentId) : null;
  if (!list) return fail('upstream_unavailable', 502);
  return NextResponse.json(list, { status: 200, headers: { 'cache-control': 'no-store' } });
}
