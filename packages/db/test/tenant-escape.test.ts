import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../src/index.js';
import { createTestContext, type TestContext } from '../src/testing.js';

/**
 * F1-06 — Suite ampliada de tenant-escape (Gate Multi-tenant, V4 §51).
 * Complementa rls.test.ts con vectores de escritura, joins, sondas booleanas,
 * fuga de contexto de pool, escalada de rol de BD y META-TESTS estructurales
 * que cubren automaticamente toda tabla futura.
 */

let ctx: TestContext;
let orgA: string;
let orgB: string;
let merchantB: string;

async function createMerchant(tenantId: string, name: string): Promise<string> {
  return withTenantTransaction(ctx.app, tenantId, async (c) => {
    const res = await c.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantId, name]
    );
    return res.rows[0]!.id;
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  orgA = await ctx.createTenant('Escape A');
  orgB = await ctx.createTenant('Escape B');
  await createMerchant(orgA, `A-shop-${randomUUID().slice(0, 8)}`);
  merchantB = await createMerchant(orgB, `B-shop-${randomUUID().slice(0, 8)}`);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('vectores de escritura cross-tenant', () => {
  it('UPDATE by primary key of another tenant row affects 0 rows', async () => {
    const res = await withTenantTransaction(ctx.app, orgA, (c) =>
      c.query(`UPDATE merchants SET name = 'pwned' WHERE id = $1`, [merchantB])
    );
    expect(res.rowCount).toBe(0);
    const intact = await ctx.admin.query('SELECT name FROM merchants WHERE id = $1', [merchantB]);
    expect(intact.rows[0]!.name).not.toBe('pwned');
  });

  it('mass UPDATE without WHERE only touches own-tenant rows', async () => {
    const res = await withTenantTransaction(ctx.app, orgA, (c) =>
      c.query(`UPDATE merchants SET updated_at = now()`)
    );
    const totalA = await ctx.admin.query(
      'SELECT count(*)::int AS n FROM merchants WHERE tenant_id = $1',
      [orgA]
    );
    expect(res.rowCount).toBe(totalA.rows[0]!.n);
  });

  it('INSERT ... SELECT cannot siphon rows from another tenant', async () => {
    const res = await withTenantTransaction(ctx.app, orgA, (c) =>
      c.query(
        `INSERT INTO merchants (tenant_id, name, country, default_currency)
         SELECT $1, name || '-copy', country, default_currency
         FROM merchants WHERE tenant_id = $2`,
        [orgA, orgB]
      )
    );
    expect(res.rowCount).toBe(0);
  });
});

describe('vectores de lectura indirecta', () => {
  it('JOIN through memberships/users/organizations leaks nothing', async () => {
    const rows = await withTenantTransaction(ctx.app, orgA, async (c) => {
      const res = await c.query(
        `SELECT o.id FROM organizations o
         LEFT JOIN memberships m ON m.tenant_id = o.id
         LEFT JOIN users u ON u.id = m.user_id
         WHERE o.id = $1`,
        [orgB]
      );
      return res.rowCount;
    });
    expect(rows).toBe(0);
  });

  it('EXISTS probe gives no boolean oracle about other tenants', async () => {
    const probe = await withTenantTransaction(ctx.app, orgA, async (c) => {
      const res = await c.query<{ found: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM merchants WHERE id = $1) AS found`,
        [merchantB]
      );
      return res.rows[0]!.found;
    });
    expect(probe).toBe(false);
  });

  it('aggregates are tenant-scoped', async () => {
    const [fromA, real] = await Promise.all([
      withTenantTransaction(ctx.app, orgA, async (c) => {
        const res = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM merchants');
        return res.rows[0]!.n;
      }),
      ctx.admin
        .query<{ n: number }>('SELECT count(*)::int AS n FROM merchants WHERE tenant_id = $1', [
          orgA,
        ])
        .then((r) => r.rows[0]!.n),
    ]);
    expect(fromA).toBe(real);
  });
});

describe('fuga de contexto y escalada de rol', () => {
  it('the SAME pooled connection does not leak context across transactions', async () => {
    const client = await ctx.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [orgA]);
      const inA = await client.query('SELECT count(*)::int AS n FROM merchants');
      expect(inA.rows[0].n).toBeGreaterThan(0);
      await client.query('COMMIT');

      // Misma conexion, sin contexto: nada.
      const noCtx = await client.query('SELECT count(*)::int AS n FROM merchants');
      expect(noCtx.rows[0].n).toBe(0);

      // Misma conexion, contexto B: solo B.
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [orgB]);
      const crossRead = await client.query('SELECT 1 FROM merchants WHERE tenant_id = $1', [orgA]);
      expect(crossRead.rowCount).toBe(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('the app role cannot escalate via SET ROLE', async () => {
    const client = await ctx.app.connect();
    try {
      await expect(client.query('SET ROLE postgres')).rejects.toThrow(/permission denied/i);
      await expect(client.query('SET ROLE fluvia_worker')).rejects.toThrow(/permission denied/i);
      await expect(client.query('SET ROLE fluvia_auth')).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }
  });

  it('the worker role still has NO DELETE anywhere', async () => {
    await expect(ctx.worker.query('DELETE FROM outbox_events')).rejects.toThrow(
      /permission denied/i
    );
    await expect(ctx.worker.query('DELETE FROM merchants')).rejects.toThrow(/permission denied/i);
  });
});

describe('META-TESTS estructurales (cubren toda tabla futura)', () => {
  it('every table with a tenant_id column has RLS ENABLED and FORCED plus at least one policy', async () => {
    const res = await ctx.admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        )
    `);
    expect(res.rowCount).toBeGreaterThan(5);
    for (const row of res.rows) {
      expect(row.relrowsecurity, `${row.relname} sin ENABLE RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} sin FORCE RLS`).toBe(true);
      expect(row.policies, `${row.relname} sin politicas`).toBeGreaterThan(0);
    }
  });

  it('auth-plane tables (users/sessions/tokens) are also force-RLS protected', async () => {
    const res = await ctx.admin.query<{ relname: string; ok: boolean }>(`
      SELECT relname, (relrowsecurity AND relforcerowsecurity) AS ok
      FROM pg_class
      WHERE relname IN ('users', 'sessions', 'email_verification_tokens',
                        'mfa_challenges', 'mfa_backup_codes')
    `);
    expect(res.rowCount).toBe(5);
    for (const row of res.rows) expect(row.ok, row.relname).toBe(true);
  });

  it('no runtime role holds DELETE on ANY table (defensa por grants)', async () => {
    const res = await ctx.admin.query(`
      SELECT grantee, table_name FROM information_schema.role_table_grants
      WHERE grantee IN ('fluvia_app', 'fluvia_worker', 'fluvia_relay', 'fluvia_inbox', 'fluvia_auth')
        AND privilege_type = 'DELETE'
    `);
    expect(res.rows).toEqual([]);
  });

  it('the app, worker, relay and inbox roles hold NO privileges on credential tables', async () => {
    const res = await ctx.admin.query(`
      SELECT grantee, table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee IN ('fluvia_app', 'fluvia_worker', 'fluvia_relay', 'fluvia_inbox')
        AND table_name IN ('sessions', 'email_verification_tokens')
    `);
    expect(res.rows).toEqual([]);
  });

  it('F6 (revisión de seguridad): the app/worker roles hold NO write grant on users (0045)', async () => {
    // `users` no es tabla de credenciales pura (app tiene SELECT vía la política de
    // membresía), pero nunca debe escribirla: 0045 revoca la asimetría heredada de
    // los default privileges de 0002 (la RLS ya lo bloqueaba; esto añade el respaldo).
    const res = await ctx.admin.query(`
      SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE grantee IN ('fluvia_app', 'fluvia_worker')
        AND table_name = 'users' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    `);
    expect(res.rows).toEqual([]);
  });

  it('AUD-P1-007: NO runtime role has BYPASSRLS (cross-tenant reads are explicit policies)', async () => {
    const res = await ctx.admin.query<{ rolname: string; rolbypassrls: boolean }>(`
      SELECT rolname, rolbypassrls FROM pg_roles
      WHERE rolname IN ('fluvia_app', 'fluvia_worker', 'fluvia_relay', 'fluvia_inbox', 'fluvia_auth', 'fluvia_webhook')
    `);
    expect(res.rowCount).toBe(6);
    for (const row of res.rows) {
      expect(row.rolbypassrls, `${row.rolname} tiene BYPASSRLS`).toBe(false);
    }
  });

  it('ADR-0011: fluvia_worker is a process shell — ZERO table privileges', async () => {
    const res = await ctx.admin.query(`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'fluvia_worker'
    `);
    expect(res.rows).toEqual([]);
  });

  it('F2-12: fluvia_inbox holds ONLY provider_events (SELECT + column UPDATE) and DLQ INSERT', async () => {
    const tables = await ctx.admin.query<{ table_name: string; privilege_type: string }>(`
      SELECT DISTINCT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'fluvia_inbox'
    `);
    for (const row of tables.rows) {
      const allowed =
        (row.table_name === 'provider_events' && row.privilege_type === 'SELECT') ||
        (row.table_name === 'raw_provider_payloads_dlq' && row.privilege_type === 'INSERT');
      expect(allowed, `privilegio inesperado: ${row.privilege_type} en ${row.table_name}`).toBe(
        true
      );
    }

    const cols = await ctx.admin.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = 'fluvia_inbox' AND table_name = 'provider_events'
        AND privilege_type = 'UPDATE'
      ORDER BY column_name
    `);
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      'attempts',
      'last_error',
      'locked_by',
      'next_attempt_at',
      'processed_at',
      'result',
      'status',
    ]);
  });

  it('F2-12: the app role can only INSERT into provider_events (no read, no update)', async () => {
    const tables = await ctx.admin.query<{ privilege_type: string }>(`
      SELECT DISTINCT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'fluvia_app' AND table_name = 'provider_events'
    `);
    expect(tables.rows.map((r) => r.privilege_type)).toEqual(['INSERT']);
  });

  it('ADR-0011: fluvia_relay holds ONLY outbox_events SELECT + column-scoped UPDATE', async () => {
    // (mantiene la aserción específica; el barrido deny-by-default vive abajo)
    const tables = await ctx.admin.query<{ table_name: string; privilege_type: string }>(`
      SELECT DISTINCT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'fluvia_relay'
    `);
    for (const row of tables.rows) {
      expect(row.table_name, `privilegio inesperado en ${row.table_name}`).toBe('outbox_events');
      expect(['SELECT', 'UPDATE']).toContain(row.privilege_type);
    }

    // El UPDATE es por columna: exactamente los campos de despacho.
    const cols = await ctx.admin.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = 'fluvia_relay' AND table_name = 'outbox_events'
        AND privilege_type = 'UPDATE'
      ORDER BY column_name
    `);
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      'attempts',
      'delivered_at',
      'last_error',
      'locked_by',
      'next_attempt_at',
      'status',
    ]);
  });
});

/**
 * F6 (threat model §5 — Multi-tenant): los meta-tests de arriba fijaban una
 * LISTA de roles a mano — un rol `fluvia_%` nuevo (una futura integración, un
 * job) podía nacer con BYPASSRLS o DELETE sin romper nada. Este bloque es
 * DENY-BY-DEFAULT: descubre TODOS los roles `fluvia_%` de `pg_catalog` y les
 * aplica las invariantes; además exige que cada rol descubierto esté en un
 * allowlist conocido, así un rol nuevo rompe el build hasta que un humano lo
 * revise y lo clasifique.
 */
describe('META-TESTS deny-by-default sobre TODOS los roles fluvia_% (F6)', () => {
  /** Roles de runtime conocidos y su rol declarado (config.ts / migraciones). */
  const KNOWN_RUNTIME_ROLES = new Set([
    'fluvia_app',
    'fluvia_worker',
    'fluvia_relay',
    'fluvia_inbox',
    'fluvia_auth',
    'fluvia_webhook',
  ]);

  async function discoverFluviaRoles(): Promise<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
  > {
    const res = await ctx.admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'fluvia\\_%' ORDER BY rolname`
    );
    return res.rows;
  }

  it('every discovered fluvia_% role is a KNOWN role (an unknown one forces review)', async () => {
    const roles = await discoverFluviaRoles();
    // Non-vacuidad: el descubrimiento realmente ve los roles del sistema.
    expect(roles.length).toBeGreaterThanOrEqual(KNOWN_RUNTIME_ROLES.size);
    const unknown = roles.map((r) => r.rolname).filter((n) => !KNOWN_RUNTIME_ROLES.has(n));
    expect(
      unknown,
      `rol fluvia_% no clasificado (revisar privilegios y añadir a KNOWN_RUNTIME_ROLES): ${unknown.join(', ')}`
    ).toEqual([]);
  });

  it('NO fluvia_% role is SUPERUSER or has BYPASSRLS (discovered dynamically)', async () => {
    const roles = await discoverFluviaRoles();
    const escalated = roles.filter((r) => r.rolsuper || r.rolbypassrls);
    expect(
      escalated.map((r) => `${r.rolname}(super=${r.rolsuper},bypassrls=${r.rolbypassrls})`),
      'un rol de runtime puede saltar RLS o es superusuario'
    ).toEqual([]);
  });

  it('NO fluvia_% role has EFFECTIVE DELETE/TRUNCATE on ANY table (incl. PUBLIC + inherited)', async () => {
    // `has_table_privilege` calcula el privilegio EFECTIVO: cubre grants a
    // PUBLIC y los heredados por membresía de grupo (con rolinherit) — que un
    // barrido de grants DIRECTOS por nombre (role_table_grants) NO ve. Se
    // recorre cada rol fluvia_% × cada tabla de `public`.
    const res = await ctx.admin.query<{ rolname: string; tablename: string; priv: string }>(`
      SELECT r.rolname, t.tablename,
             CASE WHEN has_table_privilege(r.rolname, format('%I.%I', t.schemaname, t.tablename), 'DELETE')
                  THEN 'DELETE' ELSE 'TRUNCATE' END AS priv
      FROM pg_roles r
      CROSS JOIN pg_tables t
      WHERE r.rolname LIKE 'fluvia\\_%'
        AND t.schemaname = 'public'
        AND (has_table_privilege(r.rolname, format('%I.%I', t.schemaname, t.tablename), 'DELETE')
             OR has_table_privilege(r.rolname, format('%I.%I', t.schemaname, t.tablename), 'TRUNCATE'))
    `);
    expect(
      res.rows.map((r) => `${r.rolname}:${r.priv} on ${r.tablename}`),
      'un rol de runtime tiene DELETE/TRUNCATE efectivo (directo, PUBLIC o heredado)'
    ).toEqual([]);
  });

  it('NO fluvia_% role can CREATE roles or databases (discovered dynamically)', async () => {
    const res = await ctx.admin.query<{
      rolname: string;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>(`SELECT rolname, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname LIKE 'fluvia\\_%'`);
    const offenders = res.rows.filter((r) => r.rolcreaterole || r.rolcreatedb);
    expect(
      offenders.map((r) => `${r.rolname}(createrole=${r.rolcreaterole},createdb=${r.rolcreatedb})`),
      'un rol de runtime puede crear roles/bases'
    ).toEqual([]);
  });

  it('F6 (revisión de seguridad): NO fluvia_% role can create TEMP objects (cierra el shadowing de pg_temp)', async () => {
    // Un rol capaz de `CREATE TEMP TABLE` podría shadowear las tablas SIN calificar
    // de un SECURITY DEFINER: `SET search_path = public` NO excluye `pg_temp`, que
    // PG busca PRIMERO para relaciones. 0045 revoca TEMPORARY a PUBLIC → ningún rol
    // de runtime crea objetos temporales y el vector se cierra de raíz, con
    // independencia del search_path de cada función.
    const res = await ctx.admin.query<{ rolname: string; temp: boolean }>(`
      SELECT rolname, has_database_privilege(rolname, current_database(), 'TEMP') AS temp
      FROM pg_roles WHERE rolname LIKE 'fluvia\\_%'
    `);
    const offenders = res.rows.filter((r) => r.temp);
    expect(
      offenders.map((r) => r.rolname),
      'un rol de runtime puede crear objetos temporales (vector de shadowing de pg_temp)'
    ).toEqual([]);
  });
});
