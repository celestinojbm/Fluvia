import type { Counter, Gauge, MetricsRegistry } from '@fluvia/observability';

/**
 * Frescura de los jobs periódicos del worker (follow-up de PR #110).
 *
 * Problema: los gauges de un watchdog (p. ej. `fluvia_merchants_denylisted_active`)
 * se quedan con su ÚLTIMO valor cuando el job deja de correr — porque falla
 * (`FLUVIA_MERCHANT_RISK_SWEEP_BLIND`, BD caída), porque una corrida se cuelga
 * (el guard `running` salta todas las siguientes sin loguear nada) o porque el
 * timer murió. Un 0 viejo se lee como "sano" y la alerta queda en verde sin ver
 * nada. El latido del worker no lo cubre: el proceso sigue vivo.
 *
 * Solución: cada job expone cuándo terminó BIEN por última vez y cada cuánto
 * debería correr. La regla (`observability.md` §4) es
 *
 *   time() - fluvia_worker_job_last_success_timestamp_seconds
 *     > 3 * fluvia_worker_job_interval_seconds
 *
 * Al registrarse un job habilitado, `last_success` arranca en la hora de
 * arranque (gracia): así la serie EXISTE desde el boot y un job que jamás logra
 * una corrida correcta también alerta, en vez de quedar como serie ausente que
 * ninguna comparación ve. `enabled` (0/1) se expone siempre, para que apagar un
 * watchdog por config sea visible y no se confunda con "sano".
 *
 * Métricas genéricas con label `task` (valor fijo del código, cardinalidad
 * acotada, sin identificadores de tenant): otro watchdog se suma con una línea
 * y hereda la misma regla.
 *
 * El label NO puede llamarse `job` (ni `instance`): Prometheus pone esos labels
 * a cada target al hacer scrape y, con `honor_labels: false` (el default),
 * renombra el expuesto a `exported_job`. Un selector `{job="merchant_risk"}`
 * no encontraría ninguna serie y la alerta quedaría en verde para siempre.
 */

export type JobRunResult = 'ok' | 'error';

export interface JobFreshnessTracker {
  /** Corrida terminada sin error: refresca `last_success`. */
  success(): void;
  /** Corrida fallida: solo cuenta; `last_success` NO se toca. */
  failure(): void;
}

export class JobFreshnessMetrics {
  private readonly lastSuccess: Gauge;
  private readonly interval: Gauge;
  private readonly enabled: Gauge;
  private readonly runs: Counter;
  private readonly tracked = new Set<string>();

  constructor(
    registry: MetricsRegistry,
    /** Reloj en ms (inyectable en tests). */
    private readonly now: () => number = Date.now
  ) {
    this.lastSuccess = registry.gauge(
      'fluvia_worker_job_last_success_timestamp_seconds',
      'Unix time de la última corrida correcta del job (o del arranque si aún no hubo ninguna)',
      ['task']
    );
    this.interval = registry.gauge(
      'fluvia_worker_job_interval_seconds',
      'Intervalo configurado del job; la alerta de frescura compara contra 3x este valor',
      ['task']
    );
    this.enabled = registry.gauge(
      'fluvia_worker_job_enabled',
      'Job habilitado por config (1) o apagado (0)',
      ['task']
    );
    this.runs = registry.counter('fluvia_worker_job_runs_total', 'Corridas del job por resultado', [
      'task',
      'result',
    ]);
  }

  track(job: string, opts: { enabled: boolean; intervalMs: number }): JobFreshnessTracker {
    if (this.tracked.has(job)) throw new Error(`job freshness already tracked: ${job}`);
    this.tracked.add(job);
    this.enabled.set({ task: job }, opts.enabled ? 1 : 0);
    if (opts.enabled) {
      this.interval.set({ task: job }, opts.intervalMs / 1000);
      this.lastSuccess.set({ task: job }, this.now() / 1000);
      // Series en 0 desde el arranque: `increase()` ve el primer error.
      this.runs.inc({ task: job, result: 'ok' }, 0);
      this.runs.inc({ task: job, result: 'error' }, 0);
    }
    return {
      success: () => {
        this.lastSuccess.set({ task: job }, this.now() / 1000);
        this.runs.inc({ task: job, result: 'ok' });
      },
      failure: () => {
        this.runs.inc({ task: job, result: 'error' });
      },
    };
  }
}
