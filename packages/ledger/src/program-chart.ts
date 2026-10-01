import type { PoolClient } from '@fluvia/db';
import type { Money } from '@fluvia/money';
import type { AccountDefinition } from './chart-of-accounts.js';
import { InvalidEntriesError, UnknownAccountCodeError } from './errors.js';
import type { LedgerService } from './service.js';
import type { PostTransactionInput, PostedTransaction } from './types.js';

/**
 * Catálogo de cuentas del PROGRAMA de consumo (Fluvia Personal). Separado del
 * catálogo del comercio (`CHART_OF_ACCOUNTS`) para que `ensureChart` de un
 * comercio jamás aprovisione cuentas de cliente, y viceversa. Espejo en
 * docs/product/fluvia-integral/ESPECIFICACION.md §5.
 *
 * scope:
 *  - program:  una por (tenant programa, moneda); nombre = code.
 *  - consumer: una por (tenant, cliente, moneda); nombre = `${code}:${consumerId}`.
 */
export type ProgramAccountScope = 'program' | 'consumer';

export interface ProgramAccountDefinition extends Omit<AccountDefinition, 'scope'> {
  scope: ProgramAccountScope;
}

export const PROGRAM_CHART_OF_ACCOUNTS = {
  'consumer.wallet.available': { scope: 'consumer', type: 'liability', normalSide: 'credit' },
  'consumer.wallet.held': { scope: 'consumer', type: 'liability', normalSide: 'credit' },
  'consumer.collateral': { scope: 'consumer', type: 'liability', normalSide: 'credit' },
  'consumer.credit.receivable': { scope: 'consumer', type: 'asset', normalSide: 'debit' },
  'program.funding.clearing': { scope: 'program', type: 'asset', normalSide: 'debit' },
  'program.network.payable': { scope: 'program', type: 'liability', normalSide: 'credit' },
  'program.withdrawals.in_transit': { scope: 'program', type: 'liability', normalSide: 'credit' },
} as const satisfies Record<string, ProgramAccountDefinition>;

export type ProgramAccountCode = keyof typeof PROGRAM_CHART_OF_ACCOUNTS;
export const PROGRAM_ACCOUNT_CODES = Object.keys(PROGRAM_CHART_OF_ACCOUNTS) as ProgramAccountCode[];

export function programAccountName(code: ProgramAccountCode, consumerId: string): string {
  return PROGRAM_CHART_OF_ACCOUNTS[code].scope === 'consumer' ? `${code}:${consumerId}` : code;
}

export type ProgramAccounts = Record<ProgramAccountCode, string>;

/**
 * Operaciones tipadas del programa. Cada una es un asiento de dos patas sobre
 * el catálogo; lo que no está aquí es irrepresentable. Las cuentas que
 * DECRECEN se protegen con el guard de no negatividad (bajo lock, en el
 * motor del ledger), así que ninguna operación puede gastar más saldo propio,
 * garantía, reserva o deuda de la que existe.
 */
export const PROGRAM_POSTINGS = {
  'funding.confirm': ['program.funding.clearing', 'consumer.wallet.available', 'funding'],
  'transfer.p2p': ['consumer.wallet.available', 'consumer.wallet.available', 'transfer'],
  'withdrawal.emit': ['consumer.wallet.available', 'program.withdrawals.in_transit', 'withdrawal'],
  'withdrawal.settle': ['program.withdrawals.in_transit', 'program.funding.clearing', 'withdrawal'],
  'withdrawal.fail': ['program.withdrawals.in_transit', 'consumer.wallet.available', 'withdrawal'],
  'collateral.lock': ['consumer.wallet.available', 'consumer.collateral', 'collateral'],
  'collateral.release': ['consumer.collateral', 'consumer.wallet.available', 'collateral'],
  'collateral.apply': ['consumer.collateral', 'consumer.credit.receivable', 'collateral'],
  'auth.hold': ['consumer.wallet.available', 'consumer.wallet.held', 'card'],
  'auth.release': ['consumer.wallet.held', 'consumer.wallet.available', 'card'],
  'capture.wallet': ['consumer.wallet.held', 'program.network.payable', 'card'],
  'capture.credit': ['consumer.credit.receivable', 'program.network.payable', 'credit'],
  'refund.wallet': ['program.network.payable', 'consumer.wallet.available', 'card'],
  'refund.credit': ['program.network.payable', 'consumer.credit.receivable', 'credit'],
  repayment: ['consumer.wallet.available', 'consumer.credit.receivable', 'repayment'],
} as const satisfies Record<
  string,
  readonly [ProgramAccountCode, ProgramAccountCode, PostTransactionInput['reason']]
>;

export type ProgramPostingKind = keyof typeof PROGRAM_POSTINGS;

export interface ProgramPostingInput {
  tenantId: string;
  consumerId: string;
  /** Solo `transfer.p2p`: cliente que recibe. */
  counterpartyConsumerId?: string;
  amount: Money;
  idempotencyKey: string;
  source: { type: string; id: string };
}

export class ProgramPostingService {
  constructor(private readonly ledger: LedgerService) {}

  /** Aprovisiona (idempotente, DENTRO de la tx) las cuentas del cliente y del programa. */
  async ensureAccounts(
    c: PoolClient,
    tenantId: string,
    consumerId: string,
    currency: string
  ): Promise<ProgramAccounts> {
    const names = PROGRAM_ACCOUNT_CODES.map((code) => programAccountName(code, consumerId));
    const sides = PROGRAM_ACCOUNT_CODES.map((code) => PROGRAM_CHART_OF_ACCOUNTS[code].normalSide);
    await c.query(
      `INSERT INTO ledger_accounts (tenant_id, name, currency, normal_side)
       SELECT $1, n, $2, s FROM unnest($3::text[], $4::text[]) AS t(n, s)
       ON CONFLICT (tenant_id, name, currency) DO NOTHING`,
      [tenantId, currency, names, sides]
    );
    await c.query(
      `INSERT INTO balance_projections (account_id, tenant_id)
       SELECT id, tenant_id FROM ledger_accounts
       WHERE tenant_id = $1 AND currency = $2 AND name = ANY($3::text[])
       ON CONFLICT (account_id) DO NOTHING`,
      [tenantId, currency, names]
    );
    const res = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM ledger_accounts
       WHERE tenant_id = $1 AND currency = $2 AND name = ANY($3::text[]) AND deleted_at IS NULL`,
      [tenantId, currency, names]
    );
    const byName = new Map(res.rows.map((r) => [r.name, r.id]));
    const out = {} as ProgramAccounts;
    for (const code of PROGRAM_ACCOUNT_CODES) {
      const id = byName.get(programAccountName(code, consumerId));
      if (!id) throw new UnknownAccountCodeError(code);
      out[code] = id;
    }
    return out;
  }

  /** Asiento tipado DENTRO de la transacción del llamador. */
  async post(
    c: PoolClient,
    kind: ProgramPostingKind,
    input: ProgramPostingInput
  ): Promise<PostedTransaction> {
    if (!input.amount.isPositive()) {
      throw new InvalidEntriesError('Amount must be strictly positive');
    }
    const [debitCode, creditCode, reason] = PROGRAM_POSTINGS[kind];
    const currency = input.amount.currency;
    const own = await this.ensureAccounts(c, input.tenantId, input.consumerId, currency);
    const debitId = own[debitCode];
    let creditId = own[creditCode];
    if (kind === 'transfer.p2p') {
      if (!input.counterpartyConsumerId || input.counterpartyConsumerId === input.consumerId) {
        throw new InvalidEntriesError('transfer.p2p requires a distinct counterparty');
      }
      const other = await this.ensureAccounts(
        c,
        input.tenantId,
        input.counterpartyConsumerId,
        currency
      );
      creditId = other['consumer.wallet.available'];
    }
    const guarded: string[] = [];
    if (PROGRAM_CHART_OF_ACCOUNTS[debitCode].normalSide === 'credit') guarded.push(debitId);
    if (PROGRAM_CHART_OF_ACCOUNTS[creditCode].normalSide === 'debit') guarded.push(creditId);
    if (debitId === creditId) {
      // Imposible por catálogo; defensa explícita.
      throw new InvalidEntriesError('debit and credit accounts must differ');
    }
    return this.ledger.postWithin(c, {
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      reason,
      source: input.source,
      entries: [
        { accountId: debitId, direction: 'debit', amount: input.amount },
        { accountId: creditId, direction: 'credit', amount: input.amount },
      ],
      nonNegativeAccounts: guarded,
    });
  }

  /**
   * Saldos del cliente en una moneda, leídos de las proyecciones del ledger
   * (verificables contra el recomputo con `verifyProjection`).
   */
  async consumerBalances(
    c: PoolClient,
    tenantId: string,
    consumerId: string,
    currency: string
  ): Promise<{ available: bigint; held: bigint; collateral: bigint; debt: bigint }> {
    const names = [
      'consumer.wallet.available',
      'consumer.wallet.held',
      'consumer.collateral',
      'consumer.credit.receivable',
    ].map((code) => `${code}:${consumerId}`);
    const res = await c.query<{ name: string; available: string }>(
      `SELECT a.name, p.available::text
         FROM ledger_accounts a JOIN balance_projections p ON p.account_id = a.id
        WHERE a.tenant_id = $1 AND a.currency = $2 AND a.name = ANY($3::text[])`,
      [tenantId, currency, names]
    );
    const get = (code: string): bigint => {
      const row = res.rows.find((r) => r.name === `${code}:${consumerId}`);
      return row ? BigInt(row.available) : 0n;
    };
    return {
      available: get('consumer.wallet.available'),
      held: get('consumer.wallet.held'),
      collateral: get('consumer.collateral'),
      debt: get('consumer.credit.receivable'),
    };
  }
}
