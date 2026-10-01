import type { Pool } from '@fluvia/db';
import { insertAuditEvent } from '@fluvia/audit';
import { auditContextOf, withProgramTx, type ProgramActor } from './context.js';
import { InvalidStateError, ResourceNotFoundError } from './errors.js';

type Operator = Extract<ProgramActor, { kind: 'operator' }>;

export interface ConsumerRowDto {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'suspended' | 'closed';
  syntheticRiskProfile: string;
  createdAt: string;
  openCases: number;
  overdueInstallments: number;
}

export interface ProgramOverview {
  consumers: { total: number; active: number; suspended: number };
  queues: {
    manualReviews: number;
    openCases: number;
    uncertain: number;
    unmatchedEvents: number;
    pendingApprovals: number;
  };
  cards: { active: number; blocked: number; inTransit: number };
  byCurrency: {
    currency: string;
    walletAvailable: string;
    walletHeld: string;
    collateral: string;
    debt: string;
    approvedLimits: string;
    reserved: string;
    networkPayable: string;
    overdue: string;
  }[];
  authorizationsLast24h: { approved: number; declined: number };
}

/**
 * Lecturas e investigaciones de Fluvia Operaciones (vista 360 de clientes,
 * indicadores del programa) y acciones de estado sobre clientes. Plano de
 * operación: sin `app.consumer_id` (ve todo el programa), RLS por tenant.
 */
export class OperationsService {
  constructor(private readonly appPool: Pool) {}

  async overview(tenantId: string): Promise<ProgramOverview> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const cons = await c.query<{ total: string; active: string; suspended: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status = 'active')::text AS active,
                COUNT(*) FILTER (WHERE status = 'suspended')::text AS suspended
           FROM consumers WHERE tenant_id = $1`,
        [tenantId]
      );
      const q = await c.query<Record<string, string>>(
        `SELECT
           (SELECT COUNT(*) FROM credit_applications WHERE tenant_id = $1 AND status = 'manual_review')::text AS reviews,
           (SELECT COUNT(*) FROM program_cases WHERE tenant_id = $1 AND status <> 'resolved')::text AS cases,
           (SELECT COUNT(*) FROM program_cases WHERE tenant_id = $1 AND status <> 'resolved'
              AND case_type LIKE 'uncertain_%')::text AS uncertain,
           (SELECT COUNT(*) FROM program_provider_events WHERE tenant_id = $1 AND status IN ('unmatched', 'failed'))::text AS unmatched,
           (SELECT COUNT(*) FROM program_approvals WHERE tenant_id = $1 AND status = 'proposed')::text AS approvals,
           (SELECT COUNT(*) FROM cards WHERE tenant_id = $1 AND status = 'active')::text AS cards_active,
           (SELECT COUNT(*) FROM cards WHERE tenant_id = $1 AND status = 'blocked')::text AS cards_blocked,
           (SELECT COUNT(*) FROM card_shipments WHERE tenant_id = $1 AND status IN ('requested', 'produced', 'shipped'))::text AS in_transit,
           (SELECT COUNT(*) FROM card_authorizations WHERE tenant_id = $1 AND status <> 'declined'
              AND created_at > now() - interval '24 hours')::text AS auth_ok,
           (SELECT COUNT(*) FROM card_authorizations WHERE tenant_id = $1 AND status = 'declined'
              AND created_at > now() - interval '24 hours')::text AS auth_ko`,
        [tenantId]
      );
      const money = await c.query<{
        currency: string;
        wallet_available: string;
        wallet_held: string;
        collateral: string;
        debt: string;
        network_payable: string;
      }>(
        `SELECT a.currency,
                COALESCE(SUM(p.available) FILTER (WHERE a.name LIKE 'consumer.wallet.available:%'), 0)::text AS wallet_available,
                COALESCE(SUM(p.available) FILTER (WHERE a.name LIKE 'consumer.wallet.held:%'), 0)::text AS wallet_held,
                COALESCE(SUM(p.available) FILTER (WHERE a.name LIKE 'consumer.collateral:%'), 0)::text AS collateral,
                COALESCE(SUM(p.available) FILTER (WHERE a.name LIKE 'consumer.credit.receivable:%'), 0)::text AS debt,
                COALESCE(SUM(p.available) FILTER (WHERE a.name = 'program.network.payable'), 0)::text AS network_payable
           FROM ledger_accounts a JOIN balance_projections p ON p.account_id = a.id
          WHERE a.tenant_id = $1
          GROUP BY a.currency ORDER BY a.currency`,
        [tenantId]
      );
      const lines = await c.query<{ currency: string; limits: string; reserved: string }>(
        `SELECT currency, SUM(approved_limit)::text AS limits, SUM(reserved)::text AS reserved
           FROM credit_line_availability WHERE tenant_id = $1 AND status <> 'closed' GROUP BY currency`,
        [tenantId]
      );
      const overdue = await c.query<{ currency: string; total: string }>(
        `SELECT p.currency, SUM(i.amount - i.paid_amount - i.cancelled_amount)::text AS total
           FROM credit_installments i JOIN credit_plans p ON p.id = i.plan_id
          WHERE i.tenant_id = $1 AND i.status = 'overdue' GROUP BY p.currency`,
        [tenantId]
      );
      const r = q.rows[0]!;
      return {
        consumers: {
          total: Number(cons.rows[0]!.total),
          active: Number(cons.rows[0]!.active),
          suspended: Number(cons.rows[0]!.suspended),
        },
        queues: {
          manualReviews: Number(r.reviews),
          openCases: Number(r.cases),
          uncertain: Number(r.uncertain),
          unmatchedEvents: Number(r.unmatched),
          pendingApprovals: Number(r.approvals),
        },
        cards: {
          active: Number(r.cards_active),
          blocked: Number(r.cards_blocked),
          inTransit: Number(r.in_transit),
        },
        byCurrency: money.rows.map((m) => {
          const ccy = m.currency.trim();
          const l = lines.rows.find((x) => x.currency.trim() === ccy);
          const o = overdue.rows.find((x) => x.currency.trim() === ccy);
          return {
            currency: ccy,
            walletAvailable: m.wallet_available,
            walletHeld: m.wallet_held,
            collateral: m.collateral,
            debt: m.debt,
            approvedLimits: l?.limits ?? '0',
            reserved: l?.reserved ?? '0',
            networkPayable: m.network_payable,
            overdue: o?.total ?? '0',
          };
        }),
        authorizationsLast24h: { approved: Number(r.auth_ok), declined: Number(r.auth_ko) },
      };
    });
  }

  async listConsumers(tenantId: string, q?: string): Promise<ConsumerRowDto[]> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{
        id: string;
        email: string;
        display_name: string;
        status: ConsumerRowDto['status'];
        synthetic_risk_profile: string;
        created_at: Date;
        open_cases: string;
        overdue: string;
      }>(
        `SELECT k.id, k.email, k.display_name, k.status, k.synthetic_risk_profile, k.created_at,
                (SELECT COUNT(*) FROM program_cases pc WHERE pc.consumer_id = k.id AND pc.status <> 'resolved')::text AS open_cases,
                (SELECT COUNT(*) FROM credit_installments i WHERE i.consumer_id = k.id AND i.status = 'overdue')::text AS overdue
           FROM consumers k
          WHERE k.tenant_id = $1
            AND ($2::text IS NULL OR k.email ILIKE '%' || $2 || '%' OR k.display_name ILIKE '%' || $2 || '%'
                 OR k.id::text = $2)
          ORDER BY k.created_at DESC LIMIT 100`,
        [tenantId, q?.trim() || null]
      );
      return res.rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        status: r.status,
        syntheticRiskProfile: r.synthetic_risk_profile,
        createdAt: r.created_at.toISOString(),
        openCases: Number(r.open_cases),
        overdueInstallments: Number(r.overdue),
      }));
    });
  }

  async getConsumer(tenantId: string, consumerId: string): Promise<ConsumerRowDto> {
    const rows = await this.listConsumers(tenantId, consumerId);
    const row = rows.find((r) => r.id === consumerId);
    if (!row) throw new ResourceNotFoundError('Consumer');
    return row;
  }

  /** Suspender / reactivar un cliente (operador, con motivo, auditado). */
  async setConsumerStatus(
    tenantId: string,
    consumerId: string,
    input: { status: 'active' | 'suspended'; reason: string },
    actor: Operator
  ): Promise<ConsumerRowDto> {
    await withProgramTx(this.appPool, tenantId, null, async (c) => {
      const cur = await c.query<{ status: string }>(
        `SELECT status FROM consumers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [consumerId, tenantId]
      );
      if (!cur.rows[0]) throw new ResourceNotFoundError('Consumer');
      if (cur.rows[0].status === 'closed') throw new InvalidStateError('consumer', 'closed');
      await c.query(`UPDATE consumers SET status = $2, updated_at = now() WHERE id = $1`, [
        consumerId,
        input.status,
      ]);
      await insertAuditEvent(c, {
        action: 'consumer.status_changed',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'consumer',
        resourceId: consumerId,
        riskLevel: 'high',
        reason: input.reason,
        before: { status: cur.rows[0].status },
        after: { status: input.status },
      });
    });
    return this.getConsumer(tenantId, consumerId);
  }

  /** Rastro de auditoría de un cliente (actor o recurso). */
  async consumerAudit(
    tenantId: string,
    consumerId: string
  ): Promise<
    {
      id: string;
      action: string;
      actorType: string;
      actorId: string | null;
      resourceType: string | null;
      resourceId: string | null;
      result: string;
      reason: string | null;
      createdAt: string;
    }[]
  > {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{
        id: string;
        action: string;
        actor_type: string;
        actor_id: string | null;
        resource_type: string | null;
        resource_id: string | null;
        result: string;
        reason: string | null;
        created_at: Date;
      }>(
        `SELECT id::text, action, actor_type, actor_id, resource_type, resource_id, result, reason, created_at
           FROM audit_events
          WHERE tenant_id = $1
            AND (actor_id = $2 OR resource_id = $2::text
                 OR resource_id IN (SELECT id::text FROM cards WHERE consumer_id = $2)
                 OR resource_id IN (SELECT id::text FROM card_authorizations WHERE consumer_id = $2)
                 OR resource_id IN (SELECT id::text FROM credit_lines WHERE consumer_id = $2))
          ORDER BY id DESC LIMIT 100`,
        [tenantId, consumerId]
      );
      return res.rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorType: r.actor_type,
        actorId: r.actor_id,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        result: r.result,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  /** Propuesta de aplicar garantía a deuda vencida (primera persona). */
  async proposeCollateralApplication(
    tenantId: string,
    consumerId: string,
    input: { currency: string; amount: bigint; reason: string },
    actor: Operator
  ): Promise<{ approvalId: string }> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const exists = await c.query(`SELECT 1 FROM consumers WHERE id = $1 AND tenant_id = $2`, [
        consumerId,
        tenantId,
      ]);
      if (!exists.rowCount) throw new ResourceNotFoundError('Consumer');
      const res = await c.query<{ id: string }>(
        `INSERT INTO program_approvals (tenant_id, action, subject_id, payload, reason, proposed_by_user_id)
         VALUES ($1, 'collateral.apply', $2, $3, $4, $5)
         ON CONFLICT (tenant_id, action, subject_id) WHERE status = 'proposed' DO NOTHING
         RETURNING id`,
        [
          tenantId,
          consumerId,
          JSON.stringify({ currency: input.currency, amount: input.amount.toString() }),
          input.reason,
          actor.userId,
        ]
      );
      if (!res.rows[0]) throw new InvalidStateError('approval', 'already_proposed');
      await insertAuditEvent(c, {
        action: 'program.approval_proposed',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'program_approval',
        resourceId: res.rows[0].id,
        riskLevel: 'high',
        reason: input.reason,
        after: {
          action: 'collateral.apply',
          amount: input.amount.toString(),
          currency: input.currency,
        },
      });
      return { approvalId: res.rows[0].id };
    });
  }
}
