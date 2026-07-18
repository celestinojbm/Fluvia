import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditContext } from '@fluvia/audit';
import { AuthService } from '@fluvia/auth';
import { withTenantTransaction, type Pool } from '@fluvia/db';
import {
  ApiKeyService,
  CustomerService,
  IdentityService,
  createOrganizationForUser,
} from '@fluvia/identity';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { OutboxRelay } from '@fluvia/outbox';
import {
  CheckoutSessionService,
  DisputeService,
  FlatBpsFeeSchedule,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PaymentLinkService,
  PayoutService,
  RefundService,
} from '@fluvia/payments-core';
import {
  CaseAdjustmentService,
  OperationalCaseService,
  ReconciliationService,
} from '@fluvia/reconciliation';
import {
  WebhookDeliverer,
  WebhookEndpointService,
  createWebhookFanoutPublisher,
} from '@fluvia/webhooks';
import {
  RESET_TARGET_DENYLIST,
  SHOWROOM_DB_ROLES,
  SHOWROOM_TARGET_DB,
  SHOWROOM_TEST_TARGET_RE,
} from './reset.js';

/**
 * Seed del SHOWROOM (F6.5C3) — dataset rico y deterministicamente SEMANTICO,
 * construido EXCLUSIVAMENTE por los servicios normativos del producto sobre la
 * organizacion dedicada `Showroom Fluvia` (separada de `Demo Fluvia`; el seed
 * minimo `seedDemo` queda intacto).
 *
 * Reglas duras:
 *  - Identidad SOLO por servicios: `AuthService.registerAndVerifySandbox`
 *    (C1) + `createOrganizationForUser` (C2) + `ensureMerchantForOnboarding`
 *    (C2) + `PostingService.ensureChart`. CERO INSERT/UPDATE de identidad.
 *  - Producto SOLO por servicios normativos (intents/checkout/links/customers/
 *    refunds/payouts/disputes/reconciliation/API keys/webhooks). CERO SQL de
 *    mutacion de dominio o de ledger. MockPaymentProvider es el UNICO provider.
 *  - SQL READ-ONLY unicamente para: comprobar base vacia, verificar
 *    post-condiciones y construir el manifiesto.
 *  - Politica de base VACIA (sin idempotencia universal): si existe cualquier
 *    rastro previo del showroom, el seed FALLA CLOSED sin mutar nada e indica
 *    ejecutar `demo:reset`. No hay reanudacion parcial: ante fallo a mitad, la
 *    base dedicada se reconstruye desde cero con `demo:reset`.
 *  - Los UUIDs fisicos los generan los servicios (no se fija ningun PK): el
 *    determinismo del dataset es SEMANTICO (ver manifest.ts).
 */

export class ShowroomEnvironmentError extends Error {
  constructor(env: string) {
    super(
      `Showroom seeds are forbidden in "${env}": sandbox credentials and synthetic data are local/test-only (F6.5C3)`
    );
    this.name = 'ShowroomEnvironmentError';
  }
}

/** La base NO esta vacia de showroom: fail-closed, cero mutaciones. */
export class ShowroomAlreadySeededError extends Error {
  constructor(marker: string) {
    super(
      `Showroom data already present (${marker}): seedShowroom only supports a freshly migrated, empty dedicated database. Run demo:reset to rebuild from scratch.`
    );
    this.name = 'ShowroomAlreadySeededError';
  }
}

/** Una post-condicion del dataset no se cumplio (estado inesperado). */
export class ShowroomSeedError extends Error {
  constructor(detail: string) {
    super(`seedShowroom postcondition failed: ${detail}`);
    this.name = 'ShowroomSeedError';
  }
}

/**
 * Los pools NO apuntan (todos y en vivo) a la base DEDICADA del showroom:
 * fail-closed, cero mutaciones. Distinto de ShowroomAlreadySeededError — aqui
 * el problema es el DESTINO, no el contenido.
 */
export class ShowroomDatabaseMismatchError extends Error {
  constructor(detail: string) {
    super(
      `seedShowroom blocked (wrong database): ${detail}. The showroom only runs against its dedicated database (${SHOWROOM_TARGET_DB} or fluvia_showroom_test_<id>); it NEVER touches the main database.`
    );
    this.name = 'ShowroomDatabaseMismatchError';
  }
}

export interface ShowroomPools {
  /** Superusuario local: plano de plataforma (org) + lecturas read-only. */
  admin: Pool;
  /** fluvia_app: TODOS los servicios de dominio bajo RLS. */
  app: Pool;
  /** fluvia_auth: registro sandbox atomico. */
  auth: Pool;
  /** fluvia_relay: outbox relay + fan-out de webhooks. */
  relay: Pool;
  /** fluvia_webhook: deliverer de webhooks salientes. */
  webhook: Pool;
}

/** Identificadores SEMANTICOS estables del showroom (jamas UUIDs fijados). */
export const SHOWROOM = {
  organizationName: 'Showroom Fluvia',
  slug: 'showroom-fluvia',
  merchantName: 'Showroom Store',
  country: 'CO',
  currency: 'COP',
  /** Mismo default de produccion (PLATFORM_FEE_BPS = 200, PEND-002). */
  platformFeeBps: 200,
  users: {
    owner: { email: 'owner@showroom.fluvia.test', password: 'showroom-owner-sandbox' },
    /** Segundo actor HUMANO del four-eyes (aprueba lo que el owner propone). */
    reviewer: { email: 'revisor@showroom.fluvia.test', password: 'showroom-revisor-sandbox' },
  },
  customers: {
    active: { name: 'Cliente Activo Showroom', email: 'cliente.activo@showroom.fluvia.test' },
    softDeleted: {
      name: 'Cliente Eliminado Showroom',
      email: 'cliente.eliminado@showroom.fluvia.test',
    },
  },
  apiKeyLabel: 'showroom-integration',
  /** Montos en unidades menores COP (exponente 0). Unicos por tipo de entidad:
   *  el monto ES el alias semantico dentro de cada tabla. */
  amounts: {
    intentSucceeded: 120_000n,
    intentDeclinedCard: 80_000n,
    intentDeclinedInsufficient: 90_000n,
    intentPse: 150_000n,
    intentCanceled: 70_000n,
    checkoutCompleted: 200_000n,
    checkoutOpen: 40_000n,
    checkoutExpired: 45_000n,
    refundTotalBase: 50_000n,
    refundPartialBase: 100_000n,
    refundPartialAmount: 40_000n,
    refundCanceledBase: 60_000n,
    refundCanceledAmount: 30_000n,
    funding: 500_000n,
    providerCashSettlement: 300_000n,
    release: 500_000n,
    payoutPaid: 300_000n,
    payoutFailed: 90_000n,
    disputeOpen: 45_000n,
    disputeUnderReview: 35_000n,
    disputeWon: 25_000n,
    disputeLost: 20_000n,
    settlementMismatchLine: 490_000n,
    settlementPhantomLine: 75_000n,
    adjustment: 75_000n,
  },
} as const;

export type ShowroomPhase =
  | 'preflight'
  | 'identity'
  | 'chart'
  | 'checkout-expiring'
  | 'customers'
  | 'payment-links'
  | 'payments'
  | 'checkout'
  | 'funding'
  | 'refunds'
  | 'payouts'
  | 'disputes'
  | 'refund-canceled'
  | 'payout-failed'
  | 'reconciliation'
  | 'four-eyes'
  | 'api-key'
  | 'webhooks'
  | 'await-expiry'
  | 'deliver'
  | 'verify';

export interface ShowroomSeedOptions {
  /** Observador de progreso (el CLI lo usa para narrar fases). */
  onPhase?: (phase: ShowroomPhase) => void;
  /** Poll de la expiracion normativa del checkout (default 3 s). */
  expiryPollMs?: number;
  /** Tope duro de espera de la expiracion (default 7 min: TTL minimo 5 min). */
  expiryTimeoutMs?: number;
}

/** Material sandbox LOCAL de demo: jamas entra al manifiesto ni a auditoria. */
export interface ShowroomSandboxMaterial {
  users: Array<{ email: string; password: string; role: 'owner' | 'reviewer' }>;
  apiKey: { label: string; keyPrefix: string; secret: string; environment: 'test' };
}

export interface ShowroomSeedResult {
  organizationId: string;
  merchantId: string;
  /** Credenciales sandbox — el CLI las muestra UNA sola vez tras el exito. */
  sandbox: ShowroomSandboxMaterial;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Referencia determinista del MockPaymentProvider para un attempt aprobado —
 * contrato PUBLICO del provider (`packages/payments-core/src/provider.ts`:
 * `mock_<sha256(attemptId)[0..24]>`, "mismo attempt -> misma referencia"). Se
 * computa aqui desde el attemptId devuelto por el servicio de confirmacion
 * para construir las lineas del settlement report SIN leer payment_attempts.
 */
function mockProviderRef(attemptId: string): string {
  return `mock_${createHash('sha256').update(attemptId).digest('hex').slice(0, 24)}`;
}

interface ShowroomServices {
  intents: PaymentIntentService;
  confirmation: PaymentConfirmationService;
  checkout: CheckoutSessionService;
  links: PaymentLinkService;
  customers: CustomerService;
  refunds: RefundService;
  payouts: PayoutService;
  disputes: DisputeService;
  posting: PostingService;
  ledger: LedgerService;
  identity: IdentityService;
  reconciliation: ReconciliationService;
  cases: OperationalCaseService;
  adjustments: CaseAdjustmentService;
  apiKeys: ApiKeyService;
  endpoints: WebhookEndpointService;
}

function buildServices(pools: ShowroomPools): ShowroomServices {
  const provider = new MockPaymentProvider();
  const intents = new PaymentIntentService(pools.app);
  const ledger = new LedgerService(pools.app);
  const posting = new PostingService(ledger, pools.app);
  const confirmation = new PaymentConfirmationService(
    pools.app,
    intents,
    posting,
    provider,
    new FlatBpsFeeSchedule(SHOWROOM.platformFeeBps)
  );
  const checkout = new CheckoutSessionService(pools.app, { confirmation });
  return {
    intents,
    confirmation,
    checkout,
    links: new PaymentLinkService(pools.app, { intents, checkout }),
    customers: new CustomerService(pools.app),
    refunds: new RefundService(pools.app, intents, posting, provider),
    payouts: new PayoutService(pools.app, posting, provider),
    disputes: new DisputeService(pools.app, posting),
    posting,
    ledger,
    identity: new IdentityService(pools.app),
    reconciliation: new ReconciliationService(pools.app),
    cases: new OperationalCaseService(pools.app),
    adjustments: new CaseAdjustmentService(pools.app, posting, {
      // Mismo default seguro de produccion (FOUR_EYES_THRESHOLD_MINOR = 0):
      // TODO ajuste exige un segundo aprobador humano distinto.
      fourEyesThresholdMinor: 0n,
    }),
    apiKeys: new ApiKeyService(pools.app),
    endpoints: new WebhookEndpointService(pools.app, {
      // Redes privadas SOLO en el sandbox local/test (mismo gate que el API).
      allowPrivateNetworks: true,
    }),
  };
}

/**
 * Defensa PROGRAMATICA en vivo (no solo del CLI): `seedShowroom` es exportado
 * y puede invocarse con pools arbitrarios, asi que ANTES de mirar contenido y
 * ANTES de cualquier mutacion se pregunta a la PROPIA base — read-only,
 * `current_database()` por CADA uno de los cinco pools — a donde apuntan de
 * verdad (jamas se confia solo en el pathname de una URL):
 *  - los cinco roles deben reportar EXACTAMENTE el mismo dbname;
 *  - ese dbname debe ser `fluvia_showroom` o `fluvia_showroom_test_<id>`;
 *  - `fluvia`/`postgres`/`template0`/`template1` (o cualquier otro nombre) se
 *    rechazan explicitamente.
 * Cualquier fallo (incluida una comprobacion que no responde) aborta ANTES de
 * crear el primer usuario, sin datos parciales.
 */
async function assertDedicatedDatabase(pools: ShowroomPools): Promise<void> {
  const reported: Array<[string, string]> = [];
  for (const role of SHOWROOM_DB_ROLES) {
    const res = await pools[role].query<{ db: string }>('SELECT current_database() AS db');
    const db = res.rows[0]?.db;
    if (!db) {
      throw new ShowroomDatabaseMismatchError(`pool "${role}" did not report current_database()`);
    }
    reported.push([role, db]);
  }
  const unique = new Set(reported.map(([, db]) => db));
  if (unique.size !== 1) {
    throw new ShowroomDatabaseMismatchError(
      `pools are connected to DIFFERENT databases: ${reported.map(([r, db]) => `${r}=${db}`).join(', ')}`
    );
  }
  const [db] = unique;
  if (RESET_TARGET_DENYLIST.has(db!)) {
    throw new ShowroomDatabaseMismatchError(`live current_database() is "${db}" (denylisted)`);
  }
  if (db !== SHOWROOM_TARGET_DB && !SHOWROOM_TEST_TARGET_RE.test(db!)) {
    throw new ShowroomDatabaseMismatchError(
      `live current_database() is "${db}", not a dedicated showroom database`
    );
  }
}

/** Comprobacion READ-ONLY de base vacia de showroom (fail-closed). */
async function assertShowroomEmpty(admin: Pool): Promise<void> {
  const org = await admin.query(
    `SELECT 1 FROM organizations WHERE name = $1 OR slug = $2 LIMIT 1`,
    [SHOWROOM.organizationName, SHOWROOM.slug]
  );
  if ((org.rowCount ?? 0) > 0) {
    throw new ShowroomAlreadySeededError(`organization "${SHOWROOM.organizationName}" exists`);
  }
  const users = await admin.query(
    `SELECT 1 FROM users WHERE email LIKE '%@showroom.fluvia.test' LIMIT 1`
  );
  if ((users.rowCount ?? 0) > 0) {
    throw new ShowroomAlreadySeededError('showroom users exist (possibly a partial run)');
  }
}

/** Confirma un intent por la via de dos fases del servicio real. */
async function confirmIntent(
  pools: ShowroomPools,
  services: ShowroomServices,
  tenantId: string,
  intentId: string,
  token: string
): Promise<string> {
  const begun = await withTenantTransaction(pools.app, tenantId, (c) =>
    services.confirmation.beginIn(c, tenantId, intentId)
  );
  await services.confirmation.execute(tenantId, begun.attemptId, token);
  return begun.attemptId;
}

async function expectIntentStatus(
  services: ShowroomServices,
  tenantId: string,
  intentId: string,
  expected: string,
  label: string
): Promise<void> {
  const dto = await services.intents.get(tenantId, intentId);
  if (dto.status !== expected) {
    throw new ShowroomSeedError(`${label}: expected intent status ${expected}, got ${dto.status}`);
  }
}

export async function seedShowroom(
  env: string,
  pools: ShowroomPools,
  options: ShowroomSeedOptions = {}
): Promise<ShowroomSeedResult> {
  // Guard duro de entorno ANTES de tocar la base (patron seedDemo/F1-10).
  if (env !== 'local' && env !== 'test') throw new ShowroomEnvironmentError(env);
  const phase = (p: ShowroomPhase) => options.onPhase?.(p);
  const A = SHOWROOM.amounts;
  const cop = (units: bigint) => Money.of(units, SHOWROOM.currency);

  phase('preflight');
  // Primero el DESTINO (defensa live contra pools que no apuntan a la base
  // dedicada), despues el CONTENIDO (base vacia de showroom).
  await assertDedicatedDatabase(pools);
  await assertShowroomEmpty(pools.admin);

  const services = buildServices(pools);

  // ------------------------------------------------------------------
  // Identidad y tenant (C1/C2): SOLO servicios, cero SQL de identidad.
  // ------------------------------------------------------------------
  phase('identity');
  // `allowSandboxRegistration` solo se activa tras el guard de entorno de
  // arriba: espejo exacto del gate local/test del API (F6.5C1/B6).
  const auth = new AuthService(pools.auth, { allowSandboxRegistration: true });
  const owner = await auth.registerAndVerifySandbox(SHOWROOM.users.owner);
  const reviewer = await auth.registerAndVerifySandbox(SHOWROOM.users.reviewer);

  const ownerCtx: AuditContext = { actorType: 'user', actorId: owner.userId, authMethod: 'none' };
  const reviewerCtx: AuditContext = {
    actorType: 'user',
    actorId: reviewer.userId,
    authMethod: 'none',
  };

  const org = await createOrganizationForUser(
    pools.admin,
    { userId: owner.userId, organizationName: SHOWROOM.organizationName, slug: SHOWROOM.slug },
    ownerCtx
  );
  const tenantId = org.organization.id;

  const onboarding = await services.identity.ensureMerchantForOnboarding(
    tenantId,
    { name: SHOWROOM.merchantName, country: SHOWROOM.country, defaultCurrency: SHOWROOM.currency },
    ownerCtx
  );
  const merchantId = onboarding.merchant.id;

  phase('chart');
  await services.posting.ensureChart(tenantId, merchantId, SHOWROOM.currency);

  const newIntent = (amount: bigint, description: string) =>
    services.intents.create({ tenantId, merchantId, amount: cop(amount), description });

  // ------------------------------------------------------------------
  // Sesion de checkout que EXPIRA: se crea PRIMERO (TTL minimo normativo de
  // 5 min) para que el reloj corra mientras se construye el resto; al final
  // la expiracion la produce la sincronizacion perezosa normativa del propio
  // servicio (fase await-expiry). Jamas se toca expires_at/status por SQL.
  // ------------------------------------------------------------------
  phase('checkout-expiring');
  const expiredIntent = await newIntent(A.checkoutExpired, 'Showroom: sesion que expira');
  const expiringSession = await withTenantTransaction(pools.app, tenantId, (c) =>
    services.checkout.createIn(c, tenantId, {
      paymentIntentId: expiredIntent.id,
      expiresInMinutes: 5,
    })
  );

  // ------------------------------------------------------------------
  // Customers: uno activo y uno soft-deleted (CustomerService).
  // ------------------------------------------------------------------
  phase('customers');
  await services.customers.create(tenantId, SHOWROOM.customers.active);
  const gone = await services.customers.create(tenantId, SHOWROOM.customers.softDeleted);
  await services.customers.softDelete(tenantId, gone.id);

  // ------------------------------------------------------------------
  // Payment links: uno activo y uno deshabilitado (PaymentLinkService).
  // ------------------------------------------------------------------
  phase('payment-links');
  await withTenantTransaction(pools.app, tenantId, (c) =>
    services.links.createIn(c, tenantId, {
      merchantId,
      amount: 25_000n,
      currency: SHOWROOM.currency,
      description: 'Link activo showroom',
    })
  );
  const disabledLink = await withTenantTransaction(pools.app, tenantId, (c) =>
    services.links.createIn(c, tenantId, {
      merchantId,
      amount: 30_000n,
      currency: SHOWROOM.currency,
      description: 'Link deshabilitado showroom',
    })
  );
  await services.links.disable(tenantId, disabledLink.id);

  // ------------------------------------------------------------------
  // Payment intents: cada estado por su via normativa (tokens del Mock).
  // ------------------------------------------------------------------
  phase('payments');
  const succeeded = await newIntent(A.intentSucceeded, 'Showroom: pago aprobado');
  const succeededAttempt = await confirmIntent(
    pools,
    services,
    tenantId,
    succeeded.id,
    'tok_approve'
  );
  await expectIntentStatus(services, tenantId, succeeded.id, 'succeeded', 'intent tok_approve');

  const declinedCard = await newIntent(A.intentDeclinedCard, 'Showroom: tarjeta rechazada');
  await confirmIntent(pools, services, tenantId, declinedCard.id, 'tok_decline');
  await expectIntentStatus(services, tenantId, declinedCard.id, 'failed', 'intent tok_decline');

  const declinedFunds = await newIntent(
    A.intentDeclinedInsufficient,
    'Showroom: fondos insuficientes'
  );
  await confirmIntent(pools, services, tenantId, declinedFunds.id, 'tok_decline_insufficient');
  await expectIntentStatus(
    services,
    tenantId,
    declinedFunds.id,
    'failed',
    'intent tok_decline_insufficient'
  );

  const pse = await newIntent(A.intentPse, 'Showroom: PSE asincrono en curso');
  await confirmIntent(pools, services, tenantId, pse.id, 'tok_pse');
  await expectIntentStatus(services, tenantId, pse.id, 'processing', 'intent tok_pse');

  const canceled = await newIntent(A.intentCanceled, 'Showroom: intent cancelado');
  await services.intents.transition(tenantId, canceled.id, 'canceled');

  // ------------------------------------------------------------------
  // Checkout sessions: completed (confirmacion real por client_secret con
  // tok_approve) y open. La expired ya esta corriendo su TTL.
  // ------------------------------------------------------------------
  phase('checkout');
  const completedIntent = await newIntent(A.checkoutCompleted, 'Showroom: checkout completado');
  const completedSession = await withTenantTransaction(pools.app, tenantId, (c) =>
    services.checkout.createIn(c, tenantId, { paymentIntentId: completedIntent.id })
  );
  const hostedView = await services.checkout.confirmByClientSecret(
    completedSession.id,
    completedSession.clientSecret,
    'tok_approve'
  );
  if (hostedView.status !== 'completed') {
    throw new ShowroomSeedError(`hosted checkout expected completed, got ${hostedView.status}`);
  }

  const openIntent = await newIntent(A.checkoutOpen, 'Showroom: checkout abierto');
  await withTenantTransaction(pools.app, tenantId, (c) =>
    services.checkout.createIn(c, tenantId, { paymentIntentId: openIntent.id })
  );

  // ------------------------------------------------------------------
  // Fondeo: captura grande + liquidacion del proveedor a caja + liberacion
  // pending -> available. Todo por PostingService (via normativa del ledger,
  // mismo patron que seedDemo).
  // ------------------------------------------------------------------
  phase('funding');
  const funding = await newIntent(A.funding, 'Showroom: venta grande (fondeo)');
  const fundingAttempt = await confirmIntent(pools, services, tenantId, funding.id, 'tok_approve');

  const postingBase = { tenantId, merchantId, sourceType: 'seed' };
  await services.posting.receiveProviderSettlement({
    ...postingBase,
    idempotencyKey: 'seed:showroom:provider-cash-1',
    sourceId: 'showroom-provider-cash-1',
    amount: cop(A.providerCashSettlement),
  });
  await services.posting.releaseSettlement({
    ...postingBase,
    idempotencyKey: 'seed:showroom:release-1',
    sourceId: 'showroom-release-1',
    amount: cop(A.release),
  });

  // ------------------------------------------------------------------
  // Refunds: total succeeded, parcial succeeded; el canceled se prepara aqui
  // (beginIn) y se ejecuta al final, cuando el disponible ya esta drenado por
  // movimientos normativos.
  // ------------------------------------------------------------------
  phase('refunds');
  const refundTotalBase = await newIntent(A.refundTotalBase, 'Showroom: venta reembolsada');
  const refundTotalAttempt = await confirmIntent(
    pools,
    services,
    tenantId,
    refundTotalBase.id,
    'tok_approve'
  );
  const refundTotal = await withTenantTransaction(pools.app, tenantId, (c) =>
    services.refunds.beginIn(c, tenantId, {
      paymentIntentId: refundTotalBase.id,
      reason: 'requested_by_customer',
    })
  );
  await services.refunds.execute(tenantId, refundTotal.id);
  await expectIntentStatus(services, tenantId, refundTotalBase.id, 'refunded', 'refund total');

  const refundPartialBase = await newIntent(
    A.refundPartialBase,
    'Showroom: venta con reembolso parcial'
  );
  const refundPartialAttempt = await confirmIntent(
    pools,
    services,
    tenantId,
    refundPartialBase.id,
    'tok_approve'
  );
  const refundPartial = await withTenantTransaction(pools.app, tenantId, (c) =>
    services.refunds.beginIn(c, tenantId, {
      paymentIntentId: refundPartialBase.id,
      amount: A.refundPartialAmount,
      reason: 'requested_by_customer',
    })
  );
  await services.refunds.execute(tenantId, refundPartial.id);
  await expectIntentStatus(
    services,
    tenantId,
    refundPartialBase.id,
    'partially_refunded',
    'refund parcial'
  );

  const refundCanceledBase = await newIntent(
    A.refundCanceledBase,
    'Showroom: venta con reembolso sin saldo'
  );
  const refundCanceledAttempt = await confirmIntent(
    pools,
    services,
    tenantId,
    refundCanceledBase.id,
    'tok_approve'
  );
  const refundCanceled = await withTenantTransaction(pools.app, tenantId, (c) =>
    services.refunds.beginIn(c, tenantId, {
      paymentIntentId: refundCanceledBase.id,
      amount: A.refundCanceledAmount,
      reason: 'requested_by_customer',
    })
  );

  // ------------------------------------------------------------------
  // Payouts: el failed se CREA con saldo valido y se ejecuta al final (cuando
  // el saldo ya se consumio por vias normativas); el paid se ejecuta ya.
  // ------------------------------------------------------------------
  phase('payouts');
  const payoutFailed = await services.payouts.create(tenantId, {
    merchantId,
    amount: A.payoutFailed,
    currency: SHOWROOM.currency,
    reason: 'Showroom: payout que fallara por saldo',
  });
  const payoutPaid = await services.payouts.create(tenantId, {
    merchantId,
    amount: A.payoutPaid,
    currency: SHOWROOM.currency,
    reason: 'Showroom: payout pagado',
  });
  await services.payouts.execute(tenantId, payoutPaid.id);
  {
    const dto = await services.payouts.get(tenantId, payoutPaid.id);
    if (dto.status !== 'paid') {
      throw new ShowroomSeedError(`payout paid: expected paid, got ${dto.status}`);
    }
  }

  // ------------------------------------------------------------------
  // Disputes: open / under_review / won / lost — el banco abre via
  // openFromProvider (misma via que el webhook firmado del inbox) y resuelve
  // por fuente verificada (DisputeService.resolve). Ademas de poblar el
  // dataset, los holds drenan el disponible para los fallos por saldo.
  // ------------------------------------------------------------------
  phase('disputes');
  const openDispute = async (amount: bigint, reason: string, ref: string) => {
    const res = await services.disputes.openFromProvider(tenantId, {
      merchantId,
      amount,
      currency: SHOWROOM.currency,
      reason,
      provider: 'mock',
      providerRef: ref,
    });
    return res.dispute;
  };
  await openDispute(A.disputeOpen, 'fraudulent', 'showroom-dispute-open');
  const underReview = await openDispute(
    A.disputeUnderReview,
    'product_not_received',
    'showroom-dispute-under-review'
  );
  await services.disputes.submitEvidence(tenantId, underReview.id);
  const won = await openDispute(A.disputeWon, 'fraudulent', 'showroom-dispute-won');
  if (
    (await services.disputes.resolve(tenantId, { disputeId: won.id, outcome: 'won' })) !== 'applied'
  ) {
    throw new ShowroomSeedError('dispute won: resolve was not applied');
  }
  const lost = await openDispute(A.disputeLost, 'product_unacceptable', 'showroom-dispute-lost');
  if (
    (await services.disputes.resolve(tenantId, { disputeId: lost.id, outcome: 'lost' })) !==
    'applied'
  ) {
    throw new ShowroomSeedError('dispute lost: resolve was not applied');
  }

  // ------------------------------------------------------------------
  // Refund canceled + payout failed: ambos por el guard REAL de
  // no-negatividad del ledger (AUD-P1-010) — el disponible quedo por debajo
  // de los montos tras refunds/payout/disputas normativos. Nada se fabrica.
  // ------------------------------------------------------------------
  phase('refund-canceled');
  await services.refunds.execute(tenantId, refundCanceled.id);
  {
    const dto = await services.refunds.get(tenantId, refundCanceled.id);
    if (dto.status !== 'canceled' || dto.failureCode !== 'insufficient_merchant_balance') {
      throw new ShowroomSeedError(
        `refund canceled: expected canceled/insufficient_merchant_balance, got ${dto.status}/${dto.failureCode}`
      );
    }
  }

  phase('payout-failed');
  await services.payouts.execute(tenantId, payoutFailed.id);
  {
    const dto = await services.payouts.get(tenantId, payoutFailed.id);
    if (dto.status !== 'failed' || dto.failureCode !== 'insufficient_merchant_balance') {
      throw new ShowroomSeedError(
        `payout failed: expected failed/insufficient_merchant_balance, got ${dto.status}/${dto.failureCode}`
      );
    }
  }

  // ------------------------------------------------------------------
  // Conciliacion: un settlement report con las CUATRO clases. Las referencias
  // del proveedor se computan del contrato determinista del MockProvider
  // (attemptId -> mock_<sha256>); el attempt del checkout alojado no lleva
  // linea a proposito => missing_at_provider.
  // ------------------------------------------------------------------
  phase('reconciliation');
  const now = Date.now();
  const report = await services.reconciliation.createReport(tenantId, {
    provider: 'mock',
    currency: SHOWROOM.currency,
    periodStart: new Date(now - 60 * 60 * 1000),
    periodEnd: new Date(now + 60 * 60 * 1000),
  });
  const settledAt = new Date(now);
  await services.reconciliation.addLines(tenantId, report.id, [
    { providerRef: mockProviderRef(succeededAttempt), amount: A.intentSucceeded, settledAt },
    { providerRef: mockProviderRef(refundTotalAttempt), amount: A.refundTotalBase, settledAt },
    { providerRef: mockProviderRef(refundPartialAttempt), amount: A.refundPartialBase, settledAt },
    {
      providerRef: mockProviderRef(refundCanceledAttempt),
      amount: A.refundCanceledBase,
      settledAt,
    },
    // Mismatch deliberado: el proveedor reporta menos de lo capturado.
    { providerRef: mockProviderRef(fundingAttempt), amount: A.settlementMismatchLine, settledAt },
    // Linea fantasma: el proveedor liquida algo que el ledger no conoce.
    { providerRef: 'showroom-phantom-settlement', amount: A.settlementPhantomLine, settledAt },
  ]);
  const summary = await services.reconciliation.reconcile(tenantId, report.id);
  if (
    summary.matched !== 4 ||
    summary.amount_mismatch !== 1 ||
    summary.missing_in_ledger !== 1 ||
    summary.missing_at_provider !== 1
  ) {
    throw new ShowroomSeedError(
      `reconciliation classes mismatch: ${JSON.stringify(summary)} (expected 4/1/1/1)`
    );
  }

  // Casos operativos (materializados por el motor): acknowledged sobre el
  // amount_mismatch; el missing_in_ledger se resuelve con el ajuste four-eyes.
  const allCases = await services.cases.list(tenantId, { limit: 200 });
  if (allCases.length !== 3) {
    throw new ShowroomSeedError(`expected 3 operational cases, got ${allCases.length}`);
  }
  const mismatchCase = allCases.find((c) => c.discrepancyStatus === 'amount_mismatch');
  const phantomCase = allCases.find((c) => c.discrepancyStatus === 'missing_in_ledger');
  if (!mismatchCase || !phantomCase) {
    throw new ShowroomSeedError('expected amount_mismatch and missing_in_ledger cases');
  }
  await services.cases.acknowledge(tenantId, mismatchCase.id, ownerCtx);

  // Four-eyes REAL: propone el owner, aprueba la revisora (actor humano
  // DISTINTO — el control de separacion del servicio y el CHECK de 0030 se
  // ejercen tal cual, sin debilitarse).
  phase('four-eyes');
  const proposed = await services.adjustments.propose(
    tenantId,
    phantomCase.id,
    {
      amount: A.adjustment,
      currency: SHOWROOM.currency,
      direction: 'debit_differences',
      reason: 'Liquidacion del proveedor sin contraparte en el ledger (showroom)',
    },
    ownerCtx
  );
  if (!proposed.requiresSecondApproval) {
    throw new ShowroomSeedError('adjustment should require second approval (threshold 0)');
  }
  const applied = await services.adjustments.approve(tenantId, proposed.id, reviewerCtx);
  if (applied.status !== 'applied' || applied.approvedByUserId !== reviewer.userId) {
    throw new ShowroomSeedError('four-eyes adjustment was not applied by the reviewer');
  }

  // ------------------------------------------------------------------
  // API key de integracion (mode test): el secreto se revela UNA vez en el
  // resultado (material sandbox del CLI) y JAMAS entra al manifiesto.
  // ------------------------------------------------------------------
  phase('api-key');
  const apiKey = await services.apiKeys.create(
    tenantId,
    { label: SHOWROOM.apiKeyLabel, scopes: ['read'], environment: 'test' },
    ownerCtx
  );

  // ------------------------------------------------------------------
  // Webhooks: receptor LOOPBACK propio (cero Internet). El endpoint
  // `delivered` se suscribe a checkout_session.completed (1 evento) y el
  // `dead` a checkout_session.expired (1 evento) y se deshabilita tras el
  // fan-out: el deliverer real lo mata en UN ciclo sin trafico de red.
  // ------------------------------------------------------------------
  phase('webhooks');
  const receiver: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200).end());
  });
  // Loopback EXPLICITO (jamas 0.0.0.0/::) y fallo de listen convertido en
  // rechazo limpio (sin handle colgado ni excepcion no capturada).
  await new Promise<void>((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(0, '127.0.0.1', () => {
      receiver.removeListener('error', reject);
      resolve();
    });
  });
  try {
    const receiverBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    await services.endpoints.create(
      tenantId,
      {
        url: `${receiverBase}/showroom/delivered`,
        events: ['checkout_session.completed'],
        description: 'Showroom: endpoint entregado',
      },
      { audit: ownerCtx }
    );
    const deadEndpoint = await services.endpoints.create(
      tenantId,
      {
        url: `${receiverBase}/showroom/dead`,
        events: ['checkout_session.expired'],
        description: 'Showroom: endpoint deshabilitado',
      },
      { audit: ownerCtx }
    );

    // Expiracion NORMATIVA de la sesion: se espera el TTL real (minimo 5 min
    // del servicio) y la sincronizacion perezosa del propio servicio produce
    // `expired` + su evento. Sin UPDATE de status ni de expires_at.
    phase('await-expiry');
    const pollMs = options.expiryPollMs ?? 3_000;
    const deadline = Date.now() + (options.expiryTimeoutMs ?? 7 * 60 * 1000);
    for (;;) {
      const view = await services.checkout.getByClientSecret(
        expiringSession.id,
        expiringSession.clientSecret
      );
      if (view.status === 'expired') break;
      if (view.status !== 'open') {
        throw new ShowroomSeedError(`expiring session reached unexpected status ${view.status}`);
      }
      if (Date.now() > deadline) {
        throw new ShowroomSeedError('expiring session did not expire within the wait budget');
      }
      await sleep(pollMs);
    }

    // Fan-out normativo: outbox relay real + publisher de webhooks (rol
    // relay). Se drena TODO el backlog del outbox de la base dedicada.
    phase('deliver');
    const relay = new OutboxRelay(pools.relay, createWebhookFanoutPublisher(pools.relay));
    for (;;) {
      const stats = await relay.runOnce();
      if (stats.claimed === 0) break;
    }
    // Deshabilitar el endpoint `dead` DESPUES del fan-out y ANTES del
    // deliverer: su cola pendiente muere en un ciclo, sin red (via probada en
    // delivery.test.ts).
    await services.endpoints.disable(tenantId, deadEndpoint.id, { audit: ownerCtx });

    const deliverer = new WebhookDeliverer(pools.webhook, {
      ssrf: { allowPrivateNetworks: true },
      requestTimeoutMs: 5_000,
    });
    for (;;) {
      const stats = await deliverer.runOnce();
      if (stats.claimed === 0) break;
    }
  } finally {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }

  // ------------------------------------------------------------------
  // Post-condiciones (READ-ONLY): el dataset y los balances quedaron EXACTOS.
  // ------------------------------------------------------------------
  phase('verify');
  await verifyPostconditions(pools.admin, tenantId);

  return {
    organizationId: tenantId,
    merchantId,
    sandbox: {
      users: [
        { ...SHOWROOM.users.owner, role: 'owner' },
        { ...SHOWROOM.users.reviewer, role: 'reviewer' },
      ],
      apiKey: {
        label: SHOWROOM.apiKeyLabel,
        keyPrefix: apiKey.keyPrefix,
        secret: apiKey.secret,
        environment: 'test',
      },
    },
  };
}

/** Balances finales EXACTOS del showroom (derivados de SHOWROOM.amounts). */
export const SHOWROOM_EXPECTED_BALANCES: Record<string, string> = {
  'provider.clearing': '620000',
  'provider.receivable': '0',
  'provider.payable': '0',
  'provider.fees': '0',
  'platform.fees': '20600',
  'platform.cash': '0',
  'payout.in_transit': '0',
  suspense: '-75000',
  'recon.differences': '75000',
  'merchant.pending': '509400',
  'merchant.available': '10000',
  'merchant.reserve': '0',
  'refund.liability': '0',
  'dispute.reserve': '80000',
};

async function verifyPostconditions(admin: Pool, tenantId: string): Promise<void> {
  const expectCount = async (label: string, sql: string, expected: number) => {
    const res = await admin.query<{ n: string }>(sql, [tenantId]);
    const n = Number(res.rows[0]!.n);
    if (n !== expected) throw new ShowroomSeedError(`${label}: expected ${expected}, got ${n}`);
  };

  await expectCount(
    'payment intents',
    `SELECT count(*)::text AS n FROM payment_intents WHERE tenant_id = $1`,
    12
  );
  await expectCount(
    'succeeded attempts',
    `SELECT count(*)::text AS n FROM payment_attempts WHERE tenant_id = $1 AND status = 'succeeded'`,
    6
  );
  await expectCount(
    'webhook events delivered',
    `SELECT count(*)::text AS n FROM webhook_events WHERE tenant_id = $1 AND status = 'delivered'`,
    1
  );
  await expectCount(
    'webhook events dead',
    `SELECT count(*)::text AS n FROM webhook_events WHERE tenant_id = $1 AND status = 'dead'`,
    1
  );
  await expectCount(
    'webhook events pending',
    `SELECT count(*)::text AS n FROM webhook_events WHERE tenant_id = $1 AND status = 'pending'`,
    0
  );

  const statuses = await admin.query<{ table_name: string; status: string; n: string }>(
    `SELECT 'checkout_sessions' AS table_name, status, count(*)::text AS n
       FROM checkout_sessions WHERE tenant_id = $1 GROUP BY status
     UNION ALL
     SELECT 'refunds', status, count(*)::text FROM refunds WHERE tenant_id = $1 GROUP BY status
     UNION ALL
     SELECT 'payouts', status, count(*)::text FROM payouts WHERE tenant_id = $1 GROUP BY status
     UNION ALL
     SELECT 'disputes', status, count(*)::text FROM disputes WHERE tenant_id = $1 GROUP BY status`,
    [tenantId]
  );
  const got = new Map(statuses.rows.map((r) => [`${r.table_name}:${r.status}`, Number(r.n)]));
  const expectedStatuses: Array<[string, number]> = [
    ['checkout_sessions:completed', 1],
    ['checkout_sessions:open', 1],
    ['checkout_sessions:expired', 1],
    ['refunds:succeeded', 2],
    ['refunds:canceled', 1],
    ['payouts:paid', 1],
    ['payouts:failed', 1],
    ['disputes:open', 1],
    ['disputes:under_review', 1],
    ['disputes:won', 1],
    ['disputes:lost', 1],
  ];
  for (const [key, expected] of expectedStatuses) {
    if ((got.get(key) ?? 0) !== expected) {
      throw new ShowroomSeedError(`${key}: expected ${expected}, got ${got.get(key) ?? 0}`);
    }
  }

  const balances = await admin.query<{ name: string; available: string }>(
    `SELECT la.name, COALESCE(bp.available, 0)::text AS available
     FROM ledger_accounts la
     LEFT JOIN balance_projections bp ON bp.account_id = la.id
     WHERE la.tenant_id = $1 AND la.deleted_at IS NULL`,
    [tenantId]
  );
  const byCode = new Map<string, bigint>();
  for (const row of balances.rows) {
    const code = row.name.includes(':') ? row.name.slice(0, row.name.indexOf(':')) : row.name;
    byCode.set(code, (byCode.get(code) ?? 0n) + BigInt(row.available));
  }
  for (const [code, expected] of Object.entries(SHOWROOM_EXPECTED_BALANCES)) {
    const actual = (byCode.get(code) ?? 0n).toString();
    if (actual !== expected) {
      throw new ShowroomSeedError(`balance ${code}: expected ${expected}, got ${actual}`);
    }
  }
}
