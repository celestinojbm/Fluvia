import { badRequest, forward, validIds } from '../../../../../lib/bff';

/** Crear categoría (API: `merchants:write`, auditado). */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  if (!validIds(orgId)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/catalog/categories`);
}
