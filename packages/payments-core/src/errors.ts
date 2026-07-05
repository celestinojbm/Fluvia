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
