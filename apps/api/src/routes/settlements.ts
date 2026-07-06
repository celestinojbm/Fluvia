import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RECONCILIATION_STATUSES,
  type ReconciliationEntryDto,
  type ReconciliationService,
  type SettlementReportDto,
} from '@fluvia/reconciliation';
import type { Security } from '../security.js';

/**
 * F4-01b — gestión de conciliación (plano de integración, API key). Una
 * integración carga el reporte de liquidación del proveedor (líneas) y dispara
 * la conciliación; el resultado (resumen + discrepancias) queda consultable.
 * Intencionalmente FUERA del contrato OpenAPI v1 por ahora (superficie nueva,
 * como los planos público y de sesión).
 */

const CreateReportSchema = z
  .object({
    provider: z.string().trim().min(1).max(64),
    currency: z.string().regex(/^[A-Z]{3}$/),
    period_start: z.string().datetime({ offset: true }),
    period_end: z.string().datetime({ offset: true }),
  })
  .strict();

const LinesSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            provider_ref: z.string().trim().min(1).max(200),
            amount: z.number().int().positive(),
            fee: z.number().int().min(0).optional(),
            settled_at: z.string().datetime({ offset: true }),
          })
          .strict()
      )
      .min(1)
      .max(1000),
  })
  .strict();

const IdParam = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
const EntriesQuery = z
  .object({
    status: z.enum(RECONCILIATION_STATUSES as unknown as [string, ...string[]]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export interface SettlementRoutesOptions {
  security: Security;
  reconciliationService: ReconciliationService;
}

export function publicReport(r: SettlementReportDto) {
  return {
    id: r.id,
    object: 'settlement_report',
    provider: r.provider,
    currency: r.currency,
    period_start: r.periodStart,
    period_end: r.periodEnd,
    status: r.status,
    created_at: r.createdAt,
    reconciled_at: r.reconciledAt,
  };
}

export function publicEntry(e: ReconciliationEntryDto) {
  return {
    object: 'reconciliation_entry',
    provider_ref: e.providerRef,
    status: e.status,
    ledger_amount: e.ledgerAmount === null ? null : Number(e.ledgerAmount),
    provider_amount: e.providerAmount === null ? null : Number(e.providerAmount),
    payment_intent_id: e.paymentIntentId,
  };
}

export function registerSettlementRoutes(
  app: FastifyInstance,
  { security, reconciliationService }: SettlementRoutesOptions
): void {
  app.post(
    '/v1/settlement_reports',
    { preHandler: security.apiKey(['payments:write']) },
    async (req, reply) => {
      const body = CreateReportSchema.parse(req.body);
      const report = await reconciliationService.createReport(req.apiKey!.tenantId, {
        provider: body.provider,
        currency: body.currency,
        periodStart: new Date(body.period_start),
        periodEnd: new Date(body.period_end),
      });
      return reply.code(201).send(publicReport(report));
    }
  );

  app.post(
    '/v1/settlement_reports/:id/lines',
    { preHandler: security.apiKey(['payments:write']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const { lines } = LinesSchema.parse(req.body);
      const inserted = await reconciliationService.addLines(
        req.apiKey!.tenantId,
        id,
        lines.map((l) => ({
          providerRef: l.provider_ref,
          amount: BigInt(l.amount),
          fee: l.fee === undefined ? undefined : BigInt(l.fee),
          settledAt: new Date(l.settled_at),
        }))
      );
      return { object: 'settlement_lines', inserted };
    }
  );

  app.post(
    '/v1/settlement_reports/:id/reconcile',
    { preHandler: security.apiKey(['payments:write']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const summary = await reconciliationService.reconcile(req.apiKey!.tenantId, id);
      return { object: 'reconciliation_summary', report_id: id, summary };
    }
  );

  app.get('/v1/settlement_reports', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { limit } = ListQuery.parse(req.query ?? {});
    const reports = await reconciliationService.listReports(req.apiKey!.tenantId, limit);
    return { object: 'list', data: reports.map(publicReport) };
  });

  app.get('/v1/settlement_reports/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const [report, summary] = await Promise.all([
      reconciliationService.getReport(req.apiKey!.tenantId, id),
      reconciliationService.getSummary(req.apiKey!.tenantId, id),
    ]);
    return { ...publicReport(report), summary };
  });

  app.get(
    '/v1/settlement_reports/:id/entries',
    { preHandler: security.apiKey(['read']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const q = EntriesQuery.parse(req.query ?? {});
      const entries = await reconciliationService.listEntries(req.apiKey!.tenantId, id, {
        status: q.status as never,
        limit: q.limit,
      });
      return { object: 'list', data: entries.map(publicEntry) };
    }
  );
}
