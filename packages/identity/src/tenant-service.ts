import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';
import { insertAuditEvent, type AuditContext } from '@fluvia/audit';
import {
  MerchantNameTakenError,
  MerchantNotFoundError,
  MerchantOnboardingAlreadyCompletedError,
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

export interface MerchantOnboardingResult {
  merchant: MerchantDto;
  /** true si la operacion recupero un merchant ya creado (replay natural). */
  replayed: boolean;
}

/**
 * RA-F65C2-EXT-001 — namespace del advisory lock transaccional de CREACION DE
 * MERCHANT, COMPARTIDO por TODOS los caminos runtime que insertan merchants
 * dentro de IdentityService (`createMerchant` general Y
 * `ensureMerchantForOnboarding`): sin un lock comun, ambas rutas podian
 * insertar concurrentemente merchants con nombres distintos sin serializar.
 * La clave se calcula EN PostgreSQL (`hashtextextended` ⇒ bigint, jamas
 * convertido a Number en JavaScript), es estable, va namespaced por
 * `tenant_id` y NO depende del nombre del merchant; organizaciones distintas
 * no se bloquean entre si. (El valor del namespace conserva la cadena
 * historica por estabilidad de la clave; el CONCEPTO es «merchant creation
 * lock». El lock de fila `SELECT organizations … FOR UPDATE` es inviable bajo
 * la RLS actual: politica SELECT-only con FORCE RLS.)
 *
 * Semantica LINEALIZADA que garantiza el lock compartido (orden total por
 * tenant, no «un merchant total para siempre»):
 *  - si `createMerchant` general gana el lock primero, el onboarding espera y
 *    al entrar observa exactamente ese merchant: payload identico ⇒ replay
 *    natural (chart re-ejecutable, sin duplicar merchant ni audit); payload
 *    distinto ⇒ 409 MerchantOnboardingAlreadyCompletedError (una sola fila);
 *  - si el onboarding gana primero, la creacion general espera y DESPUES crea
 *    un merchant adicional (valido: queda logicamente despues del merchant
 *    inicial; un audit por merchant; mismo nombre ⇒ MerchantNameTakenError);
 *  - jamas existe una carrera no serializada entre los dos endpoints.
 */
const MERCHANT_CREATION_LOCK_NS = 'fluvia:onboarding:merchant:';

/** Clave (bigint como texto) del advisory lock compartido — para los tests. */
export async function merchantCreationLockKey(
  client: PoolClient | Pool,
  tenantId: string
): Promise<string> {
  const res = await client.query<{ key: string }>(
    'SELECT hashtextextended($1 || $2, 0)::text AS key',
    [MERCHANT_CREATION_LOCK_NS, tenantId]
  );
  return res.rows[0]!.key;
}

/**
 * PLANO DE TENANT: todas las operaciones corren con el rol fluvia_app dentro
 * de withTenantTransaction — RLS es la segunda linea de defensa en cada query.
 */
export class IdentityService {
  constructor(private readonly appPool: Pool) {}

  /**
   * RA-F65C2-EXT-001 — primitiva client-bound del lock COMPARTIDO de creacion
   * de merchant. TODO camino runtime de IdentityService que inserte un
   * merchant debe llamarla INMEDIATAMENTE tras entrar en su
   * withTenantTransaction, ANTES de contar/consultar merchants para
   * decisiones de cardinalidad y ANTES de insertar. Transaccional: se libera
   * automaticamente al COMMIT o ROLLBACK. Misma clave exacta para todos los
   * caminos (namespaced por tenant, independiente del nombre; bigint
   * calculado en PostgreSQL — jamas Number en JS). No es un mutex de proceso
   * ni un lock global: tenants distintos no se bloquean entre si.
   */
  private async acquireMerchantCreationLock(c: PoolClient, tenantId: string): Promise<void> {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1 || $2, 0))', [
      MERCHANT_CREATION_LOCK_NS,
      tenantId,
    ]);
  }

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
      // RA-F65C2-EXT-001: mismo lock que el onboarding — serializa AMBOS
      // caminos de creacion antes de insertar. El contrato observable no
      // cambia: sigue creando merchants adicionales, devolviendo MerchantDto
      // y lanzando MerchantNameTakenError ante nombre duplicado.
      await this.acquireMerchantCreationLock(c, tenantId);
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

  /**
   * F6.5C2 Paso B — merchant de ONBOARDING (exactamente UNO por organizacion),
   * en una sola transaccion tenant-scoped serializada por advisory lock.
   * NO sustituye a `createMerchant` (merchants adicionales siguen usando la
   * ruta general despues del onboarding); su contrato queda intacto.
   *
   * Bajo el lock (tomado ANTES de contar):
   *  - cero merchants activos ⇒ crea + `merchant.created` UNA vez (misma tx);
   *  - exactamente uno y el payload normalizado coincide ⇒ replay natural
   *    (devuelve el existente, cero auditoria duplicada);
   *  - exactamente uno y difiere ⇒ MerchantOnboardingAlreadyCompletedError;
   *  - dos o mas ⇒ MerchantOnboardingAlreadyCompletedError (jamas eleccion
   *    arbitraria).
   *
   * El chart (`PostingService.ensureChart`) es un paso POSTERIOR idempotente
   * del llamador — nunca dentro de esta transaccion (sin tx distribuida).
   */
  async ensureMerchantForOnboarding(
    tenantId: string,
    rawInput: CreateMerchantInput,
    audit: AuditContext
  ): Promise<MerchantOnboardingResult> {
    const input = CreateMerchantSchema.parse(rawInput);
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      // Serializacion por tenant, independiente del nombre: el UNIQUE
      // (tenant_id, name) NO basta — dos nombres distintos concurrentes
      // insertarian dos merchants sin conflicto de indice. MISMO lock que
      // createMerchant (RA-F65C2-EXT-001): el conteo de cardinalidad de abajo
      // solo se ejecuta cuando ninguna creacion general esta en vuelo.
      await this.acquireMerchantCreationLock(c, tenantId);

      const existing = await c.query<MerchantRow>(
        `SELECT id, name, country, default_currency, status, created_at
         FROM merchants WHERE deleted_at IS NULL ORDER BY created_at`
      );
      if (existing.rows.length === 1) {
        const row = existing.rows[0]!;
        if (
          row.name === input.name &&
          row.country === input.country &&
          row.default_currency === input.defaultCurrency
        ) {
          return { merchant: toMerchantDto(row), replayed: true };
        }
        throw new MerchantOnboardingAlreadyCompletedError();
      }
      if (existing.rows.length > 1) throw new MerchantOnboardingAlreadyCompletedError();

      const res = await c.query<MerchantRow>(
        `INSERT INTO merchants (tenant_id, name, country, default_currency)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, country, default_currency, status, created_at`,
        [tenantId, input.name, input.country, input.defaultCurrency]
      );
      const dto = toMerchantDto(res.rows[0]!);
      await insertAuditEvent(c, {
        action: 'merchant.created',
        tenantId,
        context: audit,
        resourceType: 'merchant',
        resourceId: dto.id,
        after: { name: dto.name, country: dto.country, defaultCurrency: dto.defaultCurrency },
      });
      return { merchant: dto, replayed: false };
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
