import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  IdempotencyService,
  assertValidIdempotencyKey,
  computeRequestHash,
} from '@fluvia/idempotency';
import { MerchantNotFoundError } from '@fluvia/identity';
import { Money } from '@fluvia/money';
import { PaymentIntentService, type PaymentIntentDto } from '@fluvia/payments-core';
import type { Security } from '../security.js';

/**
 * F3-02 — primeros endpoints de dinero (plano de integracion, API key).
 *
 * Reglas:
 *  - TODA mutacion exige Idempotency-Key (capa F2-09: claim + efecto +
 *    respuesta persistida en UNA transaccion; replay exacto; 409/422/400 del
 *    contrato de idempotency.md).
 *  - Scopes: payments:write para mutar, read para consultar. Una API key
 *    jamas gestiona API keys (F1-04c) y el plano de sesion no toca pagos.
 *  - SIN confirm todavia: confirmar sin proveedor seria un pago imposible de
 *    resolver (capacidad simulada, Nivel A). confirm llega con F3-03
 *    (MockPaymentProvider + attempts).
 */

const MetadataSchema = z
  .record(z.string().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 20, 'metadata allows at most 20 keys');

const CreatePaymentIntentSchema = z
  .object({
    merchant_id: z.string().uuid(),
    /** Unidades MENORES de la moneda (COP exponente 0: 1000 = $1.000). */
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    description: z.string().trim().min(1).max(500).optional(),
    capture_method: z.enum(['automatic', 'manual']).default('automatic'),
    metadata: MetadataSchema.optional(),
  })
  .strict();

const ListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

export interface PaymentIntentRoutesOptions {
  security: Security;
  idempotencyService: IdempotencyService;
  paymentIntentService: PaymentIntentService;
}

function publicIntent(intent: PaymentIntentDto) {
  return {
    id: intent.id,
    object: 'payment_intent',
    merchant_id: intent.merchantId,
    amount: Number(intent.amount),
    currency: intent.currency,
    status: intent.status,
    capture_method: intent.captureMethod,
    amount_captured: Number(intent.amountCaptured),
    amount_refunded: Number(intent.amountRefunded),
    failure_code: intent.failureCode,
    created_at: intent.createdAt,
  };
}

function idempotencyKeyOf(req: FastifyRequest): string {
  return assertValidIdempotencyKey(req.headers['idempotency-key']);
}

export function registerPaymentIntentRoutes(
  app: FastifyInstance,
  { security, idempotencyService, paymentIntentService }: PaymentIntentRoutesOptions
): void {
  app.post(
    '/v1/payment_intents',
    { preHandler: security.apiKey(['payments:write']) },
    async (req, reply) => {
      const key = idempotencyKeyOf(req);
      const body = CreatePaymentIntentSchema.parse(req.body);
      const tenantId = req.apiKey!.tenantId;
      // Money valida moneda y monto ANTES de comprometer la idempotency key.
      const amount = Money.of(body.amount, body.currency);

      const result = await idempotencyService.execute({
        tenantId,
        endpoint: 'POST /v1/payment_intents',
        key,
        requestHash: computeRequestHash(body),
        handler: async (client) => {
          // El merchant ajeno y el inexistente son indistinguibles (RLS).
          const merchant = await client.query(
            `SELECT 1 FROM merchants WHERE id = $1 AND deleted_at IS NULL`,
            [body.merchant_id]
          );
          if ((merchant.rowCount ?? 0) === 0) throw new MerchantNotFoundError();
          const intent = await paymentIntentService.createIn(client, {
            tenantId,
            merchantId: body.merchant_id,
            amount,
            description: body.description,
            captureMethod: body.capture_method,
            metadata: body.metadata,
          });
          return { status: 201, body: publicIntent(intent) };
        },
      });
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.status).send(result.body);
    }
  );

  app.post(
    '/v1/payment_intents/:id/cancel',
    { preHandler: security.apiKey(['payments:write']) },
    async (req, reply) => {
      const key = idempotencyKeyOf(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const tenantId = req.apiKey!.tenantId;

      const result = await idempotencyService.execute({
        tenantId,
        endpoint: 'POST /v1/payment_intents/:id/cancel',
        key,
        requestHash: computeRequestHash({ id }),
        handler: async (client) => {
          const intent = await paymentIntentService.transitionIn(client, id, 'canceled');
          return { status: 200, body: publicIntent(intent) };
        },
      });
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.status).send(result.body);
    }
  );

  app.get('/v1/payment_intents/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const intent = await paymentIntentService.get(req.apiKey!.tenantId, id);
    return publicIntent(intent);
  });

  app.get('/v1/payment_intents', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { limit } = ListQuerySchema.parse(req.query ?? {});
    const intents = await paymentIntentService.list(req.apiKey!.tenantId, limit);
    return { object: 'list', data: intents.map(publicIntent) };
  });
}
