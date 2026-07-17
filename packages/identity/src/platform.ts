import type { Pool } from '@fluvia/db';
import { insertAuditEvent, type AuditContext } from '@fluvia/audit';
import {
  EmailTakenError,
  OnboardingAlreadyCompletedError,
  OnboardingEmailNotVerifiedError,
  OnboardingUserNotFoundError,
  OrganizationSlugTakenError,
  isUniqueViolation,
} from './errors.js';
import {
  CreateOrganizationForUserSchema,
  CreateOrganizationSchema,
  type CreateOrganizationForUserInput,
  type CreateOrganizationInput,
} from './schemas.js';

export interface CreatedOrganization {
  organizationId: string;
  slug: string;
  ownerUserId: string;
  membershipId: string;
}

/**
 * PLANO DE PLATAFORMA (no plano de tenant).
 *
 * Crear una organizacion con su owner es la unica operacion de identity que
 * ocurre ANTES de que exista contexto de tenant, por lo que corre con el pool
 * administrativo. En despliegues cloud este rol debe tener BYPASSRLS o ser
 * superusuario local; el camino de autoservicio (registro publico) llegara en
 * F1-04 mediante funcion sancionada.
 *
 * Atomica: organizacion + usuario + membresia owner en una sola transaccion.
 */
export async function createOrganizationWithOwner(
  adminPool: Pool,
  rawInput: CreateOrganizationInput
): Promise<CreatedOrganization> {
  const input = CreateOrganizationSchema.parse(rawInput);
  const email = input.ownerEmail.toLowerCase();

  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');

    let organizationId: string;
    try {
      const org = await client.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        [input.organizationName, input.slug]
      );
      organizationId = org.rows[0]!.id;
    } catch (err) {
      if (isUniqueViolation(err, 'organizations_slug_key')) {
        throw new OrganizationSlugTakenError(input.slug);
      }
      throw err;
    }

    let ownerUserId: string;
    try {
      const user = await client.query<{ id: string }>(
        'INSERT INTO users (email) VALUES ($1) RETURNING id',
        [email]
      );
      ownerUserId = user.rows[0]!.id;
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_unique')) {
        throw new EmailTakenError();
      }
      throw err;
    }

    const membership = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'owner') RETURNING id`,
      [organizationId, ownerUserId]
    );

    await client.query('COMMIT');
    return {
      organizationId,
      slug: input.slug,
      ownerUserId,
      membershipId: membership.rows[0]!.id,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fachada del onboarding de organizacion para el wiring del API: encapsula el
 * pool de PLATAFORMA para que las rutas reciban un servicio ya cableado y
 * jamas referencien el pool administrativo (gate estructural del threat model
 * §5 — `sql-parameterization.test.ts`).
 */
export class OrganizationOnboardingService {
  constructor(private readonly platformPool: Pool) {}

  createForUser(
    input: CreateOrganizationForUserInput,
    audit: AuditContext
  ): Promise<OnboardingOrganizationResult> {
    return createOrganizationForUser(this.platformPool, input, audit);
  }
}

export interface OnboardingOrganizationResult {
  organization: { id: string; name: string; slug: string };
  membership: { id: string; role: 'owner' };
  /** true si la operacion recupero una organizacion ya creada (replay natural). */
  replayed: boolean;
}

interface OnboardingUserRow {
  id: string;
  email_verified_at: Date | null;
  deleted_at: Date | null;
}

interface OwnedOrgRow {
  org_id: string;
  name: string;
  slug: string;
  membership_id: string;
}

/**
 * F6.5C2 Paso A — PLANO DE PLATAFORMA (adminPool), UNA sola transaccion.
 *
 * Crea una organizacion + membership `owner` para un usuario YA existente y
 * autenticado, con auditoria `organization.created` y `membership.created`
 * ATOMICA (mismo PoolClient; un fallo de cualquiera de los dos eventos
 * revierte organizacion y membership).
 *
 * Idempotencia NATURAL, serializada por el lock de la fila del usuario
 * (`SELECT … FOR UPDATE`): requests concurrentes del MISMO usuario quedan en
 * fila. Si el usuario ya es owner de una organizacion:
 *  - mismo payload normalizado ⇒ devuelve la existente (replay, cero filas,
 *    cero auditoria duplicada);
 *  - payload distinto ⇒ OnboardingAlreadyCompletedError (409).
 * Un slug de OTRA organizacion produce el conflicto estable existente
 * (OrganizationSlugTakenError, unique del motor).
 *
 * NO usa `@fluvia/idempotency` (contrato tenant-scoped, inaplicable
 * pre-tenant), NO crea merchant ni chart y NO toca appPool: el Paso B corre
 * en el plano tenant como transaccion separada (sin transaccion distribuida).
 */
export async function createOrganizationForUser(
  adminPool: Pool,
  rawInput: CreateOrganizationForUserInput,
  audit: AuditContext
): Promise<OnboardingOrganizationResult> {
  const input = CreateOrganizationForUserSchema.parse(rawInput);

  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');

    // Lock de la fila del usuario: serializa TODO onboarding concurrente de
    // este usuario antes de mirar o crear nada.
    const user = await client.query<OnboardingUserRow>(
      'SELECT id, email_verified_at, deleted_at FROM users WHERE id = $1 FOR UPDATE',
      [input.userId]
    );
    const userRow = user.rows[0];
    if (!userRow || userRow.deleted_at !== null) throw new OnboardingUserNotFoundError();
    if (userRow.email_verified_at === null) throw new OnboardingEmailNotVerifiedError();

    // Recuperacion natural: ¿ya es owner de alguna organizacion?
    const owned = await client.query<OwnedOrgRow>(
      `SELECT o.id AS org_id, o.name, o.slug, m.id AS membership_id
       FROM memberships m
       JOIN organizations o ON o.id = m.tenant_id AND o.deleted_at IS NULL
       WHERE m.user_id = $1 AND m.role = 'owner' AND m.revoked_at IS NULL
       ORDER BY m.created_at`,
      [input.userId]
    );
    if (owned.rows.length > 0) {
      const match = owned.rows.find(
        (r) => r.name === input.organizationName && r.slug === input.slug
      );
      if (!match) throw new OnboardingAlreadyCompletedError();
      await client.query('COMMIT');
      return {
        organization: { id: match.org_id, name: match.name, slug: match.slug },
        membership: { id: match.membership_id, role: 'owner' },
        replayed: true,
      };
    }

    let organizationId: string;
    try {
      const org = await client.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        [input.organizationName, input.slug]
      );
      organizationId = org.rows[0]!.id;
    } catch (err) {
      if (isUniqueViolation(err, 'organizations_slug_key')) {
        throw new OrganizationSlugTakenError(input.slug);
      }
      throw err;
    }

    const membership = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'owner') RETURNING id`,
      [organizationId, input.userId]
    );
    const membershipId = membership.rows[0]!.id;

    // Auditoria ATOMICA (B5): mismo client/transaccion; solo IDs + name/slug —
    // sin email, password, token, cookie ni secretos.
    await insertAuditEvent(client, {
      action: 'organization.created',
      tenantId: organizationId,
      context: audit,
      resourceType: 'organization',
      resourceId: organizationId,
      after: { name: input.organizationName, slug: input.slug },
    });
    await insertAuditEvent(client, {
      action: 'membership.created',
      tenantId: organizationId,
      context: audit,
      resourceType: 'membership',
      resourceId: membershipId,
      after: { userId: input.userId, role: 'owner' },
    });

    await client.query('COMMIT');
    return {
      organization: { id: organizationId, name: input.organizationName, slug: input.slug },
      membership: { id: membershipId, role: 'owner' },
      replayed: false,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
