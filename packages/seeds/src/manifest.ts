import type { Pool } from '@fluvia/db';

/**
 * Manifiesto SEMANTICO del showroom (F6.5C3, determinismo semantico — plan
 * F6.5C §5, corrección rev. 4).
 *
 * Los servicios generan sus PKs por `gen_random_uuid()`/`randomUUID()` y NO
 * aceptan un id del llamador: los UUIDs fisicos NO son estables entre resets,
 * y tampoco lo son timestamps, salts, password hashes, secretos de API keys o
 * webhooks, provider refs (`mock_<sha256>`), ni IDs de auditoria/outbox/inbox.
 *
 * El contrato de igualdad entre dos ciclos `demo:reset -> migrate ->
 * seedShowroom` es ESTE manifiesto: solo informacion estable y NO secreta
 * (emails logicos, slugs, nombres, cantidades, estados, montos, monedas,
 * relaciones logicas por alias, balances finales, clases de conciliacion,
 * acciones de auditoria esperadas). Orden canonico en objetos y arrays; cero
 * dependencia del orden accidental de un SELECT.
 *
 * EXCLUIDO por contrato: UUIDs fisicos, timestamps, salts/hashes, secretos,
 * tokens, provider refs, objetos Error.
 */

export interface ManifestEntityState {
  alias: string;
  amount: string;
  currency: string;
  status: string;
  failureCode: string | null;
}

export interface ShowroomSemanticManifest {
  manifestVersion: 1;
  organization: { name: string; slug: string };
  users: Array<{ email: string; membershipRole: string | null }>;
  merchant: { name: string; country: string; defaultCurrency: string };
  customers: Array<{ name: string; state: 'active' | 'soft_deleted' }>;
  paymentIntents: ManifestEntityState[];
  checkoutSessions: Array<{ alias: string; intentAmount: string; status: string }>;
  paymentLinks: Array<{ amount: string; currency: string; status: string }>;
  refunds: ManifestEntityState[];
  payouts: ManifestEntityState[];
  disputes: Array<{ alias: string; amount: string; currency: string; status: string }>;
  reconciliation: {
    reports: number;
    classes: {
      matched: number;
      amount_mismatch: number;
      missing_in_ledger: number;
      missing_at_provider: number;
    };
    cases: { open: number; acknowledged: number; resolved: number };
    adjustment: {
      status: string;
      amount: string;
      currency: string;
      requiresSecondApproval: boolean;
      approvedByDistinctActor: boolean;
    } | null;
  };
  webhooks: {
    endpoints: Array<{ events: string[]; status: string }>;
    events: { delivered: number; dead: number; pending: number };
  };
  apiKeys: Array<{ label: string; environment: string; scopes: string[]; revoked: boolean }>;
  audit: Record<string, number>;
  balances: Record<string, string>;
}

/** Cuentas del chart que el manifiesto reporta (nombres LOGICOS, sin merchant id). */
const BALANCE_CODES = [
  'provider.clearing',
  'provider.receivable',
  'provider.payable',
  'provider.fees',
  'platform.fees',
  'platform.cash',
  'payout.in_transit',
  'suspense',
  'recon.differences',
  'merchant.pending',
  'merchant.available',
  'merchant.reserve',
  'refund.liability',
  'dispute.reserve',
] as const;

const SHOWROOM_SLUG = 'showroom-fluvia';

function byString<T>(key: (v: T) => string): (a: T, b: T) => number {
  return (a, b) => key(a).localeCompare(key(b));
}

/**
 * Construye el manifiesto desde el ESTADO REAL de la base dedicada, con
 * lecturas exclusivamente READ-ONLY (permitidas para construir/verificar el
 * manifiesto). Los alias son funciones deterministas de montos/estados (los
 * montos del dataset son unicos por tipo de entidad por diseño).
 */
export async function buildShowroomSemanticManifest(
  admin: Pool
): Promise<ShowroomSemanticManifest> {
  const org = await admin.query<{ id: string; name: string; slug: string }>(
    `SELECT id, name, slug FROM organizations WHERE slug = $1 AND deleted_at IS NULL`,
    [SHOWROOM_SLUG]
  );
  const orgRow = org.rows[0];
  if (!orgRow) {
    throw new Error(`showroom manifest: organization with slug "${SHOWROOM_SLUG}" not found`);
  }
  const tenantId = orgRow.id;

  const users = await admin.query<{ email: string; role: string | null }>(
    `SELECT u.email, m.role
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1 AND m.revoked_at IS NULL
     WHERE u.email LIKE '%@showroom.fluvia.test' AND u.deleted_at IS NULL
     ORDER BY u.email`,
    [tenantId]
  );

  const merchant = await admin.query<{ name: string; country: string; default_currency: string }>(
    `SELECT name, country, default_currency FROM merchants
     WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [tenantId]
  );
  const merchantRow = merchant.rows[0];
  if (!merchantRow || merchant.rows.length !== 1) {
    throw new Error('showroom manifest: expected exactly one showroom merchant');
  }

  const customers = await admin.query<{ name: string | null; deleted: boolean }>(
    `SELECT name, (deleted_at IS NOT NULL) AS deleted FROM customers WHERE tenant_id = $1`,
    [tenantId]
  );

  const intents = await admin.query<{
    amount: string;
    currency: string;
    status: string;
    failure_code: string | null;
  }>(
    `SELECT amount::text, trim(currency) AS currency, status, failure_code
     FROM payment_intents WHERE tenant_id = $1`,
    [tenantId]
  );

  const sessions = await admin.query<{ status: string; amount: string }>(
    `SELECT cs.status, i.amount::text
     FROM checkout_sessions cs JOIN payment_intents i ON i.id = cs.payment_intent_id
     WHERE cs.tenant_id = $1`,
    [tenantId]
  );

  const links = await admin.query<{ amount: string; currency: string; status: string }>(
    `SELECT amount::text, trim(currency) AS currency, status FROM payment_links
     WHERE tenant_id = $1`,
    [tenantId]
  );

  const refunds = await admin.query<{
    amount: string;
    currency: string;
    status: string;
    failure_code: string | null;
  }>(
    `SELECT amount::text, trim(currency) AS currency, status, failure_code FROM refunds
     WHERE tenant_id = $1`,
    [tenantId]
  );

  const payouts = await admin.query<{
    amount: string;
    currency: string;
    status: string;
    failure_code: string | null;
  }>(
    `SELECT amount::text, trim(currency) AS currency, status, failure_code FROM payouts
     WHERE tenant_id = $1`,
    [tenantId]
  );

  const disputes = await admin.query<{ amount: string; currency: string; status: string }>(
    `SELECT amount::text, trim(currency) AS currency, status FROM disputes WHERE tenant_id = $1`,
    [tenantId]
  );

  const reports = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM settlement_reports WHERE tenant_id = $1`,
    [tenantId]
  );
  const entryClasses = await admin.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM reconciliation_entries
     WHERE tenant_id = $1 GROUP BY status`,
    [tenantId]
  );
  const classes = {
    matched: 0,
    amount_mismatch: 0,
    missing_in_ledger: 0,
    missing_at_provider: 0,
  };
  for (const row of entryClasses.rows) {
    if (row.status in classes) classes[row.status as keyof typeof classes] = Number(row.n);
  }

  const caseStates = await admin.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM operational_cases
     WHERE tenant_id = $1 GROUP BY status`,
    [tenantId]
  );
  const cases = { open: 0, acknowledged: 0, resolved: 0 };
  for (const row of caseStates.rows) {
    if (row.status in cases) cases[row.status as keyof typeof cases] = Number(row.n);
  }

  const adjustment = await admin.query<{
    amount: string;
    currency: string;
    status: string;
    requires_second_approval: boolean;
    proposed_by_user_id: string;
    approved_by_user_id: string | null;
  }>(
    `SELECT amount::text, trim(currency) AS currency, status, requires_second_approval,
            proposed_by_user_id, approved_by_user_id
     FROM case_adjustments WHERE tenant_id = $1`,
    [tenantId]
  );
  if (adjustment.rows.length > 1) {
    throw new Error('showroom manifest: expected at most one case adjustment');
  }
  const adj = adjustment.rows[0];

  const endpoints = await admin.query<{ events: string[]; status: string }>(
    `SELECT events, status FROM webhook_endpoints WHERE tenant_id = $1`,
    [tenantId]
  );
  const webhookEvents = await admin.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM webhook_events
     WHERE tenant_id = $1 GROUP BY status`,
    [tenantId]
  );
  const eventCounts = { delivered: 0, dead: 0, pending: 0 };
  for (const row of webhookEvents.rows) {
    if (row.status in eventCounts) {
      eventCounts[row.status as keyof typeof eventCounts] = Number(row.n);
    }
  }

  const apiKeys = await admin.query<{
    label: string;
    environment: string;
    scopes: string[];
    revoked: boolean;
  }>(
    `SELECT label, environment, scopes, (revoked_at IS NOT NULL) AS revoked
     FROM api_keys WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId]
  );

  const audit = await admin.query<{ action: string; n: string }>(
    `SELECT action, count(*)::text AS n FROM audit_events
     WHERE tenant_id = $1 OR tenant_id IS NULL GROUP BY action ORDER BY action`,
    [tenantId]
  );

  // Balances por CODIGO logico del chart (el sufijo fisico `:merchantId` de las
  // cuentas merchant-scoped se colapsa — jamas exponemos el UUID).
  const balances = await admin.query<{ name: string; available: string }>(
    `SELECT la.name, COALESCE(bp.available, 0)::text AS available
     FROM ledger_accounts la
     LEFT JOIN balance_projections bp ON bp.account_id = la.id
     WHERE la.tenant_id = $1 AND la.deleted_at IS NULL`,
    [tenantId]
  );
  const balanceByCode: Record<string, string> = {};
  for (const code of BALANCE_CODES) balanceByCode[code] = '0';
  for (const row of balances.rows) {
    const code = row.name.includes(':') ? row.name.slice(0, row.name.indexOf(':')) : row.name;
    if ((BALANCE_CODES as readonly string[]).includes(code)) {
      balanceByCode[code] = (BigInt(balanceByCode[code] ?? '0') + BigInt(row.available)).toString();
    }
  }

  const toEntity = (r: {
    amount: string;
    currency: string;
    status: string;
    failure_code: string | null;
  }): ManifestEntityState => ({
    alias: `${r.status}:${r.amount}`,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    failureCode: r.failure_code,
  });
  const entitySort = byString<ManifestEntityState>(
    (e) => `${e.status}|${e.amount.padStart(16, '0')}`
  );

  return {
    manifestVersion: 1,
    organization: { name: orgRow.name, slug: orgRow.slug },
    users: users.rows.map((u) => ({ email: u.email, membershipRole: u.role })),
    merchant: {
      name: merchantRow.name,
      country: merchantRow.country,
      defaultCurrency: merchantRow.default_currency,
    },
    customers: customers.rows
      .map((c) => ({
        name: c.name ?? '(sin nombre)',
        state: (c.deleted ? 'soft_deleted' : 'active') as 'active' | 'soft_deleted',
      }))
      .sort(byString((c) => `${c.state}|${c.name}`)),
    paymentIntents: intents.rows.map(toEntity).sort(entitySort),
    checkoutSessions: sessions.rows
      .map((s) => ({ alias: `${s.status}:${s.amount}`, intentAmount: s.amount, status: s.status }))
      .sort(byString((s) => s.alias)),
    paymentLinks: links.rows
      .map((l) => ({ amount: l.amount, currency: l.currency, status: l.status }))
      .sort(byString((l) => `${l.status}|${l.amount.padStart(16, '0')}`)),
    refunds: refunds.rows.map(toEntity).sort(entitySort),
    payouts: payouts.rows.map(toEntity).sort(entitySort),
    disputes: disputes.rows
      .map((d) => ({
        alias: `${d.status}:${d.amount}`,
        amount: d.amount,
        currency: d.currency,
        status: d.status,
      }))
      .sort(byString((d) => d.alias)),
    reconciliation: {
      reports: Number(reports.rows[0]!.n),
      classes,
      cases,
      adjustment: adj
        ? {
            status: adj.status,
            amount: adj.amount,
            currency: adj.currency,
            requiresSecondApproval: adj.requires_second_approval,
            approvedByDistinctActor:
              adj.approved_by_user_id !== null &&
              adj.approved_by_user_id !== adj.proposed_by_user_id,
          }
        : null,
    },
    webhooks: {
      endpoints: endpoints.rows
        .map((e) => ({ events: [...e.events].sort(), status: e.status }))
        .sort(byString((e) => `${e.events.join(',')}|${e.status}`)),
      events: eventCounts,
    },
    apiKeys: apiKeys.rows
      .map((k) => ({
        label: k.label,
        environment: k.environment,
        scopes: [...k.scopes].sort(),
        revoked: k.revoked,
      }))
      .sort(byString((k) => k.label)),
    audit: Object.fromEntries(audit.rows.map((a) => [a.action, Number(a.n)])),
    balances: balanceByCode,
  };
}

/** Canonicaliza recursivamente: claves de objeto ordenadas; arrays intactos
 *  (ya vienen en orden canonico definido por el builder). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Serializacion CANONICA: el mismo manifiesto semantico produce SIEMPRE el
 * mismo JSON byte-for-byte (claves ordenadas, arrays en orden definido).
 */
export function serializeShowroomManifest(manifest: ShowroomSemanticManifest): string {
  return `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;
}
