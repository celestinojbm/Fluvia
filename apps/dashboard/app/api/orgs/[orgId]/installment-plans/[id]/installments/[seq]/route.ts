import { badRequest, forward, validIds } from '../../../../../../../lib/bff';

/** Evento SIMULADO sobre una cuota (pagada / vencida). */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ orgId: string; id: string; seq: string }> }
) {
  const { orgId, id, seq } = await ctx.params;
  if (!validIds(orgId, id) || !/^(?:[1-9]|1[0-2])$/.test(seq)) return badRequest();
  return forward(
    req,
    'POST',
    `/v1/organizations/${orgId}/installment_plans/${id}/installments/${seq}/simulate`
  );
}
