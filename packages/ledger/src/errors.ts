export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidEntriesError extends LedgerError {}

/** suma(debitos) != suma(creditos) para alguna moneda del asiento (chequeo previo; la BD lo re-verifica al COMMIT). */
export class UnbalancedLedgerError extends LedgerError {
  constructor(readonly details: Record<string, string>) {
    super(
      `Unbalanced ledger transaction: ${Object.entries(details)
        .map(([ccy, net]) => `${ccy} net=${net}`)
        .join('; ')}`
    );
  }
}

export class AccountNotFoundError extends LedgerError {
  constructor(readonly missingAccountIds: string[]) {
    super(`Ledger account(s) not found or not visible for tenant: ${missingAccountIds.join(', ')}`);
  }
}

export class AccountCurrencyMismatchError extends LedgerError {
  constructor(
    readonly accountId: string,
    readonly accountCurrency: string,
    readonly entryCurrency: string
  ) {
    super(
      `Entry currency ${entryCurrency} does not match account ${accountId} currency ${accountCurrency}`
    );
  }
}

export class LedgerAccountExistsError extends LedgerError {
  constructor() {
    super('A ledger account with this name and currency already exists in the tenant');
  }
}

/** La proyeccion cambio fuera del camino sancionado: se reintenta la transaccion completa. */
export class OptimisticLockError extends LedgerError {
  constructor(readonly accountId: string) {
    super(`Optimistic lock failure updating balance projection for account ${accountId}`);
  }
}

/** Mismo idempotency key con un asiento DIFERENTE: jamas se ejecuta ni se replaya. */
export class IdempotencyConflictError extends LedgerError {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key reused with a different ledger transaction payload`);
  }
}

export class UnknownAccountCodeError extends LedgerError {
  constructor(readonly code: string) {
    super(`Account code not in the Chart of Accounts: "${code}"`);
  }
}

export class FeesExceedAmountError extends LedgerError {
  constructor() {
    super('Fees must leave a strictly positive net amount for the merchant');
  }
}

export class LedgerRetriesExhaustedError extends LedgerError {
  constructor(
    readonly attempts: number,
    readonly lastError: Error
  ) {
    super(`Ledger transaction failed after ${attempts} attempts: ${lastError.message}`);
  }
}
