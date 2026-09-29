import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../../lib/api';
import {
  pickPayment,
  pickSession,
  UUID_RE,
  type PosErrorCode,
} from '../../../../../../lib/pos-contract';

/**
 * POS sandbox — estado de un cobro (LECTURA). Combina dos GET existentes del
 * plano de sesión (`payments:read`, todo rol): la sesión de checkout y el
 * payment intent que referencia. Ambos pasan por RLS + membresía de la org:
 * una sesión de otra org responde 404.
 *
 * A diferencia de `apiGet` (que colapsa todo fallo en `null`), aquí se
 * distinguen «no existe» (404), «sesión caducada» (401) y «no sabemos» (502):
 * el POS nunca confunde un fallo de lectura con un estado del pago. Respuesta
 * reconstruida por WHITELIST (sin passthrough).
 */

function fail(code: PosErrorCode, status: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code } },
    { status, headers: { 'cache-control': 'no-store' } }
  );
}

async function getJson(
  url: string,
  token: string
): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      redirect: 'manual',
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* cuerpo no JSON */
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ orgId: string; sessionId: string }> }
) {
  const { orgId, sessionId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return fail('invalid_session', 401);
  if (!UUID_RE.test(orgId) || !UUID_RE.test(sessionId)) return fail('validation_error', 400);

  const base = `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}`;
  const s = await getJson(`${base}/checkout_sessions/${encodeURIComponent(sessionId)}`, token);
  if (!s) return fail('upstream_unavailable', 502);
  if (s.status === 401) return fail('invalid_session', 401);
  if (s.status === 404) return fail('not_found', 404);
  const session = s.status === 200 ? pickSession(s.body) : null;
  if (!session) return fail('upstream_unavailable', 502);

  const intentId = (s.body as { payment_intent_id: string }).payment_intent_id;
  const p = await getJson(`${base}/payment_intents/${encodeURIComponent(intentId)}`, token);
  if (!p) return fail('upstream_unavailable', 502);
  if (p.status === 401) return fail('invalid_session', 401);
  const payment = p.status === 200 ? pickPayment(p.body) : null;
  // Una sesión existente cuyo intent no se puede leer es un fallo de lectura,
  // no un estado: 502 (jamás «no encontrado» ni un pago inventado).
  if (!payment || payment.id !== intentId) return fail('upstream_unavailable', 502);

  return NextResponse.json(
    { session, payment },
    { status: 200, headers: { 'cache-control': 'no-store' } }
  );
}
