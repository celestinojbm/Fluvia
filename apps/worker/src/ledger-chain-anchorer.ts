import type { Pool } from '@fluvia/db';
import type { WatchdogLogger } from './attempts-watchdog.js';

/**
 * Anclaje EXTERNO del hash-chain del ledger (F6, threat model §5 — fila Ledger).
 * El sellador (LedgerCheckpointer/0042) hace DETECTABLE editar/borrar asientos ya
 * sellados, pero [7] solo recorre los checkpoints que EXISTEN: borrar la cadena
 * ENTERA o truncar su sufijo lo deja verde trivial. Este job PUBLICA el tip de la
 * cadena (`upto_seq`, `chain_hash`) a un almacén append-only SEPARADO — la política
 * ENTERA vive en `anchor_ledger_chain()` (0043, tabla `ledger_chain_anchors` + un
 * evento de auditoría `ledger.chain_anchored`). La VERIFICACIÓN no vive aquí: corre
 * como check [8] de `verify-ledger-invariants.sql` (CI por commit + restore drill),
 * que compara los anchors contra la cadena viva.
 *
 * Pata offsite (V4 Nivel A — no hay infra externa en el sandbox): cuando registra
 * un anchor NUEVO, el job LOGUEA el tip (`upto_seq`/`chain_hash`) — el artefacto
 * que el operador archiva fuera del cluster (junto con el evento de auditoría, que
 * viaja por el canal de exportación de auditoría existente). Sin una copia offsite,
 * un superusuario que borre la cadena Y los anchors sigue indetectable; el valor
 * aquí es cerrar el hueco común y elevar el costo a dos almacenes append-only.
 */

export interface LedgerAnchorHealth {
  anchorsTotal: number;
  anchoredUptoSeq: number;
  anchoredThisRun: number;
}

export interface LedgerChainAnchorerOptions {
  /** F1-07: observador de métricas por corrida. Sus errores JAMÁS afectan al job. */
  onResult?: (health: LedgerAnchorHealth) => void;
}

export class LedgerChainAnchorer {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    /** Pool con rol fluvia_worker (EXECUTE sobre anchor_ledger_chain). */
    private readonly workerPool: Pool,
    private readonly logger?: WatchdogLogger,
    private readonly options: LedgerChainAnchorerOptions = {}
  ) {}

  async runOnce(): Promise<LedgerAnchorHealth> {
    const res = await this.workerPool.query<{ metric: string; value: string }>(
      'SELECT metric, value::text FROM anchor_ledger_chain()'
    );
    const byMetric = Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
    const health: LedgerAnchorHealth = {
      anchorsTotal: byMetric.anchors_total ?? 0,
      anchoredUptoSeq: byMetric.anchored_upto_seq ?? 0,
      anchoredThisRun: byMetric.anchored_this_run ?? 0,
    };
    // Artefacto exportable offsite: solo al registrar un anchor NUEVO (sin ruido
    // en los no-op). El operador archiva esta línea fuera del cluster.
    if (health.anchoredThisRun > 0) {
      this.logger?.info(
        { anchoredUptoSeq: health.anchoredUptoSeq, anchorsTotal: health.anchorsTotal },
        'ledger hash-chain tip anchored (external tamper-evidence record)'
      );
    }
    try {
      this.options.onResult?.(health);
    } catch (err) {
      this.logger?.error(
        { err: String(err) },
        'ledger chain anchorer metrics observer failed (ignored)'
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
          this.logger?.error({ err: String(err) }, 'ledger chain anchorer run failed');
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
