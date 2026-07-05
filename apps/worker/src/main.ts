import { pino } from 'pino';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { InboxProcessor } from '@fluvia/inbox';
import { LedgerService, PostingService, ProjectionDriftWatcher } from '@fluvia/ledger';
import { MetricsRegistry } from '@fluvia/observability';
import { OutboxRelay, createLogPublisher } from '@fluvia/outbox';
import {
  MOCK_PROVIDER_NAME,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  createMockInboxRegistration,
} from '@fluvia/payments-core';
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

const worker = new WorkerProcess({
  pool: workerPool,
  logger,
  onHeartbeat: () => heartbeatsTotal.inc(),
});
// F2-11: relay del outbox. Publisher actual = log estructurado (sandbox);
// la entrega efectiva a consumidores llega con F2-12 (inbox) y F3-07 (webhooks).
const relay = new OutboxRelay(relayPool, createLogPublisher(logger), {
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
  new MockPaymentProvider()
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
  metricsServer.close();
  await worker.stop();
  await Promise.all([workerPool.end(), relayPool.end(), inboxPool.end(), appPool.end()]);
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
    metricsServer.listen(config.workerMetricsPort, '0.0.0.0', () => {
      logger.info({ port: config.workerMetricsPort }, 'worker metrics server listening');
    });
  })
  .catch((err: unknown) => {
    logger.error({ err }, 'worker failed readiness check');
    process.exit(1);
  });
