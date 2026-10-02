import { withTenantTransaction, type Pool } from '@fluvia/db';
import { CommerceError } from './errors.js';

/**
 * Tipo de negocio y módulos sobre la MISMA organización (0057). Cambiar el
 * tipo o los módulos solo cambia qué se muestra y qué rutas acepta el
 * servidor: ningún dato se borra ni se mueve.
 */
export const BUSINESS_TYPES = ['retail', 'restaurant', 'quick_service', 'services'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const MODULES = [
  'catalog',
  'inventory',
  'pos',
  'tables',
  'kitchen',
  'qr_menu',
  'customer_orders',
  'split_bill',
  'in_person',
  'payment_links',
] as const;
export type BusinessModule = (typeof MODULES)[number];

export const DEFAULT_MODULES: Record<BusinessType, readonly BusinessModule[]> = {
  retail: ['catalog', 'inventory', 'pos', 'payment_links', 'in_person'],
  restaurant: [
    'catalog',
    'pos',
    'tables',
    'kitchen',
    'qr_menu',
    'customer_orders',
    'split_bill',
    'payment_links',
    'in_person',
  ],
  quick_service: [
    'catalog',
    'pos',
    'kitchen',
    'qr_menu',
    'customer_orders',
    'payment_links',
    'in_person',
  ],
  services: ['payment_links', 'in_person'],
};

/** Vocabulario por tipo: la misma operación con la palabra de cada negocio. */
export const VOCABULARY: Record<
  BusinessType,
  { sale: string; sales: string; customer: string; item: string; newSale: string }
> = {
  retail: {
    sale: 'Venta',
    sales: 'Ventas',
    customer: 'Cliente',
    item: 'Producto',
    newSale: 'Nueva venta',
  },
  restaurant: {
    sale: 'Pedido',
    sales: 'Pedidos',
    customer: 'Comensal',
    item: 'Plato',
    newSale: 'Abrir mesa',
  },
  quick_service: {
    sale: 'Pedido',
    sales: 'Pedidos',
    customer: 'Cliente',
    item: 'Producto',
    newSale: 'Nuevo pedido',
  },
  services: {
    sale: 'Cobro',
    sales: 'Cobros',
    customer: 'Cliente',
    item: 'Servicio',
    newSale: 'Cobrar',
  },
};

export interface BusinessProfileDto {
  businessType: BusinessType;
  modules: BusinessModule[];
  solo: boolean;
  customerOrdersNeedAcceptance: boolean;
  version: number;
  configured: boolean;
  vocabulary: (typeof VOCABULARY)[BusinessType];
}

export class BusinessProfileVersionConflictError extends CommerceError {
  constructor() {
    super('Business profile was modified by someone else');
  }
}
export class ModuleNotEnabledError extends CommerceError {
  constructor(readonly module: BusinessModule) {
    super(`Module not enabled: ${module}`);
  }
}

export type EnablementStatus = 'pending' | 'enabled' | 'restricted' | 'suspended';
export interface EnablementRequirement {
  id: string;
  label: string;
  done: boolean;
}
export interface CollectionEnablementDto {
  method: 'in_person';
  status: EnablementStatus;
  provider: string;
  requirements: EnablementRequirement[];
  reason: string | null;
  version: number;
}

/** Requisitos declarados del proveedor de cobro presencial (sandbox). */
export const IN_PERSON_REQUIREMENTS: ReadonlyArray<Omit<EnablementRequirement, 'done'>> = [
  { id: 'identity', label: 'Identidad del titular verificada' },
  { id: 'payout_account', label: 'Cuenta de liquidación registrada' },
  { id: 'terms', label: 'Condiciones del proveedor de cobro aceptadas' },
  { id: 'device', label: 'Teléfono compatible registrado' },
];

export class EnablementTransitionError extends CommerceError {
  constructor(from: string, to: string) {
    super(`Invalid enablement transition ${from} -> ${to}`);
  }
}
export class CollectionNotEnabledError extends CommerceError {
  constructor(readonly status: EnablementStatus) {
    super(`In-person collection is ${status}`);
  }
}

const ENABLEMENT_PATHS: Record<EnablementStatus, readonly EnablementStatus[]> = {
  pending: ['enabled', 'restricted', 'suspended'],
  enabled: ['restricted', 'suspended'],
  restricted: ['enabled', 'suspended'],
  suspended: ['restricted', 'enabled'],
};

export class BusinessProfileService {
  constructor(private readonly appPool: Pool) {}

  async get(tenantId: string): Promise<BusinessProfileDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<{
        business_type: BusinessType;
        modules: BusinessModule[];
        solo: boolean;
        customer_orders_need_acceptance: boolean;
        version: number;
      }>(
        `SELECT business_type, modules, solo, customer_orders_need_acceptance, version
            FROM business_profiles WHERE tenant_id = $1`,
        [tenantId]
      );
      const row = r.rows[0];
      // Sin configurar: el comportamiento histórico (minorista) — sin escribir.
      if (!row) return profile('retail', [...DEFAULT_MODULES.retail], false, true, 0, false);
      return profile(
        row.business_type,
        row.modules,
        row.solo,
        row.customer_orders_need_acceptance,
        row.version,
        true
      );
    });
  }

  async requireModule(tenantId: string, module: BusinessModule): Promise<BusinessProfileDto> {
    const p = await this.get(tenantId);
    if (!p.modules.includes(module)) throw new ModuleNotEnabledError(module);
    return p;
  }

  /**
   * Configura el tipo de negocio. `modules` omitido = los del tipo. Optimista:
   * `expectedVersion` (0 = aún sin configurar) debe coincidir.
   */
  async set(
    tenantId: string,
    input: {
      businessType: BusinessType;
      modules?: BusinessModule[];
      solo?: boolean;
      customerOrdersNeedAcceptance?: boolean;
      expectedVersion: number;
    }
  ): Promise<BusinessProfileDto> {
    const modules = [...new Set(input.modules ?? DEFAULT_MODULES[input.businessType])];
    const solo = input.solo ?? false;
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const cur = await c.query<{ version: number }>(
        `SELECT version FROM business_profiles WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId]
      );
      const version = cur.rows[0]?.version ?? 0;
      if (version !== input.expectedVersion) throw new BusinessProfileVersionConflictError();
      const r = await c.query<{ version: number; customer_orders_need_acceptance: boolean }>(
        `INSERT INTO business_profiles
           (tenant_id, business_type, modules, solo, customer_orders_need_acceptance)
         VALUES ($1, $2, $3, $4, COALESCE($5, true))
         ON CONFLICT (tenant_id) DO UPDATE SET
           business_type = EXCLUDED.business_type,
           modules = EXCLUDED.modules,
           solo = EXCLUDED.solo,
           customer_orders_need_acceptance = COALESCE($5, business_profiles.customer_orders_need_acceptance),
           version = business_profiles.version + 1,
           updated_at = now()
         RETURNING version, customer_orders_need_acceptance`,
        [tenantId, input.businessType, modules, solo, input.customerOrdersNeedAcceptance ?? null]
      );
      const row = r.rows[0]!;
      // La habilitación de cobro presencial existe desde el alta, PENDIENTE.
      await c.query(
        `INSERT INTO collection_enablements (tenant_id, method, requirements)
         VALUES ($1, 'in_person', $2::jsonb) ON CONFLICT DO NOTHING`,
        [tenantId, JSON.stringify(IN_PERSON_REQUIREMENTS.map((q) => ({ ...q, done: false })))]
      );
      return profile(
        input.businessType,
        modules,
        solo,
        row.customer_orders_need_acceptance,
        row.version,
        true
      );
    });
  }

  async enablement(tenantId: string): Promise<CollectionEnablementDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const r = await c.query<{
        status: EnablementStatus;
        provider: string;
        requirements: EnablementRequirement[];
        reason: string | null;
        version: number;
      }>(
        `SELECT status, provider, requirements, reason, version
           FROM collection_enablements WHERE tenant_id = $1 AND method = 'in_person'`,
        [tenantId]
      );
      const row = r.rows[0];
      if (!row) {
        return {
          method: 'in_person',
          status: 'pending',
          provider: 'none',
          requirements: IN_PERSON_REQUIREMENTS.map((q) => ({ ...q, done: false })),
          reason: null,
          version: 0,
        };
      }
      return { method: 'in_person', ...row };
    });
  }

  /** Marca un requisito como cumplido (lo hace el comercio o el registro de dispositivo). */
  async completeRequirement(
    tenantId: string,
    requirementId: string
  ): Promise<CollectionEnablementDto> {
    await withTenantTransaction(this.appPool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO collection_enablements (tenant_id, method, requirements)
         VALUES ($1, 'in_person', $2::jsonb) ON CONFLICT DO NOTHING`,
        [tenantId, JSON.stringify(IN_PERSON_REQUIREMENTS.map((q) => ({ ...q, done: false })))]
      );
      await c.query(
        `UPDATE collection_enablements
            SET requirements = (
                  SELECT jsonb_agg(CASE WHEN r->>'id' = $2 THEN jsonb_set(r, '{done}', 'true') ELSE r END)
                    FROM jsonb_array_elements(requirements) r),
                version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND method = 'in_person'`,
        [tenantId, requirementId]
      );
    });
    return this.enablement(tenantId);
  }

  /**
   * Cambia el estado de habilitación. Pasar a `enabled` exige todos los
   * requisitos cumplidos y un proveedor; es decisión de OPERACIÓN (en sandbox,
   * del proveedor simulado), nunca automática por tener una cuenta.
   */
  async transition(
    tenantId: string,
    to: EnablementStatus,
    input: { provider?: string; reason?: string; actorId?: string | null }
  ): Promise<CollectionEnablementDto> {
    await withTenantTransaction(this.appPool, tenantId, async (c) => {
      const cur = await c.query<{
        status: EnablementStatus;
        requirements: EnablementRequirement[];
        provider: string;
      }>(
        `SELECT status, requirements, provider FROM collection_enablements
          WHERE tenant_id = $1 AND method = 'in_person' FOR UPDATE`,
        [tenantId]
      );
      const row = cur.rows[0];
      const from = row?.status ?? 'pending';
      if (!ENABLEMENT_PATHS[from].includes(to)) throw new EnablementTransitionError(from, to);
      const provider = input.provider ?? row?.provider ?? 'none';
      if (to === 'enabled') {
        const reqs = row?.requirements ?? [];
        if (reqs.length === 0 || reqs.some((q) => !q.done) || provider === 'none') {
          throw new EnablementTransitionError(from, to);
        }
      }
      await c.query(
        `UPDATE collection_enablements
            SET status = $2, provider = $3, reason = $4, version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND method = 'in_person'`,
        [tenantId, to, provider, input.reason ?? null]
      );
      await c.query(
        `INSERT INTO collection_enablement_events
           (tenant_id, method, from_status, to_status, reason, actor_id)
         VALUES ($1, 'in_person', $2, $3, $4, $5)`,
        [tenantId, from, to, input.reason ?? null, input.actorId ?? null]
      );
    });
    return this.enablement(tenantId);
  }
}

function profile(
  businessType: BusinessType,
  modules: BusinessModule[],
  solo: boolean,
  needAcceptance: boolean,
  version: number,
  configured: boolean
): BusinessProfileDto {
  return {
    businessType,
    modules,
    solo,
    customerOrdersNeedAcceptance: needAcceptance,
    version,
    configured,
    vocabulary: VOCABULARY[businessType],
  };
}
