import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateCustomerSchema,
  UpdateCustomerSchema,
  type CustomerDto,
  type CustomerService,
} from '@fluvia/identity';
import type { Security } from '../security.js';

/**
 * F3-05a — customers (plano de integración, API key). Scope `customers:write`
 * para mutar, `read` para consultar. Primer consumidor real: el checkout de
 * F3-05. Semántica tipo Stripe: el email no es único.
 */

const IdParam = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

export interface CustomerRoutesOptions {
  security: Security;
  customerService: CustomerService;
}

function publicCustomer(c: CustomerDto) {
  return {
    id: c.id,
    object: 'customer',
    email: c.email,
    name: c.name,
    phone: c.phone,
    description: c.description,
    metadata: c.metadata,
    created_at: c.createdAt,
  };
}

export function registerCustomerRoutes(
  app: FastifyInstance,
  { security, customerService }: CustomerRoutesOptions
): void {
  app.post(
    '/v1/customers',
    { preHandler: security.apiKey(['customers:write']) },
    async (req, reply) => {
      const body = CreateCustomerSchema.parse(req.body);
      const created = await customerService.create(req.apiKey!.tenantId, body);
      return reply.code(201).send(publicCustomer(created));
    }
  );

  app.get('/v1/customers/:id', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { id } = IdParam.parse(req.params);
    return publicCustomer(await customerService.get(req.apiKey!.tenantId, id));
  });

  app.get('/v1/customers', { preHandler: security.apiKey(['read']) }, async (req) => {
    const { limit } = ListQuery.parse(req.query ?? {});
    const customers = await customerService.list(req.apiKey!.tenantId, limit);
    return { object: 'list', data: customers.map(publicCustomer) };
  });

  app.post(
    '/v1/customers/:id',
    { preHandler: security.apiKey(['customers:write']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const body = UpdateCustomerSchema.parse(req.body);
      return publicCustomer(await customerService.update(req.apiKey!.tenantId, id, body));
    }
  );

  app.post(
    '/v1/customers/:id/delete',
    { preHandler: security.apiKey(['customers:write']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const res = await customerService.softDelete(req.apiKey!.tenantId, id);
      return { id: res.id, object: 'customer', deleted: true };
    }
  );

  // TM-05: derecho al olvido por PSEUDONIMIZACION (data-classification.md,
  // clase PII). IRREVERSIBLE: sobrescribe email/name/phone/description/metadata
  // y da de baja logica; el id y las FKs (checkout_sessions, ...) permanecen —
  // la contabilidad no se toca. Auditado (riesgo alto). Idempotente.
  app.post(
    '/v1/customers/:id/erase',
    { preHandler: security.apiKey(['customers:write']) },
    async (req) => {
      const { id } = IdParam.parse(req.params);
      const res = await customerService.erase(req.apiKey!.tenantId, id, {
        apiKeyId: req.apiKey!.apiKeyId,
        requestId: req.id,
        ip: req.ip,
      });
      return { id: res.id, object: 'customer', erased: true };
    }
  );
}
