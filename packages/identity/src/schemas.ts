import { z } from 'zod';
import { CURRENCY_CODES, type CurrencyCode } from '@fluvia/money';

/**
 * DTOs de entrada del dominio identity. Todos `.strict()`:
 * una clave desconocida es un error, no un dato ignorado (anti mass-assignment).
 */

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export const CreateOrganizationSchema = z
  .object({
    organizationName: z.string().trim().min(2).max(120),
    slug: z
      .string()
      .regex(SLUG_RE, 'slug must be lowercase alphanumeric with hyphens (2-49 chars)'),
    ownerEmail: z.string().trim().email().max(254),
  })
  .strict();

export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;

export const CreateMerchantSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code')
      .default('CO'),
    defaultCurrency: z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]).default('COP'),
  })
  .strict();

export type CreateMerchantInput = z.input<typeof CreateMerchantSchema>;

export const UpdateMerchantSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
  })
  .strict();

export type UpdateMerchantInput = z.infer<typeof UpdateMerchantSchema>;
