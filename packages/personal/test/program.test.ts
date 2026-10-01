import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CollateralCommittedError,
  ConsumerSessionInvalidError,
  FourEyesRequiredError,
  InsufficientFundsError,
  InvalidConsumerCredentialsError,
  PaymentCodeInvalidError,
  ResourceNotFoundError,
  REFERENCE_POLICY_PARAMS,
} from '../src/index.js';
import { bal, creditReady, fund, harness, key, newConsumer, type Harness } from './helpers.js';

/**
 * Programa de consumo contra PostgreSQL REAL con adaptadores simulados:
 * wallet, garantía, política, crédito, tarjetas, autorizaciones, cuotas,
 * eventos de proveedor, casos y conciliación.
 */
let h: Harness;

beforeAll(async () => {
  h = await harness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

describe('programa y política de referencia', () => {
  it('el programa nace con la política de referencia activa, sintética y pendiente de validación', async () => {
    const p = await h.s.programs.getActivePolicy(h.program);
    expect(p.code).toBe('ref-sandbox');
    expect(p.isReference).toBe(true);
    expect(p.synthetic).toBe(true);
    expect(p.pendingCommercialValidation).toBe(true);
    expect(p.params.maxMultiplierBps).toBe(40_000);
  });

  it('una nueva versión exige doble aprobación (quien propone no aprueba)', async () => {
    const [u1, u2] = [crypto.randomUUID(), crypto.randomUUID()];
    const draft = await h.s.programs.createPolicyDraft(
      h.program,
      { code: 'ref-sandbox', params: { ...REFERENCE_POLICY_PARAMS, downPaymentBps: 3_000 } },
      { kind: 'operator', userId: u1 }
    );
    expect(draft.version).toBe(2);
    expect(draft.status).toBe('draft');
    const { approvalId } = await h.s.programs.proposeActivation(
      h.program,
      draft.id,
      'Ajuste de prueba',
      {
        kind: 'operator',
        userId: u1,
      }
    );
    await expect(
      h.s.programs.decideApproval(h.program, approvalId, 'approve', {
        kind: 'operator',
        userId: u1,
      })
    ).rejects.toBeInstanceOf(FourEyesRequiredError);
    // Se rechaza (no queremos cambiar la política de la suite): la v1 sigue activa.
    await h.s.programs.decideApproval(h.program, approvalId, 'reject', {
      kind: 'operator',
      userId: u2,
    });
    expect((await h.s.programs.getActivePolicy(h.program)).version).toBe(1);
  });
});

describe('parámetros no implementados', () => {
  it('una política con intereses o recargos por mora se rechaza (no se ignoran en silencio)', async () => {
    const op = { kind: 'operator' as const, userId: crypto.randomUUID() };
    await expect(
      h.s.programs.createPolicyDraft(
        h.program,
        { code: 'con-interes', params: { ...REFERENCE_POLICY_PARAMS, interestBps: 150 } },
        op
      )
    ).rejects.toThrow(/interestBps/);
    await expect(
      h.s.programs.createPolicyDraft(
        h.program,
        { code: 'con-mora', params: { ...REFERENCE_POLICY_PARAMS, lateFeeBps: 50 } },
        op
      )
    ).rejects.toThrow(/lateFeeBps/);
  });
});

describe('autenticación del cliente', () => {
  it('registro, login, sesión propia y bloqueo tras intentos fallidos', async () => {
    const c = await newConsumer(h);
    expect(c.session.startsWith('fluvia_csess_')).toBe(true);
    const id = await h.s.consumerAuth.authenticate(c.session);
    expect(id.consumerId).toBe(c.id);
    expect(id.tenantId).toBe(h.program);
    // Un token de otro plano jamás valida aquí.
    await expect(
      h.s.consumerAuth.authenticate('fluvia_sess_' + 'a'.repeat(64))
    ).rejects.toBeInstanceOf(ConsumerSessionInvalidError);
    for (let i = 0; i < 5; i++) {
      await expect(
        h.s.consumerAuth.login(h.program, c.email, 'incorrecta-000000')
      ).rejects.toBeInstanceOf(InvalidConsumerCredentialsError);
    }
    await expect(
      h.s.consumerAuth.login(h.program, c.email, 'clave-de-prueba-segura')
    ).rejects.toThrow(/Too many failed attempts/);
    await h.s.consumerAuth.logout(c.session);
    await expect(h.s.consumerAuth.authenticate(c.session)).rejects.toBeInstanceOf(
      ConsumerSessionInvalidError
    );
  });
});

describe('wallet', () => {
  it('un ingreso solo acredita con evento del proveedor; duplicados y fuera de orden no duplican', async () => {
    const c = await newConsumer(h);
    const req = await h.s.wallet.requestFunding(
      h.program,
      c.id,
      { amount: 250_000n, currency: 'VES', method: 'bank_transfer', clientKey: key() },
      c.actor
    );
    expect(req.funding.status).toBe('pending');
    expect((await bal(h, c.id)).available).toBe(0n);

    const evt = {
      source: 'funding' as const,
      eventId: key('evt'),
      eventType: 'funding.confirmed',
      payload: { provider_ref: req.funding.providerRef, amount: '250000', currency: 'VES' },
    };
    expect((await h.s.events.ingest(h.program, evt)).status).toBe('applied');
    expect((await h.s.events.ingest(h.program, evt)).status).toBe('duplicate');
    // Mismo ingreso, otro id de evento: no vuelve a acreditar.
    expect((await h.s.events.ingest(h.program, { ...evt, eventId: key('evt') })).status).toBe(
      'ignored_out_of_order'
    );
    expect((await bal(h, c.id)).available).toBe(250_000n);
  });

  it('un evento con importe distinto no acredita: queda sin conciliar con caso abierto', async () => {
    const c = await newConsumer(h);
    const req = await h.s.wallet.requestFunding(
      h.program,
      c.id,
      { amount: 100_000n, currency: 'VES', method: 'bank_transfer', clientKey: key() },
      c.actor
    );
    const r = await h.s.events.ingest(h.program, {
      source: 'funding',
      eventId: key('evt'),
      eventType: 'funding.confirmed',
      payload: { provider_ref: req.funding.providerRef, amount: '999999', currency: 'VES' },
    });
    expect(r.status).toBe('unmatched');
    expect((await bal(h, c.id)).available).toBe(0n);
    const cases = await h.s.cases.list(h.program, {
      caseType: 'unmatched_provider_event',
      status: 'open',
    });
    expect(cases.length).toBeGreaterThan(0);
  });

  it('la misma clave de idempotencia devuelve la misma instrucción', async () => {
    const c = await newConsumer(h);
    const k = key();
    const a = await h.s.wallet.requestFunding(
      h.program,
      c.id,
      { amount: 1_000n, currency: 'VES', method: 'bank_transfer', clientKey: k },
      c.actor
    );
    const b = await h.s.wallet.requestFunding(
      h.program,
      c.id,
      { amount: 1_000n, currency: 'VES', method: 'bank_transfer', clientKey: k },
      c.actor
    );
    expect(b.funding.id).toBe(a.funding.id);
  });

  it('transferencia entre clientes: atómica, sin sobregiro', async () => {
    const a = await newConsumer(h);
    const b = await newConsumer(h);
    await fund(h, a.id, 50_000n);
    await h.s.wallet.transferP2P(
      h.program,
      a.id,
      { toEmail: b.email, amount: 20_000n, currency: 'VES', clientKey: key() },
      a.actor
    );
    await expect(
      h.s.wallet.transferP2P(
        h.program,
        a.id,
        { toEmail: b.email, amount: 40_000n, currency: 'VES', clientKey: key() },
        a.actor
      )
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect((await bal(h, a.id)).available).toBe(30_000n);
    expect((await bal(h, b.id)).available).toBe(20_000n);
    const seenByB = await h.s.wallet.listTransfers(h.program, b.id);
    expect(seenByB[0]!.direction).toBe('in');
  });

  it('retiro incierto conserva la reserva hasta resolución verificada; perdido sigue incierto', async () => {
    const c = await newConsumer(h);
    await fund(h, c.id, 80_000n);
    const t = await h.s.wallet.withdraw(
      h.program,
      c.id,
      { amount: 30_000n, currency: 'VES', destination: 'sim:timeout', clientKey: key() },
      c.actor
    );
    expect(t.status).toBe('indeterminate');
    expect((await bal(h, c.id)).available).toBe(50_000n);
    const open = await h.s.cases.list(h.program, {
      caseType: 'uncertain_withdrawal',
      status: 'open',
    });
    expect(open.some((x) => x.subjectId === t.id)).toBe(true);
    // Un operador no puede «cerrar a mano» un incierto con dinero retenido.
    const theCase = open.find((x) => x.subjectId === t.id)!;
    await expect(
      h.s.cases.resolve(h.program, theCase.id, 'cerrar', {
        kind: 'operator',
        userId: crypto.randomUUID(),
      })
    ).rejects.toThrow();

    const lost = await h.s.wallet.withdraw(
      h.program,
      c.id,
      { amount: 10_000n, currency: 'VES', destination: 'sim:lost', clientKey: key() },
      c.actor
    );
    expect(lost.status).toBe('indeterminate');

    const r = await h.s.wallet.resolveUncertainWithdrawals(h.program);
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect((await h.s.wallet.getTransfer(h.program, t.id)).status).toBe('completed');
    expect((await h.s.wallet.getTransfer(h.program, lost.id)).status).toBe('indeterminate');
    expect((await h.s.cases.get(h.program, theCase.id)).status).toBe('resolved');
    // Saldo: 80k − 30k (pagado) − 10k (retenido, incierto).
    expect((await bal(h, c.id)).available).toBe(40_000n);
    // Un evento tardío del banco sobre el retiro perdido lo cierra (devolución).
    const ev = await h.s.events.ingest(h.program, {
      source: 'withdrawal',
      eventId: key('evt'),
      eventType: 'withdrawal.failed',
      payload: { transfer_id: lost.id, provider_ref: 'simwd_late', failure_code: 'not_received' },
    });
    expect(ev.status).toBe('applied');
    expect((await bal(h, c.id)).available).toBe(50_000n);
  });
});

describe('garantía y crédito', () => {
  it('límite = garantía × multiplicador del nivel (B ×3), explicado; recargas no lo amplían', async () => {
    const c = await creditReady(h, {
      funds: 2_000_000n,
      collateral: 1_000_000n,
      requested: 5_000_000n,
    });
    expect(c.application.application.status).toBe('approved');
    expect(c.application.application.approvedLimit).toBe('3000000');
    const codes = c.application.application.decision.reasons.map((r) => r.code);
    expect(codes).toContain('synthetic_profile');
    expect(codes).toContain('capped_by_collateral');
    // Recarga (incluso duplicada): el límite no cambia.
    const ref = await fund(h, c.id, 500_000n);
    await h.s.events.ingest(h.program, {
      source: 'funding',
      eventId: key('evt'),
      eventType: 'funding.confirmed',
      payload: { provider_ref: ref, amount: '500000', currency: 'VES' },
    });
    const b = await bal(h, c.id);
    expect(b.limit).toBe(3_000_000n);
    expect(b.available).toBe(1_500_000n);
    expect(b.collateral).toBe(1_000_000n);
  });

  it('perfil D se rechaza; garantía bajo el mínimo se rechaza; grandes importes van a revisión manual', async () => {
    const d = await newConsumer(h, 'D');
    await fund(h, d.id, 2_000_000n);
    await h.s.collateral.lock(
      h.program,
      d.id,
      { amount: 1_000_000n, currency: 'VES', clientKey: key() },
      d.actor
    );
    const rd = await h.s.credit.apply(
      h.program,
      d.id,
      { currency: 'VES', requestedLimit: 1_000_000n, clientKey: key() },
      d.actor
    );
    expect(rd.application.status).toBe('rejected');
    expect(rd.line).toBeNull();

    const low = await newConsumer(h, 'A');
    await fund(h, low.id, 100_000n);
    await h.s.collateral.lock(
      h.program,
      low.id,
      { amount: 100_000n, currency: 'VES', clientKey: key() },
      low.actor
    );
    const rl = await h.s.credit.apply(
      h.program,
      low.id,
      { currency: 'VES', requestedLimit: 200_000n, clientKey: key() },
      low.actor
    );
    expect(rl.application.status).toBe('rejected');
    expect(rl.application.decision.reasons.map((r) => r.code)).toContain(
      'collateral_below_minimum'
    );

    const big = await newConsumer(h, 'A');
    await fund(h, big.id, 5_000_000n);
    await h.s.collateral.lock(
      h.program,
      big.id,
      { amount: 3_000_000n, currency: 'VES', clientKey: key() },
      big.actor
    );
    const rb = await h.s.credit.apply(
      h.program,
      big.id,
      { currency: 'VES', requestedLimit: 10_000_000n, clientKey: key() },
      big.actor
    );
    expect(rb.application.status).toBe('manual_review');
    expect(rb.line).toBeNull();
    const op = { kind: 'operator' as const, userId: crypto.randomUUID() };
    await expect(
      h.s.credit.decideReview(
        h.program,
        rb.application.id,
        { decision: 'approve', limit: 20_000_000n, reason: 'más' },
        op
      )
    ).rejects.toThrow();
    const decided = await h.s.credit.decideReview(
      h.program,
      rb.application.id,
      { decision: 'approve', limit: 9_000_000n, reason: 'Revisado' },
      op
    );
    expect(decided.status).toBe('approved');
    expect((await bal(h, big.id)).limit).toBe(9_000_000n);
  });

  it('no se libera garantía comprometida; se libera la sobrante y el límite se ajusta', async () => {
    const c = await creditReady(h, {
      funds: 1_200_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    // Compra con crédito de 1.5M (sin saldo suficiente ⇒ crédito).
    await h.s.cards.setLimits(
      h.program,
      c.card.id,
      { limitPerTx: null, limitDaily: null, fundingMode: 'credit_only' },
      c.actor
    );
    const a = await h.s.authorizations.authorize(h.program, {
      cardId: c.card.id,
      amount: 1_500_000n,
      currency: 'VES',
      merchantName: 'Ferretería',
      networkRef: key('net'),
      source: 'network',
    });
    expect(a.approved).toBe(true);
    // Exposición 1.5M ⇒ requiere ceil(1.5M/3) = 500k de garantía.
    await expect(
      h.s.collateral.release(
        h.program,
        c.id,
        { amount: 600_000n, currency: 'VES', clientKey: key() },
        c.actor
      )
    ).rejects.toBeInstanceOf(CollateralCommittedError);
    const ok = await h.s.collateral.release(
      h.program,
      c.id,
      { amount: 500_000n, currency: 'VES', clientKey: key() },
      c.actor
    );
    expect(ok.newLimit).toBe('1500000');
    const b = await bal(h, c.id);
    expect(b.collateral).toBe(500_000n);
    expect(b.creditAvailable).toBe(0n);
    // La garantía bloqueada nunca se gastó como pago: el saldo propio volvió íntegro.
    expect(b.available).toBe(700_000n);
  });
});

describe('tarjetas', () => {
  it('sin PAN ni CVV en el esquema ni en los datos; last4 y referencia opaca', async () => {
    const cols = await h.ctx.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('cards', 'card_payment_tokens', 'card_authorizations')`
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names.some((n) => /pan|cvv|cvc|card_number/i.test(n))).toBe(false);
    const c = await newConsumer(h);
    const card = await h.s.cards.issue(
      h.program,
      c.id,
      { currency: 'VES', form: 'virtual' },
      c.actor
    );
    expect(card.status).toBe('active');
    expect(card.last4).toMatch(/^[0-9]{4}$/);
    const raw = await h.ctx.admin.query(
      `SELECT row_to_json(k)::text AS j FROM cards k WHERE id = $1`,
      [card.id]
    );
    expect(raw.rows[0].j).not.toMatch(/[0-9]{12,19}/);
    const reveal = await h.s.cards.revealSession(h.program, card.id, c.actor);
    expect(reveal.mode).toBe('unavailable');
  });

  it('física: inactiva hasta la entrega; activar antes falla; envío sigue su orden', async () => {
    const c = await newConsumer(h);
    const card = await h.s.cards.issue(
      h.program,
      c.id,
      {
        currency: 'VES',
        form: 'physical',
        shipping: { addressLine: 'Av. Principal 123', city: 'Caracas' },
      },
      c.actor
    );
    expect(card.status).toBe('inactive');
    await expect(h.s.cards.activate(h.program, card.id, c.actor)).rejects.toThrow();
    await expect(
      h.s.cards.advanceShipment(h.program, card.id, 'delivered', { kind: 'system' })
    ).rejects.toThrow();
    for (const st of ['produced', 'shipped', 'delivered'] as const) {
      await h.s.events.ingest(h.program, {
        source: 'issuer',
        eventId: key('ship'),
        eventType: 'shipment.updated',
        payload: { card_id: card.id, status: st },
      });
    }
    const active = await h.s.cards.activate(h.program, card.id, c.actor);
    expect(active.status).toBe('active');
    expect(active.shipment!.history.map((x) => x.status)).toEqual([
      'requested',
      'produced',
      'shipped',
      'delivered',
    ]);
  });

  it('bloqueo: rechaza autorizaciones; bloqueo de Operaciones no lo levanta el cliente', async () => {
    const c = await newConsumer(h);
    await fund(h, c.id, 10_000n);
    const card = await h.s.cards.issue(
      h.program,
      c.id,
      { currency: 'VES', form: 'virtual' },
      c.actor
    );
    await h.s.cards.block(h.program, card.id, 'Revisión', {
      kind: 'operator',
      userId: crypto.randomUUID(),
    });
    const a = await h.s.authorizations.authorize(h.program, {
      cardId: card.id,
      amount: 1_000n,
      currency: 'VES',
      merchantName: 'X',
      networkRef: key('net'),
      source: 'network',
    });
    expect(a.approved).toBe(false);
    expect(a.declineCode).toBe('card_blocked');
    await expect(h.s.cards.unblock(h.program, card.id, 'yo', c.actor)).rejects.toThrow();
    await h.s.cards.unblock(h.program, card.id, 'ok', {
      kind: 'operator',
      userId: crypto.randomUUID(),
    });
    const b = await h.s.authorizations.authorize(h.program, {
      cardId: card.id,
      amount: 1_000n,
      currency: 'VES',
      merchantName: 'X',
      networkRef: key('net'),
      source: 'network',
    });
    expect(b.approved).toBe(true);
  });

  it('reemplazo: la anterior queda reemplazada y rechaza; la nueva funciona', async () => {
    const c = await newConsumer(h);
    await fund(h, c.id, 10_000n);
    const card = await h.s.cards.issue(
      h.program,
      c.id,
      { currency: 'VES', form: 'virtual' },
      c.actor
    );
    const neu = await h.s.cards.replace(h.program, card.id, { reason: 'Pérdida' }, c.actor);
    expect(neu.replacesCardId).toBe(card.id);
    expect((await h.s.cards.getCard(h.program, card.id, c.id)).status).toBe('replaced');
    const a = await h.s.authorizations.authorize(h.program, {
      cardId: card.id,
      amount: 500n,
      currency: 'VES',
      merchantName: 'X',
      networkRef: key('net'),
      source: 'network',
    });
    expect(a.declineCode).toBe('card_closed');
  });

  it('límites de la tarjeta por operación y por día', async () => {
    const c = await newConsumer(h);
    await fund(h, c.id, 100_000n);
    const card = await h.s.cards.issue(
      h.program,
      c.id,
      { currency: 'VES', form: 'virtual' },
      c.actor
    );
    await h.s.cards.setLimits(
      h.program,
      card.id,
      { limitPerTx: 30_000n, limitDaily: 50_000n },
      c.actor
    );
    const big = await h.s.authorizations.authorize(h.program, {
      cardId: card.id,
      amount: 40_000n,
      currency: 'VES',
      merchantName: 'X',
      networkRef: key('net'),
      source: 'network',
    });
    expect(big.declineCode).toBe('card_limit_exceeded');
    expect(
      (
        await h.s.authorizations.authorize(h.program, {
          cardId: card.id,
          amount: 30_000n,
          currency: 'VES',
          merchantName: 'X',
          networkRef: key('net'),
          source: 'network',
        })
      ).approved
    ).toBe(true);
    const day = await h.s.authorizations.authorize(h.program, {
      cardId: card.id,
      amount: 25_000n,
      currency: 'VES',
      merchantName: 'X',
      networkRef: key('net'),
      source: 'network',
    });
    expect(day.declineCode).toBe('card_limit_exceeded');
  });
});

describe('autorización, captura, reverso y devolución', () => {
  it('saldo propio primero y luego crédito; el crédito nunca entra en la wallet', async () => {
    const c = await creditReady(h, {
      funds: 1_300_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    // Saldo propio libre: 300k. Compra de 800k ⇒ 300k saldo + 500k crédito.
    const a = await h.s.authorizations.authorize(h.program, {
      cardId: c.card.id,
      amount: 800_000n,
      currency: 'VES',
      merchantName: 'Bodega',
      networkRef: key('net'),
      source: 'network',
    });
    expect(a.approved).toBe(true);
    expect(a.authorization!.walletAmount).toBe('300000');
    expect(a.authorization!.creditAmount).toBe('500000');
    let b = await bal(h, c.id);
    expect(b.available).toBe(0n);
    expect(b.held).toBe(300_000n);
    expect(b.reserved).toBe(500_000n);
    expect(b.creditAvailable).toBe(2_500_000n);
    // Captura parcial 600k: 300k saldo + 300k crédito; luego reverso del resto.
    await h.s.authorizations.capture(h.program, a.authorizationId!, {
      amount: 600_000n,
      idempotencyKey: 'cap-1',
    });
    // Reintento idempotente: misma clave, mismo resultado.
    await h.s.authorizations.capture(h.program, a.authorizationId!, {
      amount: 600_000n,
      idempotencyKey: 'cap-1',
    });
    const after = await h.s.authorizations.reverse(h.program, a.authorizationId!, {
      idempotencyKey: 'rev-1',
    });
    expect(after.status).toBe('captured');
    expect(after.capturedWallet).toBe('300000');
    expect(after.capturedCredit).toBe('300000');
    expect(after.releasedCredit).toBe('200000');
    b = await bal(h, c.id);
    expect(b.held).toBe(0n);
    expect(b.debt).toBe(300_000n);
    expect(b.reserved).toBe(0n);
    expect(b.creditAvailable).toBe(2_700_000n);
    expect(b.available).toBe(0n);
    expect(b.collateral).toBe(1_000_000n);
  });

  it('fondos insuficientes y límite excedido se rechazan sin efectos', async () => {
    const c = await newConsumer(h);
    await fund(h, c.id, 5_000n);
    const card = await h.s.cards.issue(
      h.program,
      c.id,
      { currency: 'VES', form: 'virtual' },
      c.actor
    );
    const a = await h.s.authorizations.authorize(h.program, {
      cardId: card.id,
      amount: 6_000n,
      currency: 'VES',
      merchantName: 'X',
      networkRef: key('net'),
      source: 'network',
    });
    expect(a.declineCode).toBe('insufficient_funds');
    expect((await bal(h, c.id)).available).toBe(5_000n);

    const k = await creditReady(h, {
      funds: 1_000_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    const x = await h.s.authorizations.authorize(h.program, {
      cardId: k.card.id,
      amount: 3_000_001n,
      currency: 'VES',
      merchantName: 'X',
      networkRef: key('net'),
      source: 'network',
    });
    expect(x.declineCode).toBe('credit_limit_exceeded');
    expect((await bal(h, k.id)).reserved).toBe(0n);
  });

  it('concurrencia: autorizaciones simultáneas nunca superan saldo + límite', async () => {
    const c = await creditReady(h, {
      funds: 1_100_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    // Capacidad total: 100k saldo + 3M crédito = 3.1M. 12 compras de 400k ⇒ caben 7.
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        h.s.authorizations.authorize(h.program, {
          cardId: c.card.id,
          amount: 400_000n,
          currency: 'VES',
          merchantName: 'X',
          networkRef: key('net'),
          source: 'network',
        })
      )
    );
    const approved = results.filter((r) => r.approved);
    expect(approved.length).toBe(7);
    expect(
      results.filter((r) => !r.approved).every((r) => r.declineCode === 'credit_limit_exceeded')
    ).toBe(true);
    const b = await bal(h, c.id);
    expect(b.held + b.reserved).toBe(2_800_000n);
    expect(b.reserved).toBeLessThanOrEqual(b.limit);
    // Capturas parciales concurrentes sobre una misma autorización no superan lo autorizado.
    const one = approved[0]!.authorizationId!;
    const caps = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        h.s.authorizations.capture(h.program, one, { amount: 100_000n, idempotencyKey: `pc-${i}` })
      )
    );
    expect(caps.filter((x) => x.status === 'fulfilled').length).toBe(4);
    const auth = await h.s.authorizations.get(h.program, one, null);
    expect(BigInt(auth.capturedWallet) + BigInt(auth.capturedCredit)).toBe(400_000n);
  });

  it('misma referencia de red ⇒ misma respuesta (sin doble reserva)', async () => {
    const c = await newConsumer(h);
    await fund(h, c.id, 10_000n);
    const card = await h.s.cards.issue(
      h.program,
      c.id,
      { currency: 'VES', form: 'virtual' },
      c.actor
    );
    const ref = key('net');
    const req = {
      cardId: card.id,
      amount: 4_000n,
      currency: 'VES',
      merchantName: 'X',
      networkRef: ref,
      source: 'network' as const,
    };
    const [a, b] = await Promise.all([
      h.s.authorizations.authorize(h.program, req),
      h.s.authorizations.authorize(h.program, req),
    ]);
    expect(a.authorizationId).toBe(b.authorizationId);
    expect((await bal(h, c.id)).held).toBe(4_000n);
  });
});

describe('cuotas', () => {
  it('código de cuotas: inicial con saldo propio, 3 cuotas exactas, pago y devolución parcial desde la última', async () => {
    const c = await creditReady(h, {
      funds: 1_600_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    const code = await h.s.cards.createPaymentCode(
      h.program,
      c.id,
      { cardId: c.card.id, mode: 'installments', installmentsCount: 3 },
      c.actor
    );
    expect(code.code.startsWith('fcp_')).toBe(true);
    expect(code.terms!.downPaymentBps).toBe(2_500);
    const a = await h.s.authorizations.authorize(h.program, {
      paymentCode: code.code,
      amount: 1_000_001n,
      currency: 'VES',
      merchantName: 'Electro',
      networkRef: key('net'),
      source: 'fluvia_checkout',
    });
    expect(a.approved).toBe(true);
    // Inicial = ceil(25 %) = 250 001; financiado 750 000.
    expect(a.authorization!.walletAmount).toBe('250001');
    expect(a.authorization!.creditAmount).toBe('750000');
    // El código es de un solo uso.
    await expect(
      h.s.authorizations.authorize(h.program, {
        paymentCode: code.code,
        amount: 10n,
        currency: 'VES',
        merchantName: 'Electro',
        networkRef: key('net'),
        source: 'fluvia_checkout',
      })
    ).rejects.toBeInstanceOf(PaymentCodeInvalidError);
    await h.s.authorizations.capture(h.program, a.authorizationId!, {
      amount: 1_000_001n,
      idempotencyKey: 'full',
    });
    let plans = await h.s.credit.listPlans(h.program, c.id, c.id);
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.downPayment).toBe('250001');
    expect(plan.installments.map((i) => i.amount)).toEqual(['250000', '250000', '250000']);
    expect(plan.installments.reduce((s, i) => s + BigInt(i.amount), 0n)).toBe(750_000n);

    // Pago de la primera cuota con saldo propio.
    await h.s.credit.repay(
      h.program,
      c.id,
      { currency: 'VES', amount: 250_000n, clientKey: key() },
      c.actor
    );
    expect((await bal(h, c.id)).debt).toBe(500_000n);

    // Devolución parcial de 300k: se atribuye al crédito y reduce cuotas desde la última.
    const r = await h.s.authorizations.refund(h.program, a.authorizationId!, {
      amount: 300_000n,
      idempotencyKey: 'ref-1',
    });
    expect(r.refundedCredit).toBe('300000');
    plans = await h.s.credit.listPlans(h.program, c.id, c.id);
    const inst = plans[0]!.installments;
    expect(inst[2]!.status).toBe('cancelled');
    expect(inst[1]!.cancelledAmount).toBe('50000');
    expect((await bal(h, c.id)).debt).toBe(200_000n);

    // Devolución del resto: deuda a cero; lo ya pagado del crédito vuelve como saldo propio.
    const before = (await bal(h, c.id)).available;
    await h.s.authorizations.refund(h.program, a.authorizationId!, {
      amount: 700_001n,
      idempotencyKey: 'ref-2',
    });
    const b = await bal(h, c.id);
    expect(b.debt).toBe(0n);
    // 450k atribuidos al crédito: 200k reducen deuda, 250k (cuota pagada) vuelven; + 250 001 inicial.
    expect(b.available - before).toBe(500_001n);
    plans = await h.s.credit.listPlans(h.program, c.id, c.id);
    expect(plans[0]!.status).toBe('paid');
  });

  it('vencidas: marcado explícito, caso abierto y aplicación de garantía con doble aprobación', async () => {
    const c = await creditReady(h, {
      funds: 1_000_000n,
      collateral: 1_000_000n,
      requested: 3_000_000n,
    });
    await h.s.cards.setLimits(
      h.program,
      c.card.id,
      { limitPerTx: null, limitDaily: null, fundingMode: 'credit_only' },
      c.actor
    );
    const a = await h.s.authorizations.authorize(h.program, {
      cardId: c.card.id,
      amount: 200_000n,
      currency: 'VES',
      merchantName: 'X',
      networkRef: key('net'),
      source: 'network',
    });
    await h.s.authorizations.capture(h.program, a.authorizationId!, {
      amount: 200_000n,
      idempotencyKey: 'cap-c',
    });
    const far = new Date(Date.now() + 90 * 86_400_000);
    const marked = await h.s.credit.markOverdue(h.program, far);
    expect(marked.marked).toBeGreaterThanOrEqual(1);
    const overdueCase = (
      await h.s.cases.list(h.program, { caseType: 'overdue_debt', consumerId: c.id })
    )[0];
    expect(overdueCase).toBeDefined();

    const [u1, u2] = [crypto.randomUUID(), crypto.randomUUID()];
    const approvals = await h.ctx.app.connect();
    approvals.release();
    // Propuesta y aprobación (persona distinta) de aplicar 200k de garantía.
    const { programs, collateral, credit } = h.s;
    const prop = await h.ctx.admin.query<{ id: string }>(
      `INSERT INTO program_approvals (tenant_id, action, subject_id, payload, reason, proposed_by_user_id)
       VALUES ($1, 'collateral.apply', $2, $3, 'Deuda vencida', $4) RETURNING id`,
      [h.program, c.id, JSON.stringify({ currency: 'VES', amount: '200000' }), u1]
    );
    await expect(
      programs.decideApproval(h.program, prop.rows[0]!.id, 'approve', {
        kind: 'operator',
        userId: u1,
      })
    ).rejects.toBeInstanceOf(FourEyesRequiredError);
    await programs.decideApproval(
      h.program,
      prop.rows[0]!.id,
      'approve',
      { kind: 'operator', userId: u2 },
      (cl, ap) =>
        collateral.applyWithin(
          cl,
          h.program,
          {
            consumerId: ap.subject_id,
            currency: 'VES',
            amount: 200_000n,
            reason: ap.reason,
            approvalId: ap.id,
          },
          { kind: 'operator', userId: u2 },
          credit
        )
    );
    const b = await bal(h, c.id);
    expect(b.debt).toBe(0n);
    expect(b.collateral).toBe(800_000n);
  });
});

describe('aislamiento', () => {
  it('un cliente no ve recursos de otro (RLS) y otra organización no ve el programa', async () => {
    const a = await newConsumer(h);
    const b = await newConsumer(h);
    const card = await h.s.cards.issue(
      h.program,
      a.id,
      { currency: 'VES', form: 'virtual' },
      a.actor
    );
    await expect(h.s.cards.getCard(h.program, card.id, b.id)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
    expect(await h.s.cards.listCards(h.program, {}, b.id)).toHaveLength(0);
    await expect(
      h.s.cards.createPaymentCode(h.program, b.id, { cardId: card.id, mode: 'wallet' }, b.actor)
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    const other = await h.ctx.createTenant('Otra organización');
    await expect(h.s.cards.getCard(other, card.id, null)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
    const rows = await h.ctx.app.query(`SELECT 1 FROM cards`);
    expect(rows.rowCount).toBe(0);
  });
});

describe('eventos de red fuera de orden y conciliación', () => {
  it('captura antes de la autorización: sin objeto ⇒ caso; reintento la aplica; duplicado no duplica', async () => {
    const c = await newConsumer(h);
    await fund(h, c.id, 50_000n);
    const card = await h.s.cards.issue(
      h.program,
      c.id,
      { currency: 'VES', form: 'virtual' },
      c.actor
    );
    const ref = key('net');
    const capture = {
      source: 'network' as const,
      eventId: key('cap'),
      eventType: 'capture',
      payload: { network_ref: ref, amount: '20000', capture_id: 'c1' },
    };
    expect((await h.s.events.ingest(h.program, capture)).status).toBe('unmatched');
    expect(
      (
        await h.s.events.ingest(h.program, {
          source: 'network',
          eventId: key('auth'),
          eventType: 'authorization.request',
          payload: {
            card_id: card.id,
            amount: '20000',
            currency: 'VES',
            merchant_name: 'Tienda externa',
            network_ref: ref,
          },
        })
      ).status
    ).toBe('applied');
    const retried = await h.s.events.retryUnmatched(h.program);
    expect(retried.applied).toBeGreaterThanOrEqual(1);
    expect((await h.s.events.ingest(h.program, capture)).status).toBe('duplicate');
    const auth = await h.s.authorizations.findByNetworkRef(h.program, ref);
    expect(auth!.status).toBe('captured');
    expect((await bal(h, c.id)).available).toBe(30_000n);
  });

  it('la conciliación interna cuadra ledger, autorizaciones, cuotas, proveedor e ingresos', async () => {
    const report = await h.s.reconciliation.run(h.program);
    const failed = report.checks.filter((x) => !x.ok);
    expect(failed).toEqual([]);
    expect(report.checks.length).toBeGreaterThanOrEqual(6);
  });
});
