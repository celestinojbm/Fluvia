import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * F6 (threat model §5 — Multi-tenant): el límite documentado del RLS es que NO
 * protege contra SQL arbitrario con el rol app; la defensa es «consultas 100%
 * parametrizadas» (`architecture/multi-tenancy.md §6.5`). Este test estructural
 * convierte esa afirmación en un GATE con DOS candados sobre el código de
 * runtime:
 *  1. INTERPOLACIÓN: toda `${…}` dentro de un literal SQL de SENTENCIA COMPLETA
 *     debe interpolar un identificador vetado (lista de columnas constante) o
 *     un caso especial documentado (el número de config de `SET LOCAL`), jamás
 *     un valor. Un `${userInput}` nuevo rompe el build.
 *  2. FORMA DEL ARGUMENTO de `.query()/.execute()`: se PROHÍBE construir SQL por
 *     concatenación (`.query('…' + x)`) o componer un query desde un fragmento
 *     (`.query(\`${base} …\`)`) — los dos vectores que un candado basado solo en
 *     literales completos no vería. El primer argumento debe ser un literal de
 *     template o un identificador simple.
 *
 * Residual conocido (documentado en threat model §5): una query armada en una
 * VARIABLE por pasos (`let q='…'; q+=input; query(q)`) pasa el primer-arg como
 * identificador; ese vector de dataflow lo cubren la revisión de código y la
 * suite behavioral (`packages/identity/test/sql-injection.test.ts`), no el
 * candado estático. No existe hoy en el código.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Raíces de código de RUNTIME (los tests y el build generado quedan fuera). */
const SCAN_ROOTS = ['packages', 'apps'];

/**
 * Interpolaciones PERMITIDAS dentro de un literal SQL. Cada una es un
 * identificador (lista de columnas o cláusula construida desde nombres
 * literales), NUNCA un valor — los valores viajan siempre por `$N`.
 */
const ALLOWED_INTERPOLATIONS: Record<string, string> = {
  // Listas de columnas constantes a nivel de módulo (verificado abajo: solo
  // identificadores, sin `${}`). Interpolar el SELECT-list es identifier-safe.
  CUSTOMER_COLUMNS: 'lista de columnas constante',
  REFUND_COLUMNS: 'lista de columnas constante',
  PAYOUT_COLUMNS: 'lista de columnas constante',
  INTENT_COLUMNS: 'lista de columnas constante',
  DISPUTE_COLUMNS: 'lista de columnas constante',
  LINK_COLUMNS: 'lista de columnas constante',
  CASE_COLUMNS: 'lista de columnas constante',
  EVENT_COLUMNS: 'lista de columnas constante',
  COLS: 'lista de columnas constante (case_adjustments)',
  // El SET de customers.update se arma desde una tupla LITERAL de campos
  // (`['email','name','phone','description']`) donde cada entrada es
  // `${field} = $N`: el identificador es literal, el valor va por `$N`.
  "sets.join(', ')": 'cláusula SET desde tupla de campos literal; valores por $N',
  // RA-F6-001: la entrada `this.lockTimeoutMs` (SET LOCAL interpolado en
  // @fluvia/idempotency) se ELIMINÓ — el servicio ahora pasa por
  // withTenantTransaction, que usa set_config(..., true) parametrizado.
};

/** Constantes que DEBEN ser puras listas de columnas (candado secundario). */
const COLUMN_CONSTANTS = Object.keys(ALLOWED_INTERPOLATIONS).filter((k) => /^[A-Z_]+$/.test(k));

/**
 * Un literal es SQL si, tras BLANQUEAR sus interpolaciones (para que un
 * `.update(` o un `from` DENTRO de `${…}` no cuenten) y recortar, EMPIEZA con
 * un verbo de sentencia SQL. Cubre todas las queries del código (siempre son
 * sentencias completas: SELECT/INSERT/UPDATE/DELETE/WITH/SET LOCAL); descarta
 * prosa como `no transition from ${x}` o `mock_${hash}`.
 */
const SQL_STATEMENT_START = /^(WITH|SELECT|INSERT|UPDATE|DELETE|SET)\b/i;

function isSqlLiteral(literal: string): boolean {
  const inner = literal.slice(1, -1); // sin los backticks
  const blanked = inner.replace(/\$\{[^}]*\}/g, ' ').trim();
  return SQL_STATEMENT_START.test(blanked);
}

/**
 * Directorios FUERA del alcance: `scripts` (codegen dev, p. ej. la semilla FSM
 * — input del desarrollador, no de la red) y `drills` (tooling de DR que corre
 * un operador). El gate cubre el código que sirve requests; ninguno de estos
 * recibe input externo. Excluirlos es explícito, no un descuido.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', '__tests__', 'scripts', 'drills']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Literales de template (sin backticks anidados — cierto en el código SQL). */
function templateLiterals(src: string): string[] {
  return src.match(/`(?:[^`\\]|\\.)*`/gs) ?? [];
}

function interpolations(literal: string): string[] {
  return [...literal.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!.trim());
}

/**
 * Extrae el PRIMER argumento de cada `.query(…)` / `.execute(…)`, respetando
 * strings (comilla simple/doble/backtick) y anidamiento de paréntesis, de modo
 * que una `,` o `)` dentro de un literal no corte el argumento antes de tiempo.
 */
function queryFirstArgs(src: string): string[] {
  const args: string[] = [];
  const re = /\.(?:query|execute)\s*\(/g;
  while (re.exec(src) !== null) {
    let i = re.lastIndex;
    let depth = 1;
    let str: string | null = null;
    let arg = '';
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]!;
      if (str) {
        arg += ch;
        if (ch === str && src[i - 1] !== '\\') str = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        str = ch;
        arg += ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) break;
      } else if (ch === ',' && depth === 1) break;
      arg += ch;
    }
    args.push(arg.trim());
  }
  return args;
}

const runtimeFiles = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

describe('parametrización SQL — candado estático (threat model §5)', () => {
  it('scans a non-trivial amount of runtime source (anti-vacuidad)', () => {
    expect(runtimeFiles.length).toBeGreaterThan(50);
  });

  it('every ${…} inside a SQL literal interpolates a vetted identifier, never a value', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();

    for (const file of runtimeFiles) {
      const src = readFileSync(file, 'utf8');
      for (const literal of templateLiterals(src)) {
        if (!isSqlLiteral(literal)) continue;
        for (const token of interpolations(literal)) {
          seen.add(token);
          if (!(token in ALLOWED_INTERPOLATIONS)) {
            offenders.push(`${relative(REPO_ROOT, file)}: \${${token}}`);
          }
        }
      }
    }

    expect(
      offenders,
      `interpolación NO vetada en un literal SQL:\n${offenders.join('\n')}`
    ).toEqual([]);
    // Non-vacuidad: el escaneo realmente encontró interpolaciones SQL.
    expect(seen.size).toBeGreaterThan(5);
    // Sin allowlist muerto: toda entrada permitida se usa de verdad (si una
    // deja de usarse, se elimina — el allowlist no acumula permisos zombis).
    for (const allowed of Object.keys(ALLOWED_INTERPOLATIONS)) {
      expect(seen.has(allowed), `entrada de allowlist sin uso: ${allowed}`).toBe(true);
    }
  });

  it('each whitelisted COLUMN constant is a pure identifier list (no value can hide in it)', () => {
    // Localiza `const NAME = \`…\`` y exige que el contenido sean solo
    // identificadores/casts/aliases — sin `${}`, sin operadores de valor.
    const defs = new Map<string, string>();
    for (const file of runtimeFiles) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/const\s+([A-Z_]+)\s*=\s*`([^`]*)`/g)) {
        defs.set(m[1]!, m[2]!);
      }
    }
    for (const name of COLUMN_CONSTANTS) {
      const body = defs.get(name);
      expect(body, `no se encontró la definición de ${name}`).toBeDefined();
      expect(body).not.toContain('${');
      // Solo columnas: letras/dígitos/_ , . ( ) espacio, cast `::`, alias `AS`,
      // comilla simple de literales de casteo. Nada de `;` o `=` (value ops).
      expect(body!, `${name} contiene algo que no es una lista de columnas`).toMatch(
        /^[\w\s,.():'*]+$/
      );
    }
  });
});

describe('parametrización SQL — forma del argumento de query (threat model §5)', () => {
  it('no .query()/.execute() builds SQL by concatenation or from a leading-${} fragment', () => {
    const concatOffenders: string[] = [];
    const fragmentOffenders: string[] = [];
    let total = 0;

    for (const file of runtimeFiles) {
      const src = readFileSync(file, 'utf8');
      for (const arg of queryFirstArgs(src)) {
        if (arg === '') continue; // `.query()` sin args (poco probable): nada que auditar
        total += 1;
        // Concatenación: un string pegado a un `+` construye SQL con datos.
        if (/['"`]\s*\+|\+\s*['"`]/.test(arg)) {
          concatOffenders.push(`${relative(REPO_ROOT, file)}: ${arg.slice(0, 60)}`);
        }
        // Fragmento: un literal que ARRANCA con `${…}` no es una sentencia
        // completa — el candado de interpolación (start-verb) no lo inspecciona,
        // así que se prohíbe de plano (escribe la sentencia completa con $N).
        if (arg.startsWith('`${')) {
          fragmentOffenders.push(`${relative(REPO_ROOT, file)}: ${arg.slice(0, 60)}`);
        }
      }
    }

    expect(total, 'anti-vacuidad: se auditó al menos un .query()').toBeGreaterThan(10);
    expect(
      concatOffenders,
      `SQL por concatenación (usa $N):\n${concatOffenders.join('\n')}`
    ).toEqual([]);
    expect(
      fragmentOffenders,
      `query compuesto desde un fragmento \${…} inicial:\n${fragmentOffenders.join('\n')}`
    ).toEqual([]);
  });
});

describe('lint de arquitectura — las rutas no tocan el pool admin (threat model §5)', () => {
  it('no file under apps/*/src/routes constructs or imports an admin pool', () => {
    const routeDirs = readdirSync(join(REPO_ROOT, 'apps'))
      .map((app) => join(REPO_ROOT, 'apps', app, 'src', 'routes'))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      });
    expect(routeDirs.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const dir of routeDirs) {
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf8');
        // El pool admin (superusuario, sin RLS) jamás debe instanciarse ni
        // referenciarse desde una ruta: las rutas reciben servicios ya
        // cableados sobre el pool `fluvia_app` (RLS forzado).
        if (/\bcreatePool\b|\badminPool\b|\bADMIN_DATABASE\b|\.admin\b/.test(src)) {
          offenders.push(relative(REPO_ROOT, file));
        }
      }
    }
    expect(offenders, `una ruta referencia el pool admin:\n${offenders.join('\n')}`).toEqual([]);
  });
});
