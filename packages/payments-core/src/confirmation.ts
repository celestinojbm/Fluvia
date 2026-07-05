import { withTenantTransaction, type Pool } from '@fluvia/db';
import type { PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { InvalidStateTransitionError, PaymentIntentNotFoundError } from './errors.js';
import type { IntentStatus } from './fsm.js';
import type { PaymentProvider } from './provider.js';
import type { PaymentIntentDto, PaymentIntentService, TxClient } from './service.js';

/**
 * Confirmacion de payment intents (F3-03, dos fases — V4 Nivel A):
 *
 *   Fase 1 (beginIn, DENTRO de la tx de la idempotency key): el intent avanza
 *   por la FSM hasta `processing` y nace el attempt en `submitting`. La
 *   respuesta del endpoint ES este estado: confirmar es asincrono por
 *   contrato (el replay devuelve exactamente lo mismo).
 *
 *   Fase 2 (execute, FUERA de toda tx): submitPayment al proveedor; el
 *   resultado se registra en UNA transaccion:
 *     aprobado  -> asiento contable capturePayment + attempt succeeded +
 *                  intent succeeded + amount_captured (composicion atomica
 *                  via onPosted: o entra TODO o no entra nada).
 *     rechazado -> attempt failed + intent failed (failure_code); sin asiento.
 *     throw     -> attempt INDETERMINATE; el intent queda processing. Nada lo
 *                  resuelve por asuncion (V4 §23): solo webhook/consulta/
 *                  conciliacion (F3-03b/F4). Crash entre fases => attempt en
 *                  submitting; el barrido a indeterminate llega con F3-04.
 *
 * Fees en 0 en sandbox: el pricing es decision humana abierta (PEND-002);
 * inventar fees seria simular un modelo comercial inexistente.
 */

const CONFIRM_PATHS: Partial<Record<IntentStatus, IntentStatus[]>> = {
  created: ['requires_payment_method', 'requires_confirmation', 'processing'],
  requires_payment_method: ['requires_confirmation', 'processing'],
  requires_confirmation: ['processing'],
};

export interface ConfirmBeginResult {
  intent: PaymentIntentDto;
  attemptId: string;
}

export class PaymentConfirmationService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    private readonly intents: PaymentIntentService,
    private readonly posting: PostingService,
    private readonly provider: PaymentProvider
  ) {}

  /** Fase 1 — client-bound: compone con la capa de idempotencia (F2-09). */
  async beginIn(c: TxClient, tenantId: string, intentId: string): Promise<ConfirmBeginResult> {
    const cur = await c.query<{ status: IntentStatus; amount: string; currency: string }>(
      `SELECT status, amount::text, currency FROM payment_intents WHERE id = $1 FOR UPDATE`,
      [intentId]
    );
    const row = cur.rows[0];
    if (!row) throw new PaymentIntentNotFoundError();
    const steps = CONFIRM_PATHS[row.status];
    if (!steps) throw new InvalidStateTransitionError(row.status, 'processing');

    let intent: PaymentIntentDto | undefined;
    for (const to of steps) {
      intent = await this.intents.transitionIn(c, intentId, to);
    }

    const attempt = await c.query<{ id: string }>(
      `INSERT INTO payment_attempts (tenant_id, intent_id, attempt_number, provider, status, amount, currency)
       SELECT $1, $2, COALESCE(MAX(attempt_number), 0) + 1, $3, 'created', $4, $5
       FROM payment_attempts WHERE intent_id = $2
       RETURNING id`,
      [tenantId, intentId, this.provider.name, row.amount, row.currency]
    );
    const attemptId = attempt.rows[0]!.id;
    // created -> submitting: transicion validada por el trigger del motor.
    await c.query(
      `UPDATE payment_attempts SET status = 'submitting', updated_at = now(), submitted_at = now()
       WHERE id = $1`,
      [attemptId]
    );
    return { intent: intent!, attemptId };
  }

  /** Fase 2 — proveedor fuera de tx; registro atomico del resultado. */
  async execute(tenantId: string, attemptId: string, paymentMethodToken: string): Promise<void> {
    const att = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<{
        intent_id: string;
        amount: string;
        currency: string;
        merchant_id: string;
      }>(
        `SELECT a.intent_id, a.amount::text, a.currency, i.merchant_id
         FROM payment_attempts a
         JOIN payment_intents i ON i.id = a.intent_id
         WHERE a.id = $1 AND a.status = 'submitting'`,
        [attemptId]
      )
    );
    const row = att.rows[0];
    // Ya resuelto (reintento tras crash) o inexistente: no hay nada que hacer.
    if (!row) return;

    let outcome;
    try {
      outcome = await this.provider.submitPayment({
        attemptId,
        amount: row.amount,
        currency: row.currency,
        paymentMethodToken,
      });
    } catch {
      // Resultado DESCONOCIDO: indeterminate. Resolucion SOLO por fuente
      // verificada (V4 §23) — jamas se marca failed "porque probablemente".
      await withTenantTransaction(this.appPool, tenantId, (c) =>
        c.query(
          `UPDATE payment_attempts
           SET status = 'indeterminate', updated_at = now(),
               last_error = 'provider unreachable/timeout: outcome unknown; awaiting verified resolution (V4 s23)'
           WHERE id = $1 AND status = 'submitting'`,
          [attemptId]
        )
      );
      return;
    }

    if (outcome.outcome === 'approved') {
      // Asiento + attempt + intent + amount_captured: UNA transaccion.
      await this.posting.capturePayment({
        tenantId,
        merchantId: row.merchant_id,
        idempotencyKey: `attempt:${attemptId}:capture`,
        sourceType: 'payment_attempt',
        sourceId: attemptId,
        amount: Money.of(row.amount, row.currency),
        onPosted: async (client) => {
          await client.query(
            `UPDATE payment_attempts
             SET status = 'succeeded', provider_ref = $2, resolved_at = now(), updated_at = now()
             WHERE id = $1`,
            [attemptId, outcome.providerRef]
          );
          await this.intents.transitionIn(client, row.intent_id, 'succeeded');
          await client.query(`UPDATE payment_intents SET amount_captured = amount WHERE id = $1`, [
            row.intent_id,
          ]);
        },
      });
      return;
    }

    if (outcome.outcome === 'declined') {
      await withTenantTransaction(this.appPool, tenantId, async (c) => {
        await c.query(
          `UPDATE payment_attempts
           SET status = 'failed', provider_ref = $2, last_error = $3, resolved_at = now(), updated_at = now()
           WHERE id = $1`,
          [attemptId, outcome.providerRef, outcome.failureCode ?? 'declined']
        );
        await this.intents.transitionIn(c, row.intent_id, 'failed', {
          failureCode: outcome.failureCode ?? 'declined',
        });
      });
      return;
    }

    // pending (aceptado asincrono): submitted — la resolucion llega por el
    // inbox (F3-03b). El mock aun no emite este outcome.
    await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query(
        `UPDATE payment_attempts
         SET status = 'submitted', provider_ref = $2, updated_at = now()
         WHERE id = $1 AND status = 'submitting'`,
        [attemptId, outcome.providerRef]
      )
    );
  }
}
