import { NextResponse } from 'next/server';
import { readFxRates } from '../../../lib/fx-server';

export const dynamic = 'force-dynamic';

/**
 * Tasas de referencia para el refresco en el navegador (el navegador no
 * conoce la URL de la API). Solo lectura de la caché compartida del servidor.
 */
export async function GET() {
  const rates = await readFxRates();
  if (!rates) {
    return NextResponse.json(
      { error: 'fx_unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } }
    );
  }
  return NextResponse.json(rates, { headers: { 'cache-control': 'private, max-age=30' } });
}
