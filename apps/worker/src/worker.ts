import type { Pool } from '@fluvia/db';

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface WorkerProcessOptions {
  /** Pool con rol fluvia_worker (cascaron de proceso: sin privilegios de tabla, ADR-0011). */
  pool: Pool;
  logger: WorkerLogger;
  heartbeatIntervalMs?: number;
}

/**
 * Proceso worker: readiness, heartbeat y apagado limpio (F1-01).
 * Las tareas corren con roles dedicados de privilegio minimo; la primera es
 * el outbox relay (F2-11, rol fluvia_relay — ver main.ts). El InboxProcessor
 * (F2-12, @fluvia/inbox) se cablea aqui cuando exista el primer handler de
 * provider (F3-03); arrancarlo sin registro solo haria polling vacio.
 * Despues: webhook delivery F3-07.
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
