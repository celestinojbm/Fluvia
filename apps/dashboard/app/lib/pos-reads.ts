import type { CheckoutSession, PaymentIntent } from './api';

/**
 * Lecturas server-side del POS: «cobros recientes» = sesiones de checkout de la
 * organización unidas a su payment intent por `payment_intent_id` (campo real
 * del serializer; sin heurísticas de importe/fecha). Usa los GET existentes del
 * plano de sesión (`payments:read`).
 *
 * A diferencia de `apiGet` (que devuelve `[]` ante cualquier fallo), aquí un
 * fallo de lectura se distingue de «no hay cobros»: la UI no debe presentar
 * un error como historial vacío.
 */

export interface RecentCharge {
  session: CheckoutSession;
  /** null si el intent no llegó en la página leída (no se inventa). */
  payment: PaymentIntent | null;
}

export type RecentChargesResult = { ok: true; rows: RecentCharge[] } | { ok: false };

const SESSIONS_LIMIT = 25;
const INTENTS_LIMIT = 100;
export const RECENT_ROWS = 10;

async function list<T>(url: string, token: string, fetchImpl: typeof fetch): Promise<T[] | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      redirect: 'manual',
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { data?: unknown };
    return Array.isArray(body?.data) ? (body.data as T[]) : null;
  } catch {
    return null;
  }
}

export async function fetchRecentCharges(opts: {
  apiBase: string;
  token: string;
  orgId: string;
  fetchImpl?: typeof fetch;
}): Promise<RecentChargesResult> {
  const f = opts.fetchImpl ?? fetch;
  const base = `${opts.apiBase}/v1/organizations/${encodeURIComponent(opts.orgId)}`;
  const [sessions, intents] = await Promise.all([
    list<CheckoutSession>(`${base}/checkout_sessions?limit=${SESSIONS_LIMIT}`, opts.token, f),
    list<PaymentIntent>(`${base}/payment_intents?limit=${INTENTS_LIMIT}`, opts.token, f),
  ]);
  if (sessions === null || intents === null) return { ok: false };
  return { ok: true, rows: joinRecentCharges(sessions, intents) };
}

/** Unión pura (testeable): más recientes primero, por `payment_intent_id`. */
export function joinRecentCharges(
  sessions: CheckoutSession[],
  intents: PaymentIntent[]
): RecentCharge[] {
  const byId = new Map(intents.map((i) => [i.id, i]));
  return [...sessions]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, RECENT_ROWS)
    .map((session) => ({ session, payment: byId.get(session.payment_intent_id) ?? null }));
}
