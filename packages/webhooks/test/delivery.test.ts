import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// RA-F65B-003: en estos tests de runtime la mutación se declara NO auditada
// explícitamente (el contrato ya no admite omitir el modo de auditoría).
const UNAUDITED = { audit: false } as const;
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
  // Cuarentena de residuos: la BD local acumula webhook_events `pending`
  // elegibles de corridas anteriores (p.ej. los seeds de webhook-events.test);
  // el claim del deliverer es global (LIMIT + ORDER BY next_attempt_at), asi
  // que esos residuos compiten con los eventos de ESTA corrida y hacen flaky
  // la suite. Se empujan fuera de la ventana (no se borran: append-only).
  await ctx.admin.query(
    `UPDATE webhook_events SET next_attempt_at = now() + interval '1 hour'
     WHERE status = 'pending' AND next_attempt_at <= now()`
  );
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
    const all = await service.create(
      org,
      { url: `${baseUrl}/all`, events: ['merchant.updated'] },
      UNAUDITED
    );
    const filtered = await service.create(
      org,
      {
        url: `${baseUrl}/filtered`,
        events: ['refund.failed'],
      },
      UNAUDITED
    );
    const disabled = await service.create(
      org,
      {
        url: `${baseUrl}/disabled`,
        events: ['merchant.updated'],
      },
      UNAUDITED
    );
    await service.disable(org, disabled.id, UNAUDITED);
    const foreign = await service.create(orgB, { url: `${baseUrl}/foreign` }, UNAUDITED);

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

  it('graduates payout.* and dispute.* to deliverable topics (F4-09)', async () => {
    // Suscribirse a los topics de dinero PRUEBA que el catalogo los acepta
    // (createEndpoint valida cada topic; un topic desconocido -> error).
    const money = await service.create(
      org,
      {
        url: `${baseUrl}/money`,
        events: ['payout.paid', 'dispute.won'],
      },
      UNAUDITED
    );
    // Antes de F4-09 estos eventos del outbox no generaban fan-out alguno.
    await fanout(org, 'payout.paid');
    await fanout(org, 'dispute.won');

    const rows = await ctx.admin.query<{ topic: string }>(
      `SELECT topic FROM webhook_events WHERE endpoint_id = $1 ORDER BY topic`,
      [money.id]
    );
    expect(rows.rows.map((r) => r.topic)).toEqual(['dispute.won', 'payout.paid']);
  });
});

describe('entrega (rol webhook)', () => {
  it('delivers with a verifiable signature, records the attempt with the pinned IP', async () => {
    received.length = 0;
    respondWith = 200;
    const endpoint = await service.create(
      org,
      {
        url: `${baseUrl}/ok`,
        events: ['payment_intent.succeeded'],
      },
      UNAUDITED
    );
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

    // F6 (revisión de seguridad): el `Fluvia-Event-Id` es el event_id ESTABLE del
    // sobre (no el PK de la fila) — así, si el relay at-least-once re-materializa la
    // fila tras un crash, ambas entregas llevan el MISMO id y el comercio deduplica.
    const stored = await ctx.admin.query<{ payload: { event_id: string } }>(
      `SELECT payload FROM webhook_events WHERE endpoint_id = $1`,
      [endpoint.id]
    );
    expect(hit!.headers['fluvia-event-id']).toBe(stored.rows[0]!.payload.event_id);

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
    const endpoint = await service.create(
      org,
      {
        url: `${baseUrl}/rotate`,
        events: ['payment_intent.processing'],
      },
      UNAUDITED
    );
    const rotated = await service.rotateSecret(org, endpoint.id, UNAUDITED);
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
    const endpoint = await service.create(
      org,
      {
        url: `${baseUrl}/failing`,
        events: ['payment_intent.failed'],
      },
      UNAUDITED
    );
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
    const endpoint = await service.create(
      org,
      {
        url: `${baseUrl}/late-disable`,
        events: ['payment_intent.canceled'],
      },
      UNAUDITED
    );
    await fanout(org, 'payment_intent.canceled');
    await service.disable(org, endpoint.id, UNAUDITED);

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
    const endpoint = await service.create(
      org,
      {
        url: `${baseUrl}/ssrf-block`,
        events: ['refund.created'],
      },
      UNAUDITED
    );
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

describe('failover de conexion entre IPs validadas (V2-N2)', () => {
  it('a refused first IP fails over to the next validated one WITHIN the same attempt', async () => {
    received.length = 0;
    respondWith = 200;
    const port = (server.address() as AddressInfo).port;
    // Resolucion inyectada (determinista): la primera IP no tiene listener en
    // ese puerto (loopback => ECONNREFUSED inmediato); la segunda es el
    // receptor real. Ambas ya pasaron la denylist — el failover jamas
    // re-resuelve (eso reabriria la ventana de DNS-rebinding).
    const failover = new WebhookDeliverer(ctx.webhook, {
      requestTimeoutMs: 2000,
      ssrf: {
        allowPrivateNetworks: true,
        resolve: async () => ['127.0.0.99', '127.0.0.1'],
      },
    });
    const endpoint = await service.create(
      org,
      {
        url: `http://failover.fluvia.test:${port}/failover`,
        events: ['payout.in_transit'],
      },
      UNAUDITED
    );
    await fanout(org, 'payout.in_transit');

    const stats = await failover.runOnce();
    expect(stats.delivered).toBeGreaterThanOrEqual(1);
    expect(received.filter((r) => r.url === '/failover')).toHaveLength(1);
    const attempt = await ctx.admin.query<{ status_code: number; resolved_ip: string }>(
      `SELECT a.status_code, a.resolved_ip FROM webhook_attempts a
       JOIN webhook_events w ON w.id = a.webhook_event_id
       WHERE w.endpoint_id = $1`,
      [endpoint.id]
    );
    // El attempt registra la IP que REALMENTE contesto, no la primera resuelta.
    expect(attempt.rows[0]!.status_code).toBe(200);
    expect(attempt.rows[0]!.resolved_ip).toBe('127.0.0.1');
  });

  it('an HTTP response (even 5xx) does NOT fail over: the destination already spoke', async () => {
    // Receptor propio en 0.0.0.0 y DOS IPs DISTINTAS que lo alcanzan: si el
    // 500 disparara failover, el conteo mostraria DOS requests en un solo
    // intento (con IPs identicas, un dedupe accidental lo ocultaria).
    let hits = 0;
    const wideServer = createServer((_req, res) => {
      hits += 1;
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) => wideServer.listen(0, '0.0.0.0', resolve));
    try {
      const port = (wideServer.address() as AddressInfo).port;
      const failover = new WebhookDeliverer(ctx.webhook, {
        requestTimeoutMs: 2000,
        ssrf: {
          allowPrivateNetworks: true,
          resolve: async () => ['127.0.0.1', '127.0.0.2'],
        },
      });
      const endpoint = await service.create(
        org,
        {
          url: `http://no-failover.fluvia.test:${port}/no-failover`,
          events: ['refund.processing'],
        },
        UNAUDITED
      );
      await fanout(org, 'refund.processing');

      const stats = await failover.runOnce();
      expect(stats.retried).toBeGreaterThanOrEqual(1);
      expect(hits).toBe(1);
      const row = await ctx.admin.query<{ status: string; last_error: string }>(
        `SELECT status, last_error FROM webhook_events WHERE endpoint_id = $1`,
        [endpoint.id]
      );
      expect(row.rows[0]!.status).toBe('pending'); // reintento por calendario, no por IP
      expect(row.rows[0]!.last_error).toContain('non-2xx');
    } finally {
      await new Promise<void>((resolve) => wideServer.close(() => resolve()));
    }
  });

  it('a connected-but-silent destination does NOT fail over (the payload may have arrived)', async () => {
    // El socket CONECTA y recibe el body, pero el servidor jamas responde:
    // el timeout NO debe re-enviar el mismo intento firmado a otra IP — eso
    // seria doble entrega dentro de un intento. Reintento = calendario.
    let hits = 0;
    const silentServer = createServer((req) => {
      req.resume(); // consume el body y calla (jamas responde)
      hits += 1;
    });
    await new Promise<void>((resolve) => silentServer.listen(0, '0.0.0.0', resolve));
    try {
      const port = (silentServer.address() as AddressInfo).port;
      const failover = new WebhookDeliverer(ctx.webhook, {
        requestTimeoutMs: 500,
        ssrf: {
          allowPrivateNetworks: true,
          resolve: async () => ['127.0.0.1', '127.0.0.2'],
        },
      });
      const endpoint = await service.create(
        org,
        {
          url: `http://silent.fluvia.test:${port}/silent`,
          events: ['payout.requested'],
        },
        UNAUDITED
      );
      await fanout(org, 'payout.requested');

      const stats = await failover.runOnce();
      expect(stats.retried).toBeGreaterThanOrEqual(1);
      expect(hits).toBe(1); // UNA sola entrega del payload, no una por IP
      const row = await ctx.admin.query<{ status: string; last_error: string }>(
        `SELECT status, last_error FROM webhook_events WHERE endpoint_id = $1`,
        [endpoint.id]
      );
      expect(row.rows[0]!.status).toBe('pending');
      expect(row.rows[0]!.last_error).toContain('timed out');
    } finally {
      await new Promise<void>((resolve) => silentServer.close(() => resolve()));
    }
  });
});

describe('TLS del deliverer: rejectUnauthorized explicito (threat model §5)', () => {
  let tlsServer: TlsServer;
  let tlsUrl: string;
  let tlsHits = 0;
  let available = false;

  beforeAll(async () => {
    // Certificado self-signed generado AL VUELO (nada de claves en el repo;
    // gitleaks quedaria justificadamente furioso). Sin openssl se salta — la
    // ejecucion definitiva es CI (ubuntu trae openssl), como el restore drill.
    let key: string;
    let cert: string;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'fluvia-tls-'));
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          join(dir, 'key.pem'),
          '-out',
          join(dir, 'cert.pem'),
          '-days',
          '1',
          '-subj',
          '/CN=127.0.0.1',
        ],
        { stdio: 'ignore' }
      );
      key = readFileSync(join(dir, 'key.pem'), 'utf8');
      cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    } catch (err) {
      // En CI el skip seria una perdida SILENCIOSA de cobertura de seguridad:
      // alli openssl es obligatorio y cualquier fallo debe romper el build.
      if (process.env.CI) throw err;
      return;
    }
    available = true;
    tlsServer = createTlsServer({ key, cert }, (_req, res) => {
      tlsHits += 1;
      res.writeHead(200).end();
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    tlsUrl = `https://127.0.0.1:${(tlsServer.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    if (available) await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  });

  it('a receiver with an untrusted cert NEVER gets the signed payload', async (ctx2) => {
    if (!available) return ctx2.skip();
    const endpoint = await service.create(
      org,
      {
        url: `${tlsUrl}/tls-selfsigned`,
        events: ['refund.succeeded'],
      },
      UNAUDITED
    );
    await fanout(org, 'refund.succeeded');

    // NODE_TLS_REJECT_UNAUTHORIZED=0 es el footgun clasico de "arreglar" TLS
    // en un worker: el rejectUnauthorized EXPLICITO del deliverer debe ganar.
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    let stats;
    try {
      stats = await deliverer.runOnce();
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }

    expect(stats.retried + stats.dead).toBeGreaterThanOrEqual(1);
    // El handshake fallo ANTES de cualquier byte de aplicacion: el receptor
    // hostil jamas vio el payload firmado.
    expect(tlsHits).toBe(0);
    const attempt = await ctx.admin.query<{ error: string; status_code: number | null }>(
      `SELECT a.error, a.status_code FROM webhook_attempts a
       JOIN webhook_events w ON w.id = a.webhook_event_id
       WHERE w.endpoint_id = $1 ORDER BY a.id DESC LIMIT 1`,
      [endpoint.id]
    );
    expect(attempt.rows[0]!.status_code).toBeNull();
    expect(attempt.rows[0]!.error).toMatch(/self[- ]signed certificate/i);
  });
});
