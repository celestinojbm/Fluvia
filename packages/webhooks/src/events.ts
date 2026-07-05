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
  'checkout_session.completed',
  'checkout_session.expired',
  'merchant.updated',
] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export function isWebhookTopic(topic: string): topic is WebhookTopic {
  return (WEBHOOK_TOPICS as readonly string[]).includes(topic);
}
