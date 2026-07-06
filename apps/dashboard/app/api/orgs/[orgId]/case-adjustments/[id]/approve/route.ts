import { adjustmentPath, proxySessionPost } from '../../../../../../lib/proxy';

/** Aprobar un ajuste (F4-03c-ii). FOUR-EYES: la API exige que el aprobador sea
 * distinto del proponente sobre umbral; si es el mismo devuelve 409
 * `four_eyes_required`, que la UI transmite y muestra sin ambigüedad. */
export async function POST(_req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  return proxySessionPost(adjustmentPath(orgId, id, 'approve'), '{}');
}
