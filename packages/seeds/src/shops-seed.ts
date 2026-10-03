import { hashPassword } from '@fluvia/auth';
import type { Pool } from '@fluvia/db';
import { seedUuid } from './deterministic.js';
import { DEMO, SeedEnvironmentError } from './seed.js';

/**
 * Seed de DEMO de «Tiendas Fluvia» (SOLO local/test, opt-in).
 *
 * Tres comercios SINTÉTICOS (sin relación con marcas reales) con catálogo,
 * variantes, existencias y fotos CC0 del conjunto cerrado, su perfil del
 * directorio PUBLICADO (`is_demo`) y su tienda activada; además activa la
 * tienda de la bodega de demostración existente con sus productos en VES.
 *
 * Re-ejecutable: ids deterministas + ON CONFLICT; las existencias iniciales
 * son UN movimiento de entrada con id fijo (re-ejecutar no suma). Devuelve
 * POSTCONDICIONES comprobadas.
 */

export class ShopsSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopsSeedError';
  }
}

interface ProductSpec {
  sku: string;
  name: string;
  description: string;
  price: number;
  image: string;
  stock?: number;
  collection?: string;
  featured?: boolean;
  variants?: Array<{ sku: string; label: string; price?: number; stock?: number }>;
}
interface ShopSpec {
  key: string;
  name: string;
  slug: string;
  category: 'hogar' | 'moda' | 'tecnologia';
  city: string;
  area: string;
  summary: string;
  currency: 'VES' | 'USD';
  pickup: boolean;
  delivery: boolean;
  deliveryTerms: string;
  returnsPolicy: string;
  email: string;
  phone: string;
  banner: string;
  photo: string;
  products: ProductSpec[];
}

export const SHOPS_DEMO = {
  owner: {
    id: seedUuid('user:tiendas@demo.fluvia.test'),
    email: 'tiendas@demo.fluvia.test',
    password: 'demo-tiendas-password',
  },
  shops: [
    {
      key: 'casa-avila',
      name: 'Casa Ávila',
      slug: 'casa-avila',
      category: 'hogar',
      city: 'Caracas',
      area: 'Los Palos Grandes',
      summary: 'Cerámica, madera y textiles para la mesa, hechos en pequeños lotes.',
      currency: 'VES',
      pickup: true,
      delivery: true,
      deliveryTerms:
        'Entregas martes y viernes dentro de Caracas. Retiro en tienda de lunes a sábado.',
      returnsPolicy:
        'Cambios en 7 días con el empaque original. Piezas hechas a mano: pequeñas variaciones no son defecto.',
      email: 'hola@casa-avila.demo.fluvia.test',
      phone: '+58 212 555 0101',
      banner: 'catalog/tienda-banner-hogar.jpg',
      photo: 'presentacion/hogar.jpg',
      products: [
        {
          sku: 'CA-TAZA',
          name: 'Taza de cerámica esmaltada',
          description: 'Taza de 350 ml torneada a mano, esmalte apto para lavavajillas.',
          price: 18_500,
          image: 'catalog/tienda-taza-ceramica.jpg',
          collection: 'Mesa',
          featured: true,
          variants: [
            { sku: 'CA-TAZA-ARENA', label: 'Arena', stock: 12 },
            { sku: 'CA-TAZA-COBALTO', label: 'Cobalto', stock: 6 },
          ],
        },
        {
          sku: 'CA-TETERA',
          name: 'Tetera de barro',
          description: 'Tetera de 900 ml con colador interno. Pieza única de cada horneada.',
          price: 89_000,
          image: 'catalog/tienda-tetera.jpg',
          stock: 2,
          collection: 'Mesa',
          featured: true,
        },
        {
          sku: 'CA-JARRON',
          name: 'Jarrón de barro oscuro',
          description: 'Jarrón de 30 cm con asas, acabado bruñido.',
          price: 64_000,
          image: 'catalog/tienda-jarron-barro.jpg',
          stock: 3,
          collection: 'Decoración',
        },
        {
          sku: 'CA-CUCHARAS',
          name: 'Cucharas de madera de samán (juego de 3)',
          description: 'Talladas y curadas con aceite mineral alimentario.',
          price: 27_500,
          image: 'catalog/tienda-cucharas-madera.jpg',
          collection: 'Cocina',
        },
        {
          sku: 'CA-VELAS',
          name: 'Velas de cera de abeja (par)',
          description: 'Dos velas de 20 cm, mecha de algodón, sin parafina.',
          price: 22_000,
          image: 'catalog/tienda-velas.jpg',
          collection: 'Decoración',
        },
      ],
    },
    {
      key: 'taller-caribe',
      name: 'Taller Caribe',
      slug: 'taller-caribe',
      category: 'moda',
      city: 'Valencia',
      area: 'El Viñedo',
      summary: 'Ropa ligera de lino y algodón, accesorios y mochilas para el calor.',
      currency: 'USD',
      pickup: false,
      delivery: true,
      deliveryTerms:
        'Envío a todo el país por agencia de encomiendas; el comercio te contacta para coordinar.',
      returnsPolicy: 'Cambio de talla en 10 días si la prenda no fue usada.',
      email: 'pedidos@taller-caribe.demo.fluvia.test',
      phone: '+58 241 555 0102',
      banner: 'catalog/tienda-banner-moda.jpg',
      photo: 'presentacion/moda.jpg',
      products: [
        {
          sku: 'TC-LINO',
          name: 'Camisa de lino crudo',
          description: 'Lino 100 %, corte holgado, botones de coco.',
          price: 4_800,
          image: 'catalog/tienda-camisa-lino.jpg',
          collection: 'Lino',
          featured: true,
          variants: [
            { sku: 'TC-LINO-S', label: 'Talla S', stock: 4 },
            { sku: 'TC-LINO-M', label: 'Talla M', stock: 6 },
            { sku: 'TC-LINO-L', label: 'Talla L', stock: 0 },
          ],
        },
        {
          sku: 'TC-COLORES',
          name: 'Camisa de algodón',
          description: 'Algodón peinado de manga corta, teñido en prenda.',
          price: 3_200,
          image: 'catalog/tienda-camisas-color.jpg',
          collection: 'Algodón',
          variants: [
            { sku: 'TC-COL-ROJO', label: 'Rojo' },
            { sku: 'TC-COL-AMARILLO', label: 'Amarillo' },
            { sku: 'TC-COL-AZUL', label: 'Azul', price: 3_400 },
          ],
        },
        {
          sku: 'TC-PANUELO',
          name: 'Pañuelo de algodón estampado',
          description: '90 × 90 cm, bordes cosidos a mano.',
          price: 1_800,
          image: 'catalog/tienda-panuelos.jpg',
          collection: 'Accesorios',
        },
        {
          sku: 'TC-MOCHILA',
          name: 'Mochila con estampado floral',
          description: 'Lona impermeable, bolsillo para portátil de 14″.',
          price: 3_900,
          image: 'catalog/tienda-mochila-floral.jpg',
          collection: 'Accesorios',
        },
        {
          sku: 'TC-GUANTES',
          name: 'Guantes de cuero',
          description: 'Cuero curtido al vegetal, forro de algodón.',
          price: 5_500,
          image: 'catalog/tienda-guantes-cuero.jpg',
          stock: 1,
          collection: 'Accesorios',
        },
      ],
    },
    {
      key: 'punto-digital',
      name: 'Punto Digital',
      slug: 'punto-digital',
      category: 'tecnologia',
      city: 'Maracaibo',
      area: 'Bella Vista',
      summary: 'Accesorios para trabajar y estudiar, y equipos fotográficos restaurados.',
      currency: 'USD',
      pickup: true,
      delivery: false,
      deliveryTerms: 'Retiro en tienda con tu número de pedido, de lunes a viernes.',
      returnsPolicy: 'Garantía de 30 días por defecto de fábrica. Equipos restaurados: 90 días.',
      email: 'soporte@punto-digital.demo.fluvia.test',
      phone: '+58 261 555 0103',
      banner: 'presentacion/tecnologia.jpg',
      photo: 'presentacion/tecnologia.jpg',
      products: [
        {
          sku: 'PD-TECLADO',
          name: 'Teclado compacto inalámbrico',
          description: 'Distribución en español, batería recargable por USB-C.',
          price: 4_200,
          image: 'catalog/tienda-teclado.jpg',
          featured: true,
        },
        {
          sku: 'PD-LAMPARA',
          name: 'Lámpara de escritorio LED',
          description: 'Brazo articulado, tres temperaturas de luz.',
          price: 3_600,
          image: 'catalog/tienda-lampara.jpg',
        },
        {
          sku: 'PD-CAMARA',
          name: 'Cámara analógica de 35 mm (restaurada)',
          description: 'Revisada y calibrada. Incluye correa de cuero. Unidad única.',
          price: 12_000,
          image: 'catalog/tienda-camara.jpg',
          stock: 1,
          featured: true,
        },
      ],
    },
  ] satisfies ShopSpec[],
} as const;

export interface ShopsSeedReport {
  shops: Array<{ slug: string; products: number }>;
  bodegaListed: number;
}

export async function seedShopsDemo(env: string, pools: { admin: Pool }): Promise<ShopsSeedReport> {
  if (env !== 'local' && env !== 'test') throw new SeedEnvironmentError(env);
  const a = pools.admin;
  const O = SHOPS_DEMO.owner;
  await a.query(
    `INSERT INTO users (id, email, password_hash, email_verified_at)
     VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
    [O.id, O.email, await hashPassword(O.password)]
  );

  for (const s of SHOPS_DEMO.shops) {
    const org = seedUuid(`org:shop-${s.key}`);
    const merchant = seedUuid(`merchant:shop-${s.key}`);
    await a.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [org, `${s.name} (demo)`, `demo-shop-${s.key}`]
    );
    await a.query(
      `INSERT INTO merchants (id, tenant_id, name, default_currency) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [merchant, org, s.name, s.currency]
    );
    await a.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'owner')
       ON CONFLICT DO NOTHING`,
      [seedUuid(`membership:${O.email}:${org}`), org, O.id]
    );
    await a.query(
      `INSERT INTO merchant_directory_profiles
         (id, tenant_id, merchant_id, slug, display_name, category, city, area, summary, channels,
          photo_ref, visibility, is_demo, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'published', true, now())
       ON CONFLICT (tenant_id, merchant_id) DO NOTHING`,
      [
        seedUuid(`directory:shop-${s.key}`),
        org,
        merchant,
        s.slug,
        s.name,
        s.category,
        s.city,
        s.area,
        s.summary,
        s.pickup ? '{in_store,online}' : '{online}',
        s.photo,
      ]
    );
    await a.query(
      `INSERT INTO shop_settings
         (id, tenant_id, merchant_id, enabled, pickup, delivery, delivery_terms, returns_policy,
          contact_email, contact_phone, banner_ref)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, merchant_id) DO NOTHING`,
      [
        seedUuid(`shop-settings:${s.key}`),
        org,
        merchant,
        s.pickup,
        s.delivery,
        s.deliveryTerms,
        s.returnsPolicy,
        s.email,
        s.phone,
        s.banner,
      ]
    );
    let position = 0;
    for (const p of s.products as readonly ProductSpec[]) {
      const id = seedUuid(`product:${p.sku}`);
      const tracked = p.stock !== undefined;
      await a.query(
        `INSERT INTO catalog_products
           (id, tenant_id, name, sku, description, price, currency, available, image_ref, track_stock)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9) ON CONFLICT DO NOTHING`,
        [id, org, p.name, p.sku, p.description, p.price, s.currency, p.image, tracked]
      );
      if (tracked && p.stock! > 0) {
        await a.query(
          `INSERT INTO inventory_movements (id, tenant_id, product_id, kind, quantity, reason)
           VALUES ($1, $2, $3, 'receipt', $4, 'Inventario inicial (demo)') ON CONFLICT (id) DO NOTHING`,
          [seedUuid(`stock:${p.sku}`), org, id, p.stock]
        );
      }
      for (const v of p.variants ?? []) {
        const vid = seedUuid(`product:${v.sku}`);
        const vTracked = v.stock !== undefined;
        await a.query(
          `INSERT INTO catalog_products
             (id, tenant_id, name, sku, description, price, currency, available, image_ref,
              track_stock, variant_of, variant_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
          [
            vid,
            org,
            `${p.name} · ${v.label}`,
            v.sku,
            p.description,
            v.price ?? p.price,
            s.currency,
            p.image,
            vTracked,
            id,
            v.label,
          ]
        );
        if (vTracked && v.stock! > 0) {
          await a.query(
            `INSERT INTO inventory_movements (id, tenant_id, product_id, kind, quantity, reason)
             VALUES ($1, $2, $3, 'receipt', $4, 'Inventario inicial (demo)') ON CONFLICT (id) DO NOTHING`,
            [seedUuid(`stock:${v.sku}`), org, vid, v.stock]
          );
        }
      }
      await a.query(
        `INSERT INTO shop_listings (tenant_id, product_id, visible, featured, collection, position)
         VALUES ($1, $2, true, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [org, id, p.featured ?? false, p.collection ?? null, position++]
      );
    }
  }

  // Bodega de demostración (seed principal): activa su tienda y publica sus
  // productos en VES con foto. Su perfil del directorio ya está publicado.
  await a.query(
    `INSERT INTO shop_settings
       (id, tenant_id, merchant_id, enabled, pickup, delivery, delivery_terms, returns_policy,
        contact_email, contact_phone, banner_ref)
     VALUES ($1, $2, $3, true, true, false, $4, $5, NULL, '+58 212 555 0100', 'presentacion/bodega-demo.jpg')
     ON CONFLICT (tenant_id, merchant_id) DO NOTHING`,
    [
      seedUuid('shop-settings:bodega-demo'),
      DEMO.organizationId,
      DEMO.merchantId,
      'Retiro en la bodega el mismo día, de 8:00 a 19:00.',
      'Productos perecederos sin cambio; el resto, en 3 días con factura.',
    ]
  );
  await a.query(
    `INSERT INTO shop_listings (tenant_id, product_id, visible, featured, position)
     SELECT tenant_id, id, true, image_ref IN ('catalog/cafe-grano.jpg', 'catalog/queso.jpg'), 0
       FROM catalog_products
      WHERE tenant_id = $1 AND currency = 'VES' AND variant_of IS NULL
        AND archived_at IS NULL AND image_ref IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [DEMO.organizationId]
  );

  // Postcondiciones (por la MISMA lectura pública que usa la app).
  const shops: ShopsSeedReport['shops'] = [];
  for (const s of SHOPS_DEMO.shops) {
    const r = await a.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM shop_product_rows() WHERE shop_slug = $1 AND variant_of IS NULL`,
      [s.slug]
    );
    const n = r.rows[0]?.n ?? 0;
    if (n !== s.products.length) {
      throw new ShopsSeedError(`la tienda ${s.slug} publica ${n}/${s.products.length} productos`);
    }
    shops.push({ slug: s.slug, products: n });
  }
  const bodega = await a.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM shop_product_rows() WHERE shop_slug = 'bodega-demo'`
  );
  const bodegaListed = bodega.rows[0]?.n ?? 0;
  if (bodegaListed < 1) throw new ShopsSeedError('la bodega de demostración no publica productos');
  return { shops, bodegaListed };
}
