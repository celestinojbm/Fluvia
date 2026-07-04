import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withTenantTransaction, type Pool } from '@fluvia/db';
import { insertAuditEvent, type AuditContext } from '@fluvia/audit';
import { IdentityError } from './errors.js';

/**
 * API keys de integracion (F1-04c).
 *
 * Propiedades:
 *  - El secreto se muestra UNA sola vez; la base solo guarda SHA-256 + prefijo.
 *  - Scopes explicitos; una API key JAMAS puede gestionar API keys
 *    (eso es exclusivo del plano de sesion con rol): robo de key != escalada.
 *  - Entornos test/live separados por prefijo detectable por secret scanning.
 */

export const API_KEY_SCOPES = [
  'read',
  'payments:write',
  'customers:write',
  'webhooks:manage',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const CreateApiKeySchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    scopes: z
      .array(z.enum(API_KEY_SCOPES as unknown as [ApiKeyScope, ...ApiKeyScope[]]))
      .nonempty()
      .max(API_KEY_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, 'duplicate scopes'),
    environment: z.enum(['test', 'live']).default('test'),
  })
  .strict();

export type CreateApiKeyInput = z.input<typeof CreateApiKeySchema>;

export class ApiKeyNotFoundError extends IdentityError {
  constructor() {
    super('API key not found');
  }
}

export class InvalidApiKeyError extends IdentityError {
  constructor() {
    super('API key is invalid or revoked');
  }
}

export class InsufficientScopeError extends IdentityError {
  constructor(readonly scope: string) {
    super(`API key lacks the required scope: ${scope}`);
  }
}

export interface CreatedApiKey {
  id: string;
  /** Secreto en claro — se entrega una unica vez y no vuelve a ser recuperable. */
  secret: string;
  keyPrefix: string;
  label: string;
  scopes: ApiKeyScope[];
  environment: 'test' | 'live';
}

export interface ApiKeyDto {
  id: string;
  label: string;
  keyPrefix: string;
  scopes: string[];
  environment: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

const PREFIX_DISPLAY_LENGTH = 20;

interface ApiKeyRow {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
  environment: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export class ApiKeyService {
  constructor(private readonly appPool: Pool) {}

  async create(
    tenantId: string,
    rawInput: CreateApiKeyInput,
    audit?: AuditContext
  ): Promise<CreatedApiKey> {
    const input = CreateApiKeySchema.parse(rawInput);
    const secret = `fluvia_sk_${input.environment}_${randomBytes(24).toString('hex')}`;
    const keyPrefix = secret.slice(0, PREFIX_DISPLAY_LENGTH);

    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label, scopes, environment, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          tenantId,
          hashApiKeySecret(secret),
          keyPrefix,
          input.label,
          input.scopes,
          input.environment,
          audit?.actorId ?? null,
        ]
      );
      const id = res.rows[0]!.id;
      if (audit) {
        await insertAuditEvent(c, {
          action: 'api_key.created',
          tenantId,
          context: audit,
          resourceType: 'api_key',
          resourceId: id,
          riskLevel: 'high',
          after: { label: input.label, scopes: input.scopes, environment: input.environment },
        });
      }
      return {
        id,
        secret,
        keyPrefix,
        label: input.label,
        scopes: input.scopes,
        environment: input.environment,
      };
    });
  }

  async list(tenantId: string): Promise<ApiKeyDto[]> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<ApiKeyRow>(
        `SELECT id, label, key_prefix, scopes, environment, created_at, last_used_at, revoked_at
         FROM api_keys
         WHERE deleted_at IS NULL
         ORDER BY created_at DESC`
      );
      return res.rows.map((r) => ({
        id: r.id,
        label: r.label,
        keyPrefix: r.key_prefix,
        scopes: r.scopes,
        environment: r.environment,
        createdAt: r.created_at.toISOString(),
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
        revokedAt: r.revoked_at?.toISOString() ?? null,
      }));
    });
  }

  async revoke(tenantId: string, apiKeyId: string, audit?: AuditContext): Promise<void> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<{ label: string }>(
        `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING label`,
        [apiKeyId]
      );
      if ((res.rowCount ?? 0) === 0) throw new ApiKeyNotFoundError();
      if (audit) {
        await insertAuditEvent(c, {
          action: 'api_key.revoked',
          tenantId,
          context: audit,
          resourceType: 'api_key',
          resourceId: apiKeyId,
          riskLevel: 'high',
          before: { label: res.rows[0]!.label },
        });
      }
    });
  }
}
