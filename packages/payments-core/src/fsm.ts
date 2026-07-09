/**
 * FSMs declarativas de pagos (F3-01, diseño en docs/design/f3-01-payment-intents.md).
 *
 * ESTOS MAPAS SON LA ÚNICA FUENTE DE VERDAD. De aquí se derivan:
 *  - el seed de las tablas *_transitions de la migración 0017
 *    (scripts/gen-fsm-seed.ts — regenerar y crear migración nueva si cambian);
 *  - el mermaid de payment-state-machines.md (§1/§2/§3);
 *  - la validación rápida del servicio de transiciones.
 * El meta-test fsm-meta.test.ts exige igualdad EXACTA doc ↔ TS ↔ DDL, y que el
 * MOTOR rechace toda transición fuera del mapa incluso con SQL de superusuario.
 */

export const INTENT_STATUSES = [
  'created',
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'authorized',
  'partially_captured',
  'succeeded',
  'failed',
  'canceled',
  'partially_refunded',
  'refunded',
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export const INTENT_TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  created: ['requires_payment_method', 'canceled'],
  requires_payment_method: ['requires_confirmation', 'canceled'],
  requires_confirmation: ['processing', 'canceled'],
  requires_action: ['processing', 'failed'],
  processing: ['requires_action', 'authorized', 'succeeded', 'failed'],
  authorized: ['partially_captured', 'succeeded', 'canceled'],
  partially_captured: ['succeeded'],
  succeeded: ['partially_refunded', 'refunded'],
  // El self-loop registra refunds parciales adicionales sin cambiar de estado.
  partially_refunded: ['refunded', 'partially_refunded'],
  failed: [],
  canceled: [],
  refunded: [],
};

export const ATTEMPT_STATUSES = [
  'created',
  'submitting',
  'submitted',
  'requires_action',
  'indeterminate',
  'succeeded',
  'failed',
  'expired',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/**
 * V4 §23: `indeterminate` SOLO se resuelve por consulta al proveedor, webhook
 * o conciliación (indeterminate -> succeeded|failed); jamás por asunción.
 */
export const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  created: ['submitting', 'expired'],
  submitting: ['submitted', 'requires_action', 'succeeded', 'failed', 'indeterminate'],
  submitted: ['succeeded', 'failed', 'indeterminate', 'expired'],
  requires_action: ['submitted', 'expired'],
  indeterminate: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  expired: [],
};

export const REFUND_STATUSES = [
  'created',
  'processing',
  'indeterminate',
  'succeeded',
  'failed',
  'canceled',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * `canceled` solo antes de enviarse al proveedor (si este lo permite).
 * `indeterminate` (V4 §23, igual que attempts): desenlace DESCONOCIDO tras
 * llamar al proveedor (throw/timeout o aceptación asíncrona `pending`); la
 * reserva contable queda RETENIDA y SOLO una fuente verificada — webhook,
 * consulta o conciliación — puede cerrarlo (jamás por asunción).
 */
export const REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  created: ['processing', 'canceled'],
  processing: ['succeeded', 'failed', 'indeterminate'],
  indeterminate: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  canceled: [],
};

export const PAYOUT_STATUSES = [
  'requested',
  'in_transit',
  'paid',
  'failed',
  'indeterminate',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * Payout (F4-07 — recurso gestionado sobre las primitivas contables de F4-05b).
 * `requested` nace la solicitud; al EMITIR el disponible del comercio pasa a
 * `in_transit` (`emitPayout`: available -> payout.in_transit, guard AUD-P1-010).
 * `requested -> failed` cubre la carrera donde el disponible se drenó entre la
 * validación y el emit (nunca se contactó al banco: desenlace CONOCIDO). Desde
 * `in_transit`: `paid` (`settlePayout`: in_transit -> platform.cash, el banco
 * confirma), `failed` (`failPayout`: in_transit -> available, el banco rebota,
 * los fondos vuelven íntegros) o `indeterminate` (V4 §23: desenlace DESCONOCIDO
 * tras llamar al banco — throw/timeout o aceptación asíncrona; los fondos quedan
 * RETENIDOS en tránsito y SOLO una fuente verificada lo cierra). Terminales:
 * `paid`, `failed`.
 */
export const PAYOUT_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  requested: ['in_transit', 'failed'],
  in_transit: ['paid', 'failed', 'indeterminate'],
  indeterminate: ['paid', 'failed'],
  paid: [],
  failed: [],
};

export const DISPUTE_STATUSES = ['open', 'under_review', 'won', 'lost'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/**
 * Dispute / chargeback (F4-08 — recurso gestionado, money clawed back). El banco
 * abre la disputa: al ABRIR se APARTA el monto disputado del disponible del
 * comercio a `dispute.reserve` (`openDispute`: available -> dispute.reserve,
 * guard AUD-P1-010) — no se puede pagar ni disputar dos veces el mismo dinero.
 * `under_review` cubre la fase de evidencia (el comercio respondió). Desenlace:
 * `won` (`winDispute`: dispute.reserve -> available, el comercio recupera lo
 * apartado) o `lost` (`loseDispute`: dispute.reserve -> provider.clearing, el
 * dinero se va de vuelta vía el proveedor, como un refund forzado). El desenlace
 * llega SIEMPRE de una fuente verificada (el banco vía webhook — slice
 * posterior), jamás por asunción; no hay `indeterminate` porque la disputa no
 * hace una llamada saliente cuyo resultado se desconozca (nos lo empujan).
 * Terminales: `won`, `lost`.
 */
export const DISPUTE_TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> = {
  open: ['under_review', 'won', 'lost'],
  under_review: ['won', 'lost'],
  won: [],
  lost: [],
};

export const CHECKOUT_SESSION_STATUSES = ['open', 'completed', 'expired'] as const;
export type CheckoutSessionStatus = (typeof CHECKOUT_SESSION_STATUSES)[number];

/**
 * Sesión de checkout (F3-05b). `open` mientras el comprador puede pagar;
 * `completed` cuando el payment intent asociado tiene éxito; `expired` si
 * vence antes de completarse. El disparo de completed/expired + sus eventos
 * `checkout_session.*` llegan con el flujo alojado (F3-05c).
 */
export const CHECKOUT_SESSION_TRANSITIONS: Record<
  CheckoutSessionStatus,
  readonly CheckoutSessionStatus[]
> = {
  open: ['completed', 'expired'],
  completed: [],
  expired: [],
};

export function canTransition<S extends string>(
  map: Record<S, readonly S[]>,
  from: S,
  to: S
): boolean {
  return map[from]?.includes(to) ?? false;
}

/** Estados sin salidas: una vez ahí, la fila jamás vuelve a cambiar de estado. */
export function terminalStates<S extends string>(map: Record<S, readonly S[]>): S[] {
  return (Object.keys(map) as S[]).filter((s) => map[s].length === 0);
}

/** Pares (from, to) planos, ordenados — forma canónica para seed y meta-tests. */
export function transitionPairs<S extends string>(map: Record<S, readonly S[]>): Array<[S, S]> {
  return (Object.keys(map) as S[])
    .flatMap((from) => map[from].map((to): [S, S] => [from, to]))
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}
