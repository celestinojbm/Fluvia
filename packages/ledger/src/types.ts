import type { Money } from '@fluvia/money';
import type { PoolClient } from '@fluvia/db';
import type { AuditContext } from '@fluvia/audit';

export const LEDGER_REASONS = [
  'payment',
  'refund',
  'fee',
  'payout',
  'transfer',
  'adjustment',
  'settlement',
  'reversal',
  'reconciliation',
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];

export type EntryDirection = 'debit' | 'credit';
export type NormalSide = 'debit' | 'credit';
export type BalanceBucket = 'available' | 'pending';

export interface LedgerEntryInput {
  accountId: string;
  direction: EntryDirection;
  amount: Money;
  bucket?: BalanceBucket;
}

export interface PostTransactionInput {
  tenantId: string;
  /** Idempotencia del asiento: unico por tenant; replay exacto si se repite. */
  idempotencyKey: string;
  reason: LedgerReason;
  /** Enlace causal obligatorio al objeto de dominio que origina el asiento. */
  source: { type: string; id: string };
  entries: LedgerEntryInput[];
  reversesTxId?: string;
  /**
   * AUD-P1-010: cuentas que NO pueden quedar con saldo negativo tras aplicar
   * el asiento. La verificacion ocurre DENTRO de la transaccion, bajo los
   * locks de cuenta (race-safe); violacion => rollback total.
   */
  nonNegativeAccounts?: string[];
  /**
   * Hook de composicion ATOMICA: corre DENTRO de la misma transaccion, tras
   * el outbox y solo en la primera aplicacion (jamas en replay). Uso interno
   * (p.ej. auditoria de reversiones); PROHIBIDO hacer llamadas externas aqui
   * (Nivel A) — solo escrituras SQL sobre el mismo client.
   */
  onPosted?: (client: PoolClient, posted: PostedTransaction) => Promise<void>;
}

export interface PostedEntry {
  accountId: string;
  direction: EntryDirection;
  /** Unidades menores como string (bigint-safe). */
  amount: string;
  currency: string;
  bucket: BalanceBucket;
}

export interface PostedTransaction {
  transactionId: string;
  /** true si el idempotency key ya existia y se devolvio el asiento original. */
  replayed: boolean;
  createdAt: string;
  entries: PostedEntry[];
}

export interface CreateAccountInput {
  tenantId: string;
  name: string;
  currency: string;
  normalSide: NormalSide;
}

export interface LedgerAccountDto {
  id: string;
  name: string;
  currency: string;
  normalSide: NormalSide;
}

export interface BalanceDto {
  accountId: string;
  available: string;
  pending: string;
  version: string;
}

export interface ProjectionVerification {
  accountId: string;
  matches: boolean;
  projected: { available: string; pending: string };
  recomputed: { available: string; pending: string };
}

/** F2-07: reversion completa de una transaccion via servicio. */
export interface ReverseTransactionInput {
  tenantId: string;
  /** Transaccion original a revertir (misma tenancy; visible via RLS). */
  transactionId: string;
  /** Idempotencia propia de la reversion. */
  idempotencyKey: string;
  /** Objeto de dominio que ORDENA la reversion (refund, ajuste, incidente). */
  source: { type: string; id: string };
  /** Razon humana OBLIGATORIA (V4 §17.4/§36); va al audit log. */
  note: string;
  /** Actor que ordena la reversion; default system. */
  audit?: AuditContext;
}

/** Resultado de rebuildProjection (F2-05). */
export interface ProjectionRebuild {
  accountId: string;
  /** true si la proyeccion viva NO coincidia con el recomputo (se corrigio). */
  drifted: boolean;
  before: { available: string; pending: string };
  after: { available: string; pending: string };
}
