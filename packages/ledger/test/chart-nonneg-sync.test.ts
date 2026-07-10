import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHART_OF_ACCOUNTS } from '../src/chart-of-accounts.js';

/**
 * RA-F6-005 (re-auditoría F6 delta) — META-TEST de sincronización chart ↔ check [9].
 *
 * La lista de cuentas protegidas del check [9] en `scripts/verify-ledger-invariants.sql`
 * está hardcodeada; su CONTRATO (declarado en el propio SQL) es ser EXACTAMENTE las
 * cuentas del chart con `type != 'transitory'`. Sin este test, añadir una cuenta
 * protegida al chart y olvidar el SQL dejaría esa cuenta FUERA de la detección de
 * no-negatividad en silencio (drift de cobertura). Mismo patrón doc↔código que los
 * meta-tests existentes (topics de webhooks, guard de parametrización SQL).
 *
 * Estático a propósito (sin PostgreSQL): compara la fuente de verdad ejecutable
 * (chart-of-accounts.ts, importada de verdad) contra el texto real del SQL.
 */

const SQL_PATH = fileURLToPath(
  new URL('../../../scripts/verify-ledger-invariants.sql', import.meta.url)
);

/** Extrae la lista hardcodeada del check [9] (el IN (...) sobre split_part). */
function extractCheck9Accounts(sql: string): string[] {
  const m = sql.match(/split_part\(a\.name, ':', 1\) IN \(([\s\S]*?)\)\s*\n\s*AND/);
  if (!m) return [];
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('RA-F6-005 — el check [9] cubre EXACTAMENTE las cuentas protegidas del chart', () => {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const sqlList = extractCheck9Accounts(sql);
  const chartProtected = Object.entries(CHART_OF_ACCOUNTS)
    .filter(([, def]) => def.type !== 'transitory')
    .map(([code]) => code);
  const chartTransitory = Object.entries(CHART_OF_ACCOUNTS)
    .filter(([, def]) => def.type === 'transitory')
    .map(([code]) => code);

  it('the extraction is NOT vacuous (the [9] IN-list exists and the chart has both tiers)', () => {
    // Si el SQL se refactoriza y la extracción deja de matchear, este test debe
    // ROMPER ruidosamente (no pasar en vacío): actualizar extractCheck9Accounts.
    expect(sqlList.length, 'no se pudo extraer la lista IN(...) del check [9]').toBeGreaterThan(0);
    expect(chartProtected.length).toBeGreaterThan(0);
    // Sanidad del chart: las transitorias documentadas siguen siendo transitorias.
    expect(chartTransitory).toEqual(expect.arrayContaining(['suspense', 'recon.differences']));
  });

  it('every protected chart account is covered by [9], and [9] lists nothing else', () => {
    const missing = chartProtected.filter((c) => !sqlList.includes(c));
    const extra = sqlList.filter((c) => !(chartProtected as string[]).includes(c));
    expect(
      missing,
      `cuentas PROTEGIDAS del chart SIN cobertura en el check [9] — añádelas a la lista IN(...) de scripts/verify-ledger-invariants.sql: ${missing.join(', ')}`
    ).toEqual([]);
    expect(
      extra,
      `cuentas listadas en el check [9] que NO son protegidas del chart (ya no existen, ` +
        `cambiaron de nombre o son transitorias) — quítalas del IN(...) o corrige el chart: ${extra.join(', ')}`
    ).toEqual([]);
  });

  it('no transitory account leaked into the [9] protected list', () => {
    // Redundante con "extra" pero con mensaje específico: una transitoria en [9]
    // produciría FALSOS POSITIVOS (postReconAdjustment las deja negativas por diseño).
    const leaked = sqlList.filter((c) => chartTransitory.includes(c));
    expect(
      leaked,
      `cuentas TRANSITORIAS dentro de la lista protegida del check [9] (darían falso positivo): ${leaked.join(', ')}`
    ).toEqual([]);
  });
});
