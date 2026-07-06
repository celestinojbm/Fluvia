import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DisputeService, type DisputeDto } from '@fluvia/payments-core';
import type { Security } from '../security.js';

/**
 * F4-08b — disputas como recurso (plano de integracion, API key), sobre el motor
 * de F4-08a. A diferencia de payouts/refunds, la disputa la INICIA el banco: el
 * integrador NO la crea. Su superficie es de LECTURA (ver sus disputas) + una
 * unica accion mutante: RESPONDER con evidencia (`open -> under_review`). La
 * apertura y la resolucion (won/lost) llegan por fuente verificada (el webhook
 * del banco — F4-08c). El envio de evidencia es idempotente por diseno (no
 * necesita Idempotency-Key: re-enviar sobre `under_review` devuelve el estado
 * actual). Sandbox: disputas publicas/reales bloqueadas hasta gates.
 */

const ListQuerySchema = z
  .object({
    merchant_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export interface DisputeRoutesOptions {
  security: Security;
  disputeService: DisputeService;
}

export function publicDispute(dispute: DisputeDto) {
  return {
    id: dispute.id,
    object: 'dispute',
    merchant_id: dispute.merchantId,
    amount: Number(dispute.amount),
    currency: dispute.currency,
    status: dispute.status,
    reason: dispute.reason,
    provider_ref: dispute.providerRef,
    created_at: dispute.createdAt,
  };
}

export function registerDisputeRoutes(
  app: FastifyInstance,
  { security, disputeService }: DisputeRoutesOptions
): void {
  app.get('/v1/disputes/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const dispute = await disputeService.get(req.apiKey!.tenantId, id);
    return publicDispute(dispute);
  });

  app.get('/v1/disputes', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { merchant_id, limit } = ListQuerySchema.parse(req.query ?? {});
    const disputes = await disputeService.list(req.apiKey!.tenantId, merchant_id, limit);
    return { object: 'list', data: disputes.map(publicDispute) };
  });

  // Responder a la disputa con evidencia: `open -> under_review`. Idempotente
  // (sin Idempotency-Key): re-enviar sobre `under_review` devuelve el estado
  // actual; sobre una disputa ya resuelta es invalid_state_transition (409).
  app.post(
    '/v1/disputes/:id/evidence',
    { preHandler: security.apiKey(['payments:write']) },
    async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const dispute = await disputeService.submitEvidence(req.apiKey!.tenantId, id);
      return publicDispute(dispute);
    }
  );
}
