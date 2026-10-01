import { badRequest, forward, validIds } from '../../../../../../lib/bff';

/** Editar producto con versión esperada (API: `merchants:write`, auditado). */
export async function PATCH(req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  if (!validIds(orgId, id)) return badRequest();
  return forward(req, 'PATCH', `/v1/organizations/${orgId}/catalog/products/${id}`);
}
