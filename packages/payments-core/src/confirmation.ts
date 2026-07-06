import { withTenantTransaction, type Pool } from '@fluvia/db';
import type { PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { InvalidStateTransitionError, PaymentIntentNotFoundError } from './errors.js';
import type { IntentStatus } from './fsm.js';
import type { PaymentProvider } from './provider.js';
import { CircuitOpenError } from './resilience.js';
import type { FeeSchedule } from './pricing.js';
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
 * Fee de plataforma: el servicio recibe un FeeSchedule inyectado (5.o param,
 * requerido) y devenga Ff = fees.platformFee(monto) en cada captura. Produccion
 * usa FlatBpsFeeSchedule(PLATFORM_FEE_BPS) (2% por PEND-002/decision #25); los
 * tests usan ZERO_FEE_SCHEDULE. Sin default silencioso: omitirlo es un error de
 * compilacion, no un fee-cero accidental (perdida de ingresos en produccion).
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
    private readonly provider: PaymentProvider,
    /** Motor de fees (F4-05c): calcula el fee de plataforma en la captura.
     * Requerido para no arriesgar un fee=0 silencioso en producción. */
    private readonly fees: FeeSchedule
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
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Circuito abierto (F3-04): la peticion JAMAS se envio, el desenlace
        // es CONOCIDO — fallo limpio sin ambiguedad ni asiento.
        await this.recordDeclined(
          tenantId,
          attemptId,
          row.intent_id,
          'circuit_open',
          'provider_unavailable'
        );
        return;
      }
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
      await this.recordApproved(tenantId, attemptId, row, outcome.providerRef);
      return;
    }

    if (outcome.outcome === 'declined') {
      await this.recordDeclined(
        tenantId,
        attemptId,
        row.intent_id,
        outcome.providerRef,
        outcome.failureCode ?? 'declined'
      );
      return;
    }

    // pending (aceptado asincrono, p.ej. PSE): submitted — la resolucion
    // llega por webhook firmado via el inbox (resolveFromProvider).
    await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query(
        `UPDATE payment_attempts
         SET status = 'submitted', provider_ref = $2, updated_at = now()
         WHERE id = $1 AND status = 'submitting'`,
        [attemptId, outcome.providerRef]
      )
    );
  }

  /**
   * Resolucion por FUENTE VERIFICADA (F3-03b): la unica via legitima para
   * cerrar attempts `submitted` (asincronos) o `indeterminate` (V4 §23).
   * La llama el handler del inbox tras verificar firma + dedup + schema.
   * Devuelve el outcome del contrato del inbox:
   *  - applied: attempt e intent resueltos (con captura atomica si aprobo).
   *  - ignored_out_of_order: el attempt ya es terminal (webhook tardio).
   *  - ignored: attempt inexistente para este tenant/proveedor/referencia.
   */
  async resolveFromProvider(
    tenantId: string,
    input: {
      attemptId: string;
      providerRef: string;
      result: 'succeeded' | 'failed';
      failureCode?: string;
    }
  ): Promise<'applied' | 'ignored_out_of_order' | 'ignored'> {
    const att = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<{
        status: string;
        provider_ref: string | null;
        intent_id: string;
        amount: string;
        currency: string;
        merchant_id: string;
      }>(
        `SELECT a.status, a.provider_ref, a.intent_id, a.amount::text, a.currency, i.merchant_id
         FROM payment_attempts a
         JOIN payment_intents i ON i.id = a.intent_id
         WHERE a.id = $1 AND a.provider = $2`,
        [input.attemptId, this.provider.name]
      )
    );
    const row = att.rows[0];
    if (!row) return 'ignored';
    // La referencia debe coincidir; un attempt indeterminate por timeout
    // puede no tenerla aun (el webhook la aporta).
    if (row.provider_ref !== null && row.provider_ref !== input.providerRef) return 'ignored';
    if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'expired') {
      return 'ignored_out_of_order';
    }
    if (row.status !== 'submitted' && row.status !== 'indeterminate') {
      // submitting/created: la fase 2 sigue en vuelo; el retry del inbox
      // volvera a intentarlo (backoff) en lugar de perder el evento.
      throw new Error(`attempt ${input.attemptId} still ${row.status}; retry later`);
    }

    if (input.result === 'succeeded') {
      await this.recordApproved(tenantId, input.attemptId, row, input.providerRef);
    } else {
      await this.recordDeclined(
        tenantId,
        input.attemptId,
        row.intent_id,
        input.providerRef,
        input.failureCode ?? 'declined'
      );
    }
    return 'applied';
  }

  /** Asiento + attempt + intent + amount_captured: UNA transaccion (onPosted). */
  private async recordApproved(
    tenantId: string,
    attemptId: string,
    row: { intent_id: string; amount: string; currency: string; merchant_id: string },
    providerRef: string
  ): Promise<void> {
    const amount = Money.of(row.amount, row.currency);
    await this.posting.capturePayment({
      tenantId,
      merchantId: row.merchant_id,
      // Misma key que la via sincrona: doble procesamiento => replay, 1 asiento.
      idempotencyKey: `attempt:${attemptId}:capture`,
      sourceType: 'payment_attempt',
      sourceId: attemptId,
      amount,
      // F4-05c: el fee de plataforma (Ff) se calcula por el motor de fees (2% por
      // PEND-002). Fp (fee del proveedor) es 0 en sandbox; el margen de Fluvia es
      // Ff. La captura credita platform.fees = Ff y merchant.pending = M − Ff.
      platformFee: this.fees.platformFee(amount),
      onPosted: async (client) => {
        await client.query(
          `UPDATE payment_attempts
           SET status = 'succeeded', provider_ref = $2, resolved_at = now(), updated_at = now()
           WHERE id = $1`,
          [attemptId, providerRef]
        );
        await this.intents.transitionIn(client, row.intent_id, 'succeeded');
        await client.query(`UPDATE payment_intents SET amount_captured = amount WHERE id = $1`, [
          row.intent_id,
        ]);
      },
    });
  }

  private async recordDeclined(
    tenantId: string,
    attemptId: string,
    intentId: string,
    providerRef: string,
    failureCode: string
  ): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, async (c) => {
      await c.query(
        `UPDATE payment_attempts
         SET status = 'failed', provider_ref = $2, last_error = $3, resolved_at = now(), updated_at = now()
         WHERE id = $1`,
        [attemptId, providerRef, failureCode]
      );
      await this.intents.transitionIn(c, intentId, 'failed', { failureCode });
    });
  }
}
