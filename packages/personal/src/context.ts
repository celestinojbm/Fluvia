import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { isRetryableLedgerError } from '@fluvia/ledger';
import type { AuditContext } from '@fluvia/audit';

/**
 * Transacción del programa. Fija el tenant (organización programa) y, en el
 * plano del cliente, `app.consumer_id`: la RLS de 0052 restringe entonces cada
 * fila al propio cliente (defensa en profundidad además del filtro del
 * servicio). El plano de operación pasa `consumerId = null`.
 *
 * Reintenta la transacción COMPLETA ante contención del ledger (deadlock,
 * lock timeout, versión optimista): el dominio y el asiento comparten COMMIT.
 */
export async function withProgramTx<T>(
  pool: Pool,
  tenantId: string,
  consumerId: string | null,
  fn: (c: PoolClient) => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 15 * 2 ** attempt + Math.random() * 25));
    }
    try {
      return await withTenantTransaction(pool, tenantId, async (c) => {
        if (consumerId) {
          await c.query(`SELECT set_config('app.consumer_id', $1, true)`, [consumerId]);
        }
        return fn(c);
      });
    } catch (err) {
      if (!isRetryableLedgerError(err)) throw err;
      last = err;
    }
  }
  throw last;
}

/** Actor de una operación del programa. */
export type ProgramActor =
  | { kind: 'consumer'; consumerId: string; audit?: Partial<AuditContext> }
  | { kind: 'operator'; userId: string; audit?: Partial<AuditContext> }
  | { kind: 'system'; audit?: Partial<AuditContext> };

export function auditContextOf(actor: ProgramActor): AuditContext {
  switch (actor.kind) {
    case 'consumer':
      return {
        actorType: 'consumer',
        actorId: actor.consumerId,
        authMethod: 'consumer_session',
        ...actor.audit,
      };
    case 'operator':
      return { actorType: 'user', actorId: actor.userId, authMethod: 'session', ...actor.audit };
    case 'system':
      return { actorType: 'system', authMethod: 'none', ...actor.audit };
  }
}

/** Ámbito de cliente de la transacción según el actor. */
export function consumerScope(actor: ProgramActor): string | null {
  return actor.kind === 'consumer' ? actor.consumerId : null;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

export function engineMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? '';
}

export function toBig(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  return BigInt(v);
}
