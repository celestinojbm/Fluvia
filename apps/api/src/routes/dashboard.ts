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
import {
  ADJUSTMENT_DIRECTIONS,
  CASE_SEVERITIES,
  CASE_STATUSES,
  RECONCILIATION_STATUSES,
  type CaseAdjustmentDto,
  type CaseAdjustmentService,
  type OperationalCaseService,
  type ReconciliationService,
} from '@fluvia/reconciliation';
import type { Security } from '../security.js';
import { publicIntent } from './payment-intents.js';
import { publicRefund } from './refunds.js';
import { publicSession } from './checkout-sessions.js';
import { publicLink } from './payment-links.js';
import { publicAttempt, publicEvent } from './webhook-events.js';
import { publicEntry, publicReport } from './settlements.js';
import { publicCase } from './cases.js';

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
const CasesQuery = z
  .object({
    status: z.enum(CASE_STATUSES as unknown as [string, ...string[]]).optional(),
    severity: z.enum(CASE_SEVERITIES as unknown as [string, ...string[]]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .passthrough();
const AcknowledgeBody = z.object({ assignee_user_id: z.string().uuid().optional() }).strict();
const ResolveBody = z.object({ resolution: z.string().trim().min(1).max(2000) }).strict();
const ProposeBody = z
  .object({
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    direction: z.enum(ADJUSTMENT_DIRECTIONS as unknown as [string, ...string[]]),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
const RejectBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

export interface DashboardRoutesOptions {
  security: Security;
  paymentIntentService: PaymentIntentService;
  refundService: RefundService;
  checkoutSessionService: CheckoutSessionService;
  paymentLinkService: PaymentLinkService;
  webhookEventService: WebhookEventService;
  reconciliationService: ReconciliationService;
  operationalCaseService: OperationalCaseService;
  caseAdjustmentService: CaseAdjustmentService;
}

export function publicAdjustment(a: CaseAdjustmentDto) {
  return {
    id: a.id,
    object: 'case_adjustment',
    case_id: a.caseId,
    amount: Number(a.amount),
    currency: a.currency,
    direction: a.direction,
    reason: a.reason,
    status: a.status,
    requires_second_approval: a.requiresSecondApproval,
    proposed_by_user_id: a.proposedByUserId,
    approved_by_user_id: a.approvedByUserId,
    rejected_by_user_id: a.rejectedByUserId,
    rejection_reason: a.rejectionReason,
    ledger_transaction_id: a.ledgerTransactionId,
    version: a.version,
    created_at: a.createdAt,
    decided_at: a.decidedAt,
  };
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
    operationalCaseService,
    caseAdjustmentService,
  }: DashboardRoutesOptions
): void {
  const guard = { preHandler: [security.session, security.org('payments:read')] };
  // F4-03c: operación de conciliación por sesión (trabajar casos + AUTORIZAR
  // ajustes con four-eyes). El aprobador != proponente se exige por identidad.
  const manage = { preHandler: [security.session, security.org('reconciliation:manage')] };
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

  // ── Casos operativos por sesión (F4-03c) ───────────────────────────────────
  app.get('/v1/organizations/:orgId/operational_cases', guard, async (req) => {
    OrgParam.parse(req.params);
    const q = CasesQuery.parse(req.query ?? {});
    const list = await operationalCaseService.list(tenant(req), {
      status: q.status as never,
      severity: q.severity as never,
      limit: q.limit,
    });
    return { object: 'list', data: list.map(publicCase) };
  });

  app.get('/v1/organizations/:orgId/operational_cases/:id', guard, async (req) => {
    const { id } = IdParams.parse(req.params);
    const [kase, adjustmentsList] = await Promise.all([
      operationalCaseService.get(tenant(req), id),
      caseAdjustmentService.listForCase(tenant(req), id),
    ]);
    return { ...publicCase(kase), adjustments: adjustmentsList.map(publicAdjustment) };
  });

  app.post('/v1/organizations/:orgId/operational_cases/:id/acknowledge', manage, async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = AcknowledgeBody.parse(req.body ?? {});
    const updated = await operationalCaseService.acknowledge(
      tenant(req),
      id,
      userAuditContext(req),
      {
        assigneeUserId: body.assignee_user_id,
      }
    );
    return publicCase(updated);
  });

  app.post('/v1/organizations/:orgId/operational_cases/:id/resolve', manage, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { resolution } = ResolveBody.parse(req.body);
    const updated = await operationalCaseService.resolve(
      tenant(req),
      id,
      resolution,
      userAuditContext(req)
    );
    return publicCase(updated);
  });

  // ── Ajustes monetarios con four-eyes por sesión (F4-03c) ───────────────────
  app.get('/v1/organizations/:orgId/operational_cases/:id/adjustments', guard, async (req) => {
    const { id } = IdParams.parse(req.params);
    const list = await caseAdjustmentService.listForCase(tenant(req), id);
    return { object: 'list', data: list.map(publicAdjustment) };
  });

  // Proponer un ajuste (acto humano; el proponente es req.identity.userId).
  app.post(
    '/v1/organizations/:orgId/operational_cases/:id/adjustments',
    manage,
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const body = ProposeBody.parse(req.body);
      const created = await caseAdjustmentService.propose(
        tenant(req),
        id,
        {
          amount: BigInt(body.amount),
          currency: body.currency,
          direction: body.direction as never,
          reason: body.reason,
        },
        userAuditContext(req)
      );
      return reply.code(201).send(publicAdjustment(created));
    }
  );

  // Aprobar: FOUR-EYES — el servicio exige aprobador != proponente sobre umbral.
  app.post('/v1/organizations/:orgId/case_adjustments/:id/approve', manage, async (req) => {
    const { id } = IdParams.parse(req.params);
    const applied = await caseAdjustmentService.approve(tenant(req), id, userAuditContext(req));
    return publicAdjustment(applied);
  });

  app.post('/v1/organizations/:orgId/case_adjustments/:id/reject', manage, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { reason } = RejectBody.parse(req.body);
    const rejected = await caseAdjustmentService.reject(
      tenant(req),
      id,
      reason,
      userAuditContext(req)
    );
    return publicAdjustment(rejected);
  });
}
