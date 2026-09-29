/**
 * Contrato del POS web sandbox (sin dependencias de servidor: lo importan tanto
 * los route handlers BFF como el componente cliente).
 *
 * Recorrido — SOLO contratos existentes de la API:
 *  1. Crear la venta = `POST /v1/organizations/:orgId/payment_links` (plano de
 *     sesión, `reconciliation:manage`, idempotente, auditado).
 *  2. Abrir el cobro = BFF `POST /api/orgs/:orgId/pos/checkout`: verifica por
 *     sesión que el link es de la org y está activo, y abre una sesión con el
 *     `POST /v1/payment_links/:id/sessions` PÚBLICO (el mismo que usa `/l/:id`
 *     del checkout alojado).
 *  3. Estado = BFF `GET /api/orgs/:orgId/pos/sessions/:id`: lee por sesión
 *     `checkout_sessions/:id` y el `payment_intents/:id` que referencia.
 *
 * Lo que la API NO ofrece (documentado, no simulado): relación link→intent
 * (gap G3), cancelar un intent o deshabilitar un link por sesión.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Respuesta del BFF de apertura de checkout (201). */
export interface PosCheckoutOpened {
  checkout_session_id: string;
  /** URL alojada con el `client_secret` en el FRAGMENTO (nunca en query). */
  checkout_url: string;
}

/** Respuesta del BFF de estado (200). */
export interface PosSaleStatus {
  session: {
    id: string;
    status: string;
    expires_at: string;
    completed_at: string | null;
    created_at: string;
  };
  payment: {
    id: string;
    merchant_id: string;
    amount: number;
    currency: string;
    status: string;
    failure_code: string | null;
    amount_refunded: number;
  };
}

/** Códigos de error que emiten los BFF del POS (allowlist cerrada). */
export type PosErrorCode =
  | 'validation_error'
  | 'invalid_session'
  | 'insufficient_permissions'
  | 'not_found'
  | 'link_unavailable'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'checkout_open_uncertain'
  | 'origin_not_allowed';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strOrNull = (v: unknown): v is string | null => v === null || str(v);
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Valida y RECONSTRUYE (whitelist) la sesión de checkout del plano de sesión. */
export function pickSession(v: unknown): PosSaleStatus['session'] | null {
  if (!isObj(v)) return null;
  const { id, status, expires_at, completed_at, created_at, payment_intent_id } = v;
  if (!str(id) || !UUID_RE.test(id) || !str(status) || !str(expires_at) || !str(created_at)) {
    return null;
  }
  if (!strOrNull(completed_at) || !str(payment_intent_id) || !UUID_RE.test(payment_intent_id)) {
    return null;
  }
  return { id, status, expires_at, completed_at, created_at };
}

/** Valida y RECONSTRUYE (whitelist) el payment intent del plano de sesión. */
export function pickPayment(v: unknown): PosSaleStatus['payment'] | null {
  if (!isObj(v)) return null;
  const { id, merchant_id, amount, currency, status, failure_code, amount_refunded } = v;
  if (!str(id) || !UUID_RE.test(id) || !str(merchant_id) || !int(amount) || !str(currency)) {
    return null;
  }
  if (!str(status) || !strOrNull(failure_code) || !int(amount_refunded)) return null;
  return { id, merchant_id, amount, currency, status, failure_code, amount_refunded };
}

/**
 * Fase de la venta, DERIVADA de los estados persistidos (FSM de
 * `docs/architecture/payment-state-machines.md`). Jamás se asume éxito: solo
 * `succeeded` (o sus refunds posteriores) cuenta como cobrado.
 */
export type SalePhase =
  'awaiting_payment' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired' | 'unknown';

const PAID = new Set(['succeeded', 'partially_refunded', 'refunded']);
const IN_FLIGHT = new Set(['processing', 'requires_action', 'authorized', 'partially_captured']);
const WAITING = new Set(['created', 'requires_payment_method', 'requires_confirmation']);

export function classifySale(sessionStatus: string, intentStatus: string): SalePhase {
  if (PAID.has(intentStatus)) return 'succeeded';
  if (intentStatus === 'failed') return 'failed';
  if (intentStatus === 'canceled') return 'canceled';
  // Un intent en vuelo manda sobre la expiración de la sesión: el desenlace del
  // proveedor aún puede llegar (V4 §23 — nunca se asume).
  if (IN_FLIGHT.has(intentStatus)) return 'processing';
  if (sessionStatus === 'expired') return 'expired';
  if (WAITING.has(intentStatus)) return 'awaiting_payment';
  return 'unknown';
}

/** Fases en las que el POS deja de consultar el estado. */
export function isTerminalPhase(p: SalePhase): boolean {
  return p === 'succeeded' || p === 'failed' || p === 'canceled' || p === 'expired';
}
