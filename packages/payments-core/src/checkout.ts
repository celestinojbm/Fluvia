import { createHash, randomBytes } from 'node:crypto';
import { withTenantTransaction, type Pool } from '@fluvia/db';
import {
  CheckoutSessionInvalidCustomerError,
  CheckoutSessionNotFoundError,
  InvalidStateTransitionError,
  PaymentIntentNotFoundError,
} from './errors.js';
import type { IntentStatus } from './fsm.js';
import type { TxClient } from './service.js';

/**
 * Checkout sessions (F3-05b) — el recurso: una sesión de checkout alojado
 * envuelve un payment_intent (y opcionalmente un customer). El comercio la
 * crea y obtiene la URL alojada + el `client_secret` (se muestra UNA vez; la
 * base guarda solo su hash, como las API keys).
 *
 * Alcance F3-05b: crear/consultar (plano API key). El retrieval por
 * client_secret, el disparo de completed/expired y los eventos
 * `checkout_session.*` llegan con el flujo alojado (F3-05c).
 *
 * Solo se abre checkout sobre un intent aún NO resuelto: crear una sesión para
 * un intent succeeded/failed/canceled/refunded es un error de estado.
 */

const INTENT_OPEN_FOR_CHECKOUT: ReadonlySet<IntentStatus> = new Set<IntentStatus>([
  'created',
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
]);

const DEFAULT_EXPIRES_MINUTES = 24 * 60;
const MIN_EXPIRES_MINUTES = 5;
const MAX_EXPIRES_MINUTES = 24 * 60;

export interface CheckoutSessionDto {
  id: string;
  paymentIntentId: string;
  customerId: string | null;
  status: string;
  url: string;
  successUrl: string | null;
  cancelUrl: string | null;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
}

export interface CreatedCheckoutSession extends CheckoutSessionDto {
  /** Credencial de la página alojada — se entrega UNA única vez. */
  clientSecret: string;
}

export interface CreateCheckoutSessionInput {
  paymentIntentId: string;
  customerId?: string;
  successUrl?: string;
  cancelUrl?: string;
  /** Minutos hasta expirar (default 24 h; acotado 5 min–24 h). */
  expiresInMinutes?: number;
}

interface SessionRow {
  id: string;
  payment_intent_id: string;
  customer_id: string | null;
  status: string;
  success_url: string | null;
  cancel_url: string | null;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
}

export interface CheckoutSessionServiceOptions {
  /** Base de la URL alojada; el buyer se redirige a `{base}/c/{id}`. */
  checkoutBaseUrl?: string;
}

export function hashClientSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export class CheckoutSessionService {
  private readonly baseUrl: string;

  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    options: CheckoutSessionServiceOptions = {}
  ) {
    this.baseUrl = (options.checkoutBaseUrl ?? 'https://checkout.fluvia.local').replace(/\/+$/, '');
  }

  private toDto(r: SessionRow): CheckoutSessionDto {
    return {
      id: r.id,
      paymentIntentId: r.payment_intent_id,
      customerId: r.customer_id,
      status: r.status,
      url: `${this.baseUrl}/c/${r.id}`,
      successUrl: r.success_url,
      cancelUrl: r.cancel_url,
      expiresAt: r.expires_at.toISOString(),
      completedAt: r.completed_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    };
  }

  /** Client-bound: compone con la capa de idempotencia (F2-09). */
  async createIn(
    c: TxClient,
    tenantId: string,
    input: CreateCheckoutSessionInput
  ): Promise<CreatedCheckoutSession> {
    const intent = await c.query<{ status: IntentStatus }>(
      `SELECT status FROM payment_intents WHERE id = $1`,
      [input.paymentIntentId]
    );
    if (!intent.rows[0]) throw new PaymentIntentNotFoundError();
    if (!INTENT_OPEN_FOR_CHECKOUT.has(intent.rows[0].status)) {
      // El intent ya está resuelto: no hay pago que alojar.
      throw new InvalidStateTransitionError(intent.rows[0].status, 'checkout_open');
    }

    // Customer opcional: pre-check bajo RLS (ajeno o borrado => invisible) para
    // dar un error limpio en vez de una violación de FK cruda a mitad de la tx.
    if (input.customerId !== undefined) {
      const cust = await c.query(`SELECT 1 FROM customers WHERE id = $1 AND deleted_at IS NULL`, [
        input.customerId,
      ]);
      if ((cust.rowCount ?? 0) === 0) throw new CheckoutSessionInvalidCustomerError();
    }

    const minutes = Math.min(
      Math.max(Math.floor(input.expiresInMinutes ?? DEFAULT_EXPIRES_MINUTES), MIN_EXPIRES_MINUTES),
      MAX_EXPIRES_MINUTES
    );
    // `cs_` + 36 bytes aleatorios (base64url) — se entrega una vez, se guarda su hash.
    const clientSecret = `cs_${randomBytes(36).toString('base64url')}`;

    const res = await c.query<SessionRow>(
      `INSERT INTO checkout_sessions
         (tenant_id, payment_intent_id, customer_id, client_secret_hash, success_url, cancel_url, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
       RETURNING id, payment_intent_id, customer_id, status, success_url, cancel_url,
                 expires_at, completed_at, created_at`,
      [
        tenantId,
        input.paymentIntentId,
        input.customerId ?? null,
        hashClientSecret(clientSecret),
        input.successUrl ?? null,
        input.cancelUrl ?? null,
        minutes,
      ]
    );
    return { ...this.toDto(res.rows[0]!), clientSecret };
  }

  async get(tenantId: string, sessionId: string): Promise<CheckoutSessionDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<SessionRow>(
        `SELECT id, payment_intent_id, customer_id, status, success_url, cancel_url,
                expires_at, completed_at, created_at
         FROM checkout_sessions WHERE id = $1`,
        [sessionId]
      );
      if (!res.rows[0]) throw new CheckoutSessionNotFoundError();
      return this.toDto(res.rows[0]);
    });
  }

  async list(tenantId: string, limit = 20): Promise<CheckoutSessionDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<SessionRow>(
        `SELECT id, payment_intent_id, customer_id, status, success_url, cancel_url,
                expires_at, completed_at, created_at
         FROM checkout_sessions ORDER BY created_at DESC, id LIMIT $1`,
        [capped]
      );
      return res.rows.map((r) => this.toDto(r));
    });
  }
}
