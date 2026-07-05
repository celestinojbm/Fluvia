import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { dbUrlsFromEnv } from './config.js';
import { migrate } from './migrate.js';
import { createPool, withTenantTransaction } from './pool.js';

/**
 * Contexto de integracion para tests: pools por rol + helpers de seeding.
 * La limpieza entre corridas NO borra datos (DELETE esta prohibido por
 * diseno): cada corrida crea tenants nuevos y opera aislada via RLS.
 */
export interface TestContext {
  admin: Pool;
  app: Pool;
  worker: Pool;
  relay: Pool;
  inbox: Pool;
  auth: Pool;
  webhook: Pool;
  createTenant(name?: string): Promise<string>;
  createApiKey(tenantId: string, label?: string): Promise<string>;
  createLedgerAccount(input: {
    tenantId: string;
    name: string;
    currency: string;
    normalSide: 'debit' | 'credit';
  }): Promise<string>;
  close(): Promise<void>;
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Pepper HMAC de desarrollo (espejo de @fluvia/identity para evitar el ciclo). */
export const DEV_API_KEY_HMAC_PEPPER_HEX =
  'ffeeddccbbaa00112233445566778899ffeeddccbbaa00112233445566778899'; // gitleaks:allow

export function hmacApiKey(plaintext: string, pepperHex = DEV_API_KEY_HMAC_PEPPER_HEX): string {
  return createHmac('sha256', Buffer.from(pepperHex, 'hex')).update(plaintext).digest('hex');
}

export async function createTestContext(): Promise<TestContext> {
  const urls = dbUrlsFromEnv();
  const admin = createPool({ connectionString: urls.admin, max: 4 });
  await migrate(admin);
  const app = createPool({ connectionString: urls.app, max: 12 });
  const worker = createPool({ connectionString: urls.worker, max: 4 });
  const relay = createPool({ connectionString: urls.relay, max: 4 });
  const inbox = createPool({ connectionString: urls.inbox, max: 4 });
  const auth = createPool({ connectionString: urls.auth, max: 4 });
  const webhook = createPool({ connectionString: urls.webhook, max: 4 });

  return {
    admin,
    app,
    worker,
    relay,
    inbox,
    auth,
    webhook,

    async createTenant(name = `tenant-${randomUUID()}`) {
      // "tenant" = organization (convencion de columna tenant_id, ver 0003).
      const res = await admin.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        [name, `org-${randomUUID()}`]
      );
      return res.rows[0]!.id;
    },

    async createApiKey(tenantId, label = 'test') {
      const plaintext = `fluvia_sk_${randomBytes(24).toString('hex')}`;
      await admin.query('INSERT INTO api_keys (tenant_id, key_hash, label) VALUES ($1, $2, $3)', [
        tenantId,
        hashApiKey(plaintext),
        label,
      ]);
      return plaintext;
    },

    async createLedgerAccount({ tenantId, name, currency, normalSide }) {
      return withTenantTransaction(app, tenantId, async (client) => {
        const res = await client.query<{ id: string }>(
          `INSERT INTO ledger_accounts (tenant_id, name, currency, normal_side)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [tenantId, name, currency, normalSide]
        );
        return res.rows[0]!.id;
      });
    },

    async close() {
      await Promise.all([
        admin.end(),
        app.end(),
        worker.end(),
        relay.end(),
        inbox.end(),
        auth.end(),
        webhook.end(),
      ]);
    },
  };
}
