import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { buildEnvelope } from '@fluvia/events';
import {
  WebhookDeliverer,
  WebhookEndpointService,
  createWebhookFanoutPublisher,
  verifyWebhookDelivery,
} from '../src/index.js';

/**
 * F3-07 — cadena completa contra PG real y un receptor HTTP real:
 * fan-out (rol relay) -> claim-lease (rol webhook) -> POST firmado con
 * pinning -> attempt log -> reintentos/dead segun el calendario.
 */

let ctx: TestContext;
let service: WebhookEndpointService;
let deliverer: WebhookDeliverer;
let org: string;
let orgB: string;
let server: Server;
let baseUrl: string;

interface Received {
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
const received: Received[] = [];
let respondWith = 200;

beforeAll(async () => {
  ctx = await createTestContext();
  org = await ctx.createTenant(`WH ${randomUUID().slice(0, 8)}`);
  orgB = await ctx.createTenant(`WH-B ${randomUUID().slice(0, 8)}`);
  service = new WebhookEndpointService(ctx.app, { allowPrivateNetworks: true });
  deliverer = new WebhookDeliverer(ctx.webhook, {
    ssrf: { allowPrivateNetworks: true },
    requestTimeoutMs: 2000,
  });

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(respondWith).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.close();
});

function envelopeFor(_topic: string) {
  return buildEnvelope({
    producer: 'fluvia.payments',
    resource: { type: 'payment_intent', id: randomUUID() },
    data: { hello: 'merchant' },
  });
}

async function fanout(tenantId: string, topic: string) {
  const publisher = createWebhookFanoutPublisher(ctx.relay);
  await publisher.publish({
    id: '1',
    tenantId,
    topic,
    envelope: envelopeFor(topic),
    attempt: 1,
  });
}

describe('fan-out (rol relay, ventanas 0019)', () => {
  it('materializes queue rows ONLY for active, subscribed endpoints of THAT tenant', async () => {
    // Cada endpoint del archivo se suscribe a topics DISJUNTOS: el fan-out
    // de un test jamas encola trabajo para los endpoints de otro.
    const all = await service.create(org, { url: `${baseUrl}/all`, events: ['merchant.updated'] });
    const filtered = await service.create(org, {
      url: `${baseUrl}/filtered`,
      events: ['refund.failed'],
    });
    const disabled = await service.create(org, {
      url: `${baseUrl}/disabled`,
      events: ['merchant.updated'],
    });
    await service.disable(org, disabled.id);
    const foreign = await service.create(orgB, { url: `${baseUrl}/foreign` });

    await fanout(org, 'merchant.updated');

    const rows = await ctx.admin.query<{ endpoint_id: string }>(
      `SELECT endpoint_id FROM webhook_events WHERE tenant_id = $1`,
      [org]
    );
    const ids = rows.rows.map((r) => r.endpoint_id);
    expect(ids).toContain(all.id);
    expect(ids).not.toContain(filtered.id); // suscrito a otro topic
    expect(ids).not.toContain(disabled.id);
    const foreignRows = await ctx.admin.query(
      `SELECT 1 FROM webhook_events WHERE endpoint_id = $1`,
      [foreign.id]
    );
    expect(foreignRows.rowCount).toBe(0);

    // Topics internos (no publicos) no generan webhooks.
    await fanout(org, 'ledger.transaction.posted');
    const internal = await ctx.admin.query(
      `SELECT 1 FROM webhook_events WHERE tenant_id = $1 AND topic = 'ledger.transaction.posted'`,
      [org]
    );
    expect(internal.rowCount).toBe(0);
  });
});

describe('entrega (rol webhook)', () => {
  it('delivers with a verifiable signature, records the attempt with the pinned IP', async () => {
    received.length = 0;
    respondWith = 200;
    const endpoint = await service.create(org, {
      url: `${baseUrl}/ok`,
      events: ['payment_intent.succeeded'],
    });
    await fanout(org, 'payment_intent.succeeded');

    const stats = await deliverer.runOnce();
    expect(stats.delivered).toBeGreaterThanOrEqual(1);

    const hit = received.find((r) => r.url === '/ok');
    expect(hit).toBeTruthy();
    // La firma verifica con el secreto entregado UNA vez al crear.
    expect(
      verifyWebhookDelivery({
        secret: endpoint.secret,
        signatureHeader: String(hit!.headers['fluvia-signature']),
        timestampSec: Number(hit!.headers['fluvia-timestamp']),
        eventId: String(hit!.headers['fluvia-event-id']),
        rawBody: hit!.body,
      })
    ).toBe(true);

    const row = await ctx.admin.query<{ status: string }>(
      `SELECT status FROM webhook_events WHERE endpoint_id = $1`,
      [endpoint.id]
    );
    expect(row.rows[0]!.status).toBe('delivered');
    const attempt = await ctx.admin.query<{ status_code: number; resolved_ip: string }>(
      `SELECT status_code, resolved_ip FROM webhook_attempts a
       JOIN webhook_events w ON w.id = a.webhook_event_id
       WHERE w.endpoint_id = $1`,
      [endpoint.id]
    );
    expect(attempt.rows[0]!.status_code).toBe(200);
    expect(attempt.rows[0]!.resolved_ip).toBe('127.0.0.1');
  });

  it('rotation: deliveries carry BOTH signatures during the grace window', async () => {
    received.length = 0;
    respondWith = 200;
    const endpoint = await service.create(org, {
      url: `${baseUrl}/rotate`,
      events: ['payment_intent.processing'],
    });
    const rotated = await service.rotateSecret(org, endpoint.id);
    expect(rotated.secret).not.toBe(endpoint.secret);

    await fanout(org, 'payment_intent.processing');
    await deliverer.runOnce();
    const hit = received.find((r) => r.url === '/rotate');
    expect(hit).toBeTruthy();
    const header = String(hit!.headers['fluvia-signature']);
    expect(header.split(',')).toHaveLength(2);
    for (const secret of [endpoint.secret, rotated.secret]) {
      expect(
        verifyWebhookDelivery({
          secret,
          signatureHeader: header,
          timestampSec: Number(hit!.headers['fluvia-timestamp']),
          eventId: String(hit!.headers['fluvia-event-id']),
          rawBody: hit!.body,
        })
      ).toBe(true);
    }
  });

  it('non-2xx schedules a retry per the contract; exhausted attempts go dead', async () => {
    respondWith = 500;
    const endpoint = await service.create(org, {
      url: `${baseUrl}/failing`,
      events: ['payment_intent.failed'],
    });
    await fanout(org, 'payment_intent.failed');

    const stats = await deliverer.runOnce();
    expect(stats.retried).toBeGreaterThanOrEqual(1);
    const row = await ctx.admin.query<{ status: string; next_attempt_at: Date; attempts: number }>(
      `SELECT status, next_attempt_at, attempts FROM webhook_events WHERE endpoint_id = $1`,
      [endpoint.id]
    );
    expect(row.rows[0]!.status).toBe('pending');
    expect(row.rows[0]!.attempts).toBe(1);
    // 30 s del calendario (con margen).
    expect(row.rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 20_000);

    // Agotamiento: attempts al borde + elegible ya => dead.
    await ctx.admin.query(
      `UPDATE webhook_events SET attempts = 6, next_attempt_at = now() WHERE endpoint_id = $1`,
      [endpoint.id]
    );
    const finalStats = await deliverer.runOnce();
    expect(finalStats.dead).toBeGreaterThanOrEqual(1);
    const dead = await ctx.admin.query<{ status: string }>(
      `SELECT status FROM webhook_events WHERE endpoint_id = $1`,
      [endpoint.id]
    );
    expect(dead.rows[0]!.status).toBe('dead');
    respondWith = 200;
  });

  it('a disabled endpoint kills its pending queue WITHOUT network attempts', async () => {
    received.length = 0;
    const endpoint = await service.create(org, {
      url: `${baseUrl}/late-disable`,
      events: ['payment_intent.canceled'],
    });
    await fanout(org, 'payment_intent.canceled');
    await service.disable(org, endpoint.id);

    await deliverer.runOnce();
    const row = await ctx.admin.query<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM webhook_events WHERE endpoint_id = $1`,
      [endpoint.id]
    );
    expect(row.rows[0]!.status).toBe('dead');
    expect(row.rows[0]!.last_error).toContain('disabled');
    // Cero trafico de red hacia el endpoint deshabilitado.
    expect(received.filter((r) => r.url === '/late-disable')).toHaveLength(0);
  });

  it('SSRF: a queue row pointing at a private address never gets a request (strict mode)', async () => {
    const strict = new WebhookDeliverer(ctx.webhook, { requestTimeoutMs: 1000 });
    received.length = 0;
    const endpoint = await service.create(org, {
      url: `${baseUrl}/ssrf-block`,
      events: ['refund.created'],
    });
    await fanout(org, 'refund.created');

    const stats = await strict.runOnce();
    expect(stats.retried + stats.dead).toBeGreaterThanOrEqual(1);
    expect(received.filter((r) => r.url === '/ssrf-block')).toHaveLength(0);
    const attempt = await ctx.admin.query<{ error: string }>(
      `SELECT a.error FROM webhook_attempts a
       JOIN webhook_events w ON w.id = a.webhook_event_id
       WHERE w.endpoint_id = $1 ORDER BY a.id DESC LIMIT 1`,
      [endpoint.id]
    );
    expect(attempt.rows[0]!.error).toMatch(/https required|non-public/);
  });
});
