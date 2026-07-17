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

/** F1-04b: codigo TOTP/backup incorrecto (cuenta hacia el lockout). */
export class InvalidMfaCodeError extends AuthError {
  constructor() {
    super('The MFA code is invalid');
  }
}

/** F1-04b: reto MFA inexistente, expirado o ya consumido. */
export class InvalidMfaChallengeError extends AuthError {
  constructor() {
    super('The MFA challenge is invalid, expired or already used');
  }
}

export class MfaAlreadyEnabledError extends AuthError {
  constructor() {
    super('MFA is already enabled for this account');
  }
}

export class MfaNotEnabledError extends AuthError {
  constructor() {
    super('MFA is not enabled (or not pending activation) for this account');
  }
}

/** F1-04b: accion sensible exige verificacion MFA reciente en la sesion. */
export class StepUpRequiredError extends AuthError {
  constructor() {
    super('This action requires recent MFA verification (step-up)');
  }
}

/**
 * F6.5C1 (B6): el registro sandbox atomico esta deshabilitado en este proceso.
 * Fail-closed: la capacidad SOLO existe cuando el API la activa explicitamente
 * (entornos local/test); en cualquier otro caso el metodo rechaza sin tocar la
 * base de datos y el API lo mapea a 404 (jamas degrada a `register` normal).
 */
export class SandboxRegistrationDisabledError extends AuthError {
  constructor() {
    super('Sandbox registration is not available in this environment');
  }
}

/** F1-04b: limite de tasa alcanzado (por IP/email/ruta). */
export class RateLimitedError extends AuthError {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many requests; retry later');
  }
}
