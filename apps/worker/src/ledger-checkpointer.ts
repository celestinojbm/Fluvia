import type { Pool } from '@fluvia/db';
import type { WatchdogLogger } from './attempts-watchdog.js';

/**
 * Sellador del hash-chain del ledger (F6, threat model §5 — fila Ledger). La
 * política ENTERA vive en `seal_ledger_checkpoints()` (0042): sellado LAZY en
 * dos fases con horizonte de txid (candidato → finalización cuando toda tx en
 * vuelo terminó) — cero contención en el camino caliente de posting y cero
 * falsos positivos por commits fuera de orden. Este job solo invoca la función
 * en un intervalo y expone los gauges. La VERIFICACIÓN de la cadena no vive
 * aquí: corre como check [7] de `verify-ledger-invariants.sql` (CI por commit,
 * restore drill, y a demanda del operador).
 */

export interface LedgerChainHealth {
  checkpointsTotal: number;
  sealedUptoSeq: number;
  sealedThisRun: number;
  candidateUptoSeq: number;
  /** Rezago de detección: seq máximos aún sin cubrir por la cadena. NO decrece =
   *  sellador atascado/caído (su fallo es silencioso) → alerta de estancamiento. */
  unsealedSeq: number;
}

export interface LedgerCheckpointerOptions {
  /** F1-07: observador de métricas por corrida. Sus errores JAMAS afectan al job. */
  onResult?: (health: LedgerChainHealth) => void;
  /**
   * Edad mínima del candidato antes de finalizarlo (cinturón sobre el
   * horizonte de txid — cubre la ventana microscópica nextval→txid de un
   * INSERT en curso). Default 60 s; los tests lo bajan a 0 (un solo escritor).
   */
  minCandidateAgeMs?: number;
}

export class LedgerCheckpointer {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private readonly minCandidateAgeMs: number;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre seal_ledger_checkpoints). */
    private readonly workerPool: Pool,
    private readonly logger?: WatchdogLogger,
    private readonly options: LedgerCheckpointerOptions = {}
  ) {
    this.minCandidateAgeMs = options.minCandidateAgeMs ?? 60_000;
  }

  async runOnce(): Promise<LedgerChainHealth> {
    const res = await this.workerPool.query<{ metric: string; value: string }>(
      'SELECT metric, value::text FROM seal_ledger_checkpoints(make_interval(secs => $1))',
      [this.minCandidateAgeMs / 1000]
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    const health: LedgerChainHealth = {
      checkpointsTotal: byMetric.checkpoints_total ?? 0,
      sealedUptoSeq: byMetric.sealed_upto_seq ?? 0,
      sealedThisRun: byMetric.sealed_this_run ?? 0,
      candidateUptoSeq: byMetric.candidate_upto_seq ?? 0,
      unsealedSeq: byMetric.unsealed_seq ?? 0,
    };
    try {
      this.options.onResult?.(health);
    } catch (err) {
      this.logger?.error(
        { err: String(err) },
        'ledger checkpointer metrics observer failed (ignored)'
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
          this.logger?.error({ err: String(err) }, 'ledger checkpointer run failed');
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
