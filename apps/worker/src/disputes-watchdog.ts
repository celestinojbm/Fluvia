import type { Pool } from '@fluvia/db';
import type { WatchdogLogger } from './attempts-watchdog.js';

/**
 * Watchdog del plano de disputas (F4-10). Espeja el de payouts (F4-07c) pero SIN
 * barrido: la política ENTERA vive en `sweep_disputes()` (0038), que solo
 * SURFACEA la salud — una disputa `open`/`under_review` retiene fondos en
 * `dispute.reserve` y su desenlace llega SOLO de fuente verificada (el banco vía
 * webhook), jamás por timeout ni asunción (V4 §23), así que NADA se transiciona
 * aquí. Este job invoca la función en un intervalo, expone los gauges y ALERTA
 * ante disputas envejecidas (dinero apartado a riesgo de perderse si no se
 * responde antes del plazo del banco).
 */

export interface DisputesHealth {
  heldTotal: number;
  heldAged: number;
}

export interface DisputesWatchdogOptions {
  /** F1-07: observador de métricas por corrida. Sus errores JAMAS afectan al job. */
  onResult?: (health: DisputesHealth) => void;
}

export class DisputesWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre sweep_disputes). */
    private readonly workerPool: Pool,
    private readonly logger?: WatchdogLogger,
    private readonly options: DisputesWatchdogOptions = {}
  ) {}

  async runOnce(): Promise<DisputesHealth> {
    const res = await this.workerPool.query<{ metric: string; value: string }>(
      'SELECT metric, value::text FROM sweep_disputes()'
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    const health: DisputesHealth = {
      heldTotal: byMetric.held_total ?? 0,
      heldAged: byMetric.held_aged ?? 0,
    };
    if (health.heldAged > 0) {
      // Alerta baseline: una disputa viva más allá del plazo exige intervención
      // — asegurar el envío de evidencia / perseguir la resolución del banco
      // antes de que se pierda por defecto (los fondos siguen apartados).
      this.logger?.error(
        { aged: health.heldAged, held: health.heldTotal },
        'AGED DISPUTES holding merchant funds past the response window — ensure evidence submitted / chase bank resolution'
      );
    }
    try {
      this.options.onResult?.(health);
    } catch (err) {
      this.logger?.error(
        { err: String(err) },
        'disputes watchdog metrics observer failed (ignored)'
      );
    }
    return health;
  }

  start(intervalMs = 60_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'disputes watchdog run failed');
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
}
