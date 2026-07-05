import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@fluvia/money';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import { AccountNotFoundError, LedgerService, ProjectionDriftWatcher } from '../src/index.js';

/**
 * F2-05 (rebuild + drift check) y F2-06 (invariantes SQL externas al ORM).
 * La "corrupcion" se siembra como superusuario tocando la PROYECCION (la
 * unica pieza derivada y mutable); los asientos son inmutables por motor.
 */

let ctx: TestContext;
let ledger: LedgerService;
let org: string;
let accA: string;
let accB: string;

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/verify-ledger-invariants.sql'
);

const usd = (minor: number) => Money.of(minor, 'USD');
const key = () => `drift-${randomUUID()}`;

async function transfer(amount: number, from: string, to: string) {
  return ledger.postTransaction({
    tenantId: org,
    idempotencyKey: key(),
    reason: 'transfer',
    source: { type: 'manual', id: `drift-${randomUUID().slice(0, 8)}` },
    entries: [
      { accountId: from, direction: 'debit', amount: usd(amount) },
      { accountId: to, direction: 'credit', amount: usd(amount) },
    ],
  });
}

/** Siembra drift en la proyeccion de una cuenta (solo superusuario puede). */
async function tamperProjection(accountId: string, delta: number) {
  await ctx.admin.query(
    `UPDATE balance_projections SET available = available + $2 WHERE account_id = $1`,
    [accountId, delta]
  );
}

beforeAll(async () => {
  ctx = await createTestContext();
  ledger = new LedgerService(ctx.app);
  org = await ctx.createTenant('Drift Org');
  accA = (
    await ledger.createAccount({
      tenantId: org,
      name: 'drift.a',
      currency: 'USD',
      normalSide: 'debit',
    })
  ).id;
  accB = (
    await ledger.createAccount({
      tenantId: org,
      name: 'drift.b',
      currency: 'USD',
      normalSide: 'credit',
    })
  ).id;
  await transfer(10_000, accA, accB);
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('F2-05: rebuildProjection', () => {
  it('healthy account: rebuild reports drifted=false and preserves values', async () => {
    const before = await ledger.getBalance(org, accB);
    const result = await ledger.rebuildProjection(org, accB);
    expect(result.drifted).toBe(false);
    expect(result.after).toEqual(result.before);
    const after = await ledger.getBalance(org, accB);
    expect(after.available).toBe(before.available);
    // La version SIEMPRE avanza: un posting en vuelo con version vieja reintenta.
    expect(BigInt(after.version)).toBe(BigInt(before.version) + 1n);
  });

  it('tampered projection: verify detects, rebuild repairs and reports drifted=true', async () => {
    await tamperProjection(accB, 777);
    expect((await ledger.verifyProjection(org, accB)).matches).toBe(false);

    const result = await ledger.rebuildProjection(org, accB);
    expect(result.drifted).toBe(true);
    expect(BigInt(result.before.available) - BigInt(result.after.available)).toBe(777n);

    const check = await ledger.verifyProjection(org, accB);
    expect(check.matches).toBe(true);
    expect(check.projected.available).toBe(result.after.available);
  });

  it('PROPERTY (Gate Ledger): after N concurrent random transfers interleaved with rebuilds, rebuild == projection for every account', async () => {
    const accounts = [accA, accB];
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i += 1) {
      const from = accounts[i % 2]!;
      const to = accounts[(i + 1) % 2]!;
      jobs.push(transfer(10 + i * 3, from, to));
      if (i % 5 === 0) jobs.push(ledger.rebuildProjection(org, accounts[i % 2]!));
    }
    await Promise.all(jobs);

    for (const accountId of accounts) {
      const rebuilt = await ledger.rebuildProjection(org, accountId);
      expect(rebuilt.drifted, `drift residual en ${accountId}`).toBe(false);
      const check = await ledger.verifyProjection(org, accountId);
      expect(check.matches).toBe(true);
    }
  });

  it('rejects unknown or cross-tenant accounts', async () => {
    await expect(ledger.rebuildProjection(org, randomUUID())).rejects.toThrow(AccountNotFoundError);
    const otherOrg = await ctx.createTenant('Drift Other Org');
    await expect(ledger.rebuildProjection(otherOrg, accA)).rejects.toThrow(AccountNotFoundError);
  });
});

describe('F2-05: ledger_projection_drift() + watcher programado', () => {
  it('worker role detects seeded drift; app role has NO access to the definer function', async () => {
    await tamperProjection(accA, -123);
    const errors: Array<Record<string, unknown>> = [];
    const watcher = new ProjectionDriftWatcher(ctx.worker, {
      info: () => undefined,
      error: (obj) => {
        errors.push(obj);
      },
    });

    const rows = await watcher.runOnce();
    const mine = rows.find((r) => r.accountId === accA);
    expect(mine).toBeTruthy();
    expect(mine!.tenantId).toBe(org);
    expect(BigInt(mine!.projectedAvailable!) - BigInt(mine!.recomputedAvailable)).toBe(-123n);
    expect(errors.length).toBe(1); // alerta baseline emitida

    // Reparacion EXPLICITA (jamas automatica) y el watcher queda limpio.
    await ledger.rebuildProjection(org, accA);
    const clean = await watcher.runOnce();
    expect(clean.find((r) => r.accountId === accA)).toBeUndefined();

    // El rol app no tiene la ventana cross-tenant.
    await expect(ctx.app.query('SELECT * FROM ledger_projection_drift()')).rejects.toThrow(
      /permission denied/i
    );
  });

  it('F1-07: onCheck observer sees each check result and its failures never break the watcher', async () => {
    await tamperProjection(accA, 77);
    const seen: number[] = [];
    const watcher = new ProjectionDriftWatcher(
      ctx.worker,
      { info: () => undefined, error: () => undefined },
      {
        onCheck: (rows) => {
          seen.push(rows.filter((r) => r.accountId === accA).length);
          throw new Error('metrics observer exploded');
        },
      }
    );

    // El observador lanzo y aun asi runOnce devolvio las filas.
    const rows = await watcher.runOnce();
    expect(rows.some((r) => r.accountId === accA)).toBe(true);
    expect(seen).toEqual([1]);

    await ledger.rebuildProjection(org, accA);
    await watcher.runOnce();
    expect(seen).toEqual([1, 0]); // el gauge volveria a 0: base de la alerta drift>0
  });
});

describe('F2-06: scripts/verify-ledger-invariants.sql (externo al ORM)', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8');

  it('passes on a healthy database', async () => {
    await expect(ctx.admin.query(script)).resolves.toBeTruthy();
  });

  it('CA Gate Ledger: detects seeded corruption and passes again after explicit repair', async () => {
    await tamperProjection(accB, 999_999);
    await expect(ctx.admin.query(script)).rejects.toThrow(
      /FLUVIA_INVARIANT_VIOLATION.*projection drift/
    );

    await ledger.rebuildProjection(org, accB);
    await expect(ctx.admin.query(script)).resolves.toBeTruthy();
  });

  it('a MISSING projection row is a visible failure (not silent drift) and rebuild materializes it', async () => {
    // Semantica decidida en F2-05: el drift silencioso es una fila viva que
    // MIENTE; una fila AUSENTE no puede mentir — getBalance falla ruidosamente
    // y rebuild la materializa. (Borrarla exige superusuario en modo replica:
    // el trigger de inmutabilidad lo impide por las vias normales.)
    const orphan = (
      await ledger.createAccount({
        tenantId: org,
        name: 'drift.orphan',
        currency: 'USD',
        normalSide: 'credit',
      })
    ).id;
    await transfer(500, accA, orphan);
    const client = await ctx.admin.connect();
    try {
      await client.query(`SET session_replication_role = replica`);
      await client.query(`DELETE FROM balance_projections WHERE account_id = $1`, [orphan]);
      await client.query(`SET session_replication_role = DEFAULT`);
    } finally {
      client.release();
    }

    // Fallo VISIBLE: el saldo no es legible, nadie opera sobre un cero falso.
    await expect(ledger.getBalance(org, orphan)).rejects.toThrow(AccountNotFoundError);
    // Y el script global sigue en verde: no hay fila viva que mienta.
    await expect(ctx.admin.query(script)).resolves.toBeTruthy();

    const rebuilt = await ledger.rebuildProjection(org, orphan);
    expect(rebuilt.drifted).toBe(true);
    expect(rebuilt.after.available).toBe('500');
    expect((await ledger.getBalance(org, orphan)).available).toBe('500');
    await expect(ctx.admin.query(script)).resolves.toBeTruthy();
  });
});
