/* global process, console */
/**
 * RA-F6-004 — Reporte y check de licencias TRANSITIVAS (docs/compliance/license-policy.md).
 *
 * Herramienta: la capacidad NATIVA de pnpm (`pnpm licenses list --json`), que lee
 * las licencias DECLARADAS en los manifests de todo el árbol del lockfile — cero
 * dependencias nuevas, reproducible, workspaces-aware. (El SBOM SPDX de syft en CI
 * deriva su metadata de licencias de los MISMOS manifests: derivarlo de ahí
 * añadiría partes móviles sin fidelidad extra — Opción B del cierre.)
 *
 * Semántica del gate (ver política §4):
 *  - El gate DURO aplica a las dependencias de PRODUCCIÓN (`--prod`): lo que se
 *    distribuye. Las devDependencies se reportan como INFORMATIVAS.
 *  - PROHIBIDA o DESCONOCIDA/no-parseable en producción → exit 1 (siempre).
 *  - RESTRINGIDA en producción → se lista como «requiere decisión humana»:
 *    exit 0 con warning en modo normal (CI), exit 1 en `--strict` salvo que
 *    exista una excepción con `status: "aceptada"` en license-exceptions.json.
 *    NINGUNA licencia se acepta automáticamente: aceptar es del propietario.
 *  - Expresiones SPDX: `OR` → basta una rama permitida (el consumidor elige);
 *    `AND` → todas las ramas deben ser permitidas; si no se puede clasificar,
 *    cuenta como DESCONOCIDA (falla).
 *
 * Uso:  node scripts/check-licenses.mjs [--strict] [--report]
 *   --report  además escribe docs/compliance/license-report.md
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Clasificación SPDX — espejo ejecutable de docs/compliance/license-policy.md §2.
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
]);
const RESTRICTED = new Set([
  'MPL-2.0',
  'EPL-2.0',
  'LGPL-2.0-only',
  'LGPL-2.0-or-later',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'CC-BY-4.0',
  'CC-BY-3.0',
  'Python-2.0',
  'Artistic-2.0',
]);
const PROHIBITED_PATTERNS = [
  /^GPL-/i,
  /^AGPL/i,
  /^SSPL/i,
  /^BUSL/i,
  /Commons.?Clause/i,
  /^CC-BY-NC/i,
  /NonCommercial/i,
  /^UNLICENSED$/i,
];

function classifyToken(token) {
  const t = token.trim().replace(/^\(|\)$/g, '');
  if (PROHIBITED_PATTERNS.some((re) => re.test(t))) return 'prohibida';
  if (ALLOWED.has(t)) return 'permitida';
  if (RESTRICTED.has(t)) return 'restringida';
  return 'desconocida';
}

/** Clasifica una expresión SPDX simple (sin paréntesis anidados). */
export function classify(expr) {
  if (!expr || typeof expr !== 'string' || /^unknown$/i.test(expr.trim())) return 'desconocida';
  const clean = expr.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/ OR /i.test(clean) && / AND /i.test(clean)) return 'desconocida'; // mixta: revisar
  if (/ OR /i.test(clean)) {
    const parts = clean.split(/ OR /i).map(classifyToken);
    if (parts.includes('permitida')) return 'permitida'; // el consumidor elige la rama
    if (parts.includes('restringida')) return 'restringida';
    return parts.includes('prohibida') ? 'prohibida' : 'desconocida';
  }
  if (/ AND /i.test(clean)) {
    const parts = clean.split(/ AND /i).map(classifyToken);
    if (parts.includes('prohibida')) return 'prohibida';
    if (parts.includes('desconocida')) return 'desconocida';
    return parts.includes('restringida') ? 'restringida' : 'permitida';
  }
  return classifyToken(clean);
}

function licensesJson(prodOnly) {
  const cmd = `pnpm licenses list ${prodOnly ? '--prod ' : ''}--json`;
  return { cmd, data: JSON.parse(execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) || '{}') };
}

function bucketize(data) {
  const buckets = { permitida: [], restringida: [], prohibida: [], desconocida: [] };
  let total = 0;
  for (const [license, pkgs] of Object.entries(data)) {
    for (const p of pkgs) {
      total += 1;
      buckets[classify(license)].push({ name: p.name, versions: p.versions, license });
    }
  }
  return { buckets, total };
}

function loadExceptions() {
  try {
    return JSON.parse(readFileSync('docs/compliance/license-exceptions.json', 'utf8')).exceptions ?? [];
  } catch {
    return [];
  }
}

const strict = process.argv.includes('--strict');
const report = process.argv.includes('--report');

const prod = licensesJson(true);
const all = licensesJson(false);
const prodB = bucketize(prod.data);
const allB = bucketize(all.data);
const exceptions = loadExceptions();
// Fuente ÚNICA de verdad de las decisiones humanas — la MISMA que consumen el check estricto Y el
// reporte (F6-DELTA-001). Map `package|license` → excepción aceptada: `.has()` sirve al gate (igual
// que el Set anterior); `.get()` da la decisión completa para renderizarla en el reporte, sin duplicar
// la lógica de excepciones ni permitir que ambos modos se desincronicen.
const accepted = new Map(
  exceptions.filter((e) => e.status === 'aceptada').map((e) => [`${e.package}|${e.license}`, e])
);

const fmt = (list) => list.map((p) => `${p.name}@${p.versions.join(',')} [${p.license}]`).join('\n  ');

// Renderiza una licencia RESTRINGIDA de producción en el reporte reflejando la decisión humana
// vigente en license-exceptions.json (F6-DELTA-001): las ACEPTADAS muestran el bloque completo de la
// excepción; las que NO tienen decisión se marcan explícitamente como pendientes (bloquean release).
function renderRestricted(p) {
  const e = accepted.get(`${p.name}|${p.license}`);
  const head = `- \`${p.name}@${p.versions.join(',')}\` — **${p.license}**`;
  if (!e) {
    return `${head} — **sin decisión registrada** en license-exceptions.json (bloquea release/producción hasta decisión del propietario)`;
  }
  const lines = [
    `${head} — **estado: aceptada** (decisión humana registrada)`,
    `  - **Aprobado por**: ${e.approvedBy} · **Fecha de aprobación**: ${e.approvalDate}`,
    `  - **Razón**: ${e.reason}`,
    `  - **Obligaciones**: ${e.obligations}`,
    `  - **reviewBy**: ${e.reviewBy}`,
    `  - **La aceptación NO autoriza producción/release.**`,
  ];
  if (/LGPL/i.test(p.license)) {
    lines.push(
      `  - **LGPLv3**: requiere **revisión legal antes del primer release público/comercial**; la excepción caduca si cambia el modo de uso, si se modifica libvips, si se enlaza estáticamente o si se empaqueta de forma no reemplazable.`
    );
  }
  return lines.join('\n');
}

console.log(`Licencias transitivas — PRODUCCIÓN: ${prodB.total} paquetes · árbol completo: ${allB.total}`);
console.log(`  permitidas(prod): ${prodB.buckets.permitida.length}`);
let failures = 0;
for (const tier of ['prohibida', 'desconocida']) {
  const hits = prodB.buckets[tier];
  if (hits.length) {
    failures += hits.length;
    console.error(`✗ ${tier.toUpperCase()} en producción (${hits.length}):\n  ${fmt(hits)}`);
  }
}
const pendingRestricted = prodB.buckets.restringida.filter(
  (p) => !accepted.has(`${p.name}|${p.license}`)
);
if (pendingRestricted.length) {
  const msg = `RESTRINGIDAS en producción SIN decisión humana registrada (${pendingRestricted.length}) — bloquean release/producción hasta decisión del propietario (política §3):\n  ${fmt(pendingRestricted)}`;
  if (strict) {
    failures += pendingRestricted.length;
    console.error(`✗ ${msg}`);
  } else {
    console.warn(`⚠ ${msg}`);
  }
}

if (report) {
  const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const date = new Date().toISOString().slice(0, 10);
  const summary = (b) =>
    Object.entries(
      [...b.buckets.permitida, ...b.buckets.restringida, ...b.buckets.prohibida, ...b.buckets.desconocida].reduce(
        (acc, p) => ((acc[p.license] = (acc[p.license] ?? 0) + 1), acc),
        {}
      )
    )
      .sort()
      .map(([l, n]) => `| ${l} | ${n} | ${classify(l)} |`)
      .join('\n');
  const md = `# Reporte de licencias transitivas (generado)

- **Fecha**: ${date} · **Commit base**: \`${commit}\`
- **Herramienta**: \`pnpm licenses list --json\` (nativa de pnpm; licencias DECLARADAS en manifests — ver limitaciones)
- **Comandos**: \`${prod.cmd}\` (gate) · \`${all.cmd}\` (informativo)
- **Regenerar**: \`pnpm licenses:report\` · **Gate**: \`pnpm licenses:check\` (CI, job security)

## Producción (lo que se distribuye) — GATE

Total: **${prodB.total} paquetes** · permitidas ${prodB.buckets.permitida.length} · restringidas ${prodB.buckets.restringida.length} · prohibidas ${prodB.buckets.prohibida.length} · desconocidas ${prodB.buckets.desconocida.length}

| Licencia | Paquetes | Clasificación |
| --- | --- | --- |
${summary(prodB)}

### Restringidas — DECISIÓN HUMANA registrada en license-exceptions.json (bloquean release hasta decidirse)

${prodB.buckets.restringida.length ? prodB.buckets.restringida.map(renderRestricted).join('\n') : '- (ninguna)'}

### Prohibidas / desconocidas en producción

${[...prodB.buckets.prohibida, ...prodB.buckets.desconocida].length ? fmt([...prodB.buckets.prohibida, ...prodB.buckets.desconocida]) : '- (ninguna)'}

## Árbol completo incl. devDependencies — INFORMATIVO (no se distribuyen)

Total: **${allB.total} paquetes** · fuera del tier permitido: ${[...allB.buckets.restringida, ...allB.buckets.prohibida, ...allB.buckets.desconocida].map((p) => `\`${p.name}\` (${p.license})`).join(', ') || '(ninguno)'}

## Resultado

**${failures ? 'FAIL' : 'PASS'}** — ${failures ? `${failures} violación(es) del gate` : `sin prohibidas ni desconocidas en producción${pendingRestricted.length ? `; ${pendingRestricted.length} restringida(s) pendiente(s) de decisión humana (bloquean release, no este check en modo normal)` : ''}`}.

## Limitaciones conocidas

- Reporta licencias **DECLARADAS** en los \`package.json\` del árbol (igual que el SBOM SPDX de syft): no hay escaneo file-level ni análisis de NOTICE/vendored code.
- El árbol proviene del lockfile (incluye optional deps de todas las plataformas pineadas, p. ej. los binarios de sharp/libvips).
- Este reporte es una FOTO del commit indicado; el check de CI es el gate vivo por commit.
`;
  // Guard anti-regresión (F6-DELTA-001): el reporte NO puede contradecir license-exceptions.json.
  // Ejercita el MISMO `renderRestricted` que arma el markdown, así el chequeo refleja la salida real:
  //  - aceptada → debe mostrar «estado: aceptada» y nunca «sin decisión registrada»;
  //  - sin excepción → debe seguir marcándose «sin decisión registrada» (no silenciar una pendiente).
  // Cualquier inconsistencia aborta la generación con exit 1 en vez de escribir un reporte engañoso.
  for (const p of prodB.buckets.restringida) {
    const block = renderRestricted(p);
    const isAccepted = accepted.has(`${p.name}|${p.license}`);
    const saysUndecided = /sin decisión registrada/i.test(block);
    const saysAccepted = /estado: aceptada/i.test(block);
    if (isAccepted && (saysUndecided || !saysAccepted)) {
      console.error(
        `✗ F6-DELTA-001: ${p.name}@${p.versions.join(',')} [${p.license}] está ACEPTADA en license-exceptions.json pero el reporte no la refleja.`
      );
      process.exit(1);
    }
    if (!isAccepted && !saysUndecided) {
      console.error(
        `✗ F6-DELTA-001: ${p.name}@${p.versions.join(',')} [${p.license}] es restringida SIN excepción pero el reporte no la marca como pendiente.`
      );
      process.exit(1);
    }
  }
  writeFileSync('docs/compliance/license-report.md', md);
  console.log('Reporte escrito en docs/compliance/license-report.md');
}

if (failures) {
  console.error(`\nFAIL: ${failures} violación(es) de la política de licencias (docs/compliance/license-policy.md).`);
  process.exit(1);
}
console.log(`OK: sin licencias prohibidas ni desconocidas en producción${strict ? ' (strict)' : ''}.`);
