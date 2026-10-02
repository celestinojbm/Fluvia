import { OpsAction } from '../../lib/ops-action';
import { readOps } from '../../lib/server';
import type { EventRow } from '../../lib/types';
import { Failed, Sandbox, St, when } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function Eventos({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ status?: string; source?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (sp.status) qs.set('status', sp.status);
  if (sp.source) qs.set('source', sp.source);
  const r = await readOps<{ data: EventRow[] }>(orgId, `/events${qs.size ? `?${qs}` : ''}`);
  if (r.kind !== 'ok') return <Failed />;
  const base = `/operaciones/${orgId}/eventos`;
  return (
    <main aria-labelledby="ox-ev">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">Proveedores</p>
          <h1 id="ox-ev">Eventos y conciliación</h1>
        </div>
        <OpsAction
          orgId={orgId}
          path="reconciliation/run"
          label="Conciliar ahora"
          reason={false}
          success="Conciliación ejecutada: los descuadres abren casos."
        />
      </div>
      <Sandbox />
      <nav className="ox-filters" aria-label="Estado">
        {[
          ['', 'Todos'],
          ['applied', 'Aplicados'],
          ['unmatched', 'Sin objeto'],
          ['ignored_out_of_order', 'Tardíos'],
          ['failed', 'Fallidos'],
        ].map(([v, l]) => (
          <a
            key={v}
            href={v ? `${base}?status=${v}` : base}
            aria-current={(sp.status ?? '') === v ? 'true' : undefined}
          >
            {l}
          </a>
        ))}
      </nav>
      {r.data.data.length === 0 ? (
        <div className="ox-empty">Sin eventos en este filtro.</div>
      ) : (
        <div
          className="ox-table-wrap"
          tabIndex={0}
          role="group"
          aria-label="Tabla (desplazable con teclado)"
        >
          <table className="ox-table is-stack">
            <thead>
              <tr>
                <th>Fuente</th>
                <th>Tipo</th>
                <th>Estado</th>
                <th>Id del proveedor</th>
                <th>Recibido</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {r.data.data.map((e) => (
                <tr key={e.id}>
                  <td data-label="Fuente">{e.source}</td>
                  <td data-label="Tipo" className="ox-mono">
                    {e.event_type}
                  </td>
                  <td data-label="Estado">
                    <St s={e.status} />
                    {e.detail ? <div className="ox-muted">{e.detail}</div> : null}
                  </td>
                  <td data-label="Id" className="ox-mono">
                    {e.event_id}
                  </td>
                  <td data-label="Recibido">{when(e.received_at)}</td>
                  <td data-label="Acciones">
                    {e.status === 'unmatched' || e.status === 'failed' ? (
                      <OpsAction
                        orgId={orgId}
                        path={`events/${e.id}/reprocess`}
                        label="Reintentar"
                        reason={false}
                        success="Reprocesado."
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="ox-section" aria-labelledby="ox-sim">
        <h2 id="ox-sim">Simular un evento de proveedor (sandbox)</h2>
        <p className="ox-muted">
          Para ensayar duplicados y desorden: un mismo id se ignora; una captura antes de su
          autorización queda sin objeto y se aplica al reintentar.
        </p>
        <OpsAction
          orgId={orgId}
          path="sandbox/provider-events"
          label="Inyectar evento de red"
          reason={false}
          extra={{ source: 'network', event_type: 'authorization.request' }}
          fields={[{ name: 'event_id', label: 'Id del evento', placeholder: 'sim-…' }]}
          success="Evento ingerido."
        />
      </section>
    </main>
  );
}
