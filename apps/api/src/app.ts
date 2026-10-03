import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from '@fluvia/config';
import type { Pool } from '@fluvia/db';
import type { AuthService } from '@fluvia/auth';
import { AuditReader } from '@fluvia/audit';
import {
  CustomerService,
  OrganizationOnboardingService,
  type ApiKeyService,
  type IdentityService,
} from '@fluvia/identity';
import { IdempotencyService } from '@fluvia/idempotency';
import { InboxIngestService } from '@fluvia/inbox';
import { WebhookEndpointService, WebhookEventService } from '@fluvia/webhooks';
import {
  CaseAdjustmentService,
  OperationalCaseService,
  ReconciliationService,
} from '@fluvia/reconciliation';
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
  ResilientProvider,
  SqlProviderOperationStore,
  UncertainPaymentResolver,
  isSaleReleaseUnverified,
  isSingleChargeViolation,
} from '@fluvia/payments-core';
import { LedgerService, PostingService } from '@fluvia/ledger';
import {
  CatalogService,
  DirectoryService,
  CustomerDirectory,
  InstallmentSandboxService,
  InventoryService,
  BusinessProfileService,
  VenueService,
  DiningService,
  BillService,
  InPersonService,
  OrderService,
  ShopService,
  SummaryService,
  isInstallmentPlanActive,
  isOrderCancelled,
} from '@fluvia/commerce';
import { MetricsRegistry } from '@fluvia/observability';
import {
  FluviaCardNetwork,
  FluviaRoutingProvider,
  createPersonalServices,
  type PersonalServices,
} from '@fluvia/personal';
import { registerAuthRoutes, type AuthRateLimits } from './routes/auth.js';
import type { RateLimiter } from './rate-limit.js';
import { registerAccountRoutes, registerOrganizationRoutes } from './routes/organizations.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerPaymentIntentRoutes } from './routes/payment-intents.js';
import { registerRefundRoutes } from './routes/refunds.js';
import { registerPayoutRoutes } from './routes/payouts.js';
import { registerDisputeRoutes } from './routes/disputes.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerCheckoutSessionRoutes } from './routes/checkout-sessions.js';
import { registerPaymentLinkRoutes } from './routes/payment-links.js';
import {
  registerProviderWebhookRoutes,
  type ProviderWebhookRateLimits,
} from './routes/provider-webhooks.js';
import { registerWebhookEndpointRoutes } from './routes/webhook-endpoints.js';
import { registerWebhookEventRoutes } from './routes/webhook-events.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerSettlementRoutes } from './routes/settlements.js';
import { registerCaseRoutes } from './routes/cases.js';
import { registerCommerceRoutes } from './routes/commerce.js';
import { registerDiningRoutes } from './routes/dining.js';
import { registerInPersonRoutes } from './routes/in-person.js';
import { buyerTools } from './buyer-tools.js';
import { buyerAuthenticator } from './buyer-auth.js';
import { registerDirectoryRoutes } from './routes/directory.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { commerceTools, personalTools } from './assistant-tools.js';
import {
  AssistantEngine,
  AssistantStore,
  LocalPrivateStorage,
  createAssistantProviders,
  loadAssistantLimits,
  loadAssistantProviders,
  resolveActions,
  type AssistantProviders,
  type BlobStorage,
  type ConcurrencyGate,
} from '@fluvia/assistant';
import { registerPersonalRoutes } from './routes/personal.js';
import { registerShopMerchantRoutes } from './routes/shops.js';
import { registerFxRoutes } from './routes/fx.js';
import { FxService } from './fx/service.js';
import { fxRefreshConfigFromEnv } from './fx/refresher.js';
import { registerProgramOpsRoutes } from './routes/program-ops.js';
import { createSecurity } from './security.js';
import { registerMetrics } from './metrics.js';
import { findCardData } from './card-data-guard.js';
import { DOMAIN_ERROR_CODES, ERROR_CATALOG, errorBody } from './error-catalog.js';

export interface BuildAppOptions {
  config: AppConfig;
  /** Pool con rol fluvia_app (RLS forzado). */
  appPool: Pool;
  /**
   * F6.5C2: pool ADMINISTRATIVO (plano de plataforma) usado UNICAMENTE por el
   * onboarding de organizacion (`POST /v1/organizations`, funcion sancionada
   * `createOrganizationForUser`). Opcional: sin el, esa ruta no se registra.
   */
  adminPool?: Pool;
  /** Servicio de autenticacion (pool fluvia_auth). Opcional en tests de plataforma. */
  authService?: AuthService;
  /**
   * Jornada integral: pool fluvia_auth para las credenciales y sesiones del
   * CLIENTE de Fluvia Personal. Sin él, las rutas del programa no se registran.
   */
  authPool?: Pool;
  identityService?: IdentityService;
  apiKeyService?: ApiKeyService;
  /** Override de limites de tasa de /v1/auth/* (tests usan ventanas cortas). */
  authRateLimits?: AuthRateLimits;
  /** Override del limite de ingesta de webhooks del proveedor (tests). */
  providerWebhookRateLimits?: ProviderWebhookRateLimits;
  /** Registro de metricas (F1-07). Por defecto cada app crea el suyo. */
  metricsRegistry?: MetricsRegistry;
  /** TM-03: backend del rate limiter de /v1/auth/*. Default in-memory
   *  (mono-instancia); despliegues compartidos inyectan el de Redis. */
  rateLimiter?: RateLimiter;
  /** Solo tests: captura el output del logger para verificar la redacción
   *  sobre la instancia REAL de pino del app (no una copia de la config). */
  loggerStream?: { write: (msg: string) => void };
  /**
   * Asistente «Fluvia». Por defecto lee process.env (proveedores reales solo
   * con TODAS sus credenciales; si no, simulados) y guarda adjuntos en
   * ASSISTANT_STORAGE_DIR. Los tests inyectan almacenamiento y proveedores.
   */
  assistant?: {
    env?: Record<string, string | undefined>;
    storage?: BlobStorage;
    providers?: AssistantProviders;
    /** Respuestas en curso por titular: Redis con varias réplicas (server.ts). */
    concurrency?: ConcurrencyGate;
  };
  /** Tasas de referencia (server.ts arranca el refresco con este servicio). */
  fx?: FxService;
}

// F1-08: la taxonomia vive en error-catalog.ts (catalogo versionado con
// contract test). Este archivo solo enruta hacia ella.

/**
 * Redaccion del logger — COMPARTIDA con log-redaction.test.ts: el test prueba
 * este MISMO objeto (no una copia) Y que buildApp lo cablea (probe por los
 * paths top-level, que no pasan por serializer). Nota de alcance: el
 * serializer `req` por defecto de Fastify ya DESCARTA los headers; los paths
 * `req.*`/`res.*` censuran si un serializer futuro los incluyera, y los
 * gemelos top-level cubren logs ad-hoc tipo `log.info({ headers })`.
 */
export const LOG_REDACT = {
  paths: [
    'req.headers.authorization',
    'req.headers["x-api-key"]',
    'req.headers.cookie',
    'req.headers["x-checkout-client-secret"]',
    'res.headers["set-cookie"]',
    'headers.authorization',
    'headers["x-api-key"]',
    'headers.cookie',
    'headers["x-checkout-client-secret"]',
    'headers["set-cookie"]',
  ],
  censor: '[REDACTED]',
};

/**
 * Construye la instancia Fastify del API (F1-01).
 *
 * Solo plataforma: health/readiness, correlation id, redaccion de secretos
 * en logs y el sobre de error estable minimo. Los recursos de negocio llegan
 * con sus dominios (F3+); la taxonomia completa de errores es F1-08.
 */
export function buildApp({
  config,
  appPool,
  adminPool,
  authService,
  authPool,
  identityService,
  apiKeyService,
  authRateLimits,
  providerWebhookRateLimits,
  metricsRegistry,
  rateLimiter,
  loggerStream,
  assistant,
  fx,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: LOG_REDACT,
      ...(loggerStream ? { stream: loggerStream } : {}),
    },
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      const value = Array.isArray(incoming) ? incoming[0] : incoming;
      // Se acepta el id entrante solo si es corto y simple (anti log-injection).
      return value && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : randomUUID();
    },
    bodyLimit: 1024 * 1024,
  });

  // F3-11a (AUD-P2-016): CORS de allowlist explícita. Por defecto NINGÚN
  // cross-origin (checkout/dashboard llaman al API server-side, no desde el
  // navegador); un allowlist configurable habilita clientes de navegador (p.ej.
  // el SDK). El preflight se responde aquí (no hay rutas OPTIONS declaradas).
  const corsOrigins = config.corsAllowedOrigins;
  const corsAllows = (origin: string): boolean =>
    corsOrigins.includes('*') || corsOrigins.includes(origin);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && corsAllows(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      // Preflight: el navegador decide por la presencia de ACAO. Solo añadimos
      // los headers de método/cabeceras cuando el origen está permitido.
      if (origin && corsAllows(origin)) {
        reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
        reply.header(
          'access-control-allow-headers',
          'authorization, content-type, idempotency-key, x-checkout-client-secret, x-request-id'
        );
        reply.header('access-control-max-age', '600');
      }
      return reply.code(204).send();
    }
  });

  // F3-11a: cabeceras de seguridad en TODA respuesta. El API devuelve JSON, así
  // que la CSP se bloquea al máximo; HSTS solo fuera de local/test (http local).
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cross-origin-resource-policy', 'same-origin');
    if (config.env !== 'local' && config.env !== 'test') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
  });

  // F1-07: contadores/histogramas HTTP + GET /metrics (agregados anonimos).
  const registry = metricsRegistry ?? new MetricsRegistry();
  registerMetrics(app, registry);

  // TM-06 (pci-scope.md §3): guard de datos de tarjeta. Fluvia jamas acepta
  // PAN/CVV — solo tokens del proveedor. Corre en preValidation (body ya
  // parseado, ANTES de auth/Zod/handler): un request con estructura de tarjeta
  // se rechaza sin tocar nada mas, con log de incidente SIN el valor. Los
  // bodies no-objeto (p. ej. la ingesta del webhook, string firmado) no
  // aplican. Heuristica conservadora — no "resuelve PCI", refuerza la frontera.
  const cardDataRejected = registry.counter(
    'fluvia_card_data_rejected_total',
    'Requests rechazados por contener datos aparentes de tarjeta (guard PCI)',
    ['kind']
  );
  app.addHook('preValidation', async (req, reply) => {
    if (req.body === null || typeof req.body !== 'object') return;
    const hit = findCardData(req.body);
    if (hit) {
      req.log.error(
        {
          event: 'pci.card_data_rejected',
          kind: hit.kind,
          fieldPath: hit.path,
          route: req.routeOptions.url ?? 'unmatched',
        },
        'card-like data rejected at the edge (PCI guard) — value not logged'
      );
      cardDataRejected.inc({ kind: hit.kind });
      return reply
        .code(ERROR_CATALOG.card_data_not_allowed.status)
        .send(errorBody('card_data_not_allowed', req.id));
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    env: config.env,
    uptime_seconds: Math.round(process.uptime()),
  }));

  app.get('/ready', async (req, reply) => {
    try {
      await appPool.query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      req.log.error({ err }, 'readiness check failed: database unreachable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  if (authService) {
    // F6.5C1 (B6): la fuente normativa de entorno es config.env (@fluvia/config,
    // ya validada anti-mezcla) — la MISMA condicion exacta que gobierna
    // exposeVerificationToken. Fuera de local/test la ruta register-sandbox NO
    // se registra (404 del not-found handler), sin fallback a register.
    const isLocalOrTest = config.env === 'local' || config.env === 'test';
    registerAuthRoutes(app, {
      authService,
      exposeVerificationToken: isLocalOrTest,
      enableSandboxRegistration: isLocalOrTest,
      rateLimits: authRateLimits,
      limiter: rateLimiter,
    });
  }

  if (authService && identityService && apiKeyService) {
    const security = createSecurity({
      authService,
      identityService,
      appPool,
      apiKeyHmacSecretHex: config.apiKeyHmacSecret,
      apiKeyHmacSecretsRetiredHex: config.apiKeyHmacSecretsRetired,
    });
    const auditReader = new AuditReader(appPool);
    registerOrganizationRoutes(app, {
      security,
      authService,
      identityService,
      apiKeyService,
      auditReader,
    });
    registerAccountRoutes(app, { security, identityService });
    // F3-02: plano de integracion (API key). Servicios internos construidos
    // aqui: solo dependen del pool app (RLS) — nada de config adicional.
    const paymentIntentService = new PaymentIntentService(appPool);
    const ledgerService = new LedgerService(appPool);
    const postingService = new PostingService(ledgerService, appPool);
    // F6.5C2: onboarding (organizacion pre-tenant + merchant inicial + chart).
    // El pool de plataforma queda ENCAPSULADO en la fachada aqui, en el
    // wiring: las rutas jamas referencian pools administrativos (gate §5).
    registerOnboardingRoutes(app, {
      security,
      identityService,
      postingService,
      organizationOnboarding: adminPool ? new OrganizationOnboardingService(adminPool) : undefined,
    });
    // Proveedor del sandbox: MockPaymentProvider (tokenizacion simulada). Los
    // adapters reales llegan en Fase 5 tras la matriz de jurisdiccion. F3-04:
    // timeout real + circuit breaker alrededor de CUALQUIER adapter — un solo
    // proveedor comparte circuito entre confirm y refund.
    //
    // Jornada integral: el MockProvider REGISTRA sus decisiones (proveedor
    // simulado consultable: los inciertos se resuelven por consulta, no por
    // suposición) y, si hay organización programa configurada, un proveedor de
    // ENRUTAMIENTO manda los códigos `fcp_` de Fluvia Personal a la red Fluvia
    // simulada. Para el resto de tokens el comportamiento es el de siempre.
    const personal: PersonalServices | undefined = authPool
      ? createPersonalServices({ app: appPool, auth: authPool })
      : undefined;
    const simulatedProvider = new MockPaymentProvider(new SqlProviderOperationStore(appPool));
    const routedProvider =
      personal && config.programTenantId
        ? new FluviaRoutingProvider(
            simulatedProvider,
            new FluviaCardNetwork(config.programTenantId, personal.authorizations)
          )
        : simulatedProvider;
    const provider = new ResilientProvider(routedProvider);
    const idempotencyService = new IdempotencyService(appPool, {
      retentionHours: config.idempotencyRetentionHours,
    });
    const confirmationService = new PaymentConfirmationService(
      appPool,
      paymentIntentService,
      postingService,
      provider,
      new FlatBpsFeeSchedule(config.platformFeeBps)
    );
    registerPaymentIntentRoutes(app, {
      security,
      idempotencyService,
      paymentIntentService,
      confirmationService,
    });
    // F3-08: refunds end-to-end (asiento compensatorio via la via normativa).
    const refundService = new RefundService(
      appPool,
      paymentIntentService,
      postingService,
      provider
    );
    registerRefundRoutes(app, { security, idempotencyService, refundService });
    // F4-07b: payouts como recurso (money out) sobre el motor de F4-07a. Mismo
    // circuito/timeout que el resto (provider resiliente); sandbox, sin exponer.
    const payoutService = new PayoutService(appPool, postingService, provider);
    registerPayoutRoutes(app, { security, idempotencyService, payoutService });
    // F4-08b: disputas como recurso (money clawed back) sobre el motor de F4-08a.
    // Plano de LECTURA + envio de evidencia; la apertura/resolucion llegan por el
    // webhook del banco (F4-08c). Sandbox, sin exponer.
    const disputeService = new DisputeService(appPool, postingService);
    registerDisputeRoutes(app, { security, disputeService });
    // F3-05a: customers (plano de integracion; primer consumidor = checkout).
    registerCustomerRoutes(app, {
      security,
      customerService: new CustomerService(appPool),
    });
    // F3-05b/c: checkout sessions (recurso + flujo alojado: /status y /confirm
    // por client_secret, sin API key).
    const checkoutSessionService = new CheckoutSessionService(appPool, {
      checkoutBaseUrl: config.checkoutBaseUrl,
      confirmation: confirmationService,
    });
    registerCheckoutSessionRoutes(app, { security, idempotencyService, checkoutSessionService });
    // F3-06: payment links (plantilla "págame"; abrir el link genera una sesión
    // — reutiliza el recurso de checkout).
    const paymentLinkService = new PaymentLinkService(appPool, {
      checkoutBaseUrl: config.checkoutBaseUrl,
      intents: paymentIntentService,
      checkout: checkoutSessionService,
    });
    registerPaymentLinkRoutes(app, { security, idempotencyService, paymentLinkService });
    // F3-03b: ingesta de webhooks del proveedor (firma HMAC, sin API key).
    // Rate-limited por IP (threat model §5); mismo backend inyectable que
    // /v1/auth/* — en despliegues compartidos la ventana vive en Redis (TM-03).
    registerProviderWebhookRoutes(app, {
      ingestService: new InboxIngestService(appPool),
      mockWebhookSecret: config.mockWebhookSecret,
      rateLimits: providerWebhookRateLimits,
      limiter: rateLimiter,
    });
    // F3-07: gestion de endpoints de webhooks salientes (scope webhooks:manage).
    // Instancia compartida: el plano de API key y el de sesión (F6.5B1) usan el
    // MISMO servicio (una sola fuente de lógica y de secretos).
    const webhookEndpointService = new WebhookEndpointService(appPool, {
      encKeyHex: config.webhookSecretEncKey,
      // Redes privadas SOLO local/test (guard por entorno, no configurable).
      allowPrivateNetworks: config.env === 'local' || config.env === 'test',
    });
    registerWebhookEndpointRoutes(app, { security, endpointService: webhookEndpointService });
    // F3-09a: visibilidad de la cola de webhooks + reenvío manual auditado de
    // eventos `dead` (plano de operación; primera acción del futuro dashboard).
    const webhookEventService = new WebhookEventService(appPool);
    registerWebhookEventRoutes(app, { security, webhookEventService });
    // F4-01b: gestión de conciliación (plano de integración). Carga el reporte
    // de liquidación del proveedor y dispara la conciliación.
    const reconciliationService = new ReconciliationService(appPool);
    registerSettlementRoutes(app, { security, reconciliationService });
    // F4-03a: casos operativos — cada discrepancia se materializa como un caso
    // (trigger 0029); aquí se listan y se gobierna su ciclo (documental, sin
    // mover dinero — el ajuste con four-eyes es F4-03b).
    const operationalCaseService = new OperationalCaseService(appPool);
    registerCaseRoutes(app, { security, operationalCaseService });
    // F4-03b/c: ajuste monetario con four-eyes. El motor postea el asiento
    // compensatorio (recon.differences↔suspense) y resuelve el caso al aprobar.
    const caseAdjustmentService = new CaseAdjustmentService(appPool, postingService, {
      fourEyesThresholdMinor: BigInt(config.fourEyesThresholdMinor),
    });
    // F3-09b-i / F4-03c: plano del dashboard por sesión + membresía (lectura
    // payments:read; operación de conciliación reconciliation:manage).
    registerDashboardRoutes(app, {
      security,
      idempotencyService,
      paymentIntentService,
      refundService,
      payoutService,
      disputeService,
      checkoutSessionService,
      paymentLinkService,
      webhookEventService,
      webhookEndpointService,
      reconciliationService,
      operationalCaseService,
      caseAdjustmentService,
    });
    // Plataforma del comercio (sandbox): catálogo, pedidos (venta de cobro
    // único por pedido), clientes, indicadores/caja y cuotas SIMULADAS.
    const orderService = new OrderService(appPool, paymentLinkService);
    registerCommerceRoutes(app, {
      security,
      idempotencyService,
      catalogService: new CatalogService(appPool),
      orderService,
      customerDirectory: new CustomerDirectory(appPool),
      summaryService: new SummaryService(appPool),
      installmentService: new InstallmentSandboxService(appPool, orderService),
      inventoryService: new InventoryService(appPool),
    });
    // Restaurantes / tipo de negocio: configuración del local, pedidos de
    // mesa, KDS en vivo y QR público (menú + pedido propio). Permisos de local
    // (venue_staff) evaluados en el servidor.
    const diningService = new DiningService(appPool);
    const billService = new BillService(appPool, paymentLinkService, diningService);
    const businessService = new BusinessProfileService(appPool);
    const venueService = new VenueService(appPool);
    const sandboxSimulation = config.env === 'local' || config.env === 'test';
    registerDiningRoutes(app, {
      security,
      idempotencyService,
      businessService,
      venueService,
      diningService,
      billService,
      sandboxSimulation,
      limiter: rateLimiter,
      checkoutBaseUrl: config.checkoutBaseUrl,
    });
    // Cobro presencial: sobre ventas de cobro único existentes; resultado
    // fijado por el servidor desde el intent. Simulador solo en local/test.
    registerInPersonRoutes(app, {
      security,
      venueService,
      sandboxSimulation,
      inPersonService: new InPersonService(appPool, {
        business: businessService,
        paymentLinks: paymentLinkService,
        checkout: checkoutSessionService,
        sandbox: sandboxSimulation,
      }),
    });
    // Tasas de referencia (BCV, USDT): lectura de la caché compartida.
    {
      const fxCfg = fxRefreshConfigFromEnv(process.env);
      const fxService =
        fx ??
        new FxService(appPool, {
          refreshEnabled: fxCfg.enabled,
          bcvIntervalSeconds: fxCfg.bcvIntervalSeconds,
          usdtIntervalSeconds: fxCfg.usdtIntervalSeconds,
          coingeckoKey: fxCfg.coingeckoApiKey ? (fxCfg.coingeckoPro ? 'pro' : 'demo') : 'sin_clave',
        });
      registerFxRoutes(app, { fx: fxService, limiter: rateLimiter });
    }
    // Directorio «Dónde comprar»: perfiles PUBLICADOS explícitamente por cada
    // comercio; lectura pública limitada por IP.
    registerDirectoryRoutes(app, {
      security,
      directoryService: new DirectoryService(appPool),
      limiter: rateLimiter,
    });
    // Tiendas Fluvia: el comercio publica su catálogo existente; el pedido es
    // un pedido normal del comercio (precio del servidor, reserva, cobro único).
    const shopService = new ShopService(appPool, orderService);
    registerShopMerchantRoutes(app, { security, shops: shopService, limiter: rateLimiter });
    // Jornada integral: Fluvia Personal (plano del cliente) y Fluvia
    // Operaciones (plano de operador sobre la organización programa), más la
    // resolución verificable de cobros/devoluciones inciertos del comercio.
    const merchantResolver = new UncertainPaymentResolver(
      appPool,
      routedProvider,
      confirmationService,
      refundService
    );
    if (personal) {
      registerPersonalRoutes(app, {
        personal,
        rateLimits: authRateLimits,
        limiter: rateLimiter,
        shop: {
          shops: shopService,
          links: paymentLinkService,
          checkout: checkoutSessionService,
          checkoutBaseUrl: config.checkoutBaseUrl,
        },
      });
    }
    const personalOrFallback = personal ?? createPersonalServices({ app: appPool, auth: appPool });
    registerProgramOpsRoutes(app, {
      security,
      personal: personalOrFallback,
      merchantResolver,
      sandboxSimulation: config.env === 'local' || config.env === 'test',
    });

    // Asistente «Fluvia» (Personal y Comercio): herramientas de LECTURA,
    // proveedores intercambiables, adjuntos en almacenamiento privado.
    const env = assistant?.env ?? process.env;
    const limits = loadAssistantLimits(env);
    const providers = assistant?.providers ?? createAssistantProviders(loadAssistantProviders(env));
    const storage =
      assistant?.storage ?? new LocalPrivateStorage(env.ASSISTANT_STORAGE_DIR ?? '.data/assistant');
    const store = new AssistantStore(appPool);
    const directory = new DirectoryService(appPool);
    const pTools = personalTools(personalOrFallback, directory, shopService);
    const cTools = commerceTools({
      summary: new SummaryService(appPool),
      directory,
      listUncertain: (t) => merchantResolver.listUncertain(t),
    });
    const bTools = buyerTools({
      appPool,
      dining: diningService,
      bills: billService,
      venue: venueService,
    });
    registerAssistantRoutes(app, {
      security,
      authenticateBuyer: buyerAuthenticator({
        appPool,
        checkout: checkoutSessionService,
        dining: diningService,
      }),
      authenticateConsumer: async (token) => {
        const id = await personalOrFallback.consumerAuth.authenticate(token);
        return { consumerId: id.consumerId, tenantId: id.tenantId };
      },
      engine: new AssistantEngine({
        store,
        storage,
        provider: providers.conversation,
        limits,
        // Mapa EXPLÍCITO: cada superficie solo ve sus herramientas.
        tools: (surface) =>
          surface === 'personal' ? pTools : surface === 'buyer' ? bTools : cTools,
        concurrency: assistant?.concurrency,
      }),
      store,
      storage,
      providers,
      limits,
      resolveActions: (ids, surface, orgId) => resolveActions(ids, surface, orgId),
      limiter: rateLimiter,
    });
  }

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorBody('not_found', req.id));
  });

  // F1-08: TODA respuesta de error sale del catalogo. El message interno de
  // los errores de dominio va SOLO a logs (AUD-P2-009); el cliente recibe el
  // texto publico y estable del catalogo.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(ERROR_CATALOG.validation_error.status).send(
        errorBody(
          'validation_error',
          req.id,
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
        )
      );
    }

    // Garantía final del motor (índice único 0046): si un camino se saltara el
    // guard de servicio, el 23505 se traduce al mismo conflicto de dominio.
    if (isSingleChargeViolation(err)) {
      req.log.warn({ err }, 'single-charge index rejected a second charge');
      return reply
        .code(ERROR_CATALOG.sale_already_charged.status)
        .send(errorBody('sale_already_charged', req.id));
    }

    // Guard del motor (0047): una venta de cobro único no se libera sin un
    // hecho verificado del proveedor, venga del camino que venga.
    if (isSaleReleaseUnverified(err)) {
      req.log.warn({ err }, 'single-charge release guard rejected a local release');
      return reply
        .code(ERROR_CATALOG.sale_release_unverified.status)
        .send(errorBody('sale_release_unverified', req.id));
    }

    // Guard del motor (0050): con un plan de cuotas SANDBOX vivo, la venta no
    // empieza otro cobro (tarjeta/transferencia), venga del camino que venga.
    if (isInstallmentPlanActive(err)) {
      req.log.warn({ err }, 'sandbox installment plan blocked a charge');
      return reply
        .code(ERROR_CATALOG.installment_plan_active.status)
        .send(errorBody('installment_plan_active', req.id));
    }

    // Guard del motor (0051): la venta fue anulada; ningún checkout suyo cobra.
    if (isOrderCancelled(err)) {
      req.log.warn({ err }, 'cancelled sale blocked a charge or plan');
      return reply
        .code(ERROR_CATALOG.order_cancelled.status)
        .send(errorBody('order_cancelled', req.id));
    }

    const code = DOMAIN_ERROR_CODES[err.name];
    if (code) {
      req.log.info({ errName: err.name, errMessage: err.message, code }, 'domain error');
      return reply.code(ERROR_CATALOG[code].status).send(errorBody(code, req.id));
    }

    // Errores del propio Fastify (forma del request), tambien via catalogo.
    if (err.statusCode === 413) {
      return reply.code(413).send(errorBody('payload_too_large', req.id));
    }
    if (err.statusCode === 415) {
      return reply.code(415).send(errorBody('unsupported_media_type', req.id));
    }
    if (
      err.statusCode === 400 &&
      typeof err.code === 'string' &&
      err.code.startsWith('FST_ERR_CTP')
    ) {
      return reply.code(400).send(errorBody('invalid_json', req.id));
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      req.log.warn({ err }, 'unmapped 4xx request error');
      return reply.code(400).send(errorBody('bad_request', req.id));
    }

    // 5xx: jamas filtra detalle interno al cliente.
    req.log.error({ err }, 'request failed');
    reply.code(500).send(errorBody('internal_error', req.id));
  });

  return app;
}
