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
