import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '@fluvia/db';
import {
  RESET_CONFIRMATION,
  ShowroomResetGuardError,
  ShowroomSeedGuardError,
  assertShowroomResetAllowed,
  assertShowroomSeedTargetAllowed,
  openVerifiedShowroomTarget,
  runShowroomReset,
  type ShowroomDbUrls,
  type ShowroomResetGuardCode,
  type ShowroomResetRequest,
  type ShowroomSeedGuardCode,
} from '../src/reset.js';
import { resetRequestFor, targetUrlsFor } from './showroom-helpers.js';

/**
 * F6.5C3 — guard de DIEZ condiciones del `demo:reset`, fail-closed y
 * PRE-CONEXION: cada violacion aborta con un error tipado SIN invocar jamas
 * el factory de conexiones (cero pools, cero DNS, cero queries, cero efecto).
 * El factory es inyectable precisamente para que esto sea comprobable de
 * forma OBJETIVA, no por fe.
 */

const VALID = () => resetRequestFor('fluvia_showroom_test_guard1');

function mutate(fn: (req: ShowroomResetRequest) => void): ShowroomResetRequest {
  const req = VALID();
  fn(req);
  return req;
}

/** Factory espia: si el guard fallara DESPUES de abrir algo, esto lo delata. */
function spyFactory() {
  return vi.fn((): Pool => {
    throw new Error('connection factory must NEVER be invoked when the guard rejects');
  });
}

async function expectBlocked(
  req: ShowroomResetRequest,
  codes: ShowroomResetGuardCode | ShowroomResetGuardCode[]
): Promise<void> {
  const allowed = Array.isArray(codes) ? codes : [codes];
  // 1) El guard puro lanza el codigo estable esperado…
  let guardErr: unknown;
  try {
    assertShowroomResetAllowed(req);
  } catch (err) {
    guardErr = err;
  }
  expect(guardErr).toBeInstanceOf(ShowroomResetGuardError);
  expect(allowed).toContain((guardErr as ShowroomResetGuardError).code);

  // 2) …y el comando completo aborta SIN crear conexion/pool alguno.
  const factory = spyFactory();
  await expect(runShowroomReset(req, { createPool: factory })).rejects.toBeInstanceOf(
    ShowroomResetGuardError
  );
  expect(factory).not.toHaveBeenCalled();
}

describe('guard [1]-[2]: entorno y confirmacion', () => {
  it.each(['production', 'staging', 'sandbox', 'development', ''])(
    'env "%s" aborta pre-conexion',
    async (env) => {
      await expectBlocked(
        mutate((r) => {
          r.env = env;
        }),
        'env_not_allowed'
      );
    }
  );

  it('confirmacion ausente aborta', async () => {
    await expectBlocked(
      mutate((r) => {
        r.confirm = undefined;
      }),
      'confirmation_mismatch'
    );
  });

  it('confirmacion incorrecta (incluye variaciones de case) aborta', async () => {
    for (const bad of ['reset_fluvia_showroom', 'RESET FLUVIA SHOWROOM', 'yes', 'RESET_FLUVIA']) {
      await expectBlocked(
        mutate((r) => {
          r.confirm = bad;
        }),
        'confirmation_mismatch'
      );
    }
  });
});

describe('guard [3]-[5]/[10]: identidad del target', () => {
  it.each(['fluvia', 'postgres', 'template0', 'template1'])(
    'target "%s" (base del sistema/principal) aborta SIEMPRE',
    async (db) => {
      await expectBlocked(
        mutate((r) => {
          for (const role of Object.keys(r.targetUrls) as Array<keyof typeof r.targetUrls>) {
            r.targetUrls[role] = r.targetUrls[role].replace(/\/[^/]+$/, `/${db}`);
          }
        }),
        ['target_name_invalid', 'target_denylisted']
      );
    }
  );

  it('UNA sola URL target apuntando a postgres aborta (condicion [10])', async () => {
    await expectBlocked(
      mutate((r) => {
        r.targetUrls.relay = r.targetUrls.relay.replace(/\/[^/]+$/, '/postgres');
      }),
      ['target_name_invalid', 'target_denylisted', 'target_dbnames_differ']
    );
  });

  it.each([
    'shopdb',
    'fluvia_showroom2',
    'fluvia_showroomx',
    'fluvia_showroom_test_', // id vacio
    'fluvia_showroom_test_ABC', // mayusculas fuera de la regex estricta
    'xfluvia_showroom',
    'fluvia_showroom_test_' + 'a'.repeat(64), // id demasiado largo
  ])('target "%s" (prefijo parecido pero invalido) aborta', async (db) => {
    await expectBlocked(
      mutate((r) => {
        for (const role of Object.keys(r.targetUrls) as Array<keyof typeof r.targetUrls>) {
          r.targetUrls[role] = r.targetUrls[role].replace(/\/[^/]+$/, `/${db}`);
        }
      }),
      'target_name_invalid'
    );
  });

  it('dbnames target inconsistentes entre roles abortan', async () => {
    await expectBlocked(
      mutate((r) => {
        r.targetUrls.app = r.targetUrls.app.replace(/\/[^/]+$/, '/fluvia_showroom_test_other');
      }),
      'target_dbnames_differ'
    );
  });
});

describe('guard [6]-[7]: hosts loopback y paridad maintenance/target', () => {
  it('target con host remoto aborta', async () => {
    await expectBlocked(
      mutate((r) => {
        r.targetUrls.admin = r.targetUrls.admin.replace('127.0.0.1', 'db.example.com');
      }),
      'host_not_loopback'
    );
  });

  it('maintenance con host remoto aborta', async () => {
    await expectBlocked(
      mutate((r) => {
        r.maintenanceUrl = r.maintenanceUrl.replace('127.0.0.1', '10.0.0.5');
      }),
      'host_not_loopback'
    );
  });

  it('un host que "parece local" NO se resuelve por DNS: aborta por literal', async () => {
    await expectBlocked(
      mutate((r) => {
        r.maintenanceUrl = r.maintenanceUrl.replace('127.0.0.1', 'localhost.example.com');
      }),
      'host_not_loopback'
    );
  });

  it('hosts loopback DIFERENTES entre maintenance y target abortan (identidad literal)', async () => {
    await expectBlocked(
      mutate((r) => {
        r.maintenanceUrl = r.maintenanceUrl.replace('127.0.0.1', 'localhost');
      }),
      'maintenance_target_mismatch'
    );
  });

  it('puertos diferentes abortan (puerto EFECTIVO, default 5432 comparado bien)', async () => {
    await expectBlocked(
      mutate((r) => {
        r.maintenanceUrl = 'postgres://postgres:postgres@127.0.0.1:5433/postgres';
      }),
      'maintenance_target_mismatch'
    );
  });
});

describe('guard [8]-[9]: la base de mantenimiento', () => {
  it('maintenance IGUAL al target aborta', async () => {
    await expectBlocked(
      mutate((r) => {
        r.maintenanceUrl =
          'postgres://postgres:postgres@127.0.0.1:5432/fluvia_showroom_test_guard1';
      }),
      'maintenance_equals_target'
    );
  });

  it('maintenance fuera de la allowlist (aunque sea inocua) aborta', async () => {
    for (const db of ['fluvia', 'template1', 'maintenance_db', 'fluvia_showroom_test_other']) {
      await expectBlocked(
        mutate((r) => {
          r.maintenanceUrl = `postgres://postgres:postgres@127.0.0.1:5432/${db}`;
        }),
        ['maintenance_not_allowlisted', 'maintenance_equals_target']
      );
    }
  });
});

describe('guard: parsing fail-closed de URLs', () => {
  it('URL invalida aborta', async () => {
    await expectBlocked(
      mutate((r) => {
        r.targetUrls.webhook = 'esto no es una url';
      }),
      'url_invalid'
    );
  });

  it('esquema no-postgres aborta', async () => {
    await expectBlocked(
      mutate((r) => {
        r.targetUrls.admin = 'mysql://root@127.0.0.1:5432/fluvia_showroom_test_guard1';
      }),
      'url_invalid'
    );
  });

  it('pathname con multiples segmentos (ambiguo) aborta', async () => {
    await expectBlocked(
      mutate((r) => {
        r.targetUrls.app =
          'postgres://fluvia_app:pw@127.0.0.1:5432/fluvia_showroom_test_guard1/extra';
      }),
      'url_invalid'
    );
  });

  it('percent-encoding en el dbname aborta (no puede "convertirse" en un nombre autorizado)', async () => {
    await expectBlocked(
      mutate((r) => {
        r.targetUrls.app = 'postgres://fluvia_app:pw@127.0.0.1:5432/%66luvia_showroom_test_guard1';
      }),
      'url_invalid'
    );
  });

  it('query params (en libpq pueden REDIRIGIR el destino) abortan', async () => {
    await expectBlocked(
      mutate((r) => {
        r.maintenanceUrl = 'postgres://postgres:postgres@127.0.0.1:5432/postgres?host=10.0.0.9';
      }),
      'url_invalid'
    );
  });

  it('hostname vacio (socket Unix ambiguo) aborta', async () => {
    await expectBlocked(
      mutate((r) => {
        r.targetUrls.auth = 'postgres:///fluvia_showroom_test_guard1';
      }),
      'url_invalid'
    );
  });
});

describe('guard: positivos', () => {
  it('target fluvia_showroom es valido (el nombre real de la base dedicada)', () => {
    const req = VALID();
    for (const role of Object.keys(req.targetUrls) as Array<keyof typeof req.targetUrls>) {
      req.targetUrls[role] = req.targetUrls[role].replace(/\/[^/]+$/, '/fluvia_showroom');
    }
    const plan = assertShowroomResetAllowed(req);
    expect(plan.targetDbName).toBe('fluvia_showroom');
    expect(plan.maintenanceDbName).toBe('postgres');
  });

  it('target efimero de test es valido y postgres SOLO puede ser maintenance', () => {
    const plan = assertShowroomResetAllowed(VALID());
    expect(plan.targetDbName).toBe('fluvia_showroom_test_guard1');
    expect(plan.maintenanceDbName).toBe('postgres');
    expect(RESET_CONFIRMATION).toBe('RESET_FLUVIA_SHOWROOM');
  });

  it('localhost/127.0.0.1/::1 se aceptan bajo la regla de identidad literal', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const req = VALID();
      for (const role of Object.keys(req.targetUrls) as Array<keyof typeof req.targetUrls>) {
        req.targetUrls[role] = req.targetUrls[role].replace('127.0.0.1', host);
      }
      req.maintenanceUrl = req.maintenanceUrl.replace('127.0.0.1', host);
      expect(() => assertShowroomResetAllowed(req)).not.toThrow();
    }
  });
});

/**
 * Guard PURO del `showroom:seed` (revision pre-auditoria): el seed tambien
 * debe demostrar POR SI MISMO que su target es la base dedicada — sin heredar
 * nada del reset. Misma politica de URLs (validador compartido) y el mismo
 * estandar de prueba: en cada rechazo, el factory de conexiones JAMAS se
 * invoca (openVerifiedShowroomTarget guarda primero, abre despues, atestigua
 * al final).
 */
describe('guard del seed (assertShowroomSeedTargetAllowed / openVerifiedShowroomTarget)', () => {
  const SEED_DB = 'fluvia_showroom_test_seedguard1';
  const seedUrls = () => targetUrlsFor(SEED_DB);

  async function expectSeedBlocked(
    env: string,
    targetUrls: ShowroomDbUrls,
    codes: ShowroomSeedGuardCode | ShowroomSeedGuardCode[]
  ): Promise<void> {
    const allowed = Array.isArray(codes) ? codes : [codes];
    // 1) El guard puro (sincrono, cero I/O) lanza el codigo estable esperado…
    let guardErr: unknown;
    try {
      assertShowroomSeedTargetAllowed({ env, targetUrls });
    } catch (err) {
      guardErr = err;
    }
    expect(guardErr).toBeInstanceOf(ShowroomSeedGuardError);
    expect(allowed).toContain((guardErr as ShowroomSeedGuardError).code);

    // 2) …y la via del CLI aborta SIN invocar jamas el connection factory.
    const factory = spyFactory();
    await expect(openVerifiedShowroomTarget(env, targetUrls, factory)).rejects.toBeInstanceOf(
      ShowroomSeedGuardError
    );
    expect(factory).not.toHaveBeenCalled();
  }

  it.each(['production', 'staging', 'sandbox', 'development', ''])(
    'env "%s" aborta pre-conexion',
    async (env) => {
      await expectSeedBlocked(env, seedUrls(), 'env_not_allowed');
    }
  );

  it('TODAS las URLs apuntando a la base principal `fluvia` abortan', async () => {
    await expectSeedBlocked('test', targetUrlsFor('fluvia'), [
      'target_name_invalid',
      'target_denylisted',
    ]);
  });

  it.each(['postgres', 'template0', 'template1'])('target "%s" aborta SIEMPRE', async (db) => {
    await expectSeedBlocked('test', targetUrlsFor(db), [
      'target_name_invalid',
      'target_denylisted',
    ]);
  });

  it('admin al showroom pero app a `fluvia` aborta (mezcla de destinos)', async () => {
    const urls = seedUrls();
    urls.app = urls.app.replace(/\/[^/]+$/, '/fluvia');
    await expectSeedBlocked('test', urls, [
      'target_name_invalid',
      'target_denylisted',
      'target_dbnames_differ',
    ]);
  });

  it('dos bases dedicadas DISTINTAS entre roles abortan igualmente', async () => {
    const urls = seedUrls();
    urls.relay = urls.relay.replace(/\/[^/]+$/, '/fluvia_showroom_test_other9');
    await expectSeedBlocked('test', urls, 'target_dbnames_differ');
  });

  it('role con URL invalida u omitida aborta', async () => {
    const broken = seedUrls();
    broken.webhook = 'esto no es una url';
    await expectSeedBlocked('test', broken, 'url_invalid');

    const missing = seedUrls();
    (missing as unknown as Record<string, unknown>).auth = undefined;
    await expectSeedBlocked('test', missing, 'url_invalid');
  });

  it.each(['shopdb', 'fluvia_showroom2', 'xfluvia_showroom', 'fluvia_showroom_test_'])(
    'target arbitrario o prefijo parecido "%s" aborta',
    async (db) => {
      await expectSeedBlocked('test', targetUrlsFor(db), 'target_name_invalid');
    }
  );

  it('host remoto aborta (literal, sin DNS)', async () => {
    const urls = seedUrls();
    urls.admin = urls.admin.replace('127.0.0.1', 'db.example.com');
    await expectSeedBlocked('test', urls, 'host_not_loopback');
  });

  it('hosts o puertos DISTINTOS entre roles abortan', async () => {
    const hosts = seedUrls();
    hosts.app = hosts.app.replace('127.0.0.1', 'localhost');
    await expectSeedBlocked('test', hosts, 'target_host_port_differ');

    const ports = seedUrls();
    ports.app = ports.app.replace(':5432/', ':5433/');
    await expectSeedBlocked('test', ports, 'target_host_port_differ');
  });

  it('query/fragment/path multi-segmento/percent-encoding abortan', async () => {
    const query = seedUrls();
    query.admin = `${query.admin}?host=10.0.0.9`;
    await expectSeedBlocked('test', query, 'url_invalid');

    const fragment = seedUrls();
    fragment.admin = `${fragment.admin}#frag`;
    await expectSeedBlocked('test', fragment, 'url_invalid');

    const multi = seedUrls();
    multi.admin = `${multi.admin}/extra`;
    await expectSeedBlocked('test', multi, 'url_invalid');

    const percent = seedUrls();
    percent.admin = percent.admin.replace(SEED_DB, `%66${SEED_DB.slice(1)}`);
    await expectSeedBlocked('test', percent, 'url_invalid');
  });

  it('fluvia_showroom y el target efimero de test son validos; el factory abre EXACTAMENTE 5 pools', async () => {
    const planReal = assertShowroomSeedTargetAllowed({
      env: 'local',
      targetUrls: targetUrlsFor('fluvia_showroom'),
    });
    expect(planReal.targetDbName).toBe('fluvia_showroom');

    // Pools falsos cuya identidad LIVE es valida y consistente (la attestation
    // real contra PostgreSQL vive en showroom-cluster-identity.test.ts y en el
    // seed completo): aqui se prueba el ORDEN del flujo y el conteo exacto.
    const factory = vi.fn((opts: { connectionString: string; max?: number }) => {
      return {
        connectionString: opts.connectionString,
        query: async () => ({
          rows: [
            {
              database: SEED_DB,
              server_address: '127.0.0.1',
              server_port: '5432',
              postmaster_started_at: '2026-07-18 00:00:00.000000+00',
              cluster_identifier: '7000000000000000001',
            },
          ],
        }),
        end: async () => undefined,
      } as unknown as Pool;
    });
    const opened = await openVerifiedShowroomTarget('test', seedUrls(), factory);
    expect(opened.targetDbName).toBe(SEED_DB);
    // El handle es OPACO (delta EXT-001): no expone pools/identidad/plan.
    expect(opened.target).toEqual({ kind: 'verified-showroom-target' });
    expect(factory).toHaveBeenCalledTimes(5);
    for (const call of factory.mock.calls) {
      expect(new URL(call[0].connectionString).pathname).toBe(`/${SEED_DB}`);
    }
  });
});
