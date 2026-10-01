import { randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { createPersonalServices, type PersonalServices, type ProgramActor } from '../src/index.js';

export interface Harness {
  ctx: TestContext;
  s: PersonalServices;
  program: string;
  close(): Promise<void>;
}

export async function harness(currencies = ['VES', 'USD']): Promise<Harness> {
  const ctx = await createTestContext();
  const s = createPersonalServices({ app: ctx.app, auth: ctx.auth });
  const program = await ctx.createTenant(`Programa ${randomUUID().slice(0, 8)}`);
  await s.programs.setupProgram(
    program,
    { name: 'Fluvia Personal (sandbox)', currencies },
    { kind: 'system' }
  );
  return { ctx, s, program, close: () => ctx.close() };
}

export const key = (p = 'k'): string => `${p}-${randomUUID()}`;

export async function newConsumer(
  h: Harness,
  profile: 'A' | 'B' | 'C' | 'D' = 'B'
): Promise<{ id: string; email: string; session: string; actor: ProgramActor }> {
  const email = `c-${randomUUID().slice(0, 10)}@personal.fluvia.test`;
  const r = await h.s.consumerAuth.register(h.program, {
    email,
    password: 'clave-de-prueba-segura',
    displayName: 'Cliente de prueba',
    syntheticRiskProfile: profile,
  });
  return {
    id: r.consumerId,
    email,
    session: r.session,
    actor: { kind: 'consumer', consumerId: r.consumerId },
  };
}

/** Ingreso confirmado por evento del proveedor de fondeo simulado. */
export async function fund(
  h: Harness,
  consumerId: string,
  amount: bigint,
  currency = 'VES'
): Promise<string> {
  const req = await h.s.wallet.requestFunding(
    h.program,
    consumerId,
    { amount, currency, method: 'mobile_payment', clientKey: key('fund') },
    { kind: 'consumer', consumerId }
  );
  const r = await h.s.events.ingest(h.program, {
    source: 'funding',
    eventId: key('evt'),
    eventType: 'funding.confirmed',
    payload: { provider_ref: req.funding.providerRef, amount: amount.toString(), currency },
  });
  if (r.status !== 'applied') throw new Error(`funding not applied: ${r.status}`);
  return req.funding.providerRef;
}

export async function bal(h: Harness, consumerId: string, currency = 'VES') {
  const all = await h.s.wallet.balances(h.program, consumerId);
  const b = all.find((x) => x.currency === currency)!;
  return {
    available: BigInt(b.available),
    held: BigInt(b.held),
    collateral: BigInt(b.collateral),
    debt: BigInt(b.debt),
    creditAvailable: b.credit ? BigInt(b.credit.available) : 0n,
    limit: b.credit ? BigInt(b.credit.approvedLimit) : 0n,
    reserved: b.credit ? BigInt(b.credit.reserved) : 0n,
  };
}

/** Cliente con saldo, garantía y línea aprobada (perfil B ⇒ ×3). */
export async function creditReady(
  h: Harness,
  opts: { funds: bigint; collateral: bigint; requested: bigint; profile?: 'A' | 'B' | 'C' }
) {
  const c = await newConsumer(h, opts.profile ?? 'B');
  await fund(h, c.id, opts.funds);
  await h.s.collateral.lock(
    h.program,
    c.id,
    { amount: opts.collateral, currency: 'VES', clientKey: key() },
    c.actor
  );
  const app = await h.s.credit.apply(
    h.program,
    c.id,
    { currency: 'VES', requestedLimit: opts.requested, clientKey: key() },
    c.actor
  );
  const card = await h.s.cards.issue(
    h.program,
    c.id,
    { currency: 'VES', form: 'virtual' },
    c.actor
  );
  return { ...c, application: app, card };
}
