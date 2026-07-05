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
