import { badRequest, forward, validIds } from '../../../../../lib/bff';

/**
 * Resolver cobros y devoluciones INCIERTOS por consulta verificable al
 * proveedor (API: `reconciliation:manage`). Nada se da por pagado ni por
 * fallido sin la respuesta del proveedor.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  if (!validIds(orgId)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/uncertain/resolve`);
}
