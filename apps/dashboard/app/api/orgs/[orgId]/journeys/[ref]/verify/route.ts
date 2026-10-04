import { badRequest, forward, validIds } from '../../../../../../lib/bff';

/**
 * Verificar los cobros y devoluciones INCIERTOS de UN caso (API:
 * `reconciliation:manage`). Solo se aplica lo que responde el proveedor.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string; ref: string }> }) {
  const { orgId, ref } = await ctx.params;
  if (!validIds(orgId, ref)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/journeys/${ref}/verify`);
}
