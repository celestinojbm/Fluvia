import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  CheckoutSessionService,
  PaymentIntentService,
  PaymentLinkInvalidMerchantError,
  PaymentLinkNotFoundError,
  PaymentLinkService,
} from '../src/index.js';

/**
 * F3-06 — payment links contra PG real: creación (merchant validado),
 * get/list/disable, y la RESOLUCIÓN pública link -> payment_intent +
 * checkout_session frescos, con aislamiento por tenant y anti-enumeración.
 */

let ctx: TestContext;
let service: PaymentLinkService;
let intents: PaymentIntentService;
let org: string;
let orgB: string;
let merchantId: string;

async function createLink(tenantId: string, input: Parameters<PaymentLinkService['createIn']>[2]) {
  return withTenantTransaction(ctx.app, tenantId, (c) => service.createIn(c, tenantId, input));
}

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  const checkout = new CheckoutSessionService(ctx.app, { checkoutBaseUrl: 'https://pay.test/' });
  service = new PaymentLinkService(ctx.app, {
    checkoutBaseUrl: 'https://pay.test/',
    intents,
    checkout,
  });
  org = await ctx.createTenant(`PL ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`PL-B ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `pl-shop-${randomUUID().slice(0, 8)}`]
  );
  merchantId = m.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('create / get / list / disable', () => {
  it('creates a link with the hosted url and validates the merchant', async () => {
    const link = await createLink(org, { merchantId, amount: 30_000n, currency: 'COP' });
    expect(link.status).toBe('active');
    expect(link.amount).toBe('30000');
    expect(link.url).toBe(`https://pay.test/l/${link.id}`);
    expect(await service.get(org, link.id)).toMatchObject({ id: link.id, status: 'active' });

    // Merchant de otro tenant: invisible bajo RLS => inválido.
    const foreignMerchant = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [orgB, `pl-foreign-${randomUUID().slice(0, 8)}`]
    );
    await expect(
      createLink(org, { merchantId: foreignMerchant.rows[0]!.id, amount: 1000n, currency: 'COP' })
    ).rejects.toThrow(PaymentLinkInvalidMerchantError);
  });

  it('list is tenant-scoped; disable flips status and blocks resolution', async () => {
    const link = await createLink(org, { merchantId, amount: 10_000n, currency: 'COP' });
    expect((await service.list(org, 100)).some((l) => l.id === link.id)).toBe(true);
    expect((await service.list(orgB, 100)).some((l) => l.id === link.id)).toBe(false);

    const disabled = await service.disable(org, link.id);
    expect(disabled.status).toBe('disabled');
    expect(disabled.disabledAt).toBeTruthy();
    // Un link deshabilitado ya no resuelve (anti-enumeración: not found).
    await expect(service.createSessionFromLink(link.id)).rejects.toThrow(PaymentLinkNotFoundError);
  });

  it('get/disable on a foreign or missing link is not found', async () => {
    const link = await createLink(org, { merchantId, amount: 5000n, currency: 'COP' });
    await expect(service.get(orgB, link.id)).rejects.toThrow(PaymentLinkNotFoundError);
    await expect(service.disable(orgB, link.id)).rejects.toThrow(PaymentLinkNotFoundError);
    await expect(service.get(org, randomUUID())).rejects.toThrow(PaymentLinkNotFoundError);
  });
});

describe('createSessionFromLink (plano público)', () => {
  it('resolves an active link into a FRESH intent + checkout session, atomically', async () => {
    const link = await createLink(org, {
      merchantId,
      amount: 42_000n,
      currency: 'COP',
      description: 'Donación',
    });

    const s1 = await service.createSessionFromLink(link.id);
    expect(s1.checkoutSessionId).toBeTruthy();
    expect(s1.clientSecret).toMatch(/^cs_/);
    expect(s1.url).toContain(`/c/${s1.checkoutSessionId}`);

    // Cada apertura genera una sesión DISTINTA (multi-uso) con su propio intent.
    const s2 = await service.createSessionFromLink(link.id);
    expect(s2.checkoutSessionId).not.toBe(s1.checkoutSessionId);

    // El intent generado hereda monto/moneda del link y pertenece al tenant.
    const row = await ctx.admin.query<{ amount: string; currency: string; tenant_id: string }>(
      `SELECT i.amount::text, i.currency, i.tenant_id
       FROM checkout_sessions cs JOIN payment_intents i ON i.id = cs.payment_intent_id
       WHERE cs.id = $1`,
      [s1.checkoutSessionId]
    );
    expect(row.rows[0]).toMatchObject({ amount: '42000', currency: 'COP', tenant_id: org });
  });

  it('a missing link resolves to not found (anti-enumeration)', async () => {
    await expect(service.createSessionFromLink(randomUUID())).rejects.toThrow(
      PaymentLinkNotFoundError
    );
  });
});
