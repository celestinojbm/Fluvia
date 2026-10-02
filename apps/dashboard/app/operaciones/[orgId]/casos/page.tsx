import { OpsAction } from '../../lib/ops-action';
import { readOps } from '../../lib/server';
import type { CaseRow } from '../../lib/types';
import { CASE_TYPE, Failed, St, when } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function Casos({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ status?: string; tipo?: string; id?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const r = await readOps<{ data: CaseRow[] }>(
    orgId,
    `/cases${sp.status ? `?status=${sp.status}` : ''}`
  );
  if (r.kind !== 'ok') return <Failed />;
  let rows = r.data.data;
  if (sp.tipo === 'inciertos')
    rows = rows.filter((c) => c.case_type.startsWith('uncertain_') && c.status !== 'resolved');
  if (sp.id) rows = rows.filter((c) => c.id === sp.id);
  const base = `/operaciones/${orgId}/casos`;
  const uncertainOpen = r.data.data.filter(
    (c) => c.case_type.startsWith('uncertain_') && c.status !== 'resolved'
  ).length;
  return (
    <main aria-labelledby="ox-cases">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">Casos</p>
          <h1 id="ox-cases">Casos e inciertos</h1>
        </div>
        <OpsAction
          orgId={orgId}
          path="uncertain/resolve"
          label={`Resolver inciertos por consulta (${uncertainOpen})`}
          reason={false}
          tone="primary"
          success="Consulta ejecutada: los verificados se cerraron solos."
        />
      </div>
      <p className="ox-muted">
        Un incierto retiene fondos hasta un resultado VERIFICADO (consulta al proveedor, evento
        firmado o conciliación). No se cierra a mano: la resolución por consulta lo cierra solo; si
        el proveedor no lo conoce, sigue abierto.
      </p>
      <nav className="ox-filters" aria-label="Filtro">
        {[
          ['', 'Todos', ''],
          ['open', 'Abiertos', ''],
          ['acknowledged', 'En trabajo', ''],
          ['', 'Inciertos', 'inciertos'],
          ['resolved', 'Resueltos', ''],
        ].map(([s, l, t]) => {
          const href = t ? `${base}?tipo=${t}` : s ? `${base}?status=${s}` : base;
          const current = t ? sp.tipo === t : !sp.tipo && (sp.status ?? '') === s;
          return (
            <a key={l} href={href} aria-current={current ? 'true' : undefined}>
              {l}
            </a>
          );
        })}
      </nav>
      {rows.length === 0 ? (
        <div className="ox-empty">No hay casos en este filtro.</div>
      ) : (
        <div
          className="ox-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Tabla (desplazable con teclado)"
        >
          <table className="ox-table is-stack">
            <thead>
              <tr>
                <th>Caso</th>
                <th>Estado</th>
                <th>Gravedad</th>
                <th>Resumen</th>
                <th>Abierto</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td data-label="Caso">
                    <strong>{CASE_TYPE[c.case_type] ?? c.case_type}</strong>
                    <div className="ox-mono">
                      {c.subject_type}:{c.subject_id.slice(0, 8)}
                    </div>
                    {c.consumer_id ? (
                      <a href={`/operaciones/${orgId}/clientes/${c.consumer_id}`}>Cliente</a>
                    ) : null}
                  </td>
                  <td data-label="Estado">
                    <St s={c.status} />
                  </td>
                  <td data-label="Gravedad">{c.severity}</td>
                  <td data-label="Resumen">
                    {c.summary}
                    {c.resolution ? (
                      <div className="ox-muted">Resolución: {c.resolution}</div>
                    ) : null}
                  </td>
                  <td data-label="Abierto">{when(c.created_at)}</td>
                  <td data-label="Acciones">
                    <div className="ox-row">
                      {c.status === 'open' ? (
                        <OpsAction
                          orgId={orgId}
                          path={`cases/${c.id}/acknowledge`}
                          label="Tomar"
                          reason={false}
                          success="Caso asignado a ti."
                        />
                      ) : null}
                      {c.status !== 'resolved' && !c.case_type.startsWith('uncertain_') ? (
                        <OpsAction
                          orgId={orgId}
                          path={`cases/${c.id}/resolve`}
                          label="Resolver"
                          success="Caso resuelto."
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
