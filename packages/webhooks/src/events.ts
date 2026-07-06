/**
 * Catalogo de eventos webhook del MVP (decision #13, auditoria D3).
 * webhook-delivery.md §5 se verifica contra ESTA lista por meta-test:
 * cambiar una sin la otra rompe la suite.
 */
export const WEBHOOK_TOPICS = [
  'payment_intent.created',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'payment_intent.succeeded',
  'payment_intent.failed',
  'payment_intent.canceled',
  'refund.created',
  'refund.processing',
  'refund.succeeded',
  'refund.failed',
  'refund.canceled',
  'checkout_session.completed',
  'checkout_session.expired',
  // Payouts (F4-07 / F4-09): money out. `indeterminate` es interno (silente).
  'payout.requested',
  'payout.in_transit',
  'payout.paid',
  'payout.failed',
  // Disputas / chargebacks (F4-08 / F4-09): money clawed back.
  'dispute.open',
  'dispute.under_review',
  'dispute.won',
  'dispute.lost',
  'merchant.updated',
] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export function isWebhookTopic(topic: string): topic is WebhookTopic {
  return (WEBHOOK_TOPICS as readonly string[]).includes(topic);
}
