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

/**
 * Metadata de recurso (semántica tipo Stripe): hasta 50 claves, clave ≤40 y
 * valor ≤500 caracteres. Bolsa de datos del comercio, jamás interpretada por
 * Fluvia — pero acotada para que no sea un vector de abuso de almacenamiento.
 */
export const ResourceMetadataSchema = z
  .record(z.string().trim().min(1).max(40), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 50, 'metadata allows at most 50 keys');

// Al menos un campo identificatorio: un customer totalmente vacío no tiene
// sentido y suele ser un error del integrador.
const CustomerCore = {
  email: z.string().trim().email().max(254).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  metadata: ResourceMetadataSchema.optional(),
};

export const CreateCustomerSchema = z
  .object(CustomerCore)
  .strict()
  .refine(
    (c) => c.email !== undefined || c.name !== undefined || c.phone !== undefined,
    'a customer requires at least one of: email, name, phone'
  );

export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

// Update: todos los campos opcionales; al menos uno presente (un PATCH vacío
// no es una operación válida). `null` limpia el campo (email/name/phone/desc).
export const UpdateCustomerSchema = z
  .object({
    email: z.string().trim().email().max(254).nullable().optional(),
    name: z.string().trim().min(1).max(200).nullable().optional(),
    phone: z.string().trim().min(1).max(40).nullable().optional(),
    description: z.string().trim().min(1).max(500).nullable().optional(),
    metadata: ResourceMetadataSchema.optional(),
  })
  .strict()
  .refine((c) => Object.keys(c).length > 0, 'update requires at least one field');

export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;
