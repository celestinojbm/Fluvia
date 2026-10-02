import type { Pool } from '@fluvia/db';
import type { BlobStorage } from '@fluvia/assistant';

/**
 * Retención del asistente: invoca purge_assistant_data(días) (0055, SECURITY
 * DEFINER, EXECUTE solo fluvia_worker), que borra conversaciones y adjuntos
 * vencidos y devuelve las claves de almacenamiento; el job elimina esos
 * ficheros del almacenamiento privado. Nunca registra contenidos ni claves:
 * solo cuántos elementos se purgaron.
 */
export class AssistantRetentionJob {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly workerPool: Pool,
    private readonly storage: BlobStorage,
    private readonly retentionDays: number,
    private readonly logger?: {
      info(o: Record<string, unknown>, m: string): void;
      error(o: Record<string, unknown>, m: string): void;
    }
  ) {}

  async runOnce(): Promise<number> {
    const r = await this.workerPool.query<{ storage_key: string }>(
      'SELECT storage_key FROM purge_assistant_data($1)',
      [this.retentionDays]
    );
    let removed = 0;
    for (const row of r.rows) {
      try {
        await this.storage.remove(row.storage_key);
        removed++;
      } catch {
        /* el fichero ya no existía: la fila ya se borró */
      }
    }
    if (r.rows.length)
      this.logger?.info({ purged: r.rows.length, removed }, 'assistant data purged');
    return r.rows.length;
  }

  start(intervalMs = 3_600_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) =>
          this.logger?.error({ err: String(err) }, 'assistant retention run failed')
        )
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
