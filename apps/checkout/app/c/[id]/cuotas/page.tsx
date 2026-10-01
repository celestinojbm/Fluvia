import { PlanClient } from '../../../plan-client';
import { normalizeLocale } from '../../../messages';

/** `/c/{id}/cuotas#secret`: el comprador consulta su plan (simulación). */
export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { id } = await params;
  const { lang } = await searchParams;
  return <PlanClient sessionId={id} locale={normalizeLocale(lang)} />;
}
