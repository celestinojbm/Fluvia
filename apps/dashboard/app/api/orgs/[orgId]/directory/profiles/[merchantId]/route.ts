import { badRequest, forward, validIds } from '../../../../../../lib/bff';

type Ctx = { params: Promise<{ orgId: string; merchantId: string }> };

/** Crear o editar el perfil público (API: `merchants:write`, auditado). */
export async function PUT(req: Request, ctx: Ctx) {
  const { orgId, merchantId } = await ctx.params;
  if (!validIds(orgId, merchantId)) return badRequest();
  return forward(req, 'PUT', `/v1/organizations/${orgId}/directory/profiles/${merchantId}`);
}
