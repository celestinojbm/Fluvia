import type { Pool, PoolClient } from '@fluvia/db';
import { insertAuditEvent, type AuditContext } from '@fluvia/audit';
import { generateToken, hashPassword, hashToken, verifyPassword } from '@fluvia/auth';
import { z } from 'zod';
import { isUniqueViolation } from './context.js';
import {
  ConsumerEmailTakenError,
  ConsumerLockedError,
  ConsumerSessionInvalidError,
  InvalidConsumerCredentialsError,
  ProgramNotFoundError,
} from './errors.js';

/**
 * Autenticación del CLIENTE (Fluvia Personal), separada del plano de miembros
 * de organización:
 *  - tabla `consumers` + credenciales/sesiones propias (solo rol fluvia_auth);
 *  - token de sesión `fluvia_csess_…` (prefijo distinto: una sesión de cliente
 *    no se confunde con `fluvia_sess_` de comercio/operación y viceversa);
 *  - bloqueo temporal tras intentos fallidos; respuesta uniforme ante email
 *    inexistente (anti-enumeración, con hash ficticio de coste equivalente).
 */
export const CONSUMER_SESSION_PREFIX = 'fluvia_csess';

export const ConsumerRegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(200),
  displayName: z.string().trim().min(1).max(80),
  /** Perfil de riesgo DECLARADO para el sandbox (dato sintético, no verificado). */
  syntheticRiskProfile: z.enum(['A', 'B', 'C', 'D']).default('B'),
});
export type ConsumerRegisterInput = z.input<typeof ConsumerRegisterSchema>;

export interface ConsumerIdentity {
  consumerId: string;
  tenantId: string;
  sessionId: string;
  email: string;
  displayName: string;
  status: string;
}

export interface ConsumerAuthOptions {
  sessionTtlMs?: number;
  maxFailedAttempts?: number;
  lockoutMs?: number;
}

let dummyHash: Promise<string> | undefined;

export class ConsumerAuthService {
  private readonly ttl: number;
  private readonly maxFailed: number;
  private readonly lockoutMs: number;

  constructor(
    /** Pool con rol fluvia_auth. */
    private readonly authPool: Pool,
    options: ConsumerAuthOptions = {}
  ) {
    this.ttl = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.maxFailed = options.maxFailedAttempts ?? 5;
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.authPool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async register(
    tenantId: string,
    raw: ConsumerRegisterInput,
    ctx: Partial<AuditContext> = {}
  ): Promise<{ consumerId: string; session: string }> {
    const input = ConsumerRegisterSchema.parse(raw);
    const passwordHash = await hashPassword(input.password);
    return this.tx(async (c) => {
      const prog = await c.query(`SELECT 1 FROM consumer_programs WHERE tenant_id = $1`, [
        tenantId,
      ]);
      if (!prog.rowCount) throw new ProgramNotFoundError();
      let consumerId: string;
      try {
        const res = await c.query<{ id: string }>(
          `INSERT INTO consumers (tenant_id, email, display_name, synthetic_risk_profile)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [tenantId, input.email, input.displayName, input.syntheticRiskProfile]
        );
        consumerId = res.rows[0]!.id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConsumerEmailTakenError();
        throw err;
      }
      await c.query(
        `INSERT INTO consumer_credentials (consumer_id, tenant_id, password_hash) VALUES ($1, $2, $3)`,
        [consumerId, tenantId, passwordHash]
      );
      await insertAuditEvent(c, {
        action: 'consumer.registered',
        tenantId,
        context: { actorType: 'consumer', actorId: consumerId, authMethod: 'none', ...ctx },
        resourceType: 'consumer',
        resourceId: consumerId,
      });
      const session = await this.createSession(c, consumerId, tenantId);
      return { consumerId, session };
    });
  }

  async login(
    tenantId: string,
    emailRaw: string,
    password: string,
    ctx: Partial<AuditContext> = {}
  ): Promise<{ consumerId: string; session: string }> {
    const email = emailRaw.trim().toLowerCase();
    const row = await this.tx(async (c) => {
      const res = await c.query<{
        id: string;
        status: string;
        password_hash: string;
        failed_attempts: number;
        locked_until: Date | null;
      }>(
        `SELECT k.id, k.status, cr.password_hash, cr.failed_attempts, cr.locked_until
           FROM consumers k JOIN consumer_credentials cr ON cr.consumer_id = k.id
          WHERE k.tenant_id = $1 AND k.email = $2
          FOR UPDATE OF cr`,
        [tenantId, email]
      );
      return res.rows[0];
    });
    if (!row) {
      dummyHash ??= hashPassword('fluvia-dummy-password-for-timing');
      await verifyPassword(password, await dummyHash);
      throw new InvalidConsumerCredentialsError();
    }
    if (row.locked_until && row.locked_until.getTime() > Date.now()) {
      throw new ConsumerLockedError();
    }
    const ok = await verifyPassword(password, row.password_hash);
    return this.tx(async (c) => {
      if (!ok || row.status !== 'active') {
        const failed = row.failed_attempts + 1;
        const lock = failed >= this.maxFailed ? new Date(Date.now() + this.lockoutMs) : null;
        await c.query(
          `UPDATE consumer_credentials
              SET failed_attempts = CASE WHEN $3::timestamptz IS NULL THEN $2 ELSE 0 END,
                  locked_until = $3, updated_at = now()
            WHERE consumer_id = $1`,
          [row.id, failed, lock]
        );
        await insertAuditEvent(c, {
          action: 'consumer.login_failed',
          tenantId,
          context: { actorType: 'consumer', actorId: row.id, authMethod: 'none', ...ctx },
          resourceType: 'consumer',
          resourceId: row.id,
          result: 'failure',
          riskLevel: lock ? 'high' : 'medium',
        });
        return { failed: true as const };
      }
      await c.query(
        `UPDATE consumer_credentials SET failed_attempts = 0, locked_until = NULL, updated_at = now()
          WHERE consumer_id = $1`,
        [row.id]
      );
      await insertAuditEvent(c, {
        action: 'consumer.login_succeeded',
        tenantId,
        context: { actorType: 'consumer', actorId: row.id, authMethod: 'none', ...ctx },
        resourceType: 'consumer',
        resourceId: row.id,
      });
      const session = await this.createSession(c, row.id, tenantId);
      return { failed: false as const, consumerId: row.id, session };
    }).then((r) => {
      if (r.failed) throw new InvalidConsumerCredentialsError();
      return { consumerId: r.consumerId, session: r.session };
    });
  }

  private async createSession(
    c: PoolClient,
    consumerId: string,
    tenantId: string
  ): Promise<string> {
    const token = generateToken(CONSUMER_SESSION_PREFIX);
    await c.query(
      `INSERT INTO consumer_sessions (consumer_id, tenant_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [consumerId, tenantId, token.hash, new Date(Date.now() + this.ttl)]
    );
    return token.plaintext;
  }

  /** Resuelve una sesión viva. Un token de otro plano jamás valida aquí. */
  async authenticate(token: string): Promise<ConsumerIdentity> {
    if (!token.startsWith(`${CONSUMER_SESSION_PREFIX}_`)) throw new ConsumerSessionInvalidError();
    const res = await this.authPool.query<{
      session_id: string;
      consumer_id: string;
      tenant_id: string;
      email: string;
      display_name: string;
      status: string;
    }>(
      `UPDATE consumer_sessions s SET last_seen_at = now()
         FROM consumers k
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND k.id = s.consumer_id AND k.status <> 'closed'
        RETURNING s.id AS session_id, s.consumer_id, s.tenant_id, k.email, k.display_name, k.status`,
      [hashToken(token)]
    );
    const r = res.rows[0];
    if (!r) throw new ConsumerSessionInvalidError();
    return {
      consumerId: r.consumer_id,
      tenantId: r.tenant_id,
      sessionId: r.session_id,
      email: r.email,
      displayName: r.display_name,
      status: r.status,
    };
  }

  async logout(token: string, ctx: Partial<AuditContext> = {}): Promise<void> {
    await this.tx(async (c) => {
      const res = await c.query<{ consumer_id: string; tenant_id: string }>(
        `UPDATE consumer_sessions SET revoked_at = now()
          WHERE token_hash = $1 AND revoked_at IS NULL RETURNING consumer_id, tenant_id`,
        [hashToken(token)]
      );
      const r = res.rows[0];
      if (r) {
        await insertAuditEvent(c, {
          action: 'consumer.logout',
          tenantId: r.tenant_id,
          context: {
            actorType: 'consumer',
            actorId: r.consumer_id,
            authMethod: 'consumer_session',
            ...ctx,
          },
          resourceType: 'consumer',
          resourceId: r.consumer_id,
        });
      }
    });
  }
}
