import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  IdempotencyService,
  assertValidIdempotencyKey,
  computeRequestHash,
} from '@fluvia/idempotency';
import { CheckoutSessionService, type CheckoutSessionDto } from '@fluvia/payments-core';
import type { Security } from '../security.js';

/**
 * F3-05b — checkout sessions (plano de integración, API key). El comercio crea
 * una sesión sobre un payment intent abierto y obtiene la URL alojada + el
 * `client_secret` (UNA vez). Creación idempotente (capa F2-09).
 *
 * Alcance F3-05b: crear/consultar. El retrieval por client_secret, el disparo
 * de completed/expired y los eventos `checkout_session.*` llegan con el flujo
 * alojado (F3-05c).
 */

const CreateSchema = z
  .object({
    payment_intent_id: z.string().uuid(),
    customer_id: z.string().uuid().optional(),
    success_url: z.string().url().max(2000).optional(),
    cancel_url: z.string().url().max(2000).optional(),
    expires_in_minutes: z.number().int().min(5).max(1440).optional(),
  })
  .strict();

const IdParam = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

export interface CheckoutSessionRoutesOptions {
  security: Security;
  idempotencyService: IdempotencyService;
  checkoutSessionService: CheckoutSessionService;
}

function publicSession(s: CheckoutSessionDto) {
  return {
    id: s.id,
    object: 'checkout_session',
    payment_intent_id: s.paymentIntentId,
    customer_id: s.customerId,
    status: s.status,
    url: s.url,
    success_url: s.successUrl,
    cancel_url: s.cancelUrl,
    expires_at: s.expiresAt,
    completed_at: s.completedAt,
    created_at: s.createdAt,
  };
}

function idempotencyKeyOf(req: FastifyRequest): string {
  return assertValidIdempotencyKey(req.headers['idempotency-key']);
}

export function registerCheckoutSessionRoutes(
  app: FastifyInstance,
  { security, idempotencyService, checkoutSessionService }: CheckoutSessionRoutesOptions
): void {
  app.post(
    '/v1/checkout_sessions',
    { preHandler: security.apiKey(['payments:write']) },
    async (req, reply) => {
      const key = idempotencyKeyOf(req);
      const body = CreateSchema.parse(req.body);
      const tenantId = req.apiKey!.tenantId;

      const result = await idempotencyService.execute({
        tenantId,
        endpoint: 'POST /v1/checkout_sessions',
        key,
        requestHash: computeRequestHash(body),
        handler: async (client) => {
          const created = await checkoutSessionService.createIn(client, tenantId, {
            paymentIntentId: body.payment_intent_id,
            customerId: body.customer_id,
            successUrl: body.success_url,
            cancelUrl: body.cancel_url,
            expiresInMinutes: body.expires_in_minutes,
          });
          // El client_secret se entrega UNA sola vez, sobre la respuesta pública.
          return {
            status: 201,
            body: { ...publicSession(created), client_secret: created.clientSecret },
          };
        },
      });
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.status).send(result.body);
    }
  );

  app.get('/v1/checkout_sessions/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return publicSession(await checkoutSessionService.get(req.apiKey!.tenantId, id));
  });

  app.get('/v1/checkout_sessions', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { limit } = ListQuery.parse(req.query ?? {});
    const sessions = await checkoutSessionService.list(req.apiKey!.tenantId, limit);
    return { object: 'list', data: sessions.map(publicSession) };
  });
}
