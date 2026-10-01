import type { Pool } from '@fluvia/db';
import { insertAuditEvent } from '@fluvia/audit';
import { z } from 'zod';
import type { AuthorizationService } from './authorizations.js';
import { autoResolveCase, openCase } from './cases.js';
import type { CardService } from './cards.js';
import { toBig, withProgramTx } from './context.js';
import type { WalletService } from './wallet.js';

/**
 * Ingesta de eventos de proveedores (fondeo, retiros, emisor y red) con:
 *  - deduplicación por `(source, event_id)` en el motor (UNIQUE);
 *  - tolerancia a desorden: un evento que llega antes que su objeto queda
 *    `unmatched` con caso abierto y se reintenta de forma controlada
 *    (`retryUnmatched`); uno que llega tarde a un objeto ya terminal queda
 *    `ignored_out_of_order` sin efectos;
 *  - cada efecto es idempotente por sí mismo (claves del ledger y de eventos
 *    de autorización), así que reprocesar nunca duplica dinero.
 */
export type EventSource = 'funding' | 'withdrawal' | 'issuer' | 'network';

export interface IncomingEvent {
  source: EventSource;
  eventId: string;
  eventType: string;
  occurredAt?: string;
  payload: Record<string, unknown>;
}

export interface IngestResult {
  eventId: string;
  status: 'applied' | 'duplicate' | 'ignored_out_of_order' | 'unmatched' | 'failed';
  detail?: string;
}

const minor = z
  .union([z.string().regex(/^[0-9]{1,16}$/), z.number().int().positive()])
  .transform((v) => BigInt(v));

const schemas = {
  'funding.confirmed': z.object({
    provider_ref: z.string(),
    amount: minor,
    currency: z.string().length(3),
  }),
  'funding.failed': z.object({ provider_ref: z.string(), failure_code: z.string().optional() }),
  'withdrawal.paid': z.object({ transfer_id: z.string().uuid(), provider_ref: z.string() }),
  'withdrawal.failed': z.object({
    transfer_id: z.string().uuid(),
    provider_ref: z.string(),
    failure_code: z.string().optional(),
  }),
  'shipment.updated': z.object({
    card_id: z.string().uuid(),
    status: z.enum(['produced', 'shipped', 'delivered', 'returned']),
  }),
  'authorization.request': z.object({
    card_id: z.string().uuid(),
    amount: minor,
    currency: z.string().length(3),
    merchant_name: z.string().min(1).max(120),
    network_ref: z.string().min(4).max(200),
  }),
  capture: z.object({
    network_ref: z.string(),
    amount: minor,
    capture_id: z.string(),
    final: z.boolean().optional(),
  }),
  reversal: z.object({
    network_ref: z.string(),
    amount: minor.optional(),
    reversal_id: z.string(),
  }),
  refund: z.object({ network_ref: z.string(), amount: minor, refund_id: z.string() }),
} as const;

const SOURCE_TYPES: Record<EventSource, string[]> = {
  funding: ['funding.confirmed', 'funding.failed'],
  withdrawal: ['withdrawal.paid', 'withdrawal.failed'],
  issuer: ['shipment.updated'],
  network: ['authorization.request', 'capture', 'reversal', 'refund'],
};

class Unmatched extends Error {}

export class ProviderEventService {
  constructor(
    private readonly appPool: Pool,
    private readonly deps: {
      wallet: WalletService;
      authorizations: AuthorizationService;
      cards: CardService;
    }
  ) {}

  async ingest(tenantId: string, event: IncomingEvent): Promise<IngestResult> {
    if (!SOURCE_TYPES[event.source]?.includes(event.eventType)) {
      return { eventId: event.eventId, status: 'failed', detail: 'unknown_event_type' };
    }
    const inserted = await withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO program_provider_events (tenant_id, source, event_id, event_type, occurred_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, source, event_id) DO NOTHING RETURNING id`,
        [
          tenantId,
          event.source,
          event.eventId,
          event.eventType,
          event.occurredAt ?? new Date().toISOString(),
          JSON.stringify(event.payload),
        ]
      );
      return res.rows[0]?.id ?? null;
    });
    if (!inserted) return { eventId: event.eventId, status: 'duplicate' };
    return this.process(tenantId, inserted);
  }

  /** Procesa (o reprocesa) un evento almacenado. */
  async process(tenantId: string, rowId: string): Promise<IngestResult> {
    const ev = await withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{
        id: string;
        source: EventSource;
        event_id: string;
        event_type: keyof typeof schemas;
        payload: Record<string, unknown>;
        status: string;
      }>(`SELECT * FROM program_provider_events WHERE id = $1 AND tenant_id = $2`, [
        rowId,
        tenantId,
      ]);
      return res.rows[0]!;
    });
    let status: IngestResult['status'];
    let detail: string | undefined;
    try {
      status = await this.apply(tenantId, ev.event_type, ev.payload);
    } catch (err) {
      if (err instanceof Unmatched) {
        status = 'unmatched';
        detail = err.message;
      } else {
        status = 'failed';
        detail = (err as Error).name || 'error';
      }
    }
    await withProgramTx(this.appPool, tenantId, null, async (c) => {
      await c.query(
        `UPDATE program_provider_events SET status = $2, detail = $3, processed_at = now() WHERE id = $1`,
        [rowId, status, detail ?? null]
      );
      if (status === 'unmatched') {
        await openCase(c, {
          tenantId,
          caseType: 'unmatched_provider_event',
          severity: 'medium',
          subjectType: 'provider_event',
          subjectId: rowId,
          summary: `Evento ${ev.event_type} sin objeto correspondiente (todavía): se reintentará.`,
          evidence: { source: ev.source, event_id: ev.event_id, detail },
        });
      } else if (status === 'applied' || status === 'ignored_out_of_order') {
        await autoResolveCase(
          c,
          tenantId,
          'unmatched_provider_event',
          'provider_event',
          rowId,
          'El evento encontró su objeto y se aplicó.'
        );
      }
      await insertAuditEvent(c, {
        action: 'program.provider_event_ingested',
        tenantId,
        context: { actorType: 'system', authMethod: 'none' },
        resourceType: 'provider_event',
        resourceId: rowId,
        result: status === 'failed' ? 'failure' : 'success',
        after: { source: ev.source, type: ev.event_type, status },
      });
    });
    return { eventId: ev.event_id, status, ...(detail ? { detail } : {}) };
  }

  private async apply(
    tenantId: string,
    type: keyof typeof schemas,
    raw: Record<string, unknown>
  ): Promise<'applied' | 'ignored_out_of_order'> {
    switch (type) {
      case 'funding.confirmed':
      case 'funding.failed': {
        const p = schemas[type].parse(raw) as {
          provider_ref: string;
          amount?: bigint;
          currency?: string;
          failure_code?: string;
        };
        const out = await withProgramTx(this.appPool, tenantId, null, (c) =>
          this.deps.wallet.applyFundingResult(c, tenantId, {
            providerRef: p.provider_ref,
            result: type === 'funding.confirmed' ? 'confirmed' : 'failed',
            ...(p.amount !== undefined ? { amount: p.amount } : {}),
            ...(p.currency ? { currency: p.currency } : {}),
            ...(p.failure_code ? { failureCode: p.failure_code } : {}),
          })
        );
        if (out === 'unmatched') throw new Unmatched('funding_not_found_or_amount_mismatch');
        return out;
      }
      case 'withdrawal.paid':
      case 'withdrawal.failed': {
        const p = schemas[type].parse(raw) as {
          transfer_id: string;
          provider_ref: string;
          failure_code?: string;
        };
        const out = await withProgramTx(this.appPool, tenantId, null, (c) =>
          this.deps.wallet.applyWithdrawalOutcome(c, tenantId, p.transfer_id, {
            outcome: type === 'withdrawal.paid' ? 'approved' : 'declined',
            providerRef: p.provider_ref,
            ...(p.failure_code ? { failureCode: p.failure_code } : {}),
          })
        );
        if (out === 'unmatched') throw new Unmatched('withdrawal_not_found');
        return out;
      }
      case 'shipment.updated': {
        const p = schemas[type].parse(raw);
        await this.deps.cards.advanceShipment(tenantId, p.card_id, p.status, { kind: 'system' });
        return 'applied';
      }
      case 'authorization.request': {
        const p = schemas[type].parse(raw);
        await this.deps.authorizations.authorize(tenantId, {
          cardId: p.card_id,
          amount: p.amount,
          currency: p.currency,
          merchantName: p.merchant_name,
          networkRef: p.network_ref,
          source: 'network',
        });
        return 'applied';
      }
      case 'capture':
      case 'reversal':
      case 'refund': {
        const p = schemas[type].parse(raw) as {
          network_ref: string;
          amount?: bigint;
          capture_id?: string;
          reversal_id?: string;
          refund_id?: string;
          final?: boolean;
        };
        const auth = await this.deps.authorizations.findByNetworkRef(tenantId, p.network_ref);
        if (!auth) throw new Unmatched('authorization_not_found');
        if (auth.status === 'declined') return 'ignored_out_of_order';
        if (type === 'capture') {
          if (auth.status !== 'approved' && auth.status !== 'partially_captured') {
            const already = auth.events.some((e) => e.idempotencyKey === `net:${p.capture_id}`);
            if (already) return 'applied';
            return 'ignored_out_of_order';
          }
          await this.deps.authorizations.capture(tenantId, auth.id, {
            amount: p.amount!,
            idempotencyKey: `net:${p.capture_id}`,
            ...(p.final ? { final: true } : {}),
          });
        } else if (type === 'reversal') {
          if (auth.status !== 'approved' && auth.status !== 'partially_captured')
            return 'ignored_out_of_order';
          await this.deps.authorizations.reverse(tenantId, auth.id, {
            ...(p.amount !== undefined ? { amount: p.amount } : {}),
            idempotencyKey: `net:${p.reversal_id}`,
          });
        } else {
          const captured = toBig(auth.capturedWallet) + toBig(auth.capturedCredit);
          if (captured === 0n) throw new Unmatched('refund_before_capture');
          await this.deps.authorizations.refund(tenantId, auth.id, {
            amount: p.amount!,
            idempotencyKey: `net:${p.refund_id}`,
          });
        }
        return 'applied';
      }
    }
  }

  /** Reintento controlado de eventos sin objeto, en orden de ocurrencia. */
  async retryUnmatched(
    tenantId: string,
    limit = 100
  ): Promise<{ applied: number; stillUnmatched: number }> {
    const ids = await withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{ id: string }>(
        `SELECT id FROM program_provider_events WHERE tenant_id = $1 AND status IN ('unmatched', 'failed')
          ORDER BY occurred_at, received_at LIMIT $2`,
        [tenantId, limit]
      );
      return res.rows.map((r) => r.id);
    });
    let applied = 0;
    let still = 0;
    for (const id of ids) {
      const r = await this.process(tenantId, id);
      if (r.status === 'applied' || r.status === 'ignored_out_of_order') applied++;
      else still++;
    }
    return { applied, stillUnmatched: still };
  }

  async list(
    tenantId: string,
    filter: { status?: string; source?: string } = {}
  ): Promise<
    {
      id: string;
      source: string;
      eventId: string;
      eventType: string;
      status: string;
      detail: string | null;
      occurredAt: string;
      receivedAt: string;
      payload: Record<string, unknown>;
    }[]
  > {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{
        id: string;
        source: string;
        event_id: string;
        event_type: string;
        status: string;
        detail: string | null;
        occurred_at: Date;
        received_at: Date;
        payload: Record<string, unknown>;
      }>(
        `SELECT id, source, event_id, event_type, status, detail, occurred_at, received_at, payload
           FROM program_provider_events
          WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR source = $3)
          ORDER BY received_at DESC LIMIT 200`,
        [tenantId, filter.status ?? null, filter.source ?? null]
      );
      return res.rows.map((r) => ({
        id: r.id,
        source: r.source,
        eventId: r.event_id,
        eventType: r.event_type,
        status: r.status,
        detail: r.detail,
        occurredAt: r.occurred_at.toISOString(),
        receivedAt: r.received_at.toISOString(),
        payload: r.payload,
      }));
    });
  }
}

export interface ReconciliationReport {
  checkedAt: string;
  checks: { code: string; ok: boolean; detail: string }[];
  casesOpened: number;
}

/**
 * Conciliación interna del programa: registros de dominio ↔ ledger ↔
 * proveedor simulado. Toda diferencia abre un caso (no corrige nada sola).
 */
export class ProgramReconciliationService {
  constructor(private readonly appPool: Pool) {}

  async run(tenantId: string): Promise<ReconciliationReport> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const checks: ReconciliationReport['checks'] = [];
      let cases = 0;
      const mismatch = async (
        code: string,
        subjectId: string,
        detail: string,
        evidence: Record<string, unknown>
      ) => {
        checks.push({ code, ok: false, detail });
        await openCase(c, {
          tenantId,
          caseType: 'reconciliation_mismatch',
          severity: 'high',
          subjectType: code,
          subjectId,
          summary: detail.slice(0, 280),
          evidence,
        });
        cases++;
      };

      // 1. Proyecciones del ledger del programa == recomputo desde asientos.
      const drift = await c.query<{ id: string; name: string }>(
        `SELECT a.id, a.name
           FROM ledger_accounts a
           JOIN balance_projections p ON p.account_id = a.id
           CROSS JOIN LATERAL (
             SELECT COALESCE(SUM(CASE WHEN e.bucket = 'available' THEN
                      CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END END), 0) AS available,
                    COALESCE(SUM(CASE WHEN e.bucket = 'pending' THEN
                      CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END END), 0) AS pending
               FROM ledger_entries e WHERE e.account_id = a.id) r
          WHERE a.tenant_id = $1 AND (a.name LIKE 'consumer.%' OR a.name LIKE 'program.%')
            AND (p.available <> r.available OR p.pending <> r.pending)`,
        [tenantId]
      );
      if (drift.rows.length) {
        for (const d of drift.rows)
          await mismatch(
            'ledger_projection',
            d.id,
            `Proyección distinta del recomputo: ${d.name}`,
            {}
          );
      } else
        checks.push({ code: 'ledger_projection', ok: true, detail: 'Proyecciones = recomputo' });

      // 2. Saldo retenido del cliente == reservas de saldo vivas + retiros en tránsito.
      const held = await c.query<{
        consumer_id: string;
        currency: string;
        ledger: string;
        domain: string;
      }>(
        `WITH dom AS (
           SELECT consumer_id, currency, SUM(wallet_amount - captured_wallet - released_wallet) AS amt
             FROM card_authorizations WHERE tenant_id = $1 AND status IN ('approved', 'partially_captured')
            GROUP BY consumer_id, currency)
         SELECT split_part(a.name, ':', 2)::uuid AS consumer_id, a.currency, p.available::text AS ledger,
                COALESCE(d.amt, 0)::text AS domain
           FROM ledger_accounts a JOIN balance_projections p ON p.account_id = a.id
           LEFT JOIN dom d ON d.consumer_id = split_part(a.name, ':', 2)::uuid AND d.currency = a.currency
          WHERE a.tenant_id = $1 AND a.name LIKE 'consumer.wallet.held:%'
            AND p.available <> COALESCE(d.amt, 0)`,
        [tenantId]
      );
      if (held.rows.length) {
        for (const h of held.rows)
          await mismatch(
            'wallet_held',
            `${h.consumer_id}:${h.currency}`,
            `Reserva del ledger ${h.ledger} ≠ autorizaciones ${h.domain}`,
            h
          );
      } else
        checks.push({
          code: 'wallet_held',
          ok: true,
          detail: 'Reservas de saldo = autorizaciones vivas',
        });

      // 3. Deuda del ledger == Σ cuotas pendientes.
      const debt = await c.query<{
        consumer_id: string;
        currency: string;
        ledger: string;
        plans: string;
      }>(
        `WITH dom AS (
           SELECT p.consumer_id, p.currency, SUM(i.amount - i.paid_amount - i.cancelled_amount) AS amt
             FROM credit_installments i JOIN credit_plans p ON p.id = i.plan_id
            WHERE p.tenant_id = $1 GROUP BY p.consumer_id, p.currency)
         SELECT split_part(a.name, ':', 2)::uuid AS consumer_id, a.currency, pr.available::text AS ledger,
                COALESCE(d.amt, 0)::text AS plans
           FROM ledger_accounts a JOIN balance_projections pr ON pr.account_id = a.id
           LEFT JOIN dom d ON d.consumer_id = split_part(a.name, ':', 2)::uuid AND d.currency = a.currency
          WHERE a.tenant_id = $1 AND a.name LIKE 'consumer.credit.receivable:%'
            AND pr.available <> COALESCE(d.amt, 0)`,
        [tenantId]
      );
      if (debt.rows.length) {
        for (const d of debt.rows)
          await mismatch(
            'credit_debt',
            `${d.consumer_id}:${d.currency}`,
            `Deuda del ledger ${d.ledger} ≠ cuotas pendientes ${d.plans}`,
            d
          );
      } else checks.push({ code: 'credit_debt', ok: true, detail: 'Deuda = cuotas pendientes' });

      // 4. Obligación con la red == Σ capturado − Σ devuelto.
      const net = await c.query<{ currency: string; ledger: string; domain: string }>(
        `WITH dom AS (
           SELECT currency, SUM(captured_wallet + captured_credit - refunded_wallet - refunded_credit) AS amt
             FROM card_authorizations WHERE tenant_id = $1 GROUP BY currency)
         SELECT a.currency, p.available::text AS ledger, COALESCE(d.amt, 0)::text AS domain
           FROM ledger_accounts a JOIN balance_projections p ON p.account_id = a.id
           LEFT JOIN dom d ON d.currency = a.currency
          WHERE a.tenant_id = $1 AND a.name = 'program.network.payable' AND p.available <> COALESCE(d.amt, 0)`,
        [tenantId]
      );
      if (net.rows.length) {
        for (const n of net.rows)
          await mismatch(
            'network_payable',
            n.currency,
            `Obligación con la red ${n.ledger} ≠ capturado neto ${n.domain}`,
            n
          );
      } else
        checks.push({
          code: 'network_payable',
          ok: true,
          detail: 'Obligación con la red = capturado neto',
        });

      // 5. Retiros: estado interno ↔ decisión registrada del proveedor simulado.
      const wd = await c.query<{ id: string; status: string; outcome: string }>(
        `SELECT t.id, t.status, o.outcome FROM wallet_transfers t
           JOIN sandbox_provider_operations o ON o.operation = 'withdrawal' AND o.operation_ref = t.id::text
          WHERE t.tenant_id = $1 AND t.kind = 'withdrawal'
            AND ((t.status = 'completed' AND o.outcome <> 'approved')
              OR (t.status = 'failed' AND o.outcome = 'approved'))`,
        [tenantId]
      );
      if (wd.rows.length) {
        for (const w of wd.rows)
          await mismatch(
            'withdrawal_provider',
            w.id,
            `Retiro ${w.status} pero proveedor ${w.outcome}`,
            w
          );
      } else checks.push({ code: 'withdrawal_provider', ok: true, detail: 'Retiros = proveedor' });

      // 6. Ingresos confirmados con evento del proveedor.
      const fund = await c.query<{ id: string }>(
        `SELECT f.id FROM wallet_fundings f
          WHERE f.tenant_id = $1 AND f.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM program_provider_events e
                             WHERE e.tenant_id = f.tenant_id AND e.source = 'funding'
                               AND e.event_type = 'funding.confirmed' AND e.status = 'applied'
                               AND e.payload->>'provider_ref' = f.provider_ref)`,
        [tenantId]
      );
      if (fund.rows.length) {
        for (const f of fund.rows)
          await mismatch(
            'funding_event',
            f.id,
            'Ingreso confirmado sin evento aplicado del proveedor',
            f
          );
      } else
        checks.push({
          code: 'funding_event',
          ok: true,
          detail: 'Ingresos = eventos del proveedor',
        });

      return { checkedAt: new Date().toISOString(), checks, casesOpened: cases };
    });
  }
}
