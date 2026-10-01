import type { Pool, PoolClient } from '@fluvia/db';
import { insertAuditEvent } from '@fluvia/audit';
import { auditContextOf, withProgramTx, type ProgramActor } from './context.js';
import { InvalidStateError, ResourceNotFoundError } from './errors.js';

export type CaseType =
  | 'uncertain_withdrawal'
  | 'uncertain_authorization'
  | 'uncertain_refund'
  | 'unmatched_provider_event'
  | 'reconciliation_mismatch'
  | 'overdue_debt'
  | 'customer_incident';

export interface OpenCaseInput {
  tenantId: string;
  consumerId?: string | null;
  caseType: CaseType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  subjectType: string;
  subjectId: string;
  summary: string;
  evidence?: Record<string, unknown>;
}

/**
 * Abre un caso DENTRO de la transacción del llamador. Idempotente: como mucho
 * un caso abierto por (tipo, sujeto). Devuelve el id (nuevo o existente).
 */
export async function openCase(c: PoolClient, input: OpenCaseInput): Promise<string> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO program_cases
       (tenant_id, consumer_id, case_type, severity, subject_type, subject_id, summary, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, case_type, subject_type, subject_id) WHERE status <> 'resolved'
     DO NOTHING RETURNING id`,
    [
      input.tenantId,
      input.consumerId ?? null,
      input.caseType,
      input.severity,
      input.subjectType,
      input.subjectId,
      input.summary,
      JSON.stringify(input.evidence ?? {}),
    ]
  );
  if (res.rows[0]) {
    await insertAuditEvent(c, {
      action: 'program.case_opened',
      tenantId: input.tenantId,
      context: { actorType: 'system', authMethod: 'none' },
      resourceType: 'program_case',
      resourceId: res.rows[0].id,
      riskLevel: input.severity === 'low' ? 'low' : input.severity === 'medium' ? 'medium' : 'high',
      after: { case_type: input.caseType, subject: `${input.subjectType}:${input.subjectId}` },
    });
    return res.rows[0].id;
  }
  const existing = await c.query<{ id: string }>(
    `SELECT id FROM program_cases WHERE tenant_id = $1 AND case_type = $2 AND subject_type = $3
       AND subject_id = $4 AND status <> 'resolved'`,
    [input.tenantId, input.caseType, input.subjectType, input.subjectId]
  );
  return existing.rows[0]!.id;
}

/** Cierra automáticamente el caso abierto de un sujeto (resolución verificada). */
export async function autoResolveCase(
  c: PoolClient,
  tenantId: string,
  caseType: CaseType,
  subjectType: string,
  subjectId: string,
  resolution: string
): Promise<void> {
  const res = await c.query<{ id: string }>(
    `UPDATE program_cases
        SET status = 'resolved', resolution = $5, resolved_at = now(), version = version + 1
      WHERE tenant_id = $1 AND case_type = $2 AND subject_type = $3 AND subject_id = $4
        AND status <> 'resolved'
      RETURNING id`,
    [tenantId, caseType, subjectType, subjectId, resolution]
  );
  for (const r of res.rows) {
    await insertAuditEvent(c, {
      action: 'program.case_resolved',
      tenantId,
      context: { actorType: 'system', authMethod: 'none' },
      resourceType: 'program_case',
      resourceId: r.id,
      after: { resolution },
    });
  }
}

export interface CaseDto {
  id: string;
  consumerId: string | null;
  caseType: CaseType;
  severity: string;
  status: 'open' | 'acknowledged' | 'resolved';
  subjectType: string;
  subjectId: string;
  summary: string;
  evidence: Record<string, unknown>;
  assigneeUserId: string | null;
  resolution: string | null;
  resolvedByUserId: string | null;
  version: number;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

interface CaseRow {
  id: string;
  consumer_id: string | null;
  case_type: CaseType;
  severity: string;
  status: CaseDto['status'];
  subject_type: string;
  subject_id: string;
  summary: string;
  evidence: Record<string, unknown>;
  assignee_user_id: string | null;
  resolution: string | null;
  resolved_by_user_id: string | null;
  version: number;
  created_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
}

function toDto(r: CaseRow): CaseDto {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    caseType: r.case_type,
    severity: r.severity,
    status: r.status,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    summary: r.summary,
    evidence: r.evidence,
    assigneeUserId: r.assignee_user_id,
    resolution: r.resolution,
    resolvedByUserId: r.resolved_by_user_id,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
    resolvedAt: r.resolved_at?.toISOString() ?? null,
  };
}

export class CaseService {
  constructor(private readonly appPool: Pool) {}

  async list(
    tenantId: string,
    filter: { status?: string; consumerId?: string; caseType?: string } = {}
  ): Promise<CaseDto[]> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<CaseRow>(
        `SELECT * FROM program_cases
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR status = $2)
            AND ($3::uuid IS NULL OR consumer_id = $3)
            AND ($4::text IS NULL OR case_type = $4)
          ORDER BY (status = 'resolved'), created_at DESC LIMIT 200`,
        [tenantId, filter.status ?? null, filter.consumerId ?? null, filter.caseType ?? null]
      );
      return res.rows.map(toDto);
    });
  }

  async get(tenantId: string, caseId: string): Promise<CaseDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<CaseRow>(
        `SELECT * FROM program_cases WHERE id = $1 AND tenant_id = $2`,
        [caseId, tenantId]
      );
      if (!res.rows[0]) throw new ResourceNotFoundError('Case');
      return toDto(res.rows[0]);
    });
  }

  /** Incidencia abierta por un operador (p. ej. reclamo del cliente). */
  async openIncident(
    tenantId: string,
    input: { consumerId?: string; summary: string; subjectType: string; subjectId: string },
    actor: Extract<ProgramActor, { kind: 'operator' }>
  ): Promise<CaseDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const id = await openCase(c, {
        tenantId,
        consumerId: input.consumerId ?? null,
        caseType: 'customer_incident',
        severity: 'medium',
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        summary: input.summary,
        evidence: { opened_by: actor.userId },
      });
      const res = await c.query<CaseRow>(`SELECT * FROM program_cases WHERE id = $1`, [id]);
      return toDto(res.rows[0]!);
    });
  }

  async acknowledge(
    tenantId: string,
    caseId: string,
    actor: Extract<ProgramActor, { kind: 'operator' }>
  ): Promise<CaseDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<CaseRow>(
        `UPDATE program_cases
            SET status = 'acknowledged', acknowledged_at = now(), assignee_user_id = $3,
                version = version + 1
          WHERE id = $1 AND tenant_id = $2 AND status = 'open' RETURNING *`,
        [caseId, tenantId, actor.userId]
      );
      if (!res.rows[0]) {
        const cur = await c.query<{ status: string }>(
          `SELECT status FROM program_cases WHERE id = $1 AND tenant_id = $2`,
          [caseId, tenantId]
        );
        if (!cur.rows[0]) throw new ResourceNotFoundError('Case');
        throw new InvalidStateError('case', cur.rows[0].status);
      }
      await insertAuditEvent(c, {
        action: 'program.case_acknowledged',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'program_case',
        resourceId: caseId,
      });
      return toDto(res.rows[0]);
    });
  }

  /**
   * Resolución DOCUMENTAL (no mueve dinero). Los inciertos se resuelven con
   * `UncertainResolver` (fuente verificada), que cierra su caso por sí solo.
   */
  async resolve(
    tenantId: string,
    caseId: string,
    resolution: string,
    actor: Extract<ProgramActor, { kind: 'operator' }>
  ): Promise<CaseDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const cur = await c.query<CaseRow>(
        `SELECT * FROM program_cases WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [caseId, tenantId]
      );
      const row = cur.rows[0];
      if (!row) throw new ResourceNotFoundError('Case');
      if (row.status === 'resolved') throw new InvalidStateError('case', row.status);
      if (row.case_type.startsWith('uncertain_')) {
        // Un incierto con dinero retenido no se «cierra a mano»: requiere la
        // fuente verificada (consulta al proveedor o evento).
        throw new InvalidStateError('case', 'requires_verified_resolution');
      }
      const res = await c.query<CaseRow>(
        `UPDATE program_cases
            SET status = 'resolved', resolution = $3, resolved_at = now(),
                resolved_by_user_id = $4, version = version + 1
          WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [caseId, tenantId, resolution, actor.userId]
      );
      await insertAuditEvent(c, {
        action: 'program.case_resolved',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'program_case',
        resourceId: caseId,
        riskLevel: 'medium',
        reason: resolution,
      });
      return toDto(res.rows[0]!);
    });
  }
}
