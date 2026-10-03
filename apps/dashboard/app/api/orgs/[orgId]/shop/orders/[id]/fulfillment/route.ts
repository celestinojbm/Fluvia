import { badRequest, forward, validIds } from '../../../../../../../lib/bff';

type Ctx = { params: Promise<{ orgId: string; id: string }> };

/** Avanzar la preparación/entrega de un pedido en línea YA cobrado (auditado). */
export async function POST(req: Request, ctx: Ctx) {
  const { orgId, id } = await ctx.params;
  if (!validIds(orgId, id)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/shop/orders/${id}/fulfillment`);
}
