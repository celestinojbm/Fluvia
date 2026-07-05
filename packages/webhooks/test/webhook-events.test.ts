import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import type { AuditContext } from '@fluvia/audit';
import {
  WebhookEventNotDeadError,
  WebhookEventNotFoundError,
  WebhookEventService,
} from '../src/index.js';

/**
 * F3-09a — lectura de la cola de webhooks + reenvío manual auditado de eventos
 * `dead`, contra PG real bajo el rol fluvia_app (RLS por tenant). La cola se
 * siembra con el pool admin (el relay/deliverer la escriben en producción).
 */

let ctx: TestContext;
let service: WebhookEventService;
let org: string;
let orgB: string;
let endpoint: string;

const AUDIT: AuditContext = {
  actorType: 'api_key',
  actorId: randomUUID(),
  authMethod: 'api_key',
  requestId: 'req-test',
};

async function seedEndpoint(tenantId: string): Promise<string> {
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO webhook_endpoints (tenant_id, url, secret_enc, events)
     VALUES ($1, $2, $3, '{}') RETURNING id`,
    [tenantId, 'https://example.test/hook', 'enc:dummy']
  );
  return res.rows[0]!.id;
}

async function seedEvent(
  tenantId: string,
  endpointId: string,
  status: 'pending' | 'delivered' | 'dead',
  attempts = status === 'dead' ? 7 : 0
): Promise<string> {
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO webhook_events (tenant_id, endpoint_id, topic, payload, status, attempts, last_error)
     VALUES ($1, $2, 'merchant.updated', $3, $4, $5, $6) RETURNING id`,
    [
      tenantId,
      endpointId,
      JSON.stringify({ event_id: `evt_${randomUUID()}`, data: { hello: 'world' } }),
      status,
      attempts,
      status === 'dead' ? 'non-2xx response: 500' : null,
    ]
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  service = new WebhookEventService(ctx.app);
  org = await ctx.createTenant(`WHE ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`WHE-B ${randomUUID().slice(0, 8)}`);
  endpoint = await seedEndpoint(org);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('lectura de la cola (RLS por tenant)', () => {
  it('lists a tenant events and filters by endpoint and status', async () => {
    const dead = await seedEvent(org, endpoint, 'dead');
    const delivered = await seedEvent(org, endpoint, 'delivered');

    const all = await service.list(org, { limit: 100 });
    const ids = all.map((e) => e.id);
    expect(ids).toContain(dead);
    expect(ids).toContain(delivered);

    const onlyDead = await service.list(org, { status: 'dead', limit: 100 });
    expect(onlyDead.every((e) => e.status === 'dead')).toBe(true);
    expect(onlyDead.map((e) => e.id)).toContain(dead);

    const byEndpoint = await service.list(org, { endpointId: endpoint, limit: 100 });
    expect(byEndpoint.map((e) => e.id)).toContain(dead);
    const byOther = await service.list(org, { endpointId: randomUUID(), limit: 100 });
    expect(byOther).toEqual([]);
  });

  it('returns detail with payload and attempt history', async () => {
    const dead = await seedEvent(org, endpoint, 'dead');
    await ctx.admin.query(
      `INSERT INTO webhook_attempts
         (tenant_id, webhook_event_id, attempt_number, status_code, error, latency_ms, resolved_ip)
       VALUES ($1, $2, 1, 500, 'boom', 42, '203.0.113.9')`,
      [org, dead]
    );
    const detail = await service.get(org, dead);
    expect(detail.status).toBe('dead');
    expect((detail.payload as { data: { hello: string } }).data.hello).toBe('world');
    expect(detail.attemptsHistory).toHaveLength(1);
    expect(detail.attemptsHistory[0]!.statusCode).toBe(500);
    expect(detail.attemptsHistory[0]!.resolvedIp).toBe('203.0.113.9');
  });

  it("does not leak another tenant's event", async () => {
    const foreign = await seedEvent(orgB, await seedEndpoint(orgB), 'dead');
    await expect(service.get(org, foreign)).rejects.toBeInstanceOf(WebhookEventNotFoundError);
    expect((await service.list(org, { limit: 100 })).map((e) => e.id)).not.toContain(foreign);
  });
});

describe('reenvío manual auditado', () => {
  it('clones a dead event as a fresh pending one, links it, and audits the action', async () => {
    const dead = await seedEvent(org, endpoint, 'dead');
    const fresh = await service.resend(org, dead, AUDIT);

    expect(fresh.status).toBe('pending');
    expect(fresh.attempts).toBe(0);
    expect(fresh.resentFromEventId).toBe(dead);
    expect(fresh.endpointId).toBe(endpoint);
    expect(fresh.id).not.toBe(dead);

    // El evento muerto permanece muerto (estado terminal inmutable).
    const original = await service.get(org, dead);
    expect(original.status).toBe('dead');

    // El audit event quedó escrito en la misma transacción.
    const audit = await ctx.admin.query<{ action: string; resource_id: string }>(
      `SELECT action, resource_id FROM audit_events
       WHERE tenant_id = $1 AND action = 'webhook_event.resent' AND resource_id = $2`,
      [org, fresh.id]
    );
    expect(audit.rowCount).toBe(1);
  });

  it('refuses to resend a non-dead event', async () => {
    const delivered = await seedEvent(org, endpoint, 'delivered');
    await expect(service.resend(org, delivered, AUDIT)).rejects.toBeInstanceOf(
      WebhookEventNotDeadError
    );
  });

  it('treats an unknown or foreign event as not found', async () => {
    await expect(service.resend(org, randomUUID(), AUDIT)).rejects.toBeInstanceOf(
      WebhookEventNotFoundError
    );
    const foreign = await seedEvent(orgB, await seedEndpoint(orgB), 'dead');
    await expect(service.resend(org, foreign, AUDIT)).rejects.toBeInstanceOf(
      WebhookEventNotFoundError
    );
  });
});
