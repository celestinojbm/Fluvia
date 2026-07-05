import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  IdempotencyService,
  assertValidIdempotencyKey,
  computeRequestHash,
} from '@fluvia/idempotency';
import {
  CheckoutSessionNotFoundError,
  CheckoutSessionService,
  type CheckoutSessionDto,
  type HostedCheckoutView,
} from '@fluvia/payments-core';
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

function hostedView(v: HostedCheckoutView) {
  return {
    id: v.id,
    object: 'checkout_session.hosted',
    status: v.status,
    url: v.url,
    expires_at: v.expiresAt,
    success_url: v.successUrl,
    cancel_url: v.cancelUrl,
    payment_intent: {
      id: v.paymentIntent.id,
      status: v.paymentIntent.status,
      amount: Number(v.paymentIntent.amount),
      currency: v.paymentIntent.currency,
    },
  };
}

export function publicSession(s: CheckoutSessionDto) {
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

  // Plano ALOJADO (F3-05c): la página del comprador, SIN API key — la
  // credencial es el `client_secret` (header). Sincroniza el estado de forma
  // perezosa (completed/expired + evento) y devuelve una vista redactada. Un
  // secreto/id equivocado da el mismo 404 que uno inexistente (anti-enumeración).
  function clientSecretOf(req: { headers: Record<string, unknown> }): string {
    const secret = req.headers['x-checkout-client-secret'];
    const value = Array.isArray(secret) ? secret[0] : secret;
    // Secreto ausente o de tamaño absurdo = mismo 404 del catálogo que uno malo.
    if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
      throw new CheckoutSessionNotFoundError();
    }
    return value;
  }

  app.get('/v1/checkout_sessions/:id/status', async (req) => {
    const { id } = IdParam.parse(req.params);
    return hostedView(
      await checkoutSessionService.getByClientSecret(id, clientSecretOf(req as never))
    );
  });

  // Confirm ALOJADO (F3-05c-iii): la página del comprador envía el método de
  // pago y confirma, SIN API key (credencial = client_secret en header). El
  // estado final se refleja en la vista devuelta (y en GET :id/status).
  app.post('/v1/checkout_sessions/:id/confirm', async (req) => {
    const { id } = IdParam.parse(req.params);
    const body = z
      .object({ payment_method_token: z.string().min(1).max(100) })
      .strict()
      .parse(req.body);
    return hostedView(
      await checkoutSessionService.confirmByClientSecret(
        id,
        clientSecretOf(req as never),
        body.payment_method_token
      )
    );
  });
}
