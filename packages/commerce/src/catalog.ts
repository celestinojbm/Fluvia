import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { Money } from '@fluvia/money';
import { isDemoImageRef } from './demo-images.js';
import {
  CatalogDuplicateError,
  CatalogVariantError,
  CategoryNotFoundError,
  CommerceError,
  ProductNotFoundError,
  ProductVersionConflictError,
  hasEngineMessage,
  isUniqueViolation,
} from './errors.js';

/** Imagen fuera del conjunto cerrado de demostración. */
export class UnknownImageError extends CommerceError {
  constructor() {
    super('Unknown catalog image');
  }
}

/**
 * Catálogo del comercio (0049 + 0051). Por organización (RLS forzado). Precio
 * en unidades menores; `available` = disponibilidad declarada por el comercio.
 * Con `trackStock`, además, existencias reales (on_hand / reservado / libre)
 * mantenidas por el motor (ver InventoryService). Variantes de un nivel
 * (`variantOf` fijo al crear). DTO whitelisted explícito, jamás spread.
 */

export interface CategoryDto {
  id: string;
  name: string;
  productCount: number;
  createdAt: string;
}

export interface ProductDto {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  name: string;
  sku: string | null;
  description: string | null;
  price: bigint;
  currency: string;
  available: boolean;
  version: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** `catalog/<archivo>.jpg` del conjunto de demostración, o null. */
  imageRef: string | null;
  /** Producto base si este es una variante. */
  variantOf: string | null;
  variantLabel: string | null;
  trackStock: boolean;
  /** Existencias (solo si `trackStock`): libre = existencia − reservado. */
  stock: { onHand: bigint; reserved: bigint; free: bigint } | null;
}

export interface ProductInput {
  name: string;
  sku?: string | null;
  description?: string | null;
  categoryId?: string | null;
  price: bigint;
  currency: string;
  available?: boolean;
  imageRef?: string | null;
  variantOf?: string | null;
  variantLabel?: string | null;
  trackStock?: boolean;
}

export interface ProductPatch {
  name?: string;
  sku?: string | null;
  description?: string | null;
  categoryId?: string | null;
  price?: bigint;
  available?: boolean;
  archived?: boolean;
  imageRef?: string | null;
  variantLabel?: string | null;
  trackStock?: boolean;
  /** Versión que el operador editó (concurrencia optimista). */
  expectedVersion: number;
}

export interface ProductQuery {
  q?: string;
  categoryId?: string;
  /** true = solo vendibles (disponibles y no archivados). */
  sellableOnly?: boolean;
  includeArchived?: boolean;
  /** Solo productos con existencias controladas y libre ≤ umbral. */
  lowStock?: number;
  limit?: number;
}

interface ProductRow {
  id: string;
  category_id: string | null;
  category_name: string | null;
  name: string;
  sku: string | null;
  description: string | null;
  price: string;
  currency: string;
  available: boolean;
  version: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  image_ref: string | null;
  variant_of: string | null;
  variant_label: string | null;
  track_stock: boolean;
  on_hand: string | null;
  reserved: string | null;
}

const PRODUCT_SELECT = `
  SELECT p.id, p.category_id, c.name AS category_name, p.name, p.sku, p.description,
         p.price::text, p.currency, p.available, p.version, p.archived_at, p.created_at, p.updated_at,
         p.image_ref, p.variant_of, p.variant_label, p.track_stock,
         lv.on_hand::text, lv.reserved::text
  FROM catalog_products p
  LEFT JOIN catalog_categories c ON c.id = p.category_id
  LEFT JOIN inventory_levels lv ON lv.product_id = p.id`;

function toProduct(r: ProductRow): ProductDto {
  return {
    id: r.id,
    categoryId: r.category_id,
    categoryName: r.category_name,
    name: r.name,
    sku: r.sku,
    description: r.description,
    price: BigInt(r.price),
    currency: r.currency.trim(),
    available: r.available,
    version: r.version,
    archived: r.archived_at !== null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    imageRef: r.image_ref,
    variantOf: r.variant_of,
    variantLabel: r.variant_label,
    trackStock: r.track_stock,
    stock: r.track_stock
      ? (() => {
          const onHand = BigInt(r.on_hand ?? '0');
          const reserved = BigInt(r.reserved ?? '0');
          return { onHand, reserved, free: onHand - reserved };
        })()
      : null,
  };
}

function assertImage(ref: string | null | undefined): void {
  if (ref && !isDemoImageRef(ref)) throw new UnknownImageError();
}

/** Escapa comodines de LIKE en la búsqueda del operador. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const clean = (s: string | null | undefined): string | null => {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t === '' ? null : t;
};

/** Gancho de auditoría: corre en la MISMA transacción que el cambio. */
export type AuditHook<T> = (c: PoolClient, after: T) => Promise<void>;

export class CatalogService {
  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool
  ) {}

  async listCategories(tenantId: string): Promise<CategoryDto[]> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<{
        id: string;
        name: string;
        product_count: number;
        created_at: Date;
      }>(
        `SELECT c.id, c.name, c.created_at,
                (SELECT count(*)::int FROM catalog_products p
                  WHERE p.category_id = c.id AND p.archived_at IS NULL) AS product_count
         FROM catalog_categories c
         WHERE c.archived_at IS NULL
         ORDER BY lower(c.name)`
      );
      return res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        productCount: r.product_count,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  async createCategory(
    tenantId: string,
    name: string,
    audit?: AuditHook<CategoryDto>
  ): Promise<CategoryDto> {
    const n = name.trim();
    try {
      return await withTenantTransaction(this.appPool, tenantId, async (c) => {
        const res = await c.query<{ id: string; name: string; created_at: Date }>(
          `INSERT INTO catalog_categories (tenant_id, name) VALUES ($1, $2)
           RETURNING id, name, created_at`,
          [tenantId, n]
        );
        const r = res.rows[0]!;
        const dto = {
          id: r.id,
          name: r.name,
          productCount: 0,
          createdAt: r.created_at.toISOString(),
        };
        await audit?.(c, dto);
        return dto;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'catalog_categories_name_uq')) {
        throw new CatalogDuplicateError('name');
      }
      throw err;
    }
  }

  async listProducts(tenantId: string, query: ProductQuery = {}): Promise<ProductDto[]> {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 200), 1), 500);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const where: string[] = [];
      const values: unknown[] = [];
      if (!query.includeArchived) where.push('p.archived_at IS NULL');
      if (query.sellableOnly) where.push('p.available AND p.archived_at IS NULL');
      if (query.categoryId) {
        values.push(query.categoryId);
        where.push(`p.category_id = $${values.length}`);
      }
      const q = query.q?.trim();
      if (q) {
        values.push(likePattern(q));
        where.push(
          `(p.name ILIKE $${values.length} OR p.sku ILIKE $${values.length}
            OR p.variant_label ILIKE $${values.length})`
        );
      }
      if (query.lowStock !== undefined) {
        values.push(Math.max(0, Math.floor(query.lowStock)));
        where.push(
          `p.track_stock AND coalesce(lv.on_hand, 0) - coalesce(lv.reserved, 0) <= $${values.length}`
        );
      }
      values.push(limit);
      // Las variantes quedan junto a su base: orden por (base, variante).
      const res = await c.query<ProductRow>(
        `${PRODUCT_SELECT}
         LEFT JOIN catalog_products base ON base.id = p.variant_of
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY lower(coalesce(base.name, p.name)), coalesce(p.variant_of, p.id),
                  p.variant_of IS NOT NULL, lower(coalesce(p.variant_label, '')), p.id
         LIMIT $${values.length}`,
        values
      );
      return res.rows.map(toProduct);
    });
  }

  async getProduct(tenantId: string, id: string): Promise<ProductDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
      if (!res.rows[0]) throw new ProductNotFoundError();
      return toProduct(res.rows[0]);
    });
  }

  private async assertCategory(
    c: import('@fluvia/db').PoolClient,
    categoryId: string | null | undefined
  ): Promise<void> {
    if (!categoryId) return;
    const r = await c.query(
      `SELECT 1 FROM catalog_categories WHERE id = $1 AND archived_at IS NULL`,
      [categoryId]
    );
    if ((r.rowCount ?? 0) === 0) throw new CategoryNotFoundError();
  }

  async createProduct(
    tenantId: string,
    input: ProductInput,
    audit?: AuditHook<ProductDto>
  ): Promise<ProductDto> {
    // Valida moneda y monto con el Value Object (registro de @fluvia/money).
    const price = Money.of(input.price, input.currency);
    assertImage(input.imageRef);
    try {
      return await withTenantTransaction(this.appPool, tenantId, async (c) => {
        await this.assertCategory(c, input.categoryId);
        const ins = await c.query<{ id: string }>(
          `INSERT INTO catalog_products
             (tenant_id, category_id, name, sku, description, price, currency, available,
              image_ref, variant_of, variant_label, track_stock)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [
            tenantId,
            input.categoryId ?? null,
            input.name.trim(),
            clean(input.sku),
            clean(input.description),
            price.amount.toString(),
            price.currency,
            input.available ?? true,
            input.imageRef ?? null,
            input.variantOf ?? null,
            clean(input.variantLabel),
            input.trackStock ?? false,
          ]
        );
        const res = await c.query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1`, [
          ins.rows[0]!.id,
        ]);
        const dto = toProduct(res.rows[0]!);
        await audit?.(c, dto);
        return dto;
      });
    } catch (err) {
      throw mapCatalogError(err);
    }
  }

  /**
   * Edición con concurrencia optimista: solo aplica si la versión actual es la
   * que el operador vio. La moneda no se edita (cambiarla re-denominaría el
   * precio). Los pedidos ya creados NO cambian: guardan su copia histórica.
   */
  async updateProduct(
    tenantId: string,
    id: string,
    patch: ProductPatch,
    audit?: AuditHook<ProductDto>
  ): Promise<ProductDto> {
    try {
      return await withTenantTransaction(this.appPool, tenantId, async (c) => {
        const cur = await c.query<{ version: number; currency: string }>(
          `SELECT version, currency FROM catalog_products WHERE id = $1 FOR UPDATE`,
          [id]
        );
        const row = cur.rows[0];
        if (!row) throw new ProductNotFoundError();
        if (row.version !== patch.expectedVersion) throw new ProductVersionConflictError();

        const sets: string[] = [];
        const values: unknown[] = [id];
        const set = (col: string, v: unknown) => {
          values.push(v);
          sets.push(`${col} = $${values.length}`);
        };
        if (patch.name !== undefined) set('name', patch.name.trim());
        if (patch.sku !== undefined) set('sku', clean(patch.sku));
        if (patch.description !== undefined) set('description', clean(patch.description));
        if (patch.categoryId !== undefined) {
          await this.assertCategory(c, patch.categoryId);
          set('category_id', patch.categoryId);
        }
        if (patch.price !== undefined) {
          set('price', Money.of(patch.price, row.currency.trim()).amount.toString());
        }
        if (patch.available !== undefined) set('available', patch.available);
        if (patch.imageRef !== undefined) {
          assertImage(patch.imageRef);
          set('image_ref', patch.imageRef);
        }
        if (patch.variantLabel !== undefined) set('variant_label', clean(patch.variantLabel));
        if (patch.trackStock !== undefined) set('track_stock', patch.trackStock);
        if (patch.archived !== undefined) {
          sets.push(
            patch.archived ? 'archived_at = coalesce(archived_at, now())' : 'archived_at = NULL'
          );
        }
        sets.push('version = version + 1', 'updated_at = now()');
        await c.query(`UPDATE catalog_products SET ${sets.join(', ')} WHERE id = $1`, values);
        const res = await c.query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
        const dto = toProduct(res.rows[0]!);
        await audit?.(c, dto);
        return dto;
      });
    } catch (err) {
      throw mapCatalogError(err);
    }
  }
}

function mapCatalogError(err: unknown): unknown {
  if (isUniqueViolation(err, 'catalog_products_sku_uq')) return new CatalogDuplicateError('sku');
  if (hasEngineMessage(err, 'FLUVIA_CATALOG_VARIANT')) return new CatalogVariantError();
  // Etiqueta obligatoria en una variante / base = sí misma.
  const e = err as { code?: unknown; constraint?: unknown } | null;
  if (
    e?.code === '23514' &&
    (e.constraint === 'catalog_products_variant_label_chk' ||
      e.constraint === 'catalog_products_variant_self_chk')
  ) {
    return new CatalogVariantError();
  }
  // Base de otra organización: la FK compuesta no la encuentra.
  if (e?.code === '23503' && e.constraint === 'catalog_products_variant_fk') {
    return new CatalogVariantError();
  }
  return err;
}
