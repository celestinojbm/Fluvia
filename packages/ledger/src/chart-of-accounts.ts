import type { NormalSide } from './types.js';

/**
 * Chart of Accounts ejecutable (F2-04). Fuente de verdad del catalogo;
 * docs/architecture/ledger-chart-of-accounts.md se mantiene espejo de esto.
 *
 * scope:
 *  - platform: una cuenta por (tenant, moneda); nombre en BD = code.
 *  - merchant: una cuenta por (tenant, merchant, moneda);
 *              nombre en BD = `${code}:${merchantId}`.
 */
export type AccountScope = 'platform' | 'merchant';
export type AccountType = 'asset' | 'liability' | 'income' | 'expense' | 'transitory';

export interface AccountDefinition {
  scope: AccountScope;
  type: AccountType;
  normalSide: NormalSide;
}

export const CHART_OF_ACCOUNTS = {
  'provider.clearing': { scope: 'platform', type: 'asset', normalSide: 'debit' },
  'provider.receivable': { scope: 'platform', type: 'asset', normalSide: 'debit' },
  'provider.payable': { scope: 'platform', type: 'liability', normalSide: 'credit' },
  'provider.fees': { scope: 'platform', type: 'expense', normalSide: 'debit' },
  'platform.fees': { scope: 'platform', type: 'income', normalSide: 'credit' },
  // Caja/banco operativo de Fluvia (F4-05b): activo del que salen los payouts.
  'platform.cash': { scope: 'platform', type: 'asset', normalSide: 'debit' },
  // Payout en tránsito (F4-05b): obligación en vuelo, aún no confirmada por el
  // banco. Tratamiento contable estándar = PASIVO (credit-normal): al emitir se
  // acredita desde merchant.available; al liquidar se debita contra platform.cash.
  // (Corrige el placeholder original 'asset'; la cuenta jamás se usó — saldo 0.)
  'payout.in_transit': { scope: 'platform', type: 'liability', normalSide: 'credit' },
  suspense: { scope: 'platform', type: 'transitory', normalSide: 'debit' },
  'recon.differences': { scope: 'platform', type: 'transitory', normalSide: 'debit' },
  'merchant.pending': { scope: 'merchant', type: 'liability', normalSide: 'credit' },
  'merchant.available': { scope: 'merchant', type: 'liability', normalSide: 'credit' },
  'merchant.reserve': { scope: 'merchant', type: 'liability', normalSide: 'credit' },
  'refund.liability': { scope: 'merchant', type: 'liability', normalSide: 'credit' },
  'dispute.reserve': { scope: 'merchant', type: 'liability', normalSide: 'credit' },
} as const satisfies Record<string, AccountDefinition>;

export type AccountCode = keyof typeof CHART_OF_ACCOUNTS;

export const ACCOUNT_CODES = Object.keys(CHART_OF_ACCOUNTS) as AccountCode[];

export function isAccountCode(code: string): code is AccountCode {
  return Object.prototype.hasOwnProperty.call(CHART_OF_ACCOUNTS, code);
}

/** Nombre fisico de la cuenta en ledger_accounts. */
export function accountName(code: AccountCode, merchantId: string): string {
  return CHART_OF_ACCOUNTS[code].scope === 'merchant' ? `${code}:${merchantId}` : code;
}
