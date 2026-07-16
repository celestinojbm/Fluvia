import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';

/**
 * F6.5C1 (B6) — atomicidad ante FALLO DE AUDITORIA (patron RA-F65B-003, con
 * fallo inyectable ACOTADO al test): se envuelve `insertAuditEvent` para que
 * lance SOLO cuando el test lo pide (por accion), sin hooks de produccion. El
 * resto del flujo corre contra PostgreSQL real; el fallo ocurre DENTRO de la
 * transaccion del servicio => rollback completo (ni usuario, ni token, ni el
 * audit previo que si se habia insertado).
 *
 * Archivo separado: `vi.mock` es por-modulo-de-test y no debe contaminar la
 * suite principal de register-sandbox.
 */

const failure = vi.hoisted(() => ({ action: null as string | null }));

vi.mock('@fluvia/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluvia/audit')>();
  return {
    ...actual,
    insertAuditEvent: async (
      client: Parameters<typeof actual.insertAuditEvent>[0],
      event: Parameters<typeof actual.insertAuditEvent>[1]
    ) => {
      if (failure.action !== null && event.action === failure.action) {
        throw new Error(`injected audit failure: ${event.action}`);
      }
      return actual.insertAuditEvent(client, event);
    },
  };
});

// Import DESPUES del mock: el AuthService debe resolver el modulo interceptado.
const { AuthService } = await import('../src/index.js');

let ctx: TestContext;
let sandbox: InstanceType<typeof AuthService>;

const uniqueEmail = () => `sbx-audit-${randomUUID().slice(0, 10)}@example.com`;
const PASSWORD = 'sandbox signup password 7';

async function userCount(email: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM users WHERE lower(email) = $1',
    [email.toLowerCase()]
  );
  return Number(res.rows[0]!.n);
}

async function auditCount(requestId: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM audit_events WHERE request_id = $1',
    [requestId]
  );
  return Number(res.rows[0]!.n);
}

beforeAll(async () => {
  ctx = await createTestContext();
  sandbox = new AuthService(ctx.auth, { allowSandboxRegistration: true });
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

afterEach(() => {
  failure.action = null;
});

describe('registerAndVerifySandbox — fallo de cualquiera de los dos audits => rollback completo', () => {
  it('failure of the FIRST audit (user.registered) rolls back user and token', async () => {
    failure.action = 'user.registered';
    const email = uniqueEmail();
    const requestId = randomUUID();
    await expect(
      sandbox.registerAndVerifySandbox({ email, password: PASSWORD }, { requestId })
    ).rejects.toThrow(/injected audit failure/);
    expect(await userCount(email)).toBe(0);
    expect(await auditCount(requestId)).toBe(0);
  });

  it('failure of the SECOND audit (user.email_verified) rolls back user, token AND the first audit', async () => {
    failure.action = 'user.email_verified';
    const email = uniqueEmail();
    const requestId = randomUUID();
    await expect(
      sandbox.registerAndVerifySandbox({ email, password: PASSWORD }, { requestId })
    ).rejects.toThrow(/injected audit failure/);
    // El usuario, su token y el audit `user.registered` (que SI llego a
    // insertarse dentro de la tx) desaparecieron con el rollback.
    expect(await userCount(email)).toBe(0);
    expect(await auditCount(requestId)).toBe(0);
  });

  it('sanity: with no injected failure the same service commits normally', async () => {
    const email = uniqueEmail();
    const requestId = randomUUID();
    await sandbox.registerAndVerifySandbox({ email, password: PASSWORD }, { requestId });
    expect(await userCount(email)).toBe(1);
    expect(await auditCount(requestId)).toBe(2);
  });
});
