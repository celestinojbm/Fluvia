/**
 * DRILL · Runbook «Pago `indeterminate` envejecido» (F4-06b)
 *
 * Ensaya el runbook `docs/ops/runbooks/indeterminate-payment.md` de punta a punta
 * contra un stack REAL (Postgres + la API de Fluvia levantada en proceso y
 * conducida SOBRE HTTP para el ingreso del pago). No es un test unitario: es la
 * rehearsal operativa que exige el criterio de salida de la Fase 4 («runbooks
 * probados en drill»).
 *
 * A diferencia de `aged-disputes`, aquí NO hay acción de operador: un attempt
 * `indeterminate` (el proveedor hizo timeout DESPUÉS de posible cobro → desenlace
 * DESCONOCIDO) se cierra SOLO por fuente verificada (V4 §23). El drill cruza dos
 * planos:
 *   - Proveedor (FUENTE VERIFICADA): el ingreso del pago se conduce sobre HTTP
 *     con `tok_timeout` (el mock lanza `ProviderTimeoutError`); la resolución la
 *     representa `PaymentConfirmationService.resolveFromProvider` — exactamente lo
 *     que llama el handler del webhook firmado del proveedor (F3-03b); la ingesta
 *     HTTP→inbox en sí la cubre `webhook-ingest.test.ts`.
 *   - Worker (SALUD): `sweep_payment_attempts()` (F3-04) marca los envejecidos
 *     (>30 min) SIN transicionar — el watchdog jamás resuelve por asunción.
 *
 * Flujo (= pasos del runbook):
 *   1. Confirmar con timeout del proveedor → attempt `indeterminate` (NO `failed`;
 *      un circuito abierto sería fallo LIMPIO `provider_unavailable`); el intent
 *      sigue `processing`.
 *   2. Envejecer > 30 min → `sweep_payment_attempts()` marca `indeterminate_aged`
 *      (alerta ALTA `fluvia_payment_attempts_indeterminate_aged > 0`).
 *   3. NIVEL A: el watchdog NO resuelve — el attempt sigue `indeterminate`.
 *   4. Resolución verificada `succeeded` → captura contable ATÓMICA e idempotente
 *      (`attempt:<id>:capture`); intent `succeeded` + `amount_captured`; un webhook
 *      tardío → `ignored_out_of_order` (sin doble captura).
 *   5. Un segundo indeterminado resuelto `failed` → attempt/intent `failed`, SIN
 *      asiento.
 *   6. Una referencia inexistente → `ignored` (nunca se cierra nada por fuera).
 *
 * Uso: `pnpm --filter @fluvia/api run drill:indeterminate` (requiere Postgres
 * migrado; ver `docs/ops/runbooks/README.md` §Drill). Sale 0 en PASS, 1 en FAIL.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@fluvia/config';
import { createPool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { accountName, LedgerService, PostingService, type AccountCode } from '@fluvia/ledger';
import {
  MockPaymentProvider,
  PaymentConfirmationService,
  PaymentIntentService,
  ZERO_FEE_SCHEDULE,
} from '@fluvia/payments-core';
import { buildApp } from '../src/app.js';

const CURRENCY = 'COP'; // exponente 0
const AMOUNT = 50_000; // pago que se resuelve succeeded
const AMOUNT_FAILED = 25_000; // pago que se resuelve failed
const AGED_MIN = 40; // > 30 min: past-threshold del sweep

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

interface AttemptRow {
  id: string;
  status: string;
  provider_ref: string | null;
  last_error: string | null;
}

async function main(): Promise<void> {
  const config = loadConfig(); // NODE_ENV=local + *_DATABASE_URL del entorno
  const appPool = createPool({ connectionString: config.db.app, max: 6 });
  const authPool = createPool({ connectionString: config.db.auth, max: 4 });
  const adminPool = createPool({ connectionString: config.db.admin, max: 2 });
  const workerPool = createPool({ connectionString: config.db.worker, max: 2 });
  const apiKeyService = new ApiKeyService(appPool, { hmacSecretHex: config.apiKeyHmacSecret });
  const posting = new PostingService(new LedgerService(appPool), appPool);
  // Lado «fuente verificada»: el mismo servicio que llama el handler del inbox
  // (provider 'mock' → casa con los attempts creados por la API). Fee cero para
  // una aserción de saldo limpia (el fee al 2% lo prueba `confirmation.test.ts`).
  const confirmation = new PaymentConfirmationService(
    appPool,
    new PaymentIntentService(appPool),
    posting,
    new MockPaymentProvider(),
    ZERO_FEE_SCHEDULE
  );

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
    opts: { token?: string; body?: unknown; idem?: string } = {}
  ): Promise<ApiResult> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.idem ? { 'idempotency-key': opts.idem } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
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

  /** Último attempt de un intent (el que crea el confirm). */
  const attemptOf = async (intentId: string): Promise<AttemptRow> => {
    const res = await adminPool.query<AttemptRow>(
      `SELECT id, status, provider_ref, last_error FROM payment_attempts
        WHERE intent_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
      [intentId]
    );
    return res.rows[0]!;
  };

  /** Suma de líneas del asiento de captura de un attempt: debe balancear. */
  const captureBalance = async (
    org: string,
    attemptId: string
  ): Promise<{ debit: number; credit: number; lines: number }> => {
    const res = await adminPool.query<{ debit: string; credit: string; lines: string }>(
      `SELECT COALESCE(SUM(e.amount) FILTER (WHERE e.direction='debit'),0)::text  AS debit,
              COALESCE(SUM(e.amount) FILTER (WHERE e.direction='credit'),0)::text AS credit,
              COUNT(*)::text AS lines
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.tx_root_id
        WHERE t.tenant_id = $1 AND t.idempotency_key = $2`,
      [org, `attempt:${attemptId}:capture`]
    );
    const r = res.rows[0]!;
    return { debit: Number(r.debit), credit: Number(r.credit), lines: Number(r.lines) };
  };

  /** Crea un intent (API key) y lo confirma con `tok_timeout` → indeterminate. */
  const openIndeterminate = async (
    key: string,
    merchant: string,
    amount: number
  ): Promise<{ intentId: string; attempt: AttemptRow }> => {
    const created = await api('POST', '/v1/payment_intents', {
      token: key,
      idem: `pi-${randomUUID()}`,
      body: { merchant_id: merchant, amount, currency: CURRENCY },
    });
    assert(created.status === 201, `crear intent 201 (fue ${created.status})`);
    const intentId = created.json.id as string;
    const confirmed = await api('POST', `/v1/payment_intents/${intentId}/confirm`, {
      token: key,
      idem: `cf-${randomUUID()}`,
      body: { payment_method_token: 'tok_timeout' },
    });
    assert(confirmed.status === 200, `confirmar 200 (fue ${confirmed.status})`);
    return { intentId, attempt: await attemptOf(intentId) };
  };

  try {
    // ── Setup: org + merchant + API key ───────────────────────────────────────
    const org = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        ['Indeterminate Drill Org', `drill-${randomUUID()}`]
      )
    ).rows[0]!.id;
    const merchant = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
        [org, `drill-shop-${randomUUID().slice(0, 8)}`]
      )
    ).rows[0]!.id;
    const key = (
      await apiKeyService.create(org, { label: 'drill', scopes: ['payments:write', 'read'] })
    ).secret;
    log(`org=${org.slice(0, 8)}… · merchant=${merchant.slice(0, 8)}…`);

    // ── PASO 1: confirmar con timeout → indeterminate (NO failed) ──────────────
    const { intentId, attempt } = await openIndeterminate(key, merchant, AMOUNT);
    assert(attempt.status === 'indeterminate', `attempt indeterminate (fue ${attempt.status})`);
    assert(attempt.provider_ref === null, 'sin provider_ref todavía (lo aporta el webhook)');
    assert(
      (attempt.last_error ?? '').includes('outcome unknown'),
      'last_error marca desenlace desconocido (no un decline limpio)'
    );
    const intentAfter = await api('GET', `/v1/payment_intents/${intentId}`, { token: key });
    assert(intentAfter.json.status === 'processing', 'el intent sigue processing (no resuelto)');
    ok(
      `el proveedor hizo timeout tras posible cobro → attempt indeterminate; intent sigue processing (desenlace DESCONOCIDO, V4 §23; ≠ circuito abierto = fallo limpio)`
    );

    // ── PASO 2: envejecer > 30 min → sweep marca la alerta ─────────────────────
    await adminPool.query(
      `UPDATE payment_attempts SET updated_at = now() - make_interval(mins => $2) WHERE id = $1`,
      [attempt.id, AGED_MIN]
    );
    const sweep = await workerPool.query<{ metric: string; value: string }>(
      `SELECT metric, value::text AS value FROM sweep_payment_attempts()`
    );
    const health = Object.fromEntries(sweep.rows.map((r) => [r.metric, Number(r.value)]));
    assert(
      health.indeterminate_total >= 1,
      `indeterminate_total >= 1 (fue ${health.indeterminate_total})`
    );
    assert(
      health.indeterminate_aged >= 1,
      `indeterminate_aged >= 1 → alerta (fue ${health.indeterminate_aged})`
    );
    ok(
      `attempt envejecido ${AGED_MIN}min > umbral(30min); sweep_payment_attempts: indeterminate_total=${health.indeterminate_total} indeterminate_aged=${health.indeterminate_aged} (alerta ALTA)`
    );

    // ── PASO 3: NIVEL A — el watchdog NO resuelve por asunción ─────────────────
    const afterSweep = await attemptOf(intentId);
    assert(afterSweep.status === 'indeterminate', 'el attempt sigue indeterminate tras el barrido');
    ok(
      'el watchdog SURFACEA salud pero NO resuelve: el attempt sigue indeterminate (sin cierres por asunción, V4 §23)'
    );

    // ── PASO 4: resolución verificada `succeeded` → captura atómica idempotente ─
    const pendingBefore = await balanceMinor(org, 'merchant.pending', merchant);
    const webhookRef = `wh_${randomUUID().slice(0, 12)}`;
    const applied = await confirmation.resolveFromProvider(org, {
      attemptId: attempt.id,
      providerRef: webhookRef,
      result: 'succeeded',
    });
    assert(applied === 'applied', `resolución succeeded aplicada (fue ${applied})`);
    const resolved = await attemptOf(intentId);
    assert(resolved.status === 'succeeded', `attempt succeeded (fue ${resolved.status})`);
    const intentResolved = await api('GET', `/v1/payment_intents/${intentId}`, { token: key });
    assert(intentResolved.json.status === 'succeeded', 'intent succeeded');
    assert(Number(intentResolved.json.amount_captured) === AMOUNT, `amount_captured == ${AMOUNT}`);
    assert(
      (await balanceMinor(org, 'merchant.pending', merchant)) === pendingBefore + AMOUNT,
      `merchant.pending subió ${AMOUNT} (captura contable)`
    );
    const cap = await captureBalance(org, attempt.id);
    assert(cap.lines >= 2, `la captura tiene ≥2 líneas (tiene ${cap.lines})`);
    assert(
      cap.debit === cap.credit && cap.debit === AMOUNT,
      `captura balanceada: D=${cap.debit} C=${cap.credit} == ${AMOUNT}`
    );
    // Webhook tardío: idempotente, sin doble captura.
    const late = await confirmation.resolveFromProvider(org, {
      attemptId: attempt.id,
      providerRef: webhookRef,
      result: 'succeeded',
    });
    assert(late === 'ignored_out_of_order', `webhook tardío ignorado (fue ${late})`);
    assert(
      (await balanceMinor(org, 'merchant.pending', merchant)) === pendingBefore + AMOUNT,
      'sin doble captura tras el webhook tardío'
    );
    ok(
      'resolución verificada succeeded → captura atómica idempotente; intent succeeded + amount_captured; asiento balanceado; webhook tardío → ignored_out_of_order (sin doble captura)'
    );

    // ── PASO 5: un segundo indeterminado resuelto `failed` → sin asiento ───────
    const second = await openIndeterminate(key, merchant, AMOUNT_FAILED);
    assert(second.attempt.status === 'indeterminate', 'segundo attempt indeterminate');
    const pendingBeforeFail = await balanceMinor(org, 'merchant.pending', merchant);
    const failApplied = await confirmation.resolveFromProvider(org, {
      attemptId: second.attempt.id,
      providerRef: `wh_${randomUUID().slice(0, 12)}`,
      result: 'failed',
      failureCode: 'do_not_honor',
    });
    assert(failApplied === 'applied', `resolución failed aplicada (fue ${failApplied})`);
    assert((await attemptOf(second.intentId)).status === 'failed', 'attempt failed');
    const failedIntent = await api('GET', `/v1/payment_intents/${second.intentId}`, { token: key });
    assert(failedIntent.json.status === 'failed', 'intent failed');
    assert(
      (await balanceMinor(org, 'merchant.pending', merchant)) === pendingBeforeFail,
      'un failed NO postea asiento (merchant.pending sin cambios)'
    );
    assert(
      (await captureBalance(org, second.attempt.id)).lines === 0,
      'sin líneas de captura para el failed'
    );
    ok('un segundo indeterminado resuelto failed → attempt/intent failed, SIN asiento');

    // ── PASO 6: referencia inexistente → ignored (nada se cierra por fuera) ─────
    const ignored = await confirmation.resolveFromProvider(org, {
      attemptId: randomUUID(),
      providerRef: 'wh_phantom',
      result: 'succeeded',
    });
    assert(ignored === 'ignored', `attempt inexistente → ignored (fue ${ignored})`);
    ok('una referencia inexistente → ignored: la resolución jamás cierra nada por fuera');

    console.log(
      `\n\x1b[32m✅ DRILL PASS\x1b[0m — runbook indeterminate-payment ensayado end-to-end (proveedor→worker) sobre HTTP real (${step} pasos).`
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
