import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { deriveOrderPayment, type OrderDetailDto, type OrderService } from '@fluvia/commerce';
import { SALE_RELEASING_STATUSES } from '@fluvia/payments-core';
import { withProgramTx } from '@fluvia/personal';
import { isMarket, type Market } from '@fluvia/capabilities';
import { outcomeOf } from './routes/shops.js';

/**
 * «Journey» = UNA operación de compra vista por las tres superficies.
 *
 * Fuentes canónicas (nada se recalcula ni se guarda aparte):
 *  - Comercio (tenant del comercio): venta = payment_link de cobro único;
 *    pedido opcional (`commerce_orders`); estado de pago DERIVADO de los
 *    intents del enlace (`deriveOrderPayment`, la misma regla del POS);
 *    attempts, devoluciones, asientos (`attempt:<id>:*`, `refund:<id>:*`) y la
 *    bitácora de verificaciones (0067).
 *  - Emisor (tenant del programa): `card_authorizations` cuya
 *    `network_ref = acq:<attempt_id>` (la red Fluvia la fija al autorizar) y
 *    sus asientos `auth:<id>:*`.
 *
 * `journey_ref` = id del pedido si la venta tiene pedido; si no, id del
 * enlace de cobro. Tres proyecciones con el MISMO núcleo; difieren solo en
 * qué campos ve cada audiencia.
 */

/** Dónde vive la venta: tenant del comercio + pedido/enlace o attempt de la red. */
interface Target {
  tenantId: string;
  ref: string;
  attemptId?: string;
}

export class JourneyNotFoundError extends Error {
  constructor() {
    super('Journey not found');
    this.name = 'JourneyNotFoundError';
  }
}

export type JourneyChannel = 'shop' | 'pos' | 'restaurant' | 'in_person' | 'payment_link';
export type Audience = 'consumer' | 'merchant' | 'operator';

const CHARGED = ['succeeded', 'partially_refunded', 'refunded'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTEMPT_OPEN = new Set(['created', 'submitting', 'submitted', 'requires_action']);
const REFUND_UNCERTAIN = new Set(['created', 'processing', 'indeterminate']);

interface AttemptRow {
  id: string;
  intent_id: string;
  attempt_number: number;
  status: string;
  provider_ref: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}
interface RefundRow {
  id: string;
  payment_intent_id: string;
  amount: string;
  status: string;
  reason: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}
interface LedgerRow {
  id: string;
  reason: string;
  idempotency_key: string;
  created_at: Date;
}
interface VerificationRow {
  subject_id: string;
  verdict: string;
  triggered_by: string;
  checked_at: Date;
}
interface AuthRow {
  id: string;
  consumer_id: string;
  status: string;
  currency: string;
  amount: string;
  wallet_amount: string;
  credit_amount: string;
  captured_wallet: string;
  captured_credit: string;
  refunded_wallet: string;
  refunded_credit: string;
  installments_count: number | null;
  decline_code: string | null;
  network_ref: string;
  merchant_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Lado del comercio, leído en SU tenant. */
interface MerchantSide {
  tenantId: string;
  journeyRef: string;
  linkId: string;
  channel: JourneyChannel;
  merchantName: string;
  merchantSlug: string | null;
  market: string;
  currency: string;
  total: bigint;
  createdAt: string;
  order: OrderDetailDto | null;
  payment: ReturnType<typeof deriveOrderPayment>;
  attempts: AttemptRow[];
  refunds: RefundRow[];
  ledger: LedgerRow[];
  verifications: Map<string, VerificationRow>;
  shop: {
    fulfillment: 'pickup' | 'delivery';
    fulfillmentStatus: string;
    deliveryAddress: string | null;
    returnRequestedAt: string | null;
    returnReason: string | null;
    programTenantId: string;
    consumerId: string;
    buyerName: string;
  } | null;
}

interface IssuerSide {
  authorizations: AuthRow[];
  ledger: LedgerRow[];
  cases: Array<{
    id: string;
    case_type: string;
    status: string;
    summary: string;
    created_at: Date;
  }>;
}

export interface UncertainItem {
  kind: 'payment' | 'refund';
  subjectId: string;
  status: string;
  since: string;
  lastVerification: { at: string; verdict: string; by: string } | null;
  nextStep: string;
  resolvers: string[];
  /**
   * Solo Operaciones: CONSULTA de solo lectura al registro del emisor (la
   * autorización de la red Fluvia). No resuelve nada: muestra si el emisor
   * aprobó, rechazó o no tiene registro del intento.
   */
  issuerRecord?: 'approved' | 'captured' | 'declined' | 'reversed' | 'no_record' | string;
}

export class JourneyService {
  constructor(
    private readonly appPool: Pool,
    private readonly orders: OrderService,
    private readonly programTenantId: string | undefined
  ) {}

  // ── Resolución por audiencia ────────────────────────────────────────────

  /** Cliente: su pedido de Tiendas o su compra con tarjeta Fluvia. */
  async forConsumer(programTenantId: string, consumerId: string, ref: string) {
    if (!UUID.test(ref)) throw new JourneyNotFoundError();
    const target = await withProgramTx<Target | null>(
      this.appPool,
      programTenantId,
      consumerId,
      async (c) => {
        const shop = await c.query<{ shop_tenant_id: string; order_id: string }>(
          `SELECT shop_tenant_id, order_id FROM consumer_shop_orders
          WHERE consumer_id = $1 AND order_id = $2`,
          [consumerId, ref]
        );
        if (shop.rows[0]) {
          return { tenantId: shop.rows[0].shop_tenant_id, ref: shop.rows[0].order_id } as Target;
        }
        const auth = await c.query<{ merchant_ref: string | null; network_ref: string }>(
          `SELECT merchant_ref, network_ref FROM card_authorizations
          WHERE consumer_id = $1 AND id = $2`,
          [consumerId, ref]
        );
        return auth.rows[0] ? fromNetwork(auth.rows[0]) : null;
      }
    );
    if (!target) throw new JourneyNotFoundError();
    const merchant = await this.readMerchant(target.tenantId, target.ref, target.attemptId);
    // Solo SUS autorizaciones (RLS del cliente) y nunca otra persona.
    const issuer = await this.readIssuer(programTenantId, consumerId, merchant.attempts);
    if (
      !issuer.authorizations.length &&
      !(merchant.shop && merchant.shop.consumerId === consumerId)
    ) {
      throw new JourneyNotFoundError();
    }
    return this.projectConsumer(merchant, issuer);
  }

  /** Comercio: venta o pedido de SU organización. */
  async forMerchant(tenantId: string, ref: string) {
    if (!UUID.test(ref)) throw new JourneyNotFoundError();
    const merchant = await this.readMerchant(tenantId, ref);
    return this.projectMerchant(merchant);
  }

  /** Operaciones (organización programa): desde la autorización o el pedido de Tiendas. */
  async forOperator(programTenantId: string, ref: string) {
    if (!UUID.test(ref)) throw new JourneyNotFoundError();
    const target = await withProgramTx<Target | null>(
      this.appPool,
      programTenantId,
      null,
      async (c) => {
        const auth = await c.query<{ merchant_ref: string | null; network_ref: string }>(
          `SELECT merchant_ref, network_ref FROM card_authorizations WHERE id = $1`,
          [ref]
        );
        if (auth.rows[0]) return fromNetwork(auth.rows[0]);
        const shop = await c.query<{ shop_tenant_id: string; order_id: string }>(
          `SELECT shop_tenant_id, order_id FROM consumer_shop_orders WHERE order_id = $1 LIMIT 1`,
          [ref]
        );
        return shop.rows[0]
          ? { tenantId: shop.rows[0].shop_tenant_id, ref: shop.rows[0].order_id }
          : null;
      }
    );
    if (!target) throw new JourneyNotFoundError();
    const merchant = await this.readMerchant(target.tenantId, target.ref, target.attemptId);
    const issuer = await this.readIssuer(programTenantId, null, merchant.attempts);
    return this.projectOperator(merchant, issuer);
  }

  /**
   * `journey_ref` de cada compra con tarjeta del cliente (para no listar dos
   * veces la misma compra en Actividad). Una consulta por comercio.
   */
  async refsForAuthorizations(
    auths: Array<{ id: string; merchantRef: string | null; networkRef: string }>
  ): Promise<Map<string, string>> {
    const byTenant = new Map<string, Array<{ authId: string; attemptId: string }>>();
    for (const a of auths) {
      const t = fromNetwork({ merchant_ref: a.merchantRef, network_ref: a.networkRef });
      if (!t?.attemptId) continue;
      byTenant.set(t.tenantId, [
        ...(byTenant.get(t.tenantId) ?? []),
        { authId: a.id, attemptId: t.attemptId },
      ]);
    }
    const out = new Map<string, string>();
    for (const [tenantId, list] of byTenant) {
      const r = await withTenantTransaction(this.appPool, tenantId, (c) =>
        c.query<{ attempt_id: string; journey_ref: string }>(
          `SELECT a.id AS attempt_id, COALESCE(o.id, i.payment_link_id) AS journey_ref
             FROM payment_attempts a
             JOIN payment_intents i ON i.id = a.intent_id
             LEFT JOIN commerce_orders o ON o.payment_link_id = i.payment_link_id
            WHERE a.id = ANY($1::uuid[]) AND i.payment_link_id IS NOT NULL`,
          [list.map((x) => x.attemptId)]
        )
      );
      const byAttempt = new Map(r.rows.map((x) => [x.attempt_id, x.journey_ref]));
      for (const x of list) {
        const ref = byAttempt.get(x.attemptId);
        if (ref) out.set(x.authId, ref);
      }
    }
    return out;
  }

  // ── Lecturas canónicas ───────────────────────────────────────────────────

  private async readMerchant(
    tenantId: string,
    ref: string,
    attemptId?: string
  ): Promise<MerchantSide> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      // Venta: por pedido, por enlace o por attempt de la red.
      const link = await c.query<{
        link_id: string;
        order_id: string | null;
        merchant_id: string;
        amount: string;
        currency: string;
        created_at: Date;
      }>(
        attemptId
          ? `SELECT l.id AS link_id, o.id AS order_id, l.merchant_id, l.amount::text,
                    btrim(l.currency) AS currency, l.created_at
               FROM payment_attempts a JOIN payment_intents i ON i.id = a.intent_id
               JOIN payment_links l ON l.id = i.payment_link_id
               LEFT JOIN commerce_orders o ON o.payment_link_id = l.id
              WHERE a.id = $1`
          : `SELECT l.id AS link_id, o.id AS order_id, l.merchant_id, l.amount::text,
                    btrim(l.currency) AS currency, l.created_at
               FROM payment_links l LEFT JOIN commerce_orders o ON o.payment_link_id = l.id
              WHERE o.id = $1 OR (l.id = $1 AND l.single_charge)`,
        [attemptId ?? ref]
      );
      const sale = link.rows[0];
      if (!sale) throw new JourneyNotFoundError();
      const order = sale.order_id ? await this.orders.getIn(c, sale.order_id) : null;

      const m = await c.query<{ name: string; country: string; slug: string | null }>(
        `SELECT m.name, m.country, d.slug FROM merchants m
           LEFT JOIN merchant_directory_profiles d ON d.merchant_id = m.id
          WHERE m.id = $1`,
        [sale.merchant_id]
      );
      const payment = order
        ? order.payment
        : deriveOrderPayment((await this.saleAggregate(c, sale.link_id))!);

      const attempts = await c.query<AttemptRow>(
        `SELECT a.id, a.intent_id, a.attempt_number, a.status, a.provider_ref, a.last_error,
                a.created_at, a.updated_at
           FROM payment_attempts a JOIN payment_intents i ON i.id = a.intent_id
          WHERE i.payment_link_id = $1 ORDER BY a.created_at, a.attempt_number`,
        [sale.link_id]
      );
      const refunds = await c.query<RefundRow>(
        `SELECT r.id, r.payment_intent_id, r.amount::text, r.status, r.reason, r.failure_code,
                r.created_at, r.updated_at, r.resolved_at
           FROM refunds r JOIN payment_intents i ON i.id = r.payment_intent_id
          WHERE i.payment_link_id = $1 ORDER BY r.created_at`,
        [sale.link_id]
      );
      const keys = [
        ...attempts.rows.map((a) => `attempt:${a.id}:%`),
        ...refunds.rows.map((r) => `refund:${r.id}:%`),
      ];
      const ledger = keys.length
        ? await c.query<LedgerRow>(
            `SELECT id, reason, idempotency_key, created_at FROM ledger_transactions
              WHERE idempotency_key LIKE ANY($1::text[]) ORDER BY created_at, idempotency_key`,
            [keys]
          )
        : { rows: [] as LedgerRow[] };
      const subjects = [...attempts.rows.map((a) => a.id), ...refunds.rows.map((r) => r.id)];
      const ver = subjects.length
        ? await c.query<VerificationRow>(
            `SELECT DISTINCT ON (subject_id) subject_id, verdict, triggered_by, checked_at
               FROM uncertain_verifications WHERE subject_id = ANY($1::uuid[])
              ORDER BY subject_id, checked_at DESC`,
            [subjects]
          )
        : { rows: [] as VerificationRow[] };

      const shop = sale.order_id
        ? await c.query<{
            fulfillment: 'pickup' | 'delivery';
            fulfillment_status: string;
            delivery_address: string | null;
            return_requested_at: Date | null;
            return_reason: string | null;
            program_tenant_id: string;
            consumer_id: string;
            buyer_name: string;
          }>(`SELECT * FROM shop_order_requests WHERE order_id = $1`, [sale.order_id])
        : null;
      const s = shop?.rows[0];
      return {
        tenantId,
        journeyRef: sale.order_id ?? sale.link_id,
        linkId: sale.link_id,
        channel: await this.channelOf(c, sale.link_id, Boolean(s), Boolean(order)),
        merchantName: m.rows[0]?.name ?? 'Comercio',
        merchantSlug: m.rows[0]?.slug ?? null,
        market: (m.rows[0]?.country ?? '').trim(),
        currency: order?.currency ?? sale.currency,
        total: order?.total ?? BigInt(sale.amount),
        createdAt: (order ? new Date(order.createdAt) : sale.created_at).toISOString(),
        order,
        payment,
        attempts: attempts.rows,
        refunds: refunds.rows,
        ledger: ledger.rows,
        verifications: new Map(ver.rows.map((v) => [v.subject_id, v])),
        shop: s
          ? {
              fulfillment: s.fulfillment,
              fulfillmentStatus: s.fulfillment_status,
              deliveryAddress: s.delivery_address,
              returnRequestedAt: s.return_requested_at?.toISOString() ?? null,
              returnReason: s.return_reason,
              programTenantId: s.program_tenant_id,
              consumerId: s.consumer_id,
              buyerName: s.buyer_name,
            }
          : null,
      };
    });
  }

  /** Mismo agregado que el pedido (cobró / retiene / nada) para una venta sin pedido. */
  private async saleAggregate(c: PoolClient, linkId: string) {
    const r = await c.query<{
      charged_id: string | null;
      charged_status: string | null;
      charged_refunded: string | null;
      holding_id: string | null;
      holding_status: string | null;
      checkout_count: number;
      latest_session_id: string | null;
      latest_status: string | null;
    }>(
      `SELECT
         (array_agg(i.id ORDER BY i.created_at DESC) FILTER (WHERE i.status = ANY($2::text[])))[1] AS charged_id,
         (array_agg(i.status ORDER BY i.created_at DESC) FILTER (WHERE i.status = ANY($2::text[])))[1] AS charged_status,
         (array_agg(i.amount_refunded::text ORDER BY i.created_at DESC) FILTER (WHERE i.status = ANY($2::text[])))[1] AS charged_refunded,
         (array_agg(i.id ORDER BY i.created_at DESC) FILTER (WHERE NOT (i.status = ANY($3::text[]))))[1] AS holding_id,
         (array_agg(i.status ORDER BY i.created_at DESC) FILTER (WHERE NOT (i.status = ANY($3::text[]))))[1] AS holding_status,
         count(*)::int AS checkout_count,
         NULL::uuid AS latest_session_id,
         (array_agg(i.status ORDER BY i.created_at DESC))[1] AS latest_status
       FROM payment_intents i WHERE i.payment_link_id = $1`,
      [linkId, CHARGED, SALE_RELEASING_STATUSES]
    );
    return r.rows[0];
  }

  private async channelOf(
    c: PoolClient,
    linkId: string,
    shop: boolean,
    order: boolean
  ): Promise<JourneyChannel> {
    if (shop) return 'shop';
    if (order) return 'pos';
    const r = await c.query<{ dining: boolean; in_person: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM dining_bill_allocations WHERE payment_link_id = $1) AS dining,
              EXISTS (SELECT 1 FROM in_person_payments WHERE payment_link_id = $1) AS in_person`,
      [linkId]
    );
    if (r.rows[0]?.dining) return 'restaurant';
    if (r.rows[0]?.in_person) return 'in_person';
    return 'payment_link';
  }

  private async readIssuer(
    programTenantId: string,
    consumerId: string | null,
    attempts: AttemptRow[]
  ): Promise<IssuerSide> {
    if (!attempts.length) return { authorizations: [], ledger: [], cases: [] };
    return withProgramTx(this.appPool, programTenantId, consumerId, async (c) => {
      const a = await c.query<AuthRow>(
        `SELECT id, consumer_id, status, btrim(currency) AS currency, amount::text,
                wallet_amount::text, credit_amount::text, captured_wallet::text,
                captured_credit::text, refunded_wallet::text, refunded_credit::text,
                installments_count, decline_code, network_ref, merchant_ref, created_at, updated_at
           FROM card_authorizations
          WHERE network_ref = ANY($1::text[]) AND ($2::uuid IS NULL OR consumer_id = $2)
          ORDER BY created_at`,
        [attempts.map((x) => `acq:${x.id}`), consumerId]
      );
      if (consumerId) return { authorizations: a.rows, ledger: [], cases: [] };
      const ids = a.rows.map((x) => x.id);
      const ledger = ids.length
        ? await c.query<LedgerRow>(
            `SELECT id, reason, idempotency_key, created_at FROM ledger_transactions
              WHERE idempotency_key LIKE ANY($1::text[]) ORDER BY created_at, idempotency_key`,
            [ids.map((id) => `auth:${id}:%`)]
          )
        : { rows: [] as LedgerRow[] };
      const cases = ids.length
        ? await c.query<IssuerSide['cases'][number]>(
            `SELECT id, case_type, status, summary, created_at FROM program_cases
              WHERE subject_id = ANY($1::text[]) ORDER BY created_at DESC`,
            [ids]
          )
        : { rows: [] as IssuerSide['cases'] };
      return { authorizations: a.rows, ledger: ledger.rows, cases: cases.rows };
    });
  }

  // ── Proyección ───────────────────────────────────────────────────────────

  private core(audience: Audience, m: MerchantSide, issuer: IssuerSide | null) {
    const charged = m.payment.paymentIntentId;
    const chargeAttempt =
      m.attempts.filter((a) => a.intent_id === charged).at(-1) ?? m.attempts.at(-1) ?? null;
    const mainAuth =
      issuer?.authorizations.find(
        (x) => chargeAttempt && x.network_ref === `acq:${chargeAttempt.id}`
      ) ??
      issuer?.authorizations.at(-1) ??
      null;
    const method = chargeAttempt
      ? chargeAttempt.provider_ref?.startsWith('fnet_') || mainAuth
        ? 'fluvia_card'
        : 'external_card'
      : null;

    const uncertain = this.uncertainOf(m, audience, issuer);
    const base = {
      journeyRef: m.journeyRef,
      channel: m.channel,
      orderNumber: m.order?.number ?? null,
      createdAt: m.createdAt,
      merchant: {
        name: m.merchantName,
        slug: m.merchantSlug,
        market: isMarket(m.market) ? (m.market as Market) : m.market || null,
      },
      currency: m.currency,
      total: m.total.toString(),
      lines: (m.order?.lines ?? []).map((l) => ({
        name: l.name,
        variantLabel: l.variantLabel,
        quantity: l.quantity,
        unitPrice: l.unitPrice.toString(),
        lineTotal: l.lineTotal.toString(),
      })),
      payment: {
        state: m.payment.state,
        outcome: outcomeOf({ payment: m.payment }),
        intentId: m.payment.paymentIntentId,
        intentStatus: m.payment.intentStatus,
        amountRefunded: m.payment.amountRefunded.toString(),
        method,
        attempts: m.attempts.map((a) => ({
          ...(audience === 'consumer' ? {} : { id: a.id, providerRef: a.provider_ref }),
          number: a.attempt_number,
          status: a.status,
          failure: a.last_error ? 'declined_or_error' : null,
          createdAt: a.created_at.toISOString(),
          updatedAt: a.updated_at.toISOString(),
        })),
      },
      installments: m.order?.installments ?? null,
      refunds: m.refunds.map((r) => ({
        id: r.id,
        amount: r.amount,
        status: r.status,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
        resolvedAt: r.resolved_at?.toISOString() ?? null,
      })),
      fulfillment: m.shop
        ? {
            kind: m.shop.fulfillment,
            status: m.shop.fulfillmentStatus,
            returnRequestedAt: m.shop.returnRequestedAt,
            returnReason: m.shop.returnReason,
            ...(audience === 'consumer' ? {} : { buyerName: m.shop.buyerName }),
          }
        : null,
      cancellation: m.order?.cancellation
        ? { reason: m.order.cancellation.reason, createdAt: m.order.cancellation.createdAt }
        : null,
      uncertain,
      verifiedAt: new Date().toISOString(),
    };
    const issuerOut = mainAuth
      ? {
          authorizationId: mainAuth.id,
          status: mainAuth.status,
          amount: mainAuth.amount,
          walletAmount: mainAuth.wallet_amount,
          creditAmount: mainAuth.credit_amount,
          captured: (
            BigInt(mainAuth.captured_wallet) + BigInt(mainAuth.captured_credit)
          ).toString(),
          refunded: (
            BigInt(mainAuth.refunded_wallet) + BigInt(mainAuth.refunded_credit)
          ).toString(),
          installmentsCount: mainAuth.installments_count,
          declineCode: mainAuth.decline_code,
          attempts: issuer!.authorizations.length,
        }
      : null;
    return { base, issuerOut, mainAuth };
  }

  private projectConsumer(m: MerchantSide, issuer: IssuerSide) {
    const { base, issuerOut } = this.core('consumer', m, issuer);
    return { ...base, issuer: issuerOut };
  }

  private projectMerchant(m: MerchantSide) {
    const { base } = this.core('merchant', m, null);
    return { ...base, saleId: m.linkId, ledger: m.ledger.map((l) => ledgerOut('merchant', l)) };
  }

  private projectOperator(m: MerchantSide, issuer: IssuerSide) {
    const { base, issuerOut, mainAuth } = this.core('operator', m, issuer);
    return {
      ...base,
      saleId: m.linkId,
      merchantTenantId: m.tenantId,
      issuer:
        issuerOut && mainAuth
          ? { ...issuerOut, consumerId: mainAuth.consumer_id, networkRef: mainAuth.network_ref }
          : null,
      ledger: [
        ...m.ledger.map((l) => ledgerOut('merchant', l)),
        ...issuer.ledger.map((l) => ledgerOut('program', l)),
      ],
      cases: issuer.cases.map((x) => ({
        id: x.id,
        type: x.case_type,
        status: x.status,
        summary: x.summary,
        createdAt: x.created_at.toISOString(),
      })),
    };
  }

  /**
   * Inciertos y en curso: estado real, última verificación registrada,
   * siguiente paso y quién puede resolverlo. Nunca se resuelven aquí.
   */
  private uncertainOf(
    m: MerchantSide,
    audience: Audience,
    issuer: IssuerSide | null
  ): UncertainItem[] {
    const out: UncertainItem[] = [];
    for (const a of m.attempts) {
      if (a.status !== 'indeterminate' && !ATTEMPT_OPEN.has(a.status)) continue;
      const v = m.verifications.get(a.id);
      out.push({
        kind: 'payment',
        subjectId: audience === 'consumer' ? m.journeyRef : a.id,
        status: a.status === 'indeterminate' ? 'uncertain' : 'in_progress',
        since: a.updated_at.toISOString(),
        lastVerification: v
          ? { at: v.checked_at.toISOString(), verdict: v.verdict, by: v.triggered_by }
          : null,
        nextStep:
          audience === 'consumer'
            ? 'No pagues de nuevo. Fluvia consulta el resultado con la red; si no se cobró, el dinero retenido vuelve a tu saldo.'
            : 'Consulta verificable a la red o al proveedor. Solo su respuesta cierra el cobro.',
        resolvers: ['automatic', 'merchant:reconciliation', 'operations:cases'],
        ...(audience === 'operator'
          ? {
              issuerRecord:
                issuer?.authorizations.find((x) => x.network_ref === `acq:${a.id}`)?.status ??
                'no_record',
            }
          : {}),
      });
    }
    for (const r of m.refunds) {
      if (!REFUND_UNCERTAIN.has(r.status)) continue;
      const v = m.verifications.get(r.id);
      out.push({
        kind: 'refund',
        subjectId: r.id,
        status: r.status === 'indeterminate' ? 'uncertain' : 'in_progress',
        since: r.updated_at.toISOString(),
        lastVerification: v
          ? { at: v.checked_at.toISOString(), verdict: v.verdict, by: v.triggered_by }
          : null,
        nextStep:
          audience === 'consumer'
            ? 'La devolución está en curso; no la damos por hecha hasta que la red la confirme.'
            : 'Consulta verificable de la devolución. Un fallo confirmado deja el cobro intacto.',
        resolvers: ['automatic', 'merchant:reconciliation', 'operations:cases'],
      });
    }
    return out;
  }
}

function ledgerOut(side: 'merchant' | 'program', l: LedgerRow) {
  return {
    side,
    txId: l.id,
    key: l.idempotency_key,
    reason: l.reason,
    at: l.created_at.toISOString(),
  };
}

/** `merchant_ref = <tenant>:<merchant>` y `network_ref = acq:<attempt>` (red Fluvia). */
function fromNetwork(a: { merchant_ref: string | null; network_ref: string }): Target | null {
  const tenantId = a.merchant_ref?.split(':')[0] ?? '';
  const attemptId = a.network_ref.startsWith('acq:') ? a.network_ref.slice(4) : '';
  if (!UUID.test(tenantId) || !UUID.test(attemptId)) return null;
  return { tenantId, ref: attemptId, attemptId };
}
