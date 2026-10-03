import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectedShopError,
  SHOPIFY_STOREFRONT_VERSION,
  ShopifyStorefrontAdapter,
  WooCommerceAdapter,
  connectedShopsFromEnv,
} from '../src/index.js';

/**
 * Pruebas de CONTRATO de los adaptadores de tiendas conectadas contra
 * servidores HTTP locales que reproducen la forma documentada de cada API
 * (Shopify Storefront 2026-10 GraphQL; WooCommerce REST v3). Verifican lo que
 * Fluvia ENVÍA (ruta, versión, cabeceras de autenticación) y cómo INTERPRETA
 * la respuesta. Ningún dato ni credencial real: tokens sintéticos.
 */

const SHOPIFY_TOKEN = 'shpat_sintetico_de_prueba';
const WOO_KEY = 'ck_sintetica';
const WOO_SECRET = 'cs_sintetica';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
let seen: Seen[] = [];
let server: Server;
let base: string;
let shopifyMode: 'ok' | 'unauthorized' | 'graphql_error' = 'ok';

const shopifyPage = (after: string | null) => ({
  data: {
    products: {
      edges:
        after === null
          ? [
              {
                node: {
                  id: 'gid://shopify/Product/1',
                  title: 'Camisa de lino',
                  handle: 'camisa-lino',
                  availableForSale: true,
                  featuredImage: { url: 'https://cdn.shopify.example/camisa.jpg' },
                  variants: {
                    edges: [
                      {
                        node: {
                          id: 'gid://shopify/ProductVariant/11',
                          title: 'M',
                          availableForSale: true,
                          price: { amount: '48.0', currencyCode: 'USD' },
                        },
                      },
                      {
                        node: {
                          id: 'gid://shopify/ProductVariant/12',
                          title: 'L',
                          availableForSale: false,
                          price: { amount: '45.5', currencyCode: 'USD' },
                        },
                      },
                    ],
                  },
                },
              },
              {
                node: {
                  id: 'gid://shopify/Product/2',
                  title: 'Taza',
                  handle: 'taza',
                  availableForSale: false,
                  featuredImage: null,
                  variants: {
                    edges: [
                      {
                        node: {
                          id: 'gid://shopify/ProductVariant/21',
                          title: 'Default Title',
                          availableForSale: false,
                          price: { amount: '12.00', currencyCode: 'USD' },
                        },
                      },
                    ],
                  },
                },
              },
              {
                // Moneda no soportada por Fluvia: se omite, no se convierte.
                node: {
                  id: 'gid://shopify/Product/3',
                  title: 'Bolso',
                  handle: 'bolso',
                  availableForSale: true,
                  featuredImage: null,
                  variants: {
                    edges: [
                      {
                        node: {
                          id: 'gid://shopify/ProductVariant/31',
                          title: 'Default Title',
                          availableForSale: true,
                          price: { amount: '9000', currencyCode: 'XAF' },
                        },
                      },
                    ],
                  },
                },
              },
            ]
          : [],
      pageInfo:
        after === null
          ? { hasNextPage: true, endCursor: 'cursor-1' }
          : { hasNextPage: false, endCursor: null },
    },
  },
});

const wooProducts = [
  {
    id: 101,
    name: 'Vela de soya',
    type: 'simple',
    status: 'publish',
    price: '7.50',
    stock_status: 'instock',
    permalink: 'https://tienda.example/producto/vela',
    images: [{ src: 'https://tienda.example/vela.jpg' }],
    variations: [],
  },
  {
    id: 102,
    name: 'Franela',
    type: 'variable',
    status: 'publish',
    price: '20.00',
    stock_status: 'instock',
    permalink: 'https://tienda.example/producto/franela',
    images: [],
    variations: [201, 202],
  },
  {
    id: 103,
    name: 'Sin precio',
    type: 'simple',
    status: 'publish',
    price: '',
    stock_status: 'instock',
    permalink: 'https://tienda.example/producto/sin-precio',
    images: [],
    variations: [],
  },
];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === `/api/${SHOPIFY_STOREFRONT_VERSION}/graphql.json`) {
        if (req.headers['shopify-storefront-private-token'] !== SHOPIFY_TOKEN) {
          return json(401, { errors: 'Unauthorized' });
        }
        if (shopifyMode === 'unauthorized') return json(403, { errors: 'Forbidden' });
        if (shopifyMode === 'graphql_error') {
          return json(200, { errors: [{ message: 'Field does not exist' }] });
        }
        const vars = (JSON.parse(body) as { variables: { after: string | null } }).variables;
        return json(200, shopifyPage(vars.after));
      }
      if (url.pathname.startsWith('/wp-json/wc/v3/')) {
        const expected = `Basic ${Buffer.from(`${WOO_KEY}:${WOO_SECRET}`).toString('base64')}`;
        if (req.headers.authorization !== expected) {
          return json(401, { code: 'woocommerce_rest_cannot_view' });
        }
        const path = url.pathname.replace('/wp-json/wc/v3', '');
        if (path === '/data/currencies/current') {
          return json(200, { code: 'USD', name: 'United States (US) dollar', symbol: '$' });
        }
        if (path === '/products') {
          const page = Number(url.searchParams.get('page'));
          return json(200, page === 1 ? wooProducts : [], {
            'X-WP-Total': '3',
            'X-WP-TotalPages': '2',
          });
        }
        if (path === '/products/102/variations') {
          return json(200, [
            {
              id: 201,
              price: '22.00',
              stock_status: 'instock',
              attributes: [{ name: 'Talla', option: 'M' }],
            },
            {
              id: 202,
              price: '18.00',
              stock_status: 'outofstock',
              attributes: [{ name: 'Talla', option: 'XL' }],
            },
          ]);
        }
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen = [];
  shopifyMode = 'ok';
});

const shopify = (token = SHOPIFY_TOKEN) =>
  new ShopifyStorefrontAdapter({
    storeDomain: base,
    privateToken: token,
    allowInsecureForTests: true,
  });
const woo = (secret = WOO_SECRET) =>
  new WooCommerceAdapter({
    baseUrl: base,
    consumerKey: WOO_KEY,
    consumerSecret: secret,
    allowInsecureForTests: true,
  });

describe('Shopify Storefront (contrato)', () => {
  it('POST GraphQL a la versión fijada con el token PRIVADO de servidor', async () => {
    const page = await shopify().listProducts({ first: 10 });
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req!.method).toBe('POST');
    expect(req!.url).toBe(`/api/${SHOPIFY_STOREFRONT_VERSION}/graphql.json`);
    expect(req!.headers['shopify-storefront-private-token']).toBe(SHOPIFY_TOKEN);
    // El token público (de navegador) no se usa desde el servidor.
    expect(req!.headers['x-shopify-storefront-access-token']).toBeUndefined();
    const sent = JSON.parse(req!.body) as { query: string; variables: unknown };
    expect(sent.query).toContain('products(first: $first, after: $after)');
    expect(sent.variables).toEqual({ first: 10, after: null });

    expect(page.next).toBe('cursor-1');
    expect(page.skipped).toBe(1);
    const [camisa, taza] = page.products;
    // «Desde» = variante DISPONIBLE más barata (L está agotada aunque cueste menos).
    expect(camisa).toMatchObject({
      externalId: 'gid://shopify/Product/1',
      price: 4800n,
      currency: 'USD',
      available: true,
      url: expect.stringMatching(/\/products\/camisa-lino$/),
    });
    expect(camisa!.variants.map((v) => [v.label, v.price, v.available])).toEqual([
      ['M', 4800n, true],
      ['L', 4550n, false],
    ]);
    // «Default Title» no es una opción real.
    expect(taza).toMatchObject({ available: false, price: 1200n, variants: [] });
  });

  it('pagina con el cursor recibido', async () => {
    const page = await shopify().listProducts({ after: 'cursor-1' });
    expect(JSON.parse(seen[0]!.body).variables.after).toBe('cursor-1');
    expect(page).toEqual({ products: [], next: null, skipped: 0 });
  });

  it('credencial rechazada o error GraphQL ⇒ error tipado y sonda en «error»', async () => {
    await expect(shopify('otro').listProducts()).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(await shopify('otro').probe()).toMatchObject({ state: 'error' });
    shopifyMode = 'graphql_error';
    await expect(shopify().listProducts()).rejects.toBeInstanceOf(ConnectedShopError);
    shopifyMode = 'ok';
    expect(await shopify().probe()).toMatchObject({ provider: 'shopify', state: 'connected' });
  });

  it('rechaza http:// fuera de pruebas', () => {
    expect(
      () =>
        new ShopifyStorefrontAdapter({ storeDomain: 'http://tienda.example', privateToken: 'x' })
    ).toThrow(ConnectedShopError);
  });
});

describe('WooCommerce REST v3 (contrato)', () => {
  it('Basic auth, moneda de la tienda, solo publicados, variaciones y paginación', async () => {
    const page = await woo().listProducts({ first: 20 });
    expect(seen.map((s) => s.url)).toEqual([
      '/wp-json/wc/v3/data/currencies/current',
      '/wp-json/wc/v3/products?status=publish&per_page=20&page=1',
      '/wp-json/wc/v3/products/102/variations?per_page=50',
    ]);
    for (const s of seen) {
      expect(s.method).toBe('GET');
      // Claves en la cabecera, NUNCA en la URL.
      expect(s.url).not.toMatch(/consumer_(key|secret)/);
    }
    expect(page.next).toBe('2');
    expect(page.skipped).toBe(1);
    const [vela, franela] = page.products;
    expect(vela).toMatchObject({
      externalId: '101',
      price: 750n,
      currency: 'USD',
      available: true,
      url: 'https://tienda.example/producto/vela',
      imageUrl: 'https://tienda.example/vela.jpg',
      variants: [],
    });
    expect(franela).toMatchObject({ price: 2200n, available: true });
    expect(franela!.variants.map((v) => [v.label, v.price, v.available])).toEqual([
      ['M', 2200n, true],
      ['XL', 1800n, false],
    ]);
    // La moneda se consulta una sola vez por adaptador.
    seen = [];
    const a = woo();
    await a.listProducts();
    await a.listProducts({ after: '2' });
    expect(seen.filter((s) => s.url.includes('currencies')).length).toBe(1);
  });

  it('claves rechazadas ⇒ error tipado y sonda en «error»', async () => {
    await expect(woo('mala').listProducts()).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(await woo('mala').probe()).toMatchObject({ state: 'error' });
    expect(await woo().probe()).toMatchObject({ provider: 'woocommerce', state: 'connected' });
  });

  it('rechaza http:// fuera de pruebas (las claves viajan en Basic auth)', () => {
    expect(
      () =>
        new WooCommerceAdapter({
          baseUrl: 'http://tienda.example',
          consumerKey: 'k',
          consumerSecret: 's',
        })
    ).toThrow(ConnectedShopError);
  });
});

describe('configuración desde el entorno del servidor', () => {
  it('sin credenciales ⇒ «not_connected» con motivo; nunca una conexión inventada', () => {
    const { adapters, missing } = connectedShopsFromEnv({});
    expect(adapters).toEqual([]);
    expect(missing.map((m) => [m.provider, m.state])).toEqual([
      ['shopify', 'not_connected'],
      ['woocommerce', 'not_connected'],
    ]);
  });

  it('con credenciales crea el adaptador, pero el estado lo da la sonda', () => {
    const { adapters, missing } = connectedShopsFromEnv({
      SHOPIFY_STORE_DOMAIN: 'tienda-sintetica.myshopify.com',
      SHOPIFY_STOREFRONT_PRIVATE_TOKEN: SHOPIFY_TOKEN,
    });
    expect(adapters.map((a) => a.provider)).toEqual(['shopify']);
    expect(missing.map((m) => m.provider)).toEqual(['woocommerce']);
  });
});
