import { randomBytes } from 'node:crypto';
import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { CommerceError } from './errors.js';

/**
 * Estructura del local (0058) y PERMISOS EFECTIVOS del personal.
 *
 * Los permisos se resuelven en el servidor en cada acción a partir de la
 * membresía (owner/admin: todo) y de venue_staff (rol de local y sucursal).
 * Ocultar un botón en la interfaz no es la defensa.
 */

export const VENUE_ROLES = ['manager', 'cashier', 'waiter', 'kitchen'] as const;
export type VenueRole = (typeof VENUE_ROLES)[number];

export const VENUE_PERMISSIONS = [
  'orders:view',
  'orders:open',
  'orders:add',
  'orders:send',
  'orders:move',
  'orders:void_line',
  'orders:accept_customer',
  'bill:request',
  'bill:manage',
  'bill:collect',
  'kitchen:view',
  'kitchen:act',
  'kitchen:recall',
] as const;
export type VenuePermission = (typeof VENUE_PERMISSIONS)[number];

export const VENUE_ROLE_PERMISSIONS: Record<VenueRole, readonly VenuePermission[]> = {
  manager: VENUE_PERMISSIONS,
  cashier: [
    'orders:view',
    'orders:open',
    'orders:add',
    'orders:send',
    'orders:void_line',
    'orders:accept_customer',
    'bill:request',
    'bill:manage',
    'bill:collect',
  ],
  waiter: [
    'orders:view',
    'orders:open',
    'orders:add',
    'orders:send',
    'orders:move',
    'orders:accept_customer',
    'bill:request',
  ],
  kitchen: ['kitchen:view', 'kitchen:act'],
};

export class VenueForbiddenError extends CommerceError {
  constructor(readonly permission: VenuePermission) {
    super(`Venue permission required: ${permission}`);
  }
}
export class VenueNotFoundError extends CommerceError {
  constructor(what: string) {
    super(`${what} not found`);
  }
}
export class VenueConflictError extends CommerceError {
  constructor(what: string) {
    super(what);
  }
}

/** Acceso efectivo de un usuario: por sucursal (`*` = todas). */
export interface VenueAccess {
  userId: string;
  full: boolean;
  grants: Array<{ role: VenueRole; branchId: string | null }>;
}

export function venueCan(access: VenueAccess, perm: VenuePermission, branchId: string): boolean {
  if (access.full) return true;
  return access.grants.some(
    (g) =>
      (g.branchId === null || g.branchId === branchId) &&
      VENUE_ROLE_PERMISSIONS[g.role].includes(perm)
  );
}

export function assertVenue(access: VenueAccess, perm: VenuePermission, branchId: string): void {
  if (!venueCan(access, perm, branchId)) throw new VenueForbiddenError(perm);
}

export interface BranchDto {
  id: string;
  name: string;
}
export interface AreaDto {
  id: string;
  branchId: string;
  name: string;
}
export interface TableDto {
  id: string;
  branchId: string;
  areaId: string;
  label: string;
  capacity: number;
  qrToken: string;
}
export interface StationDto {
  id: string;
  branchId: string;
  code: string;
  name: string;
}
export interface ModifierOptionDto {
  id: string;
  name: string;
  priceDelta: bigint;
  available: boolean;
}
export interface ModifierGroupDto {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: ModifierOptionDto[];
}
export interface MenuProductDto {
  id: string;
  name: string;
  description: string | null;
  ingredients: string | null;
  allergenInfo: string | null;
  price: bigint;
  currency: string;
  available: boolean;
  categoryName: string | null;
  imageUrl: string | null;
  stationCode: string | null;
  modifierGroups: ModifierGroupDto[];
}

const qrToken = () => randomBytes(24).toString('base64url');

export class VenueService {
  constructor(private readonly appPool: Pool) {}

  /** Acceso efectivo del usuario (membresía owner/admin = completo). */
  async access(tenantId: string, userId: string, membershipRole: string): Promise<VenueAccess> {
    if (membershipRole === 'owner' || membershipRole === 'admin') {
      return { userId, full: true, grants: [] };
    }
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<{ role: VenueRole; branch_id: string | null }>(
        `SELECT role, branch_id FROM venue_staff
          WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [tenantId, userId]
      );
      return {
        userId,
        full: false,
        grants: r.rows.map((x) => ({ role: x.role, branchId: x.branch_id })),
      };
    });
  }

  // ── Sucursales, salones, mesas, estaciones ────────────────────────────────
  async createBranch(tenantId: string, name: string): Promise<BranchDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c
        .query<{ id: string; name: string }>(
          `INSERT INTO venue_branches (tenant_id, name) VALUES ($1, $2) RETURNING id, name`,
          [tenantId, name.trim()]
        )
        .catch(dup('Ya existe una sucursal con ese nombre'));
      return r.rows[0]!;
    });
  }

  async createArea(tenantId: string, branchId: string, name: string): Promise<AreaDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      await this.branchIn(c, branchId);
      const r = await c.query<{ id: string; branch_id: string; name: string }>(
        `INSERT INTO venue_areas (tenant_id, branch_id, name) VALUES ($1, $2, $3)
         RETURNING id, branch_id, name`,
        [tenantId, branchId, name.trim()]
      );
      const a = r.rows[0]!;
      return { id: a.id, branchId: a.branch_id, name: a.name };
    });
  }

  async createTable(
    tenantId: string,
    input: { branchId: string; areaId: string; label: string; capacity: number }
  ): Promise<TableDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      await this.branchIn(c, input.branchId);
      const r = await c
        .query<{ id: string }>(
          `INSERT INTO venue_tables (tenant_id, branch_id, area_id, label, capacity, qr_token)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [tenantId, input.branchId, input.areaId, input.label.trim(), input.capacity, qrToken()]
        )
        .catch(dup('Ya existe una mesa con ese nombre en la sucursal'));
      return (await this.tablesIn(c, input.branchId)).find((t) => t.id === r.rows[0]!.id)!;
    });
  }

  /** Rota el token del QR (invalida carteles impresos anteriores). */
  async rotateTableQr(tenantId: string, tableId: string): Promise<TableDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<{ branch_id: string }>(
        `UPDATE venue_tables SET qr_token = $2 WHERE id = $1 AND archived_at IS NULL
         RETURNING branch_id`,
        [tableId, qrToken()]
      );
      if (!r.rows[0]) throw new VenueNotFoundError('Table');
      return (await this.tablesIn(c, r.rows[0].branch_id)).find((t) => t.id === tableId)!;
    });
  }

  async createStation(
    tenantId: string,
    input: { branchId: string; code: string; name: string }
  ): Promise<StationDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      await this.branchIn(c, input.branchId);
      const r = await c
        .query<{ id: string }>(
          `INSERT INTO prep_stations (tenant_id, branch_id, code, name) VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [tenantId, input.branchId, input.code, input.name.trim()]
        )
        .catch(dup('Ya existe una estación con ese código en la sucursal'));
      return {
        id: r.rows[0]!.id,
        branchId: input.branchId,
        code: input.code,
        name: input.name.trim(),
      };
    });
  }

  async setProductRoute(tenantId: string, productId: string, stationCode: string): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query(
        `INSERT INTO product_prep_routes (tenant_id, product_id, station_code) VALUES ($1, $2, $3)
         ON CONFLICT (product_id) DO UPDATE SET station_code = EXCLUDED.station_code`,
        [tenantId, productId, stationCode]
      )
    );
  }

  async setBranchAvailability(
    tenantId: string,
    productId: string,
    branchId: string,
    available: boolean
  ): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query(
        `INSERT INTO product_branch_availability (tenant_id, product_id, branch_id, available)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_id, branch_id) DO UPDATE SET available = EXCLUDED.available, updated_at = now()`,
        [tenantId, productId, branchId, available]
      )
    );
  }

  async setProductInfo(
    tenantId: string,
    productId: string,
    info: { ingredients: string | null; allergenInfo: string | null }
  ): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query(
        `UPDATE catalog_products SET ingredients = $2, allergen_info = $3, updated_at = now()
          WHERE id = $1 AND archived_at IS NULL`,
        [productId, info.ingredients?.trim() || null, info.allergenInfo?.trim() || null]
      );
      if ((r.rowCount ?? 0) === 0) throw new VenueNotFoundError('Product');
    });
  }

  // ── Modificadores ─────────────────────────────────────────────────────────
  async createModifierGroup(
    tenantId: string,
    input: {
      name: string;
      minSelect: number;
      maxSelect: number;
      options: Array<{ name: string; priceDelta: bigint; available?: boolean }>;
    }
  ): Promise<ModifierGroupDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const g = await c.query<{ id: string }>(
        `INSERT INTO modifier_groups (tenant_id, name, min_select, max_select)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, input.name.trim(), input.minSelect, input.maxSelect]
      );
      const groupId = g.rows[0]!.id;
      let pos = 1;
      for (const o of input.options) {
        await c.query(
          `INSERT INTO modifier_options (tenant_id, group_id, name, price_delta, available, position)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantId, groupId, o.name.trim(), o.priceDelta.toString(), o.available ?? true, pos++]
        );
      }
      return (await this.groupsIn(c, [groupId]))[0]!;
    });
  }

  async setOptionAvailability(
    tenantId: string,
    optionId: string,
    available: boolean
  ): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query(`UPDATE modifier_options SET available = $2 WHERE id = $1`, [
        optionId,
        available,
      ]);
      if ((r.rowCount ?? 0) === 0) throw new VenueNotFoundError('Modifier option');
    });
  }

  async attachModifierGroup(
    tenantId: string,
    productId: string,
    groupId: string,
    active = true
  ): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query(
        `INSERT INTO product_modifier_groups (tenant_id, product_id, group_id, active)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_id, group_id) DO UPDATE SET active = EXCLUDED.active`,
        [tenantId, productId, groupId, active]
      )
    );
  }

  // ── Personal ──────────────────────────────────────────────────────────────
  async assignStaff(
    tenantId: string,
    input: { userId: string; role: VenueRole; branchId: string | null }
  ): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, async (c) => {
      const m = await c.query(
        `SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [tenantId, input.userId]
      );
      if ((m.rowCount ?? 0) === 0) throw new VenueNotFoundError('Member');
      if (input.branchId) await this.branchIn(c, input.branchId);
      await c.query(
        `INSERT INTO venue_staff (tenant_id, user_id, role, branch_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [tenantId, input.userId, input.role, input.branchId]
      );
    });
  }

  async revokeStaff(tenantId: string, input: { userId: string; role: VenueRole }): Promise<void> {
    await withTenantTransaction(this.appPool, tenantId, (c) =>
      c.query(
        `UPDATE venue_staff SET revoked_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND role = $3 AND revoked_at IS NULL`,
        [tenantId, input.userId, input.role]
      )
    );
  }

  async listStaff(
    tenantId: string
  ): Promise<Array<{ userId: string; email: string; role: VenueRole; branchId: string | null }>> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<{
        user_id: string;
        email: string;
        role: VenueRole;
        branch_id: string | null;
      }>(
        `SELECT s.user_id, u.email, s.role, s.branch_id
           FROM venue_staff s JOIN users u ON u.id = s.user_id
          WHERE s.tenant_id = $1 AND s.revoked_at IS NULL ORDER BY u.email, s.role`,
        [tenantId]
      );
      return r.rows.map((x) => ({
        userId: x.user_id,
        email: x.email,
        role: x.role,
        branchId: x.branch_id,
      }));
    });
  }

  // ── Lectura ───────────────────────────────────────────────────────────────
  async layout(tenantId: string): Promise<{
    branches: Array<BranchDto & { areas: AreaDto[]; tables: TableDto[]; stations: StationDto[] }>;
  }> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const b = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM venue_branches WHERE archived_at IS NULL ORDER BY created_at`
      );
      const out = [];
      for (const br of b.rows) {
        const areas = await c.query<{ id: string; name: string }>(
          `SELECT id, name FROM venue_areas WHERE branch_id = $1 AND archived_at IS NULL ORDER BY created_at`,
          [br.id]
        );
        const st = await c.query<{ id: string; code: string; name: string }>(
          `SELECT id, code, name FROM prep_stations WHERE branch_id = $1 AND archived_at IS NULL ORDER BY code`,
          [br.id]
        );
        out.push({
          ...br,
          areas: areas.rows.map((a) => ({ ...a, branchId: br.id })),
          tables: await this.tablesIn(c, br.id),
          stations: st.rows.map((s) => ({ ...s, branchId: br.id })),
        });
      }
      return { branches: out };
    });
  }

  /** Menú de una sucursal: SOLO datos del catálogo del comercio. */
  async menu(tenantId: string, branchId: string): Promise<MenuProductDto[]> {
    return withTenantTransaction(this.appPool, tenantId, (c) => this.menuIn(c, branchId));
  }

  async menuIn(c: PoolClient, branchId: string): Promise<MenuProductDto[]> {
    const r = await c.query<{
      id: string;
      name: string;
      description: string | null;
      ingredients: string | null;
      allergen_info: string | null;
      price: string;
      currency: string;
      available: boolean;
      category_name: string | null;
      image_url: string | null;
      station_code: string | null;
    }>(
      `SELECT p.id, p.name, p.description, p.ingredients, p.allergen_info, p.price::text,
              p.currency, (p.available AND COALESCE(ba.available, true)) AS available,
              cat.name AS category_name, p.image_ref AS image_url, rt.station_code
         FROM catalog_products p
         LEFT JOIN catalog_categories cat ON cat.id = p.category_id
         LEFT JOIN product_branch_availability ba ON ba.product_id = p.id AND ba.branch_id = $1
         LEFT JOIN product_prep_routes rt ON rt.product_id = p.id
        WHERE p.archived_at IS NULL
        ORDER BY cat.name NULLS LAST, p.name`,
      [branchId]
    );
    const links = await c.query<{ product_id: string; group_id: string }>(
      `SELECT product_id, group_id FROM product_modifier_groups WHERE active ORDER BY position`
    );
    const groups = await this.groupsIn(c, [...new Set(links.rows.map((l) => l.group_id))]);
    const byId = new Map(groups.map((g) => [g.id, g]));
    return r.rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      ingredients: p.ingredients,
      allergenInfo: p.allergen_info,
      price: BigInt(p.price),
      currency: p.currency.trim(),
      available: p.available,
      categoryName: p.category_name,
      imageUrl: p.image_url,
      stationCode: p.station_code,
      modifierGroups: links.rows
        .filter((l) => l.product_id === p.id)
        .map((l) => byId.get(l.group_id))
        .filter((g): g is ModifierGroupDto => !!g),
    }));
  }

  async branchIn(c: PoolClient, branchId: string): Promise<BranchDto> {
    const r = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM venue_branches WHERE id = $1 AND archived_at IS NULL`,
      [branchId]
    );
    if (!r.rows[0]) throw new VenueNotFoundError('Branch');
    return r.rows[0];
  }

  private async tablesIn(c: PoolClient, branchId: string): Promise<TableDto[]> {
    const r = await c.query<{
      id: string;
      area_id: string;
      label: string;
      capacity: number;
      qr_token: string;
    }>(
      `SELECT id, area_id, label, capacity, qr_token FROM venue_tables
        WHERE branch_id = $1 AND archived_at IS NULL ORDER BY label`,
      [branchId]
    );
    return r.rows.map((t) => ({
      id: t.id,
      branchId,
      areaId: t.area_id,
      label: t.label,
      capacity: t.capacity,
      qrToken: t.qr_token,
    }));
  }

  private async groupsIn(c: PoolClient, ids: string[]): Promise<ModifierGroupDto[]> {
    if (ids.length === 0) return [];
    const g = await c.query<{ id: string; name: string; min_select: number; max_select: number }>(
      `SELECT id, name, min_select, max_select FROM modifier_groups
        WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
      [ids]
    );
    const o = await c.query<{
      id: string;
      group_id: string;
      name: string;
      price_delta: string;
      available: boolean;
    }>(
      `SELECT id, group_id, name, price_delta::text, available FROM modifier_options
        WHERE group_id = ANY($1::uuid[]) AND archived_at IS NULL ORDER BY position`,
      [ids]
    );
    return g.rows.map((x) => ({
      id: x.id,
      name: x.name,
      minSelect: x.min_select,
      maxSelect: x.max_select,
      options: o.rows
        .filter((y) => y.group_id === x.id)
        .map((y) => ({
          id: y.id,
          name: y.name,
          priceDelta: BigInt(y.price_delta),
          available: y.available,
        })),
    }));
  }
}

function dup(message: string) {
  return (e: unknown): never => {
    if ((e as { code?: string }).code === '23505') throw new VenueConflictError(message);
    throw e;
  };
}
