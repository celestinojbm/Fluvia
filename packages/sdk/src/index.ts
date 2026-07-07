/**
 * @fluvia/sdk — cliente TypeScript tipado del plano de integración (API key) de
 * Fluvia. Cubre EXACTAMENTE las rutas publicadas en `docs/api/openapi.v1.json`
 * (un contract test garantiza SDK ⊆⊇ contrato). Sin dependencias de runtime:
 * usa `fetch` global (inyectable para tests / entornos sin fetch).
 *
 * Las creaciones mutantes que exigen idempotencia (intents/refunds/checkout/
 * links) generan un `Idempotency-Key` si no se pasa uno — reintentar es seguro.
 */

// ---------------------------------------------------------------------------
// Registro de rutas: la superficie del SDK, verificada contra el contrato.
// ---------------------------------------------------------------------------
export const SDK_ROUTES = [
  { method: 'POST', path: '/v1/payment_intents' },
  { method: 'GET', path: '/v1/payment_intents' },
  { method: 'GET', path: '/v1/payment_intents/{id}' },
  { method: 'POST', path: '/v1/payment_intents/{id}/confirm' },
  { method: 'POST', path: '/v1/payment_intents/{id}/cancel' },
  { method: 'POST', path: '/v1/refunds' },
  { method: 'GET', path: '/v1/refunds' },
  { method: 'GET', path: '/v1/refunds/{id}' },
  { method: 'POST', path: '/v1/customers' },
  { method: 'GET', path: '/v1/customers' },
  { method: 'GET', path: '/v1/customers/{id}' },
  { method: 'POST', path: '/v1/customers/{id}' },
  { method: 'POST', path: '/v1/customers/{id}/delete' },
  { method: 'POST', path: '/v1/customers/{id}/erase' },
  { method: 'POST', path: '/v1/checkout_sessions' },
  { method: 'GET', path: '/v1/checkout_sessions' },
  { method: 'GET', path: '/v1/checkout_sessions/{id}' },
  { method: 'POST', path: '/v1/payment_links' },
  { method: 'GET', path: '/v1/payment_links' },
  { method: 'GET', path: '/v1/payment_links/{id}' },
  { method: 'POST', path: '/v1/payment_links/{id}/disable' },
  { method: 'POST', path: '/v1/webhook_endpoints' },
  { method: 'GET', path: '/v1/webhook_endpoints' },
  { method: 'POST', path: '/v1/webhook_endpoints/{id}/rotate' },
  { method: 'POST', path: '/v1/webhook_endpoints/{id}/disable' },
  { method: 'GET', path: '/v1/webhook_events' },
  { method: 'GET', path: '/v1/webhook_events/{id}' },
  { method: 'POST', path: '/v1/webhook_events/{id}/resend' },
] as const;

// ---------------------------------------------------------------------------
// Tipos de recurso (espejan la forma pública que devuelve el API).
// ---------------------------------------------------------------------------
export interface FluviaList<T> {
  object: 'list';
  data: T[];
}

export interface PaymentIntent {
  id: string;
  object: 'payment_intent';
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  capture_method: string;
  amount_captured: number;
  amount_refunded: number;
  failure_code: string | null;
  created_at: string;
}

export interface Refund {
  id: string;
  object: 'refund';
  payment_intent_id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  failure_code: string | null;
  created_at: string;
}

export interface Customer {
  id: string;
  object: 'customer';
  email: string | null;
  name: string | null;
  phone: string | null;
  description: string | null;
  metadata: Record<string, string>;
  created_at: string;
}

export interface CheckoutSession {
  id: string;
  object: 'checkout_session';
  payment_intent_id: string;
  customer_id: string | null;
  status: string;
  url: string;
  success_url: string | null;
  cancel_url: string | null;
  expires_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface PaymentLink {
  id: string;
  object: 'payment_link';
  merchant_id: string;
  amount: number;
  currency: string;
  description: string | null;
  status: string;
  url: string;
  metadata: Record<string, string>;
  created_at: string;
  disabled_at: string | null;
}

export interface WebhookEndpoint {
  id: string;
  object: 'webhook_endpoint';
  url: string;
  events: string[];
  status: string;
  description: string | null;
  created_at: string;
  disabled_at?: string | null;
  /** Solo presente al crear/rotar — se entrega UNA vez. */
  secret?: string;
}

export interface WebhookEvent {
  id: string;
  object: 'webhook_event';
  endpoint_id: string;
  topic: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  delivered_at: string | null;
  resent_from_event_id: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Entradas de creación / actualización.
// ---------------------------------------------------------------------------
export interface CreatePaymentIntentInput {
  merchant_id: string;
  amount: number;
  currency: string;
  description?: string;
}
export interface CreateRefundInput {
  payment_intent_id: string;
  amount: number;
  reason?: string;
}
export interface CustomerInput {
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  description?: string | null;
  metadata?: Record<string, string>;
}
export interface CreateCheckoutSessionInput {
  payment_intent_id: string;
  customer_id?: string;
  success_url?: string;
  cancel_url?: string;
  expires_in_seconds?: number;
}
export interface CreatePaymentLinkInput {
  merchant_id: string;
  amount: number;
  currency: string;
  description?: string;
  metadata?: Record<string, string>;
}
export interface CreateWebhookEndpointInput {
  url: string;
  events?: string[];
  description?: string;
}

export interface ListOptions {
  limit?: number;
}

// ---------------------------------------------------------------------------
// Error tipado: el sobre estable del API (F1-08).
// ---------------------------------------------------------------------------
export class FluviaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'FluviaApiError';
  }
}

export interface FluviaClientOptions {
  /** Base del API, p.ej. https://api.fluvia.example (sin barra final). */
  baseUrl: string;
  /** Clave secreta `fluvia_sk_…`. */
  apiKey: string;
  /** `fetch` a usar (default el global). Inyectable para tests/entornos. */
  fetchImpl?: typeof fetch;
  /** Fábrica de Idempotency-Key (default `crypto.randomUUID`). */
  idempotencyKeyFactory?: () => string;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Envía `Idempotency-Key` (autogenerado si no se pasa `key`). */
  idempotent?: boolean;
  idempotencyKey?: string;
}

export class FluviaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly newKey: () => string;

  constructor(options: FluviaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    const f = options.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('No fetch available; pass options.fetchImpl');
    this.fetchImpl = f;
    this.newKey = options.idempotencyKeyFactory ?? (() => globalThis.crypto.randomUUID());
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const qs = opts.query
      ? Object.entries(opts.query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotent) headers['idempotency-key'] = opts.idempotencyKey ?? this.newKey();

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (res.status >= 400) {
      const env = parsed as { error?: { code?: string; message?: string; details?: unknown } };
      const e = env?.error ?? {};
      throw new FluviaApiError(
        res.status,
        e.code ?? 'unknown',
        res.headers.get('x-request-id'),
        e.message ?? `HTTP ${res.status}`,
        e.details
      );
    }
    return parsed as T;
  }

  private fill(path: string, id: string): string {
    return path.replace('{id}', encodeURIComponent(id));
  }

  readonly paymentIntents = {
    create: (input: CreatePaymentIntentInput, idempotencyKey?: string) =>
      this.request<PaymentIntent>('POST', '/v1/payment_intents', {
        body: input,
        idempotent: true,
        idempotencyKey,
      }),
    get: (id: string) =>
      this.request<PaymentIntent>('GET', this.fill('/v1/payment_intents/{id}', id)),
    list: (options: ListOptions = {}) =>
      this.request<FluviaList<PaymentIntent>>('GET', '/v1/payment_intents', {
        query: { limit: options.limit },
      }),
    confirm: (id: string, paymentMethodToken: string, idempotencyKey?: string) =>
      this.request<PaymentIntent>('POST', this.fill('/v1/payment_intents/{id}/confirm', id), {
        body: { payment_method_token: paymentMethodToken },
        idempotent: true,
        idempotencyKey,
      }),
    cancel: (id: string) =>
      this.request<PaymentIntent>('POST', this.fill('/v1/payment_intents/{id}/cancel', id)),
  };

  readonly refunds = {
    create: (input: CreateRefundInput, idempotencyKey?: string) =>
      this.request<Refund>('POST', '/v1/refunds', {
        body: input,
        idempotent: true,
        idempotencyKey,
      }),
    get: (id: string) => this.request<Refund>('GET', this.fill('/v1/refunds/{id}', id)),
    list: (options: ListOptions & { paymentIntentId?: string } = {}) =>
      this.request<FluviaList<Refund>>('GET', '/v1/refunds', {
        query: { limit: options.limit, payment_intent_id: options.paymentIntentId },
      }),
  };

  readonly customers = {
    create: (input: CustomerInput) =>
      this.request<Customer>('POST', '/v1/customers', { body: input }),
    get: (id: string) => this.request<Customer>('GET', this.fill('/v1/customers/{id}', id)),
    list: (options: ListOptions = {}) =>
      this.request<FluviaList<Customer>>('GET', '/v1/customers', {
        query: { limit: options.limit },
      }),
    update: (id: string, input: CustomerInput) =>
      this.request<Customer>('POST', this.fill('/v1/customers/{id}', id), { body: input }),
    delete: (id: string) =>
      this.request<{ id: string; object: 'customer'; deleted: true }>(
        'POST',
        this.fill('/v1/customers/{id}/delete', id)
      ),
    /** TM-05: derecho al olvido — pseudonimiza la PII de forma IRREVERSIBLE
     *  (la fila y las referencias contables permanecen). Idempotente. */
    erase: (id: string) =>
      this.request<{ id: string; object: 'customer'; erased: true }>(
        'POST',
        this.fill('/v1/customers/{id}/erase', id)
      ),
  };

  readonly checkoutSessions = {
    create: (input: CreateCheckoutSessionInput, idempotencyKey?: string) =>
      this.request<CheckoutSession>('POST', '/v1/checkout_sessions', {
        body: input,
        idempotent: true,
        idempotencyKey,
      }),
    get: (id: string) =>
      this.request<CheckoutSession>('GET', this.fill('/v1/checkout_sessions/{id}', id)),
    list: (options: ListOptions = {}) =>
      this.request<FluviaList<CheckoutSession>>('GET', '/v1/checkout_sessions', {
        query: { limit: options.limit },
      }),
  };

  readonly paymentLinks = {
    create: (input: CreatePaymentLinkInput, idempotencyKey?: string) =>
      this.request<PaymentLink>('POST', '/v1/payment_links', {
        body: input,
        idempotent: true,
        idempotencyKey,
      }),
    get: (id: string) => this.request<PaymentLink>('GET', this.fill('/v1/payment_links/{id}', id)),
    list: (options: ListOptions = {}) =>
      this.request<FluviaList<PaymentLink>>('GET', '/v1/payment_links', {
        query: { limit: options.limit },
      }),
    disable: (id: string) =>
      this.request<{ id: string; status: string; disabled_at: string | null }>(
        'POST',
        this.fill('/v1/payment_links/{id}/disable', id)
      ),
  };

  readonly webhookEndpoints = {
    create: (input: CreateWebhookEndpointInput) =>
      this.request<WebhookEndpoint>('POST', '/v1/webhook_endpoints', { body: input }),
    list: () => this.request<FluviaList<WebhookEndpoint>>('GET', '/v1/webhook_endpoints'),
    rotate: (id: string) =>
      this.request<{ id: string; secret: string; rotated: true }>(
        'POST',
        this.fill('/v1/webhook_endpoints/{id}/rotate', id)
      ),
    disable: (id: string) =>
      this.request<{ id: string; status: string; disabled_at: string | null }>(
        'POST',
        this.fill('/v1/webhook_endpoints/{id}/disable', id)
      ),
  };

  readonly webhookEvents = {
    list: (options: ListOptions & { endpointId?: string; status?: string } = {}) =>
      this.request<FluviaList<WebhookEvent>>('GET', '/v1/webhook_events', {
        query: { limit: options.limit, endpoint_id: options.endpointId, status: options.status },
      }),
    get: (id: string) =>
      this.request<WebhookEvent & { payload: unknown; attempts_history: unknown[] }>(
        'GET',
        this.fill('/v1/webhook_events/{id}', id)
      ),
    resend: (id: string) =>
      this.request<WebhookEvent>('POST', this.fill('/v1/webhook_events/{id}/resend', id)),
  };
}
