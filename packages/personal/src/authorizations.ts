import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from '@fluvia/db';
import { insertAuditEvent } from '@fluvia/audit';
import { hashToken } from '@fluvia/auth';
import { InsufficientBalanceError, type ProgramPostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { engineMessage, toBig, withProgramTx } from './context.js';
import type { CreditService } from './credit.js';
import { lineExposure, lockLine } from './credit.js';
import {
  AmountExceedsError,
  InvalidStateError,
  PaymentCodeInvalidError,
  ResourceNotFoundError,
} from './errors.js';
import { downPaymentFor } from './policy.js';
import { loadActivePolicy, loadPolicyById } from './program.js';
import { PAYMENT_CODE_PREFIX, type InstallmentOffer } from './cards.js';

export type AuthorizationStatus =
  'approved' | 'partially_captured' | 'captured' | 'reversed' | 'expired' | 'declined';

export type DeclineCode =
  | 'card_inactive'
  | 'card_blocked'
  | 'card_closed'
  | 'consumer_inactive'
  | 'currency_not_supported'
  | 'card_limit_exceeded'
  | 'insufficient_funds'
  | 'credit_limit_exceeded'
  | 'amount_above_code_limit';

export interface AuthorizationDto {
  id: string;
  consumerId: string;
  cardId: string;
  currency: string;
  amount: string;
  status: AuthorizationStatus;
  declineCode: DeclineCode | null;
  walletAmount: string;
  creditAmount: string;
  capturedWallet: string;
  capturedCredit: string;
  releasedWallet: string;
  releasedCredit: string;
  refundedWallet: string;
  refundedCredit: string;
  /** Lo autorizado que sigue reservado (sin capturar ni liberar). */
  outstanding: string;
  installmentsCount: number | null;
  source: 'fluvia_checkout' | 'network';
  merchantName: string;
  merchantRef: string | null;
  networkRef: string;
  createdAt: string;
  expiresAt: string;
  events: AuthorizationEventDto[];
}

export interface AuthorizationEventDto {
  id: string;
  kind: 'capture' | 'reverse' | 'expire' | 'refund';
  amount: string;
  walletPart: string;
  creditPart: string;
  idempotencyKey: string;
  createdAt: string;
}

interface AuthRow {
  id: string;
  tenant_id: string;
  consumer_id: string;
  card_id: string;
  currency: string;
  amount: string;
  status: AuthorizationStatus;
  decline_code: DeclineCode | null;
  wallet_amount: string;
  credit_amount: string;
  captured_wallet: string;
  captured_credit: string;
  released_wallet: string;
  released_credit: string;
  refunded_wallet: string;
  refunded_credit: string;
  credit_line_id: string | null;
  installments_count: number | null;
  terms: (InstallmentOffer & Record<string, unknown>) | null;
  source: 'fluvia_checkout' | 'network';
  merchant_name: string;
  merchant_ref: string | null;
  network_ref: string;
  created_at: Date;
  expires_at: Date;
}

function remainingOf(r: AuthRow): { wallet: bigint; credit: bigint } {
  return {
    wallet: toBig(r.wallet_amount) - toBig(r.captured_wallet) - toBig(r.released_wallet),
    credit: toBig(r.credit_amount) - toBig(r.captured_credit) - toBig(r.released_credit),
  };
}

function authDto(r: AuthRow, events: AuthorizationEventDto[] = []): AuthorizationDto {
  const rem = remainingOf(r);
  const live = r.status === 'approved' || r.status === 'partially_captured';
  return {
    id: r.id,
    consumerId: r.consumer_id,
    cardId: r.card_id,
    currency: r.currency.trim(),
    amount: String(r.amount),
    status: r.status,
    declineCode: r.decline_code,
    walletAmount: String(r.wallet_amount),
    creditAmount: String(r.credit_amount),
    capturedWallet: String(r.captured_wallet),
    capturedCredit: String(r.captured_credit),
    releasedWallet: String(r.released_wallet),
    releasedCredit: String(r.released_credit),
    refundedWallet: String(r.refunded_wallet),
    refundedCredit: String(r.refunded_credit),
    outstanding: live ? (rem.wallet + rem.credit).toString() : '0',
    installmentsCount: r.installments_count,
    source: r.source,
    merchantName: r.merchant_name,
    merchantRef: r.merchant_ref,
    networkRef: r.network_ref,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    events,
  };
}

export interface AuthorizeInput {
  /** Tarjeta (red) o código de pago de un solo uso (checkout Fluvia). */
  cardId?: string;
  paymentCode?: string;
  amount: bigint;
  currency: string;
  merchantName: string;
  merchantRef?: string;
  /** Idempotencia de red: misma referencia ⇒ misma respuesta. */
  networkRef: string;
  source: 'fluvia_checkout' | 'network';
}

export interface AuthorizeResult {
  authorizationId: string | null;
  approved: boolean;
  declineCode: DeclineCode | 'invalid_payment_code' | null;
  replayed: boolean;
  authorization: AuthorizationDto | null;
}

class DeclineSignal extends Error {
  constructor(readonly code: DeclineCode) {
    super(code);
  }
}

/**
 * Autorización, captura (total/parcial), reverso, expiración y devolución de
 * tarjetas del programa. Reglas (ESPECIFICACION §8.3):
 *  - Las autorizaciones de un cliente se SERIALIZAN (advisory lock por
 *    cliente) y la línea de crédito se bloquea antes del ledger: orden de
 *    locks cliente → línea → cuentas (sin deadlocks con garantía/pagos).
 *  - Saldo propio: reserva en el ledger (`auth.hold`) con guard de no
 *    negatividad. Crédito: fila de reserva verificada por el TRIGGER del motor
 *    contra límite − deuda − reservas.
 *  - El crédito NUNCA pasa por la wallet: su captura va de deuda a la
 *    obligación con la red.
 */
export class AuthorizationService {
  constructor(
    private readonly appPool: Pool,
    private readonly posting: ProgramPostingService,
    private readonly credit: CreditService
  ) {}

  async authorize(tenantId: string, input: AuthorizeInput): Promise<AuthorizeResult> {
    if (input.amount <= 0n) throw new AmountExceedsError('allowed range');
    for (let attempt = 0; ; attempt++) {
      try {
        return await withProgramTx(this.appPool, tenantId, null, (c) =>
          this.authorizeOnce(c, tenantId, input)
        );
      } catch (err) {
        // Backstop: el guard del ledger o el trigger de crédito detectaron una
        // carrera que el lock por cliente no cubrió (p. ej. un retiro
        // simultáneo). Se reintenta con lectura fresca, que decide el rechazo.
        const engine = engineMessage(err).includes('FLUVIA_CREDIT_LIMIT_EXCEEDED');
        if ((err instanceof InsufficientBalanceError || engine) && attempt < 2) continue;
        throw err;
      }
    }
  }

  private async authorizeOnce(
    c: PoolClient,
    tenantId: string,
    input: AuthorizeInput
  ): Promise<AuthorizeResult> {
    // 1. Replay de red (serializado por referencia: dos mensajes iguales
    // simultáneos producen UNA autorización y la misma respuesta).
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('card-net:' || $1 || ':' || $2))`, [
      tenantId,
      input.networkRef,
    ]);
    const prior = await c.query<AuthRow>(
      `SELECT * FROM card_authorizations WHERE tenant_id = $1 AND network_ref = $2`,
      [tenantId, input.networkRef]
    );
    if (prior.rows[0]) {
      const p = prior.rows[0];
      if (String(p.amount) !== input.amount.toString() || p.currency.trim() !== input.currency) {
        return {
          authorizationId: null,
          approved: false,
          declineCode: 'invalid_payment_code',
          replayed: true,
          authorization: null,
        };
      }
      return {
        authorizationId: p.id,
        approved: p.status !== 'declined',
        declineCode: p.decline_code,
        replayed: true,
        authorization: authDto(p),
      };
    }

    // 2. Tarjeta (directa o por código de pago).
    let cardId = input.cardId;
    let token: {
      id: string;
      card_id: string;
      mode: 'wallet' | 'installments';
      installments_count: number | null;
      terms: InstallmentOffer | null;
      max_amount: string | null;
    } | null = null;
    if (input.paymentCode !== undefined) {
      if (!input.paymentCode.startsWith(`${PAYMENT_CODE_PREFIX}_`))
        throw new PaymentCodeInvalidError();
      const t = await c.query<{
        id: string;
        card_id: string;
        mode: 'wallet' | 'installments';
        installments_count: number | null;
        terms: InstallmentOffer | null;
        max_amount: string | null;
      }>(
        `SELECT id, card_id, mode, installments_count, terms, max_amount::text FROM card_payment_tokens
          WHERE tenant_id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [tenantId, hashToken(input.paymentCode)]
      );
      if (!t.rows[0]) throw new PaymentCodeInvalidError();
      token = t.rows[0];
      cardId = token.card_id;
    }
    if (!cardId) throw new PaymentCodeInvalidError();
    const cardRes = await c.query<{
      id: string;
      consumer_id: string;
      currency: string;
      status: string;
      funding_mode: 'wallet_first' | 'wallet_only' | 'credit_only';
      limit_per_tx: string | null;
      limit_daily: string | null;
      k_status: string;
    }>(
      `SELECT k.id, k.consumer_id, k.currency, k.status, k.funding_mode, k.limit_per_tx::text,
              k.limit_daily::text, cs.status AS k_status
         FROM cards k JOIN consumers cs ON cs.id = k.consumer_id
        WHERE k.id = $1 AND k.tenant_id = $2`,
      [cardId, tenantId]
    );
    const card = cardRes.rows[0];
    if (!card) throw new ResourceNotFoundError('Card');

    // Serializa autorizaciones del mismo cliente.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('card-auth:' || $1))`, [card.consumer_id]);

    const policy = await loadActivePolicy(c, tenantId);
    const expiresAt = new Date(Date.now() + policy.params.authorizationTtlHours * 3_600_000);
    const id = randomUUID();
    const base = {
      id,
      tenantId,
      consumerId: card.consumer_id,
      cardId: card.id,
      currency: input.currency,
      amount: input.amount,
      expiresAt,
      input,
      tokenId: token?.id ?? null,
    };

    try {
      // 3. Reglas de la tarjeta y el cliente.
      if (card.status === 'blocked') throw new DeclineSignal('card_blocked');
      if (card.status === 'closed' || card.status === 'replaced')
        throw new DeclineSignal('card_closed');
      if (card.status !== 'active') throw new DeclineSignal('card_inactive');
      if (card.k_status !== 'active') throw new DeclineSignal('consumer_inactive');
      if (card.currency.trim() !== input.currency)
        throw new DeclineSignal('currency_not_supported');
      if (token?.max_amount && input.amount > BigInt(token.max_amount)) {
        throw new DeclineSignal('amount_above_code_limit');
      }
      if (card.limit_per_tx && input.amount > BigInt(card.limit_per_tx)) {
        throw new DeclineSignal('card_limit_exceeded');
      }
      if (card.limit_daily) {
        const today = await c.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount - released_wallet - released_credit), 0)::text AS total
             FROM card_authorizations
            WHERE card_id = $1 AND status <> 'declined'
              AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          [card.id]
        );
        if (BigInt(today.rows[0]!.total) + input.amount > BigInt(card.limit_daily)) {
          throw new DeclineSignal('card_limit_exceeded');
        }
      }

      // 4. Reparto saldo propio / crédito.
      const line = await lockLine(c, tenantId, card.consumer_id, input.currency);
      const balances = await this.posting.consumerBalances(
        c,
        tenantId,
        card.consumer_id,
        input.currency
      );
      let creditAvailable = 0n;
      if (line && line.status === 'active') {
        creditAvailable = (await lineExposure(c, line.id)).available;
      }
      let walletPart: bigint;
      let creditPart: bigint;
      let installments: number | null = null;
      let terms: Record<string, unknown> | null = null;
      if (token?.mode === 'installments') {
        const offer = token.terms!;
        walletPart = downPaymentFor(input.amount, offer.downPaymentBps);
        creditPart = input.amount - walletPart;
        installments = offer.installmentsCount;
        terms = { ...offer, accepted_via: 'payment_code' };
        if (balances.available < walletPart) throw new DeclineSignal('insufficient_funds');
      } else if (token?.mode === 'wallet' || card.funding_mode === 'wallet_only') {
        walletPart = input.amount;
        creditPart = 0n;
        if (balances.available < walletPart) throw new DeclineSignal('insufficient_funds');
      } else if (card.funding_mode === 'credit_only') {
        walletPart = 0n;
        creditPart = input.amount;
      } else {
        walletPart = balances.available < input.amount ? balances.available : input.amount;
        if (walletPart < 0n) walletPart = 0n;
        creditPart = input.amount - walletPart;
      }
      if (creditPart > 0n) {
        if (!line || line.status !== 'active') throw new DeclineSignal('insufficient_funds');
        if (creditPart > creditAvailable) throw new DeclineSignal('credit_limit_exceeded');
        if (installments === null) {
          // Compra con tarjeta sin oferta de cuotas: el crédito se paga en una cuota.
          installments = 1;
          terms = {
            policy: {
              id: policy.id,
              code: policy.code,
              version: policy.version,
              pendingCommercialValidation: true,
            },
            installmentsCount: 1,
            intervalDays: policy.params.intervalDays,
            downPaymentBps: 0,
            interestBps: policy.params.interestBps,
            lateFeeBps: policy.params.lateFeeBps,
            accepted_via: 'card_terms',
          };
        }
      }

      // 5. Reservas: crédito (trigger del motor) y saldo propio (ledger).
      await c.query(
        `INSERT INTO card_authorizations
           (id, tenant_id, consumer_id, card_id, currency, amount, status, wallet_amount, credit_amount,
            credit_line_id, installments_count, terms, source, merchant_name, merchant_ref, network_ref,
            payment_token_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          id,
          tenantId,
          card.consumer_id,
          card.id,
          input.currency,
          input.amount.toString(),
          walletPart.toString(),
          creditPart.toString(),
          creditPart > 0n ? line!.id : null,
          creditPart > 0n ? installments : null,
          creditPart > 0n ? JSON.stringify(terms) : null,
          input.source,
          input.merchantName,
          input.merchantRef ?? null,
          input.networkRef,
          token?.id ?? null,
          expiresAt,
        ]
      );
      if (walletPart > 0n) {
        const hold = await this.posting.post(c, 'auth.hold', {
          tenantId,
          consumerId: card.consumer_id,
          amount: Money.of(walletPart, input.currency),
          idempotencyKey: `auth:${id}:hold`,
          source: { type: 'card_authorization', id },
        });
        await c.query(`UPDATE card_authorizations SET hold_ledger_tx_id = $2 WHERE id = $1`, [
          id,
          hold.transactionId,
        ]);
      }
      if (token) {
        await c.query(
          `UPDATE card_payment_tokens SET used_at = now(), authorization_id = $2 WHERE id = $1`,
          [token.id, id]
        );
      }
      await this.auditDecision(c, base, 'approved', null, walletPart, creditPart);
      const row = await this.load(c, tenantId, id);
      return {
        authorizationId: id,
        approved: true,
        declineCode: null,
        replayed: false,
        authorization: authDto(row),
      };
    } catch (err) {
      if (!(err instanceof DeclineSignal)) throw err;
      await c.query(
        `INSERT INTO card_authorizations
           (id, tenant_id, consumer_id, card_id, currency, amount, status, decline_code, source,
            merchant_name, merchant_ref, network_ref, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'declined', $7, $8, $9, $10, $11, now())`,
        [
          id,
          tenantId,
          card.consumer_id,
          card.id,
          input.currency,
          input.amount.toString(),
          err.code,
          input.source,
          input.merchantName,
          input.merchantRef ?? null,
          input.networkRef,
        ]
      );
      await this.auditDecision(c, base, 'declined', err.code, 0n, 0n);
      const row = await this.load(c, tenantId, id);
      return {
        authorizationId: id,
        approved: false,
        declineCode: err.code,
        replayed: false,
        authorization: authDto(row),
      };
    }
  }

  private async auditDecision(
    c: PoolClient,
    base: { id: string; tenantId: string; consumerId: string; input: AuthorizeInput },
    status: 'approved' | 'declined',
    code: string | null,
    wallet: bigint,
    credit: bigint
  ): Promise<void> {
    await insertAuditEvent(c, {
      action: 'card.authorization_decided',
      tenantId: base.tenantId,
      context: { actorType: 'system', authMethod: 'none' },
      resourceType: 'card_authorization',
      resourceId: base.id,
      result: status === 'approved' ? 'success' : 'failure',
      after: {
        status,
        decline_code: code,
        amount: base.input.amount.toString(),
        currency: base.input.currency,
        wallet: wallet.toString(),
        credit: credit.toString(),
        merchant: base.input.merchantName,
      },
    });
  }

  private async load(c: PoolClient, tenantId: string, id: string, lock = false): Promise<AuthRow> {
    const res = lock
      ? await c.query<AuthRow>(
          `SELECT * FROM card_authorizations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [id, tenantId]
        )
      : await c.query<AuthRow>(
          `SELECT * FROM card_authorizations WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId]
        );
    if (!res.rows[0]) throw new ResourceNotFoundError('Authorization');
    return res.rows[0];
  }

  private async priorEvent(
    c: PoolClient,
    tenantId: string,
    authorizationId: string,
    key: string,
    kind: string,
    amount: bigint | null
  ): Promise<boolean> {
    const res = await c.query<{ kind: string; amount: string }>(
      `SELECT kind, amount::text FROM card_authorization_events
        WHERE tenant_id = $1 AND authorization_id = $2 AND idempotency_key = $3`,
      [tenantId, authorizationId, key]
    );
    const r = res.rows[0];
    if (!r) return false;
    if (r.kind !== kind || (amount !== null && r.amount !== amount.toString())) {
      throw new InvalidStateError('authorization_event', 'idempotency_mismatch');
    }
    return true;
  }

  /**
   * Captura total o parcial (varias permitidas hasta lo autorizado). Se
   * consume primero la parte de saldo propio (la inicial) y luego el crédito.
   * La parte de crédito crea su plan de cuotas en la MISMA transacción.
   * `final` libera lo no capturado.
   */
  async capture(
    tenantId: string,
    authorizationId: string,
    input: { amount: bigint; idempotencyKey: string; final?: boolean }
  ): Promise<AuthorizationDto> {
    if (input.amount <= 0n) throw new AmountExceedsError('allowed range');
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const row = await this.load(c, tenantId, authorizationId, true);
      if (
        await this.priorEvent(
          c,
          tenantId,
          authorizationId,
          input.idempotencyKey,
          'capture',
          input.amount
        )
      ) {
        return this.dtoWithin(c, tenantId, authorizationId);
      }
      if (row.status !== 'approved' && row.status !== 'partially_captured') {
        throw new InvalidStateError('authorization', row.status);
      }
      const rem = remainingOf(row);
      if (input.amount > rem.wallet + rem.credit) throw new AmountExceedsError('authorized amount');
      const walletPart = input.amount < rem.wallet ? input.amount : rem.wallet;
      const creditPart = input.amount - walletPart;
      const currency = row.currency.trim();
      const eventId = randomUUID();
      let ledgerTx: string | null = null;
      if (walletPart > 0n) {
        const p = await this.posting.post(c, 'capture.wallet', {
          tenantId,
          consumerId: row.consumer_id,
          amount: Money.of(walletPart, currency),
          idempotencyKey: `auth:${row.id}:capture:${eventId}:wallet`,
          source: { type: 'card_authorization_event', id: eventId },
        });
        ledgerTx = p.transactionId;
      }
      if (creditPart > 0n) {
        const p = await this.posting.post(c, 'capture.credit', {
          tenantId,
          consumerId: row.consumer_id,
          amount: Money.of(creditPart, currency),
          idempotencyKey: `auth:${row.id}:capture:${eventId}:credit`,
          source: { type: 'card_authorization_event', id: eventId },
        });
        ledgerTx = p.transactionId;
      }
      await c.query(
        `INSERT INTO card_authorization_events
           (id, tenant_id, consumer_id, authorization_id, kind, amount, wallet_part, credit_part, idempotency_key, ledger_tx_id)
         VALUES ($1, $2, $3, $4, 'capture', $5, $6, $7, $8, $9)`,
        [
          eventId,
          tenantId,
          row.consumer_id,
          row.id,
          input.amount.toString(),
          walletPart.toString(),
          creditPart.toString(),
          input.idempotencyKey,
          ledgerTx,
        ]
      );
      const capturedWallet = toBig(row.captured_wallet) + walletPart;
      const capturedCredit = toBig(row.captured_credit) + creditPart;
      await c.query(
        `UPDATE card_authorizations SET captured_wallet = $2, captured_credit = $3, version = version + 1,
                updated_at = now() WHERE id = $1`,
        [row.id, capturedWallet.toString(), capturedCredit.toString()]
      );
      if (creditPart > 0n) {
        const terms = (row.terms ?? {}) as Partial<InstallmentOffer> & Record<string, unknown>;
        const policy = terms.policy?.id
          ? await loadPolicyById(c, terms.policy.id)
          : await loadActivePolicy(c, tenantId);
        // La inicial (saldo propio) de la compra entera se registra en el plan
        // de la captura que la consumió.
        await this.credit.createPlanWithin(c, {
          tenantId,
          consumerId: row.consumer_id,
          lineId: row.credit_line_id!,
          authorizationId: row.id,
          captureEventId: eventId,
          currency,
          principal: creditPart,
          downPayment: walletPart,
          installmentsCount: row.installments_count ?? 1,
          intervalDays: terms.intervalDays ?? policy.params.intervalDays,
          interestBps: terms.interestBps ?? policy.params.interestBps,
          policyId: policy.id,
          terms,
          merchantName: row.merchant_name,
          startDate: new Date(),
        });
      }
      await insertAuditEvent(c, {
        action: 'card.captured',
        tenantId,
        context: { actorType: 'system', authMethod: 'none' },
        resourceType: 'card_authorization',
        resourceId: row.id,
        after: {
          amount: input.amount.toString(),
          wallet: walletPart.toString(),
          credit: creditPart.toString(),
        },
      });
      if (input.final) {
        await this.releaseWithin(
          c,
          tenantId,
          row.id,
          null,
          `${input.idempotencyKey}:final`,
          'reverse'
        );
      }
      await this.settleStatus(c, row.id);
      return this.dtoWithin(c, tenantId, authorizationId);
    });
  }

  /** Reverso (total o parcial) de lo autorizado y no capturado. */
  async reverse(
    tenantId: string,
    authorizationId: string,
    input: { amount?: bigint; idempotencyKey: string }
  ): Promise<AuthorizationDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      await this.load(c, tenantId, authorizationId, true);
      await this.releaseWithin(
        c,
        tenantId,
        authorizationId,
        input.amount ?? null,
        input.idempotencyKey,
        'reverse'
      );
      await this.settleStatus(c, authorizationId);
      return this.dtoWithin(c, tenantId, authorizationId);
    });
  }

  /** Expira autorizaciones vivas vencidas (proceso explícito con fecha de corte). */
  async expireStale(tenantId: string, asOf: Date): Promise<{ expired: number }> {
    const ids = await withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{ id: string }>(
        `SELECT id FROM card_authorizations WHERE tenant_id = $1
           AND status IN ('approved', 'partially_captured') AND expires_at < $2 LIMIT 500`,
        [tenantId, asOf]
      );
      return res.rows.map((r) => r.id);
    });
    for (const id of ids) {
      await withProgramTx(this.appPool, tenantId, null, async (c) => {
        const row = await this.load(c, tenantId, id, true);
        if (row.status !== 'approved' && row.status !== 'partially_captured') return;
        await this.releaseWithin(
          c,
          tenantId,
          id,
          null,
          `expire:${asOf.toISOString().slice(0, 10)}`,
          'expire'
        );
        await this.settleStatus(c, id, true);
      });
    }
    return { expired: ids.length };
  }

  private async releaseWithin(
    c: PoolClient,
    tenantId: string,
    authorizationId: string,
    amount: bigint | null,
    key: string,
    kind: 'reverse' | 'expire'
  ): Promise<void> {
    const row = await this.load(c, tenantId, authorizationId);
    if (await this.priorEvent(c, tenantId, authorizationId, key, kind, amount)) return;
    if (row.status !== 'approved' && row.status !== 'partially_captured') {
      throw new InvalidStateError('authorization', row.status);
    }
    const rem = remainingOf(row);
    const total = rem.wallet + rem.credit;
    const want = amount ?? total;
    if (want <= 0n) return;
    if (want > total) throw new AmountExceedsError('outstanding authorization');
    // Se libera primero el crédito (deshace en orden inverso a la captura).
    const creditPart = want < rem.credit ? want : rem.credit;
    const walletPart = want - creditPart;
    const eventId = randomUUID();
    let ledgerTx: string | null = null;
    if (walletPart > 0n) {
      const p = await this.posting.post(c, 'auth.release', {
        tenantId,
        consumerId: row.consumer_id,
        amount: Money.of(walletPart, row.currency.trim()),
        idempotencyKey: `auth:${row.id}:release:${eventId}`,
        source: { type: 'card_authorization_event', id: eventId },
      });
      ledgerTx = p.transactionId;
    }
    await c.query(
      `INSERT INTO card_authorization_events
         (id, tenant_id, consumer_id, authorization_id, kind, amount, wallet_part, credit_part, idempotency_key, ledger_tx_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        eventId,
        tenantId,
        row.consumer_id,
        row.id,
        kind,
        want.toString(),
        walletPart.toString(),
        creditPart.toString(),
        key,
        ledgerTx,
      ]
    );
    await c.query(
      `UPDATE card_authorizations SET released_wallet = released_wallet + $2, released_credit = released_credit + $3,
              version = version + 1, updated_at = now() WHERE id = $1`,
      [row.id, walletPart.toString(), creditPart.toString()]
    );
    await insertAuditEvent(c, {
      action: 'card.reversed',
      tenantId,
      context: { actorType: 'system', authMethod: 'none' },
      resourceType: 'card_authorization',
      resourceId: row.id,
      after: { kind, amount: want.toString() },
    });
  }

  private async settleStatus(c: PoolClient, id: string, expired = false): Promise<void> {
    await c.query(
      `UPDATE card_authorizations SET status = CASE
          WHEN wallet_amount + credit_amount - captured_wallet - captured_credit - released_wallet - released_credit > 0
            THEN CASE WHEN captured_wallet + captured_credit > 0 THEN 'partially_captured' ELSE 'approved' END
          WHEN captured_wallet + captured_credit > 0 THEN 'captured'
          WHEN $2 THEN 'expired'
          ELSE 'reversed' END,
          updated_at = now()
        WHERE id = $1 AND status IN ('approved', 'partially_captured')`,
      [id, expired]
    );
  }

  /**
   * Devolución (parcial o total) de lo capturado. Se atribuye primero al
   * crédito: reduce la deuda (cuotas desde la última); lo que el cliente ya
   * hubiera pagado de esa parte vuelve como saldo propio. Luego, saldo propio.
   */
  async refund(
    tenantId: string,
    authorizationId: string,
    input: { amount: bigint; idempotencyKey: string }
  ): Promise<AuthorizationDto> {
    if (input.amount <= 0n) throw new AmountExceedsError('allowed range');
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const row = await this.load(c, tenantId, authorizationId, true);
      if (
        await this.priorEvent(
          c,
          tenantId,
          authorizationId,
          input.idempotencyKey,
          'refund',
          input.amount
        )
      ) {
        return this.dtoWithin(c, tenantId, authorizationId);
      }
      const refundableCredit = toBig(row.captured_credit) - toBig(row.refunded_credit);
      const refundableWallet = toBig(row.captured_wallet) - toBig(row.refunded_wallet);
      if (input.amount > refundableCredit + refundableWallet)
        throw new AmountExceedsError('captured amount');
      const creditAttr = input.amount < refundableCredit ? input.amount : refundableCredit;
      const walletAttr = input.amount - creditAttr;
      const currency = row.currency.trim();
      const eventId = randomUUID();
      let debtReduction = 0n;
      if (creditAttr > 0n) {
        debtReduction = await this.credit.reducePlansForRefundWithin(c, row.id, creditAttr);
      }
      const cashBack = walletAttr + (creditAttr - debtReduction);
      let ledgerTx: string | null = null;
      if (debtReduction > 0n) {
        const p = await this.posting.post(c, 'refund.credit', {
          tenantId,
          consumerId: row.consumer_id,
          amount: Money.of(debtReduction, currency),
          idempotencyKey: `auth:${row.id}:refund:${eventId}:credit`,
          source: { type: 'card_authorization_event', id: eventId },
        });
        ledgerTx = p.transactionId;
      }
      if (cashBack > 0n) {
        const p = await this.posting.post(c, 'refund.wallet', {
          tenantId,
          consumerId: row.consumer_id,
          amount: Money.of(cashBack, currency),
          idempotencyKey: `auth:${row.id}:refund:${eventId}:wallet`,
          source: { type: 'card_authorization_event', id: eventId },
        });
        ledgerTx = p.transactionId;
      }
      await c.query(
        `INSERT INTO card_authorization_events
           (id, tenant_id, consumer_id, authorization_id, kind, amount, wallet_part, credit_part, idempotency_key, ledger_tx_id)
         VALUES ($1, $2, $3, $4, 'refund', $5, $6, $7, $8, $9)`,
        [
          eventId,
          tenantId,
          row.consumer_id,
          row.id,
          input.amount.toString(),
          walletAttr.toString(),
          creditAttr.toString(),
          input.idempotencyKey,
          ledgerTx,
        ]
      );
      await c.query(
        `UPDATE card_authorizations SET refunded_wallet = refunded_wallet + $2, refunded_credit = refunded_credit + $3,
                version = version + 1, updated_at = now() WHERE id = $1`,
        [row.id, walletAttr.toString(), creditAttr.toString()]
      );
      await insertAuditEvent(c, {
        action: 'card.refunded',
        tenantId,
        context: { actorType: 'system', authMethod: 'none' },
        resourceType: 'card_authorization',
        resourceId: row.id,
        after: {
          amount: input.amount.toString(),
          debt_reduction: debtReduction.toString(),
          to_wallet: cashBack.toString(),
        },
      });
      return this.dtoWithin(c, tenantId, authorizationId);
    });
  }

  async dtoWithin(c: PoolClient, tenantId: string, id: string): Promise<AuthorizationDto> {
    const row = await this.load(c, tenantId, id);
    const ev = await c.query<{
      id: string;
      kind: AuthorizationEventDto['kind'];
      amount: string;
      wallet_part: string;
      credit_part: string;
      idempotency_key: string;
      created_at: Date;
    }>(
      `SELECT id, kind, amount::text, wallet_part::text, credit_part::text, idempotency_key, created_at
         FROM card_authorization_events WHERE authorization_id = $1 ORDER BY created_at, id`,
      [id]
    );
    return authDto(
      row,
      ev.rows.map((e) => ({
        id: e.id,
        kind: e.kind,
        amount: e.amount,
        walletPart: e.wallet_part,
        creditPart: e.credit_part,
        idempotencyKey: e.idempotency_key,
        createdAt: e.created_at.toISOString(),
      }))
    );
  }

  async get(tenantId: string, id: string, scope: string | null): Promise<AuthorizationDto> {
    return withProgramTx(this.appPool, tenantId, scope, (c) => this.dtoWithin(c, tenantId, id));
  }

  async findByNetworkRef(tenantId: string, networkRef: string): Promise<AuthorizationDto | null> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{ id: string }>(
        `SELECT id FROM card_authorizations WHERE tenant_id = $1 AND network_ref = $2`,
        [tenantId, networkRef]
      );
      return res.rows[0] ? this.dtoWithin(c, tenantId, res.rows[0].id) : null;
    });
  }

  async findEventByKey(
    tenantId: string,
    authorizationId: string | null,
    key: string
  ): Promise<AuthorizationEventDto | null> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{
        id: string;
        kind: AuthorizationEventDto['kind'];
        amount: string;
        wallet_part: string;
        credit_part: string;
        idempotency_key: string;
        created_at: Date;
      }>(
        `SELECT id, kind, amount::text, wallet_part::text, credit_part::text, idempotency_key, created_at
           FROM card_authorization_events
          WHERE tenant_id = $1 AND ($2::uuid IS NULL OR authorization_id = $2) AND idempotency_key = $3
          LIMIT 1`,
        [tenantId, authorizationId, key]
      );
      const e = res.rows[0];
      return e
        ? {
            id: e.id,
            kind: e.kind,
            amount: e.amount,
            walletPart: e.wallet_part,
            creditPart: e.credit_part,
            idempotencyKey: e.idempotency_key,
            createdAt: e.created_at.toISOString(),
          }
        : null;
    });
  }

  async list(
    tenantId: string,
    filter: { consumerId?: string; cardId?: string; status?: string },
    scope: string | null
  ): Promise<AuthorizationDto[]> {
    return withProgramTx(this.appPool, tenantId, scope, async (c) => {
      const res = await c.query<AuthRow>(
        `SELECT * FROM card_authorizations
          WHERE tenant_id = $1 AND ($2::uuid IS NULL OR consumer_id = $2)
            AND ($3::uuid IS NULL OR card_id = $3) AND ($4::text IS NULL OR status = $4)
          ORDER BY created_at DESC LIMIT 200`,
        [tenantId, filter.consumerId ?? null, filter.cardId ?? null, filter.status ?? null]
      );
      return res.rows.map((r) => authDto(r));
    });
  }
}
