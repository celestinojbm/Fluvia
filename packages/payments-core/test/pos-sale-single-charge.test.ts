import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import {
  CheckoutSessionService,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PaymentLinkService,
  ZERO_FEE_SCHEDULE,
} from '../src/index.js';

/**
 * Integridad de una venta POS contra PG real + MockProvider.
 *
 * Hallazgo reproducido: una venta POS = un payment link; «abrir checkout» =
 * `createSessionFromLink` (intent + sesión NUEVOS cada vez) y
 * `confirmByClientSecret` bloquea SOLO su propia sesión. Dos checkouts de la
 * misma venta confirmados (en serie o en paralelo) terminan ambos
 * `succeeded`: dos capturas en el ledger para una sola venta.
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let checkout: CheckoutSessionService;
let links: PaymentLinkService;
let org: string;
let merchantId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  const posting = new PostingService(new LedgerService(ctx.app), ctx.app);
  checkout = new CheckoutSessionService(ctx.app, {
    confirmation: new PaymentConfirmationService(
      ctx.app,
      intents,
      posting,
      new MockPaymentProvider(),
      ZERO_FEE_SCHEDULE
    ),
  });
  links = new PaymentLinkService(ctx.app, { intents, checkout });
  org = await ctx.createTenant(`POS ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `pos-shop-${randomUUID().slice(0, 8)}`]
  );
  merchantId = m.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

async function newLink() {
  return withTenantTransaction(ctx.app, org, (c) =>
    links.createIn(c, org, { merchantId, amount: 5_000n, currency: 'COP' })
  );
}

async function succeededCaptures(intentIds: string[]): Promise<number> {
  const r = await ctx.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment_attempts
     WHERE intent_id = ANY($1::uuid[]) AND status = 'succeeded'`,
    [intentIds]
  );
  return Number(r.rows[0]!.n);
}

describe('link multiuso (comportamiento actual)', () => {
  it('dos checkouts del mismo link confirmados en paralelo ⇒ AMBOS succeeded (dos cobros)', async () => {
    const link = await newLink();
    const a = await links.createSessionFromLink(link.id);
    const b = await links.createSessionFromLink(link.id);
    expect(a.checkoutSessionId).not.toBe(b.checkoutSessionId);

    const [ra, rb] = await Promise.all([
      checkout.confirmByClientSecret(a.checkoutSessionId, a.clientSecret, 'tok_approve'),
      checkout.confirmByClientSecret(b.checkoutSessionId, b.clientSecret, 'tok_approve'),
    ]);
    expect(ra.paymentIntent.id).not.toBe(rb.paymentIntent.id);
    expect([ra.paymentIntent.status, rb.paymentIntent.status]).toEqual(['succeeded', 'succeeded']);
    expect(await succeededCaptures([ra.paymentIntent.id, rb.paymentIntent.id])).toBe(2);
  });
});
