import { withTenantTransaction, type Pool } from '@fluvia/db';
import { Money } from '@fluvia/money';
import { CheckoutSessionService } from './checkout.js';
import { PaymentLinkInvalidMerchantError, PaymentLinkNotFoundError } from './errors.js';
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
  createdAt: string;
  disabledAt: string | null;
}

export interface CreatePaymentLinkInput {
  merchantId: string;
  amount: bigint;
  currency: string;
  description?: string;
  metadata?: Record<string, string>;
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
  created_at: Date;
  disabled_at: Date | null;
}

const LINK_COLUMNS = `id, merchant_id, amount::text, currency, description, status, metadata,
  created_at, disabled_at`;

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
      `INSERT INTO payment_links (tenant_id, merchant_id, amount, currency, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${LINK_COLUMNS}`,
      [
        tenantId,
        input.merchantId,
        amount.amount.toString(),
        amount.currency,
        input.description ?? null,
        JSON.stringify(input.metadata ?? {}),
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
      const intent = await this.intents.createIn(c, {
        tenantId: link.tenant_id,
        merchantId: link.merchant_id,
        amount: Money.of(link.amount, link.currency.trim()),
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
