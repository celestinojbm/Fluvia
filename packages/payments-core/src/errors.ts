export class PaymentsCoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class PaymentIntentNotFoundError extends PaymentsCoreError {
  constructor() {
    super('Payment intent not found');
  }
}

export class InvalidStateTransitionError extends PaymentsCoreError {
  constructor(
    readonly from: string,
    readonly to: string
  ) {
    super(`Illegal payment state transition: ${from} -> ${to}`);
  }
}

export class RefundNotFoundError extends PaymentsCoreError {
  constructor() {
    super('Refund not found');
  }
}

export class CheckoutSessionNotFoundError extends PaymentsCoreError {
  constructor() {
    super('Checkout session not found');
  }
}

/** F3-05b: la sesión referencia un customer inexistente o de otro tenant. */
export class CheckoutSessionInvalidCustomerError extends PaymentsCoreError {
  constructor() {
    super('The referenced customer does not exist');
  }
}

/**
 * POS — una venta (payment link de cobro único) admite como máximo UN cobro:
 * ya hay un intent de la venta cobrando (processing, desenlace incierto
 * incluido) o cobrado. Guard de servicio bajo lock del link; el índice único
 * `payment_intents_single_charge_uq` (0046) es la garantía final del motor.
 */
export class SaleAlreadyChargedError extends PaymentsCoreError {
  constructor() {
    super('This sale already has a payment in progress or completed');
  }
}

/**
 * POS — una venta de cobro único no se libera sin un hecho verificado del
 * proveedor: cancelar localmente un intent que retiene la venta (p. ej.
 * `authorized`, fondos retenidos) o marcarlo `failed` sin rechazo resuelto.
 * Guard de servicio + trigger del motor (0047).
 */
export class SaleReleaseUnverifiedError extends PaymentsCoreError {
  constructor() {
    super('This sale cannot be released without a verified provider outcome');
  }
}

/** Rechazo del trigger `fluvia_single_charge_release_guard` (0047). */
export function isSaleReleaseUnverified(err: unknown): boolean {
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m.startsWith('FLUVIA_SALE_RELEASE_UNVERIFIED');
}

/** Violación del índice único del invariante (23505) ⇒ error de dominio. */
export function isSingleChargeViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e.constraint === 'payment_intents_single_charge_uq';
}

export class PaymentLinkNotFoundError extends PaymentsCoreError {
  constructor() {
    super('Payment link not found');
  }
}

/** F3-06: el link referencia un merchant inexistente o de otro tenant. */
export class PaymentLinkInvalidMerchantError extends PaymentsCoreError {
  constructor() {
    super('The referenced merchant does not exist');
  }
}

/** F3-08: Σ refunds activos+aplicados jamás supera lo capturado (V4 Nivel A). */
export class RefundAmountExceedsRemainingError extends PaymentsCoreError {
  constructor(
    readonly requested: string,
    readonly remaining: string
  ) {
    super(
      `Refund amount ${requested} exceeds the remaining refundable amount ${remaining} (captured minus applied and in-flight refunds)`
    );
  }
}

export class PayoutNotFoundError extends PaymentsCoreError {
  constructor() {
    super('Payout not found');
  }
}

/**
 * F4-07: un payout jamás puede emitir más que el disponible del comercio (menos
 * los payouts ya en vuelo). Pre-chequeo en fase 1; el guard AUD-P1-010 del motor
 * es la protección atómica final. V4 Nivel A (conservador: jamás sobre-paga).
 */
export class InsufficientPayoutBalanceError extends PaymentsCoreError {
  constructor(
    readonly requested: string,
    readonly available: string
  ) {
    super(
      `Payout amount ${requested} exceeds the merchant's available balance ${available} (available minus in-flight payouts)`
    );
  }
}

export class DisputeNotFoundError extends PaymentsCoreError {
  constructor() {
    super('Dispute not found');
  }
}

/**
 * F4-08: abrir una disputa aparta el monto disputado del disponible del comercio
 * (available -> dispute.reserve); en el sandbox v1 el guard de no-negatividad
 * AUD-P1-010 impide apartar más de lo disponible. (En real una disputa puede
 * dejar al comercio en negativo: modelo de saldo deudor, decisión mayor futura.)
 */
export class InsufficientDisputeBalanceError extends PaymentsCoreError {
  constructor(
    readonly amount: string,
    readonly available: string
  ) {
    super(
      `Dispute amount ${amount} exceeds the merchant's available balance ${available} (cannot set aside more than available in sandbox v1)`
    );
  }
}
