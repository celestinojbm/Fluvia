import { casePath, proxySessionPost } from '../../../../../../lib/proxy';

/** Reconocer un caso (F4-03c-ii). Requiere `reconciliation:manage` en la API. */
export async function POST(_req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  return proxySessionPost(casePath(orgId, id, 'acknowledge'), '{}');
}
