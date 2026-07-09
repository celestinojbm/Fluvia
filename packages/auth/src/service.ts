import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from '@fluvia/db';
import { insertAuditEvent } from '@fluvia/audit';
import {
  AccountLockedError,
  EmailNotVerifiedError,
  EmailTakenError,
  InvalidCredentialsError,
  InvalidMfaChallengeError,
  InvalidMfaCodeError,
  InvalidSessionError,
  InvalidVerificationTokenError,
  MfaAlreadyEnabledError,
  MfaNotEnabledError,
  StepUpRequiredError,
} from './errors.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './passwords.js';
import { generateToken, hashToken } from './tokens.js';
import {
  DEV_MFA_SECRET_KEY_HEX,
  decryptMfaSecretWithKeyring,
  encryptSecret,
  generateTotpSecret,
  otpauthUri,
  parseMfaKey,
  verifyTotp,
  type MfaEncKeyring,
} from './totp.js';
import {
  LoginSchema,
  MfaVerifySchema,
  RegisterSchema,
  VerifyEmailSchema,
  type LoginInput,
  type MfaVerifyInput,
  type RegisterInput,
  type VerifyEmailInput,
} from './schemas.js';

export interface AuthServiceOptions {
  /** TTL absoluto de sesion. Nivel C, configurable. */
  sessionTtlMs?: number;
  /**
   * F6 (threat model §5): idle-timeout de sesion. Una sesion sin uso durante
   * mas de esta ventana es invalida ANTES de su expiry absoluto (limita el
   * robo de un token de una sesion olvidada/abandonada). Default 30 min.
   */
  sessionIdleTimeoutMs?: number;
  verificationTtlMs?: number;
  maxFailedAttempts?: number;
  lockoutMs?: number;
  /**
   * Clave AES-256-GCM (64 hex) para el secreto TOTP en reposo. El default es
   * SOLO para local/test (regimen R-12); @fluvia/config la exige explicita
   * fuera de local (MFA_SECRET_KEY, anti-mezcla).
   */
  mfaEncryptionKeyHex?: string;
  /**
   * Claves RETIRADAS (64 hex c/u) que SOLO descifran, durante la ventana de
   * rotación de `MFA_SECRET_KEY` (F6, ADR-0012). Un secreto TOTP cifrado con
   * cualquiera de ellas se sigue descifrando (el tag AES-GCM disambigua) hasta
   * que `reencryptMfaSecrets` lo migra a la actual. Vacío = sin rotación.
   */
  retiredMfaKeyHexes?: string[];
  /** TTL del reto MFA post-password (default 5 min). */
  mfaChallengeTtlMs?: number;
  /** Frescura maxima de la verificacion MFA para step-up (default 15 min). */
  stepUpMaxAgeMs?: number;
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

/**
 * F1-04b: con MFA habilitado, el password correcto NO emite sesion — emite un
 * reto de corta vida que se canjea en verifyMfaChallenge().
 */
export type LoginOutcome =
  | ({ mfaRequired: false } & LoginResult)
  | { mfaRequired: true; userId: string; challengeToken: string; challengeExpiresAt: Date };

export interface SessionIdentity {
  sessionId: string;
  userId: string;
  /** true si el usuario tiene MFA habilitado (base del step-up). */
  mfaEnabled: boolean;
  /** Ultima verificacion MFA de ESTA sesion (null si nunca). */
  mfaVerifiedAt: Date | null;
  /** Ultima re-autenticacion por PASSWORD de esta sesion (step-up TM-02,
   *  usuarios sin MFA). Con MFA habilitado NO sustituye a mfaVerifiedAt. */
  passwordVerifiedAt: Date | null;
}

export interface MfaSetup {
  /** Secreto base32 — se muestra UNA vez para cargarlo en el authenticator. */
  secret: string;
  otpauthUri: string;
}

export interface MfaStatus {
  enabled: boolean;
  pendingSetup: boolean;
  backupCodesRemaining: number;
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
  totp_enabled_at: Date | null;
}

interface MfaUserRow {
  id: string;
  email: string;
  failed_login_attempts: number;
  locked_until: Date | null;
  totp_secret_enc: string | null;
  totp_pending_secret_enc: string | null;
  totp_enabled_at: Date | null;
  totp_last_used_step: string;
}

/** Codigos de respaldo: 10 hex agrupados xxxxx-xxxxx; se persiste solo sha256. */
function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const hex = randomBytes(5).toString('hex');
    return `${hex.slice(0, 5)}-${hex.slice(5)}`;
  });
}

function normalizeBackupCode(code: string): string {
  return code.toLowerCase().replace(/[^0-9a-f]/gu, '');
}

function hashBackupCode(code: string): string {
  return createHash('sha256').update(normalizeBackupCode(code)).digest('hex');
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
  private readonly sessionIdleTimeoutMs: number;
  private readonly verificationTtlMs: number;
  private readonly maxFailedAttempts: number;
  private readonly lockoutMs: number;
  /** Clave ACTUAL (cifra los secretos TOTP nuevos). */
  private readonly mfaKey: Buffer;
  /** Keyring de DESCIFRADO (actual + retiradas) — rotación sin downtime. */
  private readonly mfaKeyring: MfaEncKeyring;
  private readonly mfaChallengeTtlMs: number;
  /** Publica: el guard de step-up (apps/api) la usa como unica fuente. */
  readonly stepUpMaxAgeMs: number;

  constructor(
    private readonly authPool: Pool,
    options: AuthServiceOptions = {}
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 24 * 60 * 60 * 1000;
    this.sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 30 * 60 * 1000;
    this.verificationTtlMs = options.verificationTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxFailedAttempts = options.maxFailedAttempts ?? 5;
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
    const mfaCurrentKeyHex = options.mfaEncryptionKeyHex ?? DEV_MFA_SECRET_KEY_HEX;
    this.mfaKey = parseMfaKey(mfaCurrentKeyHex); // cifra con la ACTUAL
    this.mfaKeyring = { current: mfaCurrentKeyHex, retired: options.retiredMfaKeyHexes ?? [] };
    this.mfaChallengeTtlMs = options.mfaChallengeTtlMs ?? 5 * 60 * 1000;
    this.stepUpMaxAgeMs = options.stepUpMaxAgeMs ?? 15 * 60 * 1000;
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
      await insertAuditEvent(c, {
        action: 'user.registered',
        context: { actorType: 'user', actorId: userId, authMethod: 'none' },
        resourceType: 'user',
        resourceId: userId,
      });
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
      await insertAuditEvent(c, {
        action: 'user.email_verified',
        context: { actorType: 'user', actorId: row.user_id, authMethod: 'none' },
        resourceType: 'user',
        resourceId: row.user_id,
      });
      return { userId: row.user_id };
    });
  }

  async login(
    rawInput: LoginInput,
    meta: { ip?: string; userAgent?: string; requestId?: string } = {}
  ): Promise<LoginOutcome> {
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
        `SELECT id, password_hash, email_verified_at, failed_login_attempts, locked_until,
                totp_enabled_at
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
        await insertAuditEvent(client, {
          action: lock ? 'auth.account_locked' : 'auth.login_failed',
          context: { actorType: 'user', actorId: user.id, authMethod: 'none', ...meta },
          resourceType: 'user',
          resourceId: user.id,
          result: 'failure',
          riskLevel: lock ? 'high' : 'medium',
          reason: lock ? 'max_failed_attempts_reached' : 'invalid_password',
        });
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

      // F1-04b: con MFA habilitado el password NO basta — se emite un reto
      // de corta vida y la sesion solo nace en verifyMfaChallenge().
      if (user.totp_enabled_at) {
        const challenge = generateToken('fluvia_mfa');
        const challengeExpiresAt = new Date(Date.now() + this.mfaChallengeTtlMs);
        await client.query(
          `INSERT INTO mfa_challenges (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
          [user.id, challenge.hash, challengeExpiresAt]
        );
        await insertAuditEvent(client, {
          action: 'auth.mfa_challenge',
          context: { actorType: 'user', actorId: user.id, authMethod: 'none', ...meta },
          resourceType: 'user',
          resourceId: user.id,
        });
        await client.query('COMMIT');
        inTx = false;
        return {
          mfaRequired: true,
          userId: user.id,
          challengeToken: challenge.plaintext,
          challengeExpiresAt,
        };
      }

      const session = await this.createSession(client, user.id, meta, false);
      await insertAuditEvent(client, {
        action: 'auth.login_succeeded',
        context: { actorType: 'user', actorId: user.id, authMethod: 'session', ...meta },
        resourceType: 'user',
        resourceId: user.id,
      });
      await client.query('COMMIT');
      inTx = false;
      return { mfaRequired: false, ...session };
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async createSession(
    client: PoolClient,
    userId: string,
    meta: { ip?: string; userAgent?: string },
    mfaVerified: boolean
  ): Promise<LoginResult> {
    const session = generateToken('fluvia_sess');
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);
    await client.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent, mfa_verified_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() ELSE NULL END)`,
      [userId, session.hash, expiresAt, meta.ip ?? null, meta.userAgent ?? null, mfaVerified]
    );
    return { userId, sessionToken: session.plaintext, expiresAt };
  }

  async authenticateSession(sessionToken: string): Promise<SessionIdentity> {
    const res = await this.authPool.query<{
      id: string;
      user_id: string;
      mfa_verified_at: Date | null;
      password_verified_at: Date | null;
    }>(
      // El WHERE evalua last_seen_at PREVIO al SET (semantica de UPDATE): una
      // sesion ociosa mas alla del idle-timeout no valida (ademas del expiry
      // absoluto). Una sesion fresca tiene last_seen_at = now() (DEFAULT), asi
      // que pasa. El SET refresca el reloj de inactividad en cada uso.
      `UPDATE sessions
       SET last_seen_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
         AND last_seen_at > now() - make_interval(secs => $2)
       RETURNING id, user_id, mfa_verified_at, password_verified_at`,
      [hashToken(sessionToken), this.sessionIdleTimeoutMs / 1000]
    );
    const row = res.rows[0];
    if (!row) throw new InvalidSessionError();
    const user = await this.authPool.query<{ totp_enabled_at: Date | null }>(
      `SELECT totp_enabled_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [row.user_id]
    );
    if (!user.rows[0]) throw new InvalidSessionError();
    return {
      sessionId: row.id,
      userId: row.user_id,
      mfaEnabled: user.rows[0].totp_enabled_at !== null,
      mfaVerifiedAt: row.mfa_verified_at,
      passwordVerifiedAt: row.password_verified_at,
    };
  }

  async logout(
    sessionToken: string,
    meta: { ip?: string; userAgent?: string; requestId?: string } = {}
  ): Promise<void> {
    await this.withTx(async (c) => {
      const res = await c.query<{ id: string; user_id: string }>(
        `UPDATE sessions SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL
         RETURNING id, user_id`,
        [hashToken(sessionToken)]
      );
      const row = res.rows[0];
      if (row) {
        await insertAuditEvent(c, {
          action: 'auth.logout',
          context: { actorType: 'user', actorId: row.user_id, authMethod: 'session', ...meta },
          resourceType: 'session',
          resourceId: row.id,
        });
      }
    });
  }

  async revokeAllSessions(
    userId: string,
    meta: { ip?: string; userAgent?: string; requestId?: string } = {}
  ): Promise<number> {
    return this.withTx(async (c) => {
      const res = await c.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId]
      );
      const count = res.rowCount ?? 0;
      if (count > 0) {
        await insertAuditEvent(c, {
          action: 'auth.sessions_revoked',
          context: { actorType: 'user', actorId: userId, authMethod: 'session', ...meta },
          resourceType: 'user',
          resourceId: userId,
          riskLevel: 'medium',
          reason: `revoked_${count}_sessions`,
        });
      }
      return count;
    });
  }

  // --------------------------------------------------------------------------
  // F1-04b — MFA TOTP + codigos de respaldo + step-up (AUD-P1-006, PEND-005)
  // --------------------------------------------------------------------------

  private async lockUserForMfa(client: PoolClient, userId: string): Promise<MfaUserRow> {
    const res = await client.query<MfaUserRow>(
      `SELECT id, email, failed_login_attempts, locked_until,
              totp_secret_enc, totp_pending_secret_enc, totp_enabled_at,
              totp_last_used_step::text
       FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [userId]
    );
    const user = res.rows[0];
    if (!user) throw new InvalidSessionError();
    return user;
  }

  /**
   * Verifica un codigo TOTP contra el secreto ACTIVO con anti-replay: el step
   * que produjo el match debe ser mayor que el ultimo usado (un codigo jamas
   * vale dos veces). Devuelve el step o null.
   */
  private matchActiveTotp(user: MfaUserRow, code: string): bigint | null {
    if (!user.totp_secret_enc) return null;
    const secret = decryptMfaSecretWithKeyring(this.mfaKeyring, user.totp_secret_enc).plaintext;
    const step = verifyTotp(secret, code);
    if (step === null || step <= BigInt(user.totp_last_used_step)) return null;
    return step;
  }

  /**
   * Fallo de codigo MFA: cuenta al MISMO lockout que el password. Escribe el
   * contador y el audit; el CALLER commitea antes de lanzar el error devuelto
   * (mismo patron commit-before-throw del login).
   */
  private async prepareMfaFailure(
    client: PoolClient,
    user: MfaUserRow,
    meta: { ip?: string; userAgent?: string; requestId?: string }
  ): Promise<Error> {
    const attempts = user.failed_login_attempts + 1;
    const lock = attempts >= this.maxFailedAttempts;
    await client.query(
      `UPDATE users
       SET failed_login_attempts = $2,
           locked_until = CASE WHEN $3 THEN now() + make_interval(secs => $4) ELSE locked_until END
       WHERE id = $1`,
      [user.id, lock ? 0 : attempts, lock, this.lockoutMs / 1000]
    );
    await insertAuditEvent(client, {
      action: lock ? 'auth.account_locked' : 'auth.mfa_failed',
      context: { actorType: 'user', actorId: user.id, authMethod: 'none', ...meta },
      resourceType: 'user',
      resourceId: user.id,
      result: 'failure',
      riskLevel: lock ? 'high' : 'medium',
      reason: lock ? 'max_failed_attempts_reached' : 'invalid_mfa_code',
    });
    return lock ? new AccountLockedError() : new InvalidMfaCodeError();
  }

  /** Canjea el reto post-password por una sesion, verificando TOTP o backup code. */
  async verifyMfaChallenge(
    rawInput: MfaVerifyInput,
    meta: { ip?: string; userAgent?: string; requestId?: string } = {}
  ): Promise<LoginResult> {
    const input = MfaVerifySchema.parse(rawInput);
    const client = await this.authPool.connect();
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      const challenge = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM mfa_challenges
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [hashToken(input.challenge_token)]
      );
      const ch = challenge.rows[0];
      if (!ch) throw new InvalidMfaChallengeError();

      const user = await this.lockUserForMfa(client, ch.user_id);
      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        throw new AccountLockedError();
      }
      if (!user.totp_enabled_at) throw new MfaNotEnabledError();

      let method: 'totp' | 'backup_code' | null = null;
      const step = this.matchActiveTotp(user, input.code);
      if (step !== null) {
        await client.query(`UPDATE users SET totp_last_used_step = $2 WHERE id = $1`, [
          user.id,
          step.toString(),
        ]);
        method = 'totp';
      } else {
        // Codigo de respaldo: un solo uso, consumido atomicamente.
        const used = await client.query(
          `UPDATE mfa_backup_codes SET used_at = now()
           WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
           RETURNING id`,
          [user.id, hashBackupCode(input.code)]
        );
        if ((used.rowCount ?? 0) > 0) method = 'backup_code';
      }
      if (!method) {
        const failure = await this.prepareMfaFailure(client, user, meta);
        await client.query('COMMIT');
        inTx = false;
        throw failure;
      }

      await client.query(`UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1`, [ch.id]);
      await client.query(
        `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
        [user.id]
      );
      const session = await this.createSession(client, user.id, meta, true);
      await insertAuditEvent(client, {
        action: 'auth.mfa_verified',
        context: { actorType: 'user', actorId: user.id, authMethod: 'session', ...meta },
        resourceType: 'user',
        resourceId: user.id,
        reason: method,
      });
      await client.query('COMMIT');
      inTx = false;
      return session;
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Paso 1 del enrolamiento: genera el secreto pendiente (se activa con un codigo valido). */
  async setupMfa(userId: string): Promise<MfaSetup> {
    return this.withTx(async (c) => {
      const user = await this.lockUserForMfa(c, userId);
      if (user.totp_enabled_at) throw new MfaAlreadyEnabledError();
      const secret = generateTotpSecret();
      await c.query(`UPDATE users SET totp_pending_secret_enc = $2 WHERE id = $1`, [
        userId,
        encryptSecret(this.mfaKey, secret),
      ]);
      return { secret, otpauthUri: otpauthUri(secret, user.email) };
    });
  }

  /**
   * Paso 2: el usuario demuestra que cargo el secreto (codigo valido) y MFA
   * queda habilitado. Devuelve los codigos de respaldo UNA sola vez.
   */
  async activateMfa(
    userId: string,
    code: string,
    meta: { sessionId?: string; ip?: string; userAgent?: string; requestId?: string } = {}
  ): Promise<{ backupCodes: string[] }> {
    return this.withTx(async (c) => {
      const user = await this.lockUserForMfa(c, userId);
      if (user.totp_enabled_at) throw new MfaAlreadyEnabledError();
      if (!user.totp_pending_secret_enc) throw new MfaNotEnabledError();
      const secret = decryptMfaSecretWithKeyring(
        this.mfaKeyring,
        user.totp_pending_secret_enc
      ).plaintext;
      const step = verifyTotp(secret, code);
      if (step === null) throw new InvalidMfaCodeError();

      await c.query(
        `UPDATE users
         SET totp_secret_enc = totp_pending_secret_enc,
             totp_pending_secret_enc = NULL,
             totp_enabled_at = now(),
             totp_last_used_step = $2
         WHERE id = $1`,
        [userId, step.toString()]
      );
      const backupCodes = generateBackupCodes();
      for (const bc of backupCodes) {
        await c.query(`INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)`, [
          userId,
          hashBackupCode(bc),
        ]);
      }
      // La sesion que activo MFA queda verificada (evita step-up inmediato).
      if (meta.sessionId) {
        await c.query(
          `UPDATE sessions SET mfa_verified_at = now() WHERE id = $1 AND user_id = $2`,
          [meta.sessionId, userId]
        );
      }
      await insertAuditEvent(c, {
        action: 'auth.mfa_enabled',
        context: { actorType: 'user', actorId: userId, authMethod: 'session', ...meta },
        resourceType: 'user',
        resourceId: userId,
        riskLevel: 'high',
      });
      return { backupCodes };
    });
  }

  /** Deshabilita MFA. Exige un TOTP valido (un backup code NO basta para apagarla). */
  async disableMfa(
    userId: string,
    code: string,
    meta: { ip?: string; userAgent?: string; requestId?: string } = {}
  ): Promise<void> {
    return this.withTx(async (c) => {
      const user = await this.lockUserForMfa(c, userId);
      if (!user.totp_enabled_at) throw new MfaNotEnabledError();
      const step = this.matchActiveTotp(user, code);
      if (step === null) throw new InvalidMfaCodeError();
      await c.query(
        `UPDATE users
         SET totp_secret_enc = NULL, totp_pending_secret_enc = NULL,
             totp_enabled_at = NULL, totp_last_used_step = 0
         WHERE id = $1`,
        [userId]
      );
      // Los codigos de respaldo sin usar quedan invalidados (append-only: se marcan).
      await c.query(
        `UPDATE mfa_backup_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
        [userId]
      );
      await insertAuditEvent(c, {
        action: 'auth.mfa_disabled',
        context: { actorType: 'user', actorId: userId, authMethod: 'session', ...meta },
        resourceType: 'user',
        resourceId: userId,
        riskLevel: 'high',
      });
    });
  }

  /** Step-up: refresca mfa_verified_at de la sesion con un TOTP fresco. */
  async stepUp(
    userId: string,
    sessionId: string,
    code: string,
    meta: { ip?: string; userAgent?: string; requestId?: string } = {}
  ): Promise<{ mfaVerifiedAt: Date }> {
    const client = await this.authPool.connect();
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      const user = await this.lockUserForMfa(client, userId);
      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        throw new AccountLockedError();
      }
      if (!user.totp_enabled_at) throw new MfaNotEnabledError();
      const step = this.matchActiveTotp(user, code);
      if (step === null) {
        const failure = await this.prepareMfaFailure(client, user, meta);
        await client.query('COMMIT');
        inTx = false;
        throw failure;
      }
      await client.query(`UPDATE users SET totp_last_used_step = $2 WHERE id = $1`, [
        userId,
        step.toString(),
      ]);
      const updated = await client.query<{ mfa_verified_at: Date }>(
        `UPDATE sessions SET mfa_verified_at = now()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()
         RETURNING mfa_verified_at`,
        [sessionId, userId]
      );
      if (!updated.rows[0]) throw new InvalidSessionError();
      await insertAuditEvent(client, {
        action: 'auth.step_up',
        context: { actorType: 'user', actorId: userId, authMethod: 'session', ...meta },
        resourceType: 'session',
        resourceId: sessionId,
        riskLevel: 'medium',
      });
      await client.query('COMMIT');
      inTx = false;
      return { mfaVerifiedAt: updated.rows[0].mfa_verified_at };
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * TM-02 (threat model §5) — step-up por RE-AUTENTICACIÓN DE PASSWORD, solo
   * para usuarios SIN MFA (con MFA habilitado el password no sustituye al
   * factor fuerte: se exige `/v1/auth/mfa/step-up`). Un password fallido cuenta
   * contra el MISMO lockout que el login (no es un oráculo de fuerza bruta
   * paralelo), y el éxito refresca `sessions.password_verified_at` (0040)
   * auditado en la misma transacción.
   */
  async stepUpWithPassword(
    userId: string,
    sessionId: string,
    password: string,
    meta: { ip?: string; userAgent?: string; requestId?: string } = {}
  ): Promise<{ passwordVerifiedAt: Date }> {
    const client = await this.authPool.connect();
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      const res = await client.query<{
        id: string;
        password_hash: string | null;
        failed_login_attempts: number;
        locked_until: Date | null;
        totp_enabled_at: Date | null;
      }>(
        `SELECT id, password_hash, failed_login_attempts, locked_until, totp_enabled_at
         FROM users WHERE id = $1 AND deleted_at IS NULL
         FOR UPDATE`,
        [userId]
      );
      const user = res.rows[0];
      if (!user || user.password_hash === null) {
        await verifyPassword(password, await dummyPasswordHash());
        throw new InvalidCredentialsError();
      }
      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        throw new AccountLockedError();
      }
      // Con MFA habilitado, el step-up es SIEMPRE por TOTP.
      if (user.totp_enabled_at) throw new StepUpRequiredError();

      const valid = await verifyPassword(password, user.password_hash);
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
        await insertAuditEvent(client, {
          action: lock ? 'auth.account_locked' : 'auth.step_up_password_failed',
          context: { actorType: 'user', actorId: user.id, authMethod: 'session', ...meta },
          resourceType: 'session',
          resourceId: sessionId,
          result: 'failure',
          riskLevel: lock ? 'high' : 'medium',
          reason: lock ? 'max_failed_attempts_reached' : 'invalid_password',
        });
        await client.query('COMMIT');
        inTx = false;
        throw lock ? new AccountLockedError() : new InvalidCredentialsError();
      }

      await client.query(`UPDATE users SET failed_login_attempts = 0 WHERE id = $1`, [user.id]);
      const updated = await client.query<{ password_verified_at: Date }>(
        `UPDATE sessions SET password_verified_at = now()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()
         RETURNING password_verified_at`,
        [sessionId, userId]
      );
      if (!updated.rows[0]) throw new InvalidSessionError();
      await insertAuditEvent(client, {
        action: 'auth.step_up_password',
        context: { actorType: 'user', actorId: userId, authMethod: 'session', ...meta },
        resourceType: 'session',
        resourceId: sessionId,
        riskLevel: 'medium',
      });
      await client.query('COMMIT');
      inTx = false;
      return { passwordVerifiedAt: updated.rows[0].password_verified_at };
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async mfaStatus(userId: string): Promise<MfaStatus> {
    const res = await this.authPool.query<{
      totp_enabled_at: Date | null;
      totp_pending_secret_enc: string | null;
      remaining: number;
    }>(
      `SELECT u.totp_enabled_at, u.totp_pending_secret_enc,
              (SELECT count(*)::int FROM mfa_backup_codes b
               WHERE b.user_id = u.id AND b.used_at IS NULL) AS remaining
       FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId]
    );
    const row = res.rows[0];
    if (!row) throw new InvalidSessionError();
    return {
      enabled: row.totp_enabled_at !== null,
      pendingSetup: row.totp_pending_secret_enc !== null,
      backupCodesRemaining: row.remaining,
    };
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
