import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Identidad «Menta»: brand.css es la fuente ÚNICA de color y tipografía y es
 * idéntico en el panel y en el checkout. Aquí se verifica la paleta exacta del
 * encargo, el contraste de cada par texto/fondo que usa la interfaz y que
 * ninguna hoja de pantalla reintroduce la identidad anterior.
 */
const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const brand = read('app/brand.css');

function token(name: string): string {
  const m = brand.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} sin valor hex`);
  return m[1]!.toLowerCase();
}

function lum(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('identidad Menta: tokens', () => {
  it('brand.css es idéntico en dashboard y checkout', () => {
    expect(read('../checkout/app/brand.css')).toBe(brand);
  });

  it('paleta exacta del encargo', () => {
    expect(token('fl-mint')).toBe('#b2fce4');
    expect(token('fl-black')).toBe('#000000');
    expect(token('fl-white')).toBe('#ffffff');
    expect(token('fl-ink-2')).toBe('#404040');
    expect(token('fl-line')).toBe('#d9e2de');
  });

  it('Manrope alojada localmente es la primera fuente', () => {
    expect(brand).toMatch(/--fl-font:\s*'Manrope Variable'/);
    for (const layout of ['app/layout.tsx', '../checkout/app/layout.tsx']) {
      expect(read(layout)).toContain("import '@fontsource-variable/manrope';");
    }
  });

  const mint = token('fl-mint');
  const white = token('fl-white');
  const black = token('fl-black');
  // [texto, fondo, mínimo]: 4.5 texto normal; 3 bordes de control (1.4.11).
  const pairs: Array<[string, string, string, number]> = [
    ['texto principal / menta', black, mint, 4.5],
    ['texto principal / blanco', black, white, 4.5],
    ['secundario / menta', token('fl-ink-2'), mint, 4.5],
    ['secundario / blanco', token('fl-ink-2'), white, 4.5],
    ['secundario / zona hundida', token('fl-ink-2'), token('fl-surface-2'), 4.5],
    ['botón primario (blanco / negro)', white, black, 4.5],
    ['menta sobre negro (etiquetas del terminal)', mint, black, 4.5],
    ['borde de campo / blanco', token('fl-ink-2'), white, 3],
    ['ok / blanco', token('fl-ok'), white, 4.5],
    ['ok / suave', token('fl-ok'), token('fl-ok-soft'), 4.5],
    ['ok / menta', token('fl-ok'), mint, 4.5],
    ['aviso / blanco', token('fl-warn'), white, 4.5],
    ['aviso / suave', token('fl-warn'), token('fl-warn-soft'), 4.5],
    ['error / blanco', token('fl-bad'), white, 4.5],
    ['error / suave', token('fl-bad'), token('fl-bad-soft'), 4.5],
    ['error / menta', token('fl-bad'), mint, 4.5],
    ['error sobre negro', token('fl-bad-on-dark'), black, 4.5],
    ['crédito / blanco', token('fl-credit'), white, 4.5],
    ['crédito / suave', token('fl-credit'), token('fl-credit-soft'), 4.5],
    ['crédito / menta', token('fl-credit'), mint, 4.5],
    ['simulación / suave', token('fl-sim'), token('fl-sim-soft'), 4.5],
    ['blanco sobre error (fecha vencida)', white, token('fl-bad'), 4.5],
  ];
  it.each(pairs)('contraste %s', (_name, fg, bg, min) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});

describe('identidad Menta: sin restos de la identidad anterior', () => {
  // Arena, verde azulado («río»), sol y el azul del panel heredado.
  const LEGACY = [
    '#f6f2eb',
    '#efe9df',
    '#e4dccf',
    '#f3e7d1',
    '#0b6b6b',
    '#08504f',
    '#0a6470',
    '#074b54',
    '#0d2e2d',
    '#e9a23b',
    '#ffd75e',
    '#a9c9c5',
  ];
  const SHEETS = [
    'app/globals.css',
    'app/platform.css',
    'app/personal/personal.css',
    'app/operaciones/ops.css',
    '../checkout/app/globals.css',
  ];
  it.each(SHEETS)('%s no usa colores de la identidad anterior', (sheet) => {
    const css = read(sheet).toLowerCase();
    for (const hex of LEGACY) expect(css, `${sheet} contiene ${hex}`).not.toContain(hex);
  });
  it.each(SHEETS)('%s no redefine tokens de color en :root', (sheet) => {
    const css = read(sheet);
    const roots = css.match(/:root\s*\{[^}]*\}/g) ?? [];
    for (const r of roots) expect(r, sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
