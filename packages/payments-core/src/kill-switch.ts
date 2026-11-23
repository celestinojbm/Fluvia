import { withPlatformOperation } from '@fluvia/audit';
import type { Pool, PoolClient } from '@fluvia/db';
import { z } from 'zod';
import { PaymentsCoreError } from './errors.js';

/**
 * Kill switch por país o contraparte (issue #91).
 *
 * El corte lo hace cumplir el MOTOR (migración 0068): un INSERT en
 * `payment_intents`, `payment_attempts` o `payouts` que toque un país, comercio
 * o proveedor con un interruptor activo falla con SQLSTATE {@link FLOW_SUSPENDED_SQLSTATE}.
 * Ningún servicio tiene que acordarse de comprobarlo, y ningún camino nuevo
 * puede saltárselo.
 *
 * Este módulo es el PLANO DE PLATAFORMA: activar, liberar y listar, solo con el
 * pool administrativo (los roles de runtime no tienen privilegios sobre la
 * tabla), con razón obligatoria y auditoría `platform.operation` de riesgo alto
 * en la MISMA transacción. Jamás exponer {@link KillSwitchAdmin} a requests de
 * usuarios finales: se opera por CLI (`kill-switch-cli.ts`).
 */

/** SQLSTATE dedicado del guard (0068). "451": no disponible por razones legales. */
export const FLOW_SUSPENDED_SQLSTATE = 'FV451';

/** ¿El error viene del guard del motor? (pg propaga `code` = SQLSTATE). */
export function isFlowSuspendedDbError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === FLOW_SUSPENDED_SQLSTATE
  );
}

export const KILL_SWITCH_SCOPES = ['country', 'merchant', 'provider'] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

export interface KillSwitchDto {
  id: string;
  scope: KillSwitchScope;
  target: string;
  reason: string;
  engagedBy: string;
  engagedAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
  releaseReason: string | null;
}

export class KillSwitchNotFoundError extends PaymentsCoreError {
  constructor() {
    super('Kill switch not found');
  }
}

export class KillSwitchAlreadyReleasedError extends PaymentsCoreError {
  constructor(readonly id: string) {
    super(`Kill switch ${id} was already released`);
  }
}

/** El comercio objetivo no existe: casi siempre es un id mal copiado. */
export class KillSwitchUnknownMerchantError extends PaymentsCoreError {
  constructor(readonly merchantId: string) {
    super(`Merchant ${merchantId} does not exist`);
  }
}

const Reason = z
  .string()
  .trim()
  .min(1, 'reason is required')
  .max(1000, 'reason must be at most 1000 characters');

/** Operador = id (uuid) del usuario de plataforma: es lo que guarda audit_events.actor_id. */
const Actor = z.string().trim().toLowerCase().uuid('actorId must be the operator user id (uuid)');

/**
 * Normaliza el objetivo al formato EXACTO que compara el guard: un `co` o un
 * uuid en mayúsculas sería un interruptor activo que no corta nada.
 */
const Target = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('country'),
    target: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code'),
  }),
  z.object({
    scope: z.literal('merchant'),
    target: z.string().trim().toLowerCase().uuid('merchant must be a merchant id (uuid)'),
  }),
  z.object({
    scope: z.literal('provider'),
    target: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'provider must be a provider name'),
  }),
]);

export interface EngageKillSwitchInput {
  scope: KillSwitchScope;
  target: string;
  reason: string;
  actorId: string;
  requestId?: string;
}

export interface ReleaseKillSwitchInput {
  id: string;
  reason: string;
  actorId: string;
  requestId?: string;
}

export interface EngageResult {
  killSwitch: KillSwitchDto;
  /** false si ya había un interruptor activo para ese objetivo (no-op). */
  created: boolean;
}

interface KillSwitchRow {
  id: string;
  scope: KillSwitchScope;
  target: string;
  reason: string;
  engaged_by: string;
  engaged_at: Date;
  released_at: Date | null;
  released_by: string | null;
  release_reason: string | null;
}

const KILL_SWITCH_COLUMNS = `id, scope, target, reason, engaged_by, engaged_at, released_at, released_by, release_reason`;

const toDto = (r: KillSwitchRow): KillSwitchDto => ({
  id: r.id,
  scope: r.scope,
  target: r.target,
  reason: r.reason,
  engagedBy: r.engaged_by,
  engagedAt: r.engaged_at.toISOString(),
  releasedAt: r.released_at?.toISOString() ?? null,
  releasedBy: r.released_by,
  releaseReason: r.release_reason,
});

export class KillSwitchAdmin {
  constructor(
    /** Pool ADMINISTRATIVO (plano de plataforma). */
    private readonly adminPool: Pool
  ) {}

  /**
   * Activa un corte. Efecto inmediato para toda transacción que haga INSERT
   * después del COMMIT. Idempotente por (scope, target): si ya hay uno activo,
   * lo devuelve con `created: false` (la orden del operador queda auditada igual).
   */
  async engage(input: EngageKillSwitchInput): Promise<EngageResult> {
    const { scope, target } = Target.parse({ scope: input.scope, target: input.target });
    const reason = Reason.parse(input.reason);
    const actorId = Actor.parse(input.actorId);

    const details: Record<string, unknown> = { operation: 'kill_switch.engage', scope, target };
    return withPlatformOperation(
      this.adminPool,
      {
        actorId,
        reason,
        requestId: input.requestId,
        resourceType: 'kill_switch',
        details,
      },
      async (client) => {
        if (scope === 'merchant') {
          const m = await client.query<{ tenant_id: string }>(
            `SELECT tenant_id FROM merchants WHERE id = $1`,
            [target]
          );
          if (!m.rows[0]) throw new KillSwitchUnknownMerchantError(target);
          details.merchantTenantId = m.rows[0].tenant_id;
        }

        const inserted = await client.query<KillSwitchRow>(
          `INSERT INTO kill_switches (scope, target, reason, engaged_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (scope, target) WHERE released_at IS NULL DO NOTHING
           RETURNING ${KILL_SWITCH_COLUMNS}`,
          [scope, target, reason, actorId]
        );
        let row = inserted.rows[0];
        const created = row !== undefined;
        if (!row) {
          const existing = await client.query<KillSwitchRow>(
            `SELECT ${KILL_SWITCH_COLUMNS} FROM kill_switches
             WHERE scope = $1 AND target = $2 AND released_at IS NULL`,
            [scope, target]
          );
          row = existing.rows[0]!;
        }
        details.killSwitchId = row.id;
        details.created = created;
        return { killSwitch: toDto(row), created };
      }
    );
  }

  /** Libera un corte (una sola vez; exige su propia razón). */
  async release(input: ReleaseKillSwitchInput): Promise<KillSwitchDto> {
    const id = z.string().trim().toLowerCase().uuid().parse(input.id);
    const reason = Reason.parse(input.reason);
    const actorId = Actor.parse(input.actorId);

    const details: Record<string, unknown> = { operation: 'kill_switch.release', killSwitchId: id };
    return withPlatformOperation(
      this.adminPool,
      {
        actorId,
        reason,
        requestId: input.requestId,
        resourceType: 'kill_switch',
        resourceId: id,
        details,
      },
      async (client) => {
        const cur = await client.query<KillSwitchRow>(
          `SELECT ${KILL_SWITCH_COLUMNS} FROM kill_switches WHERE id = $1 FOR UPDATE`,
          [id]
        );
        const row = cur.rows[0];
        if (!row) throw new KillSwitchNotFoundError();
        if (row.released_at !== null) throw new KillSwitchAlreadyReleasedError(id);

        const res = await client.query<KillSwitchRow>(
          `UPDATE kill_switches
              SET released_at = now(), released_by = $2, release_reason = $3
            WHERE id = $1
            RETURNING ${KILL_SWITCH_COLUMNS}`,
          [id, actorId, reason]
        );
        details.scope = row.scope;
        details.target = row.target;
        return toDto(res.rows[0]!);
      }
    );
  }

  /** Interruptores activos (lectura del plano de plataforma, sin auditoría). */
  async listActive(): Promise<KillSwitchDto[]> {
    return this.read(
      `SELECT ${KILL_SWITCH_COLUMNS} FROM kill_switches WHERE released_at IS NULL
       ORDER BY engaged_at, id`
    );
  }

  /** Historial reciente (activos y liberados), del más nuevo al más viejo. */
  async history(limit = 50): Promise<KillSwitchDto[]> {
    const n = z.number().int().min(1).max(500).parse(limit);
    return this.read(
      `SELECT ${KILL_SWITCH_COLUMNS} FROM kill_switches ORDER BY engaged_at DESC, id DESC LIMIT $1`,
      [n]
    );
  }

  private async read(sql: string, params: unknown[] = []): Promise<KillSwitchDto[]> {
    const client: PoolClient = await this.adminPool.connect();
    try {
      const res = await client.query<KillSwitchRow>(sql, params);
      return res.rows.map(toDto);
    } finally {
      client.release();
    }
  }
}
