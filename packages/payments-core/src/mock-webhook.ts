import { z } from 'zod';
import type { ProviderRegistration } from '@fluvia/inbox';
import type { PaymentConfirmationService } from './confirmation.js';

/**
 * Webhooks del MockPaymentProvider (F3-03b) — el PRIMER handler real del
 * inbox durable (F2-12). Cadena completa de defensas antes de tocar dinero:
 * firma HMAC verificada al ingerir -> dedup (provider, provider_event_id) ->
 * schema Zod estricto (lo no conforme va a la DLQ como veneno) -> este
 * handler, que solo delega en resolveFromProvider (fuente verificada, V4 §23).
 */

export const MOCK_PROVIDER_NAME = 'mock';

export const MockWebhookEventSchema = z
  .object({
    event_id: z.string().min(1).max(120),
    type: z.enum(['payment.succeeded', 'payment.failed']),
    tenant_id: z.string().uuid(),
    attempt_id: z.string().uuid(),
    provider_ref: z.string().min(1).max(120),
    failure_code: z.string().min(1).max(60).optional(),
  })
  .strict();

export type MockWebhookEvent = z.infer<typeof MockWebhookEventSchema>;

export function createMockInboxRegistration(
  confirmation: PaymentConfirmationService
): ProviderRegistration {
  return {
    schema: MockWebhookEventSchema,
    async handler(event) {
      const payload = event.payload as MockWebhookEvent;
      const outcome = await confirmation.resolveFromProvider(payload.tenant_id, {
        attemptId: payload.attempt_id,
        providerRef: payload.provider_ref,
        result: payload.type === 'payment.succeeded' ? 'succeeded' : 'failed',
        failureCode: payload.failure_code,
      });
      if (outcome === 'applied') return { outcome: 'applied' };
      if (outcome === 'ignored_out_of_order') {
        return { outcome: 'ignored_out_of_order', detail: 'attempt already terminal' };
      }
      return {
        outcome: 'ignored',
        detail: 'no matching attempt for tenant/provider/reference',
      };
    },
  };
}
