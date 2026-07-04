import type { Pool } from '@fluvia/db';
import { EmailTakenError, OrganizationSlugTakenError, isUniqueViolation } from './errors.js';
import { CreateOrganizationSchema, type CreateOrganizationInput } from './schemas.js';

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
