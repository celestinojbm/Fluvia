import type { Pool } from '@fluvia/db';

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface WorkerProcessOptions {
  /** Pool con rol fluvia_worker (BYPASSRLS, solo colas). */
  pool: Pool;
  logger: WorkerLogger;
  heartbeatIntervalMs?: number;
}

/**
 * Esqueleto del proceso worker (F1-01).
 *
 * Por ahora solo: verificacion de conectividad, heartbeat observable y
 * apagado limpio. Los consumidores reales (outbox relay F2-11, inbox F2-12,
 * webhook delivery F3-07) se registraran aqui como tareas.
 */
export class WorkerProcess {
  private timer: NodeJS.Timeout | undefined;
  private beats = 0;
  private stopped = false;

  constructor(private readonly opts: WorkerProcessOptions) {}

  get heartbeats(): number {
    return this.beats;
  }

  /** Falla rapido si la base de datos no responde: el worker no debe arrancar ciego. */
  async checkReady(): Promise<void> {
    await this.opts.pool.query('SELECT 1');
  }

  start(): void {
    if (this.timer) return;
    const interval = this.opts.heartbeatIntervalMs ?? 30_000;
    this.timer = setInterval(() => {
      this.beats += 1;
      this.opts.logger.info({ heartbeat: this.beats }, 'worker heartbeat');
    }, interval);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.opts.logger.info({ heartbeats: this.beats }, 'worker stopped cleanly');
  }
}
