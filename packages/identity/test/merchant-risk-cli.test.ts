import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';

/**
 * CLI `merchant-risk screen [--include-undeclared]` de punta a punta (proceso
 * real, PG real). La lógica de `screen` ya está cubierta en merchant-risk.test.ts;
 * aquí se prueba el CABLEADO: que el flag llega a `screen` y que la salida es la
 * que el runbook promete (triage post-#108 de los legados pending_review).
 */

const run = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(pkgDir, 'node_modules', '.bin', 'tsx');

let ctx: TestContext;
let undeclaredId: string;
let declaredId: string;

async function cli(...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(tsx, ['src/merchant-risk-cli.ts', '--', ...args], {
      cwd: pkgDir,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? '', code: e.code ?? 1 };
  }
}

beforeAll(async () => {
  ctx = await createTestContext();
  const org = await ctx.createTenant();
  undeclaredId = (
    await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [org, `CLI Legado ${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
  declaredId = (
    await ctx.admin.query<{ id: string }>(
      `INSERT INTO merchants (tenant_id, name, state_affiliation) VALUES ($1, $2, 'none') RETURNING id`,
      [org, `CLI Declarado ${randomUUID().slice(0, 8)}`]
    )
  ).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('merchant-risk CLI: screen', () => {
  it('sin el flag NO lista al legado sin declarar', async () => {
    const { stdout, code } = await cli('screen');
    expect(code).toBe(0);
    expect(stdout).not.toContain(undeclaredId);
  }, 60_000);

  it('--include-undeclared lista al legado como undeclared/pending_review y no al declarado', async () => {
    const { stdout, code } = await cli('screen', '--include-undeclared');
    expect(code).toBe(0);
    const line = stdout.split('\n').find((l) => l.includes(undeclaredId));
    expect(line).toBeDefined();
    expect(line).toMatch(/^undeclared \|/);
    expect(line).toContain('ACTIVE');
    expect(line).toContain('affiliation=UNDECLARED');
    expect(line).toContain('declaration=pending_review');
    expect(stdout).not.toContain(declaredId);
  }, 60_000);

  it('solo lee: el legado sigue activo tras el screen', async () => {
    const res = await ctx.admin.query<{ status: string }>(
      'SELECT status FROM merchants WHERE id = $1',
      [undeclaredId]
    );
    expect(res.rows[0]!.status).toBe('active');
  });

  it('un comando desconocido sale con código 2 y el uso', async () => {
    const { code } = await cli('freeze-all');
    expect(code).toBe(2);
  }, 60_000);
});
