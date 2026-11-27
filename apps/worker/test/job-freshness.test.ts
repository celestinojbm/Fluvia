import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from '@fluvia/db';
import { MetricsRegistry } from '@fluvia/observability';
import { JobFreshnessMetrics } from '../src/job-freshness.js';
import { MerchantRiskWatchdog } from '../src/merchant-risk-watchdog.js';

/**
 * Follow-up de #110 — alerta cuando el watchdog de riesgo deja de correr.
 * Sin PG: los modos de fallo (BD que rechaza, corrida colgada) se fijan con un
 * pool simulado y el reloj es inyectado. `staleJobs` evalúa la MISMA expresión
 * de `observability.md` §4 sobre la exposición Prometheus real del registro:
 *
 *   time() - fluvia_worker_job_last_success_timestamp_seconds
 *     > 3 * fluvia_worker_job_interval_seconds
 */

const INTERVAL_MS = 300_000;

function sample(text: string, metric: string, labels: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${metric}{${labels}} `));
  return line === undefined ? undefined : Number(line.split(' ').pop());
}

function staleJobs(registry: MetricsRegistry, nowMs: number, job = 'merchant_risk'): boolean {
  const text = registry.render();
  const last = sample(text, 'fluvia_worker_job_last_success_timestamp_seconds', `job="${job}"`);
  const interval = sample(text, 'fluvia_worker_job_interval_seconds', `job="${job}"`);
  if (last === undefined || interval === undefined) {
    throw new Error('freshness series absent — the alert could never fire');
  }
  return nowMs / 1000 - last > 3 * interval;
}

const okRows = {
  rows: [
    { metric: 'pending_review_active', value: '0' },
    { metric: 'pending_review_total', value: '0' },
    { metric: 'denylisted_active', value: '0' },
  ],
};

const quietLogger = { info: () => undefined, error: () => undefined };

function wire(pool: Pool, clock: { now: number }) {
  const registry = new MetricsRegistry();
  const freshness = new JobFreshnessMetrics(registry, () => clock.now);
  const tracker = freshness.track('merchant_risk', { enabled: true, intervalMs: INTERVAL_MS });
  const errors: string[] = [];
  const wd = new MerchantRiskWatchdog(
    pool,
    { info: () => undefined, error: (_o, msg) => errors.push(msg) },
    {
      onRun: (r) => (r === 'ok' ? tracker.success() : tracker.failure()),
    }
  );
  return { registry, wd, errors };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('JobFreshnessMetrics', () => {
  it('un job habilitado expone la serie desde el arranque (no ausente) con gracia de 3 intervalos', () => {
    const clock = { now: 1_000_000_000_000 };
    const registry = new MetricsRegistry();
    new JobFreshnessMetrics(registry, () => clock.now).track('merchant_risk', {
      enabled: true,
      intervalMs: INTERVAL_MS,
    });
    const text = registry.render();
    expect(text).toContain('fluvia_worker_job_enabled{job="merchant_risk"} 1');
    expect(text).toContain('fluvia_worker_job_interval_seconds{job="merchant_risk"} 300');
    expect(text).toContain('fluvia_worker_job_runs_total{job="merchant_risk",result="error"} 0');

    clock.now += 3 * INTERVAL_MS;
    expect(staleJobs(registry, clock.now)).toBe(false);
    clock.now += 1000;
    expect(staleJobs(registry, clock.now)).toBe(true); // nunca corrió bien: alerta
  });

  it('un job apagado por config es visible como enabled=0 y no publica frescura', () => {
    const registry = new MetricsRegistry();
    new JobFreshnessMetrics(registry).track('merchant_risk', {
      enabled: false,
      intervalMs: INTERVAL_MS,
    });
    const text = registry.render();
    expect(text).toContain('fluvia_worker_job_enabled{job="merchant_risk"} 0');
    expect(text).not.toContain('fluvia_worker_job_last_success_timestamp_seconds{');
  });

  it('rechaza registrar el mismo job dos veces', () => {
    const f = new JobFreshnessMetrics(new MetricsRegistry());
    f.track('merchant_risk', { enabled: true, intervalMs: INTERVAL_MS });
    expect(() => f.track('merchant_risk', { enabled: true, intervalMs: INTERVAL_MS })).toThrow(
      /already tracked/
    );
  });

  it('las métricas no llevan identificadores: solo el nombre fijo del job', () => {
    const registry = new MetricsRegistry();
    const t = new JobFreshnessMetrics(registry).track('merchant_risk', {
      enabled: true,
      intervalMs: INTERVAL_MS,
    });
    t.success();
    t.failure();
    const jobLines = registry
      .render()
      .split('\n')
      .filter((l) => l.startsWith('fluvia_worker_job_'));
    expect(jobLines.length).toBeGreaterThan(0);
    for (const l of jobLines) {
      expect(l).toMatch(/^fluvia_worker_job_\w+\{job="merchant_risk"(,result="(ok|error)")?\} /);
    }
  });
});

describe('MerchantRiskWatchdog — frescura (follow-up #110)', () => {
  it('corridas correctas mantienen la frescura; dejar de correr la vence', async () => {
    const clock = { now: 1_000_000_000_000 };
    const { registry, wd } = wire({ query: async () => okRows } as unknown as Pool, clock);

    for (let i = 0; i < 5; i++) {
      clock.now += INTERVAL_MS;
      await wd.tick();
      expect(staleJobs(registry, clock.now)).toBe(false);
    }
    expect(registry.render()).toContain(
      'fluvia_worker_job_runs_total{job="merchant_risk",result="ok"} 5'
    );

    // El job deja de correr (timer muerto): nadie llama a tick().
    clock.now += 3 * INTERVAL_MS + 1000;
    expect(staleJobs(registry, clock.now)).toBe(true);
  });

  it('falla cerrado (SWEEP_BLIND) en cada corrida: cuenta errores y la frescura vence', async () => {
    const clock = { now: 1_000_000_000_000 };
    let fail = false;
    const pool = {
      query: async () => {
        if (fail) {
          throw new Error(
            'FLUVIA_MERCHANT_RISK_SWEEP_BLIND: owner of sweep_merchant_risk() is subject to RLS'
          );
        }
        return okRows;
      },
    } as unknown as Pool;
    const { registry, wd, errors } = wire(pool, clock);

    await wd.tick(); // una corrida buena
    fail = true;
    for (let i = 0; i < 4; i++) {
      clock.now += INTERVAL_MS;
      await expect(wd.tick()).resolves.toBeUndefined(); // tick jamás lanza
    }
    expect(errors.filter((m) => m === 'merchant risk watchdog run failed')).toHaveLength(4);
    const text = registry.render();
    expect(text).toContain('fluvia_worker_job_runs_total{job="merchant_risk",result="error"} 4');
    expect(text).toContain('fluvia_worker_job_runs_total{job="merchant_risk",result="ok"} 1');
    expect(staleJobs(registry, clock.now)).toBe(true);

    // Se arregla el dueño de la función: la siguiente corrida buena la limpia.
    fail = false;
    await wd.tick();
    expect(staleJobs(registry, clock.now)).toBe(false);
  });

  it('una corrida COLGADA bloquea las siguientes sin loguear nada — la frescura la delata', async () => {
    vi.useFakeTimers();
    const clock = { now: 1_000_000_000_000 };
    let calls = 0;
    const pool = {
      query: () => {
        calls += 1;
        return new Promise(() => undefined); // la query nunca vuelve
      },
    } as unknown as Pool;
    const { registry, wd, errors } = wire(pool, clock);

    wd.start(INTERVAL_MS);
    for (let i = 0; i < 4; i++) {
      clock.now += INTERVAL_MS;
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    }
    wd.stop();

    expect(calls).toBe(1); // el guard `running` saltó las otras tres
    expect(errors).toHaveLength(0); // ni un log: punto ciego sin esta alerta
    expect(registry.render()).toContain(
      'fluvia_worker_job_runs_total{job="merchant_risk",result="error"} 0'
    );
    expect(staleJobs(registry, clock.now)).toBe(true);
  });

  it('el observador onRun que explota no rompe el job', async () => {
    const wd = new MerchantRiskWatchdog(
      { query: async () => okRows } as unknown as Pool,
      quietLogger,
      {
        onRun: () => {
          throw new Error('observer exploded');
        },
      }
    );
    await expect(wd.tick()).resolves.toBeUndefined();
  });

  it('el timer usa tick(): un fallo no escapa como rechazo no manejado', async () => {
    vi.useFakeTimers();
    const results: string[] = [];
    const wd = new MerchantRiskWatchdog(
      {
        query: async () => {
          throw new Error('db down');
        },
      } as unknown as Pool,
      quietLogger,
      { onRun: (r) => results.push(r) }
    );
    wd.start(1000);
    await vi.advanceTimersByTimeAsync(3000);
    wd.stop();
    expect(results).toEqual(['error', 'error', 'error']);
  });
});
