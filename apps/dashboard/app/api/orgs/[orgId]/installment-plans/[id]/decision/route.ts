import { badRequest, forward, validIds } from '../../../../../../lib/bff';

/** Evento SIMULADO del proveedor de cuotas: decidir un plan pendiente. */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  if (!validIds(orgId, id)) return badRequest();
  return forward(
    req,
    'POST',
    `/v1/organizations/${orgId}/installment_plans/${id}/simulate_decision`
  );
}
