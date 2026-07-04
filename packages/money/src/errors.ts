export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnknownCurrencyError extends MoneyError {
  constructor(readonly currency: string) {
    super(`Unknown or unsupported ISO-4217 currency: "${currency}"`);
  }
}

export class CurrencyMismatchError extends MoneyError {
  constructor(readonly left: string, readonly right: string) {
    super(`Currency mismatch: cannot operate on ${left} and ${right}`);
  }
}

export class InvalidAmountError extends MoneyError {
  constructor(detail: string) {
    super(`Invalid monetary amount: ${detail}`);
  }
}

export class PrecisionError extends MoneyError {
  constructor(readonly currency: string, readonly maxDecimals: number, readonly received: string) {
    super(
      `Currency ${currency} supports at most ${maxDecimals} decimal places, received "${received}"`
    );
  }
}
