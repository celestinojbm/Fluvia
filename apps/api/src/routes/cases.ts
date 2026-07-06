import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditContext } from '@fluvia/audit';
import {
  CASE_SEVERITIES,
  CASE_STATUSES,
  type OperationalCaseDto,
  type OperationalCaseService,
} from '@fluvia/reconciliation';
import type { Security } from '../security.js';

/**
 * F4-03a — casos operativos de conciliación (plano de integración, API key).
 * Cada discrepancia se materializa como un caso (trigger 0029); aquí se listan,
 * se consultan y se gobierna su ciclo (acknowledge / resolve). Resolver es
 * DOCUMENTAL: no mueve dinero (el ajuste con four-eyes es F4-03b). Fuera del
 * contrato OpenAPI v1 por ahora, como el resto de la superficie de conciliación.
 */

const IdParam = z.object({ id: z.string().uuid() });
const ListQuery = z
  .object({
    status: z.enum(CASE_STATUSES as unknown as [string, ...string[]]).optional(),
    severity: z.enum(CASE_SEVERITIES as unknown as [string, ...string[]]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const AcknowledgeSchema = z.object({ assignee_user_id: z.string().uuid().optional() }).strict();
const ResolveSchema = z.object({ resolution: z.string().trim().min(1).max(2000) }).strict();

export interface CaseRoutesOptions {
  security: Security;
  operationalCaseService: OperationalCaseService;
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

export function publicCase(c: OperationalCaseDto) {
  return {
    id: c.id,
    object: 'operational_case',
    case_type: c.caseType,
    severity: c.severity,
    status: c.status,
    reconciliation_entry_id: c.reconciliationEntryId,
    report_id: c.reportId,
    provider: c.provider,
    provider_ref: c.providerRef,
    discrepancy_status: c.discrepancyStatus,
    ledger_amount: c.ledgerAmount === null ? null : Number(c.ledgerAmount),
    provider_amount: c.providerAmount === null ? null : Number(c.providerAmount),
    assignee_user_id: c.assigneeUserId,
    resolution: c.resolution,
    resolved_by_user_id: c.resolvedByUserId,
    version: c.version,
    created_at: c.createdAt,
    acknowledged_at: c.acknowledgedAt,
    resolved_at: c.resolvedAt,
  };
}

export function registerCaseRoutes(
  app: FastifyInstance,
  { security, operationalCaseService }: CaseRoutesOptions
): void {
  app.get('/v1/operational_cases', { preHandler: security.apiKey(['read']) }, async (req) => {
    const q = ListQuery.parse(req.query ?? {});
    const cases = await operationalCaseService.list(req.apiKey!.tenantId, {
      status: q.status as never,
      severity: q.severity as never,
      limit: q.limit,
    });
    return { object: 'list', data: cases.map(publicCase) };
  });

  app.get('/v1/operational_cases/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const found = await operationalCaseService.get(req.apiKey!.tenantId, id);
    return publicCase(found);
  });

  app.post(
    '/v1/operational_cases/:id/acknowledge',
    { preHandler: security.apiKey(['payments:write']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const body = AcknowledgeSchema.parse(req.body ?? {});
      const updated = await operationalCaseService.acknowledge(
        req.apiKey!.tenantId,
        id,
        apiKeyAuditContext(req),
        { assigneeUserId: body.assignee_user_id }
      );
      return publicCase(updated);
    }
  );

  app.post(
    '/v1/operational_cases/:id/resolve',
    { preHandler: security.apiKey(['payments:write']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const { resolution } = ResolveSchema.parse(req.body);
      const updated = await operationalCaseService.resolve(
        req.apiKey!.tenantId,
        id,
        resolution,
        apiKeyAuditContext(req)
      );
      return publicCase(updated);
    }
  );
}
