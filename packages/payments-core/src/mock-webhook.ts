import { z } from 'zod';
import type { InboxHandlerResult, ProviderRegistration } from '@fluvia/inbox';
import type { PaymentConfirmationService } from './confirmation.js';
import type { DisputeService } from './disputes.js';
import type { PayoutService } from './payouts.js';

/**
 * Webhooks del MockPaymentProvider (F3-03b + F4-07c-ii + F4-08c) — el handler
 * real del inbox durable (F2-12). En el sandbox el mismo proveedor 'mock' hace
 * de procesador de pagos, de banco de payouts Y de banco de disputas; sus
 * eventos se ingieren por el mismo endpoint firmado y este handler los DESPACHA
 * por tipo. Cadena completa de defensas antes de tocar dinero: firma HMAC
 * verificada al ingerir -> dedup (provider, provider_event_id) -> schema Zod
 * estricto (lo no conforme va a la DLQ como veneno) -> este handler.
 *
 *  - payment.succeeded/failed  -> PaymentConfirmationService.resolveFromProvider
 *  - payout.paid/failed        -> PayoutService.resolveFromProvider (cierra los
 *    payouts `in_transit`/`indeterminate` — p. ej. los barridos por F4-07c).
 *  - dispute.opened            -> DisputeService.openFromProvider (el banco ABRE
 *    la disputa; idempotente por `provider_ref` — el inbox es at-least-once).
 *  - dispute.won/lost          -> DisputeService.resolve (fuente verificada; won
 *    devuelve al comercio, lost forfeita al proveedor).
 *
 * Todo efecto es idempotente: `resolveFromProvider`/`resolve` son no-ops sobre
 * recursos terminales o inexistentes, y `openFromProvider` no doble-abre (V4 §23
 * + Nivel A: jamás por asunción ni doble efecto de dinero).
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
const disputeOpenFields = {
  ...eventFields,
  merchant_id: z.string().uuid(),
  amount: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  provider_ref: z.string().min(1).max(120),
  reason: z.string().min(1).max(120).optional(),
};
const disputeResolveFields = {
  ...eventFields,
  dispute_id: z.string().uuid(),
  provider_ref: z.string().min(1).max(120).optional(),
};

export const MockWebhookEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('payment.succeeded'), ...paymentFields }).strict(),
  z.object({ type: z.literal('payment.failed'), ...paymentFields }).strict(),
  z.object({ type: z.literal('payout.paid'), ...payoutFields }).strict(),
  z.object({ type: z.literal('payout.failed'), ...payoutFields }).strict(),
  z.object({ type: z.literal('dispute.opened'), ...disputeOpenFields }).strict(),
  z.object({ type: z.literal('dispute.won'), ...disputeResolveFields }).strict(),
  z.object({ type: z.literal('dispute.lost'), ...disputeResolveFields }).strict(),
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
  payouts: PayoutService,
  disputes: DisputeService
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

      if (payload.type === 'payout.paid' || payload.type === 'payout.failed') {
        const outcome = await payouts.resolveFromProvider(payload.tenant_id, {
          payoutId: payload.payout_id,
          result: payload.type === 'payout.paid' ? 'paid' : 'failed',
          providerRef: payload.provider_ref,
          failureCode: payload.failure_code,
        });
        return mapOutcome(outcome, 'payout');
      }

      if (payload.type === 'dispute.opened') {
        // El banco ABRE la disputa (aparta fondos). Idempotente por provider_ref:
        // un reproceso no doble-abre. Un ref ya visto es un no-op (ignored).
        const { created } = await disputes.openFromProvider(payload.tenant_id, {
          merchantId: payload.merchant_id,
          amount: BigInt(payload.amount),
          currency: payload.currency,
          reason: payload.reason,
          provider: MOCK_PROVIDER_NAME,
          providerRef: payload.provider_ref,
        });
        return created
          ? { outcome: 'applied' }
          : { outcome: 'ignored', detail: 'dispute already opened for this provider_ref' };
      }

      // dispute.won / dispute.lost — resolución por fuente verificada (V4 §23).
      const outcome = await disputes.resolve(payload.tenant_id, {
        disputeId: payload.dispute_id,
        outcome: payload.type === 'dispute.won' ? 'won' : 'lost',
        providerRef: payload.provider_ref,
      });
      return mapOutcome(outcome, 'dispute');
    },
  };
}
