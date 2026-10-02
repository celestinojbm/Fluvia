import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SIMULATOR_OUTCOMES,
  type InPersonPaymentDto,
  type InPersonService,
  type VenueService,
} from '@fluvia/commerce';
import { hasPermission, type Role } from '@fluvia/identity';
import type { Security } from '../security.js';

/**
 * Cobro presencial (plano de SESIÓN). El teléfono del cobrador solo prepara
 * y cancela; el resultado (aprobado / rechazado / incierto) lo fija el
 * servidor desde el intent. El simulador de terminal existe SOLO en
 * local/test y su resultado lo decide el proveedor sandbox.
 */

const OrgParam = z.object({ orgId: z.string().uuid() });
const IdParams = OrgParam.extend({ id: z.string().uuid() });
const ClientKey = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

export function publicInPerson(p: InPersonPaymentDto) {
  return {
    id: p.id,
    object: 'in_person_payment',
    method: p.method,
    provider: p.provider,
    // Marcado explícito: un cobro simulado nunca se presenta como real.
    simulated: p.simulated,
    state: p.state,
    amount: Number(p.amount),
    currency: p.currency,
    concept: p.concept,
    payment_link_id: p.paymentLinkId,
    payment_intent_id: p.intentId,
    failure_code: p.failureCode,
    version: p.version,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    receipt:
      p.state === 'approved'
        ? {
            amount: Number(p.amount),
            currency: p.currency,
            concept: p.concept,
            payment_intent_id: p.intentId,
            approved_at: p.updatedAt,
            simulated: p.simulated,
          }
        : null,
  };
}

export interface InPersonRoutesOptions {
  security: Security;
  inPersonService: InPersonService;
  venueService: VenueService;
  sandboxSimulation: boolean;
}

export function registerInPersonRoutes(app: FastifyInstance, o: InPersonRoutesOptions): void {
  const { security, inPersonService: svc, venueService: venue } = o;
  const member = { preHandler: [security.session, security.org('org:read')] };
  const base = '/v1/organizations/:orgId/in-person';
  const tenant = (req: FastifyRequest) => req.org!.organizationId;
  const user = (req: FastifyRequest) => req.identity!.userId;

  app.post(`${base}/devices`, member, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = z
      .object({
        platform: z.enum(['android', 'ios', 'web', 'other']),
        model: z.string().trim().max(80).nullable().optional(),
        os_version: z.string().trim().max(40).nullable().optional(),
        nfc: z.boolean().nullable().optional(),
      })
      .strict()
      .parse(req.body);
    const d = await svc.registerDevice(tenant(req), user(req), {
      platform: b.platform,
      model: b.model ?? null,
      osVersion: b.os_version ?? null,
      nfc: b.nfc ?? null,
    });
    return reply.code(201).send({
      id: d.id,
      object: 'in_person_device',
      platform: d.platform,
      capability: d.capability,
      reasons: d.reasons,
    });
  });

  const Source = z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('amount'),
        amount: z.number().int().positive().refine(Number.isSafeInteger),
        currency: z.string().regex(/^[A-Z]{3}$/),
        concept: z.string().trim().max(80).nullable().optional(),
      })
      .strict(),
    z.object({ kind: z.literal('allocation'), allocation_id: z.string().uuid() }).strict(),
    z.object({ kind: z.literal('order'), order_id: z.string().uuid() }).strict(),
  ]);

  app.post(`${base}/payments`, member, async (req, reply) => {
    OrgParam.parse(req.params);
    const b = z
      .object({
        source: Source,
        method: z.enum(['tap_to_pay', 'external_reader', 'simulator']),
        device_id: z.string().uuid().nullable().optional(),
        client_key: ClientKey,
      })
      .strict()
      .parse(req.body);
    const role = req.org!.role as Role;
    const p = await svc.create(
      tenant(req),
      {
        userId: user(req),
        canSell: hasPermission(role, 'reconciliation:manage'),
        venue: await venue.access(tenant(req), user(req), role),
      },
      {
        method: b.method,
        deviceId: b.device_id ?? null,
        clientKey: b.client_key,
        source:
          b.source.kind === 'amount'
            ? {
                kind: 'amount',
                amount: BigInt(b.source.amount),
                currency: b.source.currency,
                concept: b.source.concept ?? null,
              }
            : b.source.kind === 'allocation'
              ? { kind: 'allocation', allocationId: b.source.allocation_id }
              : { kind: 'order', orderId: b.source.order_id },
      }
    );
    return reply.code(201).send(publicInPerson(p));
  });

  app.get(`${base}/payments`, member, async (req) => {
    OrgParam.parse(req.params);
    const list = await svc.list(tenant(req), user(req));
    return { object: 'list', data: list.map(publicInPerson) };
  });

  app.get(`${base}/payments/:id`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    return publicInPerson(await svc.get(tenant(req), user(req), id));
  });

  app.post(`${base}/payments/:id/state`, member, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = z
      .object({
        to: z.enum(['ready', 'waiting_card', 'canceled']),
        expected_version: z.number().int().min(1),
      })
      .strict()
      .parse(req.body);
    return publicInPerson(
      await svc.advance(tenant(req), user(req), id, {
        to: b.to,
        expectedVersion: b.expected_version,
      })
    );
  });

  if (o.sandboxSimulation) {
    // Terminal SIMULADO: presenta un token del proveedor sandbox, nunca una tarjeta.
    app.post(`${base}/payments/:id/simulate`, member, async (req) => {
      const { id } = IdParams.parse(req.params);
      const b = z
        .object({
          outcome: z.enum(Object.keys(SIMULATOR_OUTCOMES) as [keyof typeof SIMULATOR_OUTCOMES]),
        })
        .strict()
        .parse(req.body);
      return publicInPerson(await svc.simulateTap(tenant(req), user(req), id, b.outcome));
    });
  }
}
