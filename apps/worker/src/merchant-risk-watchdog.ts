import type { Pool } from '@fluvia/db';
import type { WatchdogLogger } from './attempts-watchdog.js';

/**
 * Watchdog de riesgo de comercios (seguimiento de #92 / #108). La política vive
 * en `sweep_merchant_risk()` (0070), que solo SURFACEA conteos: NADA se congela
 * aquí. Congelar es decisión del operador por el CLI auditado
 * (`merchant-risk freeze`, runbook `docs/ops/runbooks/merchant-risk.md`).
 *
 * - `pendingReviewActive`: legados sin declaración de afiliación que siguen
 *   cobrando. Es una COLA de trabajo de Legal, no una emergencia: se loguea solo
 *   cuando cambia (no cada minuto) y la alerta es de backlog.
 * - `pendingReviewTotal`: ídem incluidos los congelados. Si SUBE, algo creó un
 *   comercio saltándose la API (que exige la declaración): eso sí es una
 *   regresión y se loguea como error. Se mira el TOTAL y no los activos porque
 *   `merchant-risk unfreeze` de un legado sin declarar (permitido por el guard
 *   de 0069) sube los activos sin que haya ningún alta nueva; y congelar un
 *   legado en la misma corrida en que entra uno nuevo dejaría los activos igual.
 * - `denylistedActive`: comercio activo cuyo nombre coincide con la lista. El
 *   guard de 0069 no re-evalúa a los ya activos, así que esto es lo único que
 *   lo avisa. Error en cada corrida mientras sea > 0.
 */

export interface MerchantRiskHealth {
  pendingReviewActive: number;
  pendingReviewTotal: number;
  denylistedActive: number;
}

export interface MerchantRiskWatchdogOptions {
  /** Observador de métricas por corrida. Sus errores JAMÁS afectan al job. */
  onResult?: (health: MerchantRiskHealth) => void;
}

export class MerchantRiskWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private lastPendingActive: number | undefined;
  private lastPendingTotal: number | undefined;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre sweep_merchant_risk). */
    private readonly workerPool: Pool,
    private readonly logger?: WatchdogLogger,
    private readonly options: MerchantRiskWatchdogOptions = {}
  ) {}

  async runOnce(): Promise<MerchantRiskHealth> {
    const res = await this.workerPool.query<{ metric: string; value: string }>(
      'SELECT metric, value::text FROM sweep_merchant_risk()'
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    const health: MerchantRiskHealth = {
      pendingReviewActive: byMetric.pending_review_active ?? 0,
      pendingReviewTotal: byMetric.pending_review_total ?? 0,
      denylistedActive: byMetric.denylisted_active ?? 0,
    };

    if (health.denylistedActive > 0) {
      this.logger?.error(
        { denylistedActive: health.denylistedActive },
        'ACTIVE MERCHANTS MATCH THE STATE DENYLIST — run `merchant-risk screen` and escalate to Legal (runbook merchant-risk.md)'
      );
    }

    const previousActive = this.lastPendingActive;
    const previousTotal = this.lastPendingTotal;
    this.lastPendingActive = health.pendingReviewActive;
    this.lastPendingTotal = health.pendingReviewTotal;
    if (previousTotal !== undefined && health.pendingReviewTotal > previousTotal) {
      this.logger?.error(
        {
          pendingReviewTotal: health.pendingReviewTotal,
          previous: previousTotal,
          pendingReviewActive: health.pendingReviewActive,
        },
        'NEW merchant without state-affiliation declaration — the API requires it; something created a merchant bypassing it'
      );
    } else if (previousActive !== health.pendingReviewActive && health.pendingReviewActive > 0) {
      this.logger?.info(
        {
          pendingReviewActive: health.pendingReviewActive,
          pendingReviewTotal: health.pendingReviewTotal,
        },
        'merchants pending state-affiliation review (Legal queue: `merchant-risk screen --include-undeclared`)'
      );
    }

    try {
      this.options.onResult?.(health);
    } catch (err) {
      this.logger?.error(
        { err: String(err) },
        'merchant risk watchdog metrics observer failed (ignored)'
      );
    }
    return health;
  }

  start(intervalMs = 300_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) => {
          this.logger?.error({ err: String(err) }, 'merchant risk watchdog run failed');
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
