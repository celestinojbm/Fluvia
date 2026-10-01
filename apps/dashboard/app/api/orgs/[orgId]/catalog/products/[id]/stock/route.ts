import { badRequest, forward, validIds } from '../../../../../../../lib/bff';

/**
 * Entrada o ajuste de existencias (API: `merchants:write`, auditado).
 * Idempotente: exige y propaga la `Idempotency-Key` del formulario, así un
 * doble envío o un reintento tras resultado incierto no suma dos veces.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  if (!validIds(orgId, id)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/catalog/products/${id}/stock`, {
    idempotent: true,
  });
}
