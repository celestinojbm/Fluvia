import { Money, MoneyError } from '@fluvia/money';

/**
 * Tiendas CONECTADAS (Shopify / WooCommerce): adaptadores de LECTURA del
 * catálogo de una tienda externa autorizada por su comerciante.
 *
 * Reglas (docs/product/personal-tiendas/CONECTADAS.md):
 *  - Credenciales SOLO de servidor (variables de entorno del API); nunca
 *    llegan al navegador ni a la base de datos en claro.
 *  - Sin credenciales ⇒ estado `not_connected`. Una conexión solo se declara
 *    `connected` tras una sonda real con respuesta válida; nunca por tener
 *    variables definidas.
 *  - Solo lectura: la compra en una tienda conectada ocurre en SU checkout;
 *    Fluvia no cobra en su nombre ni marca nada como pagado.
 *  - Precios en unidades menores con la moneda de la tienda; una moneda que
 *    Fluvia no soporta se omite (no se redondea ni se convierte).
 *
 * Versiones verificadas (2026-10-03):
 *  - Shopify Storefront API `2026-10`, `POST https://{tienda}.myshopify.com/api/2026-10/graphql.json`,
 *    token privado de servidor en `Shopify-Storefront-Private-Token`
 *    (canal Headless o app personalizada).
 *  - WooCommerce REST API v3, `/wp-json/wc/v3/products`, Basic auth con
 *    consumer key/secret SOLO sobre HTTPS; moneda en `/data/currencies/current`.
 */

export type ConnectedProvider = 'shopify' | 'woocommerce';
export type ConnectionState = 'not_connected' | 'connected' | 'error';

export interface ExternalVariant {
  externalId: string;
  label: string;
  price: bigint;
  currency: string;
  available: boolean;
}

export interface ExternalProduct {
  provider: ConnectedProvider;
  externalId: string;
  title: string;
  /** Página del producto en la tienda del comerciante (allí se compra). */
  url: string | null;
  imageUrl: string | null;
  available: boolean;
  /** Precio «desde» (variante disponible más barata) en unidades menores. */
  price: bigint | null;
  currency: string | null;
  variants: ExternalVariant[];
}

export interface ExternalPage {
  products: ExternalProduct[];
  /** Cursor (Shopify) o número de página (WooCommerce) siguiente; null si no hay más. */
  next: string | null;
  /** Productos omitidos (moneda no soportada o precio ilegible). */
  skipped: number;
}

export interface ConnectionStatus {
  provider: ConnectedProvider;
  state: ConnectionState;
  /** Explicación para el comerciante; nunca incluye secretos. */
  detail: string;
}

export class ConnectedShopError extends Error {
  constructor(
    readonly provider: ConnectedProvider,
    readonly kind: 'not_configured' | 'unauthorized' | 'upstream' | 'invalid_response',
    message: string
  ) {
    super(message);
    this.name = 'ConnectedShopError';
  }
}

type FetchLike = typeof fetch;

export interface ConnectedShopAdapter {
  readonly provider: ConnectedProvider;
  listProducts(opts?: { first?: number; after?: string | null }): Promise<ExternalPage>;
  probe(): Promise<ConnectionStatus>;
}

function minor(amount: string, currency: string): bigint | null {
  try {
    return Money.fromDecimal(amount, currency).amount;
  } catch (e) {
    if (e instanceof MoneyError) return null;
    throw e;
  }
}

function fromPrice(variants: ExternalVariant[]): { price: bigint | null; currency: string | null } {
  const live = variants.filter((v) => v.available);
  const pool = live.length ? live : variants;
  if (!pool.length) return { price: null, currency: null };
  const min = pool.reduce((a, b) => (b.price < a.price ? b : a));
  return { price: min.price, currency: min.currency };
}

async function statusFromProbe(
  provider: ConnectedProvider,
  run: () => Promise<unknown>
): Promise<ConnectionStatus> {
  try {
    await run();
    return {
      provider,
      state: 'connected',
      detail: 'Catálogo accesible con las credenciales del servidor.',
    };
  } catch (e) {
    if (e instanceof ConnectedShopError && e.kind === 'unauthorized') {
      return { provider, state: 'error', detail: 'La tienda rechazó las credenciales.' };
    }
    return { provider, state: 'error', detail: 'La tienda no respondió como se esperaba.' };
  }
}

/* ───────────────────────────── Shopify ───────────────────────────── */

export const SHOPIFY_STOREFRONT_VERSION = '2026-10';

const SHOPIFY_PRODUCTS = `query FluviaProducts($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    edges {
      node {
        id
        title
        handle
        availableForSale
        featuredImage { url }
        variants(first: 20) {
          edges { node { id title availableForSale price { amount currencyCode } } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface ShopifyResponse {
  data?: {
    products?: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          handle: string;
          availableForSale: boolean;
          featuredImage: { url: string } | null;
          variants: {
            edges: Array<{
              node: {
                id: string;
                title: string;
                availableForSale: boolean;
                price: { amount: string; currencyCode: string };
              };
            }>;
          };
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: unknown[];
}

export class ShopifyStorefrontAdapter implements ConnectedShopAdapter {
  readonly provider = 'shopify' as const;
  private readonly endpoint: string;

  constructor(
    private readonly cfg: {
      /** `mi-tienda.myshopify.com` (o la URL base de un servidor de contrato en pruebas). */
      storeDomain: string;
      privateToken: string;
      apiVersion?: string;
      fetch?: FetchLike;
      /** Solo pruebas: permite http:// contra un servidor local de contrato. */
      allowInsecureForTests?: boolean;
    }
  ) {
    const base = /^https?:\/\//.test(cfg.storeDomain)
      ? cfg.storeDomain
      : `https://${cfg.storeDomain}`;
    if (!base.startsWith('https://') && !cfg.allowInsecureForTests) {
      throw new ConnectedShopError('shopify', 'not_configured', 'Shopify requiere HTTPS');
    }
    this.endpoint = `${base.replace(/\/$/, '')}/api/${cfg.apiVersion ?? SHOPIFY_STOREFRONT_VERSION}/graphql.json`;
  }

  private publicBase(): string {
    const d = this.cfg.storeDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${d}`;
  }

  async listProducts(opts: { first?: number; after?: string | null } = {}): Promise<ExternalPage> {
    const first = Math.min(Math.max(opts.first ?? 20, 1), 50);
    const res = await (this.cfg.fetch ?? fetch)(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Shopify-Storefront-Private-Token': this.cfg.privateToken,
      },
      body: JSON.stringify({
        query: SHOPIFY_PRODUCTS,
        variables: { first, after: opts.after ?? null },
      }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectedShopError('shopify', 'unauthorized', `Shopify respondió ${res.status}`);
    }
    if (!res.ok)
      throw new ConnectedShopError('shopify', 'upstream', `Shopify respondió ${res.status}`);
    const body = (await res.json()) as ShopifyResponse;
    const products = body.data?.products;
    if (!products || (body.errors && body.errors.length)) {
      throw new ConnectedShopError(
        'shopify',
        'invalid_response',
        'Respuesta GraphQL sin productos'
      );
    }
    let skipped = 0;
    const out: ExternalProduct[] = [];
    for (const { node } of products.edges) {
      const variants: ExternalVariant[] = [];
      let bad = false;
      for (const { node: v } of node.variants.edges) {
        const amount = minor(v.price.amount, v.price.currencyCode);
        if (amount === null) {
          bad = true;
          break;
        }
        variants.push({
          externalId: v.id,
          label: v.title,
          price: amount,
          currency: v.price.currencyCode,
          available: v.availableForSale,
        });
      }
      if (bad || !variants.length) {
        skipped++;
        continue;
      }
      out.push({
        provider: 'shopify',
        externalId: node.id,
        title: node.title,
        url: `${this.publicBase()}/products/${encodeURIComponent(node.handle)}`,
        imageUrl: node.featuredImage?.url ?? null,
        available: node.availableForSale,
        ...fromPrice(variants),
        // «Default Title» es la variante única implícita de Shopify: no es una opción real.
        variants: variants.length === 1 && variants[0]!.label === 'Default Title' ? [] : variants,
      });
    }
    return {
      products: out,
      next: products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null,
      skipped,
    };
  }

  probe(): Promise<ConnectionStatus> {
    return statusFromProbe('shopify', () => this.listProducts({ first: 1 }));
  }
}

/* ─────────────────────────── WooCommerce ─────────────────────────── */

interface WooProduct {
  id: number;
  name: string;
  type: string;
  status: string;
  price: string;
  stock_status: 'instock' | 'outofstock' | 'onbackorder';
  permalink: string;
  images: Array<{ src: string }>;
  variations: number[];
}

interface WooVariation {
  id: number;
  price: string;
  stock_status: WooProduct['stock_status'];
  attributes: Array<{ name: string; option: string }>;
}

export class WooCommerceAdapter implements ConnectedShopAdapter {
  readonly provider = 'woocommerce' as const;
  private readonly base: string;
  private currency: string | null = null;

  constructor(
    private readonly cfg: {
      /** URL de la tienda WordPress, p. ej. `https://tienda.example`. */
      baseUrl: string;
      consumerKey: string;
      consumerSecret: string;
      fetch?: FetchLike;
      allowInsecureForTests?: boolean;
    }
  ) {
    // Las claves viajan en Basic auth: solo sobre HTTPS (la doc lo exige así).
    if (!cfg.baseUrl.startsWith('https://') && !cfg.allowInsecureForTests) {
      throw new ConnectedShopError('woocommerce', 'not_configured', 'WooCommerce requiere HTTPS');
    }
    this.base = `${cfg.baseUrl.replace(/\/$/, '')}/wp-json/wc/v3`;
  }

  private async get<T>(path: string): Promise<{ body: T; headers: Headers }> {
    const auth = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString(
      'base64'
    );
    const res = await (this.cfg.fetch ?? fetch)(`${this.base}${path}`, {
      headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectedShopError(
        'woocommerce',
        'unauthorized',
        `WooCommerce respondió ${res.status}`
      );
    }
    if (!res.ok) {
      throw new ConnectedShopError(
        'woocommerce',
        'upstream',
        `WooCommerce respondió ${res.status}`
      );
    }
    return { body: (await res.json()) as T, headers: res.headers };
  }

  private async storeCurrency(): Promise<string> {
    if (this.currency) return this.currency;
    const { body } = await this.get<{ code?: string }>('/data/currencies/current');
    if (!body.code) {
      throw new ConnectedShopError(
        'woocommerce',
        'invalid_response',
        'Moneda de la tienda ausente'
      );
    }
    this.currency = body.code;
    return body.code;
  }

  async listProducts(opts: { first?: number; after?: string | null } = {}): Promise<ExternalPage> {
    const perPage = Math.min(Math.max(opts.first ?? 20, 1), 50);
    const page = Math.max(Number(opts.after ?? '1') || 1, 1);
    const currency = await this.storeCurrency();
    const { body, headers } = await this.get<WooProduct[]>(
      `/products?status=publish&per_page=${perPage}&page=${page}`
    );
    if (!Array.isArray(body)) {
      throw new ConnectedShopError('woocommerce', 'invalid_response', 'Listado sin productos');
    }
    let skipped = 0;
    const out: ExternalProduct[] = [];
    for (const p of body) {
      const variants: ExternalVariant[] = [];
      if (p.type === 'variable' && p.variations.length) {
        const { body: vs } = await this.get<WooVariation[]>(
          `/products/${p.id}/variations?per_page=50`
        );
        for (const v of vs) {
          const amount = v.price ? minor(v.price, currency) : null;
          if (amount === null) continue;
          variants.push({
            externalId: String(v.id),
            label: v.attributes.map((a) => a.option).join(' · ') || `#${v.id}`,
            price: amount,
            currency,
            available: v.stock_status === 'instock',
          });
        }
        if (!variants.length) {
          skipped++;
          continue;
        }
      }
      const own = p.price ? minor(p.price, currency) : null;
      if (!variants.length && own === null) {
        skipped++;
        continue;
      }
      const priced = variants.length ? fromPrice(variants) : { price: own, currency };
      out.push({
        provider: 'woocommerce',
        externalId: String(p.id),
        title: p.name,
        url: p.permalink || null,
        imageUrl: p.images[0]?.src ?? null,
        available: variants.length
          ? variants.some((v) => v.available)
          : p.stock_status === 'instock',
        ...priced,
        variants,
      });
    }
    const totalPages = Number(headers.get('x-wp-totalpages') ?? '1');
    return { products: out, next: page < totalPages ? String(page + 1) : null, skipped };
  }

  probe(): Promise<ConnectionStatus> {
    return statusFromProbe('woocommerce', () => this.listProducts({ first: 1 }));
  }
}

/* ───────────────────────── Configuración ───────────────────────── */

/**
 * Lee las credenciales del ENTORNO del servidor. Sin ellas, el proveedor queda
 * `not_connected` con su motivo; nunca se inventa una conexión.
 */
export function connectedShopsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  adapters: ConnectedShopAdapter[];
  missing: ConnectionStatus[];
} {
  const adapters: ConnectedShopAdapter[] = [];
  const missing: ConnectionStatus[] = [];
  if (env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN) {
    adapters.push(
      new ShopifyStorefrontAdapter({
        storeDomain: env.SHOPIFY_STORE_DOMAIN,
        privateToken: env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN,
      })
    );
  } else {
    missing.push({
      provider: 'shopify',
      state: 'not_connected',
      detail:
        'Falta autorización del comerciante: dominio de la tienda y token privado de Storefront (canal Headless).',
    });
  }
  if (env.WOOCOMMERCE_BASE_URL && env.WOOCOMMERCE_CONSUMER_KEY && env.WOOCOMMERCE_CONSUMER_SECRET) {
    adapters.push(
      new WooCommerceAdapter({
        baseUrl: env.WOOCOMMERCE_BASE_URL,
        consumerKey: env.WOOCOMMERCE_CONSUMER_KEY,
        consumerSecret: env.WOOCOMMERCE_CONSUMER_SECRET,
      })
    );
  } else {
    missing.push({
      provider: 'woocommerce',
      state: 'not_connected',
      detail:
        'Falta autorización del comerciante: URL HTTPS de la tienda y claves REST de solo lectura.',
    });
  }
  return { adapters, missing };
}
