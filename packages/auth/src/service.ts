import type { Pool, PoolClient } from '@fluvia/db';
import {
  AccountLockedError,
  EmailNotVerifiedError,
  EmailTakenError,
  InvalidCredentialsError,
  InvalidSessionError,
  InvalidVerificationTokenError,
} from './errors.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './passwords.js';
import { generateToken, hashToken } from './tokens.js';
import {
  LoginSchema,
  RegisterSchema,
  VerifyEmailSchema,
  type LoginInput,
  type RegisterInput,
  type VerifyEmailInput,
} from './schemas.js';

export interface AuthServiceOptions {
  /** TTL absoluto de sesion. Nivel C, configurable. */
  sessionTtlMs?: number;
  verificationTtlMs?: number;
  maxFailedAttempts?: number;
  lockoutMs?: number;
}

export interface RegisteredUser {
  userId: string;
  /**
   * Token de verificacion en claro. El LLAMADOR decide su exposicion:
   * en local/test se retorna por API; en sandbox+ se enviara por email
   * (pendiente de canal de correo, ver STATE).
   */
  verificationToken: string;
}

export interface LoginResult {
  userId: string;
  sessionToken: string;
  expiresAt: Date;
}

export interface SessionIdentity {
  sessionId: string;
  userId: string;
}

export interface MembershipSummary {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: string;
}

interface LoginUserRow {
  id: string;
  password_hash: string | null;
  email_verified_at: Date | null;
  failed_login_attempts: number;
  locked_until: Date | null;
}

/**
 * Servicio de autenticacion (F1-04a). Corre EXCLUSIVAMENTE con el pool del
 * rol fluvia_auth: unico rol con acceso a users/sessions/tokens.
 *
 * Garantias:
 *  - Ningun secreto se persiste en claro (passwords: scrypt; tokens: sha256).
 *  - Login uniforme anti-enumeracion (mismo error y costo con email
 *    inexistente que con password incorrecto).
 *  - Lockout por intentos fallidos con ventana configurable.
 *  - Sesiones revocables individual y globalmente.
 */
export class AuthService {
  private readonly sessionTtlMs: number;
  private readonly verificationTtlMs: number;
  private readonly maxFailedAttempts: number;
  private readonly lockoutMs: number;

  constructor(
    private readonly authPool: Pool,
    options: AuthServiceOptions = {}
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 24 * 60 * 60 * 1000;
    this.verificationTtlMs = options.verificationTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxFailedAttempts = options.maxFailedAttempts ?? 5;
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
  }

  private async withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.authPool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async register(rawInput: RegisterInput): Promise<RegisteredUser> {
    const input = RegisterSchema.parse(rawInput);
    const email = input.email.toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const token = generateToken('fluvia_verify');

    return this.withTx(async (c) => {
      let userId: string;
      try {
        const res = await c.query<{ id: string }>(
          'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
          [email, passwordHash]
        );
        userId = res.rows[0]!.id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new EmailTakenError();
        throw err;
      }
      await c.query(
        `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))`,
        [userId, token.hash, this.verificationTtlMs / 1000]
      );
      return { userId, verificationToken: token.plaintext };
    });
  }

  async verifyEmail(rawInput: VerifyEmailInput): Promise<{ userId: string }> {
    const input = VerifyEmailSchema.parse(rawInput);
    return this.withTx(async (c) => {
      const consumed = await c.query<{ user_id: string }>(
        `UPDATE email_verification_tokens
         SET consumed_at = now()
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING user_id`,
        [hashToken(input.token)]
      );
      const row = consumed.rows[0];
      if (!row) throw new InvalidVerificationTokenError();
      await c.query(
        'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1',
        [row.user_id]
      );
      return { userId: row.user_id };
    });
  }

  async login(
    rawInput: LoginInput,
    meta: { ip?: string; userAgent?: string } = {}
  ): Promise<LoginResult> {
    const input = LoginSchema.parse(rawInput);
    const email = input.email.toLowerCase();

    // Sin withTx: el contador de intentos fallidos debe COMMITearse ANTES de
    // lanzar el error — dentro de una transaccion unica, el throw haria
    // rollback del contador y el lockout jamas se activaria (bug detectado
    // por el test de lockout).
    const client = await this.authPool.connect();
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      const res = await client.query<LoginUserRow>(
        `SELECT id, password_hash, email_verified_at, failed_login_attempts, locked_until
         FROM users
         WHERE lower(email) = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [email]
      );
      const user = res.rows[0];

      if (!user || user.password_hash === null) {
        // Igualar costo temporal: verificar contra hash sacrificial.
        await verifyPassword(input.password, await dummyPasswordHash());
        throw new InvalidCredentialsError();
      }

      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        throw new AccountLockedError();
      }

      const valid = await verifyPassword(input.password, user.password_hash);
      if (!valid) {
        const attempts = user.failed_login_attempts + 1;
        const lock = attempts >= this.maxFailedAttempts;
        await client.query(
          `UPDATE users
           SET failed_login_attempts = $2,
               locked_until = CASE WHEN $3 THEN now() + make_interval(secs => $4) ELSE locked_until END
           WHERE id = $1`,
          [user.id, lock ? 0 : attempts, lock, this.lockoutMs / 1000]
        );
        await client.query('COMMIT');
        inTx = false;
        throw lock ? new AccountLockedError() : new InvalidCredentialsError();
      }

      if (!user.email_verified_at) {
        throw new EmailNotVerifiedError();
      }

      await client.query(
        'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
        [user.id]
      );

      const session = generateToken('fluvia_sess');
      const expiresAt = new Date(Date.now() + this.sessionTtlMs);
      await client.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, session.hash, expiresAt, meta.ip ?? null, meta.userAgent ?? null]
      );
      await client.query('COMMIT');
      inTx = false;
      return { userId: user.id, sessionToken: session.plaintext, expiresAt };
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async authenticateSession(sessionToken: string): Promise<SessionIdentity> {
    const res = await this.authPool.query<{ id: string; user_id: string }>(
      `UPDATE sessions
       SET last_seen_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING id, user_id`,
      [hashToken(sessionToken)]
    );
    const row = res.rows[0];
    if (!row) throw new InvalidSessionError();
    return { sessionId: row.id, userId: row.user_id };
  }

  async logout(sessionToken: string): Promise<void> {
    await this.authPool.query(
      'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(sessionToken)]
    );
  }

  async revokeAllSessions(userId: string): Promise<number> {
    const res = await this.authPool.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
    return res.rowCount ?? 0;
  }

  async listMemberships(userId: string): Promise<MembershipSummary[]> {
    const res = await this.authPool.query<{
      organization_id: string;
      organization_name: string;
      organization_slug: string;
      role: string;
    }>('SELECT * FROM auth_list_memberships($1)', [userId]);
    return res.rows.map((r) => ({
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      organizationSlug: r.organization_slug,
      role: r.role,
    }));
  }
}
