import { withPlatformOperation } from '@fluvia/audit';
import type { Pool, PoolClient } from '@fluvia/db';
import { z } from 'zod';
import {
  IdentityError,
  MerchantNotFoundError,
  MerchantOnboardingBlockedError,
  isMerchantOnboardingBlockedDbError,
} from './errors.js';
import type { StateAffiliation } from './schemas.js';

/**
 * #92 — bloqueo de comercios del Gobierno de Venezuela/PDVSA hasta dictamen, y
 * congelación de comercios hecha cumplir por el motor (migración 0069).
 *
 * PLANO DE PLATAFORMA: pool admin, razón obligatoria y auditoría
 * `platform.operation` de riesgo alto en la MISMA transacción. Jamás exponer
 * {@link MerchantRiskAdmin} a requests de usuarios finales: se opera por CLI
 * (`merchant-risk-cli.ts`, runbook `docs/ops/runbooks/merchant-risk.md`).
 *
 * El motor es quien decide: congelar corta intents, attempts y la emisión de
 * payouts (SQLSTATE FV453, `isMerchantFrozenDbError` en @fluvia/payments-core); descongelar un comercio
 * declarado estatal o con nombre bloqueado falla (FV452) hasta que una
 * migración levante el bloqueo tras el dictamen.
 */

/** El patrón queda vacío (o demasiado largo) tras normalizarlo. */
export class InvalidDenylistPatternError extends IdentityError {
  constructor() {
    super('Denylist pattern must have 2 to 120 letters or digits after normalization');
  }
}

export class DenylistEntryNotFoundError extends IdentityError {
  constructor() {
    super('Denylist entry not found');
  }
}

export class DenylistEntryAlreadyRetiredError extends IdentityError {
  constructor(readonly id: string) {
    super(`Denylist entry ${id} was already retired`);
  }
}

/** Flag consultable de 0069: legado sin declaración vs ya declarado. */
export type AffiliationDeclarationStatus = 'pending_review' | 'declared';

export interface MerchantRiskDto {
  id: string;
  tenantId: string;
  name: string;
  country: string;
  status: 'active' | 'frozen';
  stateAffiliation: StateAffiliation | null;
  affiliationDeclarationStatus: AffiliationDeclarationStatus;
}

export interface DenylistEntryDto {
  id: string;
  pattern: string;
  reason: string;
  addedBy: string | null;
  addedAt: string;
  retiredAt: string | null;
  retiredBy: string | null;
  retireReason: string | null;
}

/** Por qué `screen` marca un comercio activo. */
export type ScreenFinding = 'state_affiliated' | 'denylisted_name' | 'undeclared';

export interface ScreenResult {
  merchant: MerchantRiskDto;
  findings: ScreenFinding[];
}

export interface FreezeResult {
  merchant: MerchantRiskDto;
  /** false si ya estaba en el estado pedido (no-op, sin auditoría). */
  changed: boolean;
}

const Reason = z
  .string()
  .trim()
  .min(1, 'reason is required')
  .max(1000, 'reason must be at most 1000 characters');

/** Operador = id (uuid) del usuario de plataforma: es lo que guarda audit_events.actor_id. */
const Actor = z.string().trim().toLowerCase().uuid('actorId must be the operator user id (uuid)');
const Id = z.string().trim().toLowerCase().uuid('id must be a uuid');

const FreezeInput = z.object({ merchantId: Id, reason: Reason, actorId: Actor });
const AddPatternInput = z.object({
  // Se normaliza en el MOTOR (misma función que usa el guard), no en JS: dos
  // implementaciones de "normalizar" divergirían en tildes o siglas.
  pattern: z.string().trim().min(2).max(120),
  reason: Reason,
  actorId: Actor,
});
const RetireInput = z.object({ id: Id, reason: Reason, actorId: Actor });

interface MerchantRow {
  id: string;
  tenant_id: string;
  name: string;
  country: string;
  status: 'active' | 'frozen';
  state_affiliation: StateAffiliation | null;
  affiliation_declaration_status: AffiliationDeclarationStatus;
}

interface DenylistRow {
  id: string;
  pattern: string;
  reason: string;
  added_by: string | null;
  added_at: Date;
  retired_at: Date | null;
  retired_by: string | null;
  retire_reason: string | null;
}

const MERCHANT_RISK_COLUMNS = `id, tenant_id, name, country, status, state_affiliation, affiliation_declaration_status`;
const DENYLIST_COLUMNS = `id, pattern, reason, added_by, added_at, retired_at, retired_by, retire_reason`;

const toMerchant = (r: MerchantRow): MerchantRiskDto => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  country: r.country.trim(),
  status: r.status,
  stateAffiliation: r.state_affiliation,
  affiliationDeclarationStatus: r.affiliation_declaration_status,
});

const toEntry = (r: DenylistRow): DenylistEntryDto => ({
  id: r.id,
  pattern: r.pattern,
  reason: r.reason,
  addedBy: r.added_by,
  addedAt: r.added_at.toISOString(),
  retiredAt: r.retired_at?.toISOString() ?? null,
  retiredBy: r.retired_by,
  retireReason: r.retire_reason,
});

export class MerchantRiskAdmin {
  constructor(private readonly adminPool: Pool) {}

  /** Congela un comercio: el motor corta su dinero nuevo desde el commit. */
  async freeze(raw: {
    merchantId: string;
    reason: string;
    actorId: string;
  }): Promise<FreezeResult> {
    return this.setStatus(FreezeInput.parse(raw), 'frozen');
  }

  /**
   * Descongela. Falla con {@link MerchantOnboardingBlockedError} si el comercio
   * está declarado estatal o su nombre está en la lista (hasta dictamen).
   */
  async unfreeze(raw: {
    merchantId: string;
    reason: string;
    actorId: string;
  }): Promise<FreezeResult> {
    return this.setStatus(FreezeInput.parse(raw), 'active');
  }

  private async setStatus(
    input: z.infer<typeof FreezeInput>,
    target: 'active' | 'frozen'
  ): Promise<FreezeResult> {
    const current = await this.adminPool.query<MerchantRow>(
      `SELECT ${MERCHANT_RISK_COLUMNS} FROM merchants WHERE id = $1`,
      [input.merchantId]
    );
    const row = current.rows[0];
    if (!row) throw new MerchantNotFoundError();
    if (row.status === target) return { merchant: toMerchant(row), changed: false };

    const details: Record<string, unknown> = {
      operation: target === 'frozen' ? 'merchant.freeze' : 'merchant.unfreeze',
      merchantId: input.merchantId,
      from: row.status,
      to: target,
    };
    try {
      const updated = await withPlatformOperation(
        this.adminPool,
        {
          tenantId: row.tenant_id,
          actorId: input.actorId,
          reason: input.reason,
          resourceType: 'merchant',
          resourceId: input.merchantId,
          details,
        },
        async (c: PoolClient) => {
          // Condición sobre el estado leído: si otro operador cambió el estado
          // entre la lectura y aquí, no se audita un cambio que no ocurrió.
          const res = await c.query<MerchantRow>(
            `UPDATE merchants SET status = $2, updated_at = now()
             WHERE id = $1 AND status = $3
             RETURNING ${MERCHANT_RISK_COLUMNS}`,
            [input.merchantId, target, row.status]
          );
          return res.rows[0] ?? null;
        }
      );
      if (!updated) return this.setStatus(input, target);
      return { merchant: toMerchant(updated), changed: true };
    } catch (err) {
      if (isMerchantOnboardingBlockedDbError(err)) throw new MerchantOnboardingBlockedError();
      throw err;
    }
  }

  async getMerchant(merchantId: string): Promise<MerchantRiskDto> {
    const id = Id.parse(merchantId);
    const res = await this.adminPool.query<MerchantRow>(
      `SELECT ${MERCHANT_RISK_COLUMNS} FROM merchants WHERE id = $1`,
      [id]
    );
    if (!res.rows[0]) throw new MerchantNotFoundError();
    return toMerchant(res.rows[0]);
  }

  /**
   * Comercios ACTIVOS que requieren revisión: declarados estatales, con nombre
   * en la lista, o legados sin declaración. Solo lectura; congelar es una
   * decisión del operador (`freeze`).
   */
  async screen(options: { includeUndeclared?: boolean } = {}): Promise<ScreenResult[]> {
    const res = await this.adminPool.query<MerchantRow & { denylisted: boolean }>(
      `SELECT ${MERCHANT_RISK_COLUMNS}, fluvia_merchant_name_denylisted(name) AS denylisted
       FROM merchants
       WHERE status = 'active' AND deleted_at IS NULL
         AND (state_affiliation IS DISTINCT FROM 'none' OR fluvia_merchant_name_denylisted(name))
       ORDER BY created_at, id`
    );
    const out: ScreenResult[] = [];
    for (const r of res.rows) {
      const findings: ScreenFinding[] = [];
      if (r.state_affiliation === 'government' || r.state_affiliation === 'state_owned') {
        findings.push('state_affiliated');
      }
      if (r.denylisted) findings.push('denylisted_name');
      if (r.state_affiliation === null) findings.push('undeclared');
      const relevant = options.includeUndeclared
        ? findings
        : findings.filter((f) => f !== 'undeclared');
      if (relevant.length > 0) out.push({ merchant: toMerchant(r), findings });
    }
    return out;
  }

  async listDenylist(options: { includeRetired?: boolean } = {}): Promise<DenylistEntryDto[]> {
    const res = await this.adminPool.query<DenylistRow>(
      `SELECT ${DENYLIST_COLUMNS} FROM merchant_name_denylist
       WHERE $1::boolean OR retired_at IS NULL
       ORDER BY added_at, id`,
      [options.includeRetired === true]
    );
    return res.rows.map(toEntry);
  }

  /**
   * Añade un patrón (normalizado en el motor). Idempotente: si ya hay una
   * entrada activa equivalente, la devuelve sin auditar de nuevo.
   */
  async addPattern(raw: {
    pattern: string;
    reason: string;
    actorId: string;
  }): Promise<{ entry: DenylistEntryDto; created: boolean }> {
    const input = AddPatternInput.parse(raw);
    const norm = await this.adminPool.query<{ p: string }>(
      'SELECT fluvia_normalize_merchant_name($1) AS p',
      [input.pattern]
    );
    const pattern = norm.rows[0]!.p;
    if (pattern.length < 2 || pattern.length > 120) throw new InvalidDenylistPatternError();
    const existing = await this.adminPool.query<DenylistRow>(
      `SELECT ${DENYLIST_COLUMNS} FROM merchant_name_denylist
       WHERE pattern = $1 AND retired_at IS NULL`,
      [pattern]
    );
    if (existing.rows[0]) return { entry: toEntry(existing.rows[0]), created: false };

    const details: Record<string, unknown> = { operation: 'merchant_denylist.add', pattern };
    const entry = await withPlatformOperation(
      this.adminPool,
      {
        actorId: input.actorId,
        reason: input.reason,
        resourceType: 'merchant_name_denylist',
        details,
      },
      async (c) => {
        const res = await c.query<DenylistRow>(
          `INSERT INTO merchant_name_denylist (pattern, reason, added_by)
           VALUES ($1, $2, $3)
           RETURNING ${DENYLIST_COLUMNS}`,
          [pattern, input.reason, input.actorId]
        );
        details.entryId = res.rows[0]!.id;
        return toEntry(res.rows[0]!);
      }
    );
    return { entry, created: true };
  }

  /** Retira un patrón (falso positivo o decisión de Legal). No se borra nunca. */
  async retirePattern(raw: {
    id: string;
    reason: string;
    actorId: string;
  }): Promise<DenylistEntryDto> {
    const input = RetireInput.parse(raw);
    const current = await this.adminPool.query<DenylistRow>(
      `SELECT ${DENYLIST_COLUMNS} FROM merchant_name_denylist WHERE id = $1`,
      [input.id]
    );
    const row = current.rows[0];
    if (!row) throw new DenylistEntryNotFoundError();
    if (row.retired_at) throw new DenylistEntryAlreadyRetiredError(input.id);

    return withPlatformOperation(
      this.adminPool,
      {
        actorId: input.actorId,
        reason: input.reason,
        resourceType: 'merchant_name_denylist',
        resourceId: input.id,
        details: { operation: 'merchant_denylist.retire', pattern: row.pattern },
      },
      async (c) => {
        const res = await c.query<DenylistRow>(
          `UPDATE merchant_name_denylist
           SET retired_at = now(), retired_by = $2, retire_reason = $3
           WHERE id = $1 AND retired_at IS NULL
           RETURNING ${DENYLIST_COLUMNS}`,
          [input.id, input.actorId, input.reason]
        );
        if (!res.rows[0]) throw new DenylistEntryAlreadyRetiredError(input.id);
        return toEntry(res.rows[0]);
      }
    );
  }
}
