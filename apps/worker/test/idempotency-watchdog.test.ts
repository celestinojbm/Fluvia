import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { IdempotencyWatchdog } from '../src/idempotency-watchdog.js';

/**
 * F6 (threat model §5) — sweep_idempotency_orphans() (0041) contra PG real:
 * SURFACEA los claims `in_progress` COMMITEADOS (huérfanos de un flujo
 * multi-paso o un bug) SIN transicionar nada. Las filas se preparan por el
 * admin (superusuario); la función corre con el rol fluvia_worker (sin
 * privilegios de tabla — no puede SELECT `idempotency_keys` bajo RLS; el
 * definer cuenta cross-tenant por él). Conteos globales con `>=`.
 */

let workerPool: Pool;
let adminPool: Pool;
let org: string;

/** Inserta un idempotency key COMMITEADO en el status dado (la app nunca deja
 *  un `in_progress` comiteado; aquí lo fabricamos para probar el barrido). */
async function insertKey(status: 'in_progress' | 'completed'): Promise<string> {
  const key = `wd-${randomUUID()}`;
  await adminPool.query(
    `INSERT INTO idempotency_keys (tenant_id, endpoint, key, request_hash, status)
     VALUES ($1, 'POST /v1/x', $2, 'h', $3)`,
    [org, key, status]
  );
  return key;
}

async function age(key: string, hours: number): Promise<void> {
  await adminPool.query(
    `UPDATE idempotency_keys SET created_at = now() - make_interval(hours => $2)
     WHERE tenant_id = $1 AND key = $3`,
    [org, hours, key]
  );
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  org = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Idem WD ${randomUUID().slice(0, 8)}`, `iwd-${randomUUID()}`]
    )
  ).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await Promise.all([workerPool.end(), adminPool.end()]);
});

describe('IdempotencyWatchdog — salud de huérfanos in_progress (F6)', () => {
  it('counts in_progress keys and flags the aged ones; completed keys never count', async () => {
    const watchdog = new IdempotencyWatchdog(workerPool);

    const baseline = await watchdog.runOnce();

    // Un `in_progress` fresco: cuenta en total, NO en envejecidos.
    const fresh = await insertKey('in_progress');
    // Un `in_progress` envejecido (>1 h): cuenta en total Y en envejecidos.
    const old = await insertKey('in_progress');
    await age(old, 2);
    // Un `completed`, aunque sea viejo, JAMÁS cuenta.
    const done = await insertKey('completed');
    await age(done, 5);

    const health = await watchdog.runOnce();
    expect(health.inProgressTotal).toBe(baseline.inProgressTotal + 2); // fresh + old
    expect(health.inProgressAged).toBe(baseline.inProgressAged + 1); // solo el envejecido

    // Al completar el fresco, sale del conteo de vivos.
    await adminPool.query(
      `UPDATE idempotency_keys SET status = 'completed' WHERE tenant_id = $1 AND key = $2`,
      [org, fresh]
    );
    const after = await watchdog.runOnce();
    expect(after.inProgressTotal).toBe(baseline.inProgressTotal + 1); // solo `old`
    expect(after.inProgressAged).toBe(baseline.inProgressAged + 1);
  });

  it('an aged orphan raises a baseline alert (logger.error)', async () => {
    const errors: string[] = [];
    const watchdog = new IdempotencyWatchdog(workerPool, {
      info: () => undefined,
      error: (_obj, msg) => errors.push(msg),
    });
    const old = await insertKey('in_progress');
    await age(old, 2);

    const health = await watchdog.runOnce();
    expect(health.inProgressAged).toBeGreaterThanOrEqual(1);
    expect(errors.some((m) => /AGED in_progress/i.test(m))).toBe(true);
  });
});
