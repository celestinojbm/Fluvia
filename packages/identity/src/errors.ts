export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class OrganizationSlugTakenError extends IdentityError {
  constructor(readonly slug: string) {
    super(`Organization slug already in use: "${slug}"`);
  }
}

export class EmailTakenError extends IdentityError {
  constructor() {
    // Sin incluir el email en el mensaje: los errores no deben facilitar
    // enumeracion ni terminar en logs con PII innecesaria.
    super('A user with this email already exists');
  }
}

export class MerchantNameTakenError extends IdentityError {
  constructor(readonly merchantName: string) {
    super(`A merchant with this name already exists in the organization`);
  }
}

export class OrganizationNotFoundError extends IdentityError {
  constructor() {
    super('Organization not found');
  }
}

export class MerchantNotFoundError extends IdentityError {
  constructor() {
    super('Merchant not found');
  }
}

export class CustomerNotFoundError extends IdentityError {
  constructor() {
    super('Customer not found');
  }
}

/** true si err es una violacion de unicidad de Postgres (23505), opcionalmente de un constraint concreto. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
