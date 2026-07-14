import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WEBHOOK_TOPICS, WebhookEndpointService } from '@fluvia/webhooks';
import type { Security } from '../security.js';

/**
 * Gestion de endpoints de webhook (F3-07) — plano de integracion, scope
 * `webhooks:manage` (F1-04c). El secreto whsec_ se muestra UNA sola vez al
 * crear y al rotar; jamas vuelve a ser recuperable por la API.
 */

// Exportado: el plano de sesión (dashboard.ts, F6.5B1) espeja este endpoint con
// la MISMA validación — una sola forma de request, sin duplicar reglas.
export const CreateEndpointSchema = z
  .object({
    url: z.string().min(1).max(2000),
    events: z
      .array(z.enum(WEBHOOK_TOPICS as unknown as [string, ...string[]]))
      .max(WEBHOOK_TOPICS.length)
      .optional(),
    description: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const IdParam = z.object({ id: z.string().uuid() });

export interface WebhookEndpointRoutesOptions {
  security: Security;
  endpointService: WebhookEndpointService;
}

export function registerWebhookEndpointRoutes(
  app: FastifyInstance,
  { security, endpointService }: WebhookEndpointRoutesOptions
): void {
  app.post(
    '/v1/webhook_endpoints',
    { preHandler: security.apiKey(['webhooks:manage']) },
    async (req, reply) => {
      const body = CreateEndpointSchema.parse(req.body);
      // RA-F65B-003: el plano de API key es INTENCIONALMENTE no auditado
      // (deuda histórica declarada) — la elección es explícita, no por omisión.
      const created = await endpointService.create(req.apiKey!.tenantId, body, { audit: false });
      return reply.code(201).send({
        id: created.id,
        object: 'webhook_endpoint',
        url: created.url,
        events: created.events,
        status: created.status,
        description: created.description,
        created_at: created.createdAt,
        // UNA sola vez.
        secret: created.secret,
      });
    }
  );

  app.get(
    '/v1/webhook_endpoints',
    { preHandler: security.apiKey(['webhooks:manage']) },
    async (req) => {
      const endpoints = await endpointService.list(req.apiKey!.tenantId);
      return {
        object: 'list',
        data: endpoints.map((e) => ({
          id: e.id,
          object: 'webhook_endpoint',
          url: e.url,
          events: e.events,
          status: e.status,
          description: e.description,
          created_at: e.createdAt,
          disabled_at: e.disabledAt,
        })),
      };
    }
  );

  app.post(
    '/v1/webhook_endpoints/:id/rotate',
    { preHandler: security.apiKey(['webhooks:manage']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const rotated = await endpointService.rotateSecret(req.apiKey!.tenantId, id, {
        audit: false,
      });
      // El secreto anterior sigue firmando durante la ventana de gracia.
      return { id: rotated.id, secret: rotated.secret, rotated: true };
    }
  );

  app.post(
    '/v1/webhook_endpoints/:id/disable',
    { preHandler: security.apiKey(['webhooks:manage']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const disabled = await endpointService.disable(req.apiKey!.tenantId, id, { audit: false });
      return { id: disabled.id, status: disabled.status, disabled_at: disabled.disabledAt };
    }
  );
}
