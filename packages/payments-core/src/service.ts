import { withTenantTransaction, type Pool } from '@fluvia/db';

/** Minimo comun de un client transaccional (PoolClient de pg o compatible). */
export interface TxClient {
  query: Pool['query'];
}
import { buildEnvelope } from '@fluvia/events';
import type { Money } from '@fluvia/money';
import { INTENT_TRANSITIONS, canTransition, type IntentStatus } from './fsm.js';
import { InvalidStateTransitionError, PaymentIntentNotFoundError } from './errors.js';

/**
 * Servicio de transiciones de payment intents (F3-01).
 *
 * SOLO plano interno: los endpoints públicos llegan con F3-02 (siguen
 * congelados). Doble validación deliberada: el mapa TS da feedback rápido y
 * tipado; el trigger de 0017 re-valida al COMMIT — un caller que salte este
 * servicio (o un bug aquí) muere igualmente en el motor.
 *
 * Todo cambio de estado emite su evento al outbox EN la misma transacción
 * (topic `payment_intent.<estado>`, catálogo de webhook-delivery.md §3).
 */

export interface CreateIntentInput {
  tenantId: string;
  merchantId: string;
  amount: Money;
  description?: string;
  captureMethod?: 'automatic' | 'manual';
  metadata?: Record<string, string>;
}

export interface PaymentIntentDto {
  id: string;
  tenantId: string;
  merchantId: string;
  amount: string;
  currency: string;
  status: IntentStatus;
  captureMethod: string;
  amountCaptured: string;
  amountRefunded: string;
  version: string;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionOptions {
  /** Obligatorio al pasar a `failed` (código del catálogo, jamás texto libre). */
  failureCode?: string;
}

interface IntentRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  status: IntentStatus;
  capture_method: string;
  amount_captured: string;
  amount_refunded: string;
  version: string;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}

const INTENT_COLUMNS = `id, tenant_id, merchant_id, amount::text, currency, status,
  capture_method, amount_captured::text, amount_refunded::text, version::text,
  failure_code, created_at, updated_at`;

function toDto(r: IntentRow): PaymentIntentDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    merchantId: r.merchant_id,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    captureMethod: r.capture_method,
    amountCaptured: r.amount_captured,
    amountRefunded: r.amount_refunded,
    version: r.version,
    failureCode: r.failure_code,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class PaymentIntentService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool
  ) {}

  async create(input: CreateIntentInput): Promise<PaymentIntentDto> {
    return withTenantTransaction(this.appPool, input.tenantId, (c) => this.createIn(c, input));
  }

  /**
   * Variante para componer con otras capas (idempotencia F2-09): corre DENTRO
   * de una transaccion ajena ya scoped al tenant (SET LOCAL app.tenant_id).
   */
  async createIn(c: TxClient, input: CreateIntentInput): Promise<PaymentIntentDto> {
    {
      const res = await c.query<IntentRow>(
        `INSERT INTO payment_intents
           (tenant_id, merchant_id, amount, currency, description, capture_method, metadata, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'created')
         RETURNING ${INTENT_COLUMNS}`,
        [
          input.tenantId,
          input.merchantId,
          input.amount.amount.toString(),
          input.amount.currency,
          input.description ?? null,
          input.captureMethod ?? 'automatic',
          JSON.stringify(input.metadata ?? {}),
        ]
      );
      const dto = toDto(res.rows[0]!);
      await this.emit(c, dto, 'created');
      return dto;
    }
  }

  async get(tenantId: string, intentId: string): Promise<PaymentIntentDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE id = $1`,
        [intentId]
      );
      if (!res.rows[0]) throw new PaymentIntentNotFoundError();
      return toDto(res.rows[0]);
    });
  }

  /**
   * Transición de estado bajo lock de fila. RLS hace indistinguibles el
   * intent ajeno y el inexistente (not found).
   */
  async transition(
    tenantId: string,
    intentId: string,
    to: IntentStatus,
    opts: TransitionOptions = {}
  ): Promise<PaymentIntentDto> {
    return withTenantTransaction(this.appPool, tenantId, (c) =>
      this.transitionIn(c, intentId, to, opts)
    );
  }

  /** Variante client-bound (misma regla que createIn). */
  async transitionIn(
    c: TxClient,
    intentId: string,
    to: IntentStatus,
    opts: TransitionOptions = {}
  ): Promise<PaymentIntentDto> {
    {
      const cur = await c.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE id = $1 FOR UPDATE`,
        [intentId]
      );
      const row = cur.rows[0];
      if (!row) throw new PaymentIntentNotFoundError();
      if (!canTransition(INTENT_TRANSITIONS, row.status, to)) {
        throw new InvalidStateTransitionError(row.status, to);
      }

      const res = await c.query<IntentRow>(
        `UPDATE payment_intents
         SET status = $2,
             version = version + 1,
             updated_at = now(),
             canceled_at  = CASE WHEN $2 = 'canceled'  THEN now() ELSE canceled_at END,
             succeeded_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE succeeded_at END,
             failure_code = CASE WHEN $2 = 'failed' THEN $3 ELSE failure_code END
         WHERE id = $1
         RETURNING ${INTENT_COLUMNS}`,
        [intentId, to, opts.failureCode ?? null]
      );
      const dto = toDto(res.rows[0]!);
      await this.emit(c, dto, to);
      return dto;
    }
  }

  /** Listado por tenant, mas reciente primero (paginacion simple por limit). */
  async list(tenantId: string, limit = 20): Promise<PaymentIntentDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<IntentRow>(
        `SELECT ${INTENT_COLUMNS} FROM payment_intents ORDER BY created_at DESC, id LIMIT $1`,
        [capped]
      );
      return res.rows.map(toDto);
    });
  }

  private async emit(c: TxClient, intent: PaymentIntentDto, status: string): Promise<void> {
    const envelope = buildEnvelope({
      producer: 'fluvia.payments',
      resource: { type: 'payment_intent', id: intent.id },
      data: {
        payment_intent_id: intent.id,
        status,
        amount: intent.amount,
        currency: intent.currency,
        merchant_id: intent.merchantId,
      },
    });
    await c.query(`INSERT INTO outbox_events (tenant_id, topic, payload) VALUES ($1, $2, $3)`, [
      intent.tenantId,
      `payment_intent.${status}`,
      JSON.stringify(envelope),
    ]);
  }
}
