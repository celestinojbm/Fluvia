import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase } from '../../../../../../../lib/api';
import { UUID_RE, type PosErrorCode } from '../../../../../../../lib/pos-contract';
import {
  isChargedStatus,
  pickMerchantName,
  pickReceiptPayment,
  pickReceiptRefunds,
  pickReceiptSale,
  refundsConsistent,
  type PosReceipt,
  type ReceiptPayment,
} from '../../../../../../../lib/pos-receipt-contract';
import { REFUNDS_WINDOW } from '../../../../../../../lib/pos-refund-contract';

/**
 * POS — justificante de un cobro (LECTURA). Compone SOLO GET existentes del
 * plano de sesión de la org de la RUTA (RLS + membresía):
 *
 *  1. `payment_intents/:id` — el cobro. Si la API no lo da por confirmado
 *     (`succeeded`/`partially_refunded`/`refunded`) ⇒ 409 `not_charged`:
 *     no hay justificante de un cobro sin confirmar.
 *  2. `merchants/:merchant_id` — nombre del comercio.
 *  3. `payment_links/:id/sale` — concepto y `completed_at` del checkout que
 *     cobró este intent (solo si el cobro tiene venta vinculada).
 *  4. `refunds?payment_intent_id=&limit=100` — devoluciones (sin `reason`).
 *
 * INSTANTÁNEA coherente: cobro → devoluciones → cobro otra vez. Si el cobro
 * cambió entre medias (una devolución se liquidó) se repite (máx. 3); si la
 * suma de las `succeeded` no cuadra con `amount_refunded` (lista completa) no
 * hay justificante: jamás se emite uno con totales y lista contradictorios.
 *
 * TODO o NADA: cualquier lectura fallida o incoherente ⇒ 502 (jamás un
 * justificante a medias). 401 ⇒ sesión caducada; 403/404 ⇒ `not_found`.
 * Respuesta reconstruida por WHITELIST (sin `url`, secretos ni ids ajenos).
 */

function fail(code: PosErrorCode, status: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code } },
    { status, headers: { 'cache-control': 'no-store' } }
  );
}

type Read = { status: number; body: unknown } | null;

async function getJson(url: string, token: string): Promise<Read> {
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

/** Traduce un fallo de lectura; null si la lectura fue 200. */
function readFailure(r: Read): NextResponse | null {
  if (!r) return fail('upstream_unavailable', 502);
  if (r.status === 401) return fail('invalid_session', 401);
  if (r.status === 403 || r.status === 404) return fail('not_found', 404);
  if (r.status !== 200) return fail('upstream_unavailable', 502);
  return null;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ orgId: string; paymentId: string }> }
) {
  const { orgId, paymentId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return fail('invalid_session', 401);
  if (!UUID_RE.test(orgId) || !UUID_RE.test(paymentId)) return fail('validation_error', 400);

  const base = `${apiBase()}/v1/organizations/${encodeURIComponent(orgId)}`;

  const intentUrl = `${base}/payment_intents/${encodeURIComponent(paymentId)}`;
  const refundsUrl = `${base}/refunds?${new URLSearchParams({
    payment_intent_id: paymentId,
    limit: String(REFUNDS_WINDOW),
  }).toString()}`;

  /** Lee y valida el cobro; NextResponse si no se puede emitir justificante. */
  const readPayment = async (): Promise<ReceiptPayment | NextResponse> => {
    const p = await getJson(intentUrl, token);
    const pFail = readFailure(p);
    if (pFail) return pFail;
    const payment = pickReceiptPayment(p!.body);
    if (!payment || payment.id !== paymentId) return fail('upstream_unavailable', 502);
    if (!isChargedStatus(payment.status)) return fail('not_charged', 409);
    return payment;
  };

  let snapshot: {
    payment: ReceiptPayment;
    refunds: PosReceipt['refunds'];
    truncated: boolean;
  } | null = null;
  for (let attempt = 0; attempt < 3 && !snapshot; attempt++) {
    const before = await readPayment();
    if (before instanceof NextResponse) return before;
    const r = await getJson(refundsUrl, token);
    const rFail = readFailure(r);
    if (rFail) return rFail.status === 404 ? fail('upstream_unavailable', 502) : rFail;
    const list = pickReceiptRefunds(r!.body, paymentId);
    if (!list) return fail('upstream_unavailable', 502);
    const after = await readPayment();
    if (after instanceof NextResponse) return after;
    if (
      after.status === before.status &&
      after.amount_refunded === before.amount_refunded &&
      after.amount_captured === before.amount_captured
    ) {
      snapshot = { payment: after, refunds: list.refunds, truncated: list.truncated };
    }
  }
  if (!snapshot) return fail('upstream_unavailable', 502);
  const { payment } = snapshot;
  if (!refundsConsistent(payment, snapshot.refunds, snapshot.truncated)) {
    return fail('upstream_unavailable', 502);
  }

  const [m, s] = await Promise.all([
    getJson(`${base}/merchants/${encodeURIComponent(payment.merchant_id)}`, token),
    payment.payment_link_id
      ? getJson(`${base}/payment_links/${encodeURIComponent(payment.payment_link_id)}/sale`, token)
      : Promise.resolve(undefined),
  ]);
  const mFail = readFailure(m);
  if (mFail) return mFail.status === 404 ? fail('upstream_unavailable', 502) : mFail;
  const merchantName = pickMerchantName(m!.body, payment.merchant_id);
  if (!merchantName) return fail('upstream_unavailable', 502);

  let sale: PosReceipt['sale'] = null;
  if (s !== undefined) {
    const sFail = readFailure(s);
    // La venta de un cobro existente que no se puede leer es un fallo de
    // lectura, no «sin venta»: 502.
    if (sFail) return sFail.status === 404 ? fail('upstream_unavailable', 502) : sFail;
    sale = pickReceiptSale(s!.body, payment.payment_link_id!, payment.id);
    if (!sale) return fail('upstream_unavailable', 502);
  }

  const receipt: PosReceipt = {
    payment,
    merchant_name: merchantName,
    sale,
    // Lista truncada: la API devuelve solo las 100 MÁS RECIENTES; un
    // desglose parcial podría ocultar una devolución `indeterminate` antigua.
    // No se entrega desglose: solo el total de la API y el aviso.
    refunds: snapshot.truncated ? [] : snapshot.refunds,
    refunds_truncated: snapshot.truncated,
  };
  return NextResponse.json(receipt, { status: 200, headers: { 'cache-control': 'no-store' } });
}
