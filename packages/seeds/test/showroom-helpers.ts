import { randomUUID } from 'node:crypto';
import type { ShowroomDbUrls, ShowroomResetRequest } from '../src/reset.js';

/**
 * Helpers de los tests del showroom: peticiones de reset contra una base
 * EFIMERA `fluvia_showroom_test_<id>` (jamas `fluvia_showroom` real en CI, y
 * JAMAS la base principal del job).
 */

export const MAINTENANCE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export function ephemeralDbName(): string {
  return `fluvia_showroom_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function targetUrlsFor(dbName: string): ShowroomDbUrls {
  const at = (creds: string) => `postgres://${creds}@127.0.0.1:5432/${dbName}`;
  return {
    admin: at('postgres:postgres'),
    app: at('fluvia_app:fluvia_app_dev_password'),
    auth: at('fluvia_auth:fluvia_auth_dev_password'),
    relay: at('fluvia_relay:fluvia_relay_dev_password'),
    webhook: at('fluvia_webhook:fluvia_webhook_dev_password'),
  };
}

export function resetRequestFor(dbName: string): ShowroomResetRequest {
  return {
    env: 'test',
    confirm: 'RESET_FLUVIA_SHOWROOM',
    targetUrls: targetUrlsFor(dbName),
    maintenanceUrl: MAINTENANCE_URL,
  };
}

/** Tablas cuyo conteo prueba «cero mutaciones» de una corrida abortada. */
export const MUTATION_SNAPSHOT_TABLES = [
  'users',
  'organizations',
  'memberships',
  'merchants',
  'customers',
  'payment_intents',
  'payment_attempts',
  'checkout_sessions',
  'payment_links',
  'refunds',
  'payouts',
  'disputes',
  'settlement_reports',
  'settlement_lines',
  'reconciliation_entries',
  'operational_cases',
  'case_adjustments',
  'api_keys',
  'webhook_endpoints',
  'webhook_events',
  'webhook_attempts',
  'ledger_accounts',
  'ledger_transactions',
  'ledger_entries',
  'balance_projections',
  'outbox_events',
  'idempotency_keys',
  'audit_events',
  'email_verification_tokens',
] as const;

export async function snapshotCounts(admin: {
  query: (sql: string) => Promise<{ rows: Array<{ n: string }> }>;
}): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of MUTATION_SNAPSHOT_TABLES) {
    const res = await admin.query(`SELECT count(*)::text AS n FROM ${table}`);
    out[table] = Number(res.rows[0]!.n);
  }
  return out;
}
