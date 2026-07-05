import { hashPassword } from '@fluvia/auth';
import type { Pool } from '@fluvia/db';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { seedUuid } from './deterministic.js';

/**
 * Seeds deterministas de demo (F1-10).
 *
 * Reglas:
 *  - SOLO local/test: los datos de demo (y sus passwords conocidos) JAMAS
 *    llegan a sandbox/staging/production — guard duro, no configuracion.
 *    Abrir sandbox exigira una decision explicita (se revisara con PEND-006).
 *  - Reproducible: mismos IDs (UUID v5 sobre claves fijas) en toda corrida.
 *  - Re-ejecutable sin duplicar: identidad via ON CONFLICT DO NOTHING;
 *    ledger via la MISMA capa de idempotencia de produccion (mismo key +
 *    mismo payload => replay exacto, cero asientos nuevos). El seed no tiene
 *    ningun privilegio especial sobre el ledger: pasa por LedgerService.
 */

export class SeedEnvironmentError extends Error {
  constructor(env: string) {
    super(
      `Demo seeds are forbidden in "${env}": known passwords and synthetic data are local/test-only (F1-10)`
    );
    this.name = 'SeedEnvironmentError';
  }
}

export interface DemoUserSpec {
  id: string;
  email: string;
  /** Password de DEMO, valido SOLO en local/test (el guard lo garantiza). */
  password: string;
  role: 'owner' | 'developer';
}

export const DEMO = {
  organizationId: seedUuid('org:demo-fluvia'),
  organizationName: 'Demo Fluvia',
  slug: 'demo-fluvia',
  merchantId: seedUuid('merchant:demo-store'),
  merchantName: 'Demo Store',
  currency: 'COP',
  users: [
    {
      id: seedUuid('user:owner@demo.fluvia.test'),
      email: 'owner@demo.fluvia.test',
      password: 'demo-owner-password',
      role: 'owner',
    },
    {
      id: seedUuid('user:dev@demo.fluvia.test'),
      email: 'dev@demo.fluvia.test',
      password: 'demo-dev-password',
      role: 'developer',
    },
  ] as DemoUserSpec[],
} as const;

export interface SeedReport {
  organizationId: string;
  merchantId: string;
  userIds: string[];
  /** ids de las transacciones demo del ledger (estables entre corridas). */
  transactionIds: string[];
  balances: { pending: string; available: string };
}

export interface SeedPools {
  /** Superusuario local: identidad (organizations/users/memberships/merchants). */
  admin: Pool;
  /** Rol fluvia_app: TODO el ledger pasa por la via normativa con RLS. */
  app: Pool;
}

export async function seedDemo(env: string, pools: SeedPools): Promise<SeedReport> {
  if (env !== 'local' && env !== 'test') throw new SeedEnvironmentError(env);

  // --- Identidad (idempotente por ON CONFLICT sobre ids/uniques fijos) ------
  await pools.admin.query(
    `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [DEMO.organizationId, DEMO.organizationName, DEMO.slug]
  );

  for (const user of DEMO.users) {
    // El hash se recalcula por corrida (scrypt con salt aleatorio) pero solo
    // se persiste en el alta inicial: DO NOTHING preserva el determinismo.
    const passwordHash = await hashPassword(user.password);
    await pools.admin.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
      [user.id, user.email, passwordHash]
    );
    await pools.admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [seedUuid(`membership:${user.email}`), DEMO.organizationId, user.id, user.role]
    );
  }

  await pools.admin.query(
    `INSERT INTO merchants (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [DEMO.merchantId, DEMO.organizationId, DEMO.merchantName]
  );

  // --- Ledger demo: por la via NORMATIVA (chart + posting idempotente) ------
  const ledger = new LedgerService(pools.app);
  const posting = new PostingService(ledger, pools.app);
  const chart = await posting.ensureChart(DEMO.organizationId, DEMO.merchantId, DEMO.currency);

  const cop = (units: number) => Money.of(units, DEMO.currency);
  const base = {
    tenantId: DEMO.organizationId,
    merchantId: DEMO.merchantId,
    sourceType: 'seed',
  };
  // COP tiene exponente 0: 500.000 COP bruto, fees 14.500/19.500.
  const capture = await posting.capturePayment({
    ...base,
    idempotencyKey: 'seed:demo:capture-1',
    sourceId: 'demo-capture-1',
    amount: cop(500_000),
    providerFee: cop(14_500),
    platformFee: cop(19_500),
  });
  const release = await posting.releaseSettlement({
    ...base,
    idempotencyKey: 'seed:demo:release-1',
    sourceId: 'demo-release-1',
    amount: cop(300_000),
  });

  // Las reservas/pendientes son CUENTAS del chart (decision #18); los asientos
  // del posting usan el bucket por defecto 'available' de cada cuenta.
  const [pending, available] = await Promise.all([
    ledger.getBalance(DEMO.organizationId, chart['merchant.pending']),
    ledger.getBalance(DEMO.organizationId, chart['merchant.available']),
  ]);

  return {
    organizationId: DEMO.organizationId,
    merchantId: DEMO.merchantId,
    userIds: DEMO.users.map((u) => u.id),
    transactionIds: [capture.transactionId, release.transactionId],
    balances: { pending: pending.available, available: available.available },
  };
}
