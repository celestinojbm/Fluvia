/**
 * DRILL · Runbook «Discrepancia de conciliación» (F4-06b)
 *
 * Ensaya el runbook `docs/ops/runbooks/reconciliation-discrepancy.md` de punta a
 * punta contra un stack REAL (Postgres + la API de Fluvia levantada en proceso y
 * conducida SOBRE HTTP), con dos operadores `finance` distintos para ejercer el
 * four-eyes. No es un test unitario: es la rehearsal operativa que exige el
 * criterio de salida de la Fase 4 («runbooks probados en drill»).
 *
 * Flujo (= pasos del runbook):
 *   1. Sembrar una discrepancia `missing_in_ledger` (línea del proveedor sin
 *      intent) → conciliar → el trigger materializa un `operational_case` crítico.
 *   2. Diagnóstico: listar los casos abiertos y localizar el del reporte.
 *   3. U1 (finance) reconoce el caso.
 *   4. U1 propone un ajuste monetario.
 *   5. FOUR-EYES: U1 NO puede aprobar su propio ajuste → 409 four_eyes_required.
 *   6. U2 (finance, distinto) aprueba → asiento + caso resuelto.
 *   7. Verificar: caso resuelto, ajuste `applied` con ledger_transaction_id.
 *   8. Verificar el rastro de auditoría (acknowledged / proposed / applied / resolved).
 *   9. Verificar el balance del asiento del ajuste (débitos == créditos).
 *
 * Uso: `pnpm --filter @fluvia/api run drill:reconciliation` (requiere Postgres
 * migrado; ver `docs/ops/runbooks/README.md` §Drill). Sale 0 en PASS, 1 en FAIL.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';

const PERIOD_START = '2026-06-01T00:00:00Z';
const PERIOD_END = '2026-07-01T00:00:00Z';
const IN_PERIOD = '2026-06-15T12:00:00Z';
const AMOUNT = 9_000; // COP (exponente 0)
const PASSWORD = 'drill four eyes password 77';

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
  const config = loadConfig(); // NODE_ENV=local + *_DATABASE_URL del entorno
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

  const sessionMember = async (
    role: string,
    orgId: string
  ): Promise<{ token: string; userId: string }> => {
    const email = `drill-${randomUUID().slice(0, 12)}@example.com`;
    const reg = await api('POST', '/v1/auth/register', { body: { email, password: PASSWORD } });
    assert(reg.status === 201 || reg.status === 200, `register ${email} (${reg.status})`);
    const { user_id, verification_token } = reg.json;
    await api('POST', '/v1/auth/verify-email', { body: { token: verification_token } });
    await adminPool.query(
      'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
      [orgId, user_id, role]
    );
    const login = await api('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    assert(login.json?.session_token, `login ${email} devolvió sesión`);
    return { token: login.json.session_token as string, userId: user_id as string };
  };

  try {
    // ── Setup: org + API key + dos operadores finance distintos ──────────────
    const orgRes = await adminPool.query<{ id: string }>(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['Drill Org', `drill-${randomUUID()}`]
    );
    const org = orgRes.rows[0]!.id;
    const key = (
      await apiKeyService.create(org, { label: 'drill', scopes: ['payments:write', 'read'] })
    ).secret;
    const u1 = await sessionMember('finance', org);
    const u2 = await sessionMember('finance', org);
    log(`org=${org.slice(0, 8)}… · U1=${u1.userId.slice(0, 8)}… · U2=${u2.userId.slice(0, 8)}…`);

    // ── PASO 1: sembrar discrepancia missing_in_ledger + conciliar ───────────
    const report = (
      await api('POST', '/v1/settlement_reports', {
        token: key,
        body: {
          provider: 'mock',
          currency: 'COP',
          period_start: PERIOD_START,
          period_end: PERIOD_END,
        },
      })
    ).json.id as string;
    const phantomRef = `ph-${randomUUID().slice(0, 8)}`;
    await api('POST', `/v1/settlement_reports/${report}/lines`, {
      token: key,
      body: { lines: [{ provider_ref: phantomRef, amount: AMOUNT, settled_at: IN_PERIOD }] },
    });
    const reconcile = await api('POST', `/v1/settlement_reports/${report}/reconcile`, {
      token: key,
    });
    assert(reconcile.status === 200, `reconcile 200 (fue ${reconcile.status})`);
    assert(reconcile.json.summary?.missing_in_ledger === 1, 'resumen: 1 missing_in_ledger');
    ok('discrepancia sembrada y reporte conciliado (1 missing_in_ledger)');

    // ── PASO 2: diagnóstico — localizar el caso materializado ────────────────
    const cases = await api('GET', '/v1/operational_cases?status=open&limit=200', { token: key });
    const kase = (cases.json.data as any[]).find((c) => c.report_id === report);
    assert(kase, 'se materializó un operational_case para el reporte');
    assert(kase.severity === 'critical', `severidad critical (fue ${kase.severity})`);
    assert(kase.discrepancy_status === 'missing_in_ledger', 'clase missing_in_ledger');
    const caseId = kase.id as string;
    ok(`caso materializado: ${caseId.slice(0, 8)}… severidad=critical clase=missing_in_ledger`);

    // ── PASO 3: U1 reconoce el caso (sesión) ─────────────────────────────────
    const ack = await api(
      'POST',
      `/v1/organizations/${org}/operational_cases/${caseId}/acknowledge`,
      { token: u1.token, body: {} }
    );
    assert(ack.status === 200 && ack.json.status === 'acknowledged', 'caso acknowledged');
    ok('U1 (finance) reconoció el caso');

    // ── PASO 4: U1 propone un ajuste monetario ───────────────────────────────
    const proposed = await api(
      'POST',
      `/v1/organizations/${org}/operational_cases/${caseId}/adjustments`,
      {
        token: u1.token,
        body: {
          amount: AMOUNT,
          currency: 'COP',
          direction: 'debit_differences',
          reason: 'drill: cuadra la diferencia',
        },
      }
    );
    assert(proposed.status === 201, `propuesta 201 (fue ${proposed.status})`);
    assert(proposed.json.requires_second_approval === true, 'requiere segundo aprobador');
    const adjId = proposed.json.id as string;
    ok(`U1 propuso un ajuste (${adjId.slice(0, 8)}…) que requiere four-eyes`);

    // ── PASO 5: FOUR-EYES — U1 no puede aprobar su propio ajuste ──────────────
    const selfApprove = await api(
      'POST',
      `/v1/organizations/${org}/case_adjustments/${adjId}/approve`,
      { token: u1.token }
    );
    assert(selfApprove.status === 409, `auto-aprobación 409 (fue ${selfApprove.status})`);
    assert(selfApprove.json.error?.code === 'four_eyes_required', 'código four_eyes_required');
    ok('FOUR-EYES: U1 auto-aprobó → 409 four_eyes_required (bloqueado correctamente)');

    // ── PASO 6: U2 (distinto) aprueba → asiento + caso resuelto ───────────────
    const applied = await api(
      'POST',
      `/v1/organizations/${org}/case_adjustments/${adjId}/approve`,
      { token: u2.token }
    );
    assert(applied.status === 200 && applied.json.status === 'applied', 'ajuste applied');
    assert(applied.json.ledger_transaction_id, 'ajuste tiene ledger_transaction_id');
    const txId = applied.json.ledger_transaction_id as string;
    ok(`U2 (finance distinto) aprobó → ajuste applied con asiento ${txId.slice(0, 8)}…`);

    // ── PASO 7: verificar la resolución del caso ─────────────────────────────
    const detail = await api('GET', `/v1/organizations/${org}/operational_cases/${caseId}`, {
      token: u2.token,
    });
    assert(detail.json.status === 'resolved', 'caso resuelto');
    assert(
      (detail.json.adjustments as any[])[0]?.status === 'applied',
      'ajuste applied en el detalle'
    );
    ok('caso resuelto; el detalle lista el ajuste applied');

    // ── PASO 8: verificar el rastro de auditoría ─────────────────────────────
    const events = await api('GET', `/v1/organizations/${org}/audit-events?limit=100`, {
      token: u2.token,
    });
    // Al aprobarse el ajuste, la resolución del caso es un UPDATE directo dentro
    // de la misma tx (no emite `operational_case.resolved`; ese evento es exclusivo
    // de la resolución documental). El rastro del four-eyes es ack → proposed → applied.
    const actions = new Set((events.json.audit_events as any[]).map((e) => e.action));
    for (const a of [
      'operational_case.acknowledged',
      'operational_case.adjustment_proposed',
      'operational_case.adjustment_applied',
    ]) {
      assert(actions.has(a), `audit_log contiene ${a}`);
    }
    ok('rastro de auditoría completo (acknowledged → adjustment_proposed → adjustment_applied)');

    // ── PASO 9: verificar el balance del asiento del ajuste ───────────────────
    const balance = await adminPool.query<{ debit: string; credit: string; lines: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='debit'),0)::text AS debit,
              COALESCE(SUM(amount) FILTER (WHERE direction='credit'),0)::text AS credit,
              COUNT(*)::text AS lines
         FROM ledger_entries WHERE tx_root_id = $1`,
      [txId]
    );
    const { debit, credit, lines } = balance.rows[0]!;
    assert(Number(lines) >= 2, `el asiento tiene ≥2 líneas (tiene ${lines})`);
    assert(
      debit === credit && Number(debit) === AMOUNT,
      `débitos==créditos==${AMOUNT} (D=${debit} C=${credit})`
    );
    ok(`asiento del ajuste balanceado: débitos=${debit} == créditos=${credit} (${lines} líneas)`);

    console.log(
      `\n\x1b[32m✅ DRILL PASS\x1b[0m — runbook reconciliation-discrepancy ensayado end-to-end sobre HTTP real (${step} pasos).`
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
