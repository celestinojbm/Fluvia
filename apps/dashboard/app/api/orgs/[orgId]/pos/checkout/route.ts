import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBase, canManageReconciliation } from '../../../../../lib/api';
import { assertTrustedMutationRequest } from '../../../../../lib/csrf';
import { UUID_RE, type PosErrorCode } from '../../../../../lib/pos-contract';

/**
 * POS sandbox — abrir el cobro de una venta. Toma un payment link YA creado
 * por sesión y abre una sesión de checkout alojada con el endpoint PÚBLICO
 * existente `POST /v1/payment_links/:id/sessions` (el mismo que usa `/l/:id`
 * del checkout). No hay endpoint nuevo en la API.
 *
 * Orden (fail-closed en cada paso):
 *  1. Guard CSRF ANTES de leer cookie/body (mutación: crea intent + sesión).
 *  2. Sesión obligatoria; body `{ payment_link_id: uuid }` o 400.
 *  3. Rol con `reconciliation:manage` (mismo permiso que crear el link; el API
 *     sigue siendo la fuente de verdad del resto).
 *  4. PROPIEDAD: el link se lee por el plano de SESIÓN de esta org (RLS +
 *     membresía). Solo si existe aquí y está `active` se abre la sesión — el
 *     BFF jamás usa el endpoint público para un link ajeno.
 *     Una venta de cobro único ya cobrada o cobrando ⇒ 409 `sale_already_charged`.
 *  5. Apertura con contrato ESTRICTO (status 200 exacto, body validado). Esta
 *     llamada NO es idempotente: ante un resultado incierto (red, 5xx, 2xx
 *     malformado) se responde `checkout_open_uncertain` y NO se reintenta
 *     automáticamente. Una sesión abierta y no pagada no cobra nada y expira
 *     sola (watchdog de checkout).
 *
 * El `client_secret` solo sale hacia el navegador del operador dentro del
 * FRAGMENTO de `checkout_url` (como hace `/l/:id`); nunca se loguea.
 */

function fail(code: PosErrorCode, status: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code } },
    { status, headers: { 'cache-control': 'no-store' } }
  );
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const rejected = assertTrustedMutationRequest(req);
  if (rejected) return rejected;

  const { orgId } = await ctx.params;
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) return fail('invalid_session', 401);

  const raw = (await req.json().catch(() => null)) as { payment_link_id?: unknown } | null;
  const linkId = raw?.payment_link_id;
  if (typeof linkId !== 'string' || !UUID_RE.test(linkId) || !UUID_RE.test(orgId)) {
    return fail('validation_error', 400);
  }

  const base = apiBase();
  const auth = { authorization: `Bearer ${token}` };
  const org = encodeURIComponent(orgId);

  // 3. Rol (lectura): sin membresía o sin permiso ⇒ nada se abre.
  let orgsRes: Response;
  try {
    orgsRes = await fetch(`${base}/v1/organizations`, {
      headers: auth,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return fail('upstream_unavailable', 502);
  }
  if (orgsRes.status === 401) return fail('invalid_session', 401);
  if (orgsRes.status !== 200) return fail('upstream_unavailable', 502);
  const orgs = (await readJson(orgsRes)) as { organizations?: unknown } | null;
  if (!Array.isArray(orgs?.organizations)) return fail('upstream_unavailable', 502);
  const membership = (orgs.organizations as Array<Record<string, unknown>>).find(
    (o) => o?.organization_id === orgId
  );
  if (!membership) return fail('not_found', 404);
  if (!canManageReconciliation(String(membership.role ?? ''))) {
    return fail('insufficient_permissions', 403);
  }

  // 4. Propiedad + estado del link por el plano de sesión de ESTA org.
  let linkRes: Response;
  try {
    linkRes = await fetch(
      `${base}/v1/organizations/${org}/payment_links/${encodeURIComponent(linkId)}`,
      { headers: auth, cache: 'no-store', redirect: 'manual' }
    );
  } catch {
    return fail('upstream_unavailable', 502);
  }
  if (linkRes.status === 401) return fail('invalid_session', 401);
  if (linkRes.status === 403) return fail('insufficient_permissions', 403);
  if (linkRes.status === 404) return fail('not_found', 404);
  if (linkRes.status !== 200) return fail('upstream_unavailable', 502);
  const link = (await readJson(linkRes)) as { id?: unknown; status?: unknown } | null;
  if (link?.id !== linkId) return fail('upstream_unavailable', 502);
  if (link.status !== 'active') return fail('link_unavailable', 409);

  // 5. Apertura (no idempotente) — sin reintentos automáticos.
  let openRes: Response;
  try {
    openRes = await fetch(`${base}/v1/payment_links/${encodeURIComponent(linkId)}/sessions`, {
      method: 'POST',
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return fail('checkout_open_uncertain', 502);
  }
  // Rechazos ANTES del handler: con certeza no se creó nada.
  if (openRes.status === 404) return fail('link_unavailable', 409);
  // Venta de cobro único ya cobrada o cobrando (0046): el servidor no abre un
  // checkout que jamás podría cobrar.
  if (openRes.status === 409) return fail('sale_already_charged', 409);
  if (openRes.status === 429) return fail('rate_limited', 429);
  if (openRes.status === 400) return fail('validation_error', 400);
  if (openRes.status !== 200) return fail('checkout_open_uncertain', 502);

  const opened = (await readJson(openRes)) as Record<string, unknown> | null;
  const sid = opened?.checkout_session_id;
  const secret = opened?.client_secret;
  const url = opened?.url;
  if (
    typeof sid !== 'string' ||
    !UUID_RE.test(sid) ||
    typeof secret !== 'string' ||
    secret.length === 0 ||
    secret.length > 200 ||
    typeof url !== 'string' ||
    !/^https?:\/\//.test(url) ||
    !url.endsWith(`/c/${sid}`)
  ) {
    return fail('checkout_open_uncertain', 502);
  }

  return NextResponse.json(
    { checkout_session_id: sid, checkout_url: `${url}#${encodeURIComponent(secret)}` },
    { status: 201, headers: { 'cache-control': 'no-store' } }
  );
}
