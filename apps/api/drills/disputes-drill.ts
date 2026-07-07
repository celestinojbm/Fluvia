/**
 * DRILL · Runbook «Disputa viva envejecida» (F4-06b)
 *
 * Ensaya el runbook `docs/ops/runbooks/aged-disputes.md` de punta a punta contra
 * un stack REAL (Postgres + la API de Fluvia levantada en proceso y conducida
 * SOBRE HTTP para la acción del operador). No es un test unitario: es la
 * rehearsal operativa que exige el criterio de salida de la Fase 4 («runbooks
 * probados en drill»).
 *
 * El ciclo de una disputa cruza tres planos y el drill los recorre TODOS con sus
 * garantías de Nivel A:
 *   - Banco (FUENTE VERIFICADA): abre y resuelve. Aquí se representa por el
 *     `DisputeService` (`openFromProvider`/`resolve`) — exactamente lo que llama
 *     el handler del webbook firmado del banco (F4-08c); la ingesta HTTP→inbox en
 *     sí la cubre `webhook-ingest.test.ts`.
 *   - Worker (SALUD): `sweep_disputes()` (F4-10) marca envejecidas SIN
 *     transicionar — el watchdog jamás resuelve por asunción.
 *   - Operador (HUMANO): RESPONDE con evidencia por SESIÓN sobre HTTP (F4-08e),
 *     con el gate RBAC `reconciliation:manage`.
 *
 * Flujo (= pasos del runbook):
 *   1. El banco ABRE la disputa (idempotente: el inbox es at-least-once) → aparta
 *      el monto disputado del disponible del comercio (merchant.available →
 *      dispute.reserve).
 *   2. Envejecer > umbral (7 días) → `sweep_disputes()` marca `held_aged` (alerta
 *      ALTA `fluvia_disputes_aged > 0`).
 *   3. NIVEL A: el watchdog NO transiciona — la disputa sigue `open` (sin cierres
 *      por asunción, V4 §23).
 *   4. GATE RBAC: un rol sin `reconciliation:manage` (read_only) → 403 al responder.
 *   5. El operador (finance) RESPONDE con evidencia por sesión: `open →
 *      under_review` (idempotente); los fondos siguen apartados.
 *   6. El banco entrega `dispute.won` → `dispute.reserve → merchant.available`:
 *      los fondos vuelven ÍNTEGROS; el asiento balancea; idempotente.
 *   7. Una segunda disputa `dispute.lost` → `dispute.reserve → provider.clearing`:
 *      los fondos se forfeitan; el asiento balancea.
 *
 * Uso: `pnpm --filter @fluvia/api run drill:disputes` (requiere Postgres migrado;
 * ver `docs/ops/runbooks/README.md` §Drill). Sale 0 en PASS, 1 en FAIL.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { accountName, LedgerService, PostingService, type AccountCode } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { DisputeService } from '@fluvia/payments-core';
import { buildApp } from '../src/app.js';

const CURRENCY = 'COP'; // exponente 0
const SEED = 100_000; // disponible sembrado que funda los apartes
const AMOUNT = 30_000; // disputa principal (won)
const AMOUNT_LOST = 20_000; // segunda disputa (lost)
const AGED_DAYS = 10; // > 7 días: past-threshold
const PASSWORD = 'drill disputes password 77';

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
  const workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  const apiKeyService = new ApiKeyService(appPool, { hmacSecretHex: config.apiKeyHmacSecret });
  const posting = new PostingService(new LedgerService(appPool), appPool);
  const disputes = new DisputeService(appPool, posting);

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

  /** Saldo (unidades menores) de una cuenta del merchant vía la proyección. */
  const balanceMinor = async (
    org: string,
    code: AccountCode,
    merchant: string
  ): Promise<number> => {
    const res = await adminPool.query<{ v: string }>(
      `SELECT COALESCE(bp.available, 0)::text AS v
         FROM ledger_accounts la
         JOIN balance_projections bp ON bp.account_id = la.id
        WHERE la.tenant_id = $1 AND la.name = $2 AND la.currency = $3 AND la.deleted_at IS NULL`,
      [org, accountName(code, merchant), CURRENCY]
    );
    return Number(res.rows[0]?.v ?? '0');
  };

  /** El banco abre una disputa (fuente verificada). */
  const openFromBank = async (
    org: string,
    merchant: string,
    amount: number
  ): Promise<{ id: string; created: boolean; providerRef: string }> => {
    const providerRef = `bank_dp_${randomUUID().slice(0, 8)}`;
    const { dispute, created } = await disputes.openFromProvider(org, {
      merchantId: merchant,
      amount: BigInt(amount),
      currency: CURRENCY,
      reason: 'fraudulent',
      provider: 'mock',
      providerRef,
    });
    return { id: dispute.id, created, providerRef };
  };

  /** Suma de líneas del asiento de una disputa (open + desenlace): debe balancear. */
  const disputePostingBalance = async (
    org: string,
    disputeId: string
  ): Promise<{ debit: number; credit: number; lines: number }> => {
    const res = await adminPool.query<{ debit: string; credit: string; lines: string }>(
      `SELECT COALESCE(SUM(e.amount) FILTER (WHERE e.direction='debit'),0)::text  AS debit,
              COALESCE(SUM(e.amount) FILTER (WHERE e.direction='credit'),0)::text AS credit,
              COUNT(*)::text AS lines
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.tx_root_id
        WHERE t.tenant_id = $1 AND t.idempotency_key LIKE $2`,
      [org, `dispute:${disputeId}:%`]
    );
    const r = res.rows[0]!;
    return { debit: Number(r.debit), credit: Number(r.credit), lines: Number(r.lines) };
  };

  try {
    // ── Setup: org + merchant + operadores + disponible sembrado ──────────────
    const org = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        ['Disputes Drill Org', `drill-${randomUUID()}`]
      )
    ).rows[0]!.id;
    const merchant = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
        [org, `drill-shop-${randomUUID().slice(0, 8)}`]
      )
    ).rows[0]!.id;
    const fin = await sessionMember('finance', org); // puede responder (reconciliation:manage)
    const ro = await sessionMember('read_only', org); // NO puede (solo payments:read)
    // Disponible del comercio (captura + liberación): funda el aparte de la disputa.
    const seedSrc = randomUUID();
    const seedMoney = Money.of(SEED, CURRENCY);
    await posting.capturePayment({
      tenantId: org,
      merchantId: merchant,
      idempotencyKey: `cap:${seedSrc}`,
      sourceType: 'payment_attempt',
      sourceId: seedSrc,
      amount: seedMoney,
    });
    await posting.releaseSettlement({
      tenantId: org,
      merchantId: merchant,
      idempotencyKey: `settle:${seedSrc}`,
      sourceType: 'settlement',
      sourceId: seedSrc,
      amount: seedMoney,
    });
    assert(
      (await balanceMinor(org, 'merchant.available', merchant)) === SEED,
      `disponible sembrado == ${SEED}`
    );
    log(
      `org=${org.slice(0, 8)}… · merchant=${merchant.slice(0, 8)}… · fin=${fin.userId.slice(0, 8)}… · ro=${ro.userId.slice(0, 8)}… · disponible=${SEED}`
    );

    // ── PASO 1: el banco ABRE la disputa (idempotente) + aparta fondos ────────
    const opened = await openFromBank(org, merchant, AMOUNT);
    assert(opened.created === true, 'apertura nueva (created=true)');
    // Re-entrega del MISMO evento (inbox at-least-once): jamás doble-abre.
    const reopened = await disputes.openFromProvider(org, {
      merchantId: merchant,
      amount: BigInt(AMOUNT),
      currency: CURRENCY,
      provider: 'mock',
      providerRef: opened.providerRef,
    });
    assert(
      reopened.created === false && reopened.dispute.id === opened.id,
      'reingesta del mismo provider_ref es idempotente (no doble-hold)'
    );
    assert(
      (await balanceMinor(org, 'merchant.available', merchant)) === SEED - AMOUNT,
      `merchant.available bajó a ${SEED - AMOUNT}`
    );
    assert(
      (await balanceMinor(org, 'dispute.reserve', merchant)) === AMOUNT,
      `dispute.reserve retiene ${AMOUNT}`
    );
    ok(
      `el banco abrió la disputa ${opened.id.slice(0, 8)}… (idempotente) y apartó ${AMOUNT} en dispute.reserve`
    );

    // ── PASO 2: envejecer > umbral → sweep_disputes marca la alerta ───────────
    await adminPool.query(
      `UPDATE disputes SET created_at = now() - make_interval(days => $2) WHERE id = $1`,
      [opened.id, AGED_DAYS]
    );
    const sweep = await workerPool.query<{ metric: string; value: string }>(
      `SELECT metric, value::text AS value FROM sweep_disputes()`
    );
    const health = Object.fromEntries(sweep.rows.map((r) => [r.metric, Number(r.value)]));
    assert(health.held_total >= 1, `held_total >= 1 (fue ${health.held_total})`);
    assert(health.held_aged >= 1, `held_aged >= 1 → alerta (fue ${health.held_aged})`);
    ok(
      `disputa envejecida ${AGED_DAYS}d > umbral(7d); sweep_disputes: held_total=${health.held_total} held_aged=${health.held_aged} (alerta ALTA fluvia_disputes_aged>0)`
    );

    // ── PASO 3: NIVEL A — el watchdog NO resuelve por asunción ────────────────
    const afterSweep = await adminPool.query<{ status: string }>(
      `SELECT status FROM disputes WHERE id = $1`,
      [opened.id]
    );
    assert(afterSweep.rows[0]!.status === 'open', 'la disputa sigue open tras el barrido');
    ok(
      'el watchdog SURFACEA salud pero NO transiciona: la disputa sigue open (sin cierres por asunción, V4 §23)'
    );

    // ── PASO 4: GATE RBAC — read_only no puede responder ──────────────────────
    const roResp = await api('POST', `/v1/organizations/${org}/disputes/${opened.id}/evidence`, {
      token: ro.token,
    });
    assert(roResp.status === 403, `read_only responde → 403 (fue ${roResp.status})`);
    ok('read_only sin reconciliation:manage → 403 al responder (gate RBAC correcto)');

    // ── PASO 5: el operador RESPONDE con evidencia por SESIÓN (F4-08e) ─────────
    const resp = await api('POST', `/v1/organizations/${org}/disputes/${opened.id}/evidence`, {
      token: fin.token,
    });
    assert(
      resp.status === 200 && resp.json.status === 'under_review',
      'finance responde → under_review'
    );
    // Idempotente: re-responder sobre under_review no falla.
    const respAgain = await api('POST', `/v1/organizations/${org}/disputes/${opened.id}/evidence`, {
      token: fin.token,
    });
    assert(
      respAgain.status === 200 && respAgain.json.status === 'under_review',
      're-responder es idempotente (sigue under_review)'
    );
    // Vista de sesión del operador: el detalle refleja under_review.
    const detail = await api('GET', `/v1/organizations/${org}/disputes/${opened.id}`, {
      token: fin.token,
    });
    assert(detail.json.status === 'under_review', 'el detalle por sesión muestra under_review');
    // Los fondos SIGUEN apartados (responder no mueve dinero).
    assert(
      (await balanceMinor(org, 'merchant.available', merchant)) === SEED - AMOUNT &&
        (await balanceMinor(org, 'dispute.reserve', merchant)) === AMOUNT,
      'los fondos siguen apartados tras responder'
    );
    ok(
      'finance respondió con evidencia por sesión (open→under_review, idempotente); los fondos siguen apartados'
    );

    // ── PASO 6: el banco entrega dispute.won → fondos vuelven íntegros ────────
    const won = await disputes.resolve(org, {
      disputeId: opened.id,
      outcome: 'won',
      providerRef: opened.providerRef,
    });
    assert(won === 'applied', `won aplicado (fue ${won})`);
    // Idempotente: la disputa ya es terminal → evento tardío ignorado.
    const wonAgain = await disputes.resolve(org, { disputeId: opened.id, outcome: 'won' });
    assert(wonAgain === 'ignored_out_of_order', `won repetido ignorado (fue ${wonAgain})`);
    assert(
      (await balanceMinor(org, 'merchant.available', merchant)) === SEED,
      `merchant.available restaurado a ${SEED}`
    );
    assert(
      (await balanceMinor(org, 'dispute.reserve', merchant)) === 0,
      'dispute.reserve vuelve a 0'
    );
    const wonBal = await disputePostingBalance(org, opened.id);
    assert(wonBal.lines >= 4, `asiento won tiene ≥4 líneas (open+win) (tiene ${wonBal.lines})`);
    assert(
      wonBal.debit === wonBal.credit && wonBal.debit === 2 * AMOUNT,
      `asiento won balanceado: D=${wonBal.debit} C=${wonBal.credit} == ${2 * AMOUNT}`
    );
    ok(
      'el banco entregó dispute.won → dispute.reserve→merchant.available; fondos restaurados íntegros; asiento balanceado'
    );

    // ── PASO 7: desenlace PERDIDA → forfeit balanceado ────────────────────────
    const lost = await openFromBank(org, merchant, AMOUNT_LOST);
    assert(lost.created === true, 'segunda disputa abierta');
    assert(
      (await balanceMinor(org, 'dispute.reserve', merchant)) === AMOUNT_LOST,
      `dispute.reserve retiene ${AMOUNT_LOST}`
    );
    const lostOutcome = await disputes.resolve(org, {
      disputeId: lost.id,
      outcome: 'lost',
      providerRef: lost.providerRef,
    });
    assert(lostOutcome === 'applied', `lost aplicado (fue ${lostOutcome})`);
    // Los fondos NO vuelven al comercio: se forfeitan (dispute.reserve→provider.clearing).
    assert(
      (await balanceMinor(org, 'merchant.available', merchant)) === SEED - AMOUNT_LOST,
      `merchant.available forfeitado: ${SEED - AMOUNT_LOST} (los fondos NO vuelven)`
    );
    assert(
      (await balanceMinor(org, 'dispute.reserve', merchant)) === 0,
      'dispute.reserve descargado a 0'
    );
    const lostBal = await disputePostingBalance(org, lost.id);
    assert(
      lostBal.debit === lostBal.credit && lostBal.debit === 2 * AMOUNT_LOST,
      `asiento lost balanceado: D=${lostBal.debit} C=${lostBal.credit} == ${2 * AMOUNT_LOST}`
    );
    ok(
      'una segunda disputa perdida: dispute.reserve→provider.clearing; fondos forfeitados; asiento balanceado'
    );

    console.log(
      `\n\x1b[32m✅ DRILL PASS\x1b[0m — runbook aged-disputes ensayado end-to-end (banco→worker→operador) sobre HTTP real (${step} pasos).`
    );
    await app.close();
    await Promise.all([appPool.end(), authPool.end(), adminPool.end(), workerPool.end()]);
    process.exit(0);
  } catch (err) {
    console.error(`\n\x1b[31m❌ DRILL FAIL\x1b[0m en el paso ${step + 1}:`, (err as Error).message);
    await app.close().catch(() => {});
    await Promise.all([appPool.end(), authPool.end(), adminPool.end(), workerPool.end()]).catch(
      () => {}
    );
    process.exit(1);
  }
}

void main();
