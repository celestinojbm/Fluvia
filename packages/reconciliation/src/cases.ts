import { insertAuditEvent, type AuditContext } from '@fluvia/audit';
import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';

/**
 * Casos operativos de conciliación (F4-03a). Cada discrepancia (una
 * `reconciliation_entry` != matched) se materializa como un `operational_case`
 * por el trigger de 0029; este servicio los expone y gobierna su ciclo de vida
 * (open → acknowledged → resolved) bajo el rol `fluvia_app` (RLS por tenant).
 *
 * Nivel A: resolver un caso es DOCUMENTAL — registra la disposición del operador,
 * NO mueve dinero ni ajusta saldos. El ajuste monetario con four-eyes es F4-03b.
 */

export const CASE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type CaseSeverity = (typeof CASE_SEVERITIES)[number];

export const CASE_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export class OperationalCaseNotFoundError extends Error {
  constructor() {
    super('Operational case not found');
    this.name = 'OperationalCaseNotFoundError';
  }
}

/** El caso no admite esa transición desde su estado actual (p.ej. ya resuelto). */
export class InvalidCaseTransitionError extends Error {
  constructor(from: string, action: string) {
    super(`Operational case in status '${from}' cannot ${action}`);
    this.name = 'InvalidCaseTransitionError';
  }
}

export interface OperationalCaseDto {
  id: string;
  caseType: string;
  severity: CaseSeverity;
  status: CaseStatus;
  reconciliationEntryId: string;
  reportId: string | null;
  provider: string | null;
  providerRef: string | null;
  discrepancyStatus: string | null;
  ledgerAmount: string | null;
  providerAmount: string | null;
  assigneeUserId: string | null;
  resolution: string | null;
  resolvedByUserId: string | null;
  version: number;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface ListCasesOptions {
  status?: CaseStatus;
  severity?: CaseSeverity;
  limit?: number;
}

interface CaseRow {
  id: string;
  case_type: string;
  severity: CaseSeverity;
  status: CaseStatus;
  reconciliation_entry_id: string;
  report_id: string | null;
  provider: string | null;
  provider_ref: string | null;
  discrepancy_status: string | null;
  ledger_amount: string | null;
  provider_amount: string | null;
  assignee_user_id: string | null;
  resolution: string | null;
  resolved_by_user_id: string | null;
  version: string;
  created_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
}

const CASE_COLUMNS = `id, case_type, severity, status, reconciliation_entry_id, report_id,
  provider, provider_ref, discrepancy_status, ledger_amount::text, provider_amount::text,
  assignee_user_id, resolution, resolved_by_user_id, version, created_at, acknowledged_at, resolved_at`;

function toDto(r: CaseRow): OperationalCaseDto {
  return {
    id: r.id,
    caseType: r.case_type,
    severity: r.severity,
    status: r.status,
    reconciliationEntryId: r.reconciliation_entry_id,
    reportId: r.report_id,
    provider: r.provider,
    providerRef: r.provider_ref,
    discrepancyStatus: r.discrepancy_status,
    ledgerAmount: r.ledger_amount,
    providerAmount: r.provider_amount,
    assigneeUserId: r.assignee_user_id,
    resolution: r.resolution,
    resolvedByUserId: r.resolved_by_user_id,
    version: Number(r.version),
    createdAt: r.created_at.toISOString(),
    acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
    resolvedAt: r.resolved_at?.toISOString() ?? null,
  };
}

/** El actor de sesión es un user; el de API key no — solo el user se persiste. */
function userActorId(context: AuditContext): string | null {
  return context.actorType === 'user' && context.actorId ? context.actorId : null;
}

export class OperationalCaseService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool
  ) {}

  async list(tenantId: string, options: ListCasesOptions = {}): Promise<OperationalCaseDto[]> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<CaseRow>(
        `SELECT ${CASE_COLUMNS}
         FROM operational_cases
         WHERE ($1::text IS NULL OR status = $1)
           AND ($2::text IS NULL OR severity = $2)
         ORDER BY created_at DESC, id
         LIMIT $3`,
        [options.status ?? null, options.severity ?? null, limit]
      );
      return res.rows.map(toDto);
    });
  }

  async get(tenantId: string, caseId: string): Promise<OperationalCaseDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<CaseRow>(
        `SELECT ${CASE_COLUMNS} FROM operational_cases WHERE id = $1`,
        [caseId]
      );
      if (!res.rows[0]) throw new OperationalCaseNotFoundError();
      return toDto(res.rows[0]);
    });
  }

  /** open → acknowledged (toma de posesión). Idempotencia por guard de estado. */
  async acknowledge(
    tenantId: string,
    caseId: string,
    context: AuditContext,
    options: { assigneeUserId?: string | null } = {}
  ): Promise<OperationalCaseDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const current = await this.loadForUpdate(c, caseId);
      if (current.status !== 'open') {
        throw new InvalidCaseTransitionError(current.status, 'be acknowledged');
      }
      const assignee = options.assigneeUserId ?? userActorId(context);
      const res = await c.query<CaseRow>(
        `UPDATE operational_cases
         SET status = 'acknowledged', acknowledged_at = now(),
             assignee_user_id = $2, version = version + 1
         WHERE id = $1
         RETURNING ${CASE_COLUMNS}`,
        [caseId, assignee]
      );
      await insertAuditEvent(c, {
        action: 'operational_case.acknowledged',
        tenantId,
        context,
        resourceType: 'operational_case',
        resourceId: caseId,
        riskLevel: 'low',
        reason: `acknowledged reconciliation case (${current.discrepancy_status ?? 'unknown'})`,
      });
      return toDto(res.rows[0]!);
    });
  }

  /**
   * open|acknowledged → resolved con resolución OBLIGATORIA. DOCUMENTAL: no
   * mueve dinero ni ajusta saldos (el ajuste con four-eyes es F4-03b).
   */
  async resolve(
    tenantId: string,
    caseId: string,
    resolution: string,
    context: AuditContext
  ): Promise<OperationalCaseDto> {
    const note = resolution.trim();
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const current = await this.loadForUpdate(c, caseId);
      if (current.status === 'resolved') {
        throw new InvalidCaseTransitionError(current.status, 'be resolved');
      }
      const res = await c.query<CaseRow>(
        `UPDATE operational_cases
         SET status = 'resolved', resolved_at = now(), resolution = $2,
             resolved_by_user_id = $3, version = version + 1
         WHERE id = $1
         RETURNING ${CASE_COLUMNS}`,
        [caseId, note, userActorId(context)]
      );
      await insertAuditEvent(c, {
        action: 'operational_case.resolved',
        tenantId,
        context,
        resourceType: 'operational_case',
        resourceId: caseId,
        riskLevel: 'medium',
        reason: note,
        before: { status: current.status, discrepancy: current.discrepancy_status },
      });
      return toDto(res.rows[0]!);
    });
  }

  private async loadForUpdate(c: PoolClient, caseId: string): Promise<CaseRow> {
    const res = await c.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM operational_cases WHERE id = $1 FOR UPDATE`,
      [caseId]
    );
    if (!res.rows[0]) throw new OperationalCaseNotFoundError();
    return res.rows[0];
  }
}
