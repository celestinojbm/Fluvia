import { describe, expect, it } from 'vitest';
import { safePersonalNext } from '../app/personal/lib/next-path';

describe('safePersonalNext (vuelta tras «Entrar»)', () => {
  it('acepta rutas internas de Personal con su query', () => {
    expect(safePersonalNext('/personal/tiendas/casa-avila')).toBe('/personal/tiendas/casa-avila');
    expect(safePersonalNext('/personal/actividad?filtro=pedidos')).toBe(
      '/personal/actividad?filtro=pedidos'
    );
    expect(safePersonalNext('/personal')).toBe('/personal');
  });

  it('rechaza otros hosts, esquemas, rutas fuera de Personal y bucles', () => {
    for (const bad of [
      null,
      '',
      'https://evil.example/personal',
      '//evil.example/personal',
      '/personal//evil.example',
      '/\\evil.example',
      '/personal\\..\\o',
      'javascript:alert(1)',
      '/o/org/payments',
      '/personalidad',
      '/personal/entrar?next=/personal',
      `/personal/${'a'.repeat(400)}`,
    ]) {
      expect(safePersonalNext(bad), String(bad)).toBe('/personal');
    }
  });
});
