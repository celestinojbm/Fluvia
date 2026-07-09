import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  IdempotencyService,
  assertValidIdempotencyKey,
  computeRequestHash,
} from '@fluvia/idempotency';
import { PayoutService, type PayoutDto } from '@fluvia/payments-core';
import type { Security } from '../security.js';

/**
 * F4-07b — payouts como recurso (plano de integracion, API key), sobre el motor
 * de F4-07a. Igual que refunds (F3-08), el payout es ASINCRONO por contrato:
 *  - Fase 1 (DENTRO de la tx de la idempotency key): valida fundabilidad
 *    (disponible del comercio menos payouts en vuelo) y crea la fila en
 *    `requested`. La respuesta ES ese estado; el replay devuelve lo mismo.
 *  - Fase 2 (fuera de toda tx, Nivel A): emit -> banco -> settle/fail/indeterminate.
 *    El estado final se lee via GET (o webhooks: topics payout.*).
 *
 * Superficie de sandbox: payouts publicos/reales bloqueados hasta gates. Fuera
 * del contrato OpenAPI v1 por ahora (como los demas planos de Fase 4).
 */

const CreatePayoutSchema = z
  .object({
    merchant_id: z.string().uuid(),
    /** Unidades MENORES (estrictamente positivo). F6: `int()` acepta enteros fuera
     *  del rango seguro (double impreciso → `BigInt` equivocado) → mismo bound que Money.of. */
    amount: z.number().int().positive().refine(Number.isSafeInteger, 'amount out of safe range'),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const ListQuerySchema = z
  .object({
    merchant_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export interface PayoutRoutesOptions {
  security: Security;
  idempotencyService: IdempotencyService;
  payoutService: PayoutService;
}

export function publicPayout(payout: PayoutDto) {
  return {
    id: payout.id,
    object: 'payout',
    merchant_id: payout.merchantId,
    amount: Number(payout.amount),
    currency: payout.currency,
    status: payout.status,
    reason: payout.reason,
    failure_code: payout.failureCode,
    created_at: payout.createdAt,
  };
}

function idempotencyKeyOf(req: FastifyRequest): string {
  return assertValidIdempotencyKey(req.headers['idempotency-key']);
}

export function registerPayoutRoutes(
  app: FastifyInstance,
  { security, idempotencyService, payoutService }: PayoutRoutesOptions
): void {
  app.post(
    '/v1/payouts',
    { preHandler: security.apiKey(['payments:write']) },
    async (req, reply) => {
      const key = idempotencyKeyOf(req);
      const body = CreatePayoutSchema.parse(req.body);
      const tenantId = req.apiKey!.tenantId;

      const result = await idempotencyService.execute({
        tenantId,
        endpoint: 'POST /v1/payouts',
        key,
        requestHash: computeRequestHash(body),
        handler: async (client) => {
          const payout = await payoutService.beginIn(client, tenantId, {
            merchantId: body.merchant_id,
            amount: BigInt(body.amount),
            currency: body.currency,
            reason: body.reason,
          });
          return { status: 201, body: publicPayout(payout) };
        },
      });

      if (!result.replayed) {
        const payoutId = (result.body as { id: string }).id;
        // Fase 2 fuera de toda tx (Nivel A). Un fallo inesperado deja el payout en
        // `requested` (re-ejecutable) sin cambiar la respuesta contractual.
        await payoutService.execute(tenantId, payoutId).catch((err: unknown) => {
          req.log.error(
            { err: String(err), payoutId },
            'payout execution failed; payout remains resolvable'
          );
        });
      }
      reply.header('idempotency-replayed', String(result.replayed));
      return reply.code(result.status).send(result.body);
    }
  );

  app.get('/v1/payouts/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const payout = await payoutService.get(req.apiKey!.tenantId, id);
    return publicPayout(payout);
  });

  app.get('/v1/payouts', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { merchant_id, limit } = ListQuerySchema.parse(req.query ?? {});
    const payouts = await payoutService.list(req.apiKey!.tenantId, merchant_id, limit);
    return { object: 'list', data: payouts.map(publicPayout) };
  });
}
