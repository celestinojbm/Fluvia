import { describe, expect, it } from 'vitest';
import { isoDateTimeWithOffset } from '../src/iso-datetime.js';

/**
 * Migración zod 3 → 4: `z.string().datetime({ offset: true })` de zod 4 rechaza
 * formatos que zod 3 aceptaba. `isoDateTimeWithOffset()` conserva el contrato
 * de zod 3. La tabla sale de ejecutar zod 3.25.76 y 4.6.7 sobre las mismas
 * entradas. Unit puro: no toca la BD.
 */
describe('isoDateTimeWithOffset — mismo contrato de entrada que zod 3', () => {
  const schema = isoDateTimeWithOffset();

  const acceptedByZod3 = [
    '2026-07-04T12:00:00Z',
    '2026-07-04T12:00:00.123456Z',
    '2026-07-04T12:00:00+05:00',
    '2026-07-04T07:00:00-05:00',
    // Las dos que zod 4 rechaza por defecto:
    '2026-07-04T12:00:00+0500',
    '2026-07-04T07:00:00.250-0500',
    '2026-07-04T12:00Z',
    '2026-07-04T12:00-05:00',
    '2026-07-04T12:00-0500',
  ];
  const rejectedByZod3 = [
    '2026-07-04T12:00:00', // sin zona
    '2026-07-04', // solo fecha
    '2026-07-04 12:00:00Z', // espacio en vez de T
    '2026-07-04t12:00:00z', // minúsculas
    '2026-07-04T12:00:00+05', // offset de solo horas
    '2026-02-30T12:00:00Z', // fecha imposible
    '2026-07-04T24:00:00Z', // hora imposible
    '2026-07-04T12:00:00+05:00junk',
    'yesterday',
    '',
  ];

  it.each(acceptedByZod3)('accepts %s and returns it unchanged', (value) => {
    const r = schema.safeParse(value);
    expect(r.success).toBe(true);
    expect(r.data).toBe(value);
  });

  it.each(rejectedByZod3)('rejects %j', (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('accepted values parse to the same instant as their canonical form', () => {
    expect(new Date('2026-07-04T12:00:00+0500').toISOString()).toBe('2026-07-04T07:00:00.000Z');
    expect(new Date('2026-07-04T12:00Z').toISOString()).toBe('2026-07-04T12:00:00.000Z');
    expect(new Date('2026-07-04T12:00-0500').toISOString()).toBe('2026-07-04T17:00:00.000Z');
  });

  it('rejects non-strings without coercion', () => {
    for (const bad of [null, undefined, 1_783_166_400_000, new Date()]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });
});
