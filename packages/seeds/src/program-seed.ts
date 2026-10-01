import { hashPassword } from '@fluvia/auth';
import type { Pool } from '@fluvia/db';
import { createPersonalServices } from '@fluvia/personal';
import { seedUuid } from './deterministic.js';
import { DEMO, SeedEnvironmentError } from './seed.js';

/**
 * Programa de DEMO de Fluvia Personal (jornada integral) — SOLO local/test.
 *
 * Organización programa + operadores (owner del demo como owner y una
 * segunda persona «finance» para la doble aprobación) + un cliente sintético
 * con ingreso confirmado por el proveedor simulado, garantía, línea aprobada
 * por la política de referencia y tarjeta virtual. Re-ejecutable: claves
 * deterministas en todas las escrituras (instrucción de ingreso, evento,
 * garantía, solicitud) y la tarjeta solo se emite si no existe.
 */
export const PROGRAM_DEMO = {
  organizationId: seedUuid('org:demo-fluvia-personal'),
  organizationName: 'Fluvia Personal (demo)',
  slug: 'demo-fluvia-personal',
  operator: {
    id: seedUuid('user:ops@demo.fluvia.test'),
    email: 'ops@demo.fluvia.test',
    password: 'demo-ops-password',
  },
  consumer: {
    email: 'cliente@demo.fluvia.test',
    password: 'demo-cliente-password',
    displayName: 'María Pérez (demo)',
  },
} as const;

export interface ProgramSeedReport {
  programId: string;
  consumerId: string;
  cardLast4: string | null;
}

export async function seedProgramDemo(
  env: string,
  pools: { admin: Pool; app: Pool; auth: Pool }
): Promise<ProgramSeedReport> {
  if (env !== 'local' && env !== 'test') throw new SeedEnvironmentError(env);
  const P = PROGRAM_DEMO;
  await pools.admin.query(
    `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [P.organizationId, P.organizationName, P.slug]
  );
  const owner = DEMO.users.find((u) => u.role === 'owner')!;
  await pools.admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'owner') ON CONFLICT DO NOTHING`,
    [seedUuid(`membership:program:${owner.email}`), P.organizationId, owner.id]
  );
  await pools.admin.query(
    `INSERT INTO users (id, email, password_hash, email_verified_at)
     VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
    [P.operator.id, P.operator.email, await hashPassword(P.operator.password)]
  );
  await pools.admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'finance') ON CONFLICT DO NOTHING`,
    [seedUuid(`membership:program:${P.operator.email}`), P.organizationId, P.operator.id]
  );

  const s = createPersonalServices({ app: pools.app, auth: pools.auth });
  await s.programs.setupProgram(
    P.organizationId,
    { name: 'Fluvia Personal', currencies: ['VES', 'USD'] },
    { kind: 'system' }
  );

  const existing = await pools.admin.query<{ id: string }>(
    `SELECT id FROM consumers WHERE tenant_id = $1 AND email = $2`,
    [P.organizationId, P.consumer.email]
  );
  const consumerId =
    existing.rows[0]?.id ??
    (
      await s.consumerAuth.register(P.organizationId, {
        email: P.consumer.email,
        password: P.consumer.password,
        displayName: P.consumer.displayName,
        syntheticRiskProfile: 'B',
      })
    ).consumerId;
  const actor = { kind: 'consumer' as const, consumerId };
  const funding = await s.wallet.requestFunding(
    P.organizationId,
    consumerId,
    {
      amount: 2_500_000n,
      currency: 'VES',
      method: 'mobile_payment',
      clientKey: 'seed:demo:funding-1',
    },
    actor
  );
  await s.events.ingest(P.organizationId, {
    source: 'funding',
    eventId: 'seed:demo:funding-1:confirmed',
    eventType: 'funding.confirmed',
    payload: { provider_ref: funding.funding.providerRef, amount: '2500000', currency: 'VES' },
  });
  await s.collateral.lock(
    P.organizationId,
    consumerId,
    { amount: 1_000_000n, currency: 'VES', clientKey: 'seed:demo:collateral-1' },
    actor
  );
  await s.credit.apply(
    P.organizationId,
    consumerId,
    { currency: 'VES', requestedLimit: 3_000_000n, clientKey: 'seed:demo:application-1' },
    actor
  );
  const cards = await s.cards.listCards(P.organizationId, { consumerId }, consumerId);
  const card =
    cards.find((c) => c.status === 'active') ??
    (await s.cards.issue(
      P.organizationId,
      consumerId,
      { currency: 'VES', form: 'virtual' },
      actor
    ));
  return { programId: P.organizationId, consumerId, cardLast4: card.last4 };
}
