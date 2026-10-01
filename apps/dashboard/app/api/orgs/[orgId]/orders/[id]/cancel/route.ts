import { badRequest, forward, validIds } from '../../../../../../lib/bff';

/**
 * Anular una venta SIN cobro (API: `reconciliation:manage`, auditado). El
 * motor la rechaza si un cobro la retiene; reenviarla devuelve la misma venta.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  if (!validIds(orgId, id)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/orders/${id}/cancel`);
}
