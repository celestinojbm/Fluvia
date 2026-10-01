import type { Pool, PoolClient } from '@fluvia/db';
import { insertAuditEvent } from '@fluvia/audit';
import { isCurrencyCode } from '@fluvia/money';
import { auditContextOf, withProgramTx, type ProgramActor } from './context.js';
import {
  CurrencyNotSupportedError,
  FourEyesRequiredError,
  InvalidPolicyError,
  InvalidStateError,
  PolicyNotActiveError,
  ProgramNotFoundError,
  ResourceNotFoundError,
} from './errors.js';
import {
  PolicyParamsSchema,
  REFERENCE_POLICY_CODE,
  REFERENCE_POLICY_PARAMS,
  parsePolicyParams,
  serializePolicyParams,
  type PolicyParams,
} from './policy.js';

export interface ProgramDto {
  tenantId: string;
  name: string;
  currencies: string[];
  issuerAdapter: string;
  fundingAdapter: string;
  settlementDelayDays: number;
  sandbox: boolean;
}

export interface PolicyDto {
  id: string;
  code: string;
  version: number;
  status: 'draft' | 'active' | 'retired';
  params: Record<string, unknown>;
  isReference: boolean;
  synthetic: boolean;
  pendingCommercialValidation: boolean;
  createdByUserId: string | null;
  approvedByUserId: string | null;
  activatedAt: string | null;
  createdAt: string;
}

export interface ActivePolicy {
  id: string;
  code: string;
  version: number;
  params: PolicyParams;
}

interface PolicyRow {
  id: string;
  code: string;
  version: number;
  status: PolicyDto['status'];
  params: Record<string, unknown>;
  is_reference: boolean;
  synthetic: boolean;
  pending_commercial_validation: boolean;
  created_by_user_id: string | null;
  approved_by_user_id: string | null;
  activated_at: Date | null;
  created_at: Date;
}

function toPolicyDto(r: PolicyRow): PolicyDto {
  return {
    id: r.id,
    code: r.code,
    version: r.version,
    status: r.status,
    params: r.params,
    isReference: r.is_reference,
    synthetic: r.synthetic,
    pendingCommercialValidation: r.pending_commercial_validation,
    createdByUserId: r.created_by_user_id,
    approvedByUserId: r.approved_by_user_id,
    activatedAt: r.activated_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

/** Política activa del programa, leída DENTRO de la transacción del llamador. */
export async function loadActivePolicy(c: PoolClient, tenantId: string): Promise<ActivePolicy> {
  const res = await c.query<{ id: string; code: string; version: number; params: unknown }>(
    `SELECT id, code, version, params FROM credit_policies WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId]
  );
  const row = res.rows[0];
  if (!row) throw new PolicyNotActiveError();
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    params: parsePolicyParams(row.params),
  };
}

export async function loadPolicyById(
  c: PoolClient,
  policyId: string
): Promise<ActivePolicy & { status: string }> {
  const res = await c.query<{
    id: string;
    code: string;
    version: number;
    params: unknown;
    status: string;
  }>(`SELECT id, code, version, params, status FROM credit_policies WHERE id = $1`, [policyId]);
  const row = res.rows[0];
  if (!row) throw new ResourceNotFoundError('Policy');
  return { ...row, params: parsePolicyParams(row.params) };
}

export async function loadProgram(c: PoolClient, tenantId: string): Promise<ProgramDto> {
  const res = await c.query<{
    tenant_id: string;
    name: string;
    currencies: string[];
    issuer_adapter: string;
    funding_adapter: string;
    settlement_delay_days: number;
    sandbox: boolean;
  }>(`SELECT * FROM consumer_programs WHERE tenant_id = $1`, [tenantId]);
  const r = res.rows[0];
  if (!r) throw new ProgramNotFoundError();
  return {
    tenantId: r.tenant_id,
    name: r.name,
    currencies: r.currencies,
    issuerAdapter: r.issuer_adapter,
    fundingAdapter: r.funding_adapter,
    settlementDelayDays: r.settlement_delay_days,
    sandbox: r.sandbox,
  };
}

export async function assertProgramCurrency(
  c: PoolClient,
  tenantId: string,
  currency: string
): Promise<void> {
  const program = await loadProgram(c, tenantId);
  if (!program.currencies.includes(currency)) throw new CurrencyNotSupportedError(currency);
}

export class ProgramService {
  constructor(private readonly appPool: Pool) {}

  /**
   * Convierte una organización en PROGRAMA de consumo (sandbox) y le da la
   * política de referencia activa. Idempotente.
   */
  async setupProgram(
    tenantId: string,
    input: { name: string; currencies: string[]; settlementDelayDays?: number },
    actor: ProgramActor
  ): Promise<ProgramDto> {
    for (const ccy of input.currencies) {
      if (!isCurrencyCode(ccy)) throw new CurrencyNotSupportedError(ccy);
    }
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const ins = await c.query(
        `INSERT INTO consumer_programs (tenant_id, name, currencies, settlement_delay_days)
         VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, input.name, input.currencies, input.settlementDelayDays ?? 1]
      );
      if ((ins.rowCount ?? 0) > 0) {
        const params = serializePolicyParams(parsePolicyParams(REFERENCE_POLICY_PARAMS));
        await c.query(
          `INSERT INTO credit_policies
             (tenant_id, code, version, status, params, is_reference, synthetic, activated_at)
           VALUES ($1, $2, 1, 'active', $3, true, true, now())`,
          [tenantId, REFERENCE_POLICY_CODE, JSON.stringify(params)]
        );
        await insertAuditEvent(c, {
          action: 'program.created',
          tenantId,
          context: auditContextOf(actor),
          resourceType: 'consumer_program',
          resourceId: tenantId,
          after: { currencies: input.currencies, reference_policy: REFERENCE_POLICY_CODE },
        });
      }
      return loadProgram(c, tenantId);
    });
  }

  async getProgram(tenantId: string): Promise<ProgramDto> {
    return withProgramTx(this.appPool, tenantId, null, (c) => loadProgram(c, tenantId));
  }

  async listPolicies(tenantId: string): Promise<PolicyDto[]> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<PolicyRow>(
        `SELECT * FROM credit_policies WHERE tenant_id = $1 ORDER BY code, version DESC`,
        [tenantId]
      );
      return res.rows.map(toPolicyDto);
    });
  }

  async getActivePolicy(tenantId: string): Promise<PolicyDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<PolicyRow>(
        `SELECT * FROM credit_policies WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId]
      );
      if (!res.rows[0]) throw new PolicyNotActiveError();
      return toPolicyDto(res.rows[0]);
    });
  }

  /** Nueva versión en borrador (operador). No cambia nada hasta activarse. */
  async createPolicyDraft(
    tenantId: string,
    input: { code: string; params: unknown },
    actor: Extract<ProgramActor, { kind: 'operator' }>
  ): Promise<PolicyDto> {
    const parsed = PolicyParamsSchema.safeParse(input.params);
    if (!parsed.success) {
      throw new InvalidPolicyError(parsed.error.issues.map((i) => i.message).join('; '));
    }
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(input.code)) throw new InvalidPolicyError('code');
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('credit_policy:' || $1))`, [tenantId]);
      const v = await c.query<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM credit_policies WHERE tenant_id = $1 AND code = $2`,
        [tenantId, input.code]
      );
      const res = await c.query<PolicyRow>(
        `INSERT INTO credit_policies
           (tenant_id, code, version, status, params, is_reference, synthetic, created_by_user_id)
         VALUES ($1, $2, $3, 'draft', $4, false, true, $5) RETURNING *`,
        [
          tenantId,
          input.code,
          v.rows[0]!.next,
          JSON.stringify(serializePolicyParams(parsed.data)),
          actor.userId,
        ]
      );
      await insertAuditEvent(c, {
        action: 'credit.policy_created',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'credit_policy',
        resourceId: res.rows[0]!.id,
        riskLevel: 'medium',
        after: { code: input.code, version: v.rows[0]!.next },
      });
      return toPolicyDto(res.rows[0]!);
    });
  }

  /** Propone activar una versión (primera persona). */
  async proposeActivation(
    tenantId: string,
    policyId: string,
    reason: string,
    actor: Extract<ProgramActor, { kind: 'operator' }>
  ): Promise<{ approvalId: string }> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const p = await c.query<{ status: string }>(
        `SELECT status FROM credit_policies WHERE id = $1 AND tenant_id = $2`,
        [policyId, tenantId]
      );
      if (!p.rows[0]) throw new ResourceNotFoundError('Policy');
      if (p.rows[0].status !== 'draft') throw new InvalidStateError('policy', p.rows[0].status);
      const res = await c.query<{ id: string }>(
        `INSERT INTO program_approvals (tenant_id, action, subject_id, payload, reason, proposed_by_user_id)
         VALUES ($1, 'policy.activate', $2, '{}'::jsonb, $3, $4)
         ON CONFLICT (tenant_id, action, subject_id) WHERE status = 'proposed' DO NOTHING
         RETURNING id`,
        [tenantId, policyId, reason, actor.userId]
      );
      const id =
        res.rows[0]?.id ??
        (
          await c.query<{ id: string }>(
            `SELECT id FROM program_approvals WHERE tenant_id = $1 AND action = 'policy.activate'
               AND subject_id = $2 AND status = 'proposed'`,
            [tenantId, policyId]
          )
        ).rows[0]!.id;
      await insertAuditEvent(c, {
        action: 'program.approval_proposed',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'program_approval',
        resourceId: id,
        riskLevel: 'high',
        reason,
        after: { action: 'policy.activate', policy_id: policyId },
      });
      return { approvalId: id };
    });
  }

  /**
   * Decide una aprobación pendiente (segunda persona). `approve` ejecuta la
   * acción en la MISMA transacción; el motor rechaza aprobador = proponente.
   */
  async decideApproval(
    tenantId: string,
    approvalId: string,
    decision: 'approve' | 'reject',
    actor: Extract<ProgramActor, { kind: 'operator' }>,
    execute?: (c: PoolClient, approval: ApprovalRow) => Promise<void>
  ): Promise<{ status: 'executed' | 'rejected' }> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<ApprovalRow>(
        `SELECT * FROM program_approvals WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [approvalId, tenantId]
      );
      const row = res.rows[0];
      if (!row) throw new ResourceNotFoundError('Approval');
      if (row.status !== 'proposed') throw new InvalidStateError('approval', row.status);
      if (row.proposed_by_user_id === actor.userId) throw new FourEyesRequiredError();
      const status = decision === 'approve' ? 'executed' : 'rejected';
      if (decision === 'approve') {
        if (row.action === 'policy.activate') {
          await this.activatePolicy(c, tenantId, row.subject_id, row.proposed_by_user_id, actor);
        } else if (execute) {
          await execute(c, row);
        } else {
          throw new InvalidStateError('approval', 'no_executor');
        }
      }
      await c.query(
        `UPDATE program_approvals SET status = $2, decided_by_user_id = $3, decided_at = now()
         WHERE id = $1`,
        [approvalId, status, actor.userId]
      );
      await insertAuditEvent(c, {
        action: 'program.approval_decided',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'program_approval',
        resourceId: approvalId,
        riskLevel: 'high',
        after: { action: row.action, decision: status },
      });
      return { status };
    });
  }

  private async activatePolicy(
    c: PoolClient,
    tenantId: string,
    policyId: string,
    proposedBy: string,
    approver: Extract<ProgramActor, { kind: 'operator' }>
  ): Promise<void> {
    const p = await c.query<{ status: string; params: unknown }>(
      `SELECT status, params FROM credit_policies WHERE id = $1 FOR UPDATE`,
      [policyId]
    );
    if (!p.rows[0] || p.rows[0].status !== 'draft') {
      throw new InvalidStateError('policy', p.rows[0]?.status ?? 'missing');
    }
    parsePolicyParams(p.rows[0].params);
    await c.query(
      `UPDATE credit_policies SET status = 'retired', retired_at = now()
       WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId]
    );
    await c.query(
      `UPDATE credit_policies
          SET status = 'active', activated_at = now(), approved_by_user_id = $2,
              created_by_user_id = COALESCE(created_by_user_id, $3)
        WHERE id = $1`,
      [policyId, approver.userId, proposedBy]
    );
    await insertAuditEvent(c, {
      action: 'credit.policy_activated',
      tenantId,
      context: auditContextOf(approver),
      resourceType: 'credit_policy',
      resourceId: policyId,
      riskLevel: 'high',
      after: { proposed_by: proposedBy, approved_by: approver.userId },
    });
  }

  async listApprovals(tenantId: string, status?: string): Promise<ApprovalDto[]> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<ApprovalRow>(
        `SELECT * FROM program_approvals WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY created_at DESC LIMIT 100`,
        [tenantId, status ?? null]
      );
      return res.rows.map((r) => ({
        id: r.id,
        action: r.action,
        subjectId: r.subject_id,
        payload: r.payload,
        reason: r.reason,
        status: r.status,
        proposedByUserId: r.proposed_by_user_id,
        decidedByUserId: r.decided_by_user_id,
        createdAt: r.created_at.toISOString(),
        decidedAt: r.decided_at?.toISOString() ?? null,
      }));
    });
  }
}

export interface ApprovalRow {
  id: string;
  tenant_id: string;
  action: 'policy.activate' | 'collateral.apply';
  subject_id: string;
  payload: Record<string, unknown>;
  reason: string;
  status: 'proposed' | 'executed' | 'rejected';
  proposed_by_user_id: string;
  decided_by_user_id: string | null;
  created_at: Date;
  decided_at: Date | null;
}

export interface ApprovalDto {
  id: string;
  action: string;
  subjectId: string;
  payload: Record<string, unknown>;
  reason: string;
  status: string;
  proposedByUserId: string;
  decidedByUserId: string | null;
  createdAt: string;
  decidedAt: string | null;
}
