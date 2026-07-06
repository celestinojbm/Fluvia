import { disputePath, proxySessionPost } from '../../../../../../lib/proxy';

/** Responder a una disputa con evidencia por SESIÓN (F4-08e): `open -> under_review`.
 * Sin cuerpo. Reenvía la cookie httpOnly a la API, que exige `reconciliation:manage`;
 * es idempotente (re-responder sobre `under_review` devuelve el estado actual). El
 * navegador jamás sostiene el token ni conoce la URL de la API. */
export async function POST(_req: Request, ctx: { params: Promise<{ orgId: string; id: string }> }) {
  const { orgId, id } = await ctx.params;
  return proxySessionPost(disputePath(orgId, id, 'evidence'), '{}');
}
