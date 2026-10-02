import { badRequest, forward, validIds } from '../../../../../../../lib/bff';

type Ctx = { params: Promise<{ orgId: string; merchantId: string }> };

/** Retirar del directorio el perfil público (API: `merchants:write`, auditado). */
export async function POST(req: Request, ctx: Ctx) {
  const { orgId, merchantId } = await ctx.params;
  if (!validIds(orgId, merchantId)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/directory/profiles/${merchantId}/hide`);
}
