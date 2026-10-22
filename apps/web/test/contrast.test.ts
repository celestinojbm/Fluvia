import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

const mint = '#b2fce4';
const black = '#000000';
const white = '#ffffff';
const ink = '#404040';
const ok = '#146c2e';
const warn = '#8a4b00';
const sim = '#5a3b9c';
const bad = '#b42318';

describe('contraste de la landing', () => {
  it.each([
    ['texto / menta', black, mint, 4.5],
    ['texto / blanco', black, white, 4.5],
    ['secundario / blanco', ink, white, 4.5],
    ['secundario / menta', ink, mint, 4.5],
    ['menta / negro', mint, black, 4.5],
    ['blanco / negro', white, black, 4.5],
    ['confirmado / blanco', ok, white, 4.5],
    ['aviso / blanco', warn, white, 4.5],
    ['simulación / blanco', sim, white, 4.5],
    ['error / blanco', bad, white, 4.5],
    ['error / hover destructivo', bad, '#fdf1ef', 4.5],
    ['negro / menta hover', black, '#9df5d8', 4.5],
    ['blanco / negro hover', white, '#262626', 4.5],
  ])('%s ≥ %s', (_name, fg, bg, min) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it('el símbolo de la landing es el SVG de marca, sin otro trazo', () => {
    const root = resolve(__dirname, '../../..');
    const svg = readFileSync(
      resolve(root, 'docs/design/brand/svg/fluvia-simbolo-negro.svg'),
      'utf8'
    );
    const brand = readFileSync(resolve(root, 'apps/web/app/brand.tsx'), 'utf8');
    const band = 'M0 17h14c10 0 10 14 20 14h14';
    expect(svg).toContain(band);
    expect(svg).toContain('#B2FCE4');
    expect(brand).toContain(band);
    expect(brand).toContain('viewBox="0 0 48 48"');
    expect(brand).toContain('viewBox="0 28 255 72"');
  });
});
