import { UUID_RE } from './pos-contract';

/**
 * Lecturas del POS: «cobros recientes» = sesiones de checkout de la
 * organización unidas a su payment intent por `payment_intent_id` (campo real
 * del serializer; sin heurísticas de importe/fecha). Usa los GET existentes del
 * plano de sesión (`payments:read`, RLS + membresía de la org).
 *
 * VENTANA: los listados de la API no tienen filtros ni paginación y aceptan
 * `limit ≤ 100`. El POS lee la ventana máxima y filtra DENTRO de ella; la UI
 * lo dice (nunca lo presenta como búsqueda en todo el historial).
 *
 * A diferencia de `apiGet` (que devuelve `[]` ante cualquier fallo), aquí un
 * fallo de lectura se distingue de «no hay cobros» y la sesión caducada (401)
 * de «no disponible»: la UI no presenta un error como historial vacío.
 */

/** Tope de `limit` de los listados del plano de sesión (`LimitQuery`). */
export const RECENT_WINDOW = 100;

/** Fila del panel, reconstruida por WHITELIST (sin `url` ni `client_secret`). */
export interface RecentCharge {
  session: { id: string; status: string; created_at: string; expires_at: string };
  /** null si el intent no llegó en la ventana leída (no se inventa). */
  payment: {
    id: string;
    merchant_id: string;
    amount: number;
    currency: string;
    status: string;
    /** Venta del cobro (0046); null = cobro anterior al vínculo. */
    payment_link_id: string | null;
  } | null;
}

export interface RecentWindow {
  /** Máximo de sesiones que la API devuelve en una lectura. */
  limit: number;
  /** Sesiones leídas; `== limit` ⇒ puede haber cobros más antiguos fuera. */
  returned: number;
  truncated: boolean;
}

export type RecentChargesResult =
  | { ok: true; rows: RecentCharge[]; window: RecentWindow }
  | { ok: false; reason: 'auth' | 'forbidden' | 'unavailable' };

type ListResult = { ok: true; data: unknown[] } | { ok: false; status: number | null };

async function list(url: string, token: string, fetchImpl: typeof fetch): Promise<ListResult> {
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      redirect: 'manual',
    });
    if (res.status !== 200) return { ok: false, status: res.status };
    const body = (await res.json()) as { data?: unknown };
    return Array.isArray(body?.data) ? { ok: true, data: body.data } : { ok: false, status: null };
  } catch {
    return { ok: false, status: null };
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function pickListSession(v: unknown): (RecentCharge['session'] & { intentId: string }) | null {
  if (!isObj(v)) return null;
  const { id, status, created_at, expires_at, payment_intent_id } = v;
  if (!str(id) || !UUID_RE.test(id) || !str(status) || !str(created_at) || !str(expires_at)) {
    return null;
  }
  if (!str(payment_intent_id) || !UUID_RE.test(payment_intent_id)) return null;
  return { id, status, created_at, expires_at, intentId: payment_intent_id };
}

function pickListIntent(v: unknown): NonNullable<RecentCharge['payment']> | null {
  if (!isObj(v)) return null;
  const { id, merchant_id, amount, currency, status } = v;
  if (!str(id) || !UUID_RE.test(id) || !str(merchant_id) || !int(amount)) return null;
  if (!str(currency) || !str(status)) return null;
  const link = v.payment_link_id;
  if (link !== undefined && link !== null && !(str(link) && UUID_RE.test(link))) return null;
  return { id, merchant_id, amount, currency, status, payment_link_id: link ?? null };
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
    list(`${base}/checkout_sessions?limit=${RECENT_WINDOW}`, opts.token, f),
    list(`${base}/payment_intents?limit=${RECENT_WINDOW}`, opts.token, f),
  ]);
  if (!sessions.ok || !intents.ok) {
    const statuses = [sessions, intents].map((r) => (r.ok ? 200 : r.status));
    if (statuses.includes(401)) return { ok: false, reason: 'auth' };
    if (statuses.includes(403) || statuses.includes(404)) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  }
  return joinRecentCharges(sessions.data, intents.data);
}

/**
 * Unión pura (testeable): whitelist, más recientes primero, por
 * `payment_intent_id`. Una fila malformada se descarta (no se inventa).
 */
export function joinRecentCharges(
  sessions: unknown[],
  intents: unknown[]
): Extract<RecentChargesResult, { ok: true }> {
  const byId = new Map<string, NonNullable<RecentCharge['payment']>>();
  for (const raw of intents) {
    const i = pickListIntent(raw);
    if (i) byId.set(i.id, i);
  }
  const rows: RecentCharge[] = [];
  for (const raw of sessions) {
    const s = pickListSession(raw);
    if (!s) continue;
    const { intentId, ...session } = s;
    rows.push({ session, payment: byId.get(intentId) ?? null });
  }
  rows.sort((a, b) => b.session.created_at.localeCompare(a.session.created_at));
  return {
    ok: true,
    rows,
    window: {
      limit: RECENT_WINDOW,
      returned: sessions.length,
      truncated: sessions.length >= RECENT_WINDOW,
    },
  };
}
