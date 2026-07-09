import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../src/testing.js';

/**
 * F6 (drill de caos): un fallo de conexión (kill administrativo, failover de
 * Postgres, partición de red, reinicio de la BD) NO debe tumbar el proceso.
 * node-pg emite un evento `error` en el pool y/o en el cliente; SIN un listener,
 * Node lo trata como excepción no capturada y mata el proceso — un blip transitorio
 * derribaría toda la API/worker. `createPool` ata los handlers (pool `error` para
 * conexiones ociosas + client `error` en `connect` para conexiones tomadas cuya
 * query muere en vuelo). Sin ese fix, ESTE test crashea el proceso al matar la
 * conexión en vuelo (el drill de caos lo encontró).
 */
describe('F6: resiliencia del pool a caída de conexión', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('a killed in-flight connection rejects its query, does NOT crash the process, and the pool recovers', async () => {
    const client = await ctx.app.connect();
    try {
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      // Query lenta EN VUELO cuyo backend se mata desde admin: debe RECHAZAR (no
      // colgar ni crashear). El `.then(ok, err)` la maneja para que el rechazo no
      // quede sin capturar.
      const inflight = client.query('SELECT pg_sleep(3)').then(
        () => 'resolved' as const,
        (e: Error) => e
      );
      await ctx.admin.query('SELECT pg_terminate_backend($1)', [pid]);
      const outcome = await inflight;
      expect(outcome).toBeInstanceOf(Error);
    } finally {
      client.release();
    }

    // Si el proceso hubiera crasheado por el 'error' no manejado del cliente, el
    // test nunca llegaría aquí — ESA es la invariante central (el fix la garantiza).
    // Recuperación: el pool DESCARTA la conexión muerta y sirve una fresca. node-pg
    // puede entregar la conexión recién muerta UNA vez antes de evacuarla en su
    // evento `error` (misma vuelta del event loop), así que un caller resiliente
    // reintenta — es el comportamiento honesto, no un bug: en producción las
    // requests están espaciadas y la conexión muerta ya fue evacuada.
    let recovered = false;
    for (let i = 0; i < 5 && !recovered; i += 1) {
      try {
        const res = await ctx.app.query<{ ok: number }>('SELECT 1 AS ok');
        recovered = res.rows[0]!.ok === 1;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(recovered).toBe(true);
  }, 30_000);
});
