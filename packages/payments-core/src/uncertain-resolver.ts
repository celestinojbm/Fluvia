import { withTenantTransaction, type Pool } from '@fluvia/db';
import type { PaymentConfirmationService } from './confirmation.js';
import type { PaymentProvider } from './provider.js';
import type { RefundService } from './refunds.js';

export interface UncertainResolution {
  attempts: { resolved: number; stillUncertain: number };
  refunds: { resolved: number; stillUncertain: number };
}

/**
 * Resolución de cobros y devoluciones INCIERTOS por consulta verificable al
 * proveedor (`queryPayment` / `queryRefund`). Nunca concluye por suposición:
 *  - el proveedor conoce la operación ⇒ se aplica su resultado por el mismo
 *    camino que un webhook verificado (`resolveFromProvider`);
 *  - no la conoce, responde `pending` o no responde ⇒ sigue incierta (con sus
 *    fondos retenidos) y vuelve a intentarse en la siguiente pasada.
 * Cierra el hueco declarado de las devoluciones indeterminadas (F3-08).
 */
export class UncertainPaymentResolver {
  constructor(
    private readonly appPool: Pool,
    private readonly provider: PaymentProvider,
    private readonly confirmation: PaymentConfirmationService,
    private readonly refunds: RefundService
  ) {}

  /** Ids inciertos del tenant (para mostrar la cola y para resolver). */
  async listUncertain(tenantId: string): Promise<{
    attempts: { id: string; ageSeconds: number }[];
    refunds: { id: string; ageSeconds: number }[];
  }> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const a = await c.query<{ id: string; age: string }>(
        `SELECT id, EXTRACT(EPOCH FROM now() - updated_at)::bigint::text AS age FROM payment_attempts
          WHERE tenant_id = $1 AND provider = $2 AND status = 'indeterminate'
          ORDER BY updated_at LIMIT 200`,
        [tenantId, this.provider.name]
      );
      const r = await c.query<{ id: string; age: string }>(
        `SELECT id, EXTRACT(EPOCH FROM now() - updated_at)::bigint::text AS age FROM refunds
          WHERE tenant_id = $1 AND provider = $2 AND status IN ('processing', 'indeterminate')
          ORDER BY updated_at LIMIT 200`,
        [tenantId, this.provider.name]
      );
      return {
        attempts: a.rows.map((x) => ({ id: x.id, ageSeconds: Number(x.age) })),
        refunds: r.rows.map((x) => ({ id: x.id, ageSeconds: Number(x.age) })),
      };
    });
  }

  async resolveTenant(tenantId: string): Promise<UncertainResolution> {
    const out: UncertainResolution = {
      attempts: { resolved: 0, stillUncertain: 0 },
      refunds: { resolved: 0, stillUncertain: 0 },
    };
    const queue = await this.listUncertain(tenantId);
    for (const { id } of queue.attempts) {
      const verdict = this.provider.queryPayment
        ? await this.provider.queryPayment(id).catch(() => null)
        : null;
      if (!verdict || verdict.outcome === 'pending') {
        out.attempts.stillUncertain++;
        continue;
      }
      const applied = await this.confirmation.resolveFromProvider(tenantId, {
        attemptId: id,
        providerRef: verdict.providerRef,
        result: verdict.outcome === 'approved' ? 'succeeded' : 'failed',
        ...(verdict.failureCode ? { failureCode: verdict.failureCode } : {}),
      });
      if (applied === 'applied') out.attempts.resolved++;
      else out.attempts.stillUncertain++;
    }
    for (const { id } of queue.refunds) {
      const verdict = this.provider.queryRefund
        ? await this.provider.queryRefund(id).catch(() => null)
        : null;
      if (!verdict || verdict.outcome === 'pending') {
        out.refunds.stillUncertain++;
        continue;
      }
      const applied = await this.refunds
        .resolveFromProvider(tenantId, {
          refundId: id,
          result: verdict.outcome === 'approved' ? 'succeeded' : 'failed',
          providerRef: verdict.providerRef,
          ...(verdict.failureCode ? { failureCode: verdict.failureCode } : {}),
        })
        .catch(() => 'ignored' as const);
      if (applied === 'applied') out.refunds.resolved++;
      else out.refunds.stillUncertain++;
    }
    return out;
  }
}
