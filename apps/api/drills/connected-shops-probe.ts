import { connectedShopsFromEnv } from '@fluvia/commerce';

/**
 * Sonda de SOLO LECTURA de las tiendas conectadas configuradas en el entorno
 * del servidor (SHOPIFY_STORE_DOMAIN + SHOPIFY_STOREFRONT_PRIVATE_TOKEN;
 * WOOCOMMERCE_BASE_URL + WOOCOMMERCE_CONSUMER_KEY + WOOCOMMERCE_CONSUMER_SECRET).
 *
 * Imprime el estado de cada proveedor y, si conecta, cuántos productos lee
 * de la primera página. No escribe nada, no compra nada y nunca imprime las
 * credenciales. Uso: pnpm --filter @fluvia/api run probe:connected-shops
 */
const { adapters, missing } = connectedShopsFromEnv();
for (const m of missing) console.log(`${m.provider}: ${m.state} — ${m.detail}`);
for (const a of adapters) {
  const status = await a.probe();
  console.log(`${a.provider}: ${status.state} — ${status.detail}`);
  if (status.state === 'connected') {
    const page = await a.listProducts({ first: 5 });
    console.log(`  primera página: ${page.products.length} productos, ${page.skipped} omitidos`);
  }
}
