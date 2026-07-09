import { adjustmentPath, proxySessionPost } from '../../../../../../lib/proxy';

/** Rechazar un ajuste propuesto (F4-03c-ii). Reenvía `{ reason }`; libera el caso
 * para una nueva propuesta. Requiere `reconciliation:manage`. */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  const body = await req.text();
  return proxySessionPost(adjustmentPath(orgId, id, 'reject'), body);
}
