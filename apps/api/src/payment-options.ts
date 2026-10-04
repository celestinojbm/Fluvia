import type { EffectiveCapability } from '@fluvia/capabilities';
import { downPaymentFor, type CardDto, type CurrencyBalances } from '@fluvia/personal';

/**
 * Métodos de pago de UN pedido, decididos en el SERVIDOR con los datos del
 * cliente (tarjetas, saldo, línea de crédito, política) y las capacidades del
 * mercado del comercio. La pantalla solo pinta lo que llega; nunca deduce por
 * su cuenta si algo está disponible.
 *
 * «Disponible» es una previsión: la decisión final la toma el emisor al
 * autorizar (el saldo puede cambiar entre la lectura y la confirmación).
 */

export type PaymentMethod = 'wallet' | 'installments' | 'external_card';
export type OptionReason =
  | 'capability_not_offered'
  | 'order_not_payable'
  | 'no_card_in_currency'
  | 'insufficient_balance'
  | 'no_credit_line'
  | 'credit_insufficient'
  | 'down_payment_insufficient'
  | 'no_installment_plans';

export interface PaymentOption {
  method: PaymentMethod;
  available: boolean;
  reason: OptionReason | null;
  capability: {
    status: EffectiveCapability['status'];
    simulated: boolean;
    label: string;
    liveDependency: string;
  };
  cardId?: string;
  cardLast4?: string | null;
  balanceAvailable?: string;
  creditAvailable?: string;
  downPayment?: string;
  financed?: string;
  installmentCounts?: number[];
}

export interface PaymentOptionsInput {
  currency: string;
  total: bigint;
  /** Solo un pedido sin cobro (o con el último intento rechazado) se puede pagar. */
  payable: boolean;
  capabilities: {
    wallet: EffectiveCapability;
    installments: EffectiveCapability;
    externalCard: EffectiveCapability;
  };
  cards: CardDto[];
  balance: CurrencyBalances | undefined;
  installmentCounts: number[];
  downPaymentBps: number;
}

const capOut = (c: EffectiveCapability) => ({
  status: c.status,
  simulated: c.simulated,
  label: c.label,
  liveDependency: c.liveDependency,
});

export function paymentOptions(input: PaymentOptionsInput): PaymentOption[] {
  const card = input.cards.find((c) => c.status === 'active' && c.currency === input.currency);
  const available = BigInt(input.balance?.available ?? '0');
  const line = input.balance?.credit ?? null;
  const creditAvailable = line && line.status === 'active' ? BigInt(line.available) : 0n;
  const gate = (cap: EffectiveCapability): OptionReason | null =>
    !cap.offered ? 'capability_not_offered' : !input.payable ? 'order_not_payable' : null;

  // Saldo propio.
  let walletReason = gate(input.capabilities.wallet);
  if (!walletReason && !card) walletReason = 'no_card_in_currency';
  if (!walletReason && available < input.total) walletReason = 'insufficient_balance';
  const wallet: PaymentOption = {
    method: 'wallet',
    available: walletReason === null,
    reason: walletReason,
    capability: capOut(input.capabilities.wallet),
    ...(card ? { cardId: card.id, cardLast4: card.last4 } : {}),
    balanceAvailable: available.toString(),
  };

  // Cuotas: inicial con saldo propio + resto con la línea aprobada.
  const down = downPaymentFor(input.total, input.downPaymentBps);
  const financed = input.total - down;
  let instReason = gate(input.capabilities.installments);
  if (!instReason && !card) instReason = 'no_card_in_currency';
  if (!instReason && !input.installmentCounts.length) instReason = 'no_installment_plans';
  if (!instReason && (!line || line.status !== 'active')) instReason = 'no_credit_line';
  if (!instReason && creditAvailable < financed) instReason = 'credit_insufficient';
  if (!instReason && available < down) instReason = 'down_payment_insufficient';
  const installments: PaymentOption = {
    method: 'installments',
    available: instReason === null,
    reason: instReason,
    capability: capOut(input.capabilities.installments),
    ...(card ? { cardId: card.id, cardLast4: card.last4 } : {}),
    balanceAvailable: available.toString(),
    creditAvailable: creditAvailable.toString(),
    downPayment: down.toString(),
    financed: financed.toString(),
    installmentCounts: [...input.installmentCounts],
  };

  // Otra tarjeta: checkout alojado con el proveedor simulado.
  const extReason = gate(input.capabilities.externalCard);
  const external: PaymentOption = {
    method: 'external_card',
    available: extReason === null,
    reason: extReason,
    capability: capOut(input.capabilities.externalCard),
  };
  return [wallet, installments, external];
}
