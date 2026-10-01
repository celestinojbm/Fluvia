import type { Pool } from '@fluvia/db';
import type { ProviderOperationStore, ProviderOutcome } from './provider.js';

type Operation = 'payment' | 'refund' | 'payout' | 'withdrawal' | 'funding';

/**
 * `ProviderOperationStore` sobre `sandbox_provider_operations` (0052): el
 * «sistema externo» de los proveedores SIMULADOS. Primera decisión gana (la
 * historia del proveedor no se reescribe: sin UPDATE para la app).
 */
export class SqlProviderOperationStore implements ProviderOperationStore {
  constructor(private readonly appPool: Pool) {}

  async record(
    provider: string,
    operation: Operation,
    operationRef: string,
    decision: ProviderOutcome
  ): Promise<ProviderOutcome> {
    const res = await this.appPool.query<{
      outcome: ProviderOutcome['outcome'];
      provider_ref: string;
      failure_code: string | null;
    }>(
      `WITH ins AS (
         INSERT INTO sandbox_provider_operations
           (provider, operation, operation_ref, outcome, provider_ref, failure_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider, operation, operation_ref) DO NOTHING
         RETURNING outcome, provider_ref, failure_code)
       SELECT outcome, provider_ref, failure_code FROM ins
       UNION ALL
       SELECT outcome, provider_ref, failure_code FROM sandbox_provider_operations
        WHERE provider = $1 AND operation = $2 AND operation_ref = $3
       LIMIT 1`,
      [
        provider,
        operation,
        operationRef,
        decision.outcome,
        decision.providerRef,
        decision.failureCode ?? null,
      ]
    );
    return toOutcome(res.rows[0]!);
  }

  async find(
    provider: string,
    operation: Operation,
    operationRef: string
  ): Promise<ProviderOutcome | null> {
    const res = await this.appPool.query<{
      outcome: ProviderOutcome['outcome'];
      provider_ref: string;
      failure_code: string | null;
    }>(
      `SELECT outcome, provider_ref, failure_code FROM sandbox_provider_operations
        WHERE provider = $1 AND operation = $2 AND operation_ref = $3`,
      [provider, operation, operationRef]
    );
    return res.rows[0] ? toOutcome(res.rows[0]) : null;
  }
}

function toOutcome(r: {
  outcome: ProviderOutcome['outcome'];
  provider_ref: string;
  failure_code: string | null;
}): ProviderOutcome {
  return {
    outcome: r.outcome,
    providerRef: r.provider_ref,
    ...(r.failure_code ? { failureCode: r.failure_code } : {}),
  };
}
