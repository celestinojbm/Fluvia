import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { Money } from '@fluvia/money';
import type { CheckoutSessionService, PaymentLinkService } from '@fluvia/payments-core';
import { CollectionNotEnabledError, type BusinessProfileService } from './business.js';
import { CommerceError, hasEngineMessage } from './errors.js';
import { VenueForbiddenError, venueCan, type VenueAccess } from './venue.js';

/**
 * COBRO PRESENCIAL (0061) sobre el flujo de pago EXISTENTE.
 *
 *  - Cada cobro apunta a una venta de COBRO ÚNICO: un importe del
 *    independiente (se crea su link), una fracción de cuenta del restaurante
 *    o una venta del POS. Mismo intent/attempt, ledger, fees y devoluciones.
 *  - La app solo avanza la PREPARACIÓN (preparing → ready → waiting_card) o
 *    cancela antes de procesar. approved / declined / uncertain los fija el
 *    SERVIDOR leyendo el intent, resuelto por el proveedor (respuesta
 *    síncrona o webhook firmado → inbox). Ningún callback del cliente aprueba.
 *  - Fluvia no ve PAN ni CVV: la lectura es del SDK certificado del
 *    proveedor. Sin proveedor habilitado para el país, el único «terminal» es
 *    el SIMULADOR de sandbox, registrado como `method = simulator`.
 *  - Idempotencia: (tenant, client_key) — un reintento del teléfono devuelve
 *    el MISMO cobro; el índice de cobro único impide un segundo cargo.
 */

export type InPersonMethod = 'tap_to_pay' | 'external_reader' | 'simulator';
export type InPersonState =
  | 'device_incompatible'
  | 'preparing'
  | 'ready'
  | 'waiting_card'
  | 'processing'
  | 'approved'
  | 'declined'
  | 'canceled'
  | 'uncertain';

export interface DeviceReport {
  platform: 'android' | 'ios' | 'web' | 'other';
  model?: string | null;
  osVersion?: string | null;
  nfc?: boolean | null;
}
export interface DeviceDto {
  id: string;
  platform: DeviceReport['platform'];
  capability: 'compatible' | 'incompatible' | 'unknown';
  reasons: string[];
}

export interface InPersonPaymentDto {
  id: string;
  method: InPersonMethod;
  provider: string;
  state: InPersonState;
  amount: bigint;
  currency: string;
  concept: string | null;
  paymentLinkId: string;
  intentId: string | null;
  failureCode: string | null;
  simulated: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type InPersonSource =
  | { kind: 'amount'; amount: bigint; currency: string; concept?: string | null }
  | { kind: 'allocation'; allocationId: string }
  | { kind: 'order'; orderId: string };

export class InPersonNotFoundError extends CommerceError {
  constructor() {
    super('In-person payment not found');
  }
}
export class InPersonStateError extends CommerceError {
  constructor(message: string) {
    super(message);
  }
}
export class InPersonKeyMismatchError extends CommerceError {
  constructor() {
    super('client_key already used with different parameters');
  }
}

/** Requisitos públicos de Tap to Pay de los SDK documentados (ver docs). */
const ANDROID_MIN_MAJOR = 13;

/**
 * Veredicto de compatibilidad del SERVIDOR. Un navegador nunca es un terminal
 * certificado (Web NFC no es aceptación EMV): `web` → incompatible.
 */
export function deviceVerdict(d: DeviceReport): Omit<DeviceDto, 'id' | 'platform'> {
  const reasons: string[] = [];
  if (d.platform === 'web') {
    reasons.push('web_is_not_a_certified_terminal', 'native_app_required');
    return { capability: 'incompatible', reasons };
  }
  if (d.platform === 'other') return { capability: 'incompatible', reasons: ['unsupported_os'] };
  if (d.nfc === false) reasons.push('nfc_missing');
  if (d.platform === 'android') {
    const major = Number.parseInt(String(d.osVersion ?? '').split('.')[0] ?? '', 10);
    if (Number.isNaN(major)) reasons.push('os_version_unknown');
    else if (major < ANDROID_MIN_MAJOR) reasons.push('android_13_required');
  }
  if (d.platform === 'ios' && !d.model) reasons.push('iphone_model_unknown');
  const blocking = reasons.filter(
    (r) => r !== 'os_version_unknown' && r !== 'iphone_model_unknown'
  );
  if (blocking.length) return { capability: 'incompatible', reasons };
  return { capability: reasons.length ? 'unknown' : 'compatible', reasons };
}

interface Row {
  id: string;
  method: InPersonMethod;
  provider: string;
  state: InPersonState;
  amount: string;
  currency: string;
  concept: string | null;
  payment_link_id: string;
  intent_id: string | null;
  failure_code: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const COLS = `id, method, provider, state, amount::text, currency, concept, payment_link_id,
  intent_id, failure_code, version, created_at, updated_at`;

const toDto = (r: Row): InPersonPaymentDto => ({
  id: r.id,
  method: r.method,
  provider: r.provider,
  state: r.state,
  amount: BigInt(r.amount),
  currency: r.currency.trim(),
  concept: r.concept,
  paymentLinkId: r.payment_link_id,
  intentId: r.intent_id,
  failureCode: r.failure_code,
  simulated: r.method === 'simulator',
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const APPROVED = new Set(['succeeded', 'partially_refunded', 'refunded']);
const DECLINED = new Set(['failed', 'canceled']);

/** Tokens del proveedor SANDBOX que el simulador presenta en lugar de una tarjeta. */
export const SIMULATOR_OUTCOMES = {
  approve: 'tok_approve',
  decline: 'tok_decline',
  timeout: 'tok_timeout',
  pending: 'tok_pse',
} as const;
export type SimulatorOutcome = keyof typeof SIMULATOR_OUTCOMES;

export class InPersonService {
  constructor(
    private readonly appPool: Pool,
    private readonly deps: {
      business: BusinessProfileService;
      paymentLinks: PaymentLinkService;
      checkout: CheckoutSessionService;
      /** Habilita el simulador (solo local/test). */
      sandbox: boolean;
    }
  ) {}

  async registerDevice(tenantId: string, userId: string, d: DeviceReport): Promise<DeviceDto> {
    const v = deviceVerdict(d);
    const r = await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO in_person_devices (tenant_id, user_id, platform, model, os_version, nfc, capability, reasons)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          tenantId,
          userId,
          d.platform,
          d.model ?? null,
          d.osVersion ?? null,
          d.nfc ?? null,
          v.capability,
          v.reasons,
        ]
      )
    );
    return { id: r.rows[0]!.id, platform: d.platform, ...v };
  }

  /**
   * Crea (o devuelve, por client_key) el cobro presencial. Exige la
   * habilitación de cobro en estado `enabled`. Tap to Pay en un dispositivo
   * incompatible queda registrado como `device_incompatible` (sin cobro).
   */
  async create(
    tenantId: string,
    actor: { userId: string; canSell: boolean; venue: VenueAccess },
    input: {
      source: InPersonSource;
      method: InPersonMethod;
      deviceId?: string | null;
      clientKey: string;
    }
  ): Promise<InPersonPaymentDto> {
    const en = await this.deps.business.enablement(tenantId);
    if (en.status !== 'enabled') throw new CollectionNotEnabledError(en.status);
    if (
      input.method === 'simulator' &&
      (!this.deps.sandbox || en.provider !== 'sandbox_simulator')
    ) {
      throw new InPersonStateError('The sandbox simulator is not available here');
    }
    if (input.method !== 'simulator' && en.provider === 'sandbox_simulator') {
      // Proveedor de sandbox: no hay SDK real que lea una tarjeta.
      throw new InPersonStateError('No real in-person provider is configured');
    }
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const prior = await c.query<Row>(
        `SELECT ${COLS} FROM in_person_payments WHERE client_key = $1`,
        [input.clientKey]
      );
      if (prior.rows[0]) {
        const p = prior.rows[0];
        if (p.method !== input.method) throw new InPersonKeyMismatchError();
        if (input.source.kind === 'amount' && BigInt(p.amount) !== input.source.amount) {
          throw new InPersonKeyMismatchError();
        }
        return this.syncIn(c, toDto(p));
      }
      const target = await this.resolveSourceIn(c, tenantId, actor, input.source);
      let state: InPersonState = 'preparing';
      if (input.method === 'tap_to_pay') {
        const dev = input.deviceId
          ? await c.query<{ capability: string }>(
              `SELECT capability FROM in_person_devices WHERE id = $1 AND user_id = $2`,
              [input.deviceId, actor.userId]
            )
          : null;
        if (!dev?.rows[0] || dev.rows[0].capability === 'incompatible') {
          state = 'device_incompatible';
        }
      }
      const r = await c.query<Row>(
        `INSERT INTO in_person_payments
           (tenant_id, merchant_id, payment_link_id, device_id, method, provider, state, amount,
            currency, concept, client_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${COLS}`,
        [
          tenantId,
          target.merchantId,
          target.linkId,
          input.deviceId ?? null,
          input.method,
          en.provider,
          state,
          target.amount.toString(),
          target.currency,
          target.concept,
          input.clientKey,
          actor.userId,
        ]
      );
      return toDto(r.rows[0]!);
    });
  }

  /** Preparación por la app: preparing → ready → waiting_card, o cancelar. */
  async advance(
    tenantId: string,
    userId: string,
    id: string,
    input: { to: 'ready' | 'waiting_card' | 'canceled'; expectedVersion: number }
  ): Promise<InPersonPaymentDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const p = await this.lockIn(c, id, userId);
      if (p.version !== input.expectedVersion) {
        // Reintento idempotente: si ya está en el estado pedido, se devuelve.
        if (p.state === input.to) return toDto(p);
        throw new InPersonStateError('Version conflict');
      }
      try {
        const r = await c.query<Row>(
          `UPDATE in_person_payments SET state = $2, version = version + 1, updated_at = now()
            WHERE id = $1 RETURNING ${COLS}`,
          [id, input.to]
        );
        return toDto(r.rows[0]!);
      } catch (err) {
        if (hasEngineMessage(err, 'FLUVIA_INVALID_TRANSITION')) {
          throw new InPersonStateError(`Cannot move from ${p.state} to ${input.to}`);
        }
        throw err;
      }
    });
  }

  /**
   * SIMULADOR de terminal (solo sandbox): presenta al PROVEEDOR sandbox un
   * token en lugar de una tarjeta, por el MISMO camino que un checkout
   * (sesión del link → confirmación en el servidor). El resultado lo decide
   * el proveedor y se lee del intent. Repetir el toque no cobra dos veces.
   */
  async simulateTap(
    tenantId: string,
    userId: string,
    id: string,
    outcome: SimulatorOutcome
  ): Promise<InPersonPaymentDto> {
    if (!this.deps.sandbox) throw new InPersonStateError('Simulator disabled');
    const current = await this.get(tenantId, userId, id);
    if (current.method !== 'simulator') throw new InPersonStateError('Not a simulator payment');
    // Toque repetido o tardío: no se procesa de nuevo (ningún segundo cargo).
    if (current.state !== 'waiting_card') return current;
    // 1) Sesión del link ANTES de marcar «procesando»: si la venta ya está
    //    cobrada o retenida, el error sale aquí y el cobro sigue esperando.
    const session = await this.deps.paymentLinks.createSessionFromLink(current.paymentLinkId);
    // 2) Ata el intent y pasa a «procesando» bajo lock (solo uno gana).
    const go = await withTenantTransaction(this.appPool, tenantId, async (c) => {
      const row = await this.lockIn(c, id, userId);
      if (row.state !== 'waiting_card') return false;
      const s = await c.query<{ payment_intent_id: string }>(
        `SELECT payment_intent_id FROM checkout_sessions WHERE id = $1`,
        [session.checkoutSessionId]
      );
      await c.query(
        `UPDATE in_person_payments
            SET state = 'processing', intent_id = $2, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, s.rows[0]!.payment_intent_id]
      );
      return true;
    });
    if (go) {
      try {
        // 3) El PROVEEDOR sandbox decide; el servidor confirma por el camino
        //    del checkout (guardas de cobro único e incertidumbre incluidas).
        await this.deps.checkout.confirmByClientSecret(
          session.checkoutSessionId,
          session.clientSecret,
          SIMULATOR_OUTCOMES[outcome]
        );
      } catch {
        // Un fallo de transporte no aprueba ni rechaza: el estado sale del intent.
      }
    }
    return this.get(tenantId, userId, id);
  }

  /** Lee el cobro y SINCRONIZA su estado con el intent (verdad del servidor). */
  async get(tenantId: string, userId: string, id: string): Promise<InPersonPaymentDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<Row>(
        `SELECT ${COLS} FROM in_person_payments WHERE id = $1 AND created_by = $2`,
        [id, userId]
      );
      if (!r.rows[0]) throw new InPersonNotFoundError();
      return this.syncIn(c, toDto(r.rows[0]));
    });
  }

  async list(tenantId: string, userId: string, limit = 20): Promise<InPersonPaymentDto[]> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<Row>(
        `SELECT ${COLS} FROM in_person_payments WHERE created_by = $1
          ORDER BY created_at DESC LIMIT $2`,
        [userId, Math.min(Math.max(limit, 1), 100)]
      );
      const out: InPersonPaymentDto[] = [];
      for (const row of r.rows) out.push(await this.syncIn(c, toDto(row)));
      return out;
    });
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private async syncIn(c: PoolClient, p: InPersonPaymentDto): Promise<InPersonPaymentDto> {
    if (!p.intentId || !['processing', 'uncertain', 'waiting_card'].includes(p.state)) return p;
    const i = await c.query<{ status: string; failure_code: string | null }>(
      `SELECT status, failure_code FROM payment_intents WHERE id = $1`,
      [p.intentId]
    );
    const intent = i.rows[0];
    if (!intent) return p;
    let next: InPersonState | null = null;
    if (APPROVED.has(intent.status)) next = 'approved';
    else if (DECLINED.has(intent.status)) next = 'declined';
    else if (p.state === 'processing' && intent.status !== 'created') next = 'uncertain';
    if (!next || next === p.state) return p;
    const r = await c.query<Row>(
      `UPDATE in_person_payments
          SET state = $2, failure_code = $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND state = $4 RETURNING ${COLS}`,
      [p.id, next, next === 'declined' ? (intent.failure_code ?? 'declined') : null, p.state]
    );
    return r.rows[0] ? toDto(r.rows[0]) : p;
  }

  private async lockIn(c: PoolClient, id: string, userId: string): Promise<Row> {
    const r = await c.query<Row>(
      `SELECT ${COLS} FROM in_person_payments WHERE id = $1 AND created_by = $2 FOR UPDATE`,
      [id, userId]
    );
    if (!r.rows[0]) throw new InPersonNotFoundError();
    return r.rows[0];
  }

  private async resolveSourceIn(
    c: PoolClient,
    tenantId: string,
    actor: { userId: string; canSell: boolean; venue: VenueAccess },
    source: InPersonSource
  ): Promise<{
    merchantId: string;
    linkId: string;
    amount: bigint;
    currency: string;
    concept: string | null;
  }> {
    if (source.kind === 'amount') {
      if (!actor.canSell) throw new VenueForbiddenError('bill:collect');
      const m = await c.query<{ id: string; default_currency: string }>(
        `SELECT id, default_currency FROM merchants WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`
      );
      if (!m.rows[0]) throw new InPersonNotFoundError();
      const amount = Money.of(source.amount, source.currency);
      const concept = source.concept?.trim() || null;
      const link = await this.deps.paymentLinks.createIn(c, tenantId, {
        merchantId: m.rows[0].id,
        amount: amount.amount,
        currency: amount.currency,
        description: concept ?? 'Cobro presencial',
        metadata: { channel: 'in_person' },
        singleCharge: true,
      });
      return {
        merchantId: m.rows[0].id,
        linkId: link.id,
        amount: amount.amount,
        currency: amount.currency,
        concept,
      };
    }
    if (source.kind === 'allocation') {
      const a = await c.query<{
        payment_link_id: string;
        amount: string;
        currency: string;
        merchant_id: string;
        branch_id: string;
        label: string | null;
        number: string;
        voided_at: Date | null;
      }>(
        `SELECT a.payment_link_id, a.amount::text, a.currency, b.merchant_id, o.branch_id,
                a.label, o.number::text, a.voided_at
           FROM dining_bill_allocations a JOIN dining_bills b ON b.id = a.bill_id
           JOIN dining_orders o ON o.id = b.order_id WHERE a.id = $1`,
        [source.allocationId]
      );
      const row = a.rows[0];
      if (!row || row.voided_at) throw new InPersonNotFoundError();
      if (!venueCan(actor.venue, 'bill:collect', row.branch_id)) {
        throw new VenueForbiddenError('bill:collect');
      }
      return {
        merchantId: row.merchant_id,
        linkId: row.payment_link_id,
        amount: BigInt(row.amount),
        currency: row.currency.trim(),
        concept: `Pedido #${row.number}${row.label ? ` · ${row.label}` : ''}`,
      };
    }
    if (!actor.canSell) throw new VenueForbiddenError('bill:collect');
    const o = await c.query<{
      payment_link_id: string;
      total: string;
      currency: string;
      merchant_id: string;
      number: string;
    }>(
      `SELECT payment_link_id, total::text, currency, merchant_id, number::text
         FROM commerce_orders WHERE id = $1`,
      [source.orderId]
    );
    const row = o.rows[0];
    if (!row) throw new InPersonNotFoundError();
    return {
      merchantId: row.merchant_id,
      linkId: row.payment_link_id,
      amount: BigInt(row.total),
      currency: row.currency.trim(),
      concept: `Venta #${row.number}`,
    };
  }
}
