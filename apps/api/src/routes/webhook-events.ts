import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditContext } from '@fluvia/audit';
import {
  WEBHOOK_EVENT_STATUSES,
  type WebhookAttemptDto,
  type WebhookEventDto,
  type WebhookEventService,
} from '@fluvia/webhooks';
import type { Security } from '../security.js';

/**
 * F3-09a — visibilidad de la cola de webhooks salientes + reenvío manual
 * auditado de eventos `dead`. Lecturas con scope `read`; el reenvío (acción de
 * operación) exige `webhooks:manage`. Todo RLS por tenant.
 */

const ListQuery = z
  .object({
    endpoint_id: z.string().uuid().optional(),
    status: z.enum(WEBHOOK_EVENT_STATUSES as unknown as [string, ...string[]]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const IdParam = z.object({ id: z.string().uuid() });

export interface WebhookEventRoutesOptions {
  security: Security;
  webhookEventService: WebhookEventService;
}

function apiKeyAuditContext(req: FastifyRequest): AuditContext {
  return {
    actorType: 'api_key',
    actorId: req.apiKey!.apiKeyId,
    authMethod: 'api_key',
    requestId: String(req.id),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

export function publicEvent(e: WebhookEventDto) {
  return {
    id: e.id,
    object: 'webhook_event',
    endpoint_id: e.endpointId,
    topic: e.topic,
    status: e.status,
    attempts: e.attempts,
    next_attempt_at: e.nextAttemptAt,
    last_error: e.lastError,
    delivered_at: e.deliveredAt,
    resent_from_event_id: e.resentFromEventId,
    created_at: e.createdAt,
  };
}

export function publicAttempt(a: WebhookAttemptDto) {
  return {
    object: 'webhook_attempt',
    attempt_number: a.attemptNumber,
    status_code: a.statusCode,
    error: a.error,
    latency_ms: a.latencyMs,
    resolved_ip: a.resolvedIp,
    created_at: a.createdAt,
  };
}

export function registerWebhookEventRoutes(
  app: FastifyInstance,
  { security, webhookEventService }: WebhookEventRoutesOptions
): void {
  app.get('/v1/webhook_events', { preHandler: security.apiKey(['read']) }, async (req) => {
    const q = ListQuery.parse(req.query ?? {});
    const events = await webhookEventService.list(req.apiKey!.tenantId, {
      endpointId: q.endpoint_id,
      status: q.status as never,
      limit: q.limit,
    });
    return { object: 'list', data: events.map(publicEvent) };
  });

  app.get('/v1/webhook_events/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const detail = await webhookEventService.get(req.apiKey!.tenantId, id);
    return {
      ...publicEvent(detail),
      payload: detail.payload,
      attempts_history: detail.attemptsHistory.map(publicAttempt),
    };
  });

  // Acción de operación: reenvía un evento `dead` como uno fresco (auditado).
  app.post(
    '/v1/webhook_events/:id/resend',
    { preHandler: security.apiKey(['webhooks:manage']) },
    async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const created = await webhookEventService.resend(
        req.apiKey!.tenantId,
        id,
        apiKeyAuditContext(req)
      );
      return reply.code(201).send(publicEvent(created));
    }
  );
}
