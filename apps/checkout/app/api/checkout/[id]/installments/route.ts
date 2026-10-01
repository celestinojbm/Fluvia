import { proxyCheckout } from '../../../proxy';

/** Confirmación explícita del plan de cuotas (simulación). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyCheckout(req, id, '/installments', 'POST');
}
