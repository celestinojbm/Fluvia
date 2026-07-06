import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditContext } from '@fluvia/audit';
import type {
  CheckoutSessionService,
  PaymentIntentService,
  PaymentLinkService,
  RefundService,
} from '@fluvia/payments-core';
import { WEBHOOK_EVENT_STATUSES, type WebhookEventService } from '@fluvia/webhooks';
import { RECONCILIATION_STATUSES, type ReconciliationService } from '@fluvia/reconciliation';
import type { Security } from '../security.js';
import { publicIntent } from './payment-intents.js';
import { publicRefund } from './refunds.js';
import { publicSession } from './checkout-sessions.js';
import { publicLink } from './payment-links.js';
import { publicAttempt, publicEvent } from './webhook-events.js';
import { publicEntry, publicReport } from './settlements.js';

/**
 * F3-09b-i — plano de LECTURA del dashboard de operación. A diferencia del plano
 * de integración (API key), aquí el actor es un operador HUMANO: autentica por
 * SESIÓN y su organización (= tenant) sale de su membresía (`security.org`). El
 * permiso `payments:read` (RBAC F1-04c) lo tiene todo rol — es dato de tenant de
 * solo lectura. Reutiliza los MISMOS servicios y serializers que el plano de
 * API key: una sola forma de recurso, sin duplicar lógica.
 *
 * Solo lectura: la acción de reenvío de webhooks `dead` vive en el plano de API
 * key (F3-09a, scope `webhooks:manage`); el frontend la ejerce por esa vía.
 */

const OrgParam = z.object({ orgId: z.string().uuid() });
const IdParams = z.object({ orgId: z.string().uuid(), id: z.string().uuid() });
const LimitQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
  .passthrough();
const RefundsQuery = LimitQuery.extend({ payment_intent_id: z.string().uuid().optional() });
const WebhookEventsQuery = LimitQuery.extend({
  endpoint_id: z.string().uuid().optional(),
  status: z.enum(WEBHOOK_EVENT_STATUSES as unknown as [string, ...string[]]).optional(),
});
const EntriesQuery = z
  .object({
    status: z.enum(RECONCILIATION_STATUSES as unknown as [string, ...string[]]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .passthrough();

export interface DashboardRoutesOptions {
  security: Security;
  paymentIntentService: PaymentIntentService;
  refundService: RefundService;
  checkoutSessionService: CheckoutSessionService;
  paymentLinkService: PaymentLinkService;
  webhookEventService: WebhookEventService;
  reconciliationService: ReconciliationService;
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  {
    security,
    paymentIntentService,
    refundService,
    checkoutSessionService,
    paymentLinkService,
    webhookEventService,
    reconciliationService,
  }: DashboardRoutesOptions
): void {
  const guard = { preHandler: [security.session, security.org('payments:read')] };
  const tenant = (req: { org?: { organizationId: string } }) => req.org!.organizationId;
  const userAuditContext = (req: FastifyRequest): AuditContext => ({
    actorType: 'user',
    actorId: req.identity!.userId,
    authMethod: 'session',
    requestId: String(req.id),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // --- payment intents ---
  app.get('/v1/organizations/:orgId/payment_intents', guard, async (req) => {
    const { limit } = LimitQuery.parse(req.query ?? {});
    OrgParam.parse(req.params);
    const intents = await paymentIntentService.list(tenant(req), limit);
    return { object: 'list', data: intents.map(publicIntent) };
  });
  app.get('/v1/organizations/:orgId/payment_intents/:id', guard, async (req) => {
    const { id } = IdParams.parse(req.params);
    return publicIntent(await paymentIntentService.get(tenant(req), id));
  });

  // --- refunds ---
  app.get('/v1/organizations/:orgId/refunds', guard, async (req) => {
    const q = RefundsQuery.parse(req.query ?? {});
    OrgParam.parse(req.params);
    const refunds = await refundService.list(tenant(req), q.payment_intent_id, q.limit);
    return { object: 'list', data: refunds.map(publicRefund) };
  });
  app.get('/v1/organizations/:orgId/refunds/:id', guard, async (req) => {
    const { id } = IdParams.parse(req.params);
    return publicRefund(await refundService.get(tenant(req), id));
  });

  // --- checkout sessions ---
  app.get('/v1/organizations/:orgId/checkout_sessions', guard, async (req) => {
    const { limit } = LimitQuery.parse(req.query ?? {});
    OrgParam.parse(req.params);
    const sessions = await checkoutSessionService.list(tenant(req), limit);
    return { object: 'list', data: sessions.map(publicSession) };
  });
  app.get('/v1/organizations/:orgId/checkout_sessions/:id', guard, async (req) => {
    const { id } = IdParams.parse(req.params);
    return publicSession(await checkoutSessionService.get(tenant(req), id));
  });

  // --- payment links ---
  app.get('/v1/organizations/:orgId/payment_links', guard, async (req) => {
    const { limit } = LimitQuery.parse(req.query ?? {});
    OrgParam.parse(req.params);
    const links = await paymentLinkService.list(tenant(req), limit);
    return { object: 'list', data: links.map(publicLink) };
  });
  app.get('/v1/organizations/:orgId/payment_links/:id', guard, async (req) => {
    const { id } = IdParams.parse(req.params);
    return publicLink(await paymentLinkService.get(tenant(req), id));
  });

  // --- cola de webhooks (visibilidad; el reenvío es del plano de API key) ---
  app.get('/v1/organizations/:orgId/webhook_events', guard, async (req) => {
    const q = WebhookEventsQuery.parse(req.query ?? {});
    OrgParam.parse(req.params);
    const events = await webhookEventService.list(tenant(req), {
      endpointId: q.endpoint_id,
      status: q.status as never,
      limit: q.limit,
    });
    return { object: 'list', data: events.map(publicEvent) };
  });
  app.get('/v1/organizations/:orgId/webhook_events/:id', guard, async (req) => {
    const { id } = IdParams.parse(req.params);
    const detail = await webhookEventService.get(tenant(req), id);
    return {
      ...publicEvent(detail),
      payload: detail.payload,
      attempts_history: detail.attemptsHistory.map(publicAttempt),
    };
  });

  // --- conciliación (F4-01c): reportes de liquidación + discrepancias ---
  app.get('/v1/organizations/:orgId/settlement_reports', guard, async (req) => {
    const { limit } = LimitQuery.parse(req.query ?? {});
    OrgParam.parse(req.params);
    const reports = await reconciliationService.listReports(tenant(req), limit);
    return { object: 'list', data: reports.map(publicReport) };
  });
  app.get('/v1/organizations/:orgId/settlement_reports/:id', guard, async (req) => {
    const { id } = IdParams.parse(req.params);
    const [report, summary] = await Promise.all([
      reconciliationService.getReport(tenant(req), id),
      reconciliationService.getSummary(tenant(req), id),
    ]);
    return { ...publicReport(report), summary };
  });
  app.get('/v1/organizations/:orgId/settlement_reports/:id/entries', guard, async (req) => {
    const { id } = IdParams.parse(req.params);
    const q = EntriesQuery.parse(req.query ?? {});
    const entries = await reconciliationService.listEntries(tenant(req), id, {
      status: q.status as never,
      limit: q.limit,
    });
    return { object: 'list', data: entries.map(publicEntry) };
  });

  // Acción de OPERACIÓN por sesión: reenviar un evento `dead` (espeja F3-09a del
  // plano de API key). Exige el permiso RBAC `webhooks:manage` (owner/admin/
  // developer), no solo `payments:read`. Auditado como actor `user`.
  app.post(
    '/v1/organizations/:orgId/webhook_events/:id/resend',
    { preHandler: [security.session, security.org('webhooks:manage')] },
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const created = await webhookEventService.resend(tenant(req), id, userAuditContext(req));
      return reply.code(201).send(publicEvent(created));
    }
  );
}
