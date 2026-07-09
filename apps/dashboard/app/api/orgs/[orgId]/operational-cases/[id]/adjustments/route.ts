import { casePath, proxySessionPost } from '../../../../../../lib/proxy';

/** Proponer un ajuste monetario sobre un caso (F4-03c-ii). El proponente lo fija
 * la API por `req.identity.userId` (no viaja en el cuerpo). Reenvía
 * `{ amount, currency, direction, reason }`; requiere `reconciliation:manage`. */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  const body = await req.text();
  return proxySessionPost(casePath(orgId, id, 'adjustments'), body);
}
