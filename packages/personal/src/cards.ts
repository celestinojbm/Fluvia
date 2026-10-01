import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from '@fluvia/db';
import { insertAuditEvent } from '@fluvia/audit';
import { generateToken } from '@fluvia/auth';
import { Money } from '@fluvia/money';
import type { CardIssuerAdapter, RevealSession } from './adapters.js';
import { auditContextOf, consumerScope, withProgramTx, type ProgramActor } from './context.js';
import { AmountExceedsError, InvalidStateError, ResourceNotFoundError } from './errors.js';
import { downPaymentFor } from './policy.js';
import { assertProgramCurrency, loadActivePolicy } from './program.js';
import { assertConsumerActive } from './wallet.js';

export const PAYMENT_CODE_PREFIX = 'fcp';
const PAYMENT_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_LIVE_CARDS = 5;

export type CardStatus = 'requested' | 'inactive' | 'active' | 'blocked' | 'replaced' | 'closed';
export type FundingMode = 'wallet_first' | 'wallet_only' | 'credit_only';

export interface CardDto {
  id: string;
  consumerId: string;
  currency: string;
  form: 'virtual' | 'physical';
  status: CardStatus;
  issuer: string;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  fundingMode: FundingMode;
  limitPerTx: string | null;
  limitDaily: string | null;
  blockedBy: 'consumer' | 'operator' | null;
  replacesCardId: string | null;
  createdAt: string;
  activatedAt: string | null;
  closedAt: string | null;
  shipment: ShipmentDto | null;
}

export interface ShipmentDto {
  status: 'requested' | 'produced' | 'shipped' | 'delivered' | 'returned';
  city: string;
  addressLine: string;
  history: { status: string; at: string }[];
  updatedAt: string;
}

interface CardRow {
  id: string;
  consumer_id: string;
  currency: string;
  form: 'virtual' | 'physical';
  status: CardStatus;
  issuer: string;
  issuer_ref: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  funding_mode: FundingMode;
  limit_per_tx: string | null;
  limit_daily: string | null;
  blocked_by: 'consumer' | 'operator' | null;
  replaces_card_id: string | null;
  created_at: Date;
  activated_at: Date | null;
  closed_at: Date | null;
  s_status?: ShipmentDto['status'] | null;
  s_city?: string | null;
  s_address_line?: string | null;
  s_history?: { status: string; at: string }[] | null;
  s_updated_at?: Date | null;
}

function cardDto(r: CardRow): CardDto {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    currency: r.currency.trim(),
    form: r.form,
    status: r.status,
    issuer: r.issuer,
    last4: r.last4,
    expMonth: r.exp_month,
    expYear: r.exp_year,
    fundingMode: r.funding_mode,
    limitPerTx: r.limit_per_tx === null ? null : String(r.limit_per_tx),
    limitDaily: r.limit_daily === null ? null : String(r.limit_daily),
    blockedBy: r.blocked_by,
    replacesCardId: r.replaces_card_id,
    createdAt: r.created_at.toISOString(),
    activatedAt: r.activated_at?.toISOString() ?? null,
    closedAt: r.closed_at?.toISOString() ?? null,
    shipment: r.s_status
      ? {
          status: r.s_status,
          city: r.s_city!,
          addressLine: r.s_address_line!,
          history: r.s_history ?? [],
          updatedAt: r.s_updated_at!.toISOString(),
        }
      : null,
  };
}

export interface InstallmentOffer {
  policy: { id: string; code: string; version: number; pendingCommercialValidation: true };
  installmentsCount: number;
  intervalDays: number;
  downPaymentBps: number;
  interestBps: number;
  lateFeeBps: number;
}

export interface OfferPreview {
  amount: string;
  currency: string;
  downPayment: string;
  financed: string;
  installments: { seq: number; amount: string; dueDate: string }[];
  terms: InstallmentOffer;
}

/** Calendario ilustrativo de una oferta (misma fórmula que el plan real). */
export function previewOffer(
  amount: bigint,
  currency: string,
  offer: InstallmentOffer,
  start: Date = new Date()
): OfferPreview {
  const down = downPaymentFor(amount, offer.downPaymentBps);
  const financed = amount - down;
  const shares =
    financed > 0n
      ? Money.of(financed, currency).allocate(
          Array.from({ length: offer.installmentsCount }, () => 1)
        )
      : [];
  return {
    amount: amount.toString(),
    currency,
    downPayment: down.toString(),
    financed: financed.toString(),
    installments: shares.map((m, i) => ({
      seq: i + 1,
      amount: m.amount.toString(),
      dueDate: new Date(start.getTime() + (i + 1) * offer.intervalDays * 86_400_000)
        .toISOString()
        .slice(0, 10),
    })),
    terms: offer,
  };
}

export class CardService {
  constructor(
    private readonly appPool: Pool,
    private readonly issuer: CardIssuerAdapter
  ) {}

  /**
   * Emite una tarjeta (virtual: activa al emitir; física: inactiva hasta la
   * entrega y activación). La llamada al emisor ocurre fuera de la tx; si
   * falla, la tarjeta queda `requested` (reintentable) sin efectos de dinero.
   */
  async issue(
    tenantId: string,
    consumerId: string,
    input: {
      currency: string;
      form: 'virtual' | 'physical';
      fundingMode?: FundingMode;
      shipping?: { addressLine: string; city: string };
      replacesCardId?: string;
    },
    actor: ProgramActor
  ): Promise<CardDto> {
    if (input.form === 'physical' && !input.shipping) {
      throw new InvalidStateError('card', 'physical_requires_shipping');
    }
    const cardId = randomUUID();
    await withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      await assertProgramCurrency(c, tenantId, input.currency);
      await assertConsumerActive(c, tenantId, consumerId);
      const live = await c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM cards WHERE tenant_id = $1 AND consumer_id = $2
           AND status NOT IN ('replaced', 'closed')`,
        [tenantId, consumerId]
      );
      if (Number(live.rows[0]!.n) >= MAX_LIVE_CARDS && !input.replacesCardId) {
        throw new InvalidStateError('card', 'too_many_cards');
      }
      await c.query(
        `INSERT INTO cards (id, tenant_id, consumer_id, currency, form, status, issuer, funding_mode, replaces_card_id)
         VALUES ($1, $2, $3, $4, $5, 'requested', $6, $7, $8)`,
        [
          cardId,
          tenantId,
          consumerId,
          input.currency,
          input.form,
          this.issuer.name,
          input.fundingMode ?? 'wallet_first',
          input.replacesCardId ?? null,
        ]
      );
    });
    return this.completeIssuance(tenantId, cardId, input.shipping, actor);
  }

  /** Segunda fase de emisión (también sirve para reintentar una `requested`). */
  async completeIssuance(
    tenantId: string,
    cardId: string,
    shipping: { addressLine: string; city: string } | undefined,
    actor: ProgramActor
  ): Promise<CardDto> {
    const card = await this.getCard(tenantId, cardId, consumerScope(actor));
    if (card.status !== 'requested') return card;
    const issued = await this.issuer.issueCard({
      cardId,
      consumerRef: card.consumerId,
      form: card.form,
      currency: card.currency,
    });
    const shipment =
      card.form === 'physical' && shipping
        ? await this.issuer.requestShipment({ issuerRef: issued.issuerRef, ...shipping })
        : null;
    return withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      const res = await c.query<CardRow>(
        `UPDATE cards SET issuer_ref = $2, last4 = $3, exp_month = $4, exp_year = $5,
                status = $6, activated_at = CASE WHEN $6 = 'active' THEN now() END,
                version = version + 1
          WHERE id = $1 AND status = 'requested' RETURNING *`,
        [
          cardId,
          issued.issuerRef,
          issued.last4,
          issued.expMonth,
          issued.expYear,
          card.form === 'virtual' ? 'active' : 'inactive',
        ]
      );
      if (!res.rows[0]) return this.loadCard(c, tenantId, cardId);
      if (card.form === 'physical' && shipping) {
        await c.query(
          `INSERT INTO card_shipments (tenant_id, consumer_id, card_id, status, address_line, city, shipment_ref, history)
           VALUES ($1, $2, $3, 'requested', $4, $5, $6, $7)`,
          [
            tenantId,
            card.consumerId,
            cardId,
            shipping.addressLine,
            shipping.city,
            shipment?.shipmentRef ?? null,
            JSON.stringify([{ status: 'requested', at: new Date().toISOString() }]),
          ]
        );
      }
      if (card.replacesCardId) {
        await c.query(
          `UPDATE cards SET status = 'replaced', blocked_by = NULL, closed_at = now(), version = version + 1
            WHERE id = $1 AND status NOT IN ('closed', 'replaced')`,
          [card.replacesCardId]
        );
        const old = await c.query<{ issuer_ref: string | null }>(
          `SELECT issuer_ref FROM cards WHERE id = $1`,
          [card.replacesCardId]
        );
        if (old.rows[0]?.issuer_ref) {
          await this.issuer.setCardState({ issuerRef: old.rows[0].issuer_ref, state: 'closed' });
        }
      }
      await insertAuditEvent(c, {
        action: card.replacesCardId ? 'card.replaced' : 'card.issued',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'card',
        resourceId: cardId,
        after: { form: card.form, currency: card.currency, last4: issued.last4 },
      });
      return this.loadCard(c, tenantId, cardId);
    });
  }

  private async loadCard(
    c: PoolClient,
    tenantId: string,
    cardId: string,
    lock = false
  ): Promise<CardDto> {
    if (lock) {
      await c.query(`SELECT 1 FROM cards WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
        cardId,
        tenantId,
      ]);
    }
    const res = await c.query<CardRow>(
      `SELECT k.*, s.status AS s_status, s.city AS s_city, s.address_line AS s_address_line,
              s.history AS s_history, s.updated_at AS s_updated_at
         FROM cards k LEFT JOIN card_shipments s ON s.card_id = k.id
        WHERE k.id = $1 AND k.tenant_id = $2`,
      [cardId, tenantId]
    );
    if (!res.rows[0]) throw new ResourceNotFoundError('Card');
    return cardDto(res.rows[0]);
  }

  async getCard(tenantId: string, cardId: string, scope: string | null): Promise<CardDto> {
    return withProgramTx(this.appPool, tenantId, scope, (c) => this.loadCard(c, tenantId, cardId));
  }

  async listCards(
    tenantId: string,
    filter: { consumerId?: string },
    scope: string | null
  ): Promise<CardDto[]> {
    return withProgramTx(this.appPool, tenantId, scope, async (c) => {
      const res = await c.query<CardRow>(
        `SELECT k.*, s.status AS s_status, s.city AS s_city, s.address_line AS s_address_line,
                s.history AS s_history, s.updated_at AS s_updated_at
           FROM cards k LEFT JOIN card_shipments s ON s.card_id = k.id
          WHERE k.tenant_id = $1 AND ($2::uuid IS NULL OR k.consumer_id = $2)
          ORDER BY (k.status IN ('replaced', 'closed')), k.created_at DESC LIMIT 200`,
        [tenantId, filter.consumerId ?? null]
      );
      return res.rows.map(cardDto);
    });
  }

  private async transition(
    tenantId: string,
    cardId: string,
    actor: ProgramActor,
    apply: (
      c: PoolClient,
      card: CardDto
    ) => Promise<{
      status?: CardStatus;
      blockedBy?: 'consumer' | 'operator' | null;
      action:
        | 'card.activated'
        | 'card.blocked'
        | 'card.unblocked'
        | 'card.closed'
        | 'card.limits_changed';
      issuerState?: 'active' | 'blocked' | 'closed';
      reason?: string;
      extraSql?: { sql: string; params: unknown[] };
    }>
  ): Promise<CardDto> {
    return withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      const card = await this.loadCard(c, tenantId, cardId, true);
      const change = await apply(c, card);
      if (change.status) {
        await c.query(
          `UPDATE cards SET status = $2, blocked_by = $3, version = version + 1,
                  activated_at = CASE WHEN $2 = 'active' AND activated_at IS NULL THEN now() ELSE activated_at END,
                  closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE closed_at END
            WHERE id = $1`,
          [cardId, change.status, change.blockedBy ?? null]
        );
      }
      if (change.extraSql) await c.query(change.extraSql.sql, change.extraSql.params);
      if (change.issuerState) {
        const ref = await c.query<{ issuer_ref: string | null }>(
          `SELECT issuer_ref FROM cards WHERE id = $1`,
          [cardId]
        );
        // Simulado: estado en memoria. Con un emisor real, este paso es una
        // llamada FUERA de tx con su propia reconciliación (ver ESPECIFICACION §8).
        if (ref.rows[0]?.issuer_ref) {
          await this.issuer.setCardState({
            issuerRef: ref.rows[0].issuer_ref,
            state: change.issuerState,
          });
        }
      }
      await insertAuditEvent(c, {
        action: change.action,
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'card',
        resourceId: cardId,
        riskLevel: actor.kind === 'operator' ? 'high' : 'medium',
        reason: change.reason,
        before: { status: card.status },
        after: { status: change.status ?? card.status },
      });
      return this.loadCard(c, tenantId, cardId);
    });
  }

  /** Activación de la física tras la entrega. */
  async activate(tenantId: string, cardId: string, actor: ProgramActor): Promise<CardDto> {
    return this.transition(tenantId, cardId, actor, async (_c, card) => {
      if (card.status !== 'inactive') throw new InvalidStateError('card', card.status);
      if (card.form === 'physical' && card.shipment?.status !== 'delivered') {
        throw new InvalidStateError('card', 'not_delivered');
      }
      return { status: 'active', action: 'card.activated', issuerState: 'active' };
    });
  }

  async block(
    tenantId: string,
    cardId: string,
    reason: string,
    actor: ProgramActor
  ): Promise<CardDto> {
    return this.transition(tenantId, cardId, actor, async (_c, card) => {
      if (card.status === 'blocked') return { action: 'card.blocked', reason };
      if (card.status !== 'active' && card.status !== 'inactive') {
        throw new InvalidStateError('card', card.status);
      }
      return {
        status: 'blocked',
        blockedBy: actor.kind === 'operator' ? 'operator' : 'consumer',
        action: 'card.blocked',
        issuerState: 'blocked',
        reason,
      };
    });
  }

  /** Un bloqueo de Operaciones solo lo levanta Operaciones. */
  async unblock(
    tenantId: string,
    cardId: string,
    reason: string,
    actor: ProgramActor
  ): Promise<CardDto> {
    return this.transition(tenantId, cardId, actor, async (_c, card) => {
      if (card.status !== 'blocked') throw new InvalidStateError('card', card.status);
      if (card.blockedBy === 'operator' && actor.kind !== 'operator') {
        throw new InvalidStateError('card', 'blocked_by_operator');
      }
      const back = card.activatedAt ? 'active' : 'inactive';
      return {
        status: back,
        blockedBy: null,
        action: 'card.unblocked',
        issuerState: 'active',
        reason,
      };
    });
  }

  async setLimits(
    tenantId: string,
    cardId: string,
    input: { limitPerTx: bigint | null; limitDaily: bigint | null; fundingMode?: FundingMode },
    actor: ProgramActor
  ): Promise<CardDto> {
    for (const v of [input.limitPerTx, input.limitDaily]) {
      if (v !== null && v <= 0n) throw new AmountExceedsError('allowed range');
    }
    return this.transition(tenantId, cardId, actor, async (_c, card) => {
      if (card.status === 'closed' || card.status === 'replaced') {
        throw new InvalidStateError('card', card.status);
      }
      return {
        action: 'card.limits_changed',
        extraSql: {
          sql: `UPDATE cards SET limit_per_tx = $2, limit_daily = $3,
                  funding_mode = COALESCE($4, funding_mode), version = version + 1 WHERE id = $1`,
          params: [
            cardId,
            input.limitPerTx?.toString() ?? null,
            input.limitDaily?.toString() ?? null,
            input.fundingMode ?? null,
          ],
        },
      };
    });
  }

  /** Cierre: sin autorizaciones con reservas vivas. */
  async close(
    tenantId: string,
    cardId: string,
    reason: string,
    actor: ProgramActor
  ): Promise<CardDto> {
    return this.transition(tenantId, cardId, actor, async (c, card) => {
      if (card.status === 'closed' || card.status === 'replaced') {
        throw new InvalidStateError('card', card.status);
      }
      const live = await c.query(
        `SELECT 1 FROM card_authorizations WHERE card_id = $1 AND status IN ('approved', 'partially_captured') LIMIT 1`,
        [cardId]
      );
      if (live.rowCount) throw new InvalidStateError('card', 'live_authorizations');
      return {
        status: 'closed',
        blockedBy: null,
        action: 'card.closed',
        issuerState: 'closed',
        reason,
      };
    });
  }

  /** Reemplazo (pérdida, robo, deterioro): nueva tarjeta y la anterior queda `replaced`. */
  async replace(
    tenantId: string,
    cardId: string,
    input: { reason: string; shipping?: { addressLine: string; city: string } },
    actor: ProgramActor
  ): Promise<CardDto> {
    const old = await this.getCard(tenantId, cardId, consumerScope(actor));
    if (old.status === 'closed' || old.status === 'replaced' || old.status === 'requested') {
      throw new InvalidStateError('card', old.status);
    }
    return this.issue(
      tenantId,
      old.consumerId,
      {
        currency: old.currency,
        form: old.form,
        fundingMode: old.fundingMode,
        shipping:
          input.shipping ??
          (old.shipment
            ? { addressLine: old.shipment.addressLine, city: old.shipment.city }
            : undefined),
        replacesCardId: old.id,
      },
      actor
    );
  }

  /** Avance del envío (evento del emisor/mensajería simulado u operador). */
  async advanceShipment(
    tenantId: string,
    cardId: string,
    status: 'produced' | 'shipped' | 'delivered' | 'returned',
    actor: ProgramActor
  ): Promise<CardDto> {
    const order = ['requested', 'produced', 'shipped', 'delivered'];
    return withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      const s = await c.query<{ status: string; history: { status: string; at: string }[] }>(
        `SELECT status, history FROM card_shipments WHERE card_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [cardId, tenantId]
      );
      const row = s.rows[0];
      if (!row) throw new ResourceNotFoundError('Shipment');
      if (row.status === status) return this.loadCard(c, tenantId, cardId);
      const valid =
        status === 'returned'
          ? row.status === 'shipped'
          : order.indexOf(status) === order.indexOf(row.status) + 1;
      if (!valid) throw new InvalidStateError('shipment', row.status);
      const history = [...row.history, { status, at: new Date().toISOString() }];
      await c.query(
        `UPDATE card_shipments SET status = $2, history = $3, updated_at = now() WHERE card_id = $1`,
        [cardId, status, JSON.stringify(history)]
      );
      await insertAuditEvent(c, {
        action: 'card.shipment_updated',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'card',
        resourceId: cardId,
        after: { shipment: status },
      });
      return this.loadCard(c, tenantId, cardId);
    });
  }

  /** Sesión para ver datos sensibles en el componente seguro del emisor. */
  async revealSession(
    tenantId: string,
    cardId: string,
    actor: ProgramActor
  ): Promise<RevealSession> {
    const card = await withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      const res = await c.query<{ issuer_ref: string | null; status: string }>(
        `SELECT issuer_ref, status FROM cards WHERE id = $1 AND tenant_id = $2`,
        [cardId, tenantId]
      );
      if (!res.rows[0]) throw new ResourceNotFoundError('Card');
      return res.rows[0];
    });
    if (!card.issuer_ref || card.status !== 'active')
      throw new InvalidStateError('card', card.status);
    return this.issuer.createRevealSession({ issuerRef: card.issuer_ref });
  }

  /** Oferta de cuotas vigente (política activa) para mostrar ANTES de aceptar. */
  async installmentOffer(tenantId: string, installmentsCount: number): Promise<InstallmentOffer> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const policy = await loadActivePolicy(c, tenantId);
      if (!policy.params.installmentCounts.includes(installmentsCount)) {
        throw new InvalidStateError('offer', 'installments_not_allowed');
      }
      return {
        policy: {
          id: policy.id,
          code: policy.code,
          version: policy.version,
          pendingCommercialValidation: true,
        },
        installmentsCount,
        intervalDays: policy.params.intervalDays,
        downPaymentBps: policy.params.downPaymentBps,
        interestBps: policy.params.interestBps,
        lateFeeBps: policy.params.lateFeeBps,
      };
    });
  }

  /**
   * Código de pago de un solo uso (token de red): el cliente ACEPTA la oferta
   * (saldo o cuotas) y recibe `fcp_…` para usar en un comercio Fluvia. Se
   * guarda solo su hash; caduca en 10 minutos.
   */
  async createPaymentCode(
    tenantId: string,
    consumerId: string,
    input: {
      cardId: string;
      mode: 'wallet' | 'installments';
      installmentsCount?: number;
      maxAmount?: bigint;
    },
    actor: ProgramActor
  ): Promise<{ code: string; expiresAt: string; mode: string; terms: InstallmentOffer | null }> {
    const terms =
      input.mode === 'installments'
        ? await this.installmentOffer(tenantId, input.installmentsCount ?? 0)
        : null;
    const token = generateToken(PAYMENT_CODE_PREFIX);
    const expiresAt = new Date(Date.now() + PAYMENT_CODE_TTL_MS);
    await withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      const card = await this.loadCard(c, tenantId, input.cardId);
      if (card.consumerId !== consumerId) throw new ResourceNotFoundError('Card');
      if (card.status !== 'active') throw new InvalidStateError('card', card.status);
      await c.query(
        `INSERT INTO card_payment_tokens
           (tenant_id, consumer_id, card_id, token_hash, mode, installments_count, terms, max_amount, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          consumerId,
          input.cardId,
          token.hash,
          input.mode,
          terms ? terms.installmentsCount : null,
          terms ? JSON.stringify(terms) : null,
          input.maxAmount?.toString() ?? null,
          expiresAt,
        ]
      );
      await insertAuditEvent(c, {
        action: 'card.payment_code_created',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'card',
        resourceId: input.cardId,
        after: { mode: input.mode, installments: terms?.installmentsCount ?? null },
      });
    });
    return { code: token.plaintext, expiresAt: expiresAt.toISOString(), mode: input.mode, terms };
  }
}
