import { z } from 'zod';

/**
 * Timestamp ISO-8601 con zona obligatoria (`Z` o offset numérico), con el
 * MISMO contrato de entrada que tenía `z.string().datetime({ offset: true })`
 * en zod 3.
 *
 * Por qué no usar directamente `z.iso.datetime({ offset: true })` de zod 4:
 * zod 4 endureció el formato y rechaza dos variantes que zod 3 aceptaba y que
 * los integradores sí envían (p. ej., en reportes de liquidación del proveedor):
 *  - offset sin dos puntos: `2026-07-04T12:00:00-0500` (lo que emiten
 *    `strftime('%z')` en Python y `DATE_ISO8601` en PHP);
 *  - hora con precisión de minutos: `2026-07-04T12:00Z`.
 * Ambas son instantes inequívocos que `new Date()` y Postgres (timestamptz)
 * interpretan bien. Rechazarlas tumbaría un lote completo de `lines` por una
 * cuestión de formato, así que se normalizan SOLO para validar. El valor que
 * sale del schema es el string original, igual que en zod 3.
 *
 * Lo demás sigue igual de estricto: sin zona (`2026-07-04T12:00:00`), offset
 * de solo horas (`+05`), fechas imposibles y `t`/`z` en minúscula se rechazan.
 */
const STRICT_ISO_DATETIME = z.iso.datetime({ offset: true });

const COMPACT_OFFSET = /([+-]\d{2})(\d{2})$/;
const MINUTE_PRECISION = /T(\d{2}:\d{2})(?=Z$|[+-]\d{2}:?\d{2}$)/;

function normalizeLegacyIsoDatetime(value: string): string {
  return value.replace(COMPACT_OFFSET, '$1:$2').replace(MINUTE_PRECISION, 'T$1:00');
}

export function isoDateTimeWithOffset() {
  return z
    .string()
    .refine((value) => STRICT_ISO_DATETIME.safeParse(normalizeLegacyIsoDatetime(value)).success, {
      message: 'Invalid ISO datetime',
    });
}
