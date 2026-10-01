import { proxyCheckout } from '../../../proxy';

/** Resumen del pedido + opción de cuotas (simulación) de este checkout. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyCheckout(req, id, '/order', 'GET');
}
