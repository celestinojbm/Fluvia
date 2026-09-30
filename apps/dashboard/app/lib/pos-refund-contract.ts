import { UUID_RE } from './pos-contract';

/**
 * Devoluciones de una venta del POS — contrato PURO (lo importan el BFF de
 * lectura y el componente cliente). SOLO contratos existentes de la API:
 *
 *  - Crear = `POST /v1/organizations/:orgId/refunds` (plano de sesión,
 *    `reconciliation:manage`, `Idempotency-Key` obligatoria, auditado). Fase 1
 *    dentro de la tx de la key (responde `created`); fase 2 (proveedor) fuera
 *    de toda tx — el desenlace se LEE después, nunca se asume.
 *  - Leer = `GET /v1/organizations/:orgId/refunds?payment_intent_id=&limit=100`
 *    (`payments:read`, todo rol).
 *
 * Una devolución NO libera la venta: un intent `partially_refunded`/`refunded`
 * sigue reteniendo el cobro único (0046), así que devolver jamás habilita un
 * segundo cobro de la misma venta.
 */

/** Tope de `limit` del listado de refunds (`RefundsQuery`). */
export const REFUNDS_WINDOW = 100;

export type RefundStatus =
  'created' | 'processing' | 'indeterminate' | 'succeeded' | 'failed' | 'canceled';

const STATUSES = new Set<string>([
  'created',
  'processing',
  'indeterminate',
  'succeeded',
  'failed',
  'canceled',
]);

export interface PosRefund {
  id: string;
  payment_intent_id: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  reason: string | null;
  failure_code: string | null;
  created_at: string;
}

/** Respuesta del BFF de lectura (200). */
export interface PosRefundList {
  refunds: PosRefund[];
  /** `== REFUNDS_WINDOW` ⇒ puede haber más: el cupo no es calculable. */
  truncated: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strOrNull = (v: unknown): v is string | null => v === null || v === undefined || str(v);
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Valida y RECONSTRUYE (whitelist) un refund del plano de sesión. */
export function pickRefund(v: unknown): PosRefund | null {
  if (!isObj(v)) return null;
  const { id, payment_intent_id, amount, currency, status, reason, failure_code, created_at } = v;
  if (!str(id) || !UUID_RE.test(id) || !str(payment_intent_id) || !UUID_RE.test(payment_intent_id))
    return null;
  if (!int(amount) || amount <= 0 || !str(currency) || !str(status) || !STATUSES.has(status))
    return null;
  if (!strOrNull(reason) || !strOrNull(failure_code) || !str(created_at)) return null;
  return {
    id,
    payment_intent_id,
    amount,
    currency,
    status: status as RefundStatus,
    reason: reason ?? null,
    failure_code: failure_code ?? null,
    created_at,
  };
}

/**
 * Lista del BFF (o del API, `{ data }`) → refunds del intent pedido. Un refund
 * malformado o de OTRO intent invalida la lectura entera (null): calcular el
 * cupo con una lista incompleta podría ofrecer devolver de más.
 */
export function pickRefundList(v: unknown, paymentIntentId: string): PosRefundList | null {
  if (!isObj(v)) return null;
  const raw = Array.isArray(v.data) ? v.data : Array.isArray(v.refunds) ? v.refunds : null;
  if (!raw) return null;
  const refunds: PosRefund[] = [];
  for (const r of raw) {
    const p = pickRefund(r);
    if (!p || p.payment_intent_id !== paymentIntentId) return null;
    refunds.push(p);
  }
  refunds.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const truncated = typeof v.truncated === 'boolean' ? v.truncated : raw.length >= REFUNDS_WINDOW;
  return { refunds, truncated: truncated || raw.length >= REFUNDS_WINDOW };
}

export const REFUND_TERMINAL = new Set<RefundStatus>(['succeeded', 'failed', 'canceled']);
/** Reservan cupo en el servicio (`created`/`processing`) o su desenlace no se conoce. */
const REFUND_OPEN = new Set<RefundStatus>(['created', 'processing', 'indeterminate']);

export interface RefundSummary {
  /** Capturado del cobro (unidades menores). */
  captured: number;
  /** Devuelto y liquidado (`amount_refunded` del intent). */
  refunded: number;
  /** En curso o con desenlace sin verificar. */
  pending: number;
  /** Cupo que el POS ofrece devolver. */
  remaining: number;
  /** Hay una devolución sin desenlace (created/processing/indeterminate). */
  open: boolean;
  /** Hay una devolución `indeterminate` (el proveedor no confirmó). */
  uncertain: boolean;
}

/**
 * Cupo devolvible, CONSERVADOR: capturado − devuelto − todo lo que no terminó
 * (incluido `indeterminate`, que el servicio no descuenta del remanente: el
 * POS no ofrece devolver sobre una devolución cuyo desenlace no conoce).
 */
export function summarizeRefunds(
  payment: { amount_captured: number; amount_refunded: number },
  refunds: PosRefund[]
): RefundSummary {
  let pending = 0;
  let open = false;
  let uncertain = false;
  for (const r of refunds) {
    if (REFUND_OPEN.has(r.status)) {
      pending += r.amount;
      open = true;
      if (r.status === 'indeterminate') uncertain = true;
    }
  }
  const remaining = Math.max(0, payment.amount_captured - payment.amount_refunded - pending);
  return {
    captured: payment.amount_captured,
    refunded: payment.amount_refunded,
    pending,
    remaining,
    open,
    uncertain,
  };
}

/** Estados del intent sobre los que el API acepta crear un refund. */
export function isRefundableStatus(intentStatus: string): boolean {
  return intentStatus === 'succeeded' || intentStatus === 'partially_refunded';
}
