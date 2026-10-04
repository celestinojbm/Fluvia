import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import {
  effectiveCapability,
  isCapabilityKey,
  isMarket,
  isOffered,
  marketCapabilities,
  CAPABILITY_CEILING,
  type CapabilityKey,
  type EffectiveCapability,
  type Market,
  type Withdrawal,
} from './catalog.js';

export class CapabilityUnavailableError extends Error {
  readonly code = 'capability_unavailable';
  constructor(
    readonly capability: CapabilityKey,
    readonly market: string,
    readonly status: string
  ) {
    super(`Capability ${capability} is not offered in ${market} (${status})`);
    this.name = 'CapabilityUnavailableError';
  }
}

export class CapabilityRequestError extends Error {
  readonly code = 'capability_request_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityRequestError';
  }
}

/** Quien retiró una capacidad no puede restablecerla (cuatro ojos). */
export class CapabilityFourEyesError extends Error {
  readonly code = 'four_eyes_required';
  constructor() {
    super('Another operator must restore this capability');
    this.name = 'CapabilityFourEyesError';
  }
}

export interface WithdrawalRecord {
  id: string;
  market: Market;
  capability: CapabilityKey;
  reason: string;
  withdrawnByUserId: string;
  withdrawnAt: string;
  liftedByUserId: string | null;
  liftedAt: string | null;
  liftReason: string | null;
}

/** Gancho de auditoría en la MISMA transacción que la escritura. */
export type CapabilityAudit = (c: PoolClient, resourceId: string) => Promise<void>;

interface Row {
  id: string;
  market: string;
  capability: string;
  reason: string;
  withdrawn_by_user_id: string;
  withdrawn_at: Date;
  lifted_by_user_id: string | null;
  lifted_at: Date | null;
  lift_reason: string | null;
}

const toRecord = (r: Row): WithdrawalRecord => ({
  id: r.id,
  market: r.market.trim() as Market,
  capability: r.capability as CapabilityKey,
  reason: r.reason,
  withdrawnByUserId: r.withdrawn_by_user_id,
  withdrawnAt: r.withdrawn_at.toISOString(),
  liftedByUserId: r.lifted_by_user_id,
  liftedAt: r.lifted_at?.toISOString() ?? null,
  liftReason: r.lift_reason,
});

/**
 * Capacidades efectivas = catálogo (techo) − retiradas vigentes de
 * Operaciones. Las retiradas viven en el tenant de la organización programa
 * (`programTenantId`): una sola autoridad de la plataforma.
 */
export class CapabilityService {
  constructor(
    private readonly appPool: Pool,
    private readonly programTenantId: string | undefined
  ) {}

  async withdrawals(): Promise<Withdrawal[]> {
    if (!this.programTenantId) return [];
    const r = await withTenantTransaction(this.appPool, this.programTenantId, (c) =>
      c.query<Row>(
        `SELECT * FROM capability_withdrawals WHERE lifted_at IS NULL ORDER BY withdrawn_at`
      )
    );
    return r.rows
      .filter((x) => isMarket(x.market.trim()) && isCapabilityKey(x.capability))
      .map((x) => ({
        market: x.market.trim() as Market,
        capability: x.capability as CapabilityKey,
        reason: x.reason,
        withdrawnAt: x.withdrawn_at.toISOString(),
      }));
  }

  async forMarket(market: string): Promise<EffectiveCapability[]> {
    return marketCapabilities(market, await this.withdrawals());
  }

  async get(market: string, key: CapabilityKey): Promise<EffectiveCapability> {
    return effectiveCapability(market, key, await this.withdrawals());
  }

  /** Lanza si la capacidad no se ofrece: el servidor nunca ejecuta lo que no existe. */
  async require(market: string, key: CapabilityKey): Promise<EffectiveCapability> {
    const cap = await this.get(market, key);
    if (!cap.offered) throw new CapabilityUnavailableError(key, market, cap.status);
    return cap;
  }

  /** Historial (vigentes y levantadas) del programa. */
  async history(programTenantId: string): Promise<WithdrawalRecord[]> {
    const r = await withTenantTransaction(this.appPool, programTenantId, (c) =>
      c.query<Row>(`SELECT * FROM capability_withdrawals ORDER BY withdrawn_at DESC LIMIT 200`)
    );
    return r.rows.map(toRecord);
  }

  /**
   * Retirar una capacidad de un mercado (freno). Solo tiene sentido sobre una
   * capacidad que hoy se ofrece; retirarla dos veces es idempotente.
   */
  async withdraw(
    programTenantId: string,
    input: { market: string; capability: string; reason: string; userId: string },
    audit?: CapabilityAudit
  ): Promise<WithdrawalRecord> {
    const { market, capability } = this.validate(input.market, input.capability);
    if (!isOffered(CAPABILITY_CEILING[market][capability])) {
      throw new CapabilityRequestError('Only an offered capability can be withdrawn');
    }
    return withTenantTransaction(this.appPool, programTenantId, async (c) => {
      const existing = await c.query<Row>(
        `SELECT * FROM capability_withdrawals
          WHERE market = $1 AND capability = $2 AND lifted_at IS NULL`,
        [market, capability]
      );
      if (existing.rows[0]) return toRecord(existing.rows[0]);
      const r = await c.query<Row>(
        `INSERT INTO capability_withdrawals (tenant_id, market, capability, reason, withdrawn_by_user_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [programTenantId, market, capability, input.reason.trim(), input.userId]
      );
      await audit?.(c, r.rows[0]!.id);
      return toRecord(r.rows[0]!);
    });
  }

  /** Levantar una retirada: otra persona (cuatro ojos, también en el motor). */
  async restore(
    programTenantId: string,
    input: { id: string; reason: string; userId: string },
    audit?: CapabilityAudit
  ): Promise<WithdrawalRecord> {
    return withTenantTransaction(this.appPool, programTenantId, async (c) => {
      const cur = await c.query<Row>(`SELECT * FROM capability_withdrawals WHERE id = $1`, [
        input.id,
      ]);
      const row = cur.rows[0];
      if (!row) throw new CapabilityRequestError('Withdrawal not found');
      if (row.lifted_at) throw new CapabilityRequestError('Withdrawal already lifted');
      if (row.withdrawn_by_user_id === input.userId) throw new CapabilityFourEyesError();
      const r = await c.query<Row>(
        `UPDATE capability_withdrawals
            SET lifted_by_user_id = $2, lifted_at = now(), lift_reason = $3
          WHERE id = $1 AND lifted_at IS NULL RETURNING *`,
        [input.id, input.userId, input.reason.trim()]
      );
      if (!r.rows[0]) throw new CapabilityRequestError('Withdrawal already lifted');
      await audit?.(c, input.id);
      return toRecord(r.rows[0]);
    });
  }

  private validate(
    market: string,
    capability: string
  ): { market: Market; capability: CapabilityKey } {
    if (!isMarket(market)) throw new CapabilityRequestError('Unknown market');
    if (!isCapabilityKey(capability)) throw new CapabilityRequestError('Unknown capability');
    return { market, capability };
  }
}
