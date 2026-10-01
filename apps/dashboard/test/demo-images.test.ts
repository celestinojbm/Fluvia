import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_PRODUCT_IMAGES } from '../../../packages/commerce/src/demo-images';

const pub = (app: string) => resolve(__dirname, `../../${app}/public`);

describe('imágenes de demostración: conjunto cerrado, con origen y licencia', () => {
  it('cada referencia existe, idéntica, en el dashboard y en el checkout', () => {
    for (const img of DEMO_PRODUCT_IMAGES) {
      const a = resolve(pub('dashboard'), img.ref);
      const b = resolve(pub('checkout'), img.ref);
      expect(existsSync(a), a).toBe(true);
      const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
      expect(hash(b)).toBe(hash(a));
    }
  });

  it('no hay imágenes servidas sin registro de origen y licencia', () => {
    for (const app of ['dashboard', 'checkout']) {
      const files = readdirSync(resolve(pub(app), 'catalog')).map((f) => `catalog/${f}`);
      expect(files.sort()).toEqual(DEMO_PRODUCT_IMAGES.map((i) => i.ref).sort());
    }
  });

  it('solo CC0 1.0 con página de origen', () => {
    for (const img of DEMO_PRODUCT_IMAGES) {
      expect(img.license).toBe('CC0-1.0');
      expect(img.sourceUrl).toMatch(/^https:\/\/(www\.flickr\.com|stocksnap\.io)\//);
      expect(img.ref).toMatch(/^catalog\/[a-z0-9-]{1,48}\.jpg$/);
    }
  });
});
