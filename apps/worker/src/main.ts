import { pino } from 'pino';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { OutboxRelay, createLogPublisher } from '@fluvia/outbox';
import { WorkerProcess } from './worker.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel });
const workerPool = createPool({ connectionString: config.db.worker });
const relayPool = createPool({ connectionString: config.db.relay, max: 4 });

const worker = new WorkerProcess({ pool: workerPool, logger });
// F2-11: relay del outbox. Publisher actual = log estructurado (sandbox);
// la entrega efectiva a consumidores llega con F2-12 (inbox) y F3-07 (webhooks).
const relay = new OutboxRelay(relayPool, createLogPublisher(logger), { logger });

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'graceful shutdown started');
  relay.stop();
  await worker.stop();
  await Promise.all([workerPool.end(), relayPool.end()]);
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
  })
  .catch((err: unknown) => {
    logger.error({ err }, 'worker failed readiness check');
    process.exit(1);
  });
