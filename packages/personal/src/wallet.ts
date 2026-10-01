import type { Pool, PoolClient } from '@fluvia/db';
import { insertAuditEvent } from '@fluvia/audit';
import type { ProgramPostingService } from '@fluvia/ledger';
import { InsufficientBalanceError } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { randomUUID } from 'node:crypto';
import type { FundingProviderAdapter, ProviderDecision } from './adapters.js';
import { autoResolveCase, openCase } from './cases.js';
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
  ConsumerNotActiveError,
  ConsumerNotFoundError,
  IdempotencyMismatchError,
  InsufficientFundsError,
  ResourceNotFoundError,
} from './errors.js';
import { assertProgramCurrency } from './program.js';

const MAX_MINOR = 9_007_199_254_740_991n;

export interface FundingDto {
  id: string;
  consumerId: string;
  currency: string;
  amount: string;
  method: string;
  provider: string;
  providerRef: string;
  reference: string;
  status: 'pending' | 'confirmed' | 'failed';
  failureCode: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TransferDto {
  id: string;
  consumerId: string;
  kind: 'p2p' | 'withdrawal';
  direction: 'out' | 'in';
  counterpartyConsumerId: string | null;
  destinationMasked: string | null;
  currency: string;
  amount: string;
  status: 'processing' | 'completed' | 'failed' | 'indeterminate';
  failureCode: string | null;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CurrencyBalances {
  currency: string;
  /** Dinero propio disponible. */
  available: string;
  /** Dinero propio reservado (autorizaciones y retiros en curso). */
  held: string;
  /** Dinero propio bloqueado como garantía. */
  collateral: string;
  /** Deuda con el programa (crédito dispuesto). NUNCA es dinero propio. */
  debt: string;
  credit: {
    lineId: string;
    status: string;
    approvedLimit: string;
    utilized: string;
    reserved: string;
    available: string;
  } | null;
}

export interface StatementLine {
  entryId: string;
  transactionId: string;
  createdAt: string;
  account: 'available' | 'held' | 'collateral' | 'debt';
  direction: 'in' | 'out';
  amount: string;
  currency: string;
  reason: string;
  sourceType: string;
  sourceId: string;
  description: string;
}

interface FundingRow {
  id: string;
  consumer_id: string;
  currency: string;
  amount: string;
  method: string;
  provider: string;
  provider_ref: string;
  status: FundingDto['status'];
  failure_code: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function fundingDto(r: FundingRow): FundingDto {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    currency: r.currency.trim(),
    amount: String(r.amount),
    method: r.method,
    provider: r.provider,
    providerRef: r.provider_ref,
    reference: r.provider_ref.slice(-10).toUpperCase(),
    status: r.status,
    failureCode: r.failure_code,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at?.toISOString() ?? null,
  };
}

interface TransferRow {
  id: string;
  consumer_id: string;
  kind: 'p2p' | 'withdrawal';
  counterparty_consumer_id: string | null;
  destination_masked: string | null;
  currency: string;
  amount: string;
  status: TransferDto['status'];
  failure_code: string | null;
  note: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function transferDto(r: TransferRow, viewer?: string): TransferDto {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    kind: r.kind,
    direction: viewer && r.consumer_id !== viewer ? 'in' : 'out',
    counterpartyConsumerId: r.counterparty_consumer_id,
    destinationMasked: r.destination_masked,
    currency: r.currency.trim(),
    amount: String(r.amount),
    status: r.status,
    failureCode: r.failure_code,
    note: r.note,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at?.toISOString() ?? null,
  };
}

export function assertAmount(amount: bigint): void {
  if (amount <= 0n || amount > MAX_MINOR) throw new AmountExceedsError('allowed range');
}

/** Cliente activo, bajo lock compartido (evita operar mientras se suspende). */
export async function assertConsumerActive(
  c: PoolClient,
  tenantId: string,
  consumerId: string
): Promise<{ email: string; displayName: string; profile: string }> {
  const res = await c.query<{
    status: string;
    email: string;
    display_name: string;
    synthetic_risk_profile: string;
  }>(
    `SELECT status, email, display_name, synthetic_risk_profile FROM consumers
      WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
    [consumerId, tenantId]
  );
  const r = res.rows[0];
  if (!r) throw new ConsumerNotFoundError();
  if (r.status !== 'active') throw new ConsumerNotActiveError();
  return { email: r.email, displayName: r.display_name, profile: r.synthetic_risk_profile };
}

function maskDestination(destination: string): string {
  if (destination.startsWith('sim:')) return destination;
  const tail = destination.replace(/\s+/g, '').slice(-4);
  return `•••• ${tail}`;
}

/** Traduce el guard del ledger a un error de dominio. */
export function mapLedgerFunds(err: unknown): never {
  if (err instanceof InsufficientBalanceError) throw new InsufficientFundsError();
  throw err;
}

export class WalletService {
  constructor(
    private readonly appPool: Pool,
    private readonly posting: ProgramPostingService,
    private readonly funding: FundingProviderAdapter
  ) {}

  /** Instrucción de ingreso (pendiente hasta que el proveedor la confirme). */
  async requestFunding(
    tenantId: string,
    consumerId: string,
    input: {
      amount: bigint;
      currency: string;
      method: 'bank_transfer' | 'mobile_payment' | 'cash_agent';
      clientKey: string;
    },
    actor: ProgramActor
  ): Promise<{ funding: FundingDto; instructions: { reference: string; text: string } }> {
    assertAmount(input.amount);
    const existing = await this.findFundingByKey(tenantId, consumerId, input.clientKey);
    if (existing) {
      if (
        existing.amount !== input.amount.toString() ||
        existing.currency !== input.currency ||
        existing.method !== input.method
      ) {
        throw new IdempotencyMismatchError();
      }
      return {
        funding: existing,
        instructions: {
          reference: existing.reference,
          text: 'Instrucción ya emitida (reintento idempotente).',
        },
      };
    }
    const fundingId = randomUUID();
    const instruction = await this.funding.createFundingInstruction({
      fundingId,
      amount: input.amount.toString(),
      currency: input.currency,
      method: input.method,
    });
    try {
      const funding = await withProgramTx(
        this.appPool,
        tenantId,
        consumerScope(actor),
        async (c) => {
          await assertProgramCurrency(c, tenantId, input.currency);
          await assertConsumerActive(c, tenantId, consumerId);
          const res = await c.query<FundingRow>(
            `INSERT INTO wallet_fundings
             (id, tenant_id, consumer_id, currency, amount, method, provider, provider_ref, client_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
              fundingId,
              tenantId,
              consumerId,
              input.currency,
              input.amount.toString(),
              input.method,
              this.funding.name,
              instruction.providerRef,
              input.clientKey,
            ]
          );
          await insertAuditEvent(c, {
            action: 'wallet.funding_requested',
            tenantId,
            context: auditContextOf(actor),
            resourceType: 'wallet_funding',
            resourceId: fundingId,
            after: { amount: input.amount.toString(), currency: input.currency },
          });
          return fundingDto(res.rows[0]!);
        }
      );
      return { funding, instructions: instruction.instructions };
    } catch (err) {
      if (isUniqueViolation(err)) {
        const again = await this.findFundingByKey(tenantId, consumerId, input.clientKey);
        if (again) return this.requestFunding(tenantId, consumerId, input, actor);
      }
      throw err;
    }
  }

  private async findFundingByKey(
    tenantId: string,
    consumerId: string,
    clientKey: string
  ): Promise<FundingDto | null> {
    return withProgramTx(this.appPool, tenantId, consumerId, async (c) => {
      const res = await c.query<FundingRow>(
        `SELECT * FROM wallet_fundings WHERE tenant_id = $1 AND consumer_id = $2 AND client_key = $3`,
        [tenantId, consumerId, clientKey]
      );
      return res.rows[0] ? fundingDto(res.rows[0]) : null;
    });
  }

  /**
   * Aplica la confirmación/fallo de un ingreso DENTRO de la transacción del
   * procesador de eventos. Idempotente: el asiento usa clave por ingreso y un
   * ingreso ya resuelto no vuelve a acreditar (eventos duplicados con otro id
   * o fuera de orden ⇒ `ignored_out_of_order`).
   */
  async applyFundingResult(
    c: PoolClient,
    tenantId: string,
    input: {
      providerRef: string;
      result: 'confirmed' | 'failed';
      amount?: bigint;
      currency?: string;
      failureCode?: string;
    }
  ): Promise<'applied' | 'ignored_out_of_order' | 'unmatched'> {
    const res = await c.query<FundingRow>(
      `SELECT * FROM wallet_fundings WHERE tenant_id = $1 AND provider_ref = $2 FOR UPDATE`,
      [tenantId, input.providerRef]
    );
    const row = res.rows[0];
    if (!row) return 'unmatched';
    if (row.status !== 'pending') return 'ignored_out_of_order';
    const currency = row.currency.trim();
    if (input.result === 'confirmed') {
      if (
        (input.amount !== undefined && input.amount !== toBig(row.amount)) ||
        (input.currency !== undefined && input.currency !== currency)
      ) {
        // El banco dice otro importe/moneda: no se acredita por suposición.
        return 'unmatched';
      }
      const posted = await this.posting.post(c, 'funding.confirm', {
        tenantId,
        consumerId: row.consumer_id,
        amount: Money.of(row.amount, currency),
        idempotencyKey: `funding:${row.id}:confirm`,
        source: { type: 'wallet_funding', id: row.id },
      });
      await c.query(
        `UPDATE wallet_fundings SET status = 'confirmed', ledger_tx_id = $2, resolved_at = now()
          WHERE id = $1`,
        [row.id, posted.transactionId]
      );
      await insertAuditEvent(c, {
        action: 'wallet.funding_confirmed',
        tenantId,
        context: { actorType: 'system', authMethod: 'none' },
        resourceType: 'wallet_funding',
        resourceId: row.id,
        after: { amount: String(row.amount), currency },
      });
    } else {
      await c.query(
        `UPDATE wallet_fundings SET status = 'failed', failure_code = $2, resolved_at = now()
          WHERE id = $1`,
        [row.id, input.failureCode ?? 'funding_failed']
      );
      await insertAuditEvent(c, {
        action: 'wallet.funding_failed',
        tenantId,
        context: { actorType: 'system', authMethod: 'none' },
        resourceType: 'wallet_funding',
        resourceId: row.id,
        result: 'failure',
      });
    }
    return 'applied';
  }

  async listFundings(tenantId: string, consumerId: string): Promise<FundingDto[]> {
    return withProgramTx(this.appPool, tenantId, consumerId, async (c) => {
      const res = await c.query<FundingRow>(
        `SELECT * FROM wallet_fundings WHERE tenant_id = $1 AND consumer_id = $2
          ORDER BY created_at DESC LIMIT 100`,
        [tenantId, consumerId]
      );
      return res.rows.map(fundingDto);
    });
  }

  /** Transferencia entre clientes del programa (misma moneda; atómica). */
  async transferP2P(
    tenantId: string,
    consumerId: string,
    input: { toEmail: string; amount: bigint; currency: string; note?: string; clientKey: string },
    actor: ProgramActor
  ): Promise<TransferDto> {
    assertAmount(input.amount);
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const prior = await c.query<TransferRow>(
        `SELECT * FROM wallet_transfers WHERE tenant_id = $1 AND consumer_id = $2 AND client_key = $3`,
        [tenantId, consumerId, input.clientKey]
      );
      if (prior.rows[0]) {
        const p = prior.rows[0];
        if (String(p.amount) !== input.amount.toString() || p.currency.trim() !== input.currency) {
          throw new IdempotencyMismatchError();
        }
        return transferDto(p, consumerId);
      }
      await assertProgramCurrency(c, tenantId, input.currency);
      await assertConsumerActive(c, tenantId, consumerId);
      const dest = await c.query<{ id: string; status: string }>(
        `SELECT id, status FROM consumers WHERE tenant_id = $1 AND email = $2`,
        [tenantId, input.toEmail.trim().toLowerCase()]
      );
      const to = dest.rows[0];
      if (!to || to.id === consumerId) throw new ConsumerNotFoundError();
      if (to.status !== 'active') throw new ConsumerNotActiveError();
      const id = randomUUID();
      const posted = await this.posting
        .post(c, 'transfer.p2p', {
          tenantId,
          consumerId,
          counterpartyConsumerId: to.id,
          amount: Money.of(input.amount, input.currency),
          idempotencyKey: `transfer:${id}`,
          source: { type: 'wallet_transfer', id },
        })
        .catch(mapLedgerFunds);
      const res = await c.query<TransferRow>(
        `INSERT INTO wallet_transfers
           (id, tenant_id, consumer_id, kind, counterparty_consumer_id, currency, amount, status,
            provider_ref, note, client_key, resolved_at)
         VALUES ($1, $2, $3, 'p2p', $4, $5, $6, 'completed', $7, $8, $9, now()) RETURNING *`,
        [
          id,
          tenantId,
          consumerId,
          to.id,
          input.currency,
          input.amount.toString(),
          posted.transactionId,
          input.note ?? null,
          input.clientKey,
        ]
      );
      await insertAuditEvent(c, {
        action: 'wallet.transfer_completed',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'wallet_transfer',
        resourceId: id,
        after: { amount: input.amount.toString(), currency: input.currency, to: to.id },
      });
      return transferDto(res.rows[0]!, consumerId);
    });
  }

  /**
   * Retiro a una cuenta externa en tres fases (como payouts):
   *  1. tx: fondos a «en tránsito» + registro `processing`;
   *  2. FUERA de tx: el proveedor;
   *  3. tx: liquidar, devolver o dejar `indeterminate` con caso abierto. Un
   *     incierto CONSERVA la reserva hasta resolución verificada.
   */
  async withdraw(
    tenantId: string,
    consumerId: string,
    input: { amount: bigint; currency: string; destination: string; clientKey: string },
    actor: ProgramActor
  ): Promise<TransferDto> {
    assertAmount(input.amount);
    const phase1 = await withProgramTx(this.appPool, tenantId, consumerScope(actor), async (c) => {
      const prior = await c.query<TransferRow>(
        `SELECT * FROM wallet_transfers WHERE tenant_id = $1 AND consumer_id = $2 AND client_key = $3`,
        [tenantId, consumerId, input.clientKey]
      );
      if (prior.rows[0]) {
        const p = prior.rows[0];
        if (String(p.amount) !== input.amount.toString() || p.currency.trim() !== input.currency) {
          throw new IdempotencyMismatchError();
        }
        return { row: p, fresh: false };
      }
      await assertProgramCurrency(c, tenantId, input.currency);
      await assertConsumerActive(c, tenantId, consumerId);
      const id = randomUUID();
      await this.posting
        .post(c, 'withdrawal.emit', {
          tenantId,
          consumerId,
          amount: Money.of(input.amount, input.currency),
          idempotencyKey: `withdrawal:${id}:emit`,
          source: { type: 'wallet_transfer', id },
        })
        .catch(mapLedgerFunds);
      const res = await c.query<TransferRow>(
        `INSERT INTO wallet_transfers
           (id, tenant_id, consumer_id, kind, destination_masked, currency, amount, status, client_key)
         VALUES ($1, $2, $3, 'withdrawal', $4, $5, $6, 'processing', $7) RETURNING *`,
        [
          id,
          tenantId,
          consumerId,
          maskDestination(input.destination),
          input.currency,
          input.amount.toString(),
          input.clientKey,
        ]
      );
      await insertAuditEvent(c, {
        action: 'wallet.withdrawal_requested',
        tenantId,
        context: auditContextOf(actor),
        resourceType: 'wallet_transfer',
        resourceId: id,
        after: { amount: input.amount.toString(), currency: input.currency },
      });
      return { row: res.rows[0]!, fresh: true };
    });
    if (!phase1.fresh) return transferDto(phase1.row, consumerId);
    const id = phase1.row.id;
    let decision: ProviderDecision | null = null;
    try {
      decision = await this.funding.submitWithdrawal({
        transferId: id,
        amount: input.amount.toString(),
        currency: input.currency,
        destination: input.destination,
      });
    } catch {
      decision = null;
    }
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      if (decision === null) {
        await this.markWithdrawalUncertain(c, tenantId, id, consumerId);
      } else if (decision.outcome !== 'pending') {
        await this.applyWithdrawalOutcome(c, tenantId, id, decision);
      }
      const res = await c.query<TransferRow>(`SELECT * FROM wallet_transfers WHERE id = $1`, [id]);
      return transferDto(res.rows[0]!, consumerId);
    });
  }

  private async markWithdrawalUncertain(
    c: PoolClient,
    tenantId: string,
    id: string,
    consumerId: string
  ): Promise<void> {
    await c.query(
      `UPDATE wallet_transfers SET status = 'indeterminate' WHERE id = $1 AND status = 'processing'`,
      [id]
    );
    await openCase(c, {
      tenantId,
      consumerId,
      caseType: 'uncertain_withdrawal',
      severity: 'high',
      subjectType: 'wallet_transfer',
      subjectId: id,
      summary: 'Retiro sin respuesta del proveedor: fondos retenidos hasta resultado verificado.',
    });
  }

  /**
   * Aplica un resultado VERIFICADO (respuesta, consulta o evento) de un retiro.
   * Idempotente: un retiro ya terminal ignora resultados tardíos.
   */
  async applyWithdrawalOutcome(
    c: PoolClient,
    tenantId: string,
    transferId: string,
    decision: ProviderDecision
  ): Promise<'applied' | 'ignored_out_of_order' | 'unmatched'> {
    const res = await c.query<TransferRow>(
      `SELECT * FROM wallet_transfers WHERE id = $1 AND tenant_id = $2 AND kind = 'withdrawal' FOR UPDATE`,
      [transferId, tenantId]
    );
    const row = res.rows[0];
    if (!row) return 'unmatched';
    if (row.status === 'completed' || row.status === 'failed') return 'ignored_out_of_order';
    if (decision.outcome === 'pending') return 'ignored_out_of_order';
    const amount = Money.of(row.amount, row.currency.trim());
    const ok = decision.outcome === 'approved';
    await this.posting.post(c, ok ? 'withdrawal.settle' : 'withdrawal.fail', {
      tenantId,
      consumerId: row.consumer_id,
      amount,
      idempotencyKey: `withdrawal:${row.id}:${ok ? 'settle' : 'fail'}`,
      source: { type: 'wallet_transfer', id: row.id },
    });
    await c.query(
      `UPDATE wallet_transfers SET status = $2, provider_ref = $3, failure_code = $4, resolved_at = now()
        WHERE id = $1`,
      [
        row.id,
        ok ? 'completed' : 'failed',
        decision.providerRef,
        ok ? null : (decision.failureCode ?? 'withdrawal_failed'),
      ]
    );
    await autoResolveCase(
      c,
      tenantId,
      'uncertain_withdrawal',
      'wallet_transfer',
      row.id,
      `Resultado verificado del proveedor: ${ok ? 'pagado' : 'rechazado'}.`
    );
    await insertAuditEvent(c, {
      action: 'wallet.withdrawal_resolved',
      tenantId,
      context: { actorType: 'system', authMethod: 'none' },
      resourceType: 'wallet_transfer',
      resourceId: row.id,
      after: { outcome: decision.outcome },
    });
    return 'applied';
  }

  /**
   * Resuelve retiros inciertos consultando al proveedor (fuente verificada).
   * Si el proveedor no conoce la operación, el caso sigue abierto: no se
   * presume ni pagado ni fallido.
   */
  async resolveUncertainWithdrawals(
    tenantId: string
  ): Promise<{ resolved: number; stillUncertain: number }> {
    const pending = await withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<{ id: string }>(
        `SELECT id FROM wallet_transfers WHERE tenant_id = $1 AND kind = 'withdrawal'
           AND status IN ('indeterminate', 'processing') ORDER BY created_at LIMIT 100`,
        [tenantId]
      );
      return res.rows.map((r) => r.id);
    });
    let resolved = 0;
    let still = 0;
    for (const id of pending) {
      const decision = await this.funding.queryWithdrawal(id).catch(() => null);
      if (!decision || decision.outcome === 'pending') {
        still++;
        continue;
      }
      const out = await withProgramTx(this.appPool, tenantId, null, (c) =>
        this.applyWithdrawalOutcome(c, tenantId, id, decision)
      );
      if (out === 'applied') resolved++;
    }
    return { resolved, stillUncertain: still };
  }

  async listTransfers(tenantId: string, consumerId: string): Promise<TransferDto[]> {
    return withProgramTx(this.appPool, tenantId, consumerId, async (c) => {
      const res = await c.query<TransferRow>(
        `SELECT * FROM wallet_transfers
          WHERE tenant_id = $1 AND (consumer_id = $2 OR counterparty_consumer_id = $2)
          ORDER BY created_at DESC LIMIT 100`,
        [tenantId, consumerId]
      );
      return res.rows.map((r) => transferDto(r, consumerId));
    });
  }

  async getTransfer(tenantId: string, transferId: string): Promise<TransferDto> {
    return withProgramTx(this.appPool, tenantId, null, async (c) => {
      const res = await c.query<TransferRow>(
        `SELECT * FROM wallet_transfers WHERE id = $1 AND tenant_id = $2`,
        [transferId, tenantId]
      );
      if (!res.rows[0]) throw new ResourceNotFoundError('Transfer');
      return transferDto(res.rows[0]);
    });
  }

  /** Saldos por moneda desde el LEDGER + disponibilidad de crédito del servidor. */
  async balances(
    tenantId: string,
    consumerId: string,
    scope: string | null = consumerId
  ): Promise<CurrencyBalances[]> {
    return withProgramTx(this.appPool, tenantId, scope, async (c) => {
      const prog = await c.query<{ currencies: string[] }>(
        `SELECT currencies FROM consumer_programs WHERE tenant_id = $1`,
        [tenantId]
      );
      const currencies = prog.rows[0]?.currencies ?? [];
      const lines = await c.query<{
        line_id: string;
        currency: string;
        status: string;
        approved_limit: string;
        utilized: string;
        reserved: string;
        available: string;
      }>(
        `SELECT line_id, currency, status, approved_limit::text, utilized::text, reserved::text,
                available::text
           FROM credit_line_availability WHERE tenant_id = $1 AND consumer_id = $2`,
        [tenantId, consumerId]
      );
      const out: CurrencyBalances[] = [];
      for (const ccy of currencies) {
        const b = await this.posting.consumerBalances(c, tenantId, consumerId, ccy);
        const l = lines.rows.find((r) => r.currency.trim() === ccy);
        out.push({
          currency: ccy,
          available: b.available.toString(),
          held: b.held.toString(),
          collateral: b.collateral.toString(),
          debt: b.debt.toString(),
          credit: l
            ? {
                lineId: l.line_id,
                status: l.status,
                approvedLimit: l.approved_limit,
                utilized: l.utilized,
                reserved: l.reserved,
                available: l.status === 'active' ? l.available : '0',
              }
            : null,
        });
      }
      return out;
    });
  }

  /** Extracto: movimientos del ledger de las cuentas del cliente. */
  async statement(
    tenantId: string,
    consumerId: string,
    currency: string,
    opts: { limit?: number; before?: string; scope?: string | null } = {}
  ): Promise<StatementLine[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return withProgramTx(
      this.appPool,
      tenantId,
      opts.scope === undefined ? consumerId : opts.scope,
      async (c) => {
        const names = {
          [`consumer.wallet.available:${consumerId}`]: 'available',
          [`consumer.wallet.held:${consumerId}`]: 'held',
          [`consumer.collateral:${consumerId}`]: 'collateral',
          [`consumer.credit.receivable:${consumerId}`]: 'debt',
        } as const;
        const res = await c.query<{
          entry_id: string;
          tx_id: string;
          created_at: Date;
          name: string;
          normal_side: string;
          direction: string;
          amount: string;
          currency: string;
          reason: string;
          source_type: string;
          source_id: string;
        }>(
          `SELECT e.id::text AS entry_id, t.id AS tx_id, t.created_at, a.name, a.normal_side,
                  e.direction, e.amount::text, e.currency, t.reason, t.source_type, t.source_id
             FROM ledger_entries e
             JOIN ledger_accounts a ON a.id = e.account_id
             JOIN ledger_transactions t ON t.id = e.tx_root_id
            WHERE a.tenant_id = $1 AND a.currency = $2 AND a.name = ANY($3::text[])
              AND ($4::timestamptz IS NULL OR t.created_at < $4)
            ORDER BY t.created_at DESC, e.id DESC
            LIMIT $5`,
          [tenantId, currency, Object.keys(names), opts.before ?? null, limit]
        );
        return res.rows.map((r) => {
          const account = names[r.name as keyof typeof names] as StatementLine['account'];
          const increases = r.direction === r.normal_side;
          return {
            entryId: r.entry_id,
            transactionId: r.tx_id,
            createdAt: r.created_at.toISOString(),
            account,
            direction: increases ? 'in' : 'out',
            amount: r.amount,
            currency: r.currency.trim(),
            reason: r.reason,
            sourceType: r.source_type,
            sourceId: r.source_id,
            description: describe(r.reason, r.source_type, account, increases),
          };
        });
      }
    );
  }
}

function describe(reason: string, sourceType: string, account: string, increases: boolean): string {
  if (sourceType === 'wallet_funding') return 'Ingreso de fondos';
  if (sourceType === 'wallet_transfer' && reason === 'transfer')
    return increases ? 'Transferencia recibida' : 'Transferencia enviada';
  if (reason === 'withdrawal')
    return account === 'available' && increases ? 'Retiro devuelto' : 'Retiro a cuenta bancaria';
  if (reason === 'collateral') {
    if (account === 'debt') return 'Garantía aplicada a deuda';
    if (account === 'collateral')
      return increases ? 'Garantía bloqueada' : 'Garantía liberada o aplicada';
    return increases ? 'Garantía liberada' : 'Garantía bloqueada';
  }
  if (reason === 'card') {
    if (account === 'held') return increases ? 'Reserva por compra' : 'Reserva usada o liberada';
    return increases ? 'Devolución o reserva liberada' : 'Compra con saldo propio';
  }
  if (reason === 'credit')
    return increases ? 'Compra con crédito' : 'Devolución aplicada a la deuda';
  if (reason === 'repayment')
    return account === 'debt' ? 'Pago aplicado a la deuda' : 'Pago de cuota';
  return 'Movimiento';
}
