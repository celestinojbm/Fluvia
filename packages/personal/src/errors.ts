/**
 * Errores de dominio del programa de consumo. El `name` (clase) se traduce a un
 * código estable del catálogo de errores de la API; el mensaje interno solo va
 * a logs. Un recurso ajeno y uno inexistente son indistinguibles (NotFound).
 */
export class PersonalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProgramNotFoundError extends PersonalError {
  constructor() {
    super('Consumer program not found');
  }
}
export class ConsumerNotFoundError extends PersonalError {
  constructor() {
    super('Consumer not found');
  }
}
export class ConsumerNotActiveError extends PersonalError {
  constructor() {
    super('Consumer is not active');
  }
}
export class ResourceNotFoundError extends PersonalError {
  constructor(what: string) {
    super(`${what} not found`);
  }
}
export class CurrencyNotSupportedError extends PersonalError {
  constructor(currency: string) {
    super(`Currency not supported by the program: ${currency}`);
  }
}
export class InsufficientFundsError extends PersonalError {
  constructor() {
    super('Insufficient own funds');
  }
}
export class CreditLimitExceededError extends PersonalError {
  constructor() {
    super('Credit limit exceeded');
  }
}
export class CollateralCommittedError extends PersonalError {
  constructor() {
    super('Collateral backs current exposure and cannot be released');
  }
}
export class InsufficientCollateralError extends PersonalError {
  constructor() {
    super('Not enough blocked collateral');
  }
}
export class PolicyNotActiveError extends PersonalError {
  constructor() {
    super('No active credit policy');
  }
}
export class InvalidPolicyError extends PersonalError {
  constructor(detail: string) {
    super(`Invalid credit policy: ${detail}`);
  }
}
export class InvalidStateError extends PersonalError {
  constructor(
    readonly resource: string,
    readonly current: string
  ) {
    super(`${resource} cannot change from state ${current}`);
  }
}
export class FourEyesRequiredError extends PersonalError {
  constructor() {
    super('A different person must approve this action');
  }
}
export class CardNotUsableError extends PersonalError {
  constructor(readonly code: 'card_inactive' | 'card_blocked' | 'card_closed') {
    super(`Card not usable: ${code}`);
  }
}
export class PaymentCodeInvalidError extends PersonalError {
  constructor() {
    super('Payment code invalid, used or expired');
  }
}
export class AmountExceedsError extends PersonalError {
  constructor(what: string) {
    super(`Amount exceeds ${what}`);
  }
}
export class IdempotencyMismatchError extends PersonalError {
  constructor() {
    super('Same idempotency key used with different parameters');
  }
}
export class ConsumerEmailTakenError extends PersonalError {
  constructor() {
    super('Email already registered in this program');
  }
}
export class InvalidConsumerCredentialsError extends PersonalError {
  constructor() {
    super('Invalid credentials');
  }
}
export class ConsumerSessionInvalidError extends PersonalError {
  constructor() {
    super('Consumer session invalid or expired');
  }
}
export class ConsumerLockedError extends PersonalError {
  constructor() {
    super('Too many failed attempts; try later');
  }
}
export class ApplicationPendingError extends PersonalError {
  constructor() {
    super('There is already an application under review');
  }
}
