import { cookies } from 'next/headers';
import { apiBase } from './api';
import {
  DEFAULT_DISPLAY,
  DISPLAY_COOKIE,
  isDisplayCurrency,
  type DisplayCurrency,
  type FxRates,
} from './fx';

/**
 * Lectura server-side de las tasas de referencia (la API sirve su caché
 * compartida; aquí no se consulta ninguna fuente externa) y de la moneda de
 * visualización guardada EN ESTE DISPOSITIVO (cookie). Cualquier fallo ⇒
 * `rates: null` y la interfaz muestra «No disponible», nunca un valor.
 */
export async function readFxRates(): Promise<FxRates | null> {
  try {
    const res = await fetch(`${apiBase()}/v1/fx/rates`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as FxRates;
    return Array.isArray(body?.references) ? body : null;
  } catch {
    return null;
  }
}

export async function readDisplayCurrency(): Promise<DisplayCurrency> {
  const v = (await cookies()).get(DISPLAY_COOKIE)?.value;
  return isDisplayCurrency(v) ? v : DEFAULT_DISPLAY;
}

export async function loadFx(): Promise<{ rates: FxRates | null; display: DisplayCurrency }> {
  const [rates, display] = await Promise.all([readFxRates(), readDisplayCurrency()]);
  return { rates, display };
}
