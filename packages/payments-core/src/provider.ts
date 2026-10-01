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
  /** Nombre comercial del cobrador (descriptor para el emisor; opcional). */
  merchantDescriptor?: string;
  /** Referencia opaca del comercio (tenant:merchant) para el emisor. */
  merchantRef?: string;
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

export interface SubmitPayoutInput {
  payoutId: string;
  /** Unidades menores, como string decimal. */
  amount: string;
  currency: string;
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
  /**
   * Payout al banco del comercio (F4-07). Mismas reglas que submitPayment:
   * SIEMPRE fuera de tx; un throw = desenlace DESCONOCIDO (el payout queda
   * `indeterminate` con los fondos retenidos en tránsito hasta fuente
   * verificada). Opcional: un adapter sin payouts hace fallar la config del
   * PayoutService.
   */
  submitPayout?(input: SubmitPayoutInput): Promise<ProviderOutcome>;
  /**
   * Consulta VERIFICABLE del resultado de un cobro (jornada integral). Es la
   * fuente que permite cerrar un attempt `indeterminate` sin suponer nada:
   * `null` = el proveedor no conoce la operación (sigue incierto). Fuera de tx;
   * un throw = la consulta tampoco respondió (sigue incierto).
   */
  queryPayment?(attemptId: string): Promise<ProviderOutcome | null>;
  /** Ídem para devoluciones `processing`/`indeterminate` (cierra el hueco de F3-08). */
  queryRefund?(refundId: string): Promise<ProviderOutcome | null>;
}

/**
 * Registro del «sistema externo» de un proveedor SIMULADO: lo que decidió de
 * verdad, para que una consulta posterior a un timeout devuelva la verdad del
 * proveedor y no una suposición. Implementación sobre PostgreSQL en
 * `SqlProviderOperationStore` (tabla `sandbox_provider_operations`, 0052).
 */
export interface ProviderOperationStore {
  record(
    provider: string,
    operation: 'payment' | 'refund' | 'payout' | 'withdrawal' | 'funding',
    operationRef: string,
    decision: ProviderOutcome
  ): Promise<ProviderOutcome>;
  find(
    provider: string,
    operation: 'payment' | 'refund' | 'payout' | 'withdrawal' | 'funding',
    operationRef: string
  ): Promise<ProviderOutcome | null>;
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
 *   tok_approve_refund_timeout -> aprobado; sus DEVOLUCIONES se ejecutan y la
 *                                respuesta se pierde (devolución incierta)
 *   cualquier otro            -> rechazado invalid_payment_method
 *
 * Con un `ProviderOperationStore` (opcional), el simulado REGISTRA cada
 * decisión — también la de un timeout, que ejecuta el cobro y pierde la
 * respuesta — y responde `queryPayment`/`queryRefund` con esa verdad. Sin
 * store se comporta exactamente como antes (sin consultas).
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly queryPayment?: (attemptId: string) => Promise<ProviderOutcome | null>;
  readonly queryRefund?: (refundId: string) => Promise<ProviderOutcome | null>;

  constructor(private readonly store?: ProviderOperationStore) {
    if (store) {
      this.queryPayment = (attemptId) => store.find(this.name, 'payment', attemptId);
      this.queryRefund = (refundId) => store.find(this.name, 'refund', refundId);
    }
  }

  private async keep(
    operation: 'payment' | 'refund' | 'payout',
    ref: string,
    decision: ProviderOutcome
  ): Promise<ProviderOutcome> {
    return this.store ? this.store.record(this.name, operation, ref, decision) : decision;
  }

  async submitPayment(input: SubmitPaymentInput): Promise<ProviderOutcome> {
    const providerRef = `mock_${createHash('sha256').update(input.attemptId).digest('hex').slice(0, 24)}`;
    if (this.store) {
      if (input.paymentMethodToken === 'tok_timeout') {
        // El proveedor EJECUTA el cobro y la respuesta se pierde.
        await this.keep('payment', input.attemptId, { outcome: 'approved', providerRef });
        throw new ProviderTimeoutError(this.name);
      }
      return this.keep('payment', input.attemptId, await this.decide(input, providerRef));
    }
    return this.decide(input, providerRef);
  }

  private decide(input: SubmitPaymentInput, providerRef: string): Promise<ProviderOutcome> {
    switch (input.paymentMethodToken) {
      case 'tok_approve':
        return Promise.resolve({ outcome: 'approved', providerRef });
      case 'tok_approve_refund_timeout':
        return Promise.resolve({
          outcome: 'approved',
          providerRef: `mockrt_${providerRef.slice('mock_'.length)}`,
        });
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
  async refundPayment(input: RefundPaymentInput): Promise<ProviderOutcome> {
    const providerRef = `mockr_${createHash('sha256').update(input.refundId).digest('hex').slice(0, 24)}`;
    const decision = await this.keep('refund', input.refundId, {
      outcome: 'approved',
      providerRef,
    });
    if (input.chargeProviderRef?.startsWith('mockrt_')) {
      // Cargo de prueba «tok_approve_refund_timeout»: la devolución se EJECUTA
      // y la respuesta se pierde (desenlace desconocido para quien llama).
      throw new ProviderTimeoutError(this.name);
    }
    return decision;
  }

  /**
   * Payouts del sandbox: siempre aprobados (el banco confirma; las ramas
   * declined/timeout/pending se prueban con adapters inyectados, como refunds).
   * Deterministico: mismo payout -> misma referencia.
   */
  submitPayout(input: SubmitPayoutInput): Promise<ProviderOutcome> {
    const providerRef = `mockp_${createHash('sha256').update(input.payoutId).digest('hex').slice(0, 24)}`;
    return this.keep('payout', input.payoutId, { outcome: 'approved', providerRef });
  }
}
