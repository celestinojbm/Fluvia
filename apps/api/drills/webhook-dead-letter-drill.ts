/**
 * DRILL · Runbook «Webhook saliente en `dead`» (F4-06b)
 *
 * Ensaya el runbook `docs/ops/runbooks/webhook-dead-letter.md` de punta a punta
 * contra un stack REAL (Postgres + la API de Fluvia levantada en proceso y
 * conducida SOBRE HTTP para la acción del operador). No es un test unitario: es
 * la rehearsal operativa que exige el criterio de salida de la Fase 4.
 *
 * Un webhook saliente que agotó su calendario de reintentos queda `dead`
 * (terminal, inmutable). La única acción de escritura del plano de operación de
 * webhooks es REENVIAR desde el panel (F3-09b-iii): NO resucita el evento muerto
 * (estado terminal), lo CLONA como un `pending` fresco enlazado por
 * `resent_from_event_id`, auditado como `webhook_event.resent`. El drill cruza:
 *   - GATE RBAC: un rol sin `webhooks:manage` (read_only) → 403.
 *   - El reenvío por SESIÓN (owner/admin/developer) → 201 con un `pending` fresco.
 *   - El evento `dead` sigue terminal (no se resucita).
 *   - Rastro de auditoría `webhook_event.resent`.
 *   - Reenviar un evento NO-dead → 409 (invalid_state_transition).
 *
 * Uso: `pnpm --filter @fluvia/api run drill:webhook-dead-letter` (requiere
 * Postgres migrado; ver `docs/ops/runbooks/README.md` §Drill). Sale 0/1.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

const PASSWORD = 'drill webhook password 77';

let step = 0;
const log = (msg: string): void => console.log(`  ${msg}`);
function ok(msg: string): void {
  console.log(`\x1b[32m✓\x1b[0m PASO ${++step}: ${msg}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FALLÓ: ${msg}`);
}

interface ApiResult {
  status: number;
  json: any;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const appPool = createPool({ connectionString: config.db.app, max: 6 });
  const authPool = createPool({ connectionString: config.db.auth, max: 4 });
  const adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  const apiKeyService = new ApiKeyService(appPool, { hmacSecretHex: config.apiKeyHmacSecret });

  const app = buildApp({
    config,
    appPool,
    authService: new AuthService(authPool, { mfaEncryptionKeyHex: config.mfaSecretKey }),
    identityService: new IdentityService(appPool),
    apiKeyService,
    authRateLimits: {
      loginPerEmail: { max: 10_000, windowMs: 60_000 },
      loginPerIp: { max: 10_000, windowMs: 60_000 },
      registerPerIp: { max: 10_000, windowMs: 60_000 },
      mfaPerIp: { max: 10_000, windowMs: 60_000 },
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  log(`API real escuchando en ${base}`);

  const api = async (
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {}
  ): Promise<ApiResult> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  const sessionMember = async (role: string, orgId: string): Promise<{ token: string }> => {
    const email = `drill-${randomUUID().slice(0, 12)}@example.com`;
    const reg = await api('POST', '/v1/auth/register', { body: { email, password: PASSWORD } });
    assert(reg.status === 201 || reg.status === 200, `register ${email} (${reg.status})`);
    await api('POST', '/v1/auth/verify-email', { body: { token: reg.json.verification_token } });
    await adminPool.query(
      'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
      [orgId, reg.json.user_id, role]
    );
    const login = await api('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    assert(login.json?.session_token, `login ${email} devolvió sesión`);
    return { token: login.json.session_token as string };
  };

  /** Siembra un endpoint + un evento en el estado dado (dead usa el patrón real). */
  const seedEvent = async (org: string, status: 'dead' | 'delivered'): Promise<string> => {
    const ep = (
      await adminPool.query<{ id: string }>(
        `INSERT INTO webhook_endpoints (tenant_id, url, secret_enc, events)
         VALUES ($1, 'https://example.test/hook', 'enc:dummy', '{}') RETURNING id`,
        [org]
      )
    ).rows[0]!.id;
    const ev = (
      await adminPool.query<{ id: string }>(
        `INSERT INTO webhook_events (tenant_id, endpoint_id, topic, payload, status, attempts, last_error)
         VALUES ($1, $2, 'merchant.updated', $3, $4, $5, $6) RETURNING id`,
        [
          org,
          ep,
          JSON.stringify({ event_id: `evt_${randomUUID()}` }),
          status,
          status === 'dead' ? 7 : 0,
          status === 'dead' ? 'non-2xx response: 500' : null,
        ]
      )
    ).rows[0]!.id;
    return ev;
  };

  try {
    const org = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        ['Webhook Dead-Letter Drill Org', `drill-${randomUUID()}`]
      )
    ).rows[0]!.id;
    const admin = await sessionMember('admin', org); // tiene webhooks:manage
    const ro = await sessionMember('read_only', org); // NO lo tiene
    const dead = await seedEvent(org, 'dead');
    log(`org=${org.slice(0, 8)}… · dead=${dead.slice(0, 8)}…`);

    // ── PASO 1: GATE RBAC — read_only no puede reenviar ───────────────────────
    const roResp = await api('POST', `/v1/organizations/${org}/webhook_events/${dead}/resend`, {
      token: ro.token,
    });
    assert(roResp.status === 403, `read_only reenvía → 403 (fue ${roResp.status})`);
    ok('read_only sin `webhooks:manage` → 403 al reenviar (gate RBAC correcto)');

    // ── PASO 2: reenvío por sesión → 201 con un `pending` fresco ──────────────
    const resend = await api('POST', `/v1/organizations/${org}/webhook_events/${dead}/resend`, {
      token: admin.token,
    });
    assert(resend.status === 201, `reenvío → 201 (fue ${resend.status})`);
    assert(resend.json.status === 'pending', 'el clon nace pending');
    assert(
      resend.json.resent_from_event_id === dead,
      'el clon enlaza al dead por resent_from_event_id'
    );
    const freshId = resend.json.id as string;
    ok('admin reenvió por sesión → 201: un `pending` fresco enlazado al dead (no lo resucita)');

    // ── PASO 3: el evento `dead` sigue terminal (inmutable) ───────────────────
    const stillDead = await adminPool.query<{ status: string }>(
      `SELECT status FROM webhook_events WHERE id=$1`,
      [dead]
    );
    assert(
      stillDead.rows[0]!.status === 'dead',
      'el evento original sigue dead (estado terminal inmutable)'
    );
    ok('el evento `dead` sigue terminal: el reenvío CLONA, no resucita');

    // ── PASO 4: rastro de auditoría `webhook_event.resent` ────────────────────
    const audit = await adminPool.query(
      `SELECT 1 FROM audit_events
        WHERE tenant_id=$1 AND action='webhook_event.resent' AND resource_id=$2`,
      [org, freshId]
    );
    assert(audit.rowCount === 1, '1 fila de auditoría webhook_event.resent (sobre el id fresco)');
    ok('`webhook_event.resent` auditado (actor usuario, sobre el evento fresco)');

    // ── PASO 5: reenviar un evento NO-dead → 409 ──────────────────────────────
    const delivered = await seedEvent(org, 'delivered');
    const badResend = await api(
      'POST',
      `/v1/organizations/${org}/webhook_events/${delivered}/resend`,
      {
        token: admin.token,
      }
    );
    assert(badResend.status === 409, `reenviar un no-dead → 409 (fue ${badResend.status})`);
    assert(
      badResend.json.error?.code === 'invalid_state_transition',
      `código invalid_state_transition (fue ${badResend.json.error?.code})`
    );
    ok('reenviar un evento NO-dead → 409 invalid_state_transition (solo los dead se reenvían)');

    console.log(
      `\n\x1b[32m✅ DRILL PASS\x1b[0m — runbook webhook-dead-letter ensayado end-to-end (reenvío auditado sobre HTTP real) (${step} pasos).`
    );
    await app.close();
    await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
    process.exit(0);
  } catch (err) {
    console.error(`\n\x1b[31m❌ DRILL FAIL\x1b[0m en el paso ${step + 1}:`, (err as Error).message);
    await app.close().catch(() => {});
    await Promise.all([appPool.end(), authPool.end(), adminPool.end()]).catch(() => {});
    process.exit(1);
  }
}

void main();
