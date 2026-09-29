import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../lib/api';
import { UUID_RE, type PosErrorCode } from '../../../../../lib/pos-contract';
import { fetchRecentCharges } from '../../../../../lib/pos-reads';

/**
 * POS sandbox — «cobros recientes» (LECTURA). Refresca el panel sin recargar la
 * página. Solo combina dos GET existentes del plano de sesión (`payments:read`,
 * todo rol) de la org de la RUTA: RLS + membresía hacen que otra org responda
 * 404/403 y aquí se traduce a `not_found`, jamás a una lista vacía.
 *
 * Respuesta por WHITELIST (sin `url` de sesión ni secretos) con la VENTANA
 * leída (`limit`, `returned`, `truncated`) para que la UI diga que los filtros
 * solo cubren las últimas N sesiones.
 */

function fail(code: PosErrorCode, status: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code } },
    { status, headers: { 'cache-control': 'no-store' } }
  );
}

export async function GET(_req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return fail('invalid_session', 401);
  if (!UUID_RE.test(orgId)) return fail('validation_error', 400);

  const r = await fetchRecentCharges({ apiBase: apiBase(), token, orgId });
  if (!r.ok) {
    if (r.reason === 'auth') return fail('invalid_session', 401);
    if (r.reason === 'forbidden') return fail('not_found', 404);
    return fail('upstream_unavailable', 502);
  }
  return NextResponse.json(
    { rows: r.rows, window: r.window },
    { status: 200, headers: { 'cache-control': 'no-store' } }
  );
}
