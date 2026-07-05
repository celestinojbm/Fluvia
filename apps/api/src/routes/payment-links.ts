import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  IdempotencyService,
  assertValidIdempotencyKey,
  computeRequestHash,
} from '@fluvia/idempotency';
import { ResourceMetadataSchema } from '@fluvia/identity';
import { PaymentLinkService, type PaymentLinkDto } from '@fluvia/payments-core';
import type { Security } from '../security.js';

/**
 * F3-06 — payment links (plantilla "págame"). Gestión en el plano de
 * integración (API key, scope payments:write/read; creación idempotente F2-09).
 * La apertura del link `POST :id/sessions` es PÚBLICA (sin API key): genera un
 * payment_intent + checkout_session frescos y devuelve la sesión para pagar.
 */

const CreateSchema = z
  .object({
    merchant_id: z.string().uuid(),
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    description: z.string().trim().min(1).max(500).optional(),
    metadata: ResourceMetadataSchema.optional(),
  })
  .strict();

const IdParam = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

export interface PaymentLinkRoutesOptions {
  security: Security;
  idempotencyService: IdempotencyService;
  paymentLinkService: PaymentLinkService;
}

export function publicLink(l: PaymentLinkDto) {
  return {
    id: l.id,
    object: 'payment_link',
    merchant_id: l.merchantId,
    amount: Number(l.amount),
    currency: l.currency,
    description: l.description,
    status: l.status,
    url: l.url,
    metadata: l.metadata,
    created_at: l.createdAt,
    disabled_at: l.disabledAt,
  };
}

function idempotencyKeyOf(req: FastifyRequest): string {
  return assertValidIdempotencyKey(req.headers['idempotency-key']);
}

export function registerPaymentLinkRoutes(
  app: FastifyInstance,
  { security, idempotencyService, paymentLinkService }: PaymentLinkRoutesOptions
): void {
  app.post(
    '/v1/payment_links',
    { preHandler: security.apiKey(['payments:write']) },
    async (req, reply) => {
      const key = idempotencyKeyOf(req);
      const body = CreateSchema.parse(req.body);
      const tenantId = req.apiKey!.tenantId;
      const result = await idempotencyService.execute({
        tenantId,
        endpoint: 'POST /v1/payment_links',
        key,
        requestHash: computeRequestHash(body),
        handler: async (client) => {
          const link = await paymentLinkService.createIn(client, tenantId, {
            merchantId: body.merchant_id,
            amount: BigInt(body.amount),
            currency: body.currency,
            description: body.description,
            metadata: body.metadata,
          });
          return { status: 201, body: publicLink(link) };
        },
      });
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.status).send(result.body);
    }
  );

  app.get('/v1/payment_links/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return publicLink(await paymentLinkService.get(req.apiKey!.tenantId, id));
  });

  app.get('/v1/payment_links', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { limit } = ListQuery.parse(req.query ?? {});
    const links = await paymentLinkService.list(req.apiKey!.tenantId, limit);
    return { object: 'list', data: links.map(publicLink) };
  });

  app.post(
    '/v1/payment_links/:id/disable',
    { preHandler: security.apiKey(['payments:write']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const link = await paymentLinkService.disable(req.apiKey!.tenantId, id);
      return { id: link.id, status: link.status, disabled_at: link.disabledAt };
    }
  );

  // Plano PÚBLICO (sin API key): abrir el link genera una sesión de checkout.
  // Un link inexistente o deshabilitado da el mismo 404 (anti-enumeración).
  app.post('/v1/payment_links/:id/sessions', async (req) => {
    const { id } = IdParam.parse(req.params);
    const session = await paymentLinkService.createSessionFromLink(id);
    return {
      object: 'checkout_session',
      checkout_session_id: session.checkoutSessionId,
      client_secret: session.clientSecret,
      url: session.url,
    };
  });
}
