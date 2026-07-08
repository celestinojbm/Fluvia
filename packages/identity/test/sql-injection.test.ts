import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { CustomerService } from '../src/index.js';

/**
 * F6 (threat model §5 — Multi-tenant): respaldo EMPÍRICO del candado estático
 * de parametrización (`packages/db/test/sql-parameterization.test.ts`). Empuja
 * payloads hostiles por los sinks de texto libre de CustomerService — incluido
 * el ÚNICO builder de cláusula dinámica del código de producto (el
 * `${sets.join(', ')}` de `update`) — y verifica que llegan como DATOS: viaje
 * de ida y vuelta EXACTO, tabla intacta, sin filas colaterales. Si alguna
 * consulta interpolara un valor, uno de estos payloads rompería la query o
 * mutaría el esquema; ninguno lo hace.
 */

let ctx: TestContext;
let service: CustomerService;
let org: string;
let orgB: string;

/** Vectores clásicos de inyección — todos deben almacenarse como texto literal. */
const HOSTILE = [
  `'; DROP TABLE customers; --`,
  `Robert'); DROP TABLE customers;--`, // little Bobby Tables
  `' OR '1'='1`,
  `x'; UPDATE customers SET deleted_at = now(); --`,
  `$1$2$3`, // se ve como placeholders de bind: debe quedar como texto
  `100%' UNION SELECT rolname FROM pg_roles --`,
  `’; DROP TABLE customers; --`, // comilla tipográfica (unicode)
  `admin"/*`,
  `\\'; SELECT pg_sleep(0); --`,
];

beforeAll(async () => {
  ctx = await createTestContext();
  service = new CustomerService(ctx.app);
  org = await ctx.createTenant(`SQLi ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`SQLi-B ${randomUUID().slice(0, 8)}`);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

async function tableExists(name: string): Promise<boolean> {
  const res = await ctx.admin.query<{ reg: string | null }>(`SELECT to_regclass($1) AS reg`, [
    `public.${name}`,
  ]);
  return res.rows[0]!.reg !== null;
}

async function customerCount(tenantId: string): Promise<number> {
  const res = await ctx.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM customers WHERE tenant_id = $1`,
    [tenantId]
  );
  return Number(res.rows[0]!.n);
}

describe('inyección SQL por los sinks de texto libre (create/get)', () => {
  it('stores every hostile payload verbatim in name/phone/description and round-trips exactly', async () => {
    expect(await tableExists('customers')).toBe(true);
    const before = await customerCount(org);

    for (const payload of HOSTILE) {
      const created = await service.create(org, {
        name: payload,
        phone: payload.slice(0, 40),
        description: payload,
      });
      const fetched = await service.get(org, created.id);
      // Viaje de ida y vuelta EXACTO: el payload es dato, no SQL.
      expect(fetched.name).toBe(payload);
      expect(fetched.phone).toBe(payload.slice(0, 40));
      expect(fetched.description).toBe(payload);
    }

    // La tabla sigue existiendo y solo crecieron las filas que insertamos:
    // ni un DROP, ni un UPDATE masivo de deleted_at, ni filas fantasma.
    expect(await tableExists('customers')).toBe(true);
    expect(await customerCount(org)).toBe(before + HOSTILE.length);
  });

  it('hostile payloads in metadata (jsonb) round-trip as data, keys and values intact', async () => {
    // metadata es un mapa plano string→string; claves y valores hostiles.
    const meta = {
      [`k'; DROP--`]: `v' OR 1=1 --`,
      [`$1`]: `x'); DELETE FROM customers; --`,
      [`a\\'`]: `’; SELECT pg_sleep(0) --`,
    };
    const created = await service.create(org, { name: 'meta', metadata: meta });
    const fetched = await service.get(org, created.id);
    expect(fetched.metadata).toEqual(meta);
  });
});

describe('inyección SQL por el builder de cláusula dinámica (update SET)', () => {
  it('the ${sets.join} clause treats hostile VALUES as data and never widens the SET', async () => {
    const created = await service.create(org, { name: 'before', description: 'before' });
    const before = await customerCount(org);

    for (const payload of HOSTILE) {
      const updated = await service.update(org, created.id, {
        name: payload,
        description: payload,
      });
      expect(updated.name).toBe(payload);
      expect(updated.description).toBe(payload);
    }

    // Un valor hostil en el SET no puede tocar OTRA columna (los identificadores
    // del SET son literales; los valores van por $N): el customer sigue vivo.
    const still = await service.get(org, created.id);
    expect(still.id).toBe(created.id);
    // Sin filas colaterales creadas por el update.
    expect(await customerCount(org)).toBe(before);
  });

  it('an injected non-whitelisted field in the update input is REJECTED (strict schema + fixed SET)', async () => {
    const created = await service.create(org, { name: 'keep' });
    // `deleted_at` NO es un campo del recurso: el schema `.strict()` rechaza la
    // clave desconocida ANTES del SQL, así que jamás podría entrar al SET (que
    // además usa identificadores literales). Defensa en dos capas.
    await expect(
      service.update(org, created.id, {
        name: 'kept',
        deleted_at: '1999-01-01',
      } as unknown as Parameters<CustomerService['update']>[2])
    ).rejects.toThrow();
    // El customer quedó INTACTO (ni renombrado ni soft-deleted por la inyección).
    const fetched = await service.get(org, created.id);
    expect(fetched.name).toBe('keep');
  });
});

describe('la validación bloquea payloads hostiles en campos tipados ANTES del SQL', () => {
  it('a hostile email never reaches the query (Zod .email() rejects it)', async () => {
    await expect(
      service.create(org, { email: `a'@x.com'; DROP TABLE customers; --` })
    ).rejects.toThrow();
    // Y la tabla sigue intacta.
    expect(await tableExists('customers')).toBe(true);
  });
});

describe('los payloads hostiles respetan el aislamiento por tenant', () => {
  it('a payload crafted to read another tenant cannot cross RLS', async () => {
    const mine = await service.create(org, { name: `x' OR tenant_id IS NOT NULL --` });
    // Desde orgB, ese customer no existe (RLS), pese al payload "OR ... --".
    await expect(service.get(orgB, mine.id)).rejects.toThrow();
    expect((await service.list(orgB, 100)).some((c) => c.id === mine.id)).toBe(false);
  });
});
