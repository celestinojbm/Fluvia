import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  IdempotencyService,
  assertValidIdempotencyKey,
  computeRequestHash,
} from '@fluvia/idempotency';
import { RefundService, type RefundDto } from '@fluvia/payments-core';
import type { Security } from '../security.js';

/**
 * F3-08 — refunds end-to-end (plano de integracion, API key).
 *
 * Igual que confirm (F3-03), el refund es ASINCRONO por contrato:
 *  - Fase 1 (DENTRO de la tx de la idempotency key): valida estado del intent
 *    + monto contra lo remanente reembolsable y crea la fila en `created`. La
 *    respuesta ES ese estado; el replay devuelve exactamente lo mismo.
 *  - Fase 2 (fuera de toda tx, Nivel A): reserva contable -> proveedor ->
 *    settle/cancel atomico. El estado final se lee via GET (o webhooks F3-07:
 *    topics refund.*). Monto ausente = todo lo remanente.
 */

const CreateRefundSchema = z
  .object({
    payment_intent_id: z.string().uuid(),
    /** Unidades MENORES; ausente = reembolso total de lo remanente. */
    amount: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const ListQuerySchema = z
  .object({
    payment_intent_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export interface RefundRoutesOptions {
  security: Security;
  idempotencyService: IdempotencyService;
  refundService: RefundService;
}

function publicRefund(refund: RefundDto) {
  return {
    id: refund.id,
    object: 'refund',
    payment_intent_id: refund.paymentIntentId,
    amount: Number(refund.amount),
    currency: refund.currency,
    status: refund.status,
    reason: refund.reason,
    failure_code: refund.failureCode,
    created_at: refund.createdAt,
  };
}

function idempotencyKeyOf(req: FastifyRequest): string {
  return assertValidIdempotencyKey(req.headers['idempotency-key']);
}

export function registerRefundRoutes(
  app: FastifyInstance,
  { security, idempotencyService, refundService }: RefundRoutesOptions
): void {
  app.post(
    '/v1/refunds',
    { preHandler: security.apiKey(['payments:write']) },
    async (req, reply) => {
      const key = idempotencyKeyOf(req);
      const body = CreateRefundSchema.parse(req.body);
      const tenantId = req.apiKey!.tenantId;

      const result = await idempotencyService.execute({
        tenantId,
        endpoint: 'POST /v1/refunds',
        key,
        requestHash: computeRequestHash(body),
        handler: async (client) => {
          const refund = await refundService.beginIn(client, tenantId, {
            paymentIntentId: body.payment_intent_id,
            amount: body.amount === undefined ? undefined : BigInt(body.amount),
            reason: body.reason,
          });
          return { status: 201, body: publicRefund(refund) };
        },
      });

      if (!result.replayed) {
        const refundId = (result.body as { id: string }).id;
        // Fase 2 fuera de toda tx (Nivel A). Un fallo inesperado deja el refund
        // en `created` (re-ejecutable) sin cambiar la respuesta contractual.
        await refundService.execute(tenantId, refundId).catch((err: unknown) => {
          req.log.error(
            { err: String(err), refundId },
            'refund execution failed; refund remains resolvable'
          );
        });
      }
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.status).send(result.body);
    }
  );

  app.get('/v1/refunds/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const refund = await refundService.get(req.apiKey!.tenantId, id);
    return publicRefund(refund);
  });

  app.get('/v1/refunds', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { payment_intent_id, limit } = ListQuerySchema.parse(req.query ?? {});
    const refunds = await refundService.list(req.apiKey!.tenantId, payment_intent_id, limit);
    return { object: 'list', data: refunds.map(publicRefund) };
  });
}
