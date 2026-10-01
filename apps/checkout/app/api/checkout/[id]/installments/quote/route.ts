import { proxyCheckout } from '../../../../proxy';

/** Cotización (sin persistir) del calendario de cuotas. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyCheckout(req, id, '/installments/quote', 'POST');
}
