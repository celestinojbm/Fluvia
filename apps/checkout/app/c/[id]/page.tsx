import { CheckoutClient } from '../../checkout-client';
import { normalizeLocale } from '../../messages';

/**
 * Ruta alojada `/c/{id}`. El `client_secret` viaja en el fragmento (`#…`),
 * legible solo en el cliente; el locale por `?lang=`. En Next 15 `params` y
 * `searchParams` son promesas.
 */
export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { id } = await params;
  const { lang } = await searchParams;
  return <CheckoutClient sessionId={id} locale={normalizeLocale(lang)} />;
}
