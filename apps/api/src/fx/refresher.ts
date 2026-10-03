import type { Pool } from '@fluvia/db';
import { bcvHistoryFile, parseBcvHistoryXls, parseBcvHome } from './bcv.js';
import { coinGeckoRequest, parseCoinGecko } from './coingecko.js';
import { HttpError, httpsGet, type FetchLike } from './http.js';
import { caracasDate, type FxService } from './service.js';

/**
 * Refresco en SERVIDOR con caché compartida (la tabla de lecturas):
 *  - un temporizador por fuente; intervalo configurable;
 *  - una sola réplica consulta a la vez (pg_try_advisory_lock) y ninguna lo
 *    hace si otra tuvo éxito hace menos de un intervalo;
 *  - reintentos ACOTADOS con backoff exponencial dentro de cada ciclo y, si
 *    el ciclo falla, el siguiente se aplaza (×2 por fallo, tope 6 h);
 *  - respeta Retry-After (429) del proveedor.
 * Un fallo nunca borra ni re-fecha lecturas: solo actualiza fx_source_status.
 */
export interface FxRefreshConfig {
  enabled: boolean;
  bcvUrl: string;
  bcvIntervalSeconds: number;
  usdtIntervalSeconds: number;
  coingeckoBaseUrl: string;
  coingeckoApiKey: string | null;
  coingeckoPro: boolean;
  timeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
}

export function fxRefreshConfigFromEnv(env: NodeJS.ProcessEnv): FxRefreshConfig {
  const num = (k: string, d: number, min: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= min ? v : d;
  };
  const pro = Boolean(env.FX_COINGECKO_PRO_API_KEY);
  return {
    enabled: (env.FX_REFRESH ?? (env.NODE_ENV === 'test' ? 'off' : 'on')) !== 'off',
    bcvUrl: env.FX_BCV_URL ?? 'https://www.bcv.org.ve/',
    // Mínimos para no abusar de las fuentes: BCV ≥ 10 min, USDT ≥ 1 min.
    bcvIntervalSeconds: num('FX_BCV_INTERVAL_SECONDS', 1800, 600),
    usdtIntervalSeconds: num('FX_USDT_INTERVAL_SECONDS', 300, 60),
    coingeckoBaseUrl:
      env.FX_COINGECKO_BASE_URL ??
      (pro ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3'),
    coingeckoApiKey: env.FX_COINGECKO_PRO_API_KEY ?? env.FX_COINGECKO_DEMO_API_KEY ?? null,
    coingeckoPro: pro,
    timeoutMs: num('FX_HTTP_TIMEOUT_MS', 20_000, 1000),
    maxAttempts: num('FX_MAX_ATTEMPTS', 3, 1),
    backoffBaseMs: num('FX_BACKOFF_BASE_MS', 2000, 0),
  };
}

const LOCK = { bcv: 0x46_58_42_43, coingecko: 0x46_58_43_47 }; // 'FXBC', 'FXCG'

export class FxRefresher {
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private failures = { bcv: 0, coingecko: 0 };

  constructor(
    private readonly pool: Pool,
    private readonly fx: FxService,
    private readonly cfg: FxRefreshConfig,
    private readonly log: {
      info: (o: object, m: string) => void;
      warn: (o: object, m: string) => void;
    },
    private readonly fetch: FetchLike = httpsGet,
    private readonly clock: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms))
  ) {}

  start(): void {
    if (!this.cfg.enabled) return;
    this.loop('bcv', 2_000);
    this.loop('coingecko', 4_000);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
  }

  private loop(source: 'bcv' | 'coingecko', delayMs: number): void {
    if (this.stopped) return;
    const t = setTimeout(async () => {
      const interval =
        (source === 'bcv' ? this.cfg.bcvIntervalSeconds : this.cfg.usdtIntervalSeconds) * 1000;
      let next = interval;
      try {
        const ok = await this.refresh(source);
        if (ok === false) next = Math.min(interval * 2 ** this.failures[source], 6 * 3600_000);
      } catch (err) {
        this.log.warn({ err, source }, 'fx refresh error');
      }
      this.loop(source, next);
    }, delayMs);
    t.unref?.();
    this.timers.push(t);
  }

  /**
   * Un ciclo para una fuente. Devuelve true (éxito), false (fallo tras los
   * reintentos) o null (otra réplica lo hizo o está reciente: no se consulta).
   */
  async refresh(source: 'bcv' | 'coingecko'): Promise<boolean | null> {
    const client = await this.pool.connect();
    try {
      const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        LOCK[source],
      ]);
      if (!got.rows[0]?.ok) return null;
      try {
        const status = await this.fx.sourceStatus(source);
        const interval =
          (source === 'bcv' ? this.cfg.bcvIntervalSeconds : this.cfg.usdtIntervalSeconds) * 1000;
        if (
          status.lastSuccessAt &&
          this.clock().getTime() - Date.parse(status.lastSuccessAt) < interval * 0.9
        ) {
          return null;
        }
        let lastErr = 'error';
        for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
          try {
            if (source === 'bcv') await this.fetchBcv();
            else await this.fetchUsdt();
            await this.fx.recordAttempt(source, true);
            this.failures[source] = 0;
            return true;
          } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err);
            const retryAfter = err instanceof RetryAfterError ? err.ms : 0;
            if (attempt < this.cfg.maxAttempts) {
              await this.sleep(Math.max(retryAfter, this.cfg.backoffBaseMs * 2 ** (attempt - 1)));
            }
          }
        }
        await this.fx.recordAttempt(source, false, lastErr);
        this.failures[source] += 1;
        this.log.warn(
          { source, error: lastErr },
          'fx source unavailable; keeping last valid reading'
        );
        return false;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK[source]]);
      }
    } finally {
      client.release();
    }
  }

  private async get(url: string, headers?: Record<string, string>) {
    const r = await this.fetch(url, {
      headers,
      timeoutMs: this.cfg.timeoutMs,
      maxBytes: 5_000_000,
    });
    if (r.status === 429) {
      throw new RetryAfterError(60_000);
    }
    if (r.status !== 200) throw new HttpError(`HTTP ${r.status} en ${new URL(url).host}`, r.status);
    return r;
  }

  async fetchBcv(): Promise<void> {
    const home = await this.get(this.cfg.bcvUrl);
    const reading = parseBcvHome(home.body.toString('utf8'));
    await this.fx.saveBcv(reading, 'bcv:portada');
    // Si la portada ya muestra una Fecha Valor futura (o no tenemos ninguna
    // aplicable hoy), el histórico oficial trae la que rige hoy.
    const today = caracasDate(this.clock());
    if (!(await this.fx.hasApplicableBcv(today))) {
      const files = [bcvHistoryFile(today)];
      const [y, m] = today.split('-').map(Number) as [number, number];
      const prevQuarterEnd = new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 0));
      files.push(bcvHistoryFile(prevQuarterEnd.toISOString().slice(0, 10)));
      for (const f of files) {
        try {
          const x = await this.get(f);
          for (const r of parseBcvHistoryXls(x.body)) {
            await this.fx.saveBcv(r, `bcv:historico:${f.split('/').pop()}`);
          }
        } catch (err) {
          this.log.warn({ err, file: f }, 'bcv history unavailable');
        }
        if (await this.fx.hasApplicableBcv(today)) break;
      }
    }
  }

  async fetchUsdt(): Promise<void> {
    const req = coinGeckoRequest({
      baseUrl: this.cfg.coingeckoBaseUrl,
      apiKey: this.cfg.coingeckoApiKey,
      pro: this.cfg.coingeckoPro,
    });
    const r = await this.get(req.url, req.headers);
    await this.fx.saveUsdt(
      parseCoinGecko(JSON.parse(r.body.toString('utf8'))),
      'coingecko:simple/price'
    );
  }
}

export class RetryAfterError extends Error {
  constructor(readonly ms: number) {
    super(`límite del proveedor (429); reintentar en ${Math.round(ms / 1000)} s`);
    this.name = 'RetryAfterError';
  }
}
