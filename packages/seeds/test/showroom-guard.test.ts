import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '@fluvia/db';
import {
  RESET_CONFIRMATION,
  ShowroomResetGuardError,
  assertShowroomResetAllowed,
  runShowroomReset,
  type ShowroomResetGuardCode,
  type ShowroomResetRequest,
} from '../src/reset.js';
import { resetRequestFor } from './showroom-helpers.js';

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
