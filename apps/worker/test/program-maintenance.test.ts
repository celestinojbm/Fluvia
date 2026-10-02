import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  RefundService,
  SqlProviderOperationStore,
  UncertainPaymentResolver,
  ZERO_FEE_SCHEDULE,
} from '@fluvia/payments-core';
import { createPersonalServices, type PersonalServices } from '@fluvia/personal';
import { ProgramMaintenanceJob } from '../src/program-maintenance.js';

/**
 * El worker resuelve SOLO por fuente verificada: un retiro con respuesta
 * perdida (el banco lo pagó) y una devolución incierta del comercio (el
 * proveedor la ejecutó) se cierran consultando al proveedor; un retiro que el
 * banco nunca recibió sigue incierto. El rol worker solo lista tenants.
 */
let ctx: TestContext;
let p: PersonalServices;
let program: string;
let merchantOrg: string;
let merchantId: string;
let job: ProgramMaintenanceJob;
let intents: PaymentIntentService;
let confirmation: PaymentConfirmationService;
let refunds: RefundService;
let posting: PostingService;

beforeAll(async () => {
  ctx = await createTestContext();
  p = createPersonalServices({ app: ctx.app, auth: ctx.auth });
  program = await ctx.createTenant(`Programa ${randomUUID().slice(0, 6)}`);
  await p.programs.setupProgram(
    program,
    { name: 'Programa', currencies: ['VES'] },
    { kind: 'system' }
  );
  merchantOrg = await ctx.createTenant(`Comercio ${randomUUID().slice(0, 6)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, 'Tienda') RETURNING id`,
    [merchantOrg]
  );
  merchantId = m.rows[0]!.id;
  const provider = new MockPaymentProvider(new SqlProviderOperationStore(ctx.app));
  intents = new PaymentIntentService(ctx.app);
  posting = new PostingService(new LedgerService(ctx.app), ctx.app);
  confirmation = new PaymentConfirmationService(
    ctx.app,
    intents,
    posting,
    provider,
    ZERO_FEE_SCHEDULE
  );
  refunds = new RefundService(ctx.app, intents, posting, provider);
  job = new ProgramMaintenanceJob(
    ctx.worker,
    p,
    new UncertainPaymentResolver(ctx.app, provider, confirmation, refunds),
    undefined,
    { minUncertainAgeSeconds: 0 }
  );
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

describe('mantenimiento del programa y de inciertos del comercio', () => {
  it('cierra lo verificable y deja incierto lo que el proveedor no conoce', async () => {
    const reg = await p.consumerAuth.register(program, {
      email: `w-${randomUUID().slice(0, 8)}@personal.fluvia.test`,
      password: 'clave del cliente 2026',
      displayName: 'Cliente',
    });
    const actor = { kind: 'consumer' as const, consumerId: reg.consumerId };
    const f = await p.wallet.requestFunding(
      program,
      reg.consumerId,
      { amount: 50_000n, currency: 'VES', method: 'bank_transfer', clientKey: `k-${randomUUID()}` },
      actor
    );
    await p.events.ingest(program, {
      source: 'funding',
      eventId: `e-${randomUUID()}`,
      eventType: 'funding.confirmed',
      payload: { provider_ref: f.funding.providerRef, amount: '50000', currency: 'VES' },
    });
    const paid = await p.wallet.withdraw(
      program,
      reg.consumerId,
      {
        amount: 10_000n,
        currency: 'VES',
        destination: 'sim:timeout',
        clientKey: `k-${randomUUID()}`,
      },
      actor
    );
    const lost = await p.wallet.withdraw(
      program,
      reg.consumerId,
      { amount: 5_000n, currency: 'VES', destination: 'sim:lost', clientKey: `k-${randomUUID()}` },
      actor
    );

    // Lado comercio: cobro con cargo de prueba cuya devolución pierde la respuesta.
    const intent = await intents.create({
      tenantId: merchantOrg,
      merchantId,
      amount: Money.of(20_000, 'VES'),
    });
    const { attemptId } = await withTenantTransaction(ctx.app, merchantOrg, (c) =>
      confirmation.beginIn(c, merchantOrg, intent.id)
    );
    await confirmation.execute(merchantOrg, attemptId, 'tok_approve_refund_timeout');
    await posting.releaseSettlement({
      tenantId: merchantOrg,
      merchantId,
      idempotencyKey: `settle:${intent.id}`,
      sourceType: 'settlement',
      sourceId: intent.id,
      amount: Money.of(20_000, 'VES'),
    });
    const r = await withTenantTransaction(ctx.app, merchantOrg, (c) =>
      refunds.beginIn(c, merchantOrg, { paymentIntentId: intent.id, amount: 5_000n })
    );
    await refunds.execute(merchantOrg, r.id);

    // Un programa que aún no ofrece crédito (sin política activa) no es un fallo.
    const noCredit = await ctx.createTenant(`Sin crédito ${randomUUID().slice(0, 6)}`);
    await p.programs.setupProgram(
      noCredit,
      { name: 'Sin crédito', currencies: ['VES'] },
      { kind: 'system' }
    );
    await ctx.admin.query(
      `UPDATE credit_policies SET status = 'retired' WHERE tenant_id = $1 AND status = 'active'`,
      [noCredit]
    );

    const result = await job.runOnce();
    expect(result.failures).toBe(0);
    expect(result.withdrawalsResolved).toBeGreaterThanOrEqual(1);
    expect(result.refundsResolved).toBeGreaterThanOrEqual(1);
    expect((await p.wallet.getTransfer(program, paid.id)).status).toBe('completed');
    expect((await p.wallet.getTransfer(program, lost.id)).status).toBe('indeterminate');
    const refund = await ctx.admin.query<{ status: string }>(
      `SELECT status FROM refunds WHERE id = $1`,
      [r.id]
    );
    expect(refund.rows[0]!.status).toBe('succeeded');
  });

  it('el rol worker no lee tablas del programa (solo lista tenants por función definer)', async () => {
    await expect(ctx.worker.query('SELECT 1 FROM consumers LIMIT 1')).rejects.toThrow(
      /permission denied/
    );
    const list = await ctx.worker.query('SELECT tenant_id FROM list_program_tenants()');
    expect(list.rowCount).toBeGreaterThan(0);
  });
});
