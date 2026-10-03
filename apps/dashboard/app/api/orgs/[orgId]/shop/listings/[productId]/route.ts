import { badRequest, forward, validIds } from '../../../../../../lib/bff';

type Ctx = { params: Promise<{ orgId: string; productId: string }> };

/** Publicar, destacar u ocultar un producto en la tienda (auditado). */
export async function PUT(req: Request, ctx: Ctx) {
  const { orgId, productId } = await ctx.params;
  if (!validIds(orgId, productId)) return badRequest();
  return forward(req, 'PUT', `/v1/organizations/${orgId}/shop/listings/${productId}`);
}
