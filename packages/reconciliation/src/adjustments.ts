import { insertAuditEvent, type AuditContext } from '@fluvia/audit';
import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import type { PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';

/**
 * Ajuste monetario de un caso con four-eyes (F4-03b). Cierra el §30: "todo
 * ajuste pasa por asiento con caso, razón, actor y aprobación". Un ajuste lo
 * PROPONE un humano y, sobre umbral, lo APRUEBA un segundo humano DISTINTO; al
 * aprobarse se postea un asiento compensatorio real (recon.differences ↔
 * suspense) enlazado al caso, y el caso queda `resolved` — todo en UNA
 * transacción (onPosted del ledger).
 *
 * Invariante Nivel A: ni la IA ni un solo humano autorizan dinero real sobre
 * umbral. Toda acción exige actor humano (actorType 'user'); el four-eyes,
 * además del guard aquí, es un CHECK en la BD (0030).
 */

export const ADJUSTMENT_DIRECTIONS = ['debit_differences', 'credit_differences'] as const;
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

export const ADJUSTMENT_STATUSES = ['proposed', 'applied', 'rejected'] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];

/** Autorizar dinero es un acto humano: un actor máquina (api_key) no puede. */
export class HumanActorRequiredError extends Error {
  constructor() {
    super('Monetary case adjustments require a human actor (Level A)');
    this.name = 'HumanActorRequiredError';
  }
}

/** Four-eyes: sobre umbral, el aprobador no puede ser el proponente. */
export class SelfApprovalError extends Error {
  constructor() {
    super('Four-eyes: an over-threshold adjustment cannot be approved by its proposer');
    this.name = 'SelfApprovalError';
  }
}

export class CaseAdjustmentNotFoundError extends Error {
  constructor() {
    super('Case adjustment not found');
    this.name = 'CaseAdjustmentNotFoundError';
  }
}

/** El ajuste no admite esa transición desde su estado actual. */
export class InvalidAdjustmentTransitionError extends Error {
  constructor(from: string, action: string) {
    super(`Case adjustment in status '${from}' cannot ${action}`);
    this.name = 'InvalidAdjustmentTransitionError';
  }
}

/** El caso ya tiene un ajuste vivo (proposed/applied). */
export class CaseAdjustmentExistsError extends Error {
  constructor() {
    super('The case already has an active adjustment');
    this.name = 'CaseAdjustmentExistsError';
  }
}

export interface ProposeAdjustmentInput {
  amount: bigint;
  currency: string;
  direction: AdjustmentDirection;
  reason: string;
}

export interface CaseAdjustmentDto {
  id: string;
  caseId: string;
  amount: string;
  currency: string;
  direction: AdjustmentDirection;
  reason: string;
  status: AdjustmentStatus;
  requiresSecondApproval: boolean;
  proposedByUserId: string;
  approvedByUserId: string | null;
  rejectedByUserId: string | null;
  rejectionReason: string | null;
  ledgerTransactionId: string | null;
  version: number;
  createdAt: string;
  decidedAt: string | null;
}

interface AdjustmentRow {
  id: string;
  case_id: string;
  amount: string;
  currency: string;
  direction: AdjustmentDirection;
  reason: string;
  status: AdjustmentStatus;
  requires_second_approval: boolean;
  proposed_by_user_id: string;
  approved_by_user_id: string | null;
  rejected_by_user_id: string | null;
  rejection_reason: string | null;
  ledger_transaction_id: string | null;
  version: string;
  created_at: Date;
  decided_at: Date | null;
}

const COLS = `id, case_id, amount::text, currency, direction, reason, status,
  requires_second_approval, proposed_by_user_id, approved_by_user_id,
  rejected_by_user_id, rejection_reason, ledger_transaction_id, version, created_at, decided_at`;

function toDto(r: AdjustmentRow): CaseAdjustmentDto {
  return {
    id: r.id,
    caseId: r.case_id,
    amount: r.amount,
    currency: r.currency.trim(),
    direction: r.direction,
    reason: r.reason,
    status: r.status,
    requiresSecondApproval: r.requires_second_approval,
    proposedByUserId: r.proposed_by_user_id,
    approvedByUserId: r.approved_by_user_id,
    rejectedByUserId: r.rejected_by_user_id,
    rejectionReason: r.rejection_reason,
    ledgerTransactionId: r.ledger_transaction_id,
    version: Number(r.version),
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
  };
}

/** Autorizar dinero es humano: exige actorType 'user' con id. */
function requireHumanActor(context: AuditContext): string {
  if (context.actorType !== 'user' || !context.actorId) throw new HumanActorRequiredError();
  return context.actorId;
}

export class CaseAdjustmentService {
  private readonly threshold: bigint;

  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    private readonly posting: PostingService,
    options: { fourEyesThresholdMinor: bigint }
  ) {
    this.threshold = options.fourEyesThresholdMinor;
  }

  /** Propone un ajuste sobre un caso NO resuelto. Acto humano; razón obligatoria. */
  async propose(
    tenantId: string,
    caseId: string,
    input: ProposeAdjustmentInput,
    context: AuditContext
  ): Promise<CaseAdjustmentDto> {
    const userId = requireHumanActor(context);
    if (input.amount <= 0n) throw new InvalidAdjustmentTransitionError('n/a', 'have amount <= 0');
    const note = input.reason.trim();
    // Umbral: >= exige segunda aprobación (four-eyes). Default seguro = 0 => siempre.
    const requiresSecond = input.amount >= this.threshold;
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const kase = await c.query<{ status: string }>(
        `SELECT status FROM operational_cases WHERE id = $1 FOR UPDATE`,
        [caseId]
      );
      if (!kase.rows[0]) throw new CaseAdjustmentNotFoundError();
      if (kase.rows[0].status === 'resolved') {
        throw new InvalidAdjustmentTransitionError('resolved', 'receive a new adjustment');
      }
      let inserted;
      try {
        inserted = await c.query<AdjustmentRow>(
          `INSERT INTO case_adjustments
             (tenant_id, case_id, amount, currency, direction, reason,
              requires_second_approval, proposed_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${COLS}`,
          [
            tenantId,
            caseId,
            input.amount.toString(),
            input.currency,
            input.direction,
            note,
            requiresSecond,
            userId,
          ]
        );
      } catch (err) {
        // Índice parcial único: a lo sumo un ajuste vivo por caso.
        if ((err as { code?: string }).code === '23505') throw new CaseAdjustmentExistsError();
        throw err;
      }
      const dto = toDto(inserted.rows[0]!);
      await insertAuditEvent(c, {
        action: 'operational_case.adjustment_proposed',
        tenantId,
        context,
        resourceType: 'case_adjustment',
        resourceId: dto.id,
        riskLevel: 'high',
        reason: note,
        after: {
          caseId,
          amount: dto.amount,
          currency: dto.currency,
          requiresSecondApproval: requiresSecond,
        },
      });
      return dto;
    });
  }

  /**
   * Aprueba un ajuste `proposed`: valida four-eyes, postea el asiento
   * compensatorio y resuelve el caso — TODO atómico (onPosted del ledger). El
   * asiento es idempotente por `case_adj:{id}`: una doble aprobación no duplica.
   */
  async approve(
    tenantId: string,
    adjustmentId: string,
    context: AuditContext
  ): Promise<CaseAdjustmentDto> {
    const approverId = requireHumanActor(context);
    // Pre-carga (fuera de la tx del asiento) para validar la política antes de
    // postear; el guard de carrera vive en onPosted (FOR UPDATE + re-check).
    const pre = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<AdjustmentRow>(`SELECT ${COLS} FROM case_adjustments WHERE id = $1`, [adjustmentId])
    );
    const row = pre.rows[0];
    if (!row) throw new CaseAdjustmentNotFoundError();
    if (row.status !== 'proposed') {
      throw new InvalidAdjustmentTransitionError(row.status, 'be approved');
    }
    if (row.requires_second_approval && approverId === row.proposed_by_user_id) {
      throw new SelfApprovalError();
    }

    await this.posting.postReconAdjustment({
      tenantId,
      amount: Money.of(BigInt(row.amount), row.currency.trim()),
      idempotencyKey: `case_adj:${adjustmentId}`,
      sourceType: 'case_adjustment',
      sourceId: adjustmentId,
      reason: row.reason,
      debitDifferences: row.direction === 'debit_differences',
      onPosted: async (client, posted) => {
        // Guard de carrera: el ajuste debe seguir `proposed`.
        const locked = await client.query<{ status: string }>(
          `SELECT status FROM case_adjustments WHERE id = $1 FOR UPDATE`,
          [adjustmentId]
        );
        if (!locked.rows[0] || locked.rows[0].status !== 'proposed') {
          throw new InvalidAdjustmentTransitionError(
            locked.rows[0]?.status ?? 'gone',
            'be approved'
          );
        }
        await client.query(
          `UPDATE case_adjustments
           SET status = 'applied', approved_by_user_id = $2,
               ledger_transaction_id = $3, decided_at = now(), version = version + 1
           WHERE id = $1`,
          [adjustmentId, approverId, posted.transactionId]
        );
        // El caso queda resuelto por el ajuste (referencia al asiento).
        await client.query(
          `UPDATE operational_cases
           SET status = 'resolved', resolved_at = now(),
               resolution = $2, resolved_by_user_id = $3, version = version + 1
           WHERE id = $1 AND status <> 'resolved'`,
          [
            row.case_id,
            `resolved by adjustment ${adjustmentId} (ledger tx ${posted.transactionId})`,
            approverId,
          ]
        );
        await insertAuditEvent(client, {
          action: 'operational_case.adjustment_applied',
          tenantId,
          context,
          resourceType: 'case_adjustment',
          resourceId: adjustmentId,
          riskLevel: 'high',
          reason: row.reason,
          after: { ledgerTransactionId: posted.transactionId, caseId: row.case_id },
        });
      },
    });

    return this.get(tenantId, adjustmentId);
  }

  /** Rechaza un ajuste `proposed` (acto humano); razón obligatoria. */
  async reject(
    tenantId: string,
    adjustmentId: string,
    reason: string,
    context: AuditContext
  ): Promise<CaseAdjustmentDto> {
    const userId = requireHumanActor(context);
    const note = reason.trim();
    if (!note)
      throw new InvalidAdjustmentTransitionError('proposed', 'be rejected without a reason');
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const cur = await this.loadForUpdate(c, adjustmentId);
      if (cur.status !== 'proposed') {
        throw new InvalidAdjustmentTransitionError(cur.status, 'be rejected');
      }
      const res = await c.query<AdjustmentRow>(
        `UPDATE case_adjustments
         SET status = 'rejected', rejected_by_user_id = $2, rejection_reason = $3,
             decided_at = now(), version = version + 1
         WHERE id = $1
         RETURNING ${COLS}`,
        [adjustmentId, userId, note]
      );
      await insertAuditEvent(c, {
        action: 'operational_case.adjustment_rejected',
        tenantId,
        context,
        resourceType: 'case_adjustment',
        resourceId: adjustmentId,
        riskLevel: 'medium',
        reason: note,
      });
      return toDto(res.rows[0]!);
    });
  }

  async get(tenantId: string, adjustmentId: string): Promise<CaseAdjustmentDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<AdjustmentRow>(
        `SELECT ${COLS} FROM case_adjustments WHERE id = $1`,
        [adjustmentId]
      );
      if (!res.rows[0]) throw new CaseAdjustmentNotFoundError();
      return toDto(res.rows[0]);
    });
  }

  async listForCase(tenantId: string, caseId: string): Promise<CaseAdjustmentDto[]> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<AdjustmentRow>(
        `SELECT ${COLS} FROM case_adjustments WHERE case_id = $1 ORDER BY created_at DESC, id`,
        [caseId]
      );
      return res.rows.map(toDto);
    });
  }

  private async loadForUpdate(c: PoolClient, adjustmentId: string): Promise<AdjustmentRow> {
    const res = await c.query<AdjustmentRow>(
      `SELECT ${COLS} FROM case_adjustments WHERE id = $1 FOR UPDATE`,
      [adjustmentId]
    );
    if (!res.rows[0]) throw new CaseAdjustmentNotFoundError();
    return res.rows[0];
  }
}
