import { pino } from 'pino';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { InboxProcessor } from '@fluvia/inbox';
import { LedgerService, PostingService, ProjectionDriftWatcher } from '@fluvia/ledger';
import { MetricsRegistry } from '@fluvia/observability';
import { OutboxRelay } from '@fluvia/outbox';
import { WebhookDeliverer, createWebhookFanoutPublisher } from '@fluvia/webhooks';
import {
  MOCK_PROVIDER_NAME,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  ResilientProvider,
  createMockInboxRegistration,
} from '@fluvia/payments-core';
import { AttemptsWatchdog } from './attempts-watchdog.js';
import { CheckoutSessionWatchdog } from './checkout-watchdog.js';
import { createMetricsServer } from './metrics-server.js';
import { TechnicalPurgeJob } from './purge.js';
import { WorkerProcess } from './worker.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const workerPool = createPool({ connectionString: config.db.worker });
const relayPool = createPool({ connectionString: config.db.relay, max: 4 });
// F3-03b: el handler del inbox actua como la aplicacion (RLS por tenant) y el
// claim de eventos usa el rol minimo fluvia_inbox (ADR-0011).
const inboxPool = createPool({ connectionString: config.db.inbox, max: 4 });
const appPool = createPool({ connectionString: config.db.app, max: 4 });
// F3-07: rol minimo del deliverer de webhooks salientes (0019).
const webhookPool = createPool({ connectionString: config.db.webhook, max: 4 });

// F1-07: metricas del plano worker (agregados anonimos, servidas en
// WORKER_METRICS_PORT). Las alertas baseline viven en observability.md.
const registry = new MetricsRegistry();
const heartbeatsTotal = registry.counter(
  'fluvia_worker_heartbeats_total',
  'Latidos del proceso worker'
);
const relayCyclesTotal = registry.counter(
  'fluvia_outbox_relay_cycles_total',
  'Ciclos completados del outbox relay'
);
const relayEventsTotal = registry.counter(
  'fluvia_outbox_relay_events_total',
  'Eventos del outbox por resultado de intento',
  ['result']
);
const driftChecksTotal = registry.counter(
  'fluvia_ledger_projection_drift_checks_total',
  'Chequeos de drift proyeccion-ledger ejecutados'
);
const driftAccounts = registry.gauge(
  'fluvia_ledger_projection_drift_accounts',
  'Cuentas con drift detectado en el ultimo chequeo (0 = sano)'
);
const purgeRunsTotal = registry.counter(
  'fluvia_technical_purge_runs_total',
  'Corridas del job de purga de datos tecnicos'
);
const purgeRowsTotal = registry.counter(
  'fluvia_technical_purge_rows_total',
  'Filas purgadas por clase tecnica',
  ['class']
);
const inboxCyclesTotal = registry.counter(
  'fluvia_inbox_cycles_total',
  'Ciclos completados del procesador del inbox'
);
const inboxEventsTotal = registry.counter(
  'fluvia_inbox_events_total',
  'Eventos del inbox por resultado de intento',
  ['result']
);
const attemptsSweptTotal = registry.counter(
  'fluvia_payment_attempts_swept_total',
  'Attempts barridos de submitting a indeterminate (lease vencido)'
);
const attemptsIndeterminate = registry.gauge(
  'fluvia_payment_attempts_indeterminate',
  'Attempts en indeterminate ahora mismo'
);
const attemptsIndeterminateAged = registry.gauge(
  'fluvia_payment_attempts_indeterminate_aged',
  'Attempts indeterminate envejecidos (>30 min) — 0 = sano'
);
const webhookDeliveriesTotal = registry.counter(
  'fluvia_webhook_deliveries_total',
  'Entregas de webhooks salientes por resultado',
  ['result']
);
const checkoutSweptTotal = registry.counter(
  'fluvia_checkout_sessions_swept_total',
  'Sesiones de checkout barridas por el watchdog (entrega garantizada)',
  ['result']
);

const worker = new WorkerProcess({
  pool: workerPool,
  logger,
  onHeartbeat: () => heartbeatsTotal.inc(),
});
// F2-11+F3-07: el relay del outbox hace FAN-OUT hacia la cola de webhooks
// (unico origen legitimo de un webhook saliente, webhook-delivery.md §1).
const relay = new OutboxRelay(relayPool, createWebhookFanoutPublisher(relayPool, logger), {
  logger,
  onStats: (stats) => {
    relayCyclesTotal.inc();
    if (stats.delivered > 0) relayEventsTotal.inc({ result: 'delivered' }, stats.delivered);
    if (stats.retried > 0) relayEventsTotal.inc({ result: 'retried' }, stats.retried);
    if (stats.dead > 0) relayEventsTotal.inc({ result: 'dead' }, stats.dead);
  },
});
// F2-05: vigilancia programada de drift proyeccion<->ledger (funcion definer
// 0011, unica ventana del rol worker). Drift => log error + gauge en alerta;
// reparar es SIEMPRE una accion explicita (rebuildProjection), jamas automatica.
const driftWatcher = new ProjectionDriftWatcher(workerPool, logger, {
  onCheck: (rows) => {
    driftChecksTotal.inc();
    driftAccounts.set({}, rows.length);
  },
});
// F1-09: purga de datos tecnicos. La politica (clases, retenciones, auditoria
// atomica) vive en purge_technical_data() (0015); el job solo la invoca.
const purgeJob = new TechnicalPurgeJob(workerPool, logger, {
  onResult: (rows) => {
    purgeRunsTotal.inc();
    for (const row of rows) {
      if (row.purged > 0) purgeRowsTotal.inc({ class: row.class }, row.purged);
    }
  },
});
// F3-03b: primer handler real del inbox — resuelve attempts asincronos o
// indeterminados del MockProvider por webhook firmado (fuente verificada).
const paymentIntents = new PaymentIntentService(appPool);
const confirmation = new PaymentConfirmationService(
  appPool,
  paymentIntents,
  new PostingService(new LedgerService(appPool), appPool),
  new ResilientProvider(new MockPaymentProvider())
);
const inboxProcessor = new InboxProcessor(inboxPool, {
  logger,
  onStats: (stats) => {
    inboxCyclesTotal.inc();
    if (stats.processed > 0) inboxEventsTotal.inc({ result: 'processed' }, stats.processed);
    if (stats.ignored > 0) inboxEventsTotal.inc({ result: 'ignored' }, stats.ignored);
    if (stats.retried > 0) inboxEventsTotal.inc({ result: 'retried' }, stats.retried);
    if (stats.dead > 0) inboxEventsTotal.inc({ result: 'dead' }, stats.dead);
  },
});
inboxProcessor.register(MOCK_PROVIDER_NAME, createMockInboxRegistration(confirmation));
// F3-04: barrido submitting->indeterminate + salud de indeterminados. La
// politica vive en sweep_payment_attempts() (0018); el job la invoca.
const attemptsWatchdog = new AttemptsWatchdog(workerPool, logger, {
  onResult: (health) => {
    if (health.sweptToIndeterminate > 0) attemptsSweptTotal.inc({}, health.sweptToIndeterminate);
    attemptsIndeterminate.set({}, health.indeterminateTotal);
    attemptsIndeterminateAged.set({}, health.indeterminateAged);
  },
});
// F3-05c-ii: entrega garantizada de eventos de checkout. La politica vive en
// sweep_checkout_sessions() (0024); el job la invoca y expone metricas.
const checkoutWatchdog = new CheckoutSessionWatchdog(workerPool, logger, {
  onResult: (r) => {
    if (r.completed > 0) checkoutSweptTotal.inc({ result: 'completed' }, r.completed);
    if (r.expired > 0) checkoutSweptTotal.inc({ result: 'expired' }, r.expired);
  },
});
// F3-07: deliverer de webhooks salientes — firma versionada, SSRF guard con
// pinning por intento, calendario de reintentos del contrato.
const webhookDeliverer = new WebhookDeliverer(webhookPool, {
  encKeyHex: config.webhookSecretEncKey,
  // Redes privadas SOLO en local/test: guard duro por entorno, no por env var.
  ssrf: { allowPrivateNetworks: config.env === 'local' || config.env === 'test' },
  logger,
  onStats: (stats) => {
    if (stats.delivered > 0) webhookDeliveriesTotal.inc({ result: 'delivered' }, stats.delivered);
    if (stats.retried > 0) webhookDeliveriesTotal.inc({ result: 'retried' }, stats.retried);
    if (stats.dead > 0) webhookDeliveriesTotal.inc({ result: 'dead' }, stats.dead);
  },
});

const metricsServer = createMetricsServer({
  registry,
  healthInfo: () => ({ heartbeats: worker.heartbeats, env: config.env }),
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'graceful shutdown started');
  relay.stop();
  driftWatcher.stop();
  purgeJob.stop();
  inboxProcessor.stop();
  attemptsWatchdog.stop();
  checkoutWatchdog.stop();
  webhookDeliverer.stop();
  metricsServer.close();
  await worker.stop();
  await Promise.all([
    workerPool.end(),
    relayPool.end(),
    inboxPool.end(),
    appPool.end(),
    webhookPool.end(),
  ]);
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

worker
  .checkReady()
  .then(async () => {
    // El relay tambien debe poder conectar antes de declararse listo.
    await relayPool.query('SELECT 1');
    logger.info({ env: config.env }, 'worker ready, starting heartbeat');
    worker.start();
    if (config.relay.enabled) {
      relay.start(config.relay.intervalMs);
      logger.info({ intervalMs: config.relay.intervalMs }, 'outbox relay started');
    } else {
      logger.info({}, 'outbox relay disabled by config (RELAY_ENABLED=false)');
    }
    if (config.driftCheck.enabled) {
      driftWatcher.start(config.driftCheck.intervalMs);
      logger.info({ intervalMs: config.driftCheck.intervalMs }, 'projection drift watcher started');
    } else {
      logger.info({}, 'projection drift watcher disabled by config (DRIFT_CHECK_ENABLED=false)');
    }
    if (config.purge.enabled) {
      purgeJob.start(config.purge.intervalMs);
      logger.info({ intervalMs: config.purge.intervalMs }, 'technical purge job started');
    } else {
      logger.info({}, 'technical purge job disabled by config (PURGE_ENABLED=false)');
    }
    if (config.inbox.enabled) {
      inboxProcessor.start(config.inbox.intervalMs);
      logger.info(
        { intervalMs: config.inbox.intervalMs },
        'inbox processor started (mock handler)'
      );
    } else {
      logger.info({}, 'inbox processor disabled by config (INBOX_ENABLED=false)');
    }
    if (config.attemptsWatchdog.enabled) {
      attemptsWatchdog.start(config.attemptsWatchdog.intervalMs);
      logger.info({ intervalMs: config.attemptsWatchdog.intervalMs }, 'attempts watchdog started');
    } else {
      logger.info({}, 'attempts watchdog disabled by config (ATTEMPTS_WATCHDOG_ENABLED=false)');
    }
    if (config.checkoutWatchdog.enabled) {
      checkoutWatchdog.start(config.checkoutWatchdog.intervalMs);
      logger.info({ intervalMs: config.checkoutWatchdog.intervalMs }, 'checkout watchdog started');
    } else {
      logger.info({}, 'checkout watchdog disabled by config (CHECKOUT_WATCHDOG_ENABLED=false)');
    }
    if (config.webhookDelivery.enabled) {
      webhookDeliverer.start(config.webhookDelivery.intervalMs);
      logger.info({ intervalMs: config.webhookDelivery.intervalMs }, 'webhook deliverer started');
    } else {
      logger.info({}, 'webhook deliverer disabled by config (WEBHOOK_DELIVERY_ENABLED=false)');
    }
    metricsServer.listen(config.workerMetricsPort, '0.0.0.0', () => {
      logger.info({ port: config.workerMetricsPort }, 'worker metrics server listening');
    });
  })
  .catch((err: unknown) => {
    logger.error({ err }, 'worker failed readiness check');
    process.exit(1);
  });
