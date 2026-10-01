import { badRequest, forward, validIds } from '../../../../lib/bff';

/** Buscar clientes (para asignarlos a una venta). Solo `q`, acotado. */
export async function GET(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  if (!validIds(orgId)) return badRequest();
  const q = (new URL(req.url).searchParams.get('q') ?? '').slice(0, 120);
  return forward(
    req,
    'GET',
    `/v1/organizations/${orgId}/customers?limit=20&q=${encodeURIComponent(q)}`
  );
}

/** Crear cliente (API: `reconciliation:manage`, auditado). */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  if (!validIds(orgId)) return badRequest();
  return forward(req, 'POST', `/v1/organizations/${orgId}/customers`);
}
