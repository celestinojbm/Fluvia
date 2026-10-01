import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { CustomerNotVisibleError } from './errors.js';

/**
 * Clientes del comercio en el plano de SESIÓN (ficha mínima). Reutiliza la
 * tabla `customers` existente (F3-05a, RLS forzado): misma fuente que el plano
 * de API key, sin duplicar entidades. La validación de forma la hace la ruta
 * con los schemas de @fluvia/identity; aquí solo persistencia + búsqueda +
 * compras vinculadas (resumen por moneda).
 */

export interface CustomerCardDto {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  orderCount: number;
  lastOrderAt: string | null;
}

export interface CustomerFields {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  description?: string | null;
}

interface Row {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
  created_at: Date;
  updated_at: Date;
  order_count: number;
  last_order_at: Date | null;
}

const SELECT = `
  SELECT cu.id, cu.name, cu.email, cu.phone, cu.description, cu.created_at, cu.updated_at,
         (SELECT count(*)::int FROM commerce_orders o WHERE o.customer_id = cu.id) AS order_count,
         (SELECT max(o.created_at) FROM commerce_orders o WHERE o.customer_id = cu.id)
           AS last_order_at
  FROM customers cu`;

const toDto = (r: Row): CustomerCardDto => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  description: r.description,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  orderCount: r.order_count,
  lastOrderAt: r.last_order_at?.toISOString() ?? null,
});

export class CustomerDirectory {
  constructor(private readonly appPool: Pool) {}

  async list(tenantId: string, q?: string, limit = 50): Promise<CustomerCardDto[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const values: unknown[] = [];
      let where = 'WHERE cu.deleted_at IS NULL';
      const t = q?.trim();
      if (t) {
        values.push(`%${t.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
        where += ` AND (cu.name ILIKE $1 OR cu.email ILIKE $1 OR cu.phone ILIKE $1)`;
      }
      values.push(capped);
      const res = await c.query<Row>(
        `${SELECT} ${where} ORDER BY lower(coalesce(cu.name, cu.email, '')), cu.id
         LIMIT $${values.length}`,
        values
      );
      return res.rows.map(toDto);
    });
  }

  async get(tenantId: string, id: string): Promise<CustomerCardDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => this.getIn(c, id));
  }

  private async getIn(c: PoolClient, id: string): Promise<CustomerCardDto> {
    const res = await c.query<Row>(`${SELECT} WHERE cu.id = $1 AND cu.deleted_at IS NULL`, [id]);
    if (!res.rows[0]) throw new CustomerNotVisibleError();
    return toDto(res.rows[0]);
  }

  async create(
    tenantId: string,
    fields: CustomerFields,
    audit?: (c: PoolClient, after: CustomerCardDto) => Promise<void>
  ): Promise<CustomerCardDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, name, email, phone, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          tenantId,
          fields.name ?? null,
          fields.email ?? null,
          fields.phone ?? null,
          fields.description ?? null,
        ]
      );
      const dto = await this.getIn(c, ins.rows[0]!.id);
      await audit?.(c, dto);
      return dto;
    });
  }

  async update(
    tenantId: string,
    id: string,
    fields: CustomerFields,
    audit?: (c: PoolClient, after: CustomerCardDto) => Promise<void>
  ): Promise<CustomerCardDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const sets: string[] = [];
      const values: unknown[] = [id];
      for (const k of ['name', 'email', 'phone', 'description'] as const) {
        if (fields[k] !== undefined) {
          values.push(fields[k]);
          sets.push(`${k} = $${values.length}`);
        }
      }
      sets.push('updated_at = now()');
      const res = await c.query(
        `UPDATE customers SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
        values
      );
      if ((res.rowCount ?? 0) === 0) throw new CustomerNotVisibleError();
      const dto = await this.getIn(c, id);
      await audit?.(c, dto);
      return dto;
    });
  }
}
