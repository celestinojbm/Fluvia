import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESENTATION_IMAGES } from '../../../packages/commerce/src/presentation-images';
import { PRESENTATION_CREDITS } from '../app/lib/presentation-credits';
import { CATEGORIES } from '../app/lib/categories';

/**
 * Fotos de la presentación: conjunto cerrado, CC0 verificada en origen, y la
 * copia de créditos del panel idéntica a la fuente de verdad.
 */
const DIR = resolve(__dirname, '../public/presentacion');

describe('fotos de la presentación', () => {
  it('cada referencia tiene su archivo y no hay archivos sin registrar', () => {
    const files = readdirSync(DIR).sort();
    expect(files).toEqual(
      PRESENTATION_IMAGES.map((i) => i.ref.replace('presentacion/', '')).sort()
    );
    for (const i of PRESENTATION_IMAGES)
      expect(existsSync(resolve(DIR, i.ref.split('/')[1]!))).toBe(true);
  });

  it('solo CC0 1.0 con procedencia y huella del original', () => {
    for (const i of PRESENTATION_IMAGES) {
      expect(i.license).toBe('CC0-1.0');
      expect(i.sourceUrl).toMatch(/^https:\/\/www\.flickr\.com\/photos\//);
      expect(i.verification).toContain('license id 9');
      expect(i.originalSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('los archivos servidos son JPEG sin metadatos EXIF', () => {
    for (const i of PRESENTATION_IMAGES) {
      const buf = readFileSync(resolve(DIR, i.ref.split('/')[1]!));
      expect(buf.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(buf.includes(Buffer.from('Exif'))).toBe(false);
      // huella distinta del original: el archivo servido es el recorte procesado
      expect(createHash('sha256').update(buf).digest('hex')).not.toBe(i.originalSha256);
    }
  });

  it('los créditos del panel coinciden con la fuente de verdad', () => {
    expect(PRESENTATION_CREDITS).toEqual(
      PRESENTATION_IMAGES.map((i) => ({
        ref: i.ref,
        label: i.label,
        title: i.title,
        creator: i.creator,
        sourceUrl: i.sourceUrl,
      }))
    );
  });

  it('cada categoría usa una foto del conjunto', () => {
    for (const c of CATEGORIES) {
      expect(PRESENTATION_IMAGES.map((i) => `/${i.ref}`)).toContain(c.photo);
    }
  });
});
