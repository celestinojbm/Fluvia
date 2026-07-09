import { pino } from 'pino';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { InboxProcessor } from '@fluvia/inbox';
import { LedgerService, PostingService, ProjectionDriftWatcher } from '@fluvia/ledger';
import { MetricsRegistry } from '@fluvia/observability';
import { OutboxRelay } from '@fluvia/outbox';
import { WebhookDeliverer, createWebhookFanoutPublisher } from '@fluvia/webhooks';
import {
  DisputeService,
  FlatBpsFeeSchedule,
  MOCK_PROVIDER_NAME,
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  PayoutService,
  ResilientProvider,
  createMockInboxRegistration,
} from '@fluvia/payments-core';
import { AttemptsWatchdog } from './attempts-watchdog.js';
import { CheckoutSessionWatchdog } from './checkout-watchdog.js';
import { ReconciliationWatchdog, discrepancyCount } from './reconciliation-watchdog.js';
import { PayoutsWatchdog } from './payouts-watchdog.js';
import { PayoutsRedriver } from './payouts-redriver.js';
import { DisputesWatchdog } from './disputes-watchdog.js';
import { IdempotencyWatchdog } from './idempotency-watchdog.js';
import { LedgerCheckpointer } from './ledger-checkpointer.js';
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
const reportsReconciledTotal = registry.counter(
  'fluvia_settlement_reports_reconciled_total',
  'Reportes de liquidación conciliados por el watchdog (periodo cerrado)'
);
const reconciliationEntriesTotal = registry.counter(
  'fluvia_reconciliation_entries_total',
  'Entries de conciliación producidos por el watchdog, por resultado',
  ['status']
);
const reconciliationDiscrepancies = registry.gauge(
  'fluvia_reconciliation_discrepancies_last',
  'Discrepancias detectadas en el último barrido de conciliación (0 = cuadrado)'
);
const payoutsSweptTotal = registry.counter(
  'fluvia_payouts_swept_total',
  'Payouts barridos de in_transit a indeterminate (lease vencido)'
);
const payoutsIndeterminate = registry.gauge(
  'fluvia_payouts_indeterminate',
  'Payouts en indeterminate ahora mismo (fondos retenidos en tránsito)'
);
const payoutsIndeterminateAged = registry.gauge(
  'fluvia_payouts_indeterminate_aged',
  'Payouts indeterminate envejecidos (>30 min) — 0 = sano'
);
const payoutsRequestedStuck = registry.gauge(
  'fluvia_payouts_requested_stuck',
  'Payouts en requested cuyo execute nunca corrió (>5 min) — 0 = sano'
);
const payoutsRedrivenTotal = registry.counter(
  'fluvia_payouts_redriven_total',
  'Payouts `requested` atascados re-conducidos por el redriver, por resultado',
  ['result']
);
const disputesHeld = registry.gauge(
  'fluvia_disputes_held',
  'Disputas vivas (open/under_review) ahora mismo — fondos apartados en dispute.reserve'
);
const disputesAged = registry.gauge(
  'fluvia_disputes_aged',
  'Disputas vivas envejecidas (>7 días) — 0 = sano; riesgo de pérdida por no responder'
);
const idempotencyInProgress = registry.gauge(
  'fluvia_idempotency_in_progress',
  'Claims de idempotencia `in_progress` ahora mismo (cross-tenant)'
);
const idempotencyInProgressAged = registry.gauge(
  'fluvia_idempotency_in_progress_aged',
  'Huérfanos `in_progress` envejecidos (>1 h) — 0 = sano; bloquean su key hasta la purga'
);
const ledgerChainCheckpoints = registry.gauge(
  'fluvia_ledger_chain_checkpoints',
  'Checkpoints sellados del hash-chain del ledger (0042) — tamper-evidence'
);
const ledgerChainSealedUpto = registry.gauge(
  'fluvia_ledger_chain_sealed_upto_seq',
  'Último seq de ledger_entries cubierto por la cadena — lo posterior es horizonte pendiente'
);
const ledgerChainUnsealedSeq = registry.gauge(
  'fluvia_ledger_chain_unsealed_seq',
  'Rezago de detección: seq aún sin sellar. Si NO decrece, el sellador está atascado/caído (su fallo es silencioso) — el punto ciego que la alerta de estancamiento cubre'
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
const inboxPosting = new PostingService(new LedgerService(appPool), appPool);
const inboxProvider = new ResilientProvider(new MockPaymentProvider());
const confirmation = new PaymentConfirmationService(
  appPool,
  paymentIntents,
  inboxPosting,
  inboxProvider,
  new FlatBpsFeeSchedule(config.platformFeeBps)
);
// F4-07c-ii + F4-07e: un solo PayoutService sobre el appPool sirve dos consumos
// del worker — el webhook firmado del banco lo resuelve (`resolveFromProvider`,
// fuente verificada, jamas por asuncion — V4 §23) y el redriver re-conduce los
// `requested` atascados (`execute`, seguro: el banco jamas fue contactado).
const payouts = new PayoutService(appPool, inboxPosting, inboxProvider);
// F4-08c: el mismo webhook firmado del banco ABRE disputas (dispute.opened,
// idempotente por provider_ref) y las RESUELVE (dispute.won/lost) por fuente
// verificada — jamas por asuncion (V4 §23).
const disputes = new DisputeService(appPool, inboxPosting);
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
inboxProcessor.register(
  MOCK_PROVIDER_NAME,
  createMockInboxRegistration(confirmation, payouts, disputes)
);
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
// F4-02: conciliación continua. La politica vive en sweep_settlement_reports()
// (0028); el job la invoca, expone metricas y ALERTA ante discrepancias.
const reconciliationWatchdog = new ReconciliationWatchdog(workerPool, logger, {
  onResult: (r) => {
    if (r.reportsReconciled > 0) reportsReconciledTotal.inc({}, r.reportsReconciled);
    if (r.matched > 0) reconciliationEntriesTotal.inc({ status: 'matched' }, r.matched);
    if (r.amountMismatch > 0)
      reconciliationEntriesTotal.inc({ status: 'amount_mismatch' }, r.amountMismatch);
    if (r.missingInLedger > 0)
      reconciliationEntriesTotal.inc({ status: 'missing_in_ledger' }, r.missingInLedger);
    if (r.missingAtProvider > 0)
      reconciliationEntriesTotal.inc({ status: 'missing_at_provider' }, r.missingAtProvider);
    reconciliationDiscrepancies.set({}, discrepancyCount(r));
  },
});
// F4-07c: robustez del plano de payouts. La politica vive en sweep_payouts()
// (0034); el job la invoca, expone metricas y ALERTA ante indeterminados
// envejecidos + requested atascados. Un payout barrido queda indeterminate
// (fondos retenidos), jamas failed por asuncion (V4 §23).
const payoutsWatchdog = new PayoutsWatchdog(workerPool, logger, {
  onResult: (health) => {
    if (health.sweptToIndeterminate > 0) payoutsSweptTotal.inc({}, health.sweptToIndeterminate);
    payoutsIndeterminate.set({}, health.indeterminateTotal);
    payoutsIndeterminateAged.set({}, health.indeterminateAged);
    payoutsRequestedStuck.set({}, health.requestedStuck);
  },
});
// F4-07e: re-drive de los `requested` atascados que F4-07c surfacea. La
// serializacion (lease + SKIP LOCKED) vive en claim_stuck_payouts() (0035); el
// job reclama y llama execute — seguro, el banco jamas fue contactado.
const payoutsRedriver = new PayoutsRedriver(workerPool, payouts, logger, {
  onResult: (r) => {
    if (r.redriven > 0) payoutsRedrivenTotal.inc({ result: 'redriven' }, r.redriven);
    if (r.failed > 0) payoutsRedrivenTotal.inc({ result: 'failed' }, r.failed);
  },
});
// F4-10: salud del plano de disputas. La politica vive en sweep_disputes()
// (0038); el job la invoca, expone los gauges y ALERTA ante disputas
// envejecidas. NO transiciona nada (la resolucion es solo por fuente verificada,
// V4 §23) — solo surfacea el dinero apartado a riesgo.
const disputesWatchdog = new DisputesWatchdog(workerPool, logger, {
  onResult: (health) => {
    disputesHeld.set({}, health.heldTotal);
    disputesAged.set({}, health.heldAged);
  },
});
// F6 (threat model §5): salud de la capa de idempotencia. La política vive en
// sweep_idempotency_orphans() (0041); el job la invoca, expone los gauges y
// ALERTA ante huérfanos `in_progress` envejecidos. NO transiciona nada (un
// in_progress podría ser una op multi-paso externa viva — borrarlo arriesgaría
// doble ejecución) — solo surfacea las keys bloqueadas.
const idempotencyWatchdog = new IdempotencyWatchdog(workerPool, logger, {
  onResult: (health) => {
    idempotencyInProgress.set({}, health.inProgressTotal);
    idempotencyInProgressAged.set({}, health.inProgressAged);
  },
});
// F6 (threat model §5, fila Ledger): sellador del hash-chain de tamper-evidence
// (0042). Sella checkpoints en dos fases (candidato → finalización tras el
// horizonte de txid); la VERIFICACIÓN corre como check [7] de
// verify-ledger-invariants.sql (CI por commit + restore drill), no aquí.
const ledgerCheckpointer = new LedgerCheckpointer(workerPool, logger, {
  onResult: (health) => {
    ledgerChainCheckpoints.set({}, health.checkpointsTotal);
    ledgerChainSealedUpto.set({}, health.sealedUptoSeq);
    ledgerChainUnsealedSeq.set({}, health.unsealedSeq);
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
  reconciliationWatchdog.stop();
  payoutsWatchdog.stop();
  payoutsRedriver.stop();
  disputesWatchdog.stop();
  idempotencyWatchdog.stop();
  ledgerCheckpointer.stop();
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
    if (config.reconciliationWatchdog.enabled) {
      reconciliationWatchdog.start(config.reconciliationWatchdog.intervalMs);
      logger.info(
        { intervalMs: config.reconciliationWatchdog.intervalMs },
        'reconciliation watchdog started'
      );
    } else {
      logger.info(
        {},
        'reconciliation watchdog disabled by config (RECONCILIATION_WATCHDOG_ENABLED=false)'
      );
    }
    if (config.payoutsWatchdog.enabled) {
      payoutsWatchdog.start(config.payoutsWatchdog.intervalMs);
      logger.info({ intervalMs: config.payoutsWatchdog.intervalMs }, 'payouts watchdog started');
    } else {
      logger.info({}, 'payouts watchdog disabled by config (PAYOUTS_WATCHDOG_ENABLED=false)');
    }
    if (config.payoutsRedriver.enabled) {
      payoutsRedriver.start(config.payoutsRedriver.intervalMs);
      logger.info({ intervalMs: config.payoutsRedriver.intervalMs }, 'payouts redriver started');
    } else {
      logger.info({}, 'payouts redriver disabled by config (PAYOUTS_REDRIVER_ENABLED=false)');
    }
    if (config.disputesWatchdog.enabled) {
      disputesWatchdog.start(config.disputesWatchdog.intervalMs);
      logger.info({ intervalMs: config.disputesWatchdog.intervalMs }, 'disputes watchdog started');
    } else {
      logger.info({}, 'disputes watchdog disabled by config (DISPUTES_WATCHDOG_ENABLED=false)');
    }
    if (config.idempotencyWatchdog.enabled) {
      idempotencyWatchdog.start(config.idempotencyWatchdog.intervalMs);
      logger.info(
        { intervalMs: config.idempotencyWatchdog.intervalMs },
        'idempotency watchdog started'
      );
    } else {
      logger.info(
        {},
        'idempotency watchdog disabled by config (IDEMPOTENCY_WATCHDOG_ENABLED=false)'
      );
    }
    if (config.ledgerCheckpoint.enabled) {
      ledgerCheckpointer.start(config.ledgerCheckpoint.intervalMs);
      logger.info(
        { intervalMs: config.ledgerCheckpoint.intervalMs },
        'ledger checkpointer started'
      );
    } else {
      logger.info({}, 'ledger checkpointer disabled by config (LEDGER_CHECKPOINT_ENABLED=false)');
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
