import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';

export * from './cases.js';

/**
 * Motor de conciliación (F4-01a). Casa lo que Fluvia cree liquidado (intentos
 * `succeeded` con `provider_ref` en payment_attempts) contra el reporte de
 * liquidación del proveedor (settlement_lines), y clasifica cada referencia.
 * Todo per-tenant bajo RLS (`fluvia_app`); append-only: cada corrida es inmutable.
 */

export const RECONCILIATION_STATUSES = [
  'matched',
  'amount_mismatch',
  'missing_in_ledger',
  'missing_at_provider',
] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export class SettlementReportNotFoundError extends Error {
  constructor() {
    super('Settlement report not found');
    this.name = 'SettlementReportNotFoundError';
  }
}

/** Un reporte solo se concilia una vez (append-only: la corrida es inmutable). */
export class ReportAlreadyReconciledError extends Error {
  constructor() {
    super('Settlement report is already reconciled');
    this.name = 'ReportAlreadyReconciledError';
  }
}

export interface CreateReportInput {
  provider: string;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface SettlementLineInput {
  providerRef: string;
  amount: bigint;
  fee?: bigint;
  settledAt: Date;
}

export interface SettlementReportDto {
  id: string;
  provider: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  createdAt: string;
  reconciledAt: string | null;
}

export type ReconciliationSummary = Record<ReconciliationStatus, number>;

export interface ReconciliationEntryDto {
  providerRef: string;
  status: ReconciliationStatus;
  ledgerAmount: string | null;
  providerAmount: string | null;
  paymentIntentId: string | null;
}

interface ReportRow {
  id: string;
  provider: string;
  currency: string;
  period_start: Date;
  period_end: Date;
  status: string;
  created_at: Date;
  reconciled_at: Date | null;
}

function toReportDto(r: ReportRow): SettlementReportDto {
  return {
    id: r.id,
    provider: r.provider,
    currency: r.currency.trim(),
    periodStart: r.period_start.toISOString(),
    periodEnd: r.period_end.toISOString(),
    status: r.status,
    createdAt: r.created_at.toISOString(),
    reconciledAt: r.reconciled_at?.toISOString() ?? null,
  };
}

const emptySummary = (): ReconciliationSummary => ({
  matched: 0,
  amount_mismatch: 0,
  missing_in_ledger: 0,
  missing_at_provider: 0,
});

export class ReconciliationService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool
  ) {}

  async createReport(tenantId: string, input: CreateReportInput): Promise<SettlementReportDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<ReportRow>(
        `INSERT INTO settlement_reports (tenant_id, provider, currency, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, provider, currency, period_start, period_end, status, created_at, reconciled_at`,
        [tenantId, input.provider, input.currency, input.periodStart, input.periodEnd]
      );
      return toReportDto(res.rows[0]!);
    });
  }

  /** Ingesta idempotente por línea: una misma (provider, provider_ref) por reporte. */
  async addLines(
    tenantId: string,
    reportId: string,
    lines: SettlementLineInput[]
  ): Promise<number> {
    if (lines.length === 0) return 0;
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const report = await this.loadOpenReport(c, reportId);
      let inserted = 0;
      for (const l of lines) {
        const res = await c.query(
          `INSERT INTO settlement_lines
             (report_id, tenant_id, provider, provider_ref, amount, currency, fee, settled_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (report_id, provider, provider_ref) DO NOTHING`,
          [
            reportId,
            tenantId,
            report.provider,
            l.providerRef,
            l.amount.toString(),
            report.currency,
            (l.fee ?? 0n).toString(),
            l.settledAt,
          ]
        );
        inserted += res.rowCount ?? 0;
      }
      return inserted;
    });
  }

  /**
   * Concilia un reporte `open`: FULL OUTER JOIN entre las líneas del proveedor y
   * los intentos `succeeded` del tenant (mismo proveedor/moneda, dentro del
   * periodo), clasifica cada referencia y persiste `reconciliation_entries` +
   * marca el reporte `reconciled`. Todo en UNA transacción.
   */
  async reconcile(tenantId: string, reportId: string): Promise<ReconciliationSummary> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const report = await this.loadOpenReport(c, reportId);

      const res = await c.query<{ status: ReconciliationStatus }>(
        `WITH ledger AS (
           SELECT provider_ref, amount, intent_id
           FROM payment_attempts
           WHERE tenant_id = $1 AND provider = $2 AND status = 'succeeded'
             AND provider_ref IS NOT NULL AND currency = $3
             AND resolved_at >= $4 AND resolved_at < $5
         ),
         lines AS (
           SELECT provider_ref, amount FROM settlement_lines WHERE report_id = $6
         )
         INSERT INTO reconciliation_entries
           (report_id, tenant_id, provider, provider_ref, status,
            ledger_amount, provider_amount, payment_intent_id)
         SELECT $6, $1, $2,
           COALESCE(l.provider_ref, g.provider_ref),
           CASE
             WHEN g.provider_ref IS NULL THEN 'missing_in_ledger'
             WHEN l.provider_ref IS NULL THEN 'missing_at_provider'
             WHEN g.amount = l.amount THEN 'matched'
             ELSE 'amount_mismatch'
           END,
           g.amount, l.amount, g.intent_id
         FROM lines l FULL OUTER JOIN ledger g ON g.provider_ref = l.provider_ref
         RETURNING status`,
        [
          tenantId,
          report.provider,
          report.currency,
          report.period_start,
          report.period_end,
          reportId,
        ]
      );

      await c.query(
        `UPDATE settlement_reports SET status = 'reconciled', reconciled_at = now()
         WHERE id = $1 AND status = 'open'`,
        [reportId]
      );

      const summary = emptySummary();
      for (const row of res.rows) summary[row.status] += 1;
      return summary;
    });
  }

  async listReports(tenantId: string, limit = 20): Promise<SettlementReportDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<ReportRow>(
        `SELECT id, provider, currency, period_start, period_end, status, created_at, reconciled_at
         FROM settlement_reports ORDER BY created_at DESC, id LIMIT $1`,
        [capped]
      );
      return res.rows.map(toReportDto);
    });
  }

  /** Resumen de conciliación de un reporte (recuento por clase de discrepancia). */
  async getSummary(tenantId: string, reportId: string): Promise<ReconciliationSummary> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const exists = await c.query(`SELECT 1 FROM settlement_reports WHERE id = $1`, [reportId]);
      if ((exists.rowCount ?? 0) === 0) throw new SettlementReportNotFoundError();
      const res = await c.query<{ status: ReconciliationStatus; n: string }>(
        `SELECT status, count(*)::text AS n FROM reconciliation_entries
         WHERE report_id = $1 GROUP BY status`,
        [reportId]
      );
      const summary = emptySummary();
      for (const row of res.rows) summary[row.status] = Number(row.n);
      return summary;
    });
  }

  async getReport(tenantId: string, reportId: string): Promise<SettlementReportDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<ReportRow>(
        `SELECT id, provider, currency, period_start, period_end, status, created_at, reconciled_at
         FROM settlement_reports WHERE id = $1`,
        [reportId]
      );
      if (!res.rows[0]) throw new SettlementReportNotFoundError();
      return toReportDto(res.rows[0]);
    });
  }

  async listEntries(
    tenantId: string,
    reportId: string,
    options: { status?: ReconciliationStatus; limit?: number } = {}
  ): Promise<ReconciliationEntryDto[]> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 500);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<{
        provider_ref: string;
        status: ReconciliationStatus;
        ledger_amount: string | null;
        provider_amount: string | null;
        payment_intent_id: string | null;
      }>(
        `SELECT provider_ref, status, ledger_amount::text, provider_amount::text, payment_intent_id
         FROM reconciliation_entries
         WHERE report_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY status, provider_ref
         LIMIT $3`,
        [reportId, options.status ?? null, limit]
      );
      return res.rows.map((r) => ({
        providerRef: r.provider_ref,
        status: r.status,
        ledgerAmount: r.ledger_amount,
        providerAmount: r.provider_amount,
        paymentIntentId: r.payment_intent_id,
      }));
    });
  }

  private async loadOpenReport(c: PoolClient, reportId: string): Promise<ReportRow> {
    const res = await c.query<ReportRow>(
      `SELECT id, provider, currency, period_start, period_end, status, created_at, reconciled_at
       FROM settlement_reports WHERE id = $1 FOR UPDATE`,
      [reportId]
    );
    const row = res.rows[0];
    if (!row) throw new SettlementReportNotFoundError();
    if (row.status !== 'open') throw new ReportAlreadyReconciledError();
    return row;
  }
}
