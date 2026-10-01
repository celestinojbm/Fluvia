import { cookies } from 'next/headers';
import { readApi } from '../../../lib/commerce-api';
import { Empty, PageHead } from '../../../lib/ui';
import { ResolveUncertain } from './resolve';

export const dynamic = 'force-dynamic';

interface Queue {
  attempts: { id: string; age_seconds: number }[];
  refunds: { id: string; age_seconds: number }[];
}

function age(s: number): string {
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/**
 * Por confirmar: cobros y devoluciones cuyo resultado el proveedor aún no
 * confirmó (respuesta perdida). El dinero queda retenido hasta una fuente
 * verificada; el worker consulta cada minuto y aquí se puede forzar.
 */
export default async function PorConfirmar({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const token = (await cookies()).get('fluvia_session')?.value ?? '';
  const r = await readApi<Queue>(token, `/v1/organizations/${orgId}/uncertain`);
  return (
    <main className="fx-page" aria-labelledby="pc-title">
      <PageHead
        id="pc-title"
        eyebrow="Pagos"
        title="Por confirmar"
        description="Cuando el proveedor no responde a tiempo, Fluvia no da el cobro ni la devolución por buenos ni por fallidos: los retiene y pregunta al proveedor. La lista se vacía sola en cuanto hay respuesta verificada."
      />
      {r.kind !== 'ok' ? (
        <p className="error" role="alert">
          No se pudo cargar la lista. Recarga en unos segundos.
        </p>
      ) : r.data.attempts.length + r.data.refunds.length === 0 ? (
        <Empty title="Todo confirmado">
          No hay cobros ni devoluciones pendientes de confirmar.
        </Empty>
      ) : (
        <>
          <table className="fx-table">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Referencia</th>
                <th>Esperando</th>
              </tr>
            </thead>
            <tbody>
              {r.data.attempts.map((a) => (
                <tr key={a.id}>
                  <td>Cobro</td>
                  <td>
                    <code>••••{a.id.slice(-6)}</code>
                  </td>
                  <td>{age(a.age_seconds)}</td>
                </tr>
              ))}
              {r.data.refunds.map((a) => (
                <tr key={a.id}>
                  <td>Devolución</td>
                  <td>
                    <code>••••{a.id.slice(-6)}</code>
                  </td>
                  <td>{age(a.age_seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ResolveUncertain orgId={orgId} />
        </>
      )}
    </main>
  );
}
