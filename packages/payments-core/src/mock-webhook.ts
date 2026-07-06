import { z } from 'zod';
import type { InboxHandlerResult, ProviderRegistration } from '@fluvia/inbox';
import type { PaymentConfirmationService } from './confirmation.js';
import type { PayoutService } from './payouts.js';

/**
 * Webhooks del MockPaymentProvider (F3-03b + F4-07c-ii) — el handler real del
 * inbox durable (F2-12). En el sandbox el mismo proveedor 'mock' hace de
 * procesador de pagos Y de banco de payouts; sus eventos se ingieren por el
 * mismo endpoint firmado y este handler los DESPACHA por tipo. Cadena completa
 * de defensas antes de tocar dinero: firma HMAC verificada al ingerir -> dedup
 * (provider, provider_event_id) -> schema Zod estricto (lo no conforme va a la
 * DLQ como veneno) -> este handler, que solo delega en resolveFromProvider
 * (fuente verificada, V4 §23).
 *
 *  - payment.succeeded/failed  -> PaymentConfirmationService.resolveFromProvider
 *  - payout.paid/failed        -> PayoutService.resolveFromProvider (cierra los
 *    payouts `in_transit`/`indeterminate` — p. ej. los barridos por F4-07c).
 */

export const MOCK_PROVIDER_NAME = 'mock';

const eventFields = {
  event_id: z.string().min(1).max(120),
  tenant_id: z.string().uuid(),
  failure_code: z.string().min(1).max(60).optional(),
};
const paymentFields = {
  ...eventFields,
  attempt_id: z.string().uuid(),
  provider_ref: z.string().min(1).max(120),
};
const payoutFields = {
  ...eventFields,
  payout_id: z.string().uuid(),
  provider_ref: z.string().min(1).max(120).optional(),
};

export const MockWebhookEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('payment.succeeded'), ...paymentFields }).strict(),
  z.object({ type: z.literal('payment.failed'), ...paymentFields }).strict(),
  z.object({ type: z.literal('payout.paid'), ...payoutFields }).strict(),
  z.object({ type: z.literal('payout.failed'), ...payoutFields }).strict(),
]);

export type MockWebhookEvent = z.infer<typeof MockWebhookEventSchema>;

function mapOutcome(
  outcome: 'applied' | 'ignored_out_of_order' | 'ignored',
  resource: string
): InboxHandlerResult {
  if (outcome === 'applied') return { outcome: 'applied' };
  if (outcome === 'ignored_out_of_order') {
    return { outcome: 'ignored_out_of_order', detail: `${resource} already terminal` };
  }
  return { outcome: 'ignored', detail: `no matching ${resource} for tenant/provider/reference` };
}

export function createMockInboxRegistration(
  confirmation: PaymentConfirmationService,
  payouts: PayoutService
): ProviderRegistration {
  return {
    schema: MockWebhookEventSchema,
    async handler(event) {
      const payload = event.payload as MockWebhookEvent;
      if (payload.type === 'payment.succeeded' || payload.type === 'payment.failed') {
        const outcome = await confirmation.resolveFromProvider(payload.tenant_id, {
          attemptId: payload.attempt_id,
          providerRef: payload.provider_ref,
          result: payload.type === 'payment.succeeded' ? 'succeeded' : 'failed',
          failureCode: payload.failure_code,
        });
        return mapOutcome(outcome, 'attempt');
      }
      // payout.paid / payout.failed — el banco confirma/rechaza (fuente verificada).
      const outcome = await payouts.resolveFromProvider(payload.tenant_id, {
        payoutId: payload.payout_id,
        result: payload.type === 'payout.paid' ? 'paid' : 'failed',
        providerRef: payload.provider_ref,
        failureCode: payload.failure_code,
      });
      return mapOutcome(outcome, 'payout');
    },
  };
}
