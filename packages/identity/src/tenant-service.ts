import { withTenantTransaction, type Pool } from '@fluvia/db';
import { insertAuditEvent, type AuditContext } from '@fluvia/audit';
import {
  MerchantNameTakenError,
  MerchantNotFoundError,
  OrganizationNotFoundError,
  isUniqueViolation,
} from './errors.js';
import {
  CreateMerchantSchema,
  UpdateMerchantSchema,
  type CreateMerchantInput,
  type UpdateMerchantInput,
} from './schemas.js';

/** DTOs de salida: campos whitelisted explicitamente, jamas spread de la fila. */
export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface MerchantDto {
  id: string;
  name: string;
  country: string;
  defaultCurrency: string;
  status: 'active' | 'frozen';
  createdAt: string;
}

export interface MemberDto {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  since: string;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
}

interface MerchantRow {
  id: string;
  name: string;
  country: string;
  default_currency: string;
  status: 'active' | 'frozen';
  created_at: Date;
}

const toMerchantDto = (r: MerchantRow): MerchantDto => ({
  id: r.id,
  name: r.name,
  country: r.country,
  defaultCurrency: r.default_currency,
  status: r.status,
  createdAt: r.created_at.toISOString(),
});

/**
 * PLANO DE TENANT: todas las operaciones corren con el rol fluvia_app dentro
 * de withTenantTransaction — RLS es la segunda linea de defensa en cada query.
 */
export class IdentityService {
  constructor(private readonly appPool: Pool) {}

  async getOrganization(tenantId: string): Promise<OrganizationDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<OrgRow>(
        'SELECT id, name, slug, created_at FROM organizations WHERE deleted_at IS NULL'
      );
      const row = res.rows[0];
      if (!row) throw new OrganizationNotFoundError();
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  async createMerchant(
    tenantId: string,
    rawInput: CreateMerchantInput,
    audit?: AuditContext
  ): Promise<MerchantDto> {
    const input = CreateMerchantSchema.parse(rawInput);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      try {
        const res = await c.query<MerchantRow>(
          `INSERT INTO merchants (tenant_id, name, country, default_currency)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, country, default_currency, status, created_at`,
          [tenantId, input.name, input.country, input.defaultCurrency]
        );
        const dto = toMerchantDto(res.rows[0]!);
        if (audit) {
          await insertAuditEvent(c, {
            action: 'merchant.created',
            tenantId,
            context: audit,
            resourceType: 'merchant',
            resourceId: dto.id,
            after: { name: dto.name, country: dto.country, defaultCurrency: dto.defaultCurrency },
          });
        }
        return dto;
      } catch (err) {
        if (isUniqueViolation(err, 'merchants_tenant_id_name_key')) {
          throw new MerchantNameTakenError(input.name);
        }
        throw err;
      }
    });
  }

  async listMerchants(tenantId: string): Promise<MerchantDto[]> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<MerchantRow>(
        `SELECT id, name, country, default_currency, status, created_at
         FROM merchants WHERE deleted_at IS NULL ORDER BY created_at`
      );
      return res.rows.map(toMerchantDto);
    });
  }

  async getMerchant(tenantId: string, merchantId: string): Promise<MerchantDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<MerchantRow>(
        `SELECT id, name, country, default_currency, status, created_at
         FROM merchants WHERE id = $1 AND deleted_at IS NULL`,
        [merchantId]
      );
      const row = res.rows[0];
      if (!row) throw new MerchantNotFoundError();
      return toMerchantDto(row);
    });
  }

  async updateMerchant(
    tenantId: string,
    merchantId: string,
    rawInput: UpdateMerchantInput,
    audit?: AuditContext
  ): Promise<MerchantDto> {
    const input = UpdateMerchantSchema.parse(rawInput);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      try {
        const previous = await c.query<{ name: string }>(
          'SELECT name FROM merchants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
          [merchantId]
        );
        if (previous.rowCount === 0) throw new MerchantNotFoundError();
        const res = await c.query<MerchantRow>(
          `UPDATE merchants SET name = $2, updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL
           RETURNING id, name, country, default_currency, status, created_at`,
          [merchantId, input.name]
        );
        const dto = toMerchantDto(res.rows[0]!);
        if (audit) {
          await insertAuditEvent(c, {
            action: 'merchant.updated',
            tenantId,
            context: audit,
            resourceType: 'merchant',
            resourceId: dto.id,
            before: { name: previous.rows[0]!.name },
            after: { name: dto.name },
          });
        }
        return dto;
      } catch (err) {
        if (isUniqueViolation(err, 'merchants_tenant_id_name_key')) {
          throw new MerchantNameTakenError(input.name);
        }
        throw err;
      }
    });
  }

  /** Rol del usuario dentro del tenant (o null si no es miembro activo). RLS aplica. */
  async getMemberRole(tenantId: string, userId: string): Promise<string | null> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<{ role: string }>(
        'SELECT role FROM memberships WHERE user_id = $1 AND revoked_at IS NULL',
        [userId]
      );
      return res.rows[0]?.role ?? null;
    });
  }

  async listMembers(tenantId: string): Promise<MemberDto[]> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<{
        membership_id: string;
        user_id: string;
        email: string;
        role: string;
        created_at: Date;
      }>(
        `SELECT m.id AS membership_id, u.id AS user_id, u.email, m.role, m.created_at
         FROM memberships m
         JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
         WHERE m.revoked_at IS NULL
         ORDER BY m.created_at`
      );
      return res.rows.map((r) => ({
        membershipId: r.membership_id,
        userId: r.user_id,
        email: r.email,
        role: r.role,
        since: r.created_at.toISOString(),
      }));
    });
  }
}
