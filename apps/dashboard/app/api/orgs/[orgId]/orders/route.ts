import { badRequest, forward, validIds } from '../../../../lib/bff';

/**
 * Crear la venta (pedido + su venta de cobro único). Idempotente: exige y
 * propaga la `Idempotency-Key` del carrito (API: `reconciliation:manage`).
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  if (!validIds(orgId)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/orders`, { idempotent: true });
}
