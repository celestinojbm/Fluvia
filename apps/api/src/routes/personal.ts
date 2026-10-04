import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertValidIdempotencyKey } from '@fluvia/idempotency';
import {
  ConsumerSessionInvalidError,
  MAX_LIVE_CARDS,
  parsePolicyParams,
  previewOffer,
  type PersonalServices,
  type ProgramActor,
} from '@fluvia/personal';
import { snake } from './wire.js';
import { registerPersonalShopRoutes, type PersonalShopDeps } from './shops.js';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './auth.js';
import { emailKey, ipKey, rateLimit, FixedWindowLimiter, type RateLimiter } from '../rate-limit.js';

/**
 * Fluvia Personal — plano del CLIENTE (consumidor).
 *
 * Autenticación propia: `Authorization: Bearer fluvia_csess_…` (credenciales y
 * sesiones en `consumers`/`consumer_sessions`, rol fluvia_auth). Una sesión de
 * comercio/operación (`fluvia_sess_`) no abre estas rutas y una de cliente no
 * abre las demás (prefijos y guardas distintos).
 *
 * Toda lectura y escritura corre con `app.consumer_id` fijado (RLS por
 * cliente): un id ajeno responde 404, indistinguible de inexistente.
 * Escrituras que mueven dinero exigen `Idempotency-Key` (clave del cliente;
 * el servicio la usa para replay exacto). Importes: enteros en unidades
 * menores como string decimal (sin coma flotante).
 */

/** Mercado del programa Fluvia Personal (monedas VES/USD). */
const PROGRAM_MARKET = 'VE';

declare module 'fastify' {
  interface FastifyRequest {
    consumer?: {
      consumerId: string;
      tenantId: string;
      sessionId: string;
      email?: string;
      displayName?: string;
    };
  }
}

const Minor = z
  .union([
    z.string().regex(/^[0-9]{1,16}$/),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, 'amount must be positive');
const Currency = z.string().regex(/^[A-Z]{3}$/);
const IdParam = z.object({ id: z.string().uuid() });
const ProgramParam = z.object({ programId: z.string().uuid() });

const RegisterBody = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(12).max(200),
    display_name: z.string().trim().min(1).max(80),
    synthetic_risk_profile: z.enum(['A', 'B', 'C', 'D']).optional(),
  })
  .strict();
const LoginBody = z
  .object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) })
  .strict();
const FundingBody = z
  .object({
    amount: Minor,
    currency: Currency,
    method: z.enum(['bank_transfer', 'mobile_payment', 'cash_agent']),
  })
  .strict();
const TransferBody = z
  .object({
    to_email: z.string().trim().email().max(254),
    amount: Minor,
    currency: Currency,
    note: z.string().trim().max(140).optional(),
  })
  .strict();
const WithdrawalBody = z
  .object({ amount: Minor, currency: Currency, destination: z.string().trim().min(4).max(40) })
  .strict();
const CollateralBody = z.object({ amount: Minor, currency: Currency }).strict();
const ApplicationBody = z.object({ currency: Currency, requested_limit: Minor }).strict();
const RepaymentBody = z
  .object({ currency: Currency, amount: Minor, plan_id: z.string().uuid().optional() })
  .strict();
const IssueCardBody = z
  .object({
    currency: Currency,
    form: z.enum(['virtual', 'physical']),
    funding_mode: z.enum(['wallet_first', 'wallet_only', 'credit_only']).optional(),
    shipping: z
      .object({
        address_line: z.string().trim().min(5).max(200),
        city: z.string().trim().min(2).max(80),
      })
      .strict()
      .optional(),
  })
  .strict();
const ReasonBody = z.object({ reason: z.string().trim().min(3).max(200) }).strict();
const ReplaceBody = z
  .object({
    reason: z.string().trim().min(3).max(200),
    shipping: z
      .object({
        address_line: z.string().trim().min(5).max(200),
        city: z.string().trim().min(2).max(80),
      })
      .strict()
      .optional(),
  })
  .strict();
const LimitsBody = z
  .object({
    limit_per_tx: Minor.nullable(),
    limit_daily: Minor.nullable(),
    funding_mode: z.enum(['wallet_first', 'wallet_only', 'credit_only']).optional(),
  })
  .strict();
const OfferQuery = z.object({
  count: z.coerce.number().int().min(1).max(24),
  amount: Minor,
  currency: Currency,
});
const PaymentCodeBody = z
  .object({
    card_id: z.string().uuid(),
    mode: z.enum(['wallet', 'installments']),
    installments_count: z.number().int().min(1).max(24).optional(),
    max_amount: Minor.optional(),
  })
  .strict();
const StatementQuery = z.object({
  currency: Currency,
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

function idemKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assertValidIdempotencyKey(value);
  return value!;
}

export function registerPersonalRoutes(
  app: FastifyInstance,
  deps: {
    personal: PersonalServices;
    rateLimits?: AuthRateLimits;
    limiter?: RateLimiter;
    /** Tiendas Fluvia (plano del cliente), si el servidor las cablea. */
    shop?: PersonalShopDeps;
  }
): void {
  const p = deps.personal;
  // Mismas ventanas y backend (Redis en despliegues compartidos) que /v1/auth/*,
  // con claves propias del plano del cliente.
  const limits = deps.rateLimits ?? DEFAULT_AUTH_RATE_LIMITS;
  const limiter = deps.limiter ?? new FixedWindowLimiter();
  const registerLimit = {
    preHandler: rateLimit(limiter, [
      { keyOf: ipKey('personal-register:ip'), rule: limits.registerPerIp },
    ]),
  };
  const loginLimit = {
    preHandler: rateLimit(limiter, [
      { keyOf: emailKey('personal-login:email'), rule: limits.loginPerEmail },
      { keyOf: ipKey('personal-login:ip'), rule: limits.loginPerIp },
    ]),
  };

  const consumerSession = async (req: FastifyRequest): Promise<void> => {
    const token = bearer(req);
    if (!token) throw new ConsumerSessionInvalidError();
    const id = await p.consumerAuth.authenticate(token);
    req.consumer = {
      consumerId: id.consumerId,
      tenantId: id.tenantId,
      sessionId: id.sessionId,
      email: id.email,
      displayName: id.displayName,
    };
  };
  const auth = { preHandler: [consumerSession] };
  const who = (req: FastifyRequest) => req.consumer!;
  const actor = (req: FastifyRequest): ProgramActor => ({
    kind: 'consumer',
    consumerId: req.consumer!.consumerId,
    audit: { requestId: String(req.id), ip: req.ip, userAgent: req.headers['user-agent'] },
  });
  const ctx = (req: FastifyRequest) => ({
    requestId: String(req.id),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // ── Condiciones públicas del programa ────────────────────────────────────
  // Lo que la presentación explica (cuotas, inicial, intervalo, límites) sale
  // de la política ACTIVA, no de textos fijos. Solo parámetros de producto;
  // la política de referencia es sintética y se declara así.
  const termsLimit = {
    preHandler: rateLimit(limiter, [
      { keyOf: ipKey('program-terms:ip'), rule: { max: 600, windowMs: 60_000 } },
    ]),
  };
  app.get('/v1/public/programs/:programId/terms', termsLimit, async (req) => {
    const { programId } = ProgramParam.parse(req.params);
    const program = await p.programs.getProgram(programId);
    const policy = await p.programs.getActivePolicy(programId);
    const params = parsePolicyParams(policy.params);
    return {
      object: 'program_terms',
      name: program.name,
      sandbox: program.sandbox,
      currencies: program.currencies,
      policy: {
        code: policy.code,
        version: policy.version,
        synthetic: policy.synthetic,
        pending_commercial_validation: policy.pendingCommercialValidation,
        installment_counts: params.installmentCounts,
        interval_days: params.intervalDays,
        down_payment_bps: params.downPaymentBps,
        interest_bps: params.interestBps,
        late_fee_bps: params.lateFeeBps,
        grace_days: params.graceDays,
        max_multiplier_bps: params.maxMultiplierBps,
        authorization_ttl_hours: params.authorizationTtlHours,
        limits: Object.fromEntries(
          Object.entries(params.currencies)
            .filter(([ccy]) => program.currencies.includes(ccy))
            .map(([ccy, r]) => [
              ccy,
              { min_collateral: Number(r.minCollateral), max_limit: Number(r.maxLimit) },
            ])
        ),
      },
      cards: { max_live: MAX_LIVE_CARDS },
    };
  });

  // ── Sesión ────────────────────────────────────────────────────────────────
  app.post('/v1/personal/programs/:programId/register', registerLimit, async (req, reply) => {
    const { programId } = ProgramParam.parse(req.params);
    const b = RegisterBody.parse(req.body);
    const r = await p.consumerAuth.register(
      programId,
      {
        email: b.email,
        password: b.password,
        displayName: b.display_name,
        syntheticRiskProfile: b.synthetic_risk_profile ?? 'B',
      },
      ctx(req)
    );
    return reply.code(201).send({ consumer_id: r.consumerId, session: r.session });
  });

  app.post('/v1/personal/programs/:programId/login', loginLimit, async (req) => {
    const { programId } = ProgramParam.parse(req.params);
    const b = LoginBody.parse(req.body);
    const r = await p.consumerAuth.login(programId, b.email, b.password, ctx(req));
    return { consumer_id: r.consumerId, session: r.session };
  });

  app.post('/v1/personal/logout', auth, async (req, reply) => {
    await p.consumerAuth.logout(bearer(req)!, ctx(req));
    return reply.code(204).send();
  });

  app.get('/v1/personal/me', auth, async (req) => {
    const id = await p.consumerAuth.authenticate(bearer(req)!);
    const program = await p.programs.getProgram(id.tenantId);
    const policy = await p.programs.getActivePolicy(id.tenantId);
    return snake({
      consumer: {
        id: id.consumerId,
        email: id.email,
        displayName: id.displayName,
        status: id.status,
      },
      program: {
        id: program.tenantId,
        name: program.name,
        currencies: program.currencies,
        sandbox: program.sandbox,
      },
      policy: {
        code: policy.code,
        version: policy.version,
        synthetic: policy.synthetic,
        pendingCommercialValidation: policy.pendingCommercialValidation,
        installmentCounts: policy.params.installmentCounts,
        downPaymentBps: policy.params.downPaymentBps,
        intervalDays: policy.params.intervalDays,
        interestBps: policy.params.interestBps,
        // Referencia del límite por garantía (máximo ilustrativo por nivel; no
        // es una concesión): el cliente ve la regla que se le aplicará.
        maxMultiplierBps: policy.params.maxMultiplierBps,
        tiers: policy.params.tiers,
      },
    });
  });

  // ── Inicio: saldos separados + próximos pagos + actividad ─────────────────
  app.get('/v1/personal/overview', auth, async (req) => {
    const { tenantId, consumerId } = who(req);
    const [balances, upcoming, cards, applications] = await Promise.all([
      p.wallet.balances(tenantId, consumerId),
      p.credit.upcoming(tenantId, consumerId, consumerId),
      p.cards.listCards(tenantId, { consumerId }, consumerId),
      p.credit.listApplications(tenantId, { consumerId }, consumerId),
    ]);
    const recent = balances.length
      ? // Las reservas internas («retenido») no son actividad para el cliente:
        // la compra ya aparece como salida de su saldo disponible.
        (await p.wallet.statement(tenantId, consumerId, balances[0]!.currency, { limit: 20 }))
          .filter((l) => l.account !== 'held')
          .slice(0, 6)
      : [];
    return snake({
      balances,
      upcoming: upcoming.slice(0, 6),
      cards: cards.filter((c) => c.status !== 'replaced' && c.status !== 'closed'),
      pendingApplication: applications.find((a) => a.status === 'manual_review') ?? null,
      recent,
    });
  });

  // ── Wallet ────────────────────────────────────────────────────────────────
  app.get('/v1/personal/wallet/balances', auth, async (req) =>
    snake({ data: await p.wallet.balances(who(req).tenantId, who(req).consumerId) })
  );

  app.get('/v1/personal/wallet/statement', auth, async (req) => {
    const q = StatementQuery.parse(req.query);
    const lines = await p.wallet.statement(who(req).tenantId, who(req).consumerId, q.currency, {
      ...(q.before ? { before: q.before } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
    return snake({ data: lines });
  });

  app.get('/v1/personal/wallet/fundings', auth, async (req) =>
    snake({ data: await p.wallet.listFundings(who(req).tenantId, who(req).consumerId) })
  );

  app.post('/v1/personal/wallet/fundings', auth, async (req, reply) => {
    const b = FundingBody.parse(req.body);
    const r = await p.wallet.requestFunding(
      who(req).tenantId,
      who(req).consumerId,
      { amount: b.amount, currency: b.currency, method: b.method, clientKey: idemKey(req) },
      actor(req)
    );
    return reply.code(201).send(snake(r));
  });

  app.get('/v1/personal/wallet/transfers', auth, async (req) =>
    snake({ data: await p.wallet.listTransfers(who(req).tenantId, who(req).consumerId) })
  );

  app.post('/v1/personal/wallet/transfers', auth, async (req, reply) => {
    const b = TransferBody.parse(req.body);
    const t = await p.wallet.transferP2P(
      who(req).tenantId,
      who(req).consumerId,
      {
        toEmail: b.to_email,
        amount: b.amount,
        currency: b.currency,
        ...(b.note ? { note: b.note } : {}),
        clientKey: idemKey(req),
      },
      actor(req)
    );
    return reply.code(201).send(snake(t));
  });

  app.post('/v1/personal/wallet/withdrawals', auth, async (req, reply) => {
    const b = WithdrawalBody.parse(req.body);
    const t = await p.wallet.withdraw(
      who(req).tenantId,
      who(req).consumerId,
      {
        amount: b.amount,
        currency: b.currency,
        destination: b.destination,
        clientKey: idemKey(req),
      },
      actor(req)
    );
    return reply.code(t.status === 'completed' ? 201 : 202).send(snake(t));
  });

  // ── Garantía ──────────────────────────────────────────────────────────────
  app.post('/v1/personal/collateral/lock', auth, async (req, reply) => {
    const b = CollateralBody.parse(req.body);
    const r = await p.collateral.lock(
      who(req).tenantId,
      who(req).consumerId,
      { ...b, clientKey: idemKey(req) },
      actor(req)
    );
    return reply.code(201).send(snake(r));
  });

  app.post('/v1/personal/collateral/release', auth, async (req, reply) => {
    const b = CollateralBody.parse(req.body);
    const r = await p.collateral.release(
      who(req).tenantId,
      who(req).consumerId,
      { ...b, clientKey: idemKey(req) },
      actor(req)
    );
    return reply.code(201).send(snake(r));
  });

  // ── Crédito ───────────────────────────────────────────────────────────────
  app.get('/v1/personal/credit', auth, async (req) => {
    const { tenantId, consumerId } = who(req);
    const [lines, applications, policy] = await Promise.all([
      p.credit.listLines(tenantId, consumerId, consumerId),
      p.credit.listApplications(tenantId, { consumerId }, consumerId),
      p.programs.getActivePolicy(tenantId),
    ]);
    return snake({
      lines,
      applications,
      policy: {
        code: policy.code,
        version: policy.version,
        synthetic: policy.synthetic,
        pendingCommercialValidation: policy.pendingCommercialValidation,
        params: policy.params,
      },
    });
  });

  app.post('/v1/personal/credit/applications', auth, async (req, reply) => {
    const b = ApplicationBody.parse(req.body);
    const r = await p.credit.apply(
      who(req).tenantId,
      who(req).consumerId,
      { currency: b.currency, requestedLimit: b.requested_limit, clientKey: idemKey(req) },
      actor(req)
    );
    return reply.code(201).send(snake(r));
  });

  app.get('/v1/personal/credit/plans', auth, async (req) =>
    snake({
      data: await p.credit.listPlans(who(req).tenantId, who(req).consumerId, who(req).consumerId),
    })
  );

  app.get('/v1/personal/credit/plans/:id', auth, async (req) => {
    const { id } = IdParam.parse(req.params);
    return snake(await p.credit.getPlan(who(req).tenantId, id, who(req).consumerId));
  });

  app.post('/v1/personal/credit/repayments', auth, async (req, reply) => {
    const b = RepaymentBody.parse(req.body);
    const r = await p.credit.repay(
      who(req).tenantId,
      who(req).consumerId,
      {
        currency: b.currency,
        amount: b.amount,
        ...(b.plan_id ? { planId: b.plan_id } : {}),
        clientKey: idemKey(req),
      },
      actor(req)
    );
    return reply.code(201).send(snake(r));
  });

  // ── Tarjetas ──────────────────────────────────────────────────────────────
  app.get('/v1/personal/cards', auth, async (req) =>
    snake({
      data: await p.cards.listCards(
        who(req).tenantId,
        { consumerId: who(req).consumerId },
        who(req).consumerId
      ),
    })
  );

  app.post('/v1/personal/cards', auth, async (req, reply) => {
    const b = IssueCardBody.parse(req.body);
    const card = await p.cards.issue(
      who(req).tenantId,
      who(req).consumerId,
      {
        currency: b.currency,
        form: b.form,
        ...(b.funding_mode ? { fundingMode: b.funding_mode } : {}),
        ...(b.shipping
          ? { shipping: { addressLine: b.shipping.address_line, city: b.shipping.city } }
          : {}),
      },
      actor(req)
    );
    return reply.code(201).send(snake(card));
  });

  app.get('/v1/personal/cards/:id', auth, async (req) => {
    const { id } = IdParam.parse(req.params);
    const { tenantId, consumerId } = who(req);
    const card = await p.cards.getCard(tenantId, id, consumerId);
    const authorizations = await p.authorizations.list(tenantId, { cardId: id }, consumerId);
    return snake({ card, authorizations: authorizations.slice(0, 50) });
  });

  const cardAction = (path: string, run: (req: FastifyRequest, id: string) => Promise<unknown>) =>
    app.post(`/v1/personal/cards/:id/${path}`, auth, async (req) => {
      const { id } = IdParam.parse(req.params);
      return snake(await run(req, id));
    });
  cardAction('activate', (req, id) => p.cards.activate(who(req).tenantId, id, actor(req)));
  cardAction('block', (req, id) =>
    p.cards.block(
      who(req).tenantId,
      id,
      ReasonBody.parse(req.body ?? { reason: 'Bloqueo del cliente' }).reason,
      actor(req)
    )
  );
  cardAction('unblock', (req, id) =>
    p.cards.unblock(
      who(req).tenantId,
      id,
      ReasonBody.parse(req.body ?? { reason: 'Desbloqueo del cliente' }).reason,
      actor(req)
    )
  );
  cardAction('close', (req, id) =>
    p.cards.close(who(req).tenantId, id, ReasonBody.parse(req.body).reason, actor(req))
  );
  cardAction('replace', (req, id) => {
    const b = ReplaceBody.parse(req.body);
    return p.cards.replace(
      who(req).tenantId,
      id,
      {
        reason: b.reason,
        ...(b.shipping
          ? { shipping: { addressLine: b.shipping.address_line, city: b.shipping.city } }
          : {}),
      },
      actor(req)
    );
  });
  cardAction('limits', (req, id) => {
    const b = LimitsBody.parse(req.body);
    return p.cards.setLimits(
      who(req).tenantId,
      id,
      {
        limitPerTx: b.limit_per_tx,
        limitDaily: b.limit_daily,
        ...(b.funding_mode ? { fundingMode: b.funding_mode } : {}),
      },
      actor(req)
    );
  });
  cardAction('reveal', (req, id) => p.cards.revealSession(who(req).tenantId, id, actor(req)));

  // ── Compras: oferta, código de pago y movimientos ─────────────────────────
  app.get('/v1/personal/offers/installments', auth, async (req) => {
    const q = OfferQuery.parse(req.query);
    const offer = await p.cards.installmentOffer(who(req).tenantId, q.count);
    return snake(previewOffer(q.amount, q.currency, offer));
  });

  app.post('/v1/personal/payment-codes', auth, async (req, reply) => {
    const b = PaymentCodeBody.parse(req.body);
    // Un código de pago solo se emite si el método existe en el mercado del
    // programa (Fluvia Personal opera en VES/USD: Venezuela).
    await deps.shop?.capabilities.require(
      PROGRAM_MARKET,
      b.mode === 'installments' ? 'pay.installments' : 'pay.wallet'
    );
    const r = await p.cards.createPaymentCode(
      who(req).tenantId,
      who(req).consumerId,
      {
        cardId: b.card_id,
        mode: b.mode,
        ...(b.installments_count ? { installmentsCount: b.installments_count } : {}),
        ...(b.max_amount ? { maxAmount: b.max_amount } : {}),
      },
      actor(req)
    );
    reply.header('cache-control', 'no-store');
    return reply.code(201).send(snake(r));
  });

  app.get('/v1/personal/purchases', auth, async (req) => {
    const list = await p.authorizations.list(
      who(req).tenantId,
      { consumerId: who(req).consumerId },
      who(req).consumerId
    );
    // `journey_ref`: la venta o el pedido del comercio de esa compra. Actividad
    // lo usa para no mostrar dos veces la misma operación (pedido + tarjeta).
    const refs = deps.shop
      ? await deps.shop.journeys.refsForAuthorizations(
          list.map((a) => ({ id: a.id, merchantRef: a.merchantRef, networkRef: a.networkRef }))
        )
      : new Map<string, string>();
    return snake({ data: list.map((a) => ({ ...a, journeyRef: refs.get(a.id) ?? null })) });
  });

  app.get('/v1/personal/purchases/:id', auth, async (req) => {
    const { id } = IdParam.parse(req.params);
    const { tenantId, consumerId } = who(req);
    const authorization = await p.authorizations.get(tenantId, id, consumerId);
    const plans = (await p.credit.listPlans(tenantId, consumerId, consumerId)).filter(
      (x) => x.authorizationId === id
    );
    return snake({ authorization, plans });
  });

  if (deps.shop) registerPersonalShopRoutes(app, { ...deps.shop, personal: p, auth, who, actor });
}
