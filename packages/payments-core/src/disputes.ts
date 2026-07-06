import { randomUUID } from 'node:crypto';
import { withTenantTransaction, type Pool } from '@fluvia/db';
import { buildEnvelope } from '@fluvia/events';
import { InsufficientBalanceError, accountName, type PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  DisputeNotFoundError,
  InsufficientDisputeBalanceError,
  InvalidStateTransitionError,
} from './errors.js';
import type { TxClient } from './service.js';

/**
 * Disputas / chargebacks como RECURSO gestionado (F4-08a) sobre la cuenta
 * `dispute.reserve` del Chart of Accounts. Mismo esqueleto contable que refunds
 * (F3-08), pero la disputa la INICIA el banco, no el comercio:
 *
 *   open: al abrir se APARTA el monto disputado del disponible del comercio
 *     (`openDispute`: merchant.available -> dispute.reserve). Atómico: la fila
 *     nace `open` y el asiento se postea en la MISMA transacción (o entra todo o
 *     nada). El guard AUD-P1-010 impide apartar más de lo disponible — el dinero
 *     disputado no se puede pagar ni disputar dos veces (no double-spend). En el
 *     sandbox v1 eso significa exigir disponible suficiente
 *     (`InsufficientDisputeBalanceError`); el saldo deudor es una decisión mayor
 *     futura.
 *
 *   under_review: el comercio respondió con evidencia (cambio de estado puro, no
 *     mueve dinero).
 *
 *   Desenlace por FUENTE VERIFICADA (el banco; jamás por asunción — V4 §23):
 *     won  -> `winDispute` (dispute.reserve -> merchant.available): el comercio
 *             recupera íntegro lo apartado.
 *     lost -> `loseDispute` (dispute.reserve -> provider.clearing): el dinero se
 *             va de vuelta vía el proveedor, como un refund forzado.
 *
 * Cada cambio de estado emite `dispute.<estado>` al outbox EN la misma
 * transacción (la disputa SIEMPRE es visible para el comercio: no hay estado
 * interno silencioso como el `indeterminate` de payouts).
 */

export interface DisputeDto {
  id: string;
  tenantId: string;
  merchantId: string;
  amount: string;
  currency: string;
  status: string;
  reason: string | null;
  provider: string;
  providerRef: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

interface DisputeRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  status: string;
  reason: string | null;
  provider: string;
  provider_ref: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

const DISPUTE_COLUMNS = `id, tenant_id, merchant_id, amount::text, currency, status,
  reason, provider, provider_ref, created_at, updated_at, resolved_at`;

function toDto(r: DisputeRow): DisputeDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    merchantId: r.merchant_id,
    amount: r.amount,
    currency: r.currency.trim(),
    status: r.status,
    reason: r.reason,
    provider: r.provider,
    providerRef: r.provider_ref,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    resolvedAt: r.resolved_at?.toISOString() ?? null,
  };
}

export interface OpenDisputeInput {
  merchantId: string;
  /** Unidades menores (estrictamente positivo). */
  amount: bigint;
  currency: string;
  /** Categoría del banco (fraudulent, product_not_received…). */
  reason?: string;
  /** Proveedor/banco de origen (default 'mock' en sandbox). */
  provider?: string;
  /** Referencia del banco a la disputa o al cargo disputado. */
  providerRef?: string;
}

export interface ResolveDisputeInput {
  disputeId: string;
  outcome: 'won' | 'lost';
  providerRef?: string;
}

export class DisputeService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    private readonly posting: PostingService
  ) {}

  /**
   * El banco ABRE una disputa: crea la fila `open` y aparta el monto en la MISMA
   * transacción del asiento (`openDispute`). Pre-chequeo best-effort para un
   * error limpio; el guard AUD-P1-010 del motor es la protección atómica final.
   */
  async open(tenantId: string, input: OpenDisputeInput): Promise<DisputeDto> {
    const amount = Money.of(input.amount.toString(), input.currency);
    const disputeId = randomUUID();
    const available = await this.availableBalance(tenantId, input.merchantId, input.currency);
    if (input.amount <= 0n || input.amount > available) {
      throw new InsufficientDisputeBalanceError(input.amount.toString(), available.toString());
    }
    try {
      await this.posting.openDispute({
        tenantId,
        merchantId: input.merchantId,
        idempotencyKey: `dispute:${disputeId}:open`,
        sourceType: 'dispute',
        sourceId: disputeId,
        amount,
        onPosted: async (client) => {
          const res = await client.query<DisputeRow>(
            `INSERT INTO disputes
               (id, tenant_id, merchant_id, amount, currency, reason, provider, provider_ref)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING ${DISPUTE_COLUMNS}`,
            [
              disputeId,
              tenantId,
              input.merchantId,
              input.amount.toString(),
              input.currency,
              input.reason ?? null,
              input.provider ?? 'mock',
              input.providerRef ?? null,
            ]
          );
          await this.emit(client, toDto(res.rows[0]!), 'open');
        },
      });
    } catch (err) {
      // Carrera: el disponible se drenó entre el pre-chequeo y el hold. El guard
      // atómico lo impidió; se reporta como error de dominio (nada se creó).
      if (err instanceof InsufficientBalanceError) {
        const avail = await this.availableBalance(tenantId, input.merchantId, input.currency);
        throw new InsufficientDisputeBalanceError(input.amount.toString(), avail.toString());
      }
      throw err;
    }
    return this.get(tenantId, disputeId);
  }

  /**
   * El comercio respondió con evidencia: `open` -> `under_review` (sin mover
   * dinero). Idempotente: si ya está `under_review` devuelve el estado actual sin
   * re-emitir; sobre una disputa terminal (won/lost) es un error de transición.
   * `FOR UPDATE` serializa envíos concurrentes (el segundo ve `under_review`).
   */
  async submitEvidence(tenantId: string, disputeId: string): Promise<DisputeDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const cur = await c.query<DisputeRow>(
        `SELECT ${DISPUTE_COLUMNS} FROM disputes WHERE id = $1 FOR UPDATE`,
        [disputeId]
      );
      const row = cur.rows[0];
      if (!row) throw new DisputeNotFoundError();
      if (row.status === 'under_review') return toDto(row);
      if (row.status !== 'open') {
        throw new InvalidStateTransitionError(row.status, 'under_review');
      }
      return this.transition(c, disputeId, 'under_review', {});
    });
  }

  /**
   * Resolución por FUENTE VERIFICADA (el banco; V4 §23): la única vía legítima
   * para cerrar una disputa `open`/`under_review`. Espeja `resolveFromProvider`
   * de payouts/refunds.
   *  - applied: la disputa se cerró (won -> fondos de vuelta al comercio; lost ->
   *    forfeit al proveedor).
   *  - ignored_out_of_order: la disputa ya es terminal (evento tardío).
   *  - ignored: disputa inexistente para este tenant.
   */
  async resolve(
    tenantId: string,
    input: ResolveDisputeInput
  ): Promise<'applied' | 'ignored_out_of_order' | 'ignored'> {
    const cur = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<{ status: string; amount: string; currency: string; merchant_id: string }>(
        `SELECT status, amount::text, currency, merchant_id FROM disputes WHERE id = $1`,
        [input.disputeId]
      )
    );
    const row = cur.rows[0];
    if (!row) return 'ignored';
    if (row.status === 'won' || row.status === 'lost') return 'ignored_out_of_order';
    const amount = Money.of(row.amount, row.currency.trim());
    if (input.outcome === 'won') {
      await this.recordWon(tenantId, input.disputeId, row.merchant_id, amount, input.providerRef);
    } else {
      await this.recordLost(tenantId, input.disputeId, row.merchant_id, amount, input.providerRef);
    }
    return 'applied';
  }

  async get(tenantId: string, disputeId: string): Promise<DisputeDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<DisputeRow>(
        `SELECT ${DISPUTE_COLUMNS} FROM disputes WHERE id = $1`,
        [disputeId]
      );
      if (!res.rows[0]) throw new DisputeNotFoundError();
      return toDto(res.rows[0]);
    });
  }

  async list(tenantId: string, merchantId?: string, limit = 20): Promise<DisputeDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = merchantId
        ? await c.query<DisputeRow>(
            `SELECT ${DISPUTE_COLUMNS} FROM disputes WHERE merchant_id = $2
             ORDER BY created_at DESC, id LIMIT $1`,
            [capped, merchantId]
          )
        : await c.query<DisputeRow>(
            `SELECT ${DISPUTE_COLUMNS} FROM disputes ORDER BY created_at DESC, id LIMIT $1`,
            [capped]
          );
      return res.rows.map(toDto);
    });
  }

  /** winDispute (dispute.reserve -> available) + dispute won: UNA tx. */
  private async recordWon(
    tenantId: string,
    disputeId: string,
    merchantId: string,
    amount: Money,
    providerRef?: string
  ): Promise<void> {
    await this.posting.winDispute({
      tenantId,
      merchantId,
      idempotencyKey: `dispute:${disputeId}:win`,
      sourceType: 'dispute',
      sourceId: disputeId,
      amount,
      onPosted: async (client) => {
        await this.transition(client, disputeId, 'won', { providerRef });
      },
    });
  }

  /** loseDispute (dispute.reserve -> provider.clearing) + dispute lost: UNA tx. */
  private async recordLost(
    tenantId: string,
    disputeId: string,
    merchantId: string,
    amount: Money,
    providerRef?: string
  ): Promise<void> {
    await this.posting.loseDispute({
      tenantId,
      merchantId,
      idempotencyKey: `dispute:${disputeId}:lose`,
      sourceType: 'dispute',
      sourceId: disputeId,
      amount,
      onPosted: async (client) => {
        await this.transition(client, disputeId, 'lost', { providerRef });
      },
    });
  }

  private async availableBalance(
    tenantId: string,
    merchantId: string,
    currency: string
  ): Promise<bigint> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const bal = await c.query<{ available: string }>(
        `SELECT COALESCE(bp.available, 0)::text AS available
         FROM ledger_accounts la
         JOIN balance_projections bp ON bp.account_id = la.id
         WHERE la.tenant_id = $1 AND la.name = $2 AND la.currency = $3 AND la.deleted_at IS NULL`,
        [tenantId, accountName('merchant.available', merchantId), currency]
      );
      return BigInt(bal.rows[0]?.available ?? '0');
    });
  }

  private async transition(
    c: TxClient,
    disputeId: string,
    to: string,
    opts: { providerRef?: string | null }
  ): Promise<DisputeDto> {
    // El trigger de 0036 re-valida contra dispute_transitions al UPDATE.
    const res = await c.query<DisputeRow>(
      `UPDATE disputes
       SET status = $2,
           updated_at = now(),
           resolved_at = CASE WHEN $2 IN ('won', 'lost') THEN now() ELSE resolved_at END,
           provider_ref = COALESCE($3, provider_ref)
       WHERE id = $1
       RETURNING ${DISPUTE_COLUMNS}`,
      [disputeId, to, opts.providerRef ?? null]
    );
    if (!res.rows[0]) throw new DisputeNotFoundError();
    const dto = toDto(res.rows[0]);
    await this.emit(c, dto, to);
    return dto;
  }

  private async emit(c: TxClient, dispute: DisputeDto, status: string): Promise<void> {
    const envelope = buildEnvelope({
      producer: 'fluvia.payments',
      resource: { type: 'dispute', id: dispute.id },
      data: {
        dispute_id: dispute.id,
        merchant_id: dispute.merchantId,
        status,
        amount: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason,
      },
    });
    await c.query(`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES ($1, $2, $3)`, [
      dispute.tenantId,
      `dispute.${status}`,
      JSON.stringify(envelope),
    ]);
  }
}
