import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { CustomerNotFoundError, CustomerService } from '../src/index.js';

/**
 * F3-05a — CustomerService contra PG real: validación, update parcial (null
 * limpia, metadata reemplaza), baja lógica idempotente y aislamiento por tenant.
 */

let ctx: TestContext;
let service: CustomerService;
let org: string;
let orgB: string;

beforeAll(async () => {
  ctx = await createTestContext();
  service = new CustomerService(ctx.app);
  org = await ctx.createTenant(`Cust ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`Cust-B ${randomUUID().slice(0, 8)}`);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('create + validación', () => {
  it('creates a customer with whitelisted fields and defaults metadata to {}', async () => {
    const c = await service.create(org, { email: 'ana@example.com', name: 'Ana' });
    expect(c.id).toBeTruthy();
    expect(c.email).toBe('ana@example.com');
    expect(c.name).toBe('Ana');
    expect(c.phone).toBeNull();
    expect(c.metadata).toEqual({});
  });

  it('allows DUPLICATE emails (Stripe semantics: email is not unique)', async () => {
    await service.create(org, { email: 'dup@example.com', name: 'One' });
    const two = await service.create(org, { email: 'dup@example.com', name: 'Two' });
    expect(two.id).toBeTruthy();
    const list = await service.list(org, 100);
    expect(list.filter((c) => c.email === 'dup@example.com')).toHaveLength(2);
  });

  it('requires at least one of email/name/phone', async () => {
    await expect(service.create(org, { description: 'solo desc' })).rejects.toThrow(/at least one/);
  });

  it('rejects invalid email, oversized metadata and unknown keys', async () => {
    await expect(service.create(org, { email: 'not-an-email' })).rejects.toThrow();
    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']));
    await expect(service.create(org, { name: 'x', metadata: tooMany })).rejects.toThrow(
      /at most 50/
    );
    // Clave desconocida => anti mass-assignment.
    await expect(
      service.create(org, { name: 'x', is_admin: true } as unknown as { name: string })
    ).rejects.toThrow();
  });
});

describe('get + list', () => {
  it('get returns the customer; a foreign tenant gets not found (RLS)', async () => {
    const c = await service.create(org, { name: 'Visible' });
    expect((await service.get(org, c.id)).id).toBe(c.id);
    await expect(service.get(orgB, c.id)).rejects.toThrow(CustomerNotFoundError);
  });

  it('list is tenant-scoped, newest-first, and excludes soft-deleted', async () => {
    const isolated = await ctx.createTenant(`Cust-L ${randomUUID().slice(0, 8)}`);
    const first = await service.create(isolated, { name: 'First' });
    const second = await service.create(isolated, { name: 'Second' });
    const list = await service.list(isolated, 100);
    expect(list.map((c) => c.id)).toEqual([second.id, first.id]);

    await service.softDelete(isolated, first.id);
    const after = await service.list(isolated, 100);
    expect(after.map((c) => c.id)).toEqual([second.id]);
  });
});

describe('update parcial', () => {
  it('changes only present keys; null clears a field; metadata REPLACES the bag', async () => {
    const c = await service.create(org, {
      email: 'u@example.com',
      name: 'Name',
      phone: '+57 300',
      metadata: { a: '1', b: '2' },
    });
    // Solo name; el resto intacto.
    const r1 = await service.update(org, c.id, { name: 'New Name' });
    expect(r1.name).toBe('New Name');
    expect(r1.email).toBe('u@example.com');
    expect(r1.phone).toBe('+57 300');
    expect(r1.metadata).toEqual({ a: '1', b: '2' });

    // null limpia phone; metadata reemplaza (no merge).
    const r2 = await service.update(org, c.id, { phone: null, metadata: { c: '3' } });
    expect(r2.phone).toBeNull();
    expect(r2.metadata).toEqual({ c: '3' });
    expect(r2.name).toBe('New Name');
  });

  it('rejects an empty update and updates on a foreign/missing customer are not found', async () => {
    const c = await service.create(org, { name: 'X' });
    await expect(service.update(org, c.id, {})).rejects.toThrow(/at least one field/);
    await expect(service.update(orgB, c.id, { name: 'hack' })).rejects.toThrow(
      CustomerNotFoundError
    );
  });
});

describe('softDelete', () => {
  it('is idempotent and hides the customer from get/list; foreign tenant is not found', async () => {
    const c = await service.create(org, { name: 'ToDelete' });
    await service
      .softDelete(orgB, c.id)
      .catch((e) => expect(e).toBeInstanceOf(CustomerNotFoundError));
    const del1 = await service.softDelete(org, c.id);
    expect(del1.deleted).toBe(true);
    // Segundo borrado: no es error de estado.
    const del2 = await service.softDelete(org, c.id);
    expect(del2.deleted).toBe(true);
    await expect(service.get(org, c.id)).rejects.toThrow(CustomerNotFoundError);
  });
});
