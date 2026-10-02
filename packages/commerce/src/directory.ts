import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { CommerceError, isUniqueViolation } from './errors.js';

/**
 * Directorio «Dónde comprar» (0054). Un perfil público por comercio, con
 * visibilidad EXPLÍCITA: nace en `draft`; solo `publish` (acción del comercio,
 * con confirmación) lo hace visible, y `hide` lo retira. La lectura pública va
 * por funciones SECURITY DEFINER que devuelven exclusivamente columnas públicas
 * de perfiles publicados de comercios activos.
 */

export const DIRECTORY_CATEGORIES = [
  'alimentacion',
  'restaurantes',
  'moda',
  'hogar',
  'tecnologia',
  'salud',
  'papeleria',
  'servicios',
] as const;
export type DirectoryCategory = (typeof DIRECTORY_CATEGORIES)[number];

export const DIRECTORY_CHANNELS = ['in_store', 'online'] as const;
export type DirectoryChannel = (typeof DIRECTORY_CHANNELS)[number];

export type DirectoryVisibility = 'draft' | 'published' | 'hidden';

export class DirectoryProfileNotFoundError extends CommerceError {
  constructor() {
    super('Directory profile not found');
  }
}
export class DirectoryVersionConflictError extends CommerceError {
  constructor() {
    super('Directory profile was modified by someone else');
  }
}
export class DirectorySlugTakenError extends CommerceError {
  constructor() {
    super('Directory slug already in use');
  }
}
/** El comercio no existe en la organización (o está congelado/borrado). */
export class DirectoryMerchantNotFoundError extends CommerceError {
  constructor() {
    super('Merchant not found');
  }
}

/** Perfil visto por su propio comercio (incluye estado y versión). */
export interface DirectoryProfileDto {
  id: string;
  merchantId: string;
  merchantName: string;
  slug: string;
  displayName: string;
  category: DirectoryCategory;
  city: string;
  area: string | null;
  summary: string | null;
  channels: DirectoryChannel[];
  photoRef: string | null;
  visibility: DirectoryVisibility;
  isDemo: boolean;
  publishedAt: string | null;
  version: number;
  updatedAt: string;
}

/** Perfil PÚBLICO: sin ids internos, sin estado de cuenta. */
export interface PublicDirectoryEntry {
  slug: string;
  displayName: string;
  category: DirectoryCategory;
  city: string;
  area: string | null;
  summary: string | null;
  channels: DirectoryChannel[];
  photoRef: string | null;
  isDemo: boolean;
  publishedAt: string;
}

export interface DirectoryProfileInput {
  slug: string;
  displayName: string;
  category: DirectoryCategory;
  city: string;
  area: string | null;
  summary: string | null;
  channels: DirectoryChannel[];
  photoRef: string | null;
}

type Audit<T> = (c: PoolClient, value: T) => Promise<unknown>;

interface ProfileRow {
  id: string;
  merchant_id: string;
  merchant_name: string;
  slug: string;
  display_name: string;
  category: DirectoryCategory;
  city: string;
  area: string | null;
  summary: string | null;
  channels: DirectoryChannel[];
  photo_ref: string | null;
  visibility: DirectoryVisibility;
  is_demo: boolean;
  published_at: Date | null;
  version: number;
  updated_at: Date;
}

const SELECT_PROFILE = `
  SELECT d.id, d.merchant_id, m.name AS merchant_name, d.slug, d.display_name,
         d.category, d.city, d.area, d.summary, d.channels, d.photo_ref,
         d.visibility, d.is_demo, d.published_at, d.version, d.updated_at
    FROM merchant_directory_profiles d
    JOIN merchants m ON m.id = d.merchant_id AND m.tenant_id = d.tenant_id`;

function toDto(r: ProfileRow): DirectoryProfileDto {
  return {
    id: r.id,
    merchantId: r.merchant_id,
    merchantName: r.merchant_name,
    slug: r.slug,
    displayName: r.display_name,
    category: r.category,
    city: r.city,
    area: r.area,
    summary: r.summary,
    channels: r.channels,
    photoRef: r.photo_ref,
    visibility: r.visibility,
    isDemo: r.is_demo,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
  };
}

interface PublicRow {
  slug: string;
  display_name: string;
  category: DirectoryCategory;
  city: string;
  area: string | null;
  summary: string | null;
  channels: DirectoryChannel[];
  photo_ref: string | null;
  is_demo: boolean;
  published_at: Date;
}

function toPublic(r: PublicRow): PublicDirectoryEntry {
  return {
    slug: r.slug,
    displayName: r.display_name,
    category: r.category,
    city: r.city,
    area: r.area,
    summary: r.summary,
    channels: r.channels,
    photoRef: r.photo_ref,
    isDemo: r.is_demo,
    publishedAt: r.published_at.toISOString(),
  };
}

/** Escapa `%`, `_` y `\` para ILIKE ... ESCAPE '\'. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class DirectoryService {
  constructor(private readonly pool: Pool) {}

  /** Perfiles de los comercios de la organización (cualquier visibilidad). */
  async listOwn(tenantId: string): Promise<DirectoryProfileDto[]> {
    return withTenantTransaction(this.pool, tenantId, async (c) => {
      const r = await c.query<ProfileRow>(`${SELECT_PROFILE} ORDER BY d.display_name`);
      return r.rows.map(toDto);
    });
  }

  /**
   * Crea (expectedVersion = 0) o edita el perfil de un comercio. Editar NO
   * cambia la visibilidad: un perfil publicado sigue publicado con los datos
   * nuevos; uno en borrador sigue en borrador.
   */
  async upsert(
    tenantId: string,
    merchantId: string,
    input: DirectoryProfileInput,
    expectedVersion: number,
    audit: Audit<DirectoryProfileDto>
  ): Promise<DirectoryProfileDto> {
    return withTenantTransaction(this.pool, tenantId, async (c) => {
      const m = await c.query(
        `SELECT 1 FROM merchants WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [merchantId]
      );
      if (m.rowCount === 0) throw new DirectoryMerchantNotFoundError();
      const values = [
        input.slug,
        input.displayName,
        input.category,
        input.city,
        input.area,
        input.summary,
        input.channels,
        input.photoRef,
      ];
      let id: string;
      try {
        if (expectedVersion === 0) {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO merchant_directory_profiles
               (tenant_id, merchant_id, slug, display_name, category, city, area, summary,
                channels, photo_ref)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (tenant_id, merchant_id) DO NOTHING
             RETURNING id`,
            [tenantId, merchantId, ...values]
          );
          if (ins.rowCount === 0) throw new DirectoryVersionConflictError();
          id = ins.rows[0]!.id;
        } else {
          const up = await c.query<{ id: string }>(
            `UPDATE merchant_directory_profiles
                SET slug = $3, display_name = $4, category = $5, city = $6, area = $7,
                    summary = $8, channels = $9, photo_ref = $10,
                    version = version + 1, updated_at = now()
              WHERE merchant_id = $1 AND version = $2
              RETURNING id`,
            [merchantId, expectedVersion, ...values]
          );
          if (up.rowCount === 0) await this.conflictOrMissing(c, merchantId);
          id = up.rows[0]!.id;
        }
      } catch (err) {
        if (isUniqueViolation(err, 'merchant_directory_slug_uniq'))
          throw new DirectorySlugTakenError();
        throw err;
      }
      const dto = await this.byId(c, id);
      await audit(c, dto);
      return dto;
    });
  }

  /** Publica el perfil. Requiere confirmación explícita en la capa HTTP. */
  async publish(
    tenantId: string,
    merchantId: string,
    expectedVersion: number,
    audit: Audit<DirectoryProfileDto>
  ): Promise<DirectoryProfileDto> {
    return this.setVisibility(tenantId, merchantId, 'published', expectedVersion, audit);
  }

  async hide(
    tenantId: string,
    merchantId: string,
    expectedVersion: number,
    audit: Audit<DirectoryProfileDto>
  ): Promise<DirectoryProfileDto> {
    return this.setVisibility(tenantId, merchantId, 'hidden', expectedVersion, audit);
  }

  private async setVisibility(
    tenantId: string,
    merchantId: string,
    visibility: 'published' | 'hidden',
    expectedVersion: number,
    audit: Audit<DirectoryProfileDto>
  ): Promise<DirectoryProfileDto> {
    return withTenantTransaction(this.pool, tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `UPDATE merchant_directory_profiles d
            SET visibility = $3,
                published_at = CASE WHEN $3 = 'published' THEN now() ELSE NULL END,
                version = d.version + 1, updated_at = now()
           FROM merchants m
          WHERE d.merchant_id = $1 AND d.version = $2
            AND m.id = d.merchant_id AND m.tenant_id = d.tenant_id
            AND m.status = 'active' AND m.deleted_at IS NULL
          RETURNING d.id`,
        [merchantId, expectedVersion, visibility]
      );
      if (r.rowCount === 0) await this.conflictOrMissing(c, merchantId);
      const dto = await this.byId(c, r.rows[0]!.id);
      await audit(c, dto);
      return dto;
    });
  }

  private async conflictOrMissing(c: PoolClient, merchantId: string): Promise<never> {
    const e = await c.query(`SELECT 1 FROM merchant_directory_profiles WHERE merchant_id = $1`, [
      merchantId,
    ]);
    if (e.rowCount === 0) throw new DirectoryProfileNotFoundError();
    throw new DirectoryVersionConflictError();
  }

  private async byId(c: PoolClient, id: string): Promise<DirectoryProfileDto> {
    const r = await c.query<ProfileRow>(`${SELECT_PROFILE} WHERE d.id = $1`, [id]);
    if (!r.rows[0]) throw new DirectoryProfileNotFoundError();
    return toDto(r.rows[0]);
  }

  // ── Lectura pública (sin tenant) ─────────────────────────────────────────
  async search(opts: {
    q?: string;
    category?: DirectoryCategory;
    city?: string;
    limit: number;
    offset: number;
  }): Promise<PublicDirectoryEntry[]> {
    const r = await this.pool.query<PublicRow>(
      'SELECT * FROM directory_search($1, $2, $3, $4, $5)',
      [
        opts.q ? likePattern(opts.q) : null,
        opts.category ?? null,
        opts.city ?? null,
        opts.limit,
        opts.offset,
      ]
    );
    return r.rows.map(toPublic);
  }

  async profile(slug: string): Promise<PublicDirectoryEntry> {
    const r = await this.pool.query<PublicRow>('SELECT * FROM directory_profile($1)', [slug]);
    if (!r.rows[0]) throw new DirectoryProfileNotFoundError();
    return toPublic(r.rows[0]);
  }

  async cities(): Promise<string[]> {
    const r = await this.pool.query<{ city: string }>('SELECT city FROM directory_cities()');
    return r.rows.map((x) => x.city);
  }
}
