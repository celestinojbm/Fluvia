import { UUID_RE } from './pos-contract';

/**
 * Justificante de un cobro del POS — contrato PURO (lo importan el BFF y el
 * componente cliente). Es un justificante OPERATIVO del sandbox, NO una factura
 * ni un documento fiscal: sin numeración fiscal, sin impuestos, sin datos del
 * comprador.
 *
 * SOLO lecturas existentes del plano de sesión (el BFF no inventa nada):
 *  - Cobro = `GET /v1/organizations/:orgId/payment_intents/:id` (`payments:read`)
 *    → importe, capturado, devuelto, moneda, estado, comercio, venta, alta.
 *  - Venta = `GET /v1/organizations/:orgId/payment_links/:id/sale` (`payments:read`)
 *    → concepto (`description` del link) y `completed_at` del checkout que
 *    cobró ESTE intent.
 *  - Comercio = `GET /v1/organizations/:orgId/merchants/:id` (`merchants:read`,
 *    todo rol) → nombre.
 *
 * Solo hay justificante de un cobro CONFIRMADO por la API: intent en
 * `succeeded`, `partially_refunded` o `refunded` (los dos últimos siguen siendo
 * un cobro confirmado que después se devolvió).
 */

export const CHARGED_STATUSES = new Set(['succeeded', 'partially_refunded', 'refunded']);

export function isChargedStatus(status: string): boolean {
  return CHARGED_STATUSES.has(status);
}

export interface ReceiptPayment {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  amount_captured: number;
  amount_refunded: number;
  created_at: string;
  payment_link_id: string | null;
}

export interface ReceiptSale {
  /** Concepto de la venta (`description` del payment link); null si no tiene. */
  description: string | null;
  /** `completed_at` del checkout que cobró este intent; null si la API no lo trae. */
  checkout_completed_at: string | null;
}

/** Respuesta del BFF del justificante (200). */
export interface PosReceipt {
  payment: ReceiptPayment;
  merchant_name: string;
  /** null = cobro sin venta vinculada (anterior al vínculo 0046). */
  sale: ReceiptSale | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const optStr = (v: unknown): string | null | false =>
  v === undefined || v === null ? null : typeof v === 'string' ? v : false;

/**
 * Intent del plano de sesión → cobro del justificante (WHITELIST). Aquí
 * `amount_captured` es obligatorio: un justificante no muestra un importe
 * cobrado que la API no dio.
 */
export function pickReceiptPayment(v: unknown): ReceiptPayment | null {
  if (!isObj(v)) return null;
  const { id, merchant_id, amount, currency, status, amount_captured, amount_refunded } = v;
  if (!str(id) || !UUID_RE.test(id) || !str(merchant_id) || !UUID_RE.test(merchant_id)) {
    return null;
  }
  if (!int(amount) || amount <= 0 || !str(currency) || !/^[A-Z]{3}$/.test(currency)) return null;
  if (!str(status) || !int(amount_captured) || amount_captured < 0) return null;
  if (!int(amount_refunded) || amount_refunded < 0 || !str(v.created_at)) return null;
  const link = v.payment_link_id;
  if (link !== undefined && link !== null && !(str(link) && UUID_RE.test(link))) return null;
  return {
    id,
    merchant_id,
    amount,
    currency,
    status,
    amount_captured,
    amount_refunded,
    created_at: v.created_at,
    payment_link_id: (link as string | null | undefined) ?? null,
  };
}

/**
 * Venta del plano de sesión → datos del justificante. El link debe ser el
 * pedido y el intent debe figurar entre sus checkouts (si no, la venta no es
 * la de este cobro: null ⇒ el BFF responde «no sabemos»).
 */
export function pickReceiptSale(v: unknown, linkId: string, intentId: string): ReceiptSale | null {
  if (!isObj(v) || !isObj(v.payment_link) || !Array.isArray(v.checkouts)) return null;
  const l = v.payment_link;
  if (l.id !== linkId) return null;
  const description = optStr(l.description);
  if (description === false) return null;
  const mine = v.checkouts.find((c) => isObj(c) && c.payment_intent_id === intentId);
  if (!isObj(mine)) return null;
  let completed: string | null = null;
  const cs = mine.checkout_session;
  if (cs !== null && cs !== undefined) {
    if (!isObj(cs)) return null;
    const c = optStr(cs.completed_at);
    if (c === false) return null;
    completed = c;
  }
  return {
    description: description === null || description.trim() === '' ? null : description,
    checkout_completed_at: completed,
  };
}

/** Comercio del plano de sesión → su nombre (debe ser el pedido). */
export function pickMerchantName(v: unknown, merchantId: string): string | null {
  if (!isObj(v) || v.id !== merchantId || !str(v.name)) return null;
  return v.name;
}

/** Valida la respuesta del BFF en el cliente (forma inesperada ⇒ null). */
export function parseReceipt(v: unknown): PosReceipt | null {
  if (!isObj(v) || !str(v.merchant_name)) return null;
  const payment = pickReceiptPayment(v.payment);
  if (!payment) return null;
  let sale: ReceiptSale | null = null;
  if (v.sale !== null) {
    if (!isObj(v.sale)) return null;
    const d = optStr(v.sale.description);
    const c = optStr(v.sale.checkout_completed_at);
    if (d === false || c === false) return null;
    sale = { description: d, checkout_completed_at: c };
  }
  return { payment, merchant_name: v.merchant_name, sale };
}

/**
 * Referencia visible del justificante: los 8 últimos caracteres del id del
 * cobro, en mayúsculas. Nunca se muestra el identificador completo; basta para
 * localizar el cobro junto con importe y fecha.
 */
export function receiptRef(paymentId: string): string {
  return paymentId.replace(/-/g, '').slice(-8).toUpperCase();
}
