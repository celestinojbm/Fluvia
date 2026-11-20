import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CreateCustomerSchema,
  CreateMerchantSchema,
  CreateOrganizationForUserSchema,
  CreateOrganizationSchema,
  ResourceMetadataSchema,
  UpdateCustomerSchema,
  UpdateMerchantSchema,
} from '../src/index.js';

/**
 * Migración zod 3 → 4 — fija el comportamiento de los schemas de identidad que
 * zod 4 cambia sin que TypeScript lo detecte:
 *  - `.default()` se aplica incluso dentro de campos opcionales (riesgo de que
 *    un PATCH vacío sobrescriba datos): los schemas de update NO tienen
 *    defaults y deben seguir rechazando el cuerpo vacío.
 *  - `.uuid()` pasa a validar RFC 9562 (bits de versión/variante).
 *  - `.email()` cambia de regex.
 *  - `.strict()` sigue rechazando claves desconocidas.
 * Unit puro: no toca la BD.
 */

describe('identity schemas — contrato estable tras zod 4', () => {
  it('CreateMerchant applies CO/COP defaults only on create', () => {
    expect(CreateMerchantSchema.parse({ name: 'Tienda Uno' })).toEqual({
      name: 'Tienda Uno',
      country: 'CO',
      defaultCurrency: 'COP',
    });
    expect(
      CreateMerchantSchema.parse({ name: 'Tienda Dos', country: 'MX', defaultCurrency: 'COP' })
        .country
    ).toBe('MX');
    expect(CreateMerchantSchema.safeParse({ name: 'Tienda', country: 'col' }).success).toBe(false);
  });

  it('UpdateMerchant never injects defaults and rejects empty or unknown fields', () => {
    expect(UpdateMerchantSchema.safeParse({}).success).toBe(false);
    expect(UpdateMerchantSchema.parse({ name: 'Nuevo nombre' })).toEqual({ name: 'Nuevo nombre' });
    // country/defaultCurrency no se pueden colar por el PATCH (strict)
    expect(UpdateMerchantSchema.safeParse({ name: 'Nuevo', country: 'MX' }).success).toBe(false);
  });

  it('UpdateCustomer: empty PATCH is rejected, absent keys stay absent, null clears', () => {
    expect(UpdateCustomerSchema.safeParse({}).success).toBe(false);
    expect(UpdateCustomerSchema.parse({ name: 'Ana' })).toEqual({ name: 'Ana' });
    expect(UpdateCustomerSchema.parse({ email: null })).toEqual({ email: null });
    expect(UpdateCustomerSchema.safeParse({ name: 'Ana', extra: 1 }).success).toBe(false);
  });

  it('CreateCustomer still requires one identifying field', () => {
    expect(CreateCustomerSchema.safeParse({ description: 'sin identidad' }).success).toBe(false);
    expect(CreateCustomerSchema.safeParse({ phone: '+57 300 000 0000' }).success).toBe(true);
  });

  it('email validation: trims, accepts common addresses, rejects malformed ones', () => {
    const parse = (ownerEmail: string) =>
      CreateOrganizationSchema.safeParse({
        organizationName: 'Acme',
        slug: 'acme',
        ownerEmail,
      });
    for (const ok of ['ana@fluvia.co', 'ana.maria+pagos@sub.fluvia.com.co', '  ana@fluvia.co  ']) {
      expect(parse(ok).success, ok).toBe(true);
    }
    for (const bad of ['ana', 'ana@', '@fluvia.co', 'ana..maria@fluvia.co', 'ana@fluvia']) {
      expect(parse(bad).success, bad).toBe(false);
    }
  });

  it('uuid validation accepts gen_random_uuid()/randomUUID ids and rejects non-RFC 9562 ones', () => {
    const parse = (userId: string) =>
      CreateOrganizationForUserSchema.safeParse({ userId, organizationName: 'Acme', slug: 'acme' });
    expect(parse(randomUUID()).success).toBe(true);
    // Cambio deliberado de zod 4: el nibble de versión 0 ya no es un UUID válido.
    // Los ids de Fluvia salen de gen_random_uuid()/randomUUID (v4), así que no
    // afecta datos reales; este test documenta el endurecimiento.
    expect(parse('00000000-0000-0000-0000-000000000001').success).toBe(false);
    expect(parse('not-a-uuid').success).toBe(false);
  });

  it('metadata: string keys/values, bounded size, empty keys rejected', () => {
    expect(ResourceMetadataSchema.parse({ order: '42' })).toEqual({ order: '42' });
    expect(ResourceMetadataSchema.safeParse({ order: 42 }).success).toBe(false);
    expect(ResourceMetadataSchema.safeParse({ '  ': 'x' }).success).toBe(false);
    expect(ResourceMetadataSchema.safeParse({ k: 'x'.repeat(501) }).success).toBe(false);
    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']));
    expect(ResourceMetadataSchema.safeParse(tooMany).success).toBe(false);
  });
});
