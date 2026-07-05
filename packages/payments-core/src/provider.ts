import { createHash } from 'node:crypto';

/**
 * Contrato de adapter de proveedor de pagos (F3-03).
 *
 * Reglas para TODA implementacion:
 *  - submitPayment se llama SIEMPRE fuera de una transaccion SQL (Nivel A).
 *  - Un throw significa RESULTADO DESCONOCIDO: el attempt pasa a
 *    `indeterminate` y SOLO se resuelve por fuente verificada — consulta al
 *    proveedor, webhook o conciliacion; jamas por asuncion (V4 §23).
 *  - Resultado `pending` (aceptado asincrono, tipo PSE) llega con F3-03b
 *    junto al primer handler real del inbox; el tipo ya lo contempla.
 */

export interface SubmitPaymentInput {
  attemptId: string;
  /** Unidades menores, como string decimal. */
  amount: string;
  currency: string;
  paymentMethodToken: string;
}

export interface ProviderOutcome {
  outcome: 'approved' | 'declined' | 'pending';
  /** Referencia del proveedor (conciliacion y dedup de webhooks). */
  providerRef: string;
  /** Codigo de fallo estable cuando outcome=declined. */
  failureCode?: string;
}

export interface RefundPaymentInput {
  refundId: string;
  /** Unidades menores, como string decimal. */
  amount: string;
  currency: string;
  /** Referencia del cargo original en el proveedor (attempt succeeded). */
  chargeProviderRef: string | null;
}

export interface PaymentProvider {
  readonly name: string;
  submitPayment(input: SubmitPaymentInput): Promise<ProviderOutcome>;
  /**
   * Refund contra el proveedor (F3-08). Mismas reglas que submitPayment:
   * SIEMPRE fuera de tx; un throw = desenlace DESCONOCIDO (el refund queda
   * `processing` con la reserva contable retenida hasta fuente verificada).
   * Opcional: un adapter sin refunds hace fallar la config del RefundService.
   */
  refundPayment?(input: RefundPaymentInput): Promise<ProviderOutcome>;
}

export class ProviderTimeoutError extends Error {
  constructor(provider: string) {
    super(`Payment provider ${provider} timed out: outcome UNKNOWN (indeterminate)`);
    this.name = 'ProviderTimeoutError';
  }
}

/**
 * Proveedor simulado del sandbox (tokenizacion simulada: el token ES la
 * instruccion, como las tarjetas de prueba de cualquier PSP). Deterministico:
 * mismo attempt -> misma referencia. Fallas inyectables por token:
 *
 *   tok_approve               -> aprobado sincrono
 *   tok_decline               -> rechazado card_declined
 *   tok_decline_insufficient  -> rechazado insufficient_funds
 *   tok_pse                   -> pending (asincrono; resuelve via webhook)
 *   tok_timeout               -> ProviderTimeoutError (indeterminado)
 *   cualquier otro            -> rechazado invalid_payment_method
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  submitPayment(input: SubmitPaymentInput): Promise<ProviderOutcome> {
    const providerRef = `mock_${createHash('sha256').update(input.attemptId).digest('hex').slice(0, 24)}`;
    switch (input.paymentMethodToken) {
      case 'tok_approve':
        return Promise.resolve({ outcome: 'approved', providerRef });
      case 'tok_decline':
        return Promise.resolve({ outcome: 'declined', providerRef, failureCode: 'card_declined' });
      case 'tok_decline_insufficient':
        return Promise.resolve({
          outcome: 'declined',
          providerRef,
          failureCode: 'insufficient_funds',
        });
      case 'tok_pse':
        // Metodo asincrono tipo PSE (Colombia): el proveedor acepta y el
        // resultado llega despues por webhook firmado (F3-03b).
        return Promise.resolve({ outcome: 'pending', providerRef });
      case 'tok_timeout':
        return Promise.reject(new ProviderTimeoutError(this.name));
      default:
        return Promise.resolve({
          outcome: 'declined',
          providerRef,
          failureCode: 'invalid_payment_method',
        });
    }
  }

  /**
   * Refunds del sandbox: siempre aprobados (los rechazos de refund son raros
   * en PSPs reales; las ramas declined/timeout se prueban con adapters
   * inyectados). Deterministico: mismo refund -> misma referencia.
   */
  refundPayment(input: RefundPaymentInput): Promise<ProviderOutcome> {
    const providerRef = `mockr_${createHash('sha256').update(input.refundId).digest('hex').slice(0, 24)}`;
    return Promise.resolve({ outcome: 'approved', providerRef });
  }
}
