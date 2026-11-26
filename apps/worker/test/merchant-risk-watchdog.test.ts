import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { MerchantRiskWatchdog } from '../src/merchant-risk-watchdog.js';

/**
 * #92/#108 — sweep_merchant_risk() (0070) contra PG real: SURFACEA la cola de
 * comercios pending_review y los activos que coinciden con la denylist, SIN
 * congelar a nadie. Las filas se preparan con el admin (superusuario); la
 * función corre con el rol fluvia_worker (sin lectura cross-tenant de
 * `merchants` ni acceso a la lista). Conteos globales: se comparan deltas.
 */

let workerPool: Pool;
let appPool: Pool;
let relayPool: Pool;
let adminPool: Pool;
let org: string;
const retire: string[] = [];

interface LogLine {
  level: 'info' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function captureLogger(lines: LogLine[]) {
  return {
    info: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'info', obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'error', obj, msg }),
  };
}

async function sweep(): Promise<Record<string, number>> {
  const res = await workerPool.query<{ metric: string; value: string }>(
    'SELECT metric, value::text FROM sweep_merchant_risk()'
  );
  return Object.fromEntries(res.rows.map((r) => [r.metric, Number(r.value)]));
}

/** Comercio legado: sin `state_affiliation` (como quedaron los anteriores a 0069). */
async function insertLegacy(name = `mrw-legacy-${randomUUID().slice(0, 8)}`): Promise<string> {
  const res = await adminPool.query<{ id: string }>(
    `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [org, name]
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  appPool = createPool({ connectionString: config.db.app, max: 2 });
  relayPool = createPool({ connectionString: config.db.relay, max: 2 });
  adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  org = (
    await adminPool.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Merchant Risk WD ${randomUUID().slice(0, 8)}`, `mrw-${randomUUID()}`]
    )
  ).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  // La denylist es append-only: los patrones de prueba se retiran, no se borran.
  for (const id of retire) {
    await adminPool.query(
      `UPDATE merchant_name_denylist
       SET retired_at = now(), retired_by = $2, retire_reason = 'test cleanup'
       WHERE id = $1 AND retired_at IS NULL`,
      [id, randomUUID()]
    );
  }
  await Promise.all([workerPool.end(), appPool.end(), relayPool.end(), adminPool.end()]);
});

describe('sweep_merchant_risk() — conteos sin congelar (0070)', () => {
  it('cuenta legados sin declaración; un declarado no cuenta; congelado solo en el total', async () => {
    const before = await sweep();
    const active = await insertLegacy();
    const frozen = await insertLegacy();
    await adminPool.query(`UPDATE merchants SET status = 'frozen' WHERE id = $1`, [frozen]);
    await adminPool.query(
      `INSERT INTO merchants (tenant_id, name, state_affiliation) VALUES ($1, $2, 'none')`,
      [org, `mrw-declared-${randomUUID().slice(0, 8)}`]
    );
    const deleted = await insertLegacy();
    await adminPool.query(`UPDATE merchants SET deleted_at = now() WHERE id = $1`, [deleted]);

    const after = await sweep();
    expect(after.pending_review_active! - before.pending_review_active!).toBeGreaterThanOrEqual(1);
    expect(after.pending_review_total! - before.pending_review_total!).toBeGreaterThanOrEqual(2);

    // Solo surfacea: el legado activo sigue activo y pending_review.
    const row = await adminPool.query<{ status: string; affiliation_declaration_status: string }>(
      `SELECT status, affiliation_declaration_status FROM merchants WHERE id = $1`,
      [active]
    );
    expect(row.rows[0]).toEqual({
      status: 'active',
      affiliation_declaration_status: 'pending_review',
    });
  });

  it('detecta un comercio activo que entra en la denylist DESPUÉS de su alta', async () => {
    // El guard de 0069 no re-evalúa a los ya activos: este es el punto ciego.
    const token = `mrw${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const id = await insertLegacy(`${token} Trading`);
    const before = await sweep();

    const entry = await adminPool.query<{ id: string }>(
      `INSERT INTO merchant_name_denylist (pattern, reason) VALUES ($1, 'watchdog test') RETURNING id`,
      [token]
    );
    retire.push(entry.rows[0]!.id);

    const after = await sweep();
    expect(after.denylisted_active! - before.denylisted_active!).toBeGreaterThanOrEqual(1);
    const st = await adminPool.query<{ status: string }>(
      `SELECT status FROM merchants WHERE id = $1`,
      [id]
    );
    expect(st.rows[0]!.status).toBe('active');

    // Congelado deja de contar como activo en la denylist.
    await adminPool.query(`UPDATE merchants SET status = 'frozen' WHERE id = $1`, [id]);
    const frozen = await sweep();
    expect(frozen.denylisted_active).toBe(after.denylisted_active! - 1);
  });

  it('devuelve solo números (ni nombres ni patrones)', async () => {
    const res = await workerPool.query<{ metric: string }>('SELECT * FROM sweep_merchant_risk()');
    expect(res.rows.map((r) => r.metric).sort()).toEqual([
      'denylisted_active',
      'pending_review_active',
      'pending_review_total',
    ]);
    expect(res.fields.map((f) => f.name)).toEqual(['metric', 'value']);
  });

  it('falla CERRADO si su dueño está sometido a RLS (no devuelve un 0 falso)', async () => {
    // Cloud sin BYPASSRLS: FORCE RLS sobre `merchants` y sin app.tenant_id, los
    // conteos saldrían 0 = "sano". Todo dentro de una tx que se revierte: el
    // cambio de dueño no lo ve ningún otro test.
    const role = `mrw_blind_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT SELECT ON merchants, merchant_name_denylist TO ${role}`);
      await client.query(
        `GRANT EXECUTE ON FUNCTION fluvia_merchant_name_denylisted(TEXT) TO ${role}`
      );
      await client.query(`ALTER FUNCTION sweep_merchant_risk() OWNER TO ${role}`);
      await client.query('SET LOCAL ROLE fluvia_worker');
      await expect(client.query('SELECT * FROM sweep_merchant_risk()')).rejects.toThrow(
        /FLUVIA_MERCHANT_RISK_SWEEP_BLIND/
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('solo el rol worker puede ejecutarla', async () => {
    await expect(appPool.query('SELECT * FROM sweep_merchant_risk()')).rejects.toThrow(
      /permission denied/i
    );
    await expect(relayPool.query('SELECT * FROM sweep_merchant_risk()')).rejects.toThrow(
      /permission denied/i
    );
  });
});

describe('MerchantRiskWatchdog', () => {
  it('runOnce devuelve conteos enteros no negativos', async () => {
    const health = await new MerchantRiskWatchdog(workerPool).runOnce();
    for (const v of Object.values(health)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(health.pendingReviewTotal).toBeGreaterThanOrEqual(health.pendingReviewActive);
  });

  it('la cola pending_review se loguea como info y solo cuando cambia', async () => {
    await insertLegacy();
    const lines: LogLine[] = [];
    const wd = new MerchantRiskWatchdog(workerPool, captureLogger(lines));
    await wd.runOnce();
    const pending = lines.filter((l) => /pending state-affiliation review/.test(l.msg));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.level).toBe('info');

    await wd.runOnce(); // sin cambios: no repite el aviso cada corrida
    expect(lines.filter((l) => /pending state-affiliation review/.test(l.msg))).toHaveLength(1);
  });

  it('un comercio NUEVO sin declaración se reporta como error (regresión de la API)', async () => {
    const lines: LogLine[] = [];
    const wd = new MerchantRiskWatchdog(workerPool, captureLogger(lines));
    await wd.runOnce(); // línea base: la primera corrida nunca es "subida"
    expect(lines.some((l) => /NEW merchant without/.test(l.msg))).toBe(false);

    await insertLegacy();
    await wd.runOnce();
    const regression = lines.find((l) => /NEW merchant without/.test(l.msg));
    expect(regression?.level).toBe('error');
  });

  it('unfreeze de un legado sin declarar NO se reporta como alta nueva; un alta nueva sí, aunque congelen otro', async () => {
    // Pool simulado: el conteo global de la BD compartida lo mueven otros
    // archivos de test en paralelo; aquí se fija la secuencia exacta.
    const seq: Array<[active: number, total: number]> = [
      [3, 5], // línea base
      [4, 5], // `merchant-risk unfreeze` de un legado: sube activos, total igual
      [4, 6], // alta nueva sin declaración + congelación de otro en la misma corrida
    ];
    let i = 0;
    const fakePool = {
      query: async () => {
        const [active, total] = seq[i++]!;
        return {
          rows: [
            { metric: 'pending_review_active', value: String(active) },
            { metric: 'pending_review_total', value: String(total) },
            { metric: 'denylisted_active', value: '0' },
          ],
        };
      },
    } as unknown as Pool;
    const lines: LogLine[] = [];
    const wd = new MerchantRiskWatchdog(fakePool, captureLogger(lines));

    await wd.runOnce();
    await wd.runOnce();
    expect(lines.some((l) => /NEW merchant without/.test(l.msg))).toBe(false);
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(0);

    await wd.runOnce();
    const regression = lines.filter((l) => /NEW merchant without/.test(l.msg));
    expect(regression).toHaveLength(1);
    expect(regression[0]!.level).toBe('error');
    expect(regression[0]!.obj).toMatchObject({ pendingReviewTotal: 6, previous: 5 });
  });

  it('el observador de métricas que explota no rompe el job', async () => {
    const wd = new MerchantRiskWatchdog(
      workerPool,
      { info: () => undefined, error: () => undefined },
      {
        onResult: () => {
          throw new Error('observer exploded');
        },
      }
    );
    await expect(wd.runOnce()).resolves.toBeDefined();
  });
});
