import { z } from 'zod';
import { CURRENCY_CODES, type CurrencyCode } from './currency.js';
import { Money } from './money.js';

/**
 * Schema Zod para payloads monetarios (Directiva V3 seccion C:
 * validacion de tipos en tiempo de ejecucion en toda frontera).
 * `.strict()` rechaza claves extra: proteccion anti mass-assignment.
 */
export const MoneySchema = z
  .object({
    amount: z.string().regex(/^-?\d+$/, 'amount must be integer minor units as string'),
    currency: z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]),
  })
  .strict();

export type MoneyPayload = z.infer<typeof MoneySchema>;

export function moneyFromPayload(payload: unknown): Money {
  const parsed = MoneySchema.parse(payload);
  return Money.of(parsed.amount, parsed.currency);
}
