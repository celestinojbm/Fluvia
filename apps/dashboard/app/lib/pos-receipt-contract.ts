import { UUID_RE } from './pos-contract';
import { pickRefundList, type RefundStatus } from './pos-refund-contract';

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
 *  - Devoluciones = `GET /v1/organizations/:orgId/refunds?payment_intent_id=&limit=100`
 *    (`payments:read`) → importe, estado y fecha de cada una. `reason` y
 *    `failure_code` NO se incluyen: son notas internas (el motivo lo escribe
 *    el cajero y puede llevar datos personales) y un justificante se entrega
 *    al cliente.
 *
 * Totales: SOLO los que da la API (`amount_captured`, `amount_refunded`). El
 * justificante no calcula netos ni «pendientes». `amount_refunded` solo crece
 * cuando una devolución pasa a `succeeded` (misma transacción, RefundService),
 * así que con la lista completa la suma de las `succeeded` DEBE coincidir: el
 * BFF lo comprueba y, si no, no emite justificante (lectura incoherente).
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

/** Devolución tal y como la muestra el justificante (sin `reason` ni `failure_code`). */
export interface ReceiptRefund {
  id: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  created_at: string;
}

/** Respuesta del BFF del justificante (200). */
export interface PosReceipt {
  payment: ReceiptPayment;
  merchant_name: string;
  /** null = cobro sin venta vinculada (anterior al vínculo 0046). */
  sale: ReceiptSale | null;
  /** Más recientes primero. */
  refunds: ReceiptRefund[];
  /**
   * La ventana de 100 se llenó (la API devuelve las 100 MÁS RECIENTES): no
   * hay desglose (`refunds` vacío) porque uno parcial podría ocultar una
   * devolución pendiente antigua. Solo vale el total `amount_refunded`.
   */
  refunds_truncated: boolean;
}

const REFUND_STATUSES = new Set<string>([
  'created',
  'processing',
  'indeterminate',
  'succeeded',
  'failed',
  'canceled',
]);

/**
 * Lista del API (`{ data }`) → devoluciones del justificante. Reutiliza la
 * validación TODO o NADA del POS (`pickRefundList`) y quita `reason`/`failure_code`.
 */
export function pickReceiptRefunds(
  v: unknown,
  paymentIntentId: string
): { refunds: ReceiptRefund[]; truncated: boolean } | null {
  const list = pickRefundList(v, paymentIntentId);
  if (!list) return null;
  return {
    refunds: list.refunds.map((r) => ({
      id: r.id,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      created_at: r.created_at,
    })),
    truncated: list.truncated,
  };
}

/**
 * Coherencia de la lectura: moneda del cobro en todas las devoluciones y, con
 * la lista completa, Σ `succeeded` == `amount_refunded`. Es una COMPROBACIÓN,
 * no un dato mostrado: el importe devuelto que se muestra es el de la API.
 */
export function refundsConsistent(
  payment: Pick<ReceiptPayment, 'currency' | 'amount_refunded'>,
  refunds: ReceiptRefund[],
  truncated: boolean
): boolean {
  if (refunds.some((r) => r.currency !== payment.currency)) return false;
  if (truncated) return true;
  const settled = refunds.filter((r) => r.status === 'succeeded').reduce((n, r) => n + r.amount, 0);
  return settled === payment.amount_refunded;
}

export function hasUncertainRefund(refunds: ReceiptRefund[]): boolean {
  return refunds.some((r) => r.status === 'indeterminate');
}

export function hasOpenRefund(refunds: ReceiptRefund[]): boolean {
  return refunds.some((r) => r.status === 'created' || r.status === 'processing');
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
  if (!Array.isArray(v.refunds) || typeof v.refunds_truncated !== 'boolean') return null;
  const refunds: ReceiptRefund[] = [];
  for (const r of v.refunds) {
    if (!isObj(r) || !str(r.id) || !UUID_RE.test(r.id) || !int(r.amount) || r.amount <= 0) {
      return null;
    }
    if (!str(r.currency) || !str(r.status) || !REFUND_STATUSES.has(r.status)) return null;
    if (!str(r.created_at)) return null;
    refunds.push({
      id: r.id,
      amount: r.amount,
      currency: r.currency,
      status: r.status as RefundStatus,
      created_at: r.created_at,
    });
  }
  // Un desglose junto a `refunds_truncated` sería parcial: se rechaza.
  if (v.refunds_truncated && refunds.length > 0) return null;
  if (!refundsConsistent(payment, refunds, v.refunds_truncated)) return null;
  return {
    payment,
    merchant_name: v.merchant_name,
    sale,
    refunds,
    refunds_truncated: v.refunds_truncated,
  };
}

/**
 * Referencia visible del justificante: los 8 últimos caracteres del id del
 * cobro, en mayúsculas. Nunca se muestra el identificador completo; basta para
 * localizar el cobro junto con importe y fecha.
 */
export function receiptRef(paymentId: string): string {
  return paymentId.replace(/-/g, '').slice(-8).toUpperCase();
}
