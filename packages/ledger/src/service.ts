import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import {
  AccountCurrencyMismatchError,
  AccountNotFoundError,
  IdempotencyConflictError,
  InsufficientBalanceError,
  InvalidEntriesError,
  LedgerAccountExistsError,
  LedgerRetriesExhaustedError,
  OptimisticLockError,
  UnbalancedLedgerError,
} from './errors.js';
import {
  LEDGER_REASONS,
  type BalanceDto,
  type CreateAccountInput,
  type LedgerAccountDto,
  type LedgerEntryInput,
  type PostTransactionInput,
  type PostedEntry,
  type PostedTransaction,
  type ProjectionVerification,
} from './types.js';

interface LockedAccount {
  id: string;
  currency: string;
  normal_side: 'debit' | 'credit';
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']); // serialization / deadlock

function isRetryable(err: unknown): boolean {
  return (
    err instanceof OptimisticLockError ||
    RETRYABLE_SQLSTATES.has((err as { code?: string })?.code ?? '')
  );
}

/** Firma canonica de un conjunto de asientos para comparar replays. */
function entriesSignature(
  entries: Array<{
    accountId: string;
    direction: string;
    amount: string;
    currency: string;
    bucket: string;
  }>
): string {
  return entries
    .map((e) => `${e.accountId}|${e.direction}|${e.amount}|${e.currency}|${e.bucket}`)
    .sort()
    .join('\n');
}

function validateInput(input: PostTransactionInput): void {
  if (!LEDGER_REASONS.includes(input.reason)) {
    throw new InvalidEntriesError(`Unknown ledger reason: ${input.reason}`);
  }
  if (
    !input.idempotencyKey ||
    input.idempotencyKey.length < 8 ||
    input.idempotencyKey.length > 200
  ) {
    throw new InvalidEntriesError('idempotencyKey must be 8-200 characters');
  }
  if (!input.source?.type || !input.source?.id) {
    throw new InvalidEntriesError('source.type and source.id are required (causal link)');
  }
  if (input.entries.length < 2) {
    throw new InvalidEntriesError('A ledger transaction requires at least two entries');
  }
  const net = new Map<string, bigint>();
  for (const e of input.entries) {
    if (!e.amount.isPositive()) {
      throw new InvalidEntriesError('Entry amounts must be strictly positive');
    }
    const sign = e.direction === 'debit' ? e.amount.amount : -e.amount.amount;
    net.set(e.amount.currency, (net.get(e.amount.currency) ?? 0n) + sign);
  }
  const unbalanced = [...net.entries()].filter(([, v]) => v !== 0n);
  if (unbalanced.length > 0) {
    throw new UnbalancedLedgerError(
      Object.fromEntries(unbalanced.map(([ccy, v]) => [ccy, v.toString()]))
    );
  }
}

/**
 * Motor de asientos de doble partida (F2-03). Implementa el posting normativo
 * de docs/architecture/ledger-design.md §5:
 *
 *  1. Validacion previa (balanceo por moneda) — feedback rapido; la BD
 *     re-verifica al COMMIT (constraint diferido, F2-02).
 *  2. Idempotencia del asiento EN la transaccion (ON CONFLICT DO NOTHING);
 *     replay devuelve el asiento original SOLO si la huella coincide.
 *  3. Anti-deadlock: cuentas bloqueadas en orden total (UUID ascendente).
 *  4. Proyecciones versionadas con guard optimista; fallo => retry limitado
 *     de la transaccion completa (tambien para deadlock/serialization).
 *  5. Evento outbox en la MISMA transaccion. Cero llamadas de red.
 */
export class LedgerService {
  private readonly maxRetries: number;

  constructor(
    private readonly appPool: Pool,
    options: { maxRetries?: number } = {}
  ) {
    this.maxRetries = options.maxRetries ?? 3;
  }

  async createAccount(input: CreateAccountInput): Promise<LedgerAccountDto> {
    return withTenantTransaction(this.appPool, input.tenantId, async (c) => {
      try {
        const res = await c.query<{ id: string }>(
          `INSERT INTO ledger_accounts (tenant_id, name, currency, normal_side)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [input.tenantId, input.name, input.currency, input.normalSide]
        );
        const id = res.rows[0]!.id;
        await c.query('INSERT INTO balance_projections (account_id, tenant_id) VALUES ($1, $2)', [
          id,
          input.tenantId,
        ]);
        return {
          id,
          name: input.name,
          currency: input.currency,
          normalSide: input.normalSide,
        };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new LedgerAccountExistsError();
        throw err;
      }
    });
  }

  async postTransaction(input: PostTransactionInput): Promise<PostedTransaction> {
    validateInput(input);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 20));
      }
      try {
        return await this.postOnce(input);
      } catch (err) {
        if (!isRetryable(err)) throw err;
        lastError = err as Error;
      }
    }
    throw new LedgerRetriesExhaustedError(this.maxRetries + 1, lastError!);
  }

  private async postOnce(input: PostTransactionInput): Promise<PostedTransaction> {
    return withTenantTransaction(this.appPool, input.tenantId, async (c) => {
      const inserted = await c.query<{ id: string; created_at: Date }>(
        `INSERT INTO ledger_transactions
           (tenant_id, idempotency_key, reason, source_type, source_id, reverses_tx_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id, created_at`,
        [
          input.tenantId,
          input.idempotencyKey,
          input.reason,
          input.source.type,
          input.source.id,
          input.reversesTxId ?? null,
        ]
      );

      if (inserted.rowCount === 0) {
        return this.replay(c, input);
      }
      const txId = inserted.rows[0]!.id;
      const createdAt = inserted.rows[0]!.created_at.toISOString();

      // Anti-deadlock: orden total por UUID ascendente (V4 §17.6).
      const accountIds = [...new Set(input.entries.map((e) => e.accountId))].sort();
      const locked = await c.query<LockedAccount>(
        `SELECT id, currency, normal_side FROM ledger_accounts
         WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
         ORDER BY id
         FOR UPDATE`,
        [accountIds]
      );
      if (locked.rowCount !== accountIds.length) {
        const found = new Set(locked.rows.map((r) => r.id));
        throw new AccountNotFoundError(accountIds.filter((id) => !found.has(id)));
      }
      const accounts = new Map(locked.rows.map((r) => [r.id, r]));

      const postedEntries: PostedEntry[] = [];
      for (const e of input.entries) {
        const account = accounts.get(e.accountId)!;
        if (account.currency !== e.amount.currency) {
          throw new AccountCurrencyMismatchError(e.accountId, account.currency, e.amount.currency);
        }
        const bucket = e.bucket ?? 'available';
        await c.query(
          `INSERT INTO ledger_entries
             (tenant_id, tx_root_id, account_id, direction, amount, currency, bucket, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.tenantId,
            txId,
            e.accountId,
            e.direction,
            e.amount.amount.toString(),
            e.amount.currency,
            bucket,
            input.reason,
          ]
        );
        postedEntries.push({
          accountId: e.accountId,
          direction: e.direction,
          amount: e.amount.amount.toString(),
          currency: e.amount.currency,
          bucket,
        });
      }

      await this.applyProjectionDeltas(c, input, accounts, accountIds);

      await c.query(`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES ($1, $2, $3)`, [
        input.tenantId,
        'ledger.transaction.posted',
        JSON.stringify({
          schema_version: 1,
          transaction_id: txId,
          reason: input.reason,
          source: input.source,
          reverses_tx_id: input.reversesTxId ?? null,
          entries: postedEntries,
        }),
      ]);

      return { transactionId: txId, replayed: false, createdAt, entries: postedEntries };
    });
  }

  private async applyProjectionDeltas(
    c: PoolClient,
    input: PostTransactionInput,
    accounts: Map<string, LockedAccount>,
    accountIds: string[]
  ): Promise<void> {
    // Delta por cuenta/bucket: un movimiento del lado natural incrementa.
    const deltas = new Map<string, { available: bigint; pending: bigint }>();
    for (const e of input.entries) {
      const account = accounts.get(e.accountId)!;
      const sign = e.direction === account.normal_side ? e.amount.amount : -e.amount.amount;
      const d = deltas.get(e.accountId) ?? { available: 0n, pending: 0n };
      d[e.bucket ?? 'available'] += sign;
      deltas.set(e.accountId, d);
    }

    // La fila puede no existir para cuentas creadas fuera del servicio.
    await c.query(
      `INSERT INTO balance_projections (account_id, tenant_id)
       SELECT unnest($1::uuid[]), $2
       ON CONFLICT (account_id) DO NOTHING`,
      [accountIds, input.tenantId]
    );
    // Los locks de cuenta (tomados ANTES, en orden) serializan todo posting
    // que toque estas proyecciones; la version es defensa contra escrituras
    // fuera del camino sancionado.
    const versions = await c.query<{ account_id: string; version: string }>(
      `SELECT account_id, version FROM balance_projections
       WHERE account_id = ANY($1::uuid[]) ORDER BY account_id`,
      [accountIds]
    );
    const versionByAccount = new Map(versions.rows.map((r) => [r.account_id, r.version]));

    const protectedAccounts = new Set(input.nonNegativeAccounts ?? []);
    for (const accountId of accountIds) {
      const d = deltas.get(accountId) ?? { available: 0n, pending: 0n };
      const res = await c.query<{ available: string; pending: string }>(
        `UPDATE balance_projections
         SET available = available + $2,
             pending = pending + $3,
             version = version + 1,
             updated_at = now()
         WHERE account_id = $1 AND version = $4
         RETURNING available::text, pending::text`,
        [accountId, d.available.toString(), d.pending.toString(), versionByAccount.get(accountId)]
      );
      if ((res.rowCount ?? 0) === 0) throw new OptimisticLockError(accountId);
      // AUD-P1-010: guard semantico race-safe (bajo locks de cuenta).
      if (protectedAccounts.has(accountId)) {
        const row = res.rows[0]!;
        if (BigInt(row.available) < 0n) {
          throw new InsufficientBalanceError(accountId, 'available', row.available);
        }
        if (BigInt(row.pending) < 0n) {
          throw new InsufficientBalanceError(accountId, 'pending', row.pending);
        }
      }
    }
  }

  private async replay(c: PoolClient, input: PostTransactionInput): Promise<PostedTransaction> {
    const tx = await c.query<{
      id: string;
      created_at: Date;
      reason: string;
      source_type: string | null;
      source_id: string | null;
      reverses_tx_id: string | null;
    }>(
      `SELECT id, created_at, reason, source_type, source_id, reverses_tx_id
       FROM ledger_transactions
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey]
    );
    const row = tx.rows[0];
    if (!row) throw new IdempotencyConflictError(input.idempotencyKey);

    // AUD-P2-001: la huella idempotente incluye la metadata causal completa,
    // no solo los asientos — mismo key con reason/source/reversal distinto
    // es un conflicto, jamas un replay silencioso.
    if (
      row.reason !== input.reason ||
      row.source_type !== input.source.type ||
      row.source_id !== input.source.id ||
      (row.reverses_tx_id ?? null) !== (input.reversesTxId ?? null)
    ) {
      throw new IdempotencyConflictError(input.idempotencyKey);
    }

    const stored = await c.query<{
      account_id: string;
      direction: 'debit' | 'credit';
      amount: string;
      currency: string;
      bucket: 'available' | 'pending';
    }>(
      `SELECT account_id, direction, amount::text, currency, bucket
       FROM ledger_entries WHERE tx_root_id = $1`,
      [row.id]
    );

    const requested = input.entries.map((e: LedgerEntryInput) => ({
      accountId: e.accountId,
      direction: e.direction,
      amount: e.amount.amount.toString(),
      currency: e.amount.currency,
      bucket: e.bucket ?? 'available',
    }));
    const storedEntries = stored.rows.map((r) => ({
      accountId: r.account_id,
      direction: r.direction,
      amount: r.amount,
      currency: r.currency.trim(),
      bucket: r.bucket,
    }));

    if (entriesSignature(requested) !== entriesSignature(storedEntries)) {
      throw new IdempotencyConflictError(input.idempotencyKey);
    }

    return {
      transactionId: row.id,
      replayed: true,
      createdAt: row.created_at.toISOString(),
      entries: storedEntries,
    };
  }

  async getBalance(tenantId: string, accountId: string): Promise<BalanceDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<{ available: string; pending: string; version: string }>(
        `SELECT available::text, pending::text, version::text
         FROM balance_projections WHERE account_id = $1`,
        [accountId]
      );
      const row = res.rows[0];
      if (!row) throw new AccountNotFoundError([accountId]);
      return { accountId, available: row.available, pending: row.pending, version: row.version };
    });
  }

  /**
   * Recalcula el balance desde ledger_entries (fuente de verdad) y lo compara
   * con la proyeccion. Primitiva del audit-replay (drift check formal: F2-05).
   */
  async verifyProjection(tenantId: string, accountId: string): Promise<ProjectionVerification> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const recomputed = await c.query<{ available: string; pending: string }>(
        `SELECT
           COALESCE(SUM(CASE WHEN e.bucket = 'available'
             THEN CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END
             ELSE 0 END), 0)::text AS available,
           COALESCE(SUM(CASE WHEN e.bucket = 'pending'
             THEN CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END
             ELSE 0 END), 0)::text AS pending
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
         WHERE e.account_id = $1`,
        [accountId]
      );
      const projected = await c.query<{ available: string; pending: string }>(
        `SELECT available::text, pending::text FROM balance_projections WHERE account_id = $1`,
        [accountId]
      );
      if (!projected.rows[0]) throw new AccountNotFoundError([accountId]);
      const p = projected.rows[0];
      const r = recomputed.rows[0]!;
      return {
        accountId,
        matches: p.available === r.available && p.pending === r.pending,
        projected: { available: p.available, pending: p.pending },
        recomputed: { available: r.available, pending: r.pending },
      };
    });
  }
}
