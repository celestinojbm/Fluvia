export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EmailTakenError extends AuthError {
  constructor() {
    super('A user with this email already exists');
  }
}

/**
 * Uniforme para email inexistente Y password incorrecto:
 * los errores de login no deben permitir enumeracion de cuentas.
 */
export class InvalidCredentialsError extends AuthError {
  constructor() {
    super('Invalid email or password');
  }
}

export class EmailNotVerifiedError extends AuthError {
  constructor() {
    super('Email address has not been verified');
  }
}

export class AccountLockedError extends AuthError {
  constructor() {
    super('Account temporarily locked due to repeated failed login attempts');
  }
}

export class InvalidSessionError extends AuthError {
  constructor() {
    super('Session is invalid, expired or revoked');
  }
}

export class InvalidVerificationTokenError extends AuthError {
  constructor() {
    super('Verification token is invalid, expired or already used');
  }
}
