import type { Org } from './api';

/**
 * RA-F65C2-EXT-003 — lecturas ESTRICTAS y fail-closed para `/onboarding`.
 *
 * El contrato historico `apiGet → null → []` degrada cualquier fallo (500,
 * red, JSON invalido…) a lista vacia, y una lista vacia decide el ESTADO del
 * onboarding (Paso 1 / Paso 2 vacio) — inaceptable para un flujo que muta.
 * Estos helpers devuelven un resultado DISCRIMINADO: solo el status exacto
 * contractual (200) con JSON valido y shape valido produce `ok:true`; todo lo
 * demas es un fallo tipado que el caller debe tratar como estado de lectura
 * fallida (jamas como vacio). Los consumidores historicos de `apiGet` no se
 * tocan.
 */

export type ReadFailureKind =
  'unauthorized' | 'forbidden' | 'not_found' | 'http_error' | 'network_error' | 'invalid_response';

export type ReadResult<T> = { ok: true; value: T } | { ok: false; kind: ReadFailureKind };

export interface OnboardingMerchant {
  id: string;
  name: string;
  country: string;
  defaultCurrency: string;
}

interface ReadOptions {
  apiBase: string;
  token: string;
  fetchImpl?: typeof fetch;
}

function failureForStatus(status: number): ReadFailureKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'http_error';
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

async function readJson(
  opts: ReadOptions,
  path: string
): Promise<{ ok: true; body: unknown } | { ok: false; kind: ReadFailureKind }> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${opts.apiBase}${path}`, {
      headers: { authorization: `Bearer ${opts.token}` },
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return { ok: false, kind: 'network_error' };
  }
  // Solo el status exacto contractual del GET (200) es aceptable; un redirect
  // u otro 2xx tampoco lo es (fail-closed).
  if (res.status !== 200) return { ok: false, kind: failureForStatus(res.status) };
  try {
    return { ok: true, body: (await res.json()) as unknown };
  } catch {
    return { ok: false, kind: 'invalid_response' };
  }
}

/** GET /v1/organizations — estricto: array con entradas de tipos validos. */
export async function readOrganizations(opts: ReadOptions): Promise<ReadResult<Org[]>> {
  const read = await readJson(opts, '/v1/organizations');
  if (!read.ok) return read;
  const body = read.body as { organizations?: unknown } | null;
  const list = body?.organizations;
  if (!Array.isArray(list)) return { ok: false, kind: 'invalid_response' };
  const orgs: Org[] = [];
  for (const entry of list) {
    const o = entry as {
      organization_id?: unknown;
      name?: unknown;
      slug?: unknown;
      role?: unknown;
    } | null;
    if (
      !o ||
      !isNonEmptyString(o.organization_id) ||
      typeof o.name !== 'string' ||
      typeof o.slug !== 'string' ||
      !isNonEmptyString(o.role)
    ) {
      // Shape invalido: NO se usan datos parciales de la respuesta.
      return { ok: false, kind: 'invalid_response' };
    }
    orgs.push({ organization_id: o.organization_id, name: o.name, slug: o.slug, role: o.role });
  }
  return { ok: true, value: orgs };
}

/** GET /v1/organizations/:orgId/merchants — estricto (campos usados). */
export async function readMerchants(
  opts: ReadOptions & { orgId: string }
): Promise<ReadResult<OnboardingMerchant[]>> {
  const read = await readJson(
    opts,
    `/v1/organizations/${encodeURIComponent(opts.orgId)}/merchants`
  );
  if (!read.ok) return read;
  const body = read.body as { merchants?: unknown } | null;
  const list = body?.merchants;
  if (!Array.isArray(list)) return { ok: false, kind: 'invalid_response' };
  const merchants: OnboardingMerchant[] = [];
  for (const entry of list) {
    const m = entry as {
      id?: unknown;
      name?: unknown;
      country?: unknown;
      defaultCurrency?: unknown;
    } | null;
    if (
      !m ||
      !isNonEmptyString(m.id) ||
      typeof m.name !== 'string' ||
      typeof m.country !== 'string' ||
      typeof m.defaultCurrency !== 'string'
    ) {
      return { ok: false, kind: 'invalid_response' };
    }
    merchants.push({
      id: m.id,
      name: m.name,
      country: m.country,
      defaultCurrency: m.defaultCurrency,
    });
  }
  return { ok: true, value: merchants };
}
