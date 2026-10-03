import { parseDecimalRate } from './rate.js';

/**
 * CoinGecko «simple/price» (API documentada: docs.coingecko.com):
 * GET /simple/price?ids=tether&vs_currencies=usd&include_last_updated_at=true&precision=full
 * Devuelve el precio AGREGADO de mercado de USDT en USD y la hora (epoch s)
 * de su última actualización. No es un precio P2P ni ejecutable.
 */
export interface UsdtReading {
  usdtUsd: string;
  sourceUpdatedAt: string; // ISO
}

export class CoinGeckoFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoinGeckoFormatError';
  }
}

export function parseCoinGecko(body: unknown): UsdtReading {
  const t = (body as { tether?: { usd?: unknown; last_updated_at?: unknown } } | null)?.tether;
  if (!t || typeof t.usd !== 'number' || typeof t.last_updated_at !== 'number') {
    throw new CoinGeckoFormatError('respuesta sin tether.usd / last_updated_at');
  }
  if (!(t.usd > 0) || t.usd > 10) throw new CoinGeckoFormatError(`precio fuera de rango: ${t.usd}`);
  return {
    usdtUsd: parseDecimalRate(t.usd.toFixed(8)),
    sourceUpdatedAt: new Date(t.last_updated_at * 1000).toISOString(),
  };
}

export function coinGeckoRequest(cfg: { baseUrl: string; apiKey: string | null; pro: boolean }) {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/simple/price?ids=tether&vs_currencies=usd&include_last_updated_at=true&precision=full`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.apiKey) headers[cfg.pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = cfg.apiKey;
  return { url, headers };
}
