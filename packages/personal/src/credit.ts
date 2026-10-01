import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from '@fluvia/db';
import { insertAuditEvent } from '@fluvia/audit';
import { InsufficientBalanceError, type ProgramPostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { openCase } from './cases.js';
import {
  auditContextOf,
  consumerScope,
  isUniqueViolation,
  toBig,
  withProgramTx,
  type ProgramActor,
} from './context.js';
import {
  AmountExceedsError,
  ApplicationPendingError,
  CollateralCommittedError,
  IdempotencyMismatchError,
  InsufficientCollateralError,
  InvalidStateError,
  ResourceNotFoundError,
} from './errors.js';
import { evaluateApplication, requiredCollateral, type RiskTier } from './policy.js';
import { assertProgramCurrency, loadActivePolicy, loadPolicyById } from './program.js';
import { assertAmount, assertConsumerActive, mapLedgerFunds } from './wallet.js';

type Operator = Extract<ProgramActor, { kind: 'operator' }>;

function mapCollateral(err: unknown): never {
  if (err instanceof InsufficientBalanceError) throw new InsufficientCollateralError();
  throw err;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------
export interface ApplicationDto {
  id: string;
  consumerId: string;
  currency: string;
  requestedLimit: string;
  collateralAtEvaluation: string;
  policyId: string;
  status: 'approved' | 'rejected' | 'manual_review';
  riskTier: RiskTier;
  proposedLimit: string;
  approvedLimit: string | null;
  decision: {
    reasons: { code: string; message: string }[];
    inputs: Record<string, unknown>;
    policy: { code: string; version: number };
    review?: { decision: string; reason: string; by: string };
  };
  decidedBy: 'engine' | 'operator';
  createdAt: string;
  decidedAt: string | null;
}

export interface LineDto {
  id: string;
  consumerId: string;
  currency: string;
  status: 'active' | 'frozen' | 'closed';
  approvedLimit: string;
  utilized: string;
  reserved: string;
  available: string;
  multiplierBps: number;
  riskTier: string;
  policyId: string;
  collateral: string;
  requiredCollateral: string;
  releasableCollateral: string;
}

export interface InstallmentDto {
  id: string;
  planId: string;
  seq: number;
  amount: string;
  paidAmount: string;
  cancelledAmount: string;
  outstanding: string;
  dueDate: string;
  status: 'scheduled' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';
}

export interface PlanDto {
  id: string;
  consumerId: string;
  lineId: string;
  authorizationId: string;
  currency: string;
  principal: string;
  downPayment: string;
  installmentsCount: number;
  intervalDays: number;
  interestBps: number;
  merchantName: string;
  status: 'active' | 'paid' | 'cancelled';
  outstanding: string;
  terms: Record<string, unknown>;
  createdAt: string;
  installments: InstallmentDto[];
}

interface ApplicationRow {
  id: string;
  consumer_id: string;
  currency: string;
  requested_limit: string;
  collateral_at_evaluation: string;
  policy_id: string;
  status: ApplicationDto['status'];
  risk_tier: RiskTier;
  proposed_limit: string;
  approved_limit: string | null;
  decision: ApplicationDto['decision'];
  decided_by: 'engine' | 'operator';
  created_at: Date;
  decided_at: Date | null;
}

function applicationDto(r: ApplicationRow): ApplicationDto {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    currency: r.currency.trim(),
    requestedLimit: String(r.requested_limit),
    collateralAtEvaluation: String(r.collateral_at_evaluation),
    policyId: r.policy_id,
    status: r.status,
    riskTier: r.risk_tier,
    proposedLimit: String(r.proposed_limit),
    approvedLimit: r.approved_limit === null ? null : String(r.approved_limit),
    decision: r.decision,
    decidedBy: r.decided_by,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
  };
}

interface InstallmentRow {
  id: string;
  plan_id: string;
  seq: number;
  amount: string;
  paid_amount: string;
  cancelled_amount: string;
  due_date: Date | string;
  status: InstallmentDto['status'];
}

function dateOnly(d: Date | string): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

function installmentDto(r: InstallmentRow): InstallmentDto {
  const outstanding = toBig(r.amount) - toBig(r.paid_amount) - toBig(r.cancelled_amount);
  return {
    id: r.id,
    planId: r.plan_id,
    seq: r.seq,
    amount: String(r.amount),
    paidAmount: String(r.paid_amount),
    cancelledAmount: String(r.cancelled_amount),
    outstanding: outstanding.toString(),
    dueDate: dateOnly(r.due_date),
    status: r.status,
  };
}

// ---------------------------------------------------------------------------
// Lectura de exposición (DENTRO de la transacción, tras bloquear la línea)
// ---------------------------------------------------------------------------
interface LockedLine {
  id: string;
  consumer_id: string;
  currency: string;
  approved_limit: string;
  multiplier_bps: number;
  status: 'active' | 'frozen' | 'closed';
  policy_id: string;
  risk_tier: string;
}

export async function lockLine(
  c: PoolClient,
  tenantId: string,
  consumerId: string,
  currency: string
): Promise<LockedLine | null> {
  const res = await c.query<LockedLine>(
    `SELECT id, consumer_id, currency, approved_limit::text, multiplier_bps, status, policy_id, risk_tier
       FROM credit_lines WHERE tenant_id = $1 AND consumer_id = $2 AND currency = $3 FOR UPDATE`,
    [tenantId, consumerId, currency]
  );
  return res.rows[0] ?? null;
}

export async function lineExposure(
  c: PoolClient,
  lineId: string
): Promise<{ utilized: bigint; reserved: bigint; available: bigint; limit: bigint }> {
  const res = await c.query<{
    approved_limit: string;
    utilized: string;
    reserved: string;
    available: string;
  }>(
    `SELECT approved_limit::text, utilized::text, reserved::text, available::text
       FROM credit_line_availability WHERE line_id = $1`,
    [lineId]
  );
  const r = res.rows[0]!;
  return {
    limit: BigInt(r.approved_limit),
    utilized: BigInt(r.utilized),
    reserved: BigInt(r.reserved),
    available: BigInt(r.available),
  };
}

async function recordLimitChange(
  c: PoolClient,
  input: {
    tenantId: string;
    consumerId: string;
    lineId: string;
    oldLimit: bigint | null;
    newLimit: bigint;
    source: 'application' | 'operator' | 'collateral_release' | 'status';
    reason: string;
    actorUserId?: string | null;
    applicationId?: string | null;
  }
): Promise<void> {
  await c.query(
    `INSERT INTO credit_limit_changes
       (tenant_id, consumer_id, line_id, old_limit, new_limit, source, reason, actor_user_id, application_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.tenantId,
      input.consumerId,
      input.lineId,
      input.oldLimit?.toString() ?? null,
      input.newLimit.toString(),
      input.source,
      input.reason,
      input.actorUserId ?? null,
      input.applicationId ?? null,
    ]
  );
}

// ---------------------------------------------------------------------------
// Garantía
// ---------------------------------------------------------------------------
export class CollateralService {
  constructor(
    private readonly appPool: Pool,
    private readonly posting: ProgramPostingService
  ) {}

  /** Bloquea dinero propio como garantía. NO es un pago ni una inicial. */
  async lock(
    tenantId: string,
    consumerId: string,
    input: { amount: bigint; currency: string; clientKey: string },
    actor: ProgramActor
  ): Promise<{ movementId: string; replayed: boolean }> {
    assertAmount(input.amount);
    return withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      const prior = await this.prior(c, tenantId, consumerId, input.clientKey, 'lock', input);
      if (prior) return { movementId: prior, replayed: true };
      await assertProgramCurrency(c, tenantId, input.currency);
      await assertConsumerActive(c, tenantId, consumerId);
      const id = randomUUID();
      const posted = await this.posting
        .post(c, 'collateral.lock', {
          tenantId,
          consumerId,
          amount: Money.of(input.amount, input.currency),
          idempotencyKey: `collateral:${id}:lock`,
          source: { type: 'collateral_movement', id },
        })
        .catch(mapLedgerFunds);
      await c.query(
        `INSERT INTO collateral_movements
           (id, tenant_id, consumer_id, currency, kind, amount, ledger_tx_id, actor, client_key)
         VALUES ($1, $2, $3, $4, 'lock', $5, $6, $7, $8)`,
        [
          id,
          tenantId,
          consumerId,
          input.currency,
          input.amount.toString(),
          posted.transactionId,
          actor.kind === 'operator' ? 'operator' : 'consumer',
          input.clientKey,
        ]
      );
      await insertAuditEvent(c, {
        action: 'collateral.locked',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'collateral_movement',
        resourceId: id,
        after: { amount: input.amount.toString(), currency: input.currency },
      });
      return { movementId: id, replayed: false };
    });
  }

  /**
   * Libera garantía solo si, tras liberar, sigue cubriendo la exposición
   * (deuda + reservas de crédito). El límite se reduce a lo que la garantía
   * restante respalda. Todo bajo lock de la línea.
   */
  async release(
    tenantId: string,
    consumerId: string,
    input: { amount: bigint; currency: string; clientKey: string },
    actor: ProgramActor
  ): Promise<{ movementId: string; replayed: boolean; newLimit: string | null }> {
    assertAmount(input.amount);
    return withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      const prior = await this.prior(c, tenantId, consumerId, input.clientKey, 'release', input);
      if (prior) return { movementId: prior, replayed: true, newLimit: null };
      const line = await lockLine(c, tenantId, consumerId, input.currency);
      const balances = await this.posting.consumerBalances(c, tenantId, consumerId, input.currency);
      if (input.amount > balances.collateral) throw new InsufficientCollateralError();
      const remaining = balances.collateral - input.amount;
      let newLimit: bigint | null = null;
      if (line && line.status !== 'closed') {
        const exp = await lineExposure(c, line.id);
        const exposure = exp.utilized + exp.reserved;
        if (remaining < requiredCollateral(exposure, line.multiplier_bps)) {
          throw new CollateralCommittedError();
        }
        const backed = (remaining * BigInt(line.multiplier_bps)) / 10_000n;
        if (backed < exp.limit) {
          newLimit = backed;
          await c.query(
            `UPDATE credit_lines SET approved_limit = $2, version = version + 1, updated_at = now()
              WHERE id = $1`,
            [line.id, newLimit.toString()]
          );
          await recordLimitChange(c, {
            tenantId,
            consumerId,
            lineId: line.id,
            oldLimit: exp.limit,
            newLimit,
            source: 'collateral_release',
            reason: 'Límite ajustado a la garantía restante',
          });
        }
      }
      const id = randomUUID();
      const posted = await this.posting
        .post(c, 'collateral.release', {
          tenantId,
          consumerId,
          amount: Money.of(input.amount, input.currency),
          idempotencyKey: `collateral:${id}:release`,
          source: { type: 'collateral_movement', id },
        })
        .catch(mapCollateral);
      await c.query(
        `INSERT INTO collateral_movements
           (id, tenant_id, consumer_id, currency, kind, amount, ledger_tx_id, actor, client_key)
         VALUES ($1, $2, $3, $4, 'release', $5, $6, $7, $8)`,
        [
          id,
          tenantId,
          consumerId,
          input.currency,
          input.amount.toString(),
          posted.transactionId,
          actor.kind === 'operator' ? 'operator' : 'consumer',
          input.clientKey,
        ]
      );
      await insertAuditEvent(c, {
        action: 'collateral.released',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'collateral_movement',
        resourceId: id,
        after: {
          amount: input.amount.toString(),
          currency: input.currency,
          new_limit: newLimit?.toString() ?? null,
        },
      });
      return { movementId: id, replayed: false, newLimit: newLimit?.toString() ?? null };
    });
  }

  /**
   * Aplica garantía a deuda VENCIDA. Solo se ejecuta desde una aprobación
   * de doble firma (ver `ProgramService.decideApproval`), dentro de su tx.
   */
  async applyWithin(
    c: PoolClient,
    tenantId: string,
    input: {
      consumerId: string;
      currency: string;
      amount: bigint;
      reason: string;
      approvalId: string;
    },
    approver: Operator,
    credit: CreditService
  ): Promise<void> {
    const policy = await loadActivePolicy(c, tenantId);
    if (policy.params.collateralApplication !== 'manual_operator') {
      throw new InvalidStateError('collateral_application', 'disabled_by_policy');
    }
    const line = await lockLine(c, tenantId, input.consumerId, input.currency);
    if (!line) throw new ResourceNotFoundError('Credit line');
    const overdue = await c.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount - paid_amount - cancelled_amount), 0)::text AS total
         FROM credit_installments i JOIN credit_plans p ON p.id = i.plan_id
        WHERE p.line_id = $1 AND i.status = 'overdue'`,
      [line.id]
    );
    if (input.amount > BigInt(overdue.rows[0]!.total)) throw new AmountExceedsError('overdue debt');
    const id = randomUUID();
    const posted = await this.posting
      .post(c, 'collateral.apply', {
        tenantId,
        consumerId: input.consumerId,
        amount: Money.of(input.amount, input.currency),
        idempotencyKey: `collateral:apply:${input.approvalId}`,
        source: { type: 'program_approval', id: input.approvalId },
      })
      .catch(mapCollateral);
    await c.query(
      `INSERT INTO collateral_movements
         (id, tenant_id, consumer_id, currency, kind, amount, ledger_tx_id, actor, actor_user_id,
          reason, client_key)
       VALUES ($1, $2, $3, $4, 'apply', $5, $6, 'operator', $7, $8, $9)`,
      [
        id,
        tenantId,
        input.consumerId,
        input.currency,
        input.amount.toString(),
        posted.transactionId,
        approver.userId,
        input.reason,
        `apply:${input.approvalId}`,
      ]
    );
    await credit.allocateRepaymentWithin(c, {
      tenantId,
      consumerId: input.consumerId,
      line,
      amount: input.amount,
      source: 'collateral',
      ledgerTxId: posted.transactionId,
      clientKey: `apply:${input.approvalId}`,
      planId: null,
      overdueOnly: true,
    });
    await insertAuditEvent(c, {
      action: 'collateral.applied',
      tenantId,
      context: auditContextOf(approver),
      resourceType: 'collateral_movement',
      resourceId: id,
      riskLevel: 'high',
      reason: input.reason,
      after: { amount: input.amount.toString(), currency: input.currency },
    });
  }

  private async prior(
    c: PoolClient,
    tenantId: string,
    consumerId: string,
    clientKey: string,
    kind: string,
    input: { amount: bigint; currency: string }
  ): Promise<string | null> {
    const res = await c.query<{ id: string; kind: string; amount: string; currency: string }>(
      `SELECT id, kind, amount::text, currency FROM collateral_movements
        WHERE tenant_id = $1 AND consumer_id = $2 AND client_key = $3`,
      [tenantId, consumerId, clientKey]
    );
    const r = res.rows[0];
    if (!r) return null;
    if (
      r.kind !== kind ||
      r.amount !== input.amount.toString() ||
      r.currency.trim() !== input.currency
    ) {
      throw new IdempotencyMismatchError();
    }
    return r.id;
  }
}

// ---------------------------------------------------------------------------
// Crédito: solicitudes, líneas, planes y pagos
// ---------------------------------------------------------------------------
export class CreditService {
  constructor(
    private readonly appPool: Pool,
    private readonly posting: ProgramPostingService
  ) {}

  /** Solicitud evaluada por la política activa, con explicación guardada. */
  async apply(
    tenantId: string,
    consumerId: string,
    input: { currency: string; requestedLimit: bigint; clientKey: string },
    actor: ProgramActor
  ): Promise<{ application: ApplicationDto; line: LineDto | null }> {
    assertAmount(input.requestedLimit);
    try {
      return await withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
        const prior = await c.query<ApplicationRow>(
          `SELECT * FROM credit_applications WHERE tenant_id = $1 AND consumer_id = $2 AND client_key = $3`,
          [tenantId, consumerId, input.clientKey]
        );
        if (prior.rows[0]) {
          const p = prior.rows[0];
          if (
            String(p.requested_limit) !== input.requestedLimit.toString() ||
            p.currency.trim() !== input.currency
          ) {
            throw new IdempotencyMismatchError();
          }
          return {
            application: applicationDto(p),
            line: await this.lineDtoWithin(c, tenantId, consumerId, input.currency),
          };
        }
        await assertProgramCurrency(c, tenantId, input.currency);
        const consumer = await assertConsumerActive(c, tenantId, consumerId);
        const policy = await loadActivePolicy(c, tenantId);
        const existingLine = await lockLine(c, tenantId, consumerId, input.currency);
        if (existingLine?.status === 'closed') throw new InvalidStateError('credit_line', 'closed');
        const balances = await this.posting.consumerBalances(
          c,
          tenantId,
          consumerId,
          input.currency
        );
        const history = await c.query<{ overdue: string; paid: string }>(
          `SELECT COUNT(*) FILTER (WHERE status = 'overdue')::text AS overdue,
                  COUNT(*) FILTER (WHERE status = 'paid')::text AS paid
             FROM credit_installments WHERE tenant_id = $1 AND consumer_id = $2`,
          [tenantId, consumerId]
        );
        const evaluation = evaluateApplication(policy.params, {
          currency: input.currency,
          requestedLimit: input.requestedLimit,
          collateral: balances.collateral,
          syntheticProfile: consumer.profile as RiskTier,
          history: {
            overdueInstallments: Number(history.rows[0]!.overdue),
            paidInstallments: Number(history.rows[0]!.paid),
          },
        });
        const decision = {
          reasons: evaluation.reasons,
          inputs: evaluation.inputs,
          policy: { code: policy.code, version: policy.version },
          multiplier_bps: evaluation.multiplierBps,
        };
        const res = await c.query<ApplicationRow>(
          `INSERT INTO credit_applications
             (tenant_id, consumer_id, currency, requested_limit, collateral_at_evaluation, policy_id,
              status, risk_tier, proposed_limit, approved_limit, decision, decided_by, client_key,
              decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'engine', $12,
                   CASE WHEN $7 = 'manual_review' THEN NULL ELSE now() END)
           RETURNING *`,
          [
            tenantId,
            consumerId,
            input.currency,
            input.requestedLimit.toString(),
            balances.collateral.toString(),
            policy.id,
            evaluation.status,
            evaluation.tier,
            evaluation.proposedLimit.toString(),
            evaluation.status === 'approved' ? evaluation.proposedLimit.toString() : null,
            JSON.stringify(decision),
            input.clientKey,
          ]
        );
        const app = res.rows[0]!;
        await insertAuditEvent(c, {
          action: 'credit.application_submitted',
          tenantId,
          context: auditContextOf(actor),
          resourceType: 'credit_application',
          resourceId: app.id,
          after: {
            status: evaluation.status,
            tier: evaluation.tier,
            proposed_limit: evaluation.proposedLimit.toString(),
          },
        });
        if (evaluation.status === 'approved') {
          await this.upsertLine(c, {
            tenantId,
            consumerId,
            currency: input.currency,
            limit: evaluation.proposedLimit,
            multiplierBps: evaluation.multiplierBps!,
            tier: evaluation.tier,
            policyId: policy.id,
            applicationId: app.id,
            reason: 'Aprobado por la política vigente',
            actorUserId: null,
          });
        }
        return {
          application: applicationDto(app),
          line: await this.lineDtoWithin(c, tenantId, consumerId, input.currency),
        };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'credit_applications_one_review_uq')) {
        throw new ApplicationPendingError();
      }
      throw err;
    }
  }

  private async upsertLine(
    c: PoolClient,
    input: {
      tenantId: string;
      consumerId: string;
      currency: string;
      limit: bigint;
      multiplierBps: number;
      tier: RiskTier;
      policyId: string;
      applicationId: string;
      reason: string;
      actorUserId: string | null;
    }
  ): Promise<void> {
    const existing = await lockLine(c, input.tenantId, input.consumerId, input.currency);
    let lineId: string;
    if (existing) {
      await c.query(
        `UPDATE credit_lines
            SET approved_limit = $2, multiplier_bps = $3, risk_tier = $4, policy_id = $5,
                version = version + 1, updated_at = now()
          WHERE id = $1`,
        [existing.id, input.limit.toString(), input.multiplierBps, input.tier, input.policyId]
      );
      lineId = existing.id;
    } else {
      const res = await c.query<{ id: string }>(
        `INSERT INTO credit_lines
           (tenant_id, consumer_id, currency, approved_limit, multiplier_bps, risk_tier, policy_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          input.tenantId,
          input.consumerId,
          input.currency,
          input.limit.toString(),
          input.multiplierBps,
          input.tier,
          input.policyId,
        ]
      );
      lineId = res.rows[0]!.id;
    }
    await recordLimitChange(c, {
      tenantId: input.tenantId,
      consumerId: input.consumerId,
      lineId,
      oldLimit: existing ? BigInt(existing.approved_limit) : null,
      newLimit: input.limit,
      source: 'application',
      reason: input.reason,
      actorUserId: input.actorUserId,
      applicationId: input.applicationId,
    });
  }

  /** Decisión humana de una solicitud en revisión manual. */
  async decideReview(
    tenantId: string,
    applicationId: string,
    input: { decision: 'approve' | 'reject'; limit?: bigint; reason: string },
    actor: Operator
  ): Promise<ApplicationDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<ApplicationRow>(
        `SELECT * FROM credit_applications WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [applicationId, tenantId]
      );
      const app = res.rows[0];
      if (!app) throw new ResourceNotFoundError('Application');
      if (app.status !== 'manual_review') throw new InvalidStateError('application', app.status);
      const limit = input.limit ?? BigInt(app.proposed_limit);
      if (input.decision === 'approve') {
        if (limit <= 0n || limit > BigInt(app.proposed_limit)) {
          throw new AmountExceedsError('collateral-backed proposed limit');
        }
      }
      const decision = {
        ...app.decision,
        review: { decision: input.decision, reason: input.reason, by: actor.userId },
      };
      const upd = await c.query<ApplicationRow>(
        `UPDATE credit_applications
            SET status = $2, approved_limit = $3, decision = $4, decided_by = 'operator',
                decided_by_user_id = $5, decided_at = now()
          WHERE id = $1 RETURNING *`,
        [
          applicationId,
          input.decision === 'approve' ? 'approved' : 'rejected',
          input.decision === 'approve' ? limit.toString() : null,
          JSON.stringify(decision),
          actor.userId,
        ]
      );
      if (input.decision === 'approve') {
        await this.upsertLine(c, {
          tenantId,
          consumerId: app.consumer_id,
          currency: app.currency.trim(),
          limit,
          multiplierBps: Number(
            (app.decision as unknown as { multiplier_bps: number }).multiplier_bps
          ),
          tier: app.risk_tier,
          policyId: app.policy_id,
          applicationId,
          reason: `Revisión manual: ${input.reason}`,
          actorUserId: actor.userId,
        });
      }
      await insertAuditEvent(c, {
        action: 'credit.application_decided',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'credit_application',
        resourceId: applicationId,
        riskLevel: 'high',
        reason: input.reason,
        after: { decision: input.decision, limit: limit.toString() },
      });
      return applicationDto(upd.rows[0]!);
    });
  }

  /**
   * Cambio de límite por un operador (step-up en la API). Nunca por encima
   * de lo que respalda la garantía con el multiplicador de la línea ni del
   * máximo de la política.
   */
  async changeLimit(
    tenantId: string,
    lineId: string,
    input: { newLimit: bigint; reason: string },
    actor: Operator
  ): Promise<LineDto> {
    if (input.newLimit < 0n) throw new AmountExceedsError('allowed range');
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const lr = await c.query<LockedLine>(
        `SELECT id, consumer_id, currency, approved_limit::text, multiplier_bps, status, policy_id, risk_tier
           FROM credit_lines WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [lineId, tenantId]
      );
      const line = lr.rows[0];
      if (!line) throw new ResourceNotFoundError('Credit line');
      if (line.status === 'closed') throw new InvalidStateError('credit_line', 'closed');
      const currency = line.currency.trim();
      const balances = await this.posting.consumerBalances(c, tenantId, line.consumer_id, currency);
      const backed = (balances.collateral * BigInt(line.multiplier_bps)) / 10_000n;
      const policy = await loadPolicyById(c, line.policy_id);
      const maxLimit = policy.params.currencies[currency]?.maxLimit ?? 0n;
      if (input.newLimit > backed || input.newLimit > maxLimit) {
        throw new AmountExceedsError('collateral-backed limit');
      }
      await c.query(
        `UPDATE credit_lines SET approved_limit = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [lineId, input.newLimit.toString()]
      );
      await recordLimitChange(c, {
        tenantId,
        consumerId: line.consumer_id,
        lineId,
        oldLimit: BigInt(line.approved_limit),
        newLimit: input.newLimit,
        source: 'operator',
        reason: input.reason,
        actorUserId: actor.userId,
      });
      await insertAuditEvent(c, {
        action: 'credit.limit_changed',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'credit_line',
        resourceId: lineId,
        riskLevel: 'high',
        reason: input.reason,
        before: { limit: line.approved_limit },
        after: { limit: input.newLimit.toString() },
      });
      return (await this.lineDtoWithin(c, tenantId, line.consumer_id, currency))!;
    });
  }

  /** Congelar / reactivar / cerrar una línea (operador). */
  async setLineStatus(
    tenantId: string,
    lineId: string,
    input: { status: 'active' | 'frozen' | 'closed'; reason: string },
    actor: Operator
  ): Promise<LineDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const lr = await c.query<LockedLine>(
        `SELECT id, consumer_id, currency, approved_limit::text, multiplier_bps, status, policy_id, risk_tier
           FROM credit_lines WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [lineId, tenantId]
      );
      const line = lr.rows[0];
      if (!line) throw new ResourceNotFoundError('Credit line');
      if (line.status === 'closed') throw new InvalidStateError('credit_line', 'closed');
      if (input.status === 'closed') {
        const exp = await lineExposure(c, lineId);
        if (exp.utilized > 0n || exp.reserved > 0n) {
          throw new InvalidStateError('credit_line', 'has_exposure');
        }
      }
      await c.query(
        `UPDATE credit_lines SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [lineId, input.status]
      );
      await insertAuditEvent(c, {
        action: 'credit.line_status_changed',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'credit_line',
        resourceId: lineId,
        riskLevel: 'high',
        reason: input.reason,
        before: { status: line.status },
        after: { status: input.status },
      });
      return (await this.lineDtoWithin(c, tenantId, line.consumer_id, line.currency.trim()))!;
    });
  }

  async lineDtoWithin(
    c: PoolClient,
    tenantId: string,
    consumerId: string,
    currency: string
  ): Promise<LineDto | null> {
    const res = await c.query<{
      id: string;
      consumer_id: string;
      currency: string;
      status: LineDto['status'];
      approved_limit: string;
      multiplier_bps: number;
      risk_tier: string;
      policy_id: string;
      utilized: string;
      reserved: string;
      available: string;
    }>(
      `SELECT l.id, l.consumer_id, l.currency, l.status, l.approved_limit::text, l.multiplier_bps,
              l.risk_tier, l.policy_id, a.utilized::text, a.reserved::text, a.available::text
         FROM credit_lines l JOIN credit_line_availability a ON a.line_id = l.id
        WHERE l.tenant_id = $1 AND l.consumer_id = $2 AND l.currency = $3`,
      [tenantId, consumerId, currency]
    );
    const r = res.rows[0];
    if (!r) return null;
    const b = await this.posting.consumerBalances(c, tenantId, consumerId, currency);
    const required = requiredCollateral(BigInt(r.utilized) + BigInt(r.reserved), r.multiplier_bps);
    const releasable = b.collateral > required ? b.collateral - required : 0n;
    return {
      id: r.id,
      consumerId: r.consumer_id,
      currency: r.currency.trim(),
      status: r.status,
      approvedLimit: r.approved_limit,
      utilized: r.utilized,
      reserved: r.reserved,
      available: r.status === 'active' ? r.available : '0',
      multiplierBps: r.multiplier_bps,
      riskTier: r.risk_tier,
      policyId: r.policy_id,
      collateral: b.collateral.toString(),
      requiredCollateral: required.toString(),
      releasableCollateral: releasable.toString(),
    };
  }

  async listLines(tenantId: string, consumerId: string, scope: string | null): Promise<LineDto[]> {
    return withProgramTx(this.appPool, tenantId, scope, async (c) => {
      const res = await c.query<{ currency: string }>(
        `SELECT currency FROM credit_lines WHERE tenant_id = $1 AND consumer_id = $2 ORDER BY currency`,
        [tenantId, consumerId]
      );
      const out: LineDto[] = [];
      for (const r of res.rows) {
        const dto = await this.lineDtoWithin(c, tenantId, consumerId, r.currency.trim());
        if (dto) out.push(dto);
      }
      return out;
    });
  }

  async getLine(tenantId: string, lineId: string): Promise<LineDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{ consumer_id: string; currency: string }>(
        `SELECT consumer_id, currency FROM credit_lines WHERE id = $1 AND tenant_id = $2`,
        [lineId, tenantId]
      );
      if (!res.rows[0]) throw new ResourceNotFoundError('Credit line');
      return (await this.lineDtoWithin(
        c,
        tenantId,
        res.rows[0].consumer_id,
        res.rows[0].currency.trim()
      ))!;
    });
  }

  async listApplications(
    tenantId: string,
    filter: { consumerId?: string; status?: string },
    scope: string | null
  ): Promise<ApplicationDto[]> {
    return withProgramTx(this.appPool, tenantId, scope, async (c) => {
      const res = await c.query<ApplicationRow>(
        `SELECT * FROM credit_applications
          WHERE tenant_id = $1 AND ($2::uuid IS NULL OR consumer_id = $2)
            AND ($3::text IS NULL OR status = $3)
          ORDER BY created_at DESC LIMIT 200`,
        [tenantId, filter.consumerId ?? null, filter.status ?? null]
      );
      return res.rows.map(applicationDto);
    });
  }

  async limitHistory(
    tenantId: string,
    lineId: string
  ): Promise<
    {
      oldLimit: string | null;
      newLimit: string;
      source: string;
      reason: string;
      actorUserId: string | null;
      createdAt: string;
    }[]
  > {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{
        old_limit: string | null;
        new_limit: string;
        source: string;
        reason: string;
        actor_user_id: string | null;
        created_at: Date;
      }>(
        `SELECT old_limit::text, new_limit::text, source, reason, actor_user_id, created_at
           FROM credit_limit_changes WHERE line_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
        [lineId, tenantId]
      );
      return res.rows.map((r) => ({
        oldLimit: r.old_limit,
        newLimit: r.new_limit,
        source: r.source,
        reason: r.reason,
        actorUserId: r.actor_user_id,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  // -------------------------------------------------------------------------
  // Planes
  // -------------------------------------------------------------------------

  /**
   * Crea el plan de una captura con crédito DENTRO de la tx de la captura.
   * Calendario exacto: Money.allocate ⇒ Σ cuotas = principal.
   */
  async createPlanWithin(
    c: PoolClient,
    input: {
      tenantId: string;
      consumerId: string;
      lineId: string;
      authorizationId: string;
      captureEventId: string;
      currency: string;
      principal: bigint;
      downPayment: bigint;
      installmentsCount: number;
      intervalDays: number;
      interestBps: number;
      policyId: string;
      terms: Record<string, unknown>;
      merchantName: string;
      startDate: Date;
    }
  ): Promise<string> {
    const res = await c.query<{ id: string }>(
      `INSERT INTO credit_plans
         (tenant_id, consumer_id, line_id, authorization_id, capture_event_id, currency, principal,
          down_payment, installments_count, interval_days, interest_bps, policy_id, terms, merchant_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [
        input.tenantId,
        input.consumerId,
        input.lineId,
        input.authorizationId,
        input.captureEventId,
        input.currency,
        input.principal.toString(),
        input.downPayment.toString(),
        input.installmentsCount,
        input.intervalDays,
        input.interestBps,
        input.policyId,
        JSON.stringify(input.terms),
        input.merchantName,
      ]
    );
    const planId = res.rows[0]!.id;
    const shares = Money.of(input.principal, input.currency).allocate(
      Array.from({ length: input.installmentsCount }, () => 1)
    );
    for (let i = 0; i < shares.length; i++) {
      const due = new Date(input.startDate.getTime() + (i + 1) * input.intervalDays * 86_400_000);
      await c.query(
        `INSERT INTO credit_installments (tenant_id, consumer_id, plan_id, seq, amount, due_date)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.tenantId,
          input.consumerId,
          planId,
          i + 1,
          shares[i]!.amount.toString(),
          due.toISOString().slice(0, 10),
        ]
      );
    }
    return planId;
  }

  /**
   * Reduce la deuda de los planes de una autorización por una devolución
   * atribuida al crédito. Devuelve cuánto se redujo de deuda; el resto (lo
   * que el cliente ya había pagado) vuelve como dinero propio. Cancela desde
   * la ÚLTIMA cuota hacia atrás.
   */
  async reducePlansForRefundWithin(
    c: PoolClient,
    authorizationId: string,
    creditRefund: bigint
  ): Promise<bigint> {
    let remaining = creditRefund;
    let reduced = 0n;
    const inst = await c.query<InstallmentRow & { plan_status: string }>(
      `SELECT i.*, p.status AS plan_status FROM credit_installments i
         JOIN credit_plans p ON p.id = i.plan_id
        WHERE p.authorization_id = $1 AND p.status = 'active'
        ORDER BY p.created_at DESC, i.seq DESC
        FOR UPDATE OF i`,
      [authorizationId]
    );
    for (const i of inst.rows) {
      if (remaining <= 0n) break;
      const open = toBig(i.amount) - toBig(i.paid_amount) - toBig(i.cancelled_amount);
      if (open <= 0n) continue;
      const cut = open < remaining ? open : remaining;
      const cancelled = toBig(i.cancelled_amount) + cut;
      const fullyClosed = toBig(i.paid_amount) + cancelled === toBig(i.amount);
      const status = fullyClosed
        ? toBig(i.paid_amount) === 0n
          ? 'cancelled'
          : 'paid'
        : i.status === 'overdue'
          ? 'overdue'
          : toBig(i.paid_amount) > 0n
            ? 'partially_paid'
            : 'scheduled';
      await c.query(
        `UPDATE credit_installments SET cancelled_amount = $2, status = $3, updated_at = now() WHERE id = $1`,
        [i.id, cancelled.toString(), status]
      );
      remaining -= cut;
      reduced += cut;
    }
    await this.closePlansWithin(c, authorizationId);
    return reduced;
  }

  private async closePlansWithin(
    c: PoolClient,
    authorizationId: string | null,
    planIds?: string[]
  ): Promise<void> {
    await c.query(
      `UPDATE credit_plans p
          SET status = CASE WHEN EXISTS (SELECT 1 FROM credit_installments i WHERE i.plan_id = p.id AND i.paid_amount > 0)
                            THEN 'paid' ELSE 'cancelled' END,
              closed_at = now()
        WHERE p.status = 'active'
          AND ($1::uuid IS NULL OR p.authorization_id = $1)
          AND ($2::uuid[] IS NULL OR p.id = ANY($2))
          AND NOT EXISTS (SELECT 1 FROM credit_installments i
                           WHERE i.plan_id = p.id AND i.amount - i.paid_amount - i.cancelled_amount > 0)`,
      [authorizationId, planIds ?? null]
    );
  }

  /**
   * Distribuye un pago ya ASENTADO entre cuotas pendientes: vencidas
   * primero, luego por fecha. Registra el pago con su reparto.
   */
  async allocateRepaymentWithin(
    c: PoolClient,
    input: {
      tenantId: string;
      consumerId: string;
      line: LockedLine;
      amount: bigint;
      source: 'wallet' | 'collateral';
      ledgerTxId: string;
      clientKey: string;
      planId: string | null;
      overdueOnly?: boolean;
    }
  ): Promise<{ repaymentId: string; allocation: { installmentId: string; amount: string }[] }> {
    const inst = await c.query<InstallmentRow>(
      `SELECT i.* FROM credit_installments i JOIN credit_plans p ON p.id = i.plan_id
        WHERE p.line_id = $1 AND p.status = 'active'
          AND i.status IN ('scheduled', 'partially_paid', 'overdue')
          AND ($2::uuid IS NULL OR p.id = $2)
          AND ($3::boolean = false OR i.status = 'overdue')
        ORDER BY (i.status = 'overdue') DESC, i.due_date, p.created_at, i.seq
        FOR UPDATE OF i`,
      [input.line.id, input.planId, input.overdueOnly ?? false]
    );
    let remaining = input.amount;
    const allocation: { installmentId: string; amount: string }[] = [];
    const touchedPlans = new Set<string>();
    for (const i of inst.rows) {
      if (remaining <= 0n) break;
      const open = toBig(i.amount) - toBig(i.paid_amount) - toBig(i.cancelled_amount);
      if (open <= 0n) continue;
      const pay = open < remaining ? open : remaining;
      const paid = toBig(i.paid_amount) + pay;
      const closed = paid + toBig(i.cancelled_amount) === toBig(i.amount);
      const status = closed ? 'paid' : i.status === 'overdue' ? 'overdue' : 'partially_paid';
      await c.query(
        `UPDATE credit_installments SET paid_amount = $2, status = $3, updated_at = now() WHERE id = $1`,
        [i.id, paid.toString(), status]
      );
      allocation.push({ installmentId: i.id, amount: pay.toString() });
      touchedPlans.add(i.plan_id);
      remaining -= pay;
    }
    if (remaining > 0n) throw new AmountExceedsError('outstanding installments');
    const res = await c.query<{ id: string }>(
      `INSERT INTO credit_repayments
         (tenant_id, consumer_id, line_id, plan_id, currency, amount, source, ledger_tx_id, allocation, client_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        input.tenantId,
        input.consumerId,
        input.line.id,
        input.planId,
        input.line.currency.trim(),
        input.amount.toString(),
        input.source,
        input.ledgerTxId,
        JSON.stringify(allocation),
        input.clientKey,
      ]
    );
    await this.closePlansWithin(c, null, [...touchedPlans]);
    return { repaymentId: res.rows[0]!.id, allocation };
  }

  /** Pago de cuotas con saldo propio (idempotente por clave del cliente). */
  async repay(
    tenantId: string,
    consumerId: string,
    input: { currency: string; amount: bigint; planId?: string; clientKey: string },
    actor: ProgramActor
  ): Promise<{
    repaymentId: string;
    allocation: { installmentId: string; amount: string }[];
    replayed: boolean;
  }> {
    assertAmount(input.amount);
    return withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      const prior = await c.query<{
        id: string;
        amount: string;
        currency: string;
        allocation: { installmentId: string; amount: string }[];
      }>(
        `SELECT id, amount::text, currency, allocation FROM credit_repayments
          WHERE tenant_id = $1 AND consumer_id = $2 AND client_key = $3`,
        [tenantId, consumerId, input.clientKey]
      );
      if (prior.rows[0]) {
        const p = prior.rows[0];
        if (p.amount !== input.amount.toString() || p.currency.trim() !== input.currency) {
          throw new IdempotencyMismatchError();
        }
        return { repaymentId: p.id, allocation: p.allocation, replayed: true };
      }
      const line = await lockLine(c, tenantId, consumerId, input.currency);
      if (!line) throw new ResourceNotFoundError('Credit line');
      if (input.planId) {
        const plan = await c.query(
          `SELECT 1 FROM credit_plans WHERE id = $1 AND consumer_id = $2`,
          [input.planId, consumerId]
        );
        if (!plan.rowCount) throw new ResourceNotFoundError('Plan');
      }
      const id = randomUUID();
      const posted = await this.posting
        .post(c, 'repayment', {
          tenantId,
          consumerId,
          amount: Money.of(input.amount, input.currency),
          idempotencyKey: `repayment:${id}`,
          source: { type: 'credit_repayment', id },
        })
        .catch(mapLedgerFunds);
      const out = await this.allocateRepaymentWithin(c, {
        tenantId,
        consumerId,
        line,
        amount: input.amount,
        source: 'wallet',
        ledgerTxId: posted.transactionId,
        clientKey: input.clientKey,
        planId: input.planId ?? null,
      });
      await insertAuditEvent(c, {
        action: 'credit.repayment_applied',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'credit_repayment',
        resourceId: out.repaymentId,
        after: { amount: input.amount.toString(), currency: input.currency },
      });
      return { ...out, replayed: false };
    });
  }

  /**
   * Marca vencidas las cuotas cuya fecha + días de gracia es anterior al
   * corte. Explícito (no por el paso del tiempo en una lectura). Abre un caso
   * de deuda vencida por cliente. Sin recargos en la política de referencia.
   */
  async markOverdue(tenantId: string, asOf: Date): Promise<{ marked: number }> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const policy = await loadActivePolicy(c, tenantId);
      const cutoff = new Date(asOf.getTime() - policy.params.graceDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const res = await c.query<{ id: string; consumer_id: string; plan_id: string }>(
        `UPDATE credit_installments SET status = 'overdue', updated_at = now()
          WHERE tenant_id = $1 AND status IN ('scheduled', 'partially_paid') AND due_date < $2
          RETURNING id, consumer_id, plan_id`,
        [tenantId, cutoff]
      );
      const consumers = new Set(res.rows.map((r) => r.consumer_id));
      for (const consumerId of consumers) {
        await openCase(c, {
          tenantId,
          consumerId,
          caseType: 'overdue_debt',
          severity: 'medium',
          subjectType: 'consumer',
          subjectId: consumerId,
          summary: 'Cuotas vencidas tras el periodo de gracia.',
          evidence: {
            cutoff,
            installments: res.rows.filter((r) => r.consumer_id === consumerId).map((r) => r.id),
          },
        });
      }
      if (res.rows.length > 0) {
        await insertAuditEvent(c, {
          action: 'credit.overdue_marked',
          tenantId,
          context: { actorType: 'system', authMethod: 'none' },
          resourceType: 'credit_installments',
          resourceId: cutoff,
          after: { count: res.rows.length },
        });
      }
      return { marked: res.rows.length };
    });
  }

  async listPlans(tenantId: string, consumerId: string, scope: string | null): Promise<PlanDto[]> {
    return withProgramTx(this.appPool, tenantId, scope, async (c) =>
      this.plansWithin(c, tenantId, { consumerId })
    );
  }

  async getPlan(tenantId: string, planId: string, scope: string | null): Promise<PlanDto> {
    return withProgramTx(this.appPool, tenantId, scope, async (c) => {
      const plans = await this.plansWithin(c, tenantId, { planId });
      if (!plans[0]) throw new ResourceNotFoundError('Plan');
      return plans[0];
    });
  }

  async plansWithin(
    c: PoolClient,
    tenantId: string,
    filter: { consumerId?: string; planId?: string; authorizationId?: string }
  ): Promise<PlanDto[]> {
    const plans = await c.query<{
      id: string;
      consumer_id: string;
      line_id: string;
      authorization_id: string;
      currency: string;
      principal: string;
      down_payment: string;
      installments_count: number;
      interval_days: number;
      interest_bps: number;
      merchant_name: string;
      status: PlanDto['status'];
      terms: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT * FROM credit_plans
        WHERE tenant_id = $1 AND ($2::uuid IS NULL OR consumer_id = $2)
          AND ($3::uuid IS NULL OR id = $3) AND ($4::uuid IS NULL OR authorization_id = $4)
        ORDER BY created_at DESC LIMIT 100`,
      [tenantId, filter.consumerId ?? null, filter.planId ?? null, filter.authorizationId ?? null]
    );
    if (plans.rows.length === 0) return [];
    const inst = await c.query<InstallmentRow>(
      `SELECT * FROM credit_installments WHERE plan_id = ANY($1::uuid[]) ORDER BY plan_id, seq`,
      [plans.rows.map((p) => p.id)]
    );
    return plans.rows.map((p) => {
      const items = inst.rows.filter((i) => i.plan_id === p.id).map(installmentDto);
      const outstanding = items.reduce((acc, i) => acc + BigInt(i.outstanding), 0n);
      return {
        id: p.id,
        consumerId: p.consumer_id,
        lineId: p.line_id,
        authorizationId: p.authorization_id,
        currency: p.currency.trim(),
        principal: String(p.principal),
        downPayment: String(p.down_payment),
        installmentsCount: p.installments_count,
        intervalDays: p.interval_days,
        interestBps: p.interest_bps,
        merchantName: p.merchant_name,
        status: p.status,
        outstanding: outstanding.toString(),
        terms: p.terms,
        createdAt: p.created_at.toISOString(),
        installments: items,
      };
    });
  }

  /** Próximos pagos del cliente (cuotas abiertas por fecha). */
  async upcoming(
    tenantId: string,
    consumerId: string,
    scope: string | null
  ): Promise<(InstallmentDto & { currency: string; merchantName: string })[]> {
    return withProgramTx(this.appPool, tenantId, scope, async (c) => {
      const res = await c.query<InstallmentRow & { currency: string; merchant_name: string }>(
        `SELECT i.*, p.currency, p.merchant_name FROM credit_installments i
           JOIN credit_plans p ON p.id = i.plan_id
          WHERE i.tenant_id = $1 AND i.consumer_id = $2
            AND i.status IN ('scheduled', 'partially_paid', 'overdue')
          ORDER BY i.due_date, i.seq LIMIT 50`,
        [tenantId, consumerId]
      );
      return res.rows.map((r) => ({
        ...installmentDto(r),
        currency: r.currency.trim(),
        merchantName: r.merchant_name,
      }));
    });
  }
}
