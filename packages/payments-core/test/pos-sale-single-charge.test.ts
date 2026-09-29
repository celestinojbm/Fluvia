import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@fluvia/db';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import {
  CheckoutSessionService,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PaymentLinkNotFoundError,
  PaymentLinkService,
  SaleAlreadyChargedError,
  ZERO_FEE_SCHEDULE,
} from '../src/index.js';

/**
 * Integridad de una venta POS contra PG real + MockProvider.
 *
 * Hallazgo reproducido: una venta POS = un payment link; «abrir checkout» =
 * `createSessionFromLink` (intent + sesión NUEVOS cada vez) y
 * `confirmByClientSecret` bloquea SOLO su propia sesión. Dos checkouts de la
 * misma venta confirmados (en serie o en paralelo) terminaban ambos
 * `succeeded`: dos capturas en el ledger para una sola venta.
 *
 * Invariante (0046): un link `single_charge` (venta POS) produce como máximo
 * UN cobro exitoso — guard bajo lock del link en la confirmación + índice
 * único parcial en el motor. Los links multiuso conservan su comportamiento.
 */

let ctx: TestContext;
let intents: PaymentIntentService;
let checkout: CheckoutSessionService;
let links: PaymentLinkService;
let confirmation: PaymentConfirmationService;
let org: string;
let orgB: string;
let merchantId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  intents = new PaymentIntentService(ctx.app);
  const posting = new PostingService(new LedgerService(ctx.app), ctx.app);
  confirmation = new PaymentConfirmationService(
    ctx.app,
    intents,
    posting,
    new MockPaymentProvider(),
    ZERO_FEE_SCHEDULE
  );
  checkout = new CheckoutSessionService(ctx.app, { confirmation });
  links = new PaymentLinkService(ctx.app, { intents, checkout });
  org = await ctx.createTenant(`POS ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`POS-B ${randomUUID().slice(0, 8)}`);
  const m = await ctx.admin.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, `pos-shop-${randomUUID().slice(0, 8)}`]
  );
  merchantId = m.rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

async function newLink(singleCharge = false) {
  return withTenantTransaction(ctx.app, org, (c) =>
    links.createIn(c, org, { merchantId, amount: 5_000n, currency: 'COP', singleCharge })
  );
}

const confirm = (s: { checkoutSessionId: string; clientSecret: string }, token: string) =>
  checkout.confirmByClientSecret(s.checkoutSessionId, s.clientSecret, token);

async function attemptsOf(intentIds: string[]) {
  const r = await ctx.admin.query<{ intent_id: string; status: string }>(
    `SELECT intent_id, status FROM payment_attempts WHERE intent_id = ANY($1::uuid[])`,
    [intentIds]
  );
  return r.rows;
}

async function intentOfSession(sessionId: string): Promise<string> {
  const r = await ctx.admin.query<{ payment_intent_id: string }>(
    `SELECT payment_intent_id FROM checkout_sessions WHERE id = $1`,
    [sessionId]
  );
  return r.rows[0]!.payment_intent_id;
}

async function succeededCaptures(intentIds: string[]): Promise<number> {
  const r = await ctx.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment_attempts
     WHERE intent_id = ANY($1::uuid[]) AND status = 'succeeded'`,
    [intentIds]
  );
  return Number(r.rows[0]!.n);
}

describe('link multiuso (payment links públicos: comportamiento conservado)', () => {
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
    expect(ra.saleClosed).toBe(false);

    // Vínculo persistente también para links multiuso (sin política de cobro).
    const sale = await links.getSale(org, link.id);
    expect(sale.link.singleCharge).toBe(false);
    expect(sale.history).toBe('complete');
    expect(sale.charge).toBe('charged');
    expect(sale.succeededCount).toBe(2);
    expect(sale.checkouts.map((x) => x.session?.id).sort()).toEqual(
      [a.checkoutSessionId, b.checkoutSessionId].sort()
    );
  });
});

describe('venta POS (single_charge): como máximo un cobro exitoso', () => {
  it('dos checkouts confirmados en paralelo ⇒ exactamente UNO cobra; el otro 409 sin attempt', async () => {
    const link = await newLink(true);
    const a = await links.createSessionFromLink(link.id);
    const b = await links.createSessionFromLink(link.id);
    const results = await Promise.allSettled([
      confirm(a, 'tok_approve'),
      confirm(b, 'tok_approve'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect((ko[0] as PromiseRejectedResult).reason).toBeInstanceOf(SaleAlreadyChargedError);
    expect(
      (ok[0] as PromiseFulfilledResult<{ paymentIntent: { status: string } }>).value.paymentIntent
        .status
    ).toBe('succeeded');

    const ids = [
      await intentOfSession(a.checkoutSessionId),
      await intentOfSession(b.checkoutSessionId),
    ];
    expect(await succeededCaptures(ids)).toBe(1);
    // El perdedor no llegó al proveedor: cero attempts en su intent.
    expect(await attemptsOf(ids)).toHaveLength(1);

    const sale = await links.getSale(org, link.id);
    expect(sale.charge).toBe('charged');
    expect(sale.succeededCount).toBe(1);
    expect(sale.checkouts).toHaveLength(2);
  });

  it('carrera de 8 checkouts de la misma venta ⇒ un solo cobro', async () => {
    const link = await newLink(true);
    const sessions = await Promise.all(
      Array.from({ length: 8 }, () => links.createSessionFromLink(link.id))
    );
    const results = await Promise.allSettled(sessions.map((x) => confirm(x, 'tok_approve')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SaleAlreadyChargedError);
    }
    const ids = await Promise.all(sessions.map((x) => intentOfSession(x.checkoutSessionId)));
    expect(await succeededCaptures(ids)).toBe(1);
    expect(await attemptsOf(ids)).toHaveLength(1);
  });

  it('desenlace INCIERTO del proveedor retiene la venta hasta resolución verificada', async () => {
    const link = await newLink(true);
    const a = await links.createSessionFromLink(link.id);
    const b = await links.createSessionFromLink(link.id);
    const va = await confirm(a, 'tok_timeout');
    expect(va.paymentIntent.status).toBe('processing');
    const intentA = va.paymentIntent.id;
    expect((await attemptsOf([intentA]))[0]!.status).toBe('indeterminate');

    // Mientras el resultado es desconocido, ningún otro checkout cobra.
    await expect(confirm(b, 'tok_approve')).rejects.toBeInstanceOf(SaleAlreadyChargedError);
    const vb = await checkout.getByClientSecret(b.checkoutSessionId, b.clientSecret);
    expect(vb.saleClosed).toBe(true);
    expect(vb.status).toBe('open');
    expect((await links.getSale(org, link.id)).charge).toBe('in_progress');
    await expect(links.createSessionFromLink(link.id)).rejects.toBeInstanceOf(
      SaleAlreadyChargedError
    );

    // Resolución verificada (webhook/consulta) = rechazo ⇒ la venta se libera.
    const att = await ctx.admin.query<{ id: string }>(
      `SELECT id FROM payment_attempts WHERE intent_id = $1`,
      [intentA]
    );
    expect(
      await confirmation.resolveFromProvider(org, {
        attemptId: att.rows[0]!.id,
        providerRef: 'mock_verified',
        result: 'failed',
        failureCode: 'card_declined',
      })
    ).toBe('applied');
    const vb2 = await confirm(b, 'tok_approve');
    expect(vb2.paymentIntent.status).toBe('succeeded');
    expect(vb2.saleClosed).toBe(false);
    const sale = await links.getSale(org, link.id);
    expect(sale.charge).toBe('charged');
    expect(sale.chargeIntentId).toBe(vb2.paymentIntent.id);
  });

  it('desenlace incierto resuelto como ÉXITO ⇒ la venta queda cobrada y el otro jamás cobra', async () => {
    const link = await newLink(true);
    const a = await links.createSessionFromLink(link.id);
    const b = await links.createSessionFromLink(link.id);
    const va = await confirm(a, 'tok_pse'); // aceptado asíncrono: submitted
    expect(va.paymentIntent.status).toBe('processing');
    await expect(confirm(b, 'tok_approve')).rejects.toBeInstanceOf(SaleAlreadyChargedError);
    const att = await ctx.admin.query<{ id: string; provider_ref: string }>(
      `SELECT id, provider_ref FROM payment_attempts WHERE intent_id = $1`,
      [va.paymentIntent.id]
    );
    await confirmation.resolveFromProvider(org, {
      attemptId: att.rows[0]!.id,
      providerRef: att.rows[0]!.provider_ref,
      result: 'succeeded',
    });
    await expect(confirm(b, 'tok_approve')).rejects.toBeInstanceOf(SaleAlreadyChargedError);
    const ids = [va.paymentIntent.id, await intentOfSession(b.checkoutSessionId)];
    expect(await succeededCaptures(ids)).toBe(1);
  });

  it('rechazo libera la venta: recuperar con otro checkout cobra una sola vez', async () => {
    const link = await newLink(true);
    const a = await links.createSessionFromLink(link.id);
    expect((await confirm(a, 'tok_decline')).paymentIntent.status).toBe('failed');
    expect((await links.getSale(org, link.id)).charge).toBe('none');
    const b = await links.createSessionFromLink(link.id);
    expect((await confirm(b, 'tok_approve')).paymentIntent.status).toBe('succeeded');
    // Tras cobrar, no se abren checkouts nuevos de la venta.
    await expect(links.createSessionFromLink(link.id)).rejects.toBeInstanceOf(
      SaleAlreadyChargedError
    );
  });

  it('doble envío del MISMO checkout es idempotente (un attempt, sin 409)', async () => {
    const link = await newLink(true);
    const a = await links.createSessionFromLink(link.id);
    const [r1, r2] = await Promise.all([confirm(a, 'tok_approve'), confirm(a, 'tok_approve')]);
    // Uno ejecuta el cobro; el otro ve el pago en curso o ya resuelto (antes de
    // corregir la lectura tras el lock fallaba con processing -> processing).
    const statuses = [r1.paymentIntent.status, r2.paymentIntent.status];
    expect(statuses).toContain('succeeded');
    for (const st of statuses) expect(['processing', 'succeeded']).toContain(st);
    expect(await attemptsOf([r1.paymentIntent.id])).toHaveLength(1);
    // Reintento posterior del comprador: misma vista, sin error.
    expect((await confirm(a, 'tok_approve')).status).toBe('completed');
  });

  it('TTL vencido sin barrer: el checkout ya no cobra', async () => {
    const link = await newLink(true);
    const a = await links.createSessionFromLink(link.id);
    await ctx.admin.query(
      `UPDATE checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [a.checkoutSessionId]
    );
    const v = await confirm(a, 'tok_approve');
    expect(v.status).toBe('expired');
    expect(await attemptsOf([v.paymentIntent.id])).toHaveLength(0);
  });
});

describe('garantía del motor (sin pasar por el servicio)', () => {
  it('el índice único rechaza un segundo intent de la venta en processing (23505)', async () => {
    const link = await newLink(true);
    const a = await links.createSessionFromLink(link.id);
    const b = await links.createSessionFromLink(link.id);
    await confirm(a, 'tok_approve');
    const intentB = await intentOfSession(b.checkoutSessionId);
    // Camino que se salta el guard: transiciones crudas hasta processing.
    await expect(
      withTenantTransaction(ctx.app, org, async (c) => {
        for (const to of [
          'requires_payment_method',
          'requires_confirmation',
          'processing',
        ] as const)
          await intents.transitionIn(c, intentB, to);
      })
    ).rejects.toMatchObject({ code: '23505', constraint: 'payment_intents_single_charge_uq' });
  });

  it('la política y el vínculo son inmutables; el vínculo derivado no se puede falsificar', async () => {
    const link = await newLink(true);
    const multi = await newLink(false);
    await expect(
      ctx.admin.query(`UPDATE payment_links SET single_charge = false WHERE id = $1`, [link.id])
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    const a = await links.createSessionFromLink(link.id);
    const intentA = await intentOfSession(a.checkoutSessionId);
    await expect(
      ctx.admin.query(`UPDATE payment_intents SET payment_link_id = NULL WHERE id = $1`, [intentA])
    ).rejects.toThrow(/FLUVIA_IMMUTABLE/);
    // Un INSERT que intenta fijar single_charge_link_id a mano: el trigger lo
    // recalcula desde la política del link (multiuso ⇒ NULL).
    const forged = await withTenantTransaction(ctx.app, org, (c) =>
      c.query<{ single_charge_link_id: string | null }>(
        `INSERT INTO payment_intents
           (tenant_id, merchant_id, amount, currency, payment_link_id, single_charge_link_id, status)
         VALUES ($1, $2, 5000, 'COP', $3, $3, 'created')
         RETURNING single_charge_link_id`,
        [org, merchantId, multi.id]
      )
    ).catch((e: unknown) => e);
    // payment_link_id = multi, single_charge_link_id forzado a multi ⇒ el
    // trigger lo anula (link multiuso): la fila entra sin política.
    expect(
      (forged as { rows: Array<{ single_charge_link_id: string | null }> }).rows[0]!
        .single_charge_link_id
    ).toBeNull();
  });
});

describe('aislamiento entre organizaciones', () => {
  it('la venta de otra org es not-found y un intent no puede vincularse a un link ajeno', async () => {
    const link = await newLink(true);
    await expect(links.getSale(orgB, link.id)).rejects.toBeInstanceOf(PaymentLinkNotFoundError);
    const mB = await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [orgB, `pos-b-${randomUUID().slice(0, 8)}`]
    );
    await expect(
      intents.create({
        tenantId: orgB,
        merchantId: mB.rows[0]!.id,
        amount: Money.of(5_000n, 'COP'),
        paymentLinkId: link.id,
      })
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('registros anteriores al vínculo', () => {
  it('link legado: historial PARCIAL; los checkouts sin vínculo no se atribuyen a la venta', async () => {
    const link = await newLink(false);
    // Simula un link anterior a 0046: el vínculo empezó DESPUÉS de crearlo.
    await ctx.admin.query(
      `UPDATE payment_links SET checkout_tracking_since = created_at + interval '1 hour'
       WHERE id = $1`,
      [link.id]
    );
    // Intent legado (sin payment_link_id) del mismo comercio e importe.
    const legacy = await intents.create({
      tenantId: org,
      merchantId,
      amount: Money.of(5_000n, 'COP'),
    });
    expect(legacy.paymentLinkId).toBeNull();
    const s = await links.createSessionFromLink(link.id);

    const sale = await links.getSale(org, link.id);
    expect(sale.history).toBe('partial');
    expect(sale.checkouts.map((x) => x.session?.id)).toEqual([s.checkoutSessionId]);
    expect(sale.checkouts.some((x) => x.paymentIntentId === legacy.id)).toBe(false);
  });
});
