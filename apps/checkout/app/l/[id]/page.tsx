import { redirect } from 'next/navigation';
import { normalizeLocale } from '../../messages';
import { LinkUnavailable } from './link-unavailable';
import { resolveLinkSession } from './resolve';

/**
 * Ruta pública del payment link `/l/{id}` (F3-06-b). Es la `url` que el comercio
 * comparte. Al abrirla, el servidor genera una sesión de checkout FRESCA (F3-06)
 * y redirige al flujo alojado `/c/{sessionId}#{clientSecret}` (F3-05c-iv). Un
 * link inválido/deshabilitado muestra el mismo mensaje (anti-enumeración).
 *
 * En Next 15 `params`/`searchParams` son promesas. `redirect()` debe quedar
 * FUERA de cualquier try (lanza `NEXT_REDIRECT` internamente).
 */

const API = process.env.FLUVIA_API_URL ?? 'http://127.0.0.1:3000';

export const dynamic = 'force-dynamic';

export default async function PaymentLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { id } = await params;
  const { lang } = await searchParams;
  const target = await resolveLinkSession({ apiBase: API, linkId: id, lang });
  if (target) redirect(target);
  return <LinkUnavailable locale={normalizeLocale(lang)} />;
}
