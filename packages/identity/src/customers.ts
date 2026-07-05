import { withTenantTransaction, type Pool } from '@fluvia/db';
import { CustomerNotFoundError } from './errors.js';
import {
  CreateCustomerSchema,
  UpdateCustomerSchema,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from './schemas.js';

/**
 * Customers (F3-05a) — plano de integración (API key, scope customers:write /
 * read). Primer consumidor real: el checkout de F3-05. RLS es la segunda línea
 * de defensa en cada query (rol fluvia_app dentro de withTenantTransaction).
 *
 * DTO whitelisted explícito, jamás spread de la fila.
 */

export interface CustomerDto {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  description: string | null;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface CustomerRow {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  description: string | null;
  metadata: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

const CUSTOMER_COLUMNS = `id, email, name, phone, description, metadata, created_at, updated_at`;

function toDto(r: CustomerRow): CustomerDto {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    phone: r.phone,
    description: r.description,
    metadata: r.metadata,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class CustomerService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool
  ) {}

  async create(tenantId: string, rawInput: CreateCustomerInput): Promise<CustomerDto> {
    const input = CreateCustomerSchema.parse(rawInput);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<CustomerRow>(
        `INSERT INTO customers (tenant_id, email, name, phone, description, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${CUSTOMER_COLUMNS}`,
        [
          tenantId,
          input.email ?? null,
          input.name ?? null,
          input.phone ?? null,
          input.description ?? null,
          JSON.stringify(input.metadata ?? {}),
        ]
      );
      return toDto(res.rows[0]!);
    });
  }

  async get(tenantId: string, customerId: string): Promise<CustomerDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<CustomerRow>(
        `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = $1 AND deleted_at IS NULL`,
        [customerId]
      );
      if (!res.rows[0]) throw new CustomerNotFoundError();
      return toDto(res.rows[0]);
    });
  }

  async list(tenantId: string, limit = 20): Promise<CustomerDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<CustomerRow>(
        `SELECT ${CUSTOMER_COLUMNS} FROM customers
         WHERE deleted_at IS NULL ORDER BY created_at DESC, id LIMIT $1`,
        [capped]
      );
      return res.rows.map(toDto);
    });
  }

  /**
   * Update parcial: solo las claves presentes cambian. `null` en
   * email/name/phone/description limpia el campo; metadata REEMPLAZA la bolsa
   * completa (semántica de recurso, no merge — el integrador manda el estado
   * deseado). RLS hace indistinguible el customer ajeno del inexistente.
   */
  async update(
    tenantId: string,
    customerId: string,
    rawInput: UpdateCustomerInput
  ): Promise<CustomerDto> {
    const input = UpdateCustomerSchema.parse(rawInput);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const sets: string[] = [];
      const values: unknown[] = [customerId];
      for (const field of ['email', 'name', 'phone', 'description'] as const) {
        if (field in input) {
          values.push(input[field] ?? null);
          sets.push(`${field} = $${values.length}`);
        }
      }
      if (input.metadata !== undefined) {
        values.push(JSON.stringify(input.metadata));
        sets.push(`metadata = $${values.length}::jsonb`);
      }
      sets.push('updated_at = now()');
      const res = await c.query<CustomerRow>(
        `UPDATE customers SET ${sets.join(', ')}
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING ${CUSTOMER_COLUMNS}`,
        values
      );
      if (!res.rows[0]) throw new CustomerNotFoundError();
      return toDto(res.rows[0]);
    });
  }

  /** Baja lógica (deleted_at). El histórico permanece; el customer desaparece
   *  de get/list. Idempotente: borrar dos veces no es error de estado. */
  async softDelete(tenantId: string, customerId: string): Promise<{ id: string; deleted: true }> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<{ id: string }>(
        `UPDATE customers SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
         WHERE id = $1 RETURNING id`,
        [customerId]
      );
      if (!res.rows[0]) throw new CustomerNotFoundError();
      return { id: res.rows[0].id, deleted: true };
    });
  }
}
