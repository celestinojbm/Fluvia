export {
  AuthService,
  type AuthServiceOptions,
  type RegisteredUser,
  type LoginResult,
  type SessionIdentity,
  type MembershipSummary,
} from './service.js';
export { hashPassword, verifyPassword } from './passwords.js';
export { generateToken, hashToken, type GeneratedToken } from './tokens.js';
export {
  RegisterSchema,
  LoginSchema,
  VerifyEmailSchema,
  PasswordSchema,
  type RegisterInput,
  type LoginInput,
  type VerifyEmailInput,
} from './schemas.js';
export {
  AuthError,
  EmailTakenError,
  InvalidCredentialsError,
  EmailNotVerifiedError,
  AccountLockedError,
  InvalidSessionError,
  InvalidVerificationTokenError,
} from './errors.js';
