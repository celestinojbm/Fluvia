import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Pool } from '@fluvia/db';
import { DEV_WEBHOOK_SECRET_ENC_KEY_HEX, decryptEndpointSecret } from './crypto.js';
import { buildSignatureHeader } from './signing.js';
import { resolveSafeWebhookTarget, type SsrfGuardOptions } from './ssrf.js';

/**
 * Deliverer de webhooks salientes (F3-07) — claim-lease identico al relay
 * (FOR UPDATE SKIP LOCKED; el claim ES el lease) sobre webhook_events, con
 * el rol minimo fluvia_webhook (0019).
 *
 * Por intento (webhook-delivery.md §3/§4):
 *  - SSRF guard COMPLETO en CADA intento (re-resolucion + denylist) y
 *    conexion PINEADA a la IP validada (anti DNS-rebinding); la IP queda
 *    registrada en webhook_attempts.
 *  - Firma versionada v1 (+ secreto anterior durante la ventana de rotacion).
 *  - Exito = 2xx. Redirects NO se siguen (3xx = fallo). Timeout duro.
 *  - Calendario de reintentos 0s,30s,2m,10m,1h,6h,24h -> dead (§3). El
 *    historial completo vive en webhook_attempts (append-only).
 */

export const RETRY_SCHEDULE_MS: readonly number[] = [
  0, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000,
];

export interface DelivererLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface WebhookDelivererOptions {
  workerId?: string;
  batchSize?: number;
  /** Lease del claim (default 60 s: cubre el timeout HTTP con margen). */
  leaseMs?: number;
  /** Timeout por intento (default 10 s, §3). */
  requestTimeoutMs?: number;
  encKeyHex?: string;
  ssrf?: SsrfGuardOptions;
  logger?: DelivererLogger;
  /** F1-07: observador de metricas por ciclo. Sus errores JAMAS afectan al deliverer. */
  onStats?: (stats: DelivererRunStats) => void;
}

export interface DelivererRunStats {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  topic: string;
  payload: unknown;
  attempts: number;
}

interface EndpointRow {
  url: string;
  status: string;
  secret_enc: string;
  prev_secret_enc: string | null;
  prev_secret_expires_at: Date | null;
}

export class WebhookDeliverer {
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly requestTimeoutMs: number;
  private readonly encKeyHex: string;
  private readonly ssrf: SsrfGuardOptions;
  private readonly logger: DelivererLogger | undefined;
  private readonly onStats: ((stats: DelivererRunStats) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_webhook (privilegio minimo, 0019). */
    private readonly webhookPool: Pool,
    options: WebhookDelivererOptions = {}
  ) {
    this.workerId = options.workerId ?? `webhook-${process.pid}`;
    this.batchSize = options.batchSize ?? 25;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.encKeyHex = options.encKeyHex ?? DEV_WEBHOOK_SECRET_ENC_KEY_HEX;
    this.ssrf = options.ssrf ?? {};
    this.logger = options.logger;
    this.onStats = options.onStats;
  }

  async runOnce(): Promise<DelivererRunStats> {
    const stats: DelivererRunStats = { claimed: 0, delivered: 0, retried: 0, dead: 0 };

    const claimed = await this.webhookPool.query<ClaimedRow>(
      `WITH eligible AS (
         SELECT id FROM webhook_events
         WHERE status = 'pending' AND attempts < $1 AND next_attempt_at <= now()
         ORDER BY next_attempt_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE webhook_events w
       SET attempts = w.attempts + 1,
           next_attempt_at = now() + make_interval(secs => $3::float8 / 1000),
           locked_by = $4
       FROM eligible e
       WHERE w.id = e.id
       RETURNING w.id, w.tenant_id, w.endpoint_id, w.topic, w.payload, w.attempts`,
      [RETRY_SCHEDULE_MS.length, this.batchSize, this.leaseMs, this.workerId]
    );
    stats.claimed = claimed.rowCount ?? 0;

    for (const row of claimed.rows) {
      const started = Date.now();
      let statusCode: number | null = null;
      let resolvedIp: string | null = null;
      let error: string | null = null;

      try {
        const endpoint = await this.loadEndpoint(row.endpoint_id);
        if (!endpoint || endpoint.status !== 'active') {
          // Endpoint deshabilitado: la cola muere sin intentos de red.
          await this.finish(row, stats, 'dead', 'endpoint disabled or missing');
          await this.recordAttempt(row, null, 'endpoint disabled or missing', 0, null);
          continue;
        }

        // SSRF §4: re-resolucion + denylist + pinning EN CADA intento.
        const target = await resolveSafeWebhookTarget(endpoint.url, this.ssrf);
        resolvedIp = target.ip;

        const rawBody = JSON.stringify(row.payload);
        const timestampSec = Math.floor(Date.now() / 1000);
        const eventId = `whe_${row.id}`;
        const secrets = [decryptEndpointSecret(this.encKeyHex, endpoint.secret_enc)];
        if (
          endpoint.prev_secret_enc &&
          endpoint.prev_secret_expires_at &&
          endpoint.prev_secret_expires_at.getTime() > Date.now()
        ) {
          secrets.push(decryptEndpointSecret(this.encKeyHex, endpoint.prev_secret_enc));
        }

        statusCode = await this.post(target, endpoint.url, rawBody, {
          'content-type': 'application/json',
          'user-agent': 'Fluvia-Webhooks/1.0',
          'fluvia-event-id': eventId,
          'fluvia-topic': row.topic,
          'fluvia-timestamp': String(timestampSec),
          'fluvia-attempt-id': `wha_${row.id}_${row.attempts}`,
          'fluvia-signature': buildSignatureHeader(secrets, timestampSec, eventId, rawBody),
        });

        if (statusCode >= 200 && statusCode < 300) {
          await this.finish(row, stats, 'delivered', null);
        } else {
          error = `non-2xx response: ${statusCode}`;
          await this.scheduleRetryOrDead(row, stats, error);
        }
      } catch (err) {
        error = String(err).slice(0, 500);
        await this.scheduleRetryOrDead(row, stats, error);
      }

      await this.recordAttempt(row, statusCode, error, Date.now() - started, resolvedIp);
    }

    try {
      this.onStats?.(stats);
    } catch (err) {
      this.logger?.error({ err: String(err) }, 'deliverer stats observer failed (ignored)');
    }
    return stats;
  }

  start(intervalMs = 1_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .then((stats) => {
          if (stats.claimed > 0) this.logger?.info({ ...stats }, 'webhook delivery cycle');
        })
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'webhook delivery cycle failed');
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async loadEndpoint(endpointId: string): Promise<EndpointRow | undefined> {
    const res = await this.webhookPool.query<EndpointRow>(
      `SELECT url, status, secret_enc, prev_secret_enc, prev_secret_expires_at
       FROM webhook_endpoints WHERE id = $1`,
      [endpointId]
    );
    return res.rows[0];
  }

  private post(
    target: { protocol: string; hostname: string; port: number; path: string; ip: string },
    _originalUrl: string,
    body: string,
    headers: Record<string, string>
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const isHttps = target.protocol === 'https:';
      const req = (isHttps ? httpsRequest : httpRequest)({
        // Pinning: conectamos a la IP validada; Host/SNI llevan el hostname.
        host: target.ip,
        port: target.port,
        path: target.path,
        method: 'POST',
        setHost: false,
        headers: { ...headers, host: target.hostname },
        timeout: this.requestTimeoutMs,
        ...(isHttps ? { servername: target.hostname } : {}),
      });
      req.on('response', (res) => {
        // Limite de tamano de respuesta: solo drenamos, nunca almacenamos.
        let drained = 0;
        res.on('data', (chunk: Buffer) => {
          drained += chunk.length;
          if (drained > 64 * 1024) res.destroy();
        });
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('close', () => resolve(res.statusCode ?? 0));
      });
      req.on('timeout', () => {
        req.destroy(new Error(`webhook request timed out after ${this.requestTimeoutMs}ms`));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  private async finish(
    row: ClaimedRow,
    stats: DelivererRunStats,
    status: 'delivered' | 'dead',
    error: string | null
  ): Promise<void> {
    await this.webhookPool.query(
      `UPDATE webhook_events
       SET status = $2,
           delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
           last_error = $3, locked_by = NULL
       WHERE id = $1 AND status = 'pending'`,
      [row.id, status, error]
    );
    if (status === 'delivered') stats.delivered += 1;
    else stats.dead += 1;
  }

  private async scheduleRetryOrDead(
    row: ClaimedRow,
    stats: DelivererRunStats,
    error: string
  ): Promise<void> {
    if (row.attempts >= RETRY_SCHEDULE_MS.length) {
      await this.finish(row, stats, 'dead', error);
      this.logger?.error(
        { webhookEventId: row.id, attempts: row.attempts },
        'webhook exhausted retry schedule, moved to dead'
      );
      return;
    }
    const delay =
      RETRY_SCHEDULE_MS[row.attempts] ?? RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1]!;
    await this.webhookPool.query(
      `UPDATE webhook_events
       SET next_attempt_at = now() + make_interval(secs => $2::float8 / 1000),
           last_error = $3, locked_by = NULL
       WHERE id = $1 AND status = 'pending'`,
      [row.id, delay, error]
    );
    stats.retried += 1;
  }

  private async recordAttempt(
    row: ClaimedRow,
    statusCode: number | null,
    error: string | null,
    latencyMs: number,
    resolvedIp: string | null
  ): Promise<void> {
    await this.webhookPool
      .query(
        `INSERT INTO webhook_attempts
           (tenant_id, webhook_event_id, attempt_number, status_code, error, latency_ms, resolved_ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (webhook_event_id, attempt_number) DO NOTHING`,
        [row.tenant_id, row.id, row.attempts, statusCode, error, latencyMs, resolvedIp]
      )
      .catch((err: unknown) => {
        this.logger?.error(
          { err: String(err), webhookEventId: row.id },
          'failed to record webhook attempt (delivery state already persisted)'
        );
      });
  }
}
