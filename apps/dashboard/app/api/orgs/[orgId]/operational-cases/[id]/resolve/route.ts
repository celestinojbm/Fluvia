import { casePath, proxySessionPost } from '../../../../../../lib/proxy';

/** Resolver un caso — DOCUMENTAL, no mueve dinero (F4-03c-ii). Reenvía el cuerpo
 * `{ resolution }` a la API, que valida y exige `reconciliation:manage`. */
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  const body = await req.text();
  return proxySessionPost(casePath(orgId, id, 'resolve'), body);
}
