import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@fluvia/identity';
import type { PersonalServices, ProgramActor } from '@fluvia/personal';
import type { UncertainPaymentResolver } from '@fluvia/payments-core';
import type { Security } from '../security.js';
import { snake } from './wire.js';

/**
 * Fluvia Operaciones — plano de OPERADOR sobre la organización PROGRAMA.
 *
 * Sesión de dashboard + membresía + permiso `program:*` (RBAC). Acciones que
 * cambian riesgo o dinero exigen además STEP-UP reciente (`security.stepUp`):
 * cambiar límites y estados de línea, decidir revisiones, activar políticas,
 * aplicar garantía, bloquear/desbloquear/cerrar tarjetas, suspender clientes,
 * resolver casos e inciertos. Doble aprobación por identidad donde aplica.
 * Todo queda auditado con el operador y el motivo.
 */
const OrgParam = z.object({ orgId: z.string().uuid() });
const IdParams = z.object({ orgId: z.string().uuid(), id: z.string().uuid() });
const Minor = z
  .union([
    z.string().regex(/^[0-9]{1,16}$/),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((v) => BigInt(v));
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Reason = z.string().trim().min(3).max(280);

const SetupBody = z
  .object({ name: z.string().trim().min(1).max(80), currencies: z.array(Currency).min(1).max(8) })
  .strict();
const DecisionBody = z
  .object({ decision: z.enum(['approve', 'reject']), limit: Minor.optional(), reason: Reason })
  .strict();
const LimitBody = z.object({ new_limit: Minor, reason: Reason }).strict();
const LineStatusBody = z
  .object({ status: z.enum(['active', 'frozen', 'closed']), reason: Reason })
  .strict();
const ConsumerStatusBody = z
  .object({ status: z.enum(['active', 'suspended']), reason: Reason })
  .strict();
const PolicyBody = z
  .object({ code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/), params: z.unknown() })
  .strict();
const ReasonBody = z.object({ reason: Reason }).strict();
const ApprovalDecisionBody = z.object({ decision: z.enum(['approve', 'reject']) }).strict();
const CollateralApplyBody = z
  .object({ currency: Currency, amount: Minor, reason: Reason })
  .strict();
const ShipmentBody = z
  .object({ status: z.enum(['produced', 'shipped', 'delivered', 'returned']) })
  .strict();
const ResolutionBody = z.object({ resolution: Reason }).strict();
const IncidentBody = z
  .object({
    consumer_id: z.string().uuid().optional(),
    summary: Reason,
    subject_type: z.string().trim().min(2).max(40),
    subject_id: z.string().trim().min(1).max(80),
  })
  .strict();
const AsOfBody = z.object({ as_of: z.string().datetime().optional() }).strict();
const ProviderEventBody = z
  .object({
    source: z.enum(['funding', 'withdrawal', 'issuer', 'network']),
    event_id: z.string().min(4).max(200).optional(),
    event_type: z.string().min(3).max(80),
    payload: z.record(z.unknown()),
  })
  .strict();
const ListQuery = z
  .object({
    q: z.string().trim().max(120).optional(),
    status: z.string().trim().max(40).optional(),
    consumer_id: z.string().uuid().optional(),
    case_type: z.string().trim().max(40).optional(),
    source: z.string().trim().max(20).optional(),
    currency: Currency.optional(),
  })
  .passthrough();

export function registerProgramOpsRoutes(
  app: FastifyInstance,
  deps: {
    security: Security;
    personal: PersonalServices;
    /** Resolución de inciertos del lado COMERCIO (cobros/devoluciones). */
    merchantResolver?: UncertainPaymentResolver;
    /** Simulación de proveedores solo en sandbox (local/test). */
    sandboxSimulation: boolean;
  }
): void {
  const { security, personal: p } = deps;
  const guard = (perm: Permission, stepUp = false) => ({
    preHandler: stepUp
      ? [security.session, security.org(perm), security.stepUp]
      : [security.session, security.org(perm)],
  });
  const read = guard('program:read');
  const tenant = (req: FastifyRequest) => req.org!.organizationId;
  const op = (req: FastifyRequest): Extract<ProgramActor, { kind: 'operator' }> => ({
    kind: 'operator',
    userId: req.identity!.userId,
    audit: { requestId: String(req.id), ip: req.ip, userAgent: req.headers['user-agent'] },
  });

  // ── Programa ──────────────────────────────────────────────────────────────
  app.post(
    '/v1/programs/:orgId/setup',
    guard('program:credit_manage', true),
    async (req, reply) => {
      OrgParam.parse(req.params);
      const b = SetupBody.parse(req.body);
      const program = await p.programs.setupProgram(tenant(req), b, op(req));
      return reply.code(201).send(snake(program));
    }
  );

  app.get('/v1/programs/:orgId', read, async (req) => {
    const program = await p.programs.getProgram(tenant(req));
    const overview = await p.operations.overview(tenant(req));
    return snake({ program, overview });
  });

  // ── Clientes ──────────────────────────────────────────────────────────────
  app.get('/v1/programs/:orgId/consumers', read, async (req) => {
    const q = ListQuery.parse(req.query);
    return snake({ data: await p.operations.listConsumers(tenant(req), q.q) });
  });

  app.get('/v1/programs/:orgId/consumers/:id', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    const t = tenant(req);
    const consumer = await p.operations.getConsumer(t, id);
    const [
      balances,
      lines,
      cards,
      applications,
      plans,
      authorizations,
      cases,
      audit,
      transfers,
      fundings,
    ] = await Promise.all([
      p.wallet.balances(t, id, null),
      p.credit.listLines(t, id, null),
      p.cards.listCards(t, { consumerId: id }, null),
      p.credit.listApplications(t, { consumerId: id }, null),
      p.credit.listPlans(t, id, null),
      p.authorizations.list(t, { consumerId: id }, null),
      p.cases.list(t, { consumerId: id }),
      p.operations.consumerAudit(t, id),
      p.wallet.listTransfers(t, id),
      p.wallet.listFundings(t, id),
    ]);
    return snake({
      consumer,
      balances,
      lines,
      cards,
      applications,
      plans,
      authorizations,
      cases,
      audit,
      transfers,
      fundings,
    });
  });

  app.get('/v1/programs/:orgId/consumers/:id/statement', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    const q = ListQuery.parse(req.query);
    const lines = await p.wallet.statement(tenant(req), id, q.currency ?? 'VES', {
      scope: null,
      limit: 200,
    });
    return snake({ data: lines });
  });

  app.post(
    '/v1/programs/:orgId/consumers/:id/status',
    guard('program:credit_manage', true),
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const b = ConsumerStatusBody.parse(req.body);
      return snake(await p.operations.setConsumerStatus(tenant(req), id, b, op(req)));
    }
  );

  app.post(
    '/v1/programs/:orgId/consumers/:id/collateral-applications',
    guard('program:credit_manage', true),
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const b = CollateralApplyBody.parse(req.body);
      const r = await p.operations.proposeCollateralApplication(tenant(req), id, b, op(req));
      return reply.code(201).send(snake(r));
    }
  );

  // ── Solicitudes, líneas y políticas ───────────────────────────────────────
  app.get('/v1/programs/:orgId/applications', read, async (req) => {
    const q = ListQuery.parse(req.query);
    return snake({
      data: await p.credit.listApplications(
        tenant(req),
        {
          ...(q.consumer_id ? { consumerId: q.consumer_id } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        null
      ),
    });
  });

  app.post(
    '/v1/programs/:orgId/applications/:id/decision',
    guard('program:credit_manage', true),
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const b = DecisionBody.parse(req.body);
      return snake(
        await p.credit.decideReview(
          tenant(req),
          id,
          {
            decision: b.decision,
            reason: b.reason,
            ...(b.limit !== undefined ? { limit: b.limit } : {}),
          },
          op(req)
        )
      );
    }
  );

  app.get('/v1/programs/:orgId/lines/:id', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    const line = await p.credit.getLine(tenant(req), id);
    const history = await p.credit.limitHistory(tenant(req), id);
    return snake({ line, history });
  });

  app.post(
    '/v1/programs/:orgId/lines/:id/limit',
    guard('program:credit_manage', true),
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const b = LimitBody.parse(req.body);
      return snake(
        await p.credit.changeLimit(
          tenant(req),
          id,
          { newLimit: b.new_limit, reason: b.reason },
          op(req)
        )
      );
    }
  );

  app.post(
    '/v1/programs/:orgId/lines/:id/status',
    guard('program:credit_manage', true),
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const b = LineStatusBody.parse(req.body);
      return snake(await p.credit.setLineStatus(tenant(req), id, b, op(req)));
    }
  );

  app.get('/v1/programs/:orgId/policies', read, async (req) =>
    snake({ data: await p.programs.listPolicies(tenant(req)) })
  );

  app.post(
    '/v1/programs/:orgId/policies',
    guard('program:credit_manage', true),
    async (req, reply) => {
      const b = PolicyBody.parse(req.body);
      const draft = await p.programs.createPolicyDraft(
        tenant(req),
        { code: b.code, params: b.params },
        op(req)
      );
      return reply.code(201).send(snake(draft));
    }
  );

  app.post(
    '/v1/programs/:orgId/policies/:id/propose-activation',
    guard('program:credit_manage', true),
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const b = ReasonBody.parse(req.body);
      return reply
        .code(201)
        .send(snake(await p.programs.proposeActivation(tenant(req), id, b.reason, op(req))));
    }
  );

  app.get('/v1/programs/:orgId/approvals', read, async (req) => {
    const q = ListQuery.parse(req.query);
    return snake({ data: await p.programs.listApprovals(tenant(req), q.status) });
  });

  app.post(
    '/v1/programs/:orgId/approvals/:id/decision',
    guard('program:credit_manage', true),
    async (req) => {
      const { id } = IdParams.parse(req.params);
      const b = ApprovalDecisionBody.parse(req.body);
      const actor = op(req);
      const r = await p.programs.decideApproval(tenant(req), id, b.decision, actor, (c, ap) => {
        const payload = ap.payload as { currency: string; amount: string };
        return p.collateral.applyWithin(
          c,
          tenant(req),
          {
            consumerId: ap.subject_id,
            currency: payload.currency,
            amount: BigInt(payload.amount),
            reason: ap.reason,
            approvalId: ap.id,
          },
          actor,
          p.credit
        );
      });
      return snake(r);
    }
  );

  // ── Tarjetas y transacciones ──────────────────────────────────────────────
  app.get('/v1/programs/:orgId/cards', read, async (req) => {
    const q = ListQuery.parse(req.query);
    return snake({
      data: await p.cards.listCards(
        tenant(req),
        q.consumer_id ? { consumerId: q.consumer_id } : {},
        null
      ),
    });
  });

  app.get('/v1/programs/:orgId/cards/:id', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    const card = await p.cards.getCard(tenant(req), id, null);
    const authorizations = await p.authorizations.list(tenant(req), { cardId: id }, null);
    return snake({ card, authorizations });
  });

  const cardsManage = guard('program:cards_manage', true);
  app.post('/v1/programs/:orgId/cards/:id/block', cardsManage, async (req) => {
    const { id } = IdParams.parse(req.params);
    return snake(await p.cards.block(tenant(req), id, ReasonBody.parse(req.body).reason, op(req)));
  });
  app.post('/v1/programs/:orgId/cards/:id/unblock', cardsManage, async (req) => {
    const { id } = IdParams.parse(req.params);
    return snake(
      await p.cards.unblock(tenant(req), id, ReasonBody.parse(req.body).reason, op(req))
    );
  });
  app.post('/v1/programs/:orgId/cards/:id/close', cardsManage, async (req) => {
    const { id } = IdParams.parse(req.params);
    return snake(await p.cards.close(tenant(req), id, ReasonBody.parse(req.body).reason, op(req)));
  });
  app.post('/v1/programs/:orgId/cards/:id/shipment', guard('program:cards_manage'), async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = ShipmentBody.parse(req.body);
    return snake(await p.cards.advanceShipment(tenant(req), id, b.status, op(req)));
  });

  app.get('/v1/programs/:orgId/authorizations', read, async (req) => {
    const q = ListQuery.parse(req.query);
    return snake({
      data: await p.authorizations.list(
        tenant(req),
        {
          ...(q.consumer_id ? { consumerId: q.consumer_id } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        null
      ),
    });
  });

  app.get('/v1/programs/:orgId/authorizations/:id', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    const authorization = await p.authorizations.get(tenant(req), id, null);
    const plans = (await p.credit.listPlans(tenant(req), authorization.consumerId, null)).filter(
      (x) => x.authorizationId === id
    );
    return snake({ authorization, plans });
  });

  // ── Casos, inciertos, eventos y conciliación ──────────────────────────────
  app.get('/v1/programs/:orgId/cases', read, async (req) => {
    const q = ListQuery.parse(req.query);
    return snake({
      data: await p.cases.list(tenant(req), {
        ...(q.status ? { status: q.status } : {}),
        ...(q.consumer_id ? { consumerId: q.consumer_id } : {}),
        ...(q.case_type ? { caseType: q.case_type } : {}),
      }),
    });
  });

  app.get('/v1/programs/:orgId/cases/:id', read, async (req) => {
    const { id } = IdParams.parse(req.params);
    return snake(await p.cases.get(tenant(req), id));
  });

  app.post('/v1/programs/:orgId/cases', guard('program:cases_manage'), async (req, reply) => {
    const b = IncidentBody.parse(req.body);
    const created = await p.cases.openIncident(
      tenant(req),
      {
        ...(b.consumer_id ? { consumerId: b.consumer_id } : {}),
        summary: b.summary,
        subjectType: b.subject_type,
        subjectId: b.subject_id,
      },
      op(req)
    );
    return reply.code(201).send(snake(created));
  });

  app.post(
    '/v1/programs/:orgId/cases/:id/acknowledge',
    guard('program:cases_manage'),
    async (req) => {
      const { id } = IdParams.parse(req.params);
      return snake(await p.cases.acknowledge(tenant(req), id, op(req)));
    }
  );

  app.post(
    '/v1/programs/:orgId/cases/:id/resolve',
    guard('program:cases_manage', true),
    async (req) => {
      const { id } = IdParams.parse(req.params);
      return snake(
        await p.cases.resolve(tenant(req), id, ResolutionBody.parse(req.body).resolution, op(req))
      );
    }
  );

  /** Resolución de inciertos por FUENTE VERIFICADA (consulta al proveedor y reintento de eventos). */
  app.post(
    '/v1/programs/:orgId/uncertain/resolve',
    guard('program:cases_manage', true),
    async (req) => {
      const withdrawals = await p.wallet.resolveUncertainWithdrawals(tenant(req));
      const events = await p.events.retryUnmatched(tenant(req));
      return snake({ withdrawals, events });
    }
  );

  app.get('/v1/programs/:orgId/events', read, async (req) => {
    const q = ListQuery.parse(req.query);
    return snake({
      data: await p.events.list(tenant(req), {
        ...(q.status ? { status: q.status } : {}),
        ...(q.source ? { source: q.source } : {}),
      }),
    });
  });

  app.post(
    '/v1/programs/:orgId/events/:id/reprocess',
    guard('program:cases_manage'),
    async (req) => {
      const { id } = IdParams.parse(req.params);
      return snake(await p.events.process(tenant(req), id));
    }
  );

  app.post('/v1/programs/:orgId/reconciliation/run', guard('program:cases_manage'), async (req) =>
    snake(await p.reconciliation.run(tenant(req)))
  );

  app.post(
    '/v1/programs/:orgId/maintenance/overdue',
    guard('program:credit_manage'),
    async (req) => {
      const b = AsOfBody.parse(req.body ?? {});
      return snake(
        await p.credit.markOverdue(tenant(req), b.as_of ? new Date(b.as_of) : new Date())
      );
    }
  );

  app.post(
    '/v1/programs/:orgId/maintenance/expire-authorizations',
    guard('program:cards_manage'),
    async (req) => {
      const b = AsOfBody.parse(req.body ?? {});
      return snake(
        await p.authorizations.expireStale(tenant(req), b.as_of ? new Date(b.as_of) : new Date())
      );
    }
  );

  // ── Simulación de proveedores (SOLO sandbox local/test) ───────────────────
  if (deps.sandboxSimulation) {
    app.post(
      '/v1/programs/:orgId/sandbox/provider-events',
      guard('program:cases_manage'),
      async (req, reply) => {
        const b = ProviderEventBody.parse(req.body);
        const r = await p.events.ingest(tenant(req), {
          source: b.source,
          eventId: b.event_id ?? `sim-${randomUUID()}`,
          eventType: b.event_type,
          payload: b.payload,
        });
        return reply.code(202).send(snake(r));
      }
    );
  }

  // ── Comercio: inciertos de cobros y devoluciones (consulta verificable) ──
  if (deps.merchantResolver) {
    const resolver = deps.merchantResolver;
    app.get(
      '/v1/organizations/:orgId/uncertain',
      { preHandler: [security.session, security.org('payments:read')] },
      async (req) => snake(await resolver.listUncertain(req.org!.organizationId))
    );
    app.post(
      '/v1/organizations/:orgId/uncertain/resolve',
      { preHandler: [security.session, security.org('reconciliation:manage')] },
      async (req) => snake(await resolver.resolveTenant(req.org!.organizationId))
    );
  }
}
