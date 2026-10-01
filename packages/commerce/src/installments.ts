import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import {
  CheckoutSessionNotFoundError,
  SALE_RELEASING_STATUSES,
  hashClientSecret,
} from '@fluvia/payments-core';
import {
  InstallmentInvalidStateError,
  InstallmentPlanNotAllowedError,
  InstallmentPlanNotFoundError,
  InstallmentTermsNotAcceptedError,
} from './errors.js';
import {
  INSTALLMENT_DEMO_TERMS,
  buildSchedule,
  isAllowedInstallmentCount,
  utcDate,
} from './installments-calc.js';
import type { OrderDetailDto, OrderService } from './orders.js';

/**
 * «Pagar en cuotas» — motor SANDBOX con proveedor SIMULADO (0050).
 *
 * Qué es: una simulación de la EXPERIENCIA (elegir cuotas, ver calendario,
 * confirmar, consultar el plan) y de sus estados (aprobado, rechazado,
 * pendiente, cuota vencida). Qué NO es: financiación, crédito, cobro, ni
 * integración con ningún proveedor BNPL real.
 *
 *  - El «proveedor simulado» decide según el ESCENARIO de prueba elegido en el
 *    checkout (igual que tok_approve/tok_decline en tarjeta).
 *  - Un plan aprobado NO marca el pedido como pagado (el estado de pago sale
 *    solo de payment_intents) ni toca ledger o saldos.
 *  - Las cuotas cambian solo por EVENTOS SIMULADOS explícitos de un operador
 *    del sandbox; nada se cobra ni vence por el paso del tiempo.
 */

export type InstallmentScenario = 'approve' | 'decline' | 'pending';
export const INSTALLMENT_SCENARIOS: readonly InstallmentScenario[] = [
  'approve',
  'decline',
  'pending',
];

export interface InstallmentDto {
  seq: number;
  amount: bigint;
  dueDate: string;
  status: 'scheduled' | 'paid_simulated' | 'overdue_simulated';
  statusChangedAt: string | null;
}

export interface InstallmentEventDto {
  kind: string;
  seq: number | null;
  actor: 'buyer' | 'simulated_provider' | 'operator';
  createdAt: string;
}

export interface InstallmentPlanDto {
  id: string;
  orderId: string;
  orderNumber: number;
  checkoutSessionId: string;
  currency: string;
  total: bigint;
  installmentsCount: number;
  intervalDays: number;
  termsVersion: string;
  scenario: InstallmentScenario;
  status: 'pending' | 'approved' | 'declined';
  buyerConfirmedAt: string;
  decidedAt: string | null;
  createdAt: string;
  installments: InstallmentDto[];
  events: InstallmentEventDto[];
}

export interface InstallmentQuote {
  count: number;
  currency: string;
  total: bigint;
  intervalDays: number;
  termsVersion: string;
  /** Importe inicial = primera cuota (vence al confirmar). */
  initialAmount: bigint;
  schedule: Array<{ seq: number; amount: bigint; dueDate: string }>;
}

/** Vista del comprador (credencial: el client_secret de SU checkout). */
export interface BuyerInstallmentsView {
  order: Pick<OrderDetailDto, 'number' | 'currency' | 'total' | 'lines'> & {
    merchantName: string | null;
    /** El comercio anuló la venta (0051): ya no se puede pagar. */
    cancelled: boolean;
  };
  /** ¿Se puede pedir un plan ahora? (venta sin cobro y sin plan vivo, checkout abierto). */
  eligible: boolean;
  ineligibleReason: 'sale_charged' | 'plan_exists' | 'checkout_closed' | 'order_cancelled' | null;
  allowedCounts: readonly number[];
  plan: InstallmentPlanDto | null;
}

interface PlanRow {
  id: string;
  order_id: string;
  order_number: string;
  checkout_session_id: string;
  currency: string;
  total: string;
  installments_count: number;
  interval_days: number;
  terms_version: string;
  scenario: InstallmentScenario;
  status: 'pending' | 'approved' | 'declined';
  buyer_confirmed_at: Date;
  decided_at: Date | null;
  created_at: Date;
}

const PLAN_SELECT = `
  SELECT p.id, p.order_id, o.number::text AS order_number, p.checkout_session_id, p.currency,
         p.total::text, p.installments_count, p.interval_days, p.terms_version, p.scenario,
         p.status, p.buyer_confirmed_at, p.decided_at, p.created_at
  FROM sandbox_installment_plans p
  JOIN commerce_orders o ON o.id = p.order_id`;

export class InstallmentSandboxService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    private readonly orders: OrderService
  ) {}

  /** Cotización pura (sin persistir): calendario con reparto exacto. */
  quote(total: bigint, currency: string, count: number, now = new Date()): InstallmentQuote {
    if (!isAllowedInstallmentCount(count)) throw new InstallmentInvalidStateError();
    const schedule = buildSchedule(total, count, utcDate(now));
    return {
      count,
      currency,
      total,
      intervalDays: INSTALLMENT_DEMO_TERMS.intervalDays,
      termsVersion: INSTALLMENT_DEMO_TERMS.version,
      initialAmount: schedule[0]!.amount,
      schedule,
    };
  }

  private async authenticate(sessionId: string, clientSecret: string): Promise<string> {
    const auth = await this.appPool.query<{ tenant_id: string | null }>(
      `SELECT checkout_session_authenticate($1, $2) AS tenant_id`,
      [sessionId, hashClientSecret(clientSecret)]
    );
    const tenantId = auth.rows[0]?.tenant_id ?? null;
    if (!tenantId) throw new CheckoutSessionNotFoundError();
    return tenantId;
  }

  private async loadPlan(c: PoolClient, planId: string): Promise<InstallmentPlanDto> {
    const res = await c.query<PlanRow>(`${PLAN_SELECT} WHERE p.id = $1`, [planId]);
    const r = res.rows[0];
    if (!r) throw new InstallmentPlanNotFoundError();
    const inst = await c.query<{
      seq: number;
      amount: string;
      due_date: string;
      status: InstallmentDto['status'];
      status_changed_at: Date | null;
    }>(
      `SELECT seq, amount::text, to_char(due_date, 'YYYY-MM-DD') AS due_date, status,
              status_changed_at
       FROM sandbox_installments WHERE plan_id = $1 ORDER BY seq`,
      [planId]
    );
    const ev = await c.query<{
      kind: string;
      seq: number | null;
      actor: InstallmentEventDto['actor'];
      created_at: Date;
    }>(
      `SELECT kind, seq, actor, created_at FROM sandbox_installment_events
       WHERE plan_id = $1 ORDER BY created_at, id`,
      [planId]
    );
    return {
      id: r.id,
      orderId: r.order_id,
      orderNumber: Number(r.order_number),
      checkoutSessionId: r.checkout_session_id,
      currency: r.currency.trim(),
      total: BigInt(r.total),
      installmentsCount: r.installments_count,
      intervalDays: r.interval_days,
      termsVersion: r.terms_version,
      scenario: r.scenario,
      status: r.status,
      buyerConfirmedAt: r.buyer_confirmed_at.toISOString(),
      decidedAt: r.decided_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      installments: inst.rows.map((i) => ({
        seq: i.seq,
        amount: BigInt(i.amount),
        dueDate: i.due_date,
        status: i.status,
        statusChangedAt: i.status_changed_at?.toISOString() ?? null,
      })),
      events: ev.rows.map((e) => ({
        kind: e.kind,
        seq: e.seq,
        actor: e.actor,
        createdAt: e.created_at.toISOString(),
      })),
    };
  }

  /** Contexto del checkout: sesión → intent → link → pedido. */
  private async sessionContext(
    c: PoolClient,
    sessionId: string,
    lock: boolean
  ): Promise<{
    order: OrderDetailDto | null;
    linkId: string | null;
    sessionOpen: boolean;
  }> {
    // Dos literales (sin interpolar SQL): con lock para confirmar un plan,
    // sin lock para leer.
    const sql = lock
      ? `SELECT i.payment_link_id, (cs.status = 'open' AND cs.expires_at > now()) AS open
         FROM checkout_sessions cs JOIN payment_intents i ON i.id = cs.payment_intent_id
         WHERE cs.id = $1 FOR UPDATE OF cs`
      : `SELECT i.payment_link_id, (cs.status = 'open' AND cs.expires_at > now()) AS open
         FROM checkout_sessions cs JOIN payment_intents i ON i.id = cs.payment_intent_id
         WHERE cs.id = $1`;
    const s = await c.query<{ payment_link_id: string | null; open: boolean }>(sql, [sessionId]);
    const row = s.rows[0];
    if (!row) throw new CheckoutSessionNotFoundError();
    if (!row.payment_link_id) return { order: null, linkId: null, sessionOpen: row.open };
    const order = await this.orders.findByLinkIn(c, row.payment_link_id);
    return { order, linkId: row.payment_link_id, sessionOpen: row.open };
  }

  private async saleHeld(c: PoolClient, linkId: string): Promise<boolean> {
    const r = await c.query(
      `SELECT 1 FROM payment_intents
       WHERE payment_link_id = $1 AND NOT (status = ANY($2::text[])) LIMIT 1`,
      [linkId, SALE_RELEASING_STATUSES]
    );
    return (r.rowCount ?? 0) > 0;
  }

  private async livePlanId(c: PoolClient, orderId: string): Promise<string | null> {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM sandbox_installment_plans
       WHERE order_id = $1 AND status IN ('pending', 'approved')`,
      [orderId]
    );
    return r.rows[0]?.id ?? null;
  }

  async buyerView(sessionId: string, clientSecret: string): Promise<BuyerInstallmentsView | null> {
    const tenantId = await this.authenticate(sessionId, clientSecret);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const ctx = await this.sessionContext(c, sessionId, false);
      if (!ctx.order || !ctx.linkId) return null;
      const order = ctx.order;
      const latest = await c.query<{ id: string }>(
        `SELECT id FROM sandbox_installment_plans WHERE order_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [order.id]
      );
      const plan = latest.rows[0] ? await this.loadPlan(c, latest.rows[0].id) : null;
      let reason: BuyerInstallmentsView['ineligibleReason'] = null;
      if (await this.saleHeld(c, ctx.linkId)) reason = 'sale_charged';
      else if (order.payment.state === 'cancelled') reason = 'order_cancelled';
      else if (await this.livePlanId(c, order.id)) reason = 'plan_exists';
      else if (!ctx.sessionOpen) reason = 'checkout_closed';
      return {
        order: {
          number: order.number,
          currency: order.currency,
          total: order.total,
          lines: order.lines,
          merchantName: order.merchantName,
          cancelled: order.payment.state === 'cancelled',
        },
        eligible: reason === null,
        ineligibleReason: reason,
        allowedCounts: INSTALLMENT_DEMO_TERMS.counts,
        plan,
      };
    });
  }

  async quoteForSession(
    sessionId: string,
    clientSecret: string,
    count: number
  ): Promise<InstallmentQuote> {
    const tenantId = await this.authenticate(sessionId, clientSecret);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const ctx = await this.sessionContext(c, sessionId, false);
      if (!ctx.order) throw new InstallmentPlanNotAllowedError('no_order');
      return this.quote(ctx.order.total, ctx.order.currency, count);
    });
  }

  /**
   * El comprador CONFIRMA explícitamente un plan desde su checkout.
   *
   * Bajo el lock de la sesión y del payment link de la venta (el mismo que
   * toma el cobro con tarjeta): solo si ningún cobro retiene la venta. Un
   * reenvío con el mismo número de cuotas devuelve el plan vivo (idempotente);
   * otro número con un plan vivo es un conflicto. El proveedor SIMULADO decide
   * en la misma transacción según el escenario.
   */
  async createPlanForSession(
    sessionId: string,
    clientSecret: string,
    input: { count: number; scenario: InstallmentScenario; acceptTerms: boolean },
    now = new Date()
  ): Promise<{ plan: InstallmentPlanDto; replayed: boolean }> {
    if (input.acceptTerms !== true) throw new InstallmentTermsNotAcceptedError();
    if (!isAllowedInstallmentCount(input.count)) throw new InstallmentInvalidStateError();
    const tenantId = await this.authenticate(sessionId, clientSecret);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const ctx = await this.sessionContext(c, sessionId, true);
      if (!ctx.order || !ctx.linkId) throw new InstallmentPlanNotAllowedError('no_order');
      await c.query(`SELECT 1 FROM payment_links WHERE id = $1 FOR UPDATE`, [ctx.linkId]);

      const live = await this.livePlanId(c, ctx.order.id);
      if (live) {
        const plan = await this.loadPlan(c, live);
        if (plan.installmentsCount === input.count && plan.scenario === input.scenario) {
          return { plan, replayed: true };
        }
        throw new InstallmentPlanNotAllowedError('plan_exists');
      }
      if (await this.saleHeld(c, ctx.linkId)) {
        throw new InstallmentPlanNotAllowedError('sale_charged');
      }
      if (!ctx.sessionOpen) throw new InstallmentInvalidStateError();

      const order = ctx.order;
      const quote = this.quote(order.total, order.currency, input.count, now);
      const decided = input.scenario !== 'pending';
      const status =
        input.scenario === 'approve'
          ? 'approved'
          : input.scenario === 'decline'
            ? 'declined'
            : 'pending';
      const ins = await c.query<{ id: string }>(
        `INSERT INTO sandbox_installment_plans
           (tenant_id, order_id, payment_link_id, checkout_session_id, currency, total,
            installments_count, interval_days, terms_version, scenario, status,
            buyer_confirmed_at, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          tenantId,
          order.id,
          ctx.linkId,
          sessionId,
          order.currency,
          order.total.toString(),
          input.count,
          quote.intervalDays,
          quote.termsVersion,
          input.scenario,
          status,
          now.toISOString(),
          decided ? now.toISOString() : null,
        ]
      );
      const planId = ins.rows[0]!.id;
      for (const s of quote.schedule) {
        await c.query(
          `INSERT INTO sandbox_installments (tenant_id, plan_id, seq, amount, due_date)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, planId, s.seq, s.amount.toString(), s.dueDate]
        );
      }
      await this.event(c, tenantId, planId, 'plan_requested', null, 'buyer', null);
      if (decided) {
        await this.event(
          c,
          tenantId,
          planId,
          status === 'approved' ? 'plan_approved' : 'plan_declined',
          null,
          'simulated_provider',
          null
        );
      }
      return { plan: await this.loadPlan(c, planId), replayed: false };
    });
  }

  private async event(
    c: PoolClient,
    tenantId: string,
    planId: string,
    kind: string,
    seq: number | null,
    actor: InstallmentEventDto['actor'],
    userId: string | null
  ): Promise<void> {
    await c.query(
      `INSERT INTO sandbox_installment_events (tenant_id, plan_id, kind, seq, actor, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, planId, kind, seq, actor, userId]
    );
  }

  // ── Plano del comercio (sesión) ──────────────────────────────────────────

  async get(tenantId: string, planId: string): Promise<InstallmentPlanDto> {
    return withTenantTransaction(this.appPool, tenantId, (c) => this.loadPlan(c, planId));
  }

  async list(tenantId: string, limit = 50): Promise<InstallmentPlanDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const ids = await c.query<{ id: string }>(
        `SELECT id FROM sandbox_installment_plans ORDER BY created_at DESC, id LIMIT $1`,
        [capped]
      );
      const out: InstallmentPlanDto[] = [];
      for (const r of ids.rows) out.push(await this.loadPlan(c, r.id));
      return out;
    });
  }

  /**
   * Evento SIMULADO del proveedor sobre un plan pendiente (lo dispara un
   * operador del sandbox). Idempotente: repetir la misma decisión devuelve el
   * plan; una decisión distinta sobre un plan ya decidido es inválida.
   */
  async simulateDecision(
    tenantId: string,
    planId: string,
    decision: 'approved' | 'declined',
    userId: string,
    audit?: (c: PoolClient, plan: InstallmentPlanDto) => Promise<void>
  ): Promise<InstallmentPlanDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const cur = await c.query<{ status: string }>(
        `SELECT status FROM sandbox_installment_plans WHERE id = $1 FOR UPDATE`,
        [planId]
      );
      const status = cur.rows[0]?.status;
      if (!status) throw new InstallmentPlanNotFoundError();
      if (status === decision) return this.loadPlan(c, planId);
      if (status !== 'pending') throw new InstallmentInvalidStateError();
      await c.query(
        `UPDATE sandbox_installment_plans SET status = $2, decided_at = now(), updated_at = now()
         WHERE id = $1`,
        [planId, decision]
      );
      await this.event(
        c,
        tenantId,
        planId,
        decision === 'approved' ? 'plan_approved' : 'plan_declined',
        null,
        'simulated_provider',
        userId
      );
      const plan = await this.loadPlan(c, planId);
      await audit?.(c, plan);
      return plan;
    });
  }

  /**
   * Evento SIMULADO sobre una cuota de un plan aprobado: pagada o vencida.
   * Solo la cuota PENDIENTE más antigua (orden del calendario). Idempotente:
   * repetir el mismo evento sobre la misma cuota no cambia nada.
   */
  async simulateInstallment(
    tenantId: string,
    planId: string,
    seq: number,
    outcome: 'paid' | 'overdue',
    userId: string,
    audit?: (c: PoolClient, plan: InstallmentPlanDto) => Promise<void>
  ): Promise<InstallmentPlanDto> {
    const target = outcome === 'paid' ? 'paid_simulated' : 'overdue_simulated';
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const plan = await c.query<{ status: string }>(
        `SELECT status FROM sandbox_installment_plans WHERE id = $1 FOR UPDATE`,
        [planId]
      );
      if (!plan.rows[0]) throw new InstallmentPlanNotFoundError();
      if (plan.rows[0].status !== 'approved') throw new InstallmentInvalidStateError();
      const rows = await c.query<{ seq: number; status: string }>(
        `SELECT seq, status FROM sandbox_installments WHERE plan_id = $1 ORDER BY seq`,
        [planId]
      );
      const inst = rows.rows.find((r) => r.seq === seq);
      if (!inst) throw new InstallmentPlanNotFoundError();
      if (inst.status === target) return this.loadPlan(c, planId);
      const next = rows.rows.find((r) => r.status !== 'paid_simulated');
      if (!next || next.seq !== seq) throw new InstallmentInvalidStateError();
      if (inst.status === 'overdue_simulated' && target === 'overdue_simulated') {
        return this.loadPlan(c, planId);
      }
      if (
        inst.status !== 'scheduled' &&
        !(inst.status === 'overdue_simulated' && outcome === 'paid')
      ) {
        throw new InstallmentInvalidStateError();
      }
      await c.query(
        `UPDATE sandbox_installments SET status = $3, status_changed_at = now()
         WHERE plan_id = $1 AND seq = $2`,
        [planId, seq, target]
      );
      await this.event(
        c,
        tenantId,
        planId,
        outcome === 'paid' ? 'installment_paid_simulated' : 'installment_overdue_simulated',
        seq,
        'operator',
        userId
      );
      const updated = await this.loadPlan(c, planId);
      await audit?.(c, updated);
      return updated;
    });
  }
}
