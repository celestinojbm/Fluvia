import { badRequest, forward, validIds } from '../../../../../lib/bff';

/** Crear producto (API: `merchants:write`, auditado). */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  if (!validIds(orgId)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/catalog/products`);
}

/** Productos vendibles (para refrescar precios en «Nueva venta»). */
export async function GET(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  if (!validIds(orgId)) return badRequest();
  return forward(req, 'GET', `/v1/organizations/${orgId}/catalog/products?sellable=true&limit=500`);
}
