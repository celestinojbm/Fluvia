import { withTenantTransaction, type Pool } from '@fluvia/db';
import type { PaymentConfirmationService } from './confirmation.js';
import type { PaymentProvider, ProviderOutcome } from './provider.js';
import type { RefundService } from './refunds.js';

/** Respuesta de una consulta: la del proveedor, «no la conoce» o «no respondió». */
export type VerificationVerdict = 'approved' | 'declined' | 'pending' | 'unknown' | 'no_response';

/** Persona que pide la consulta (null = automática). */
export interface VerificationActor {
  userId: string;
  role: 'merchant' | 'operator';
}

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

  /**
   * Una pasada sobre la cola del tenant. `by` = persona del comercio que la
   * pidió (null = automática, worker). Cada consulta queda en la bitácora
   * `uncertain_verifications` (0067) con su veredicto.
   */
  async resolveTenant(
    tenantId: string,
    by: VerificationActor | null = null
  ): Promise<UncertainResolution> {
    const out: UncertainResolution = {
      attempts: { resolved: 0, stillUncertain: 0 },
      refunds: { resolved: 0, stillUncertain: 0 },
    };
    const queue = await this.listUncertain(tenantId);
    for (const { id } of queue.attempts) {
      const r = await this.verifyAttempt(tenantId, id, by);
      if (r.applied) out.attempts.resolved++;
      else out.attempts.stillUncertain++;
    }
    for (const { id } of queue.refunds) {
      const r = await this.verifyRefund(tenantId, id, by);
      if (r.applied) out.refunds.resolved++;
      else out.refunds.stillUncertain++;
    }
    return out;
  }

  /** Consulta verificable de UN cobro incierto; aplica solo lo que el proveedor afirma. */
  async verifyAttempt(
    tenantId: string,
    attemptId: string,
    by: VerificationActor | null = null
  ): Promise<{ verdict: VerificationVerdict; applied: boolean }> {
    const { verdict, result } = await this.ask(() =>
      this.provider.queryPayment ? this.provider.queryPayment(attemptId) : Promise.resolve(null)
    );
    let applied = false;
    if (result && (verdict === 'approved' || verdict === 'declined')) {
      applied =
        (await this.confirmation.resolveFromProvider(tenantId, {
          attemptId,
          providerRef: result.providerRef,
          result: verdict === 'approved' ? 'succeeded' : 'failed',
          ...(result.failureCode ? { failureCode: result.failureCode } : {}),
        })) === 'applied';
    }
    await this.log(tenantId, 'payment_attempt', attemptId, verdict, applied, by);
    return { verdict, applied };
  }

  /** Consulta verificable de UNA devolución incierta. */
  async verifyRefund(
    tenantId: string,
    refundId: string,
    by: VerificationActor | null = null
  ): Promise<{ verdict: VerificationVerdict; applied: boolean }> {
    const { verdict, result } = await this.ask(() =>
      this.provider.queryRefund ? this.provider.queryRefund(refundId) : Promise.resolve(null)
    );
    let applied = false;
    if (result && (verdict === 'approved' || verdict === 'declined')) {
      applied =
        (await this.refunds
          .resolveFromProvider(tenantId, {
            refundId,
            result: verdict === 'approved' ? 'succeeded' : 'failed',
            providerRef: result.providerRef,
            ...(result.failureCode ? { failureCode: result.failureCode } : {}),
          })
          .catch(() => 'ignored' as const)) === 'applied';
    }
    await this.log(tenantId, 'refund', refundId, verdict, applied, by);
    return { verdict, applied };
  }

  private async ask(
    q: () => Promise<ProviderOutcome | null>
  ): Promise<{ verdict: VerificationVerdict; result: ProviderOutcome | null }> {
    try {
      const result = await q();
      if (!result) return { verdict: 'unknown', result: null };
      return { verdict: result.outcome, result };
    } catch {
      return { verdict: 'no_response', result: null };
    }
  }

  private async log(
    tenantId: string,
    subjectType: 'payment_attempt' | 'refund',
    subjectId: string,
    verdict: VerificationVerdict,
    applied: boolean,
    by: VerificationActor | null
  ): Promise<void> {
    // Las pasadas AUTOMÁTICAS repiten la misma consulta cada ciclo: se anota
    // el cambio de veredicto o, si no cambia, una vez cada 10 minutos. Las
    // pedidas por una persona se anotan siempre.
    await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query(
        `INSERT INTO uncertain_verifications
           (tenant_id, subject_type, subject_id, verdict, applied, triggered_by, actor_user_id)
         SELECT $1, $2, $3, $4, $5, $6, $7
          WHERE $6 <> 'automatic' OR $5 OR NOT EXISTS (
            SELECT 1 FROM uncertain_verifications v
             WHERE v.tenant_id = $1 AND v.subject_type = $2 AND v.subject_id = $3
               AND v.verdict = $4 AND v.checked_at > now() - interval '10 minutes')`,
        [
          tenantId,
          subjectType,
          subjectId,
          verdict,
          applied,
          by ? (by.role === 'operator' ? 'operator_user' : 'merchant_user') : 'automatic',
          by?.userId ?? null,
        ]
      )
    );
  }
}
