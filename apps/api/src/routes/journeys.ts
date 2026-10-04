import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PoolClient } from '@fluvia/db';
import type { Permission } from '@fluvia/identity';
import { insertAuditEvent, type AuditAction } from '@fluvia/audit';
import { withTenantTransaction, type Pool } from '@fluvia/db';
import type { UncertainPaymentResolver, VerificationActor } from '@fluvia/payments-core';
import { CAPABILITY_KEYS, MARKETS, type CapabilityService } from '@fluvia/capabilities';
import type { Security } from '../security.js';
import { JourneyNotFoundError, type JourneyService } from '../journeys.js';
import { snake } from './wire.js';

/**
 * Ecosistema — el MISMO caso desde Comercio y desde Operaciones, y las
 * capacidades por mercado.
 *
 *  - Comercio (`/v1/organizations/:orgId/journeys/:ref`, `payments:read`):
 *    venta o pedido de su organización con cobro, intentos, devoluciones,
 *    asientos propios e inciertos. «Verificar» (`reconciliation:manage`)
 *    consulta al proveedor SOLO los inciertos de ese caso.
 *  - Operaciones (`/v1/programs/:orgId/…`, organización programa):
 *    el caso desde la autorización o el pedido, con ambos lados del ledger y
 *    la CONSULTA de solo lectura al registro del emisor. «Verificar» exige
 *    step-up; la decisión nunca la toma la persona: aplica lo que responde el
 *    proveedor por la vía canónica, con bitácora y auditoría.
 *  - Capacidades: lectura para el comercio y Operaciones; Operaciones puede
 *    RETIRAR una capacidad de un mercado (freno, `program:cases_manage`) y
 *    restablecerla OTRA persona con step-up (`program:credit_manage`).
 */

const RefParams = z.object({ orgId: z.string().uuid(), ref: z.string().uuid() });
const OrgParam = z.object({ orgId: z.string().uuid() });
const IdParams = z.object({ orgId: z.string().uuid(), id: z.string().uuid() });
const Reason = z.string().trim().min(5).max(280);
const WithdrawBody = z
  .object({
    market: z.enum(MARKETS),
    capability: z.enum(CAPABILITY_KEYS),
    reason: Reason,
  })
  .strict();
const RestoreBody = z.object({ reason: Reason }).strict();

export interface JourneyRouteDeps {
  security: Security;
  appPool: Pool;
  journeys: JourneyService;
  capabilities: CapabilityService;
  resolver: UncertainPaymentResolver;
  /** Organización programa (Operaciones). Sin ella, el plano de Operaciones no aplica. */
  programTenantId: string | undefined;
}

export function registerJourneyRoutes(app: FastifyInstance, deps: JourneyRouteDeps): void {
  const { security, journeys, capabilities } = deps;
  const guard = (perm: Permission, stepUp = false) => ({
    preHandler: stepUp
      ? [security.session, security.org(perm), security.stepUp]
      : [security.session, security.org(perm)],
  });
  const tenant = (req: FastifyRequest) => req.org!.organizationId;
  const audit =
    (
      req: FastifyRequest,
      action: AuditAction,
      resourceType: string,
      reason: string,
      risk: 'low' | 'medium' | 'high' = 'medium'
    ) =>
    (c: PoolClient, resourceId: string) =>
      insertAuditEvent(c, {
        action,
        tenantId: tenant(req),
        context: {
          actorType: 'user',
          actorId: req.identity!.userId,
          authMethod: 'session',
          requestId: String(req.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        },
        resourceType,
        resourceId,
        riskLevel: risk,
        reason,
      });
  /** Solo la organización programa configurada opera la plataforma. */
  const isProgram = (req: FastifyRequest) =>
    Boolean(deps.programTenantId) && tenant(req) === deps.programTenantId;

  /** Verifica con el proveedor los inciertos de UN caso y devuelve el caso releído. */
  async function verify(
    merchantTenantId: string,
    uncertain: Array<{ kind: 'payment' | 'refund'; subjectId: string }>,
    by: VerificationActor
  ) {
    const results = [];
    for (const u of uncertain) {
      const r =
        u.kind === 'payment'
          ? await deps.resolver.verifyAttempt(merchantTenantId, u.subjectId, by)
          : await deps.resolver.verifyRefund(merchantTenantId, u.subjectId, by);
      results.push({ kind: u.kind, subjectId: u.subjectId, ...r });
    }
    return results;
  }

  // ── Comercio ──────────────────────────────────────────────────────────────
  app.get('/v1/organizations/:orgId/journeys/:ref', guard('payments:read'), async (req) => {
    const { ref } = RefParams.parse(req.params);
    return snake(await journeys.forMerchant(tenant(req), ref));
  });

  app.post(
    '/v1/organizations/:orgId/journeys/:ref/verify',
    guard('reconciliation:manage'),
    async (req) => {
      const { ref } = RefParams.parse(req.params);
      const before = await journeys.forMerchant(tenant(req), ref);
      const results = await verify(tenant(req), before.uncertain, {
        userId: req.identity!.userId,
        role: 'merchant',
      });
      await withTenantTransaction(deps.appPool, tenant(req), (c) =>
        audit(
          req,
          'uncertain.verification_requested',
          'journey',
          'merchant asks the provider for the verified outcome of an uncertain case'
        )(c, before.journeyRef)
      );
      return snake({ results, journey: await journeys.forMerchant(tenant(req), ref) });
    }
  );

  app.get('/v1/organizations/:orgId/capabilities', guard('payments:read'), async (req) => {
    OrgParam.parse(req.params);
    const markets = await withTenantTransaction(deps.appPool, tenant(req), (c) =>
      c.query<{ country: string }>(
        `SELECT DISTINCT btrim(country) AS country FROM merchants WHERE deleted_at IS NULL`
      )
    );
    // Lista (no objeto con claves de mercado: `snake()` reescribiría «VE»).
    const out = [];
    for (const { country } of markets.rows) {
      out.push({ market: country, capabilities: await capabilities.forMarket(country) });
    }
    return snake({ markets: out });
  });

  // ── Operaciones ───────────────────────────────────────────────────────────
  app.get('/v1/programs/:orgId/journeys/:ref', guard('program:read'), async (req) => {
    const { ref } = RefParams.parse(req.params);
    if (!isProgram(req)) throw new JourneyNotFoundError();
    return snake(await journeys.forOperator(tenant(req), ref));
  });

  app.post(
    '/v1/programs/:orgId/journeys/:ref/verify',
    guard('program:cases_manage', true),
    async (req) => {
      const { ref } = RefParams.parse(req.params);
      if (!isProgram(req)) throw new JourneyNotFoundError();
      const before = await journeys.forOperator(tenant(req), ref);
      const results = await verify(before.merchantTenantId, before.uncertain, {
        userId: req.identity!.userId,
        role: 'operator',
      });
      await withTenantTransaction(deps.appPool, tenant(req), (c) =>
        audit(
          req,
          'uncertain.verification_requested',
          'journey',
          'operations asks the provider for the verified outcome of an uncertain case'
        )(c, before.journeyRef)
      );
      return snake({ results, journey: await journeys.forOperator(tenant(req), ref) });
    }
  );

  app.get('/v1/programs/:orgId/capabilities', guard('program:read'), async (req) => {
    OrgParam.parse(req.params);
    if (!isProgram(req)) throw new JourneyNotFoundError();
    const markets = [];
    for (const m of MARKETS)
      markets.push({ market: m, capabilities: await capabilities.forMarket(m) });
    return snake({ markets, history: await capabilities.history(tenant(req)) });
  });

  app.post(
    '/v1/programs/:orgId/capabilities/withdrawals',
    guard('program:cases_manage'),
    async (req, reply) => {
      OrgParam.parse(req.params);
      if (!isProgram(req)) throw new JourneyNotFoundError();
      const b = WithdrawBody.parse(req.body);
      const w = await capabilities.withdraw(
        tenant(req),
        {
          market: b.market,
          capability: b.capability,
          reason: b.reason,
          userId: req.identity!.userId,
        },
        audit(
          req,
          'capability.withdrawn',
          'capability_withdrawal',
          `withdraw ${b.capability} in ${b.market}`,
          'high'
        )
      );
      return reply.code(201).send(snake(w));
    }
  );

  app.post(
    '/v1/programs/:orgId/capabilities/withdrawals/:id/restore',
    guard('program:credit_manage', true),
    async (req) => {
      const { id } = IdParams.parse(req.params);
      if (!isProgram(req)) throw new JourneyNotFoundError();
      const b = RestoreBody.parse(req.body);
      return snake(
        await capabilities.restore(
          tenant(req),
          { id, reason: b.reason, userId: req.identity!.userId },
          audit(
            req,
            'capability.restored',
            'capability_withdrawal',
            'restore a withdrawn capability',
            'high'
          )
        )
      );
    }
  );
}
