import { createHash, randomInt } from 'node:crypto';
import type { ProviderOperationStore } from '@fluvia/payments-core';

/**
 * Contratos de proveedores EXTERNOS del programa y sus implementaciones
 * SIMULADAS. Un proveedor real (banco de fondeo, emisor/procesador) implementa
 * el mismo contrato; nada del dominio depende del simulado.
 *
 * Regla común (como `PaymentProvider`): toda llamada ocurre FUERA de una
 * transacción SQL y un `throw` significa RESULTADO DESCONOCIDO — el recurso
 * queda incierto con sus fondos retenidos hasta una fuente verificada
 * (consulta, evento firmado o conciliación).
 */

export interface ProviderDecision {
  outcome: 'approved' | 'declined' | 'pending';
  providerRef: string;
  failureCode?: string;
}

export class ProviderUnavailableError extends Error {
  constructor(provider: string) {
    super(`Provider ${provider} did not answer: outcome UNKNOWN`);
    this.name = 'ProviderUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Fondeo y retiros
// ---------------------------------------------------------------------------
export interface FundingInstruction {
  providerRef: string;
  /** Lo que el cliente debe hacer en su banco (referencia a incluir, etc.). */
  instructions: { reference: string; text: string };
}

export interface FundingProviderAdapter {
  readonly name: string;
  createFundingInstruction(input: {
    fundingId: string;
    amount: string;
    currency: string;
    method: 'bank_transfer' | 'mobile_payment' | 'cash_agent';
  }): Promise<FundingInstruction>;
  submitWithdrawal(input: {
    transferId: string;
    amount: string;
    currency: string;
    destination: string;
  }): Promise<ProviderDecision>;
  /** Consulta verificable del resultado de un retiro (null = el proveedor no lo conoce). */
  queryWithdrawal(transferId: string): Promise<ProviderDecision | null>;
}

/**
 * Referencia opaca determinista SIN dígitos (alfabeto a–p): ninguna referencia
 * del emisor simulado puede parecerse a un número de tarjeta (el motor rechaza
 * 12+ dígitos seguidos en `cards.issuer_ref`).
 */
function ref(prefix: string, seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 24);
  const letters = [...hex].map((ch) => String.fromCharCode(97 + parseInt(ch, 16))).join('');
  return `${prefix}_${letters}`;
}

/**
 * Banco de fondeo SIMULADO. El destino del retiro es la instrucción de prueba
 * (como `tok_*` en pagos):
 *   sim:approve   → pagado
 *   sim:decline   → rechazado (`destination_rejected`)
 *   sim:pending   → aceptado, resultado posterior por evento
 *   sim:timeout   → el banco LO EJECUTA y la respuesta se pierde (incierto)
 *   sim:lost      → no llega al banco y la respuesta se pierde (incierto)
 */
export class SimulatedFundingProvider implements FundingProviderAdapter {
  readonly name = 'sim-funding';

  constructor(private readonly store: ProviderOperationStore) {}

  createFundingInstruction(input: {
    fundingId: string;
    amount: string;
    currency: string;
    method: string;
  }): Promise<FundingInstruction> {
    const providerRef = ref('simfund', input.fundingId);
    const reference = providerRef.slice(-10).toUpperCase();
    return Promise.resolve({
      providerRef,
      instructions: {
        reference,
        text: `Sandbox: no hay banco real. La confirmación llega como evento simulado del proveedor con la referencia ${reference}.`,
      },
    });
  }

  async submitWithdrawal(input: {
    transferId: string;
    destination: string;
  }): Promise<ProviderDecision> {
    const providerRef = ref('simwd', input.transferId);
    switch (input.destination) {
      case 'sim:approve':
        return this.store.record(this.name, 'withdrawal', input.transferId, {
          outcome: 'approved',
          providerRef,
        });
      case 'sim:decline':
        return this.store.record(this.name, 'withdrawal', input.transferId, {
          outcome: 'declined',
          providerRef,
          failureCode: 'destination_rejected',
        });
      case 'sim:pending':
        return this.store.record(this.name, 'withdrawal', input.transferId, {
          outcome: 'pending',
          providerRef,
        });
      case 'sim:timeout':
        await this.store.record(this.name, 'withdrawal', input.transferId, {
          outcome: 'approved',
          providerRef,
        });
        throw new ProviderUnavailableError(this.name);
      case 'sim:lost':
        throw new ProviderUnavailableError(this.name);
      default:
        return this.store.record(this.name, 'withdrawal', input.transferId, {
          outcome: 'declined',
          providerRef,
          failureCode: 'invalid_destination',
        });
    }
  }

  queryWithdrawal(transferId: string): Promise<ProviderDecision | null> {
    return this.store.find(this.name, 'withdrawal', transferId);
  }
}

// ---------------------------------------------------------------------------
// Emisión de tarjetas
// ---------------------------------------------------------------------------
export interface IssuedCardData {
  issuerRef: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface RevealSession {
  /** `iframe`: el emisor muestra PAN/CVV en SU componente; Fluvia nunca los ve. */
  mode: 'iframe' | 'unavailable';
  url: string | null;
  expiresAt: string | null;
  notice: string;
}

export interface CardIssuerAdapter {
  readonly name: string;
  issueCard(input: {
    cardId: string;
    consumerRef: string;
    form: 'virtual' | 'physical';
    currency: string;
  }): Promise<IssuedCardData>;
  setCardState(input: { issuerRef: string; state: 'active' | 'blocked' | 'closed' }): Promise<void>;
  createRevealSession(input: { issuerRef: string }): Promise<RevealSession>;
  requestShipment(input: {
    issuerRef: string;
    addressLine: string;
    city: string;
  }): Promise<{ shipmentRef: string }>;
}

/**
 * Emisor SIMULADO. No genera números de tarjeta: solo `last4` aleatorio y una
 * referencia opaca. La visualización de datos sensibles no está disponible en
 * sandbox (un emisor real la entrega por iframe/SDK propio, fuera del alcance
 * PCI de Fluvia).
 */
export class SimulatedCardIssuer implements CardIssuerAdapter {
  readonly name = 'sim-issuer';
  /** Estados que el emisor «tiene» (inspección en pruebas). */
  readonly states = new Map<string, string>();

  issueCard(input: { cardId: string }): Promise<IssuedCardData> {
    const now = new Date();
    const issuerRef = ref('simcard', input.cardId);
    this.states.set(issuerRef, 'active');
    return Promise.resolve({
      issuerRef,
      last4: String(randomInt(0, 10_000)).padStart(4, '0'),
      expMonth: now.getUTCMonth() + 1,
      expYear: now.getUTCFullYear() + 4,
    });
  }

  setCardState(input: { issuerRef: string; state: string }): Promise<void> {
    this.states.set(input.issuerRef, input.state);
    return Promise.resolve();
  }

  createRevealSession(): Promise<RevealSession> {
    return Promise.resolve({
      mode: 'unavailable',
      url: null,
      expiresAt: null,
      notice:
        'Entorno de prueba: los datos completos de la tarjeta los mostrará el emisor en su componente seguro. Fluvia no los almacena ni los ve.',
    });
  }

  requestShipment(input: { issuerRef: string }): Promise<{ shipmentRef: string }> {
    return Promise.resolve({ shipmentRef: ref('simship', input.issuerRef) });
  }
}
