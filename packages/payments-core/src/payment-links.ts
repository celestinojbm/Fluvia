import { withTenantTransaction, type Pool } from '@fluvia/db';
import { Money } from '@fluvia/money';
import { CheckoutSessionService } from './checkout.js';
import { SALE_RELEASING_STATUSES } from './confirmation.js';
import {
  PaymentLinkInvalidMerchantError,
  PaymentLinkNotFoundError,
  SaleAlreadyChargedError,
} from './errors.js';
import { PaymentIntentService } from './service.js';

/**
 * Payment links (F3-06) — plantilla reutilizable "págame". El comercio crea un
 * link (monto + moneda + merchant); cada vez que un comprador lo abre se genera
 * un payment_intent + checkout_session FRESCOS (reutiliza F3-05) en UNA
 * transacción atómica. El link es público (sin secreto); el secreto vive en la
 * sesión generada.
 *
 * `createSessionFromLink` es el plano PÚBLICO (sin API key): resuelve el link
 * cross-tenant vía la función SECURITY DEFINER `payment_link_resolve` (0025) —
 * solo links ACTIVOS; inexistente o deshabilitado = mismo not-found.
 *
 * Vínculo persistente (0046): cada intent generado guarda `payment_link_id`
 * (venta → intents → checkout_sessions). `single_charge` = venta de cobro
 * único (la crea el POS): como máximo UN intent de la venta cobra — guard de
 * servicio en la confirmación y garantía final en el índice único del motor.
 * Los links multiuso (default) conservan su comportamiento: cada apertura es
 * un cobro independiente.
 */

export interface PaymentLinkDto {
  id: string;
  merchantId: string;
  amount: string;
  currency: string;
  description: string | null;
  status: string;
  url: string;
  metadata: Record<string, string>;
  /** Venta de cobro único (POS): como máximo un cobro exitoso. */
  singleCharge: boolean;
  /** Desde cuándo el servidor vincula los checkouts de este link (0046). */
  checkoutTrackingSince: string;
  createdAt: string;
  disabledAt: string | null;
}

/** Un checkout (intent + su sesión) de la venta, leído del vínculo persistente. */
export interface SaleCheckoutDto {
  paymentIntentId: string;
  intentStatus: string;
  failureCode: string | null;
  amountRefunded: string;
  createdAt: string;
  /** null si el intent no tiene sesión (no ocurre por el plano público). */
  session: {
    id: string;
    status: string;
    expiresAt: string;
    completedAt: string | null;
    createdAt: string;
  } | null;
}

/**
 * Venta = link + TODOS sus checkouts vinculados, con el estado del cobro
 * derivado por el servidor. `charge`:
 *  - charged: algún intent cobró (succeeded/partially_refunded/refunded).
 *  - in_progress: algún intent retiene el cobro sin haberlo confirmado
 *    (processing, requires_action, authorized… incluido desenlace incierto).
 *  - none: ningún intent cobra ni puede estar cobrando.
 * `history`: complete si todos los checkouts del link están vinculados;
 * partial si el link es anterior al vínculo (checkouts previos invisibles).
 */
export interface PaymentLinkSaleDto {
  link: PaymentLinkDto;
  charge: 'none' | 'in_progress' | 'charged';
  /** Intent que retiene/cobró la venta (el más reciente si hay varios). */
  chargeIntentId: string | null;
  succeededCount: number;
  history: 'complete' | 'partial';
  checkouts: SaleCheckoutDto[];
  /** true si hay más checkouts de los devueltos (cota SALE_CHECKOUTS_LIMIT). */
  truncated: boolean;
}

export const SALE_CHECKOUTS_LIMIT = 50;
const CHARGED_STATUSES = new Set(['succeeded', 'partially_refunded', 'refunded']);

export interface CreatePaymentLinkInput {
  merchantId: string;
  amount: bigint;
  currency: string;
  description?: string;
  metadata?: Record<string, string>;
  /** Venta de cobro único (POS). Default false: plantilla multiuso. */
  singleCharge?: boolean;
}

export interface LinkSessionResult {
  checkoutSessionId: string;
  clientSecret: string;
  url: string;
}

interface LinkRow {
  id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  description: string | null;
  status: string;
  metadata: Record<string, string>;
  single_charge: boolean;
  checkout_tracking_since: Date;
  created_at: Date;
  disabled_at: Date | null;
}

const LINK_COLUMNS = `id, merchant_id, amount::text, currency, description, status, metadata,
  single_charge, checkout_tracking_since, created_at, disabled_at`;

export interface PaymentLinkServiceOptions {
  /** Base de la URL alojada; el link vive en `{base}/l/{id}`. */
  checkoutBaseUrl?: string;
  intents: PaymentIntentService;
  checkout: CheckoutSessionService;
}

export class PaymentLinkService {
  private readonly baseUrl: string;
  private readonly intents: PaymentIntentService;
  private readonly checkout: CheckoutSessionService;

  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    options: PaymentLinkServiceOptions
  ) {
    this.baseUrl = (options.checkoutBaseUrl ?? 'https://checkout.fluvia.local').replace(/\/+$/, '');
    this.intents = options.intents;
    this.checkout = options.checkout;
  }

  private toDto(r: LinkRow): PaymentLinkDto {
    return {
      id: r.id,
      merchantId: r.merchant_id,
      amount: r.amount,
      currency: r.currency.trim(),
      description: r.description,
      status: r.status,
      url: `${this.baseUrl}/l/${r.id}`,
      metadata: r.metadata,
      singleCharge: r.single_charge,
      checkoutTrackingSince: r.checkout_tracking_since.toISOString(),
      createdAt: r.created_at.toISOString(),
      disabledAt: r.disabled_at?.toISOString() ?? null,
    };
  }

  /** Client-bound: compone con la capa de idempotencia (F2-09). */
  async createIn(
    c: import('./service.js').TxClient,
    tenantId: string,
    input: CreatePaymentLinkInput
  ): Promise<PaymentLinkDto> {
    // Merchant validado bajo RLS (ajeno/inexistente => invisible) para dar un
    // error limpio en vez de una violación de FK cruda.
    const merchant = await c.query(`SELECT 1 FROM merchants WHERE id = $1 AND deleted_at IS NULL`, [
      input.merchantId,
    ]);
    if ((merchant.rowCount ?? 0) === 0) throw new PaymentLinkInvalidMerchantError();
    // Valida moneda/monto vía Money antes de insertar.
    const amount = Money.of(input.amount, input.currency);
    const res = await c.query<LinkRow>(
      `INSERT INTO payment_links
         (tenant_id, merchant_id, amount, currency, description, metadata, single_charge)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${LINK_COLUMNS}`,
      [
        tenantId,
        input.merchantId,
        amount.amount.toString(),
        amount.currency,
        input.description ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.singleCharge ?? false,
      ]
    );
    return this.toDto(res.rows[0]!);
  }

  async get(tenantId: string, linkId: string): Promise<PaymentLinkDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM payment_links WHERE id = $1`,
        [linkId]
      );
      if (!res.rows[0]) throw new PaymentLinkNotFoundError();
      return this.toDto(res.rows[0]);
    });
  }

  /**
   * Venta (plano autenticado por org): link + sus checkouts VINCULADOS, del
   * más antiguo al más reciente, con el estado del cobro derivado en la misma
   * lectura (una transacción, RLS del tenant: un link ajeno es not-found).
   */
  async getSale(tenantId: string, linkId: string): Promise<PaymentLinkSaleDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const l = await c.query<LinkRow>(`SELECT ${LINK_COLUMNS} FROM payment_links WHERE id = $1`, [
        linkId,
      ]);
      if (!l.rows[0]) throw new PaymentLinkNotFoundError();
      const link = this.toDto(l.rows[0]);

      const agg = await c.query<{
        succeeded: string;
        charged_id: string | null;
        holding_id: string | null;
      }>(
        `SELECT count(*) FILTER (WHERE status = ANY($2::text[]))::text AS succeeded,
                (array_agg(id ORDER BY created_at DESC) FILTER (WHERE status = ANY($2::text[])))[1]
                  AS charged_id,
                (array_agg(id ORDER BY created_at DESC)
                  FILTER (WHERE NOT (status = ANY($3::text[]))))[1] AS holding_id
         FROM payment_intents WHERE payment_link_id = $1`,
        [linkId, [...CHARGED_STATUSES], SALE_RELEASING_STATUSES]
      );
      const a = agg.rows[0]!;
      const charge: PaymentLinkSaleDto['charge'] = a.charged_id
        ? 'charged'
        : a.holding_id
          ? 'in_progress'
          : 'none';

      const rows = await c.query<{
        id: string;
        status: string;
        failure_code: string | null;
        amount_refunded: string;
        created_at: Date;
        session_id: string | null;
        session_status: string | null;
        expires_at: Date | null;
        completed_at: Date | null;
        session_created_at: Date | null;
      }>(
        `SELECT i.id, i.status, i.failure_code, i.amount_refunded::text, i.created_at,
                cs.id AS session_id, cs.status AS session_status, cs.expires_at, cs.completed_at,
                cs.created_at AS session_created_at
         FROM (SELECT * FROM payment_intents WHERE payment_link_id = $1
               ORDER BY created_at DESC, id DESC LIMIT $2) i
         LEFT JOIN LATERAL (
           SELECT * FROM checkout_sessions s WHERE s.payment_intent_id = i.id
           ORDER BY s.created_at DESC LIMIT 1
         ) cs ON true
         ORDER BY i.created_at, i.id`,
        [linkId, SALE_CHECKOUTS_LIMIT + 1]
      );
      const truncated = rows.rows.length > SALE_CHECKOUTS_LIMIT;
      const kept = truncated ? rows.rows.slice(1) : rows.rows;
      return {
        link,
        charge,
        chargeIntentId: a.charged_id ?? a.holding_id,
        succeededCount: Number(a.succeeded),
        history:
          l.rows[0].created_at.getTime() >= l.rows[0].checkout_tracking_since.getTime()
            ? 'complete'
            : 'partial',
        truncated,
        checkouts: kept.map((r) => ({
          paymentIntentId: r.id,
          intentStatus: r.status,
          failureCode: r.failure_code,
          amountRefunded: r.amount_refunded,
          createdAt: r.created_at.toISOString(),
          session:
            r.session_id && r.session_status && r.expires_at && r.session_created_at
              ? {
                  id: r.session_id,
                  status: r.session_status,
                  expiresAt: r.expires_at.toISOString(),
                  completedAt: r.completed_at?.toISOString() ?? null,
                  createdAt: r.session_created_at.toISOString(),
                }
              : null,
        })),
      };
    });
  }

  async list(tenantId: string, limit = 20): Promise<PaymentLinkDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM payment_links ORDER BY created_at DESC, id LIMIT $1`,
        [capped]
      );
      return res.rows.map((r) => this.toDto(r));
    });
  }

  async disable(tenantId: string, linkId: string): Promise<PaymentLinkDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<LinkRow>(
        `UPDATE payment_links
         SET status = 'disabled', disabled_at = COALESCE(disabled_at, now()), updated_at = now()
         WHERE id = $1
         RETURNING ${LINK_COLUMNS}`,
        [linkId]
      );
      if (!res.rows[0]) throw new PaymentLinkNotFoundError();
      return this.toDto(res.rows[0]);
    });
  }

  /**
   * Plano PÚBLICO: resuelve el link (cross-tenant, solo activos) y genera un
   * payment_intent + checkout_session frescos en UNA transacción atómica.
   * Devuelve la sesión + su client_secret para que el comprador pague.
   */
  async createSessionFromLink(linkId: string): Promise<LinkSessionResult> {
    const resolved = await this.appPool.query<{
      tenant_id: string;
      merchant_id: string;
      amount: string;
      currency: string;
    }>(`SELECT tenant_id, merchant_id, amount::text, currency FROM payment_link_resolve($1)`, [
      linkId,
    ]);
    const link = resolved.rows[0];
    if (!link) throw new PaymentLinkNotFoundError();

    return withTenantTransaction(this.appPool, link.tenant_id, async (c) => {
      // Venta de cobro único ya cobrada o cobrando: no se abre un checkout que
      // jamás podría cobrar. Comprobación de cortesía (sin lock): la exclusión
      // real vive en la confirmación y en el índice único del motor.
      const policy = await c.query<{ single_charge: boolean }>(
        `SELECT single_charge FROM payment_links WHERE id = $1`,
        [linkId]
      );
      if (policy.rows[0]?.single_charge) {
        const held = await c.query(
          `SELECT 1 FROM payment_intents
           WHERE single_charge_link_id = $1 AND NOT (status = ANY($2::text[])) LIMIT 1`,
          [linkId, SALE_RELEASING_STATUSES]
        );
        if ((held.rowCount ?? 0) > 0) throw new SaleAlreadyChargedError();
      }
      const intent = await this.intents.createIn(c, {
        tenantId: link.tenant_id,
        merchantId: link.merchant_id,
        amount: Money.of(link.amount, link.currency.trim()),
        paymentLinkId: linkId,
      });
      const session = await this.checkout.createIn(c, link.tenant_id, {
        paymentIntentId: intent.id,
      });
      return {
        checkoutSessionId: session.id,
        clientSecret: session.clientSecret,
        url: session.url,
      };
    });
  }
}
