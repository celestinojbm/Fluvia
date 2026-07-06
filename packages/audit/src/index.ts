import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';

/**
 * Auditoria append-only (F1-05, V4 §36).
 *
 * Regla de uso: insertAuditEvent se llama con el CLIENT de la transaccion de
 * la accion auditada — el evento y la accion se confirman atomicamente.
 */

export const AUDIT_ACTIONS = [
  'user.registered',
  'user.email_verified',
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.account_locked',
  'auth.logout',
  'auth.sessions_revoked',
  'auth.mfa_challenge',
  'auth.mfa_verified',
  'auth.mfa_failed',
  'auth.mfa_enabled',
  'auth.mfa_disabled',
  'auth.step_up',
  'api_key.created',
  'api_key.revoked',
  'merchant.created',
  'merchant.updated',
  'ledger.transaction_reversed',
  'platform.operation',
  'platform.technical_purge',
  'payment_attempt.swept_indeterminate',
  'webhook_event.resent',
  'operational_case.acknowledged',
  'operational_case.resolved',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type ActorType = 'user' | 'api_key' | 'system';
export type AuthMethod = 'session' | 'api_key' | 'platform' | 'none';
export type AuditResult = 'success' | 'failure';
export type RiskLevel = 'low' | 'medium' | 'high';

/** Contexto del request que las capas superiores propagan a los servicios. */
export interface AuditContext {
  actorType: ActorType;
  actorId?: string;
  authMethod?: AuthMethod;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface AuditEventInput {
  action: AuditAction;
  /** NULL/undefined => evento del plano de autenticacion (sin tenant). */
  tenantId?: string | null;
  context: AuditContext;
  resourceType?: string;
  resourceId?: string;
  result?: AuditResult;
  riskLevel?: RiskLevel;
  reason?: string;
  before?: unknown;
  after?: unknown;
}

const SENSITIVE_KEY_RE = /secret|token|password|key_hash|authorization|cvv|pan/i;

/** Redaccion superficial-recursiva de claves sensibles en los resumenes. */
export function redactSummary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSummary);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : redactSummary(v),
      ])
    );
  }
  return value;
}

export async function insertAuditEvent(
  client: PoolClient | Pool,
  event: AuditEventInput
): Promise<void> {
  const ctx = event.context;
  await client.query(
    `INSERT INTO audit_events
       (tenant_id, actor_type, actor_id, auth_method, action, resource_type, resource_id,
        result, risk_level, reason, before_summary, after_summary, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      event.tenantId ?? null,
      ctx.actorType,
      ctx.actorId ?? null,
      ctx.authMethod ?? null,
      event.action,
      event.resourceType ?? null,
      event.resourceId ?? null,
      event.result ?? 'success',
      event.riskLevel ?? 'low',
      event.reason ?? null,
      event.before === undefined ? null : JSON.stringify(redactSummary(event.before)),
      event.after === undefined ? null : JSON.stringify(redactSummary(event.after)),
      ctx.ip ?? null,
      ctx.userAgent ?? null,
      ctx.requestId ?? null,
    ]
  );
}

export interface AuditEventDto {
  id: string;
  actorType: string;
  actorId: string | null;
  authMethod: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  result: string;
  riskLevel: string;
  reason: string | null;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface ListAuditOptions {
  limit?: number;
  /** Cursor: solo eventos con id < before (orden descendente). */
  before?: string | number;
}

export class PlatformReasonRequiredError extends Error {
  constructor() {
    super('Platform operations require an explicit, non-empty reason (V4 §36)');
    this.name = 'PlatformReasonRequiredError';
  }
}

export interface PlatformOperationOptions {
  /** Tenant objetivo de la operacion (null para operaciones globales). */
  tenantId?: string | null;
  /** Operador humano/proceso que ordena la operacion. */
  actorId?: string;
  /** OBLIGATORIA: sin razon no hay bypass. */
  reason: string;
  requestId?: string;
  /** Recurso afectado (p.ej. 'outbox_event'), para trazabilidad fina. */
  resourceType?: string;
  resourceId?: string;
  /** Detalle estructurado del efecto (se redacta y persiste como after). */
  details?: unknown;
}

/**
 * UNICO camino sancionado para operar fuera del aislamiento de tenant
 * (plano de plataforma / panel admin futuro). Garantias:
 *  - Exige razon explicita; sin ella lanza antes de tocar la base.
 *  - Registra SIEMPRE un audit event 'platform.operation' de riesgo alto
 *    EN LA MISMA transaccion: si la operacion se confirma, su rastro tambien.
 *  - Corre sobre el pool administrativo: jamas exponer este helper a
 *    requests de usuarios finales.
 */
export async function withPlatformOperation<T>(
  adminPool: Pool,
  options: PlatformOperationOptions,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!options.reason || options.reason.trim().length === 0) {
    throw new PlatformReasonRequiredError();
  }
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    // options.details se lee DESPUES de fn: un caller puede pasar un objeto
    // mutable y rellenarlo dentro de fn con el efecto real (p.ej. ids tocados).
    await insertAuditEvent(client, {
      action: 'platform.operation',
      tenantId: options.tenantId ?? null,
      context: {
        actorType: 'system',
        actorId: options.actorId,
        authMethod: 'platform',
        requestId: options.requestId,
      },
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      riskLevel: 'high',
      reason: options.reason.trim(),
      after: options.details,
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Lectura del plano de tenant (rol fluvia_app, RLS aplica). */
export class AuditReader {
  constructor(private readonly appPool: Pool) {}

  async list(tenantId: string, options: ListAuditOptions = {}): Promise<AuditEventDto[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<{
        id: string;
        actor_type: string;
        actor_id: string | null;
        auth_method: string | null;
        action: string;
        resource_type: string | null;
        resource_id: string | null;
        result: string;
        risk_level: string;
        reason: string | null;
        ip: string | null;
        request_id: string | null;
        created_at: Date;
      }>(
        `SELECT id, actor_type, actor_id, auth_method, action, resource_type, resource_id,
                result, risk_level, reason, ip, request_id, created_at
         FROM audit_events
         WHERE ($2::bigint IS NULL OR id < $2)
         ORDER BY id DESC
         LIMIT $1`,
        [limit, options.before ?? null]
      );
      return res.rows.map((r) => ({
        id: r.id,
        actorType: r.actor_type,
        actorId: r.actor_id,
        authMethod: r.auth_method,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        result: r.result,
        riskLevel: r.risk_level,
        reason: r.reason,
        ip: r.ip,
        requestId: r.request_id,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }
}
