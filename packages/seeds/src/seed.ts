import { hashPassword } from '@fluvia/auth';
import type { Pool } from '@fluvia/db';
import { LedgerService, PostingService } from '@fluvia/ledger';
import { Money } from '@fluvia/money';
import { seedUuid } from './deterministic.js';

/**
 * Seeds deterministas de demo (F1-10).
 *
 * Reglas:
 *  - SOLO local/test: los datos de demo (y sus passwords conocidos) JAMAS
 *    llegan a sandbox/staging/production — guard duro, no configuracion.
 *    Abrir sandbox exigira una decision explicita (se revisara con PEND-006).
 *  - Reproducible: mismos IDs (UUID v5 sobre claves fijas) en toda corrida.
 *  - Re-ejecutable sin duplicar: identidad via ON CONFLICT DO NOTHING;
 *    ledger via la MISMA capa de idempotencia de produccion (mismo key +
 *    mismo payload => replay exacto, cero asientos nuevos). El seed no tiene
 *    ningun privilegio especial sobre el ledger: pasa por LedgerService.
 */

export class SeedEnvironmentError extends Error {
  constructor(env: string) {
    super(
      `Demo seeds are forbidden in "${env}": known passwords and synthetic data are local/test-only (F1-10)`
    );
    this.name = 'SeedEnvironmentError';
  }
}

export interface DemoUserSpec {
  id: string;
  email: string;
  /** Password de DEMO, valido SOLO en local/test (el guard lo garantiza). */
  password: string;
  role: 'owner' | 'developer';
}

export const DEMO = {
  organizationId: seedUuid('org:demo-fluvia'),
  organizationName: 'Demo Fluvia',
  slug: 'demo-fluvia',
  merchantId: seedUuid('merchant:demo-store'),
  merchantName: 'Demo Store',
  currency: 'COP',
  users: [
    {
      id: seedUuid('user:owner@demo.fluvia.test'),
      email: 'owner@demo.fluvia.test',
      password: 'demo-owner-password',
      role: 'owner',
    },
    {
      id: seedUuid('user:dev@demo.fluvia.test'),
      email: 'dev@demo.fluvia.test',
      password: 'demo-dev-password',
      role: 'developer',
    },
  ] as DemoUserSpec[],
} as const;

export const DEMO_CATEGORIES = [
  'Abarrotes',
  'Bebidas',
  'Hogar y limpieza',
  'Papelería',
  'Frescos',
] as const;

interface DemoProductSpec {
  sku: string;
  name: string;
  category: (typeof DEMO_CATEGORIES)[number];
  /** Unidades menores de `currency`. */
  price: number;
  currency?: 'COP' | 'VES';
  available?: boolean;
  /** Imagen del conjunto CC0 de demostración (docs/product/demo-images.md). */
  image?: string;
  /** SKU del producto base si es una variante (misma moneda). */
  variantOf?: string;
  variantLabel?: string;
  /** Existencias iniciales (entrada de inventario) ⇒ controla existencias. */
  stock?: number;
}

/**
 * Catálogo sintético (SKU estable = id estable). Los COP de siempre (sin
 * cambios de precio ni moneda) + un surtido de bodega en bolívares (VES,
 * céntimos) con fotos CC0, una familia con variantes y existencias, para
 * ver reservas, agotados y existencias bajas. Precios SINTÉTICOS: no son
 * referencia de mercado ni resultado de una conversión.
 */
export const DEMO_PRODUCTS: DemoProductSpec[] = [
  { sku: 'ABA-001', name: 'Arroz 1 kg', category: 'Abarrotes', price: 4_800 },
  { sku: 'ABA-002', name: 'Harina de maíz 1 kg', category: 'Abarrotes', price: 3_900 },
  {
    sku: 'ABA-003',
    name: 'Café molido 500 g',
    category: 'Abarrotes',
    price: 18_500,
    image: 'catalog/cafe-grano.jpg',
  },
  { sku: 'ABA-004', name: 'Aceite vegetal 1 L', category: 'Abarrotes', price: 12_900 },
  {
    sku: 'BEB-001',
    name: 'Agua mineral 600 ml',
    category: 'Bebidas',
    price: 2_200,
    image: 'catalog/agua.jpg',
  },
  {
    sku: 'BEB-002',
    name: 'Jugo de naranja 1 L',
    category: 'Bebidas',
    price: 7_400,
    image: 'catalog/jugo-naranja.jpg',
  },
  {
    sku: 'BEB-003',
    name: 'Refresco 2 L',
    category: 'Bebidas',
    price: 6_900,
    available: false,
    image: 'catalog/refresco.jpg',
  },
  { sku: 'HOG-001', name: 'Detergente 1 kg', category: 'Hogar y limpieza', price: 15_300 },
  { sku: 'HOG-002', name: 'Jabón de manos', category: 'Hogar y limpieza', price: 5_600 },
  {
    sku: 'PAP-001',
    name: 'Cuaderno 100 hojas',
    category: 'Papelería',
    price: 6_200,
    image: 'catalog/cuaderno.jpg',
  },
  {
    sku: 'PAP-002',
    name: 'Bolígrafos x3',
    category: 'Papelería',
    price: 4_100,
    image: 'catalog/boligrafos.jpg',
  },
  // ── Bodega en bolívares (VES, céntimos) ──
  {
    sku: 'VE-CAF-250',
    name: 'Café molido',
    variantLabel: '250 g',
    category: 'Abarrotes',
    price: 42_000,
    currency: 'VES',
    image: 'catalog/cafe-grano.jpg',
    stock: 14,
  },
  {
    sku: 'VE-CAF-500',
    name: 'Café molido',
    variantOf: 'VE-CAF-250',
    variantLabel: '500 g',
    category: 'Abarrotes',
    price: 79_000,
    currency: 'VES',
    image: 'catalog/cafe-grano.jpg',
    stock: 6,
  },
  {
    sku: 'VE-HAR-1K',
    name: 'Harina de maíz 1 kg',
    category: 'Abarrotes',
    price: 17_550,
    currency: 'VES',
    stock: 30,
  },
  {
    sku: 'VE-QUE-1K',
    name: 'Queso blanco 1 kg',
    category: 'Frescos',
    price: 115_000,
    currency: 'VES',
    image: 'catalog/queso.jpg',
    stock: 3,
  },
  {
    sku: 'VE-HUE-30',
    name: 'Huevos (cartón de 30)',
    category: 'Frescos',
    price: 98_000,
    currency: 'VES',
    image: 'catalog/huevos.jpg',
    stock: 0,
  },
  {
    sku: 'VE-PLA-1K',
    name: 'Plátanos 1 kg',
    category: 'Frescos',
    price: 16_000,
    currency: 'VES',
    image: 'catalog/platanos.jpg',
    stock: 40,
  },
  {
    sku: 'VE-PAN-01',
    name: 'Pan campesino',
    category: 'Frescos',
    price: 23_050,
    currency: 'VES',
    image: 'catalog/pan.jpg',
  },
  {
    sku: 'VE-AGU-600',
    name: 'Agua mineral 600 ml',
    category: 'Bebidas',
    price: 9_500,
    currency: 'VES',
    image: 'catalog/agua.jpg',
    stock: 48,
  },
  {
    sku: 'VE-JUG-1L',
    name: 'Jugo de naranja 1 L',
    category: 'Bebidas',
    price: 31_000,
    currency: 'VES',
    image: 'catalog/jugo-naranja.jpg',
  },
  {
    sku: 'VE-REF-2L',
    name: 'Refresco 2 L',
    category: 'Bebidas',
    price: 36_500,
    currency: 'VES',
    image: 'catalog/refresco.jpg',
  },
  {
    sku: 'VE-CUA-100',
    name: 'Cuaderno 100 hojas',
    category: 'Papelería',
    price: 28_000,
    currency: 'VES',
    image: 'catalog/cuaderno.jpg',
  },
  {
    sku: 'VE-BOL-3',
    name: 'Bolígrafos x3',
    category: 'Papelería',
    price: 15_000,
    currency: 'VES',
    image: 'catalog/boligrafos.jpg',
  },
];

export interface SeedReport {
  organizationId: string;
  merchantId: string;
  userIds: string[];
  /** ids de las transacciones demo del ledger (estables entre corridas). */
  transactionIds: string[];
  balances: { pending: string; available: string };
}

export interface SeedPools {
  /** Superusuario local: identidad (organizations/users/memberships/merchants). */
  admin: Pool;
  /** Rol fluvia_app: TODO el ledger pasa por la via normativa con RLS. */
  app: Pool;
}

export async function seedDemo(env: string, pools: SeedPools): Promise<SeedReport> {
  if (env !== 'local' && env !== 'test') throw new SeedEnvironmentError(env);

  // --- Identidad (idempotente por ON CONFLICT sobre ids/uniques fijos) ------
  await pools.admin.query(
    `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [DEMO.organizationId, DEMO.organizationName, DEMO.slug]
  );

  for (const user of DEMO.users) {
    // El hash se recalcula por corrida (scrypt con salt aleatorio) pero solo
    // se persiste en el alta inicial: DO NOTHING preserva el determinismo.
    const passwordHash = await hashPassword(user.password);
    await pools.admin.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
      [user.id, user.email, passwordHash]
    );
    await pools.admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [seedUuid(`membership:${user.email}`), DEMO.organizationId, user.id, user.role]
    );
  }

  await pools.admin.query(
    `INSERT INTO merchants (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [DEMO.merchantId, DEMO.organizationId, DEMO.merchantName]
  );

  // --- Catálogo de DEMO (comercio minorista genérico, datos sintéticos) -----
  // Precios en unidades menores con la regla de VISUALIZACIÓN vigente para COP
  // (exponente 0 en pantalla; PEND-008 sin decidir). Idempotente por ids fijos.
  for (const name of DEMO_CATEGORIES) {
    await pools.admin.query(
      `INSERT INTO catalog_categories (id, tenant_id, name) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [seedUuid(`category:${name}`), DEMO.organizationId, name]
    );
  }
  // Bases antes que variantes (el motor exige que la base exista).
  const ordered = [...DEMO_PRODUCTS].sort((a, b) => Number(!!a.variantOf) - Number(!!b.variantOf));
  for (const p of ordered) {
    await pools.admin.query(
      `INSERT INTO catalog_products
         (id, tenant_id, category_id, name, sku, price, currency, available, image_ref,
          variant_of, variant_label, track_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
      [
        seedUuid(`product:${p.sku}`),
        DEMO.organizationId,
        seedUuid(`category:${p.category}`),
        p.name,
        p.sku,
        p.price,
        p.currency ?? DEMO.currency,
        p.available ?? true,
        p.image ?? null,
        p.variantOf ? seedUuid(`product:${p.variantOf}`) : null,
        p.variantLabel ?? null,
        p.stock !== undefined,
      ]
    );
  }
  // Existencias iniciales: una ENTRADA por producto con id fijo (re-ejecutar
  // no suma: ON CONFLICT no inserta y el nivel solo lo mueve un movimiento).
  for (const p of DEMO_PRODUCTS) {
    if (!p.stock) continue;
    await pools.admin.query(
      `INSERT INTO inventory_movements (id, tenant_id, product_id, kind, quantity, reason)
       VALUES ($1, $2, $3, 'receipt', $4, 'Inventario inicial (demo)') ON CONFLICT (id) DO NOTHING`,
      [
        seedUuid(`stock:initial:${p.sku}`),
        DEMO.organizationId,
        seedUuid(`product:${p.sku}`),
        p.stock,
      ]
    );
  }

  // --- Ledger demo: por la via NORMATIVA (chart + posting idempotente) ------
  const ledger = new LedgerService(pools.app);
  const posting = new PostingService(ledger, pools.app);
  const chart = await posting.ensureChart(DEMO.organizationId, DEMO.merchantId, DEMO.currency);

  const cop = (units: number) => Money.of(units, DEMO.currency);
  const base = {
    tenantId: DEMO.organizationId,
    merchantId: DEMO.merchantId,
    sourceType: 'seed',
  };
  // COP tiene exponente 0: 500.000 COP bruto, fees 14.500/19.500.
  const capture = await posting.capturePayment({
    ...base,
    idempotencyKey: 'seed:demo:capture-1',
    sourceId: 'demo-capture-1',
    amount: cop(500_000),
    providerFee: cop(14_500),
    platformFee: cop(19_500),
  });
  const release = await posting.releaseSettlement({
    ...base,
    idempotencyKey: 'seed:demo:release-1',
    sourceId: 'demo-release-1',
    amount: cop(300_000),
  });

  // Las reservas/pendientes son CUENTAS del chart (decision #18); los asientos
  // del posting usan el bucket por defecto 'available' de cada cuenta.
  const [pending, available] = await Promise.all([
    ledger.getBalance(DEMO.organizationId, chart['merchant.pending']),
    ledger.getBalance(DEMO.organizationId, chart['merchant.available']),
  ]);

  return {
    organizationId: DEMO.organizationId,
    merchantId: DEMO.merchantId,
    userIds: DEMO.users.map((u) => u.id),
    transactionIds: [capture.transactionId, release.transactionId],
    balances: { pending: pending.available, available: available.available },
  };
}
