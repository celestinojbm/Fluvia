import { createHash } from 'node:crypto';
import type {
  PaymentProvider,
  ProviderOutcome,
  RefundPaymentInput,
  SubmitPaymentInput,
  SubmitPayoutInput,
} from '@fluvia/payments-core';
import { ProviderTimeoutError } from '@fluvia/payments-core';
import type { AuthorizationService } from './authorizations.js';
import { PAYMENT_CODE_PREFIX } from './cards.js';
import { PaymentCodeInvalidError } from './errors.js';

/**
 * Red Fluvia SIMULADA entre el lado adquirente (comercio) y el emisor (el
 * programa). En producción este puente es una red de tarjetas / un
 * procesador; aquí es una llamada en proceso con el MISMO contrato que un
 * proveedor real: respuesta aprobada/rechazada, referencia, devoluciones y
 * CONSULTA verificable del resultado. Permite inyectar la pérdida de la
 * respuesta para ensayar la incertidumbre (el emisor procesó; el comercio no
 * se enteró).
 */
export interface NetworkFaults {
  /** true ⇒ la respuesta de esa operación se pierde DESPUÉS de procesarse. */
  dropResponse?: (op: 'purchase' | 'refund', ref: string) => boolean;
}

export const NETWORK_REF_PREFIX = 'fnet_';

export class FluviaCardNetwork {
  constructor(
    private readonly programTenantId: string,
    private readonly authorizations: AuthorizationService,
    private readonly faults: NetworkFaults = {}
  ) {}

  /** Compra de un solo mensaje (autoriza + captura total) desde un checkout Fluvia. */
  async purchase(input: {
    attemptId: string;
    amount: bigint;
    currency: string;
    paymentCode: string;
    merchantName: string;
    merchantRef?: string;
  }): Promise<ProviderOutcome> {
    const networkRef = `acq:${input.attemptId}`;
    let result;
    try {
      result = await this.authorizations.authorize(this.programTenantId, {
        paymentCode: input.paymentCode,
        amount: input.amount,
        currency: input.currency,
        merchantName: input.merchantName,
        ...(input.merchantRef ? { merchantRef: input.merchantRef } : {}),
        networkRef,
        source: 'fluvia_checkout',
      });
    } catch (err) {
      if (err instanceof PaymentCodeInvalidError) {
        return {
          outcome: 'declined',
          providerRef: `${NETWORK_REF_PREFIX}${digest(networkRef)}`,
          failureCode: 'invalid_payment_code',
        };
      }
      throw err;
    }
    const outcome = await this.outcomeOf(networkRef, result.authorizationId, true);
    if (this.faults.dropResponse?.('purchase', input.attemptId)) {
      throw new ProviderTimeoutError('fluvia-network');
    }
    return outcome;
  }

  private async outcomeOf(
    networkRef: string,
    authorizationId: string | null,
    captureIfApproved: boolean
  ): Promise<ProviderOutcome> {
    const auth = authorizationId
      ? await this.authorizations.get(this.programTenantId, authorizationId, null)
      : await this.authorizations.findByNetworkRef(this.programTenantId, networkRef);
    if (!auth) {
      return {
        outcome: 'declined',
        providerRef: `${NETWORK_REF_PREFIX}${digest(networkRef)}`,
        failureCode: 'invalid_payment_code',
      };
    }
    const providerRef = `${NETWORK_REF_PREFIX}${auth.id}`;
    if (auth.status === 'declined') {
      return { outcome: 'declined', providerRef, failureCode: auth.declineCode ?? 'declined' };
    }
    if (captureIfApproved && (auth.status === 'approved' || auth.status === 'partially_captured')) {
      await this.authorizations.capture(this.programTenantId, auth.id, {
        amount: BigInt(auth.amount) - BigInt(auth.capturedWallet) - BigInt(auth.capturedCredit),
        idempotencyKey: `${networkRef}:capture`,
        final: true,
      });
    }
    return { outcome: 'approved', providerRef };
  }

  /** Consulta verificable: ¿qué hizo el emisor con este cobro? */
  async queryPurchase(attemptId: string): Promise<ProviderOutcome | null> {
    const networkRef = `acq:${attemptId}`;
    const auth = await this.authorizations.findByNetworkRef(this.programTenantId, networkRef);
    if (!auth) return null;
    // Compra de un solo mensaje: si el emisor autorizó pero la captura no
    // llegó a ocurrir, la consulta la completa (misma clave ⇒ idempotente).
    return this.outcomeOf(networkRef, auth.id, true);
  }

  async refund(input: {
    refundId: string;
    authorizationId: string;
    amount: bigint;
  }): Promise<ProviderOutcome> {
    await this.authorizations.refund(this.programTenantId, input.authorizationId, {
      amount: input.amount,
      idempotencyKey: `acq-refund:${input.refundId}`,
    });
    if (this.faults.dropResponse?.('refund', input.refundId)) {
      throw new ProviderTimeoutError('fluvia-network');
    }
    return { outcome: 'approved', providerRef: `${NETWORK_REF_PREFIX}r_${input.refundId}` };
  }

  async queryRefund(refundId: string): Promise<ProviderOutcome | null> {
    const ev = await this.authorizations.findEventByKey(
      this.programTenantId,
      null,
      `acq-refund:${refundId}`
    );
    return ev ? { outcome: 'approved', providerRef: `${NETWORK_REF_PREFIX}r_${refundId}` } : null;
  }
}

function digest(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 24);
}

/**
 * Proveedor de ENRUTAMIENTO del lado comercio. Transparente para el resto del
 * sistema (conserva el `name` del proveedor interno): los códigos `fcp_…` van
 * a la red Fluvia; cualquier otro token, al proveedor de siempre (MockProvider
 * en sandbox). Las devoluciones se enrutan por la referencia del cargo
 * (`fnet_…`), y las consultas de inciertos preguntan a ambos.
 */
export class FluviaRoutingProvider implements PaymentProvider {
  readonly name: string;

  constructor(
    private readonly inner: PaymentProvider,
    private readonly network: FluviaCardNetwork
  ) {
    this.name = inner.name;
  }

  submitPayment(input: SubmitPaymentInput): Promise<ProviderOutcome> {
    if (input.paymentMethodToken.startsWith(`${PAYMENT_CODE_PREFIX}_`)) {
      return this.network.purchase({
        attemptId: input.attemptId,
        amount: BigInt(input.amount),
        currency: input.currency,
        paymentCode: input.paymentMethodToken,
        merchantName: input.merchantDescriptor ?? 'Comercio Fluvia',
        ...(input.merchantRef ? { merchantRef: input.merchantRef } : {}),
      });
    }
    return this.inner.submitPayment(input);
  }

  refundPayment(input: RefundPaymentInput): Promise<ProviderOutcome> {
    if (input.chargeProviderRef?.startsWith(NETWORK_REF_PREFIX)) {
      return this.network.refund({
        refundId: input.refundId,
        authorizationId: input.chargeProviderRef.slice(NETWORK_REF_PREFIX.length),
        amount: BigInt(input.amount),
      });
    }
    if (!this.inner.refundPayment) throw new Error('inner provider has no refunds');
    return this.inner.refundPayment(input);
  }

  submitPayout(input: SubmitPayoutInput): Promise<ProviderOutcome> {
    if (!this.inner.submitPayout) throw new Error('inner provider has no payouts');
    return this.inner.submitPayout(input);
  }

  async queryPayment(attemptId: string): Promise<ProviderOutcome | null> {
    const fromNetwork = await this.network.queryPurchase(attemptId);
    if (fromNetwork) return fromNetwork;
    return this.inner.queryPayment ? this.inner.queryPayment(attemptId) : null;
  }

  async queryRefund(refundId: string): Promise<ProviderOutcome | null> {
    const fromNetwork = await this.network.queryRefund(refundId);
    if (fromNetwork) return fromNetwork;
    return this.inner.queryRefund ? this.inner.queryRefund(refundId) : null;
  }
}
