import { OpsAction } from '../../lib/ops-action';
import { readOps } from '../../lib/server';
import { Failed, St, when } from '../../lib/ui';

export const dynamic = 'force-dynamic';

interface CardRow {
  id: string;
  consumer_id: string;
  currency: string;
  form: string;
  status: string;
  last4: string | null;
  blocked_by: string | null;
  funding_mode: string;
  created_at: string;
  shipment: { status: string; city: string } | null;
}

export default async function Tarjetas({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ estado?: string }>;
}) {
  const { orgId } = await params;
  const { estado } = await searchParams;
  const r = await readOps<{ data: CardRow[] }>(orgId, '/cards');
  if (r.kind !== 'ok') return <Failed />;
  const rows = r.data.data.filter(
    (c) =>
      !estado ||
      c.status === estado ||
      (estado === 'envio' && c.shipment && c.shipment.status !== 'delivered')
  );
  const base = `/operaciones/${orgId}/tarjetas`;
  return (
    <main aria-labelledby="ox-cards">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">Tarjetas</p>
          <h1 id="ox-cards">Tarjetas del programa</h1>
        </div>
      </div>
      <p className="ox-muted">
        Emisor simulado: solo últimos 4 dígitos y referencias opacas. Fluvia no almacena PAN ni CVV.
      </p>
      <nav className="ox-filters" aria-label="Filtro">
        {[
          ['', 'Todas'],
          ['active', 'Activas'],
          ['blocked', 'Bloqueadas'],
          ['inactive', 'Por activar'],
          ['envio', 'Envíos en curso'],
        ].map(([v, l]) => (
          <a
            key={v}
            href={v ? `${base}?estado=${v}` : base}
            aria-current={(estado ?? '') === v ? 'true' : undefined}
          >
            {l}
          </a>
        ))}
      </nav>
      {rows.length === 0 ? (
        <div className="ox-empty">Sin tarjetas en este filtro.</div>
      ) : (
        <div className="ox-table-wrap">
          <table className="ox-table is-stack">
            <thead>
              <tr>
                <th>Tarjeta</th>
                <th>Cliente</th>
                <th>Estado</th>
                <th>Envío</th>
                <th>Alta</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id}>
                  <td data-label="Tarjeta">
                    {k.form === 'virtual' ? 'Virtual' : 'Física'} •••• {k.last4 ?? '····'} ·{' '}
                    {k.currency}
                  </td>
                  <td data-label="Cliente">
                    <a href={`/operaciones/${orgId}/clientes/${k.consumer_id}`}>Ver cliente</a>
                  </td>
                  <td data-label="Estado">
                    <St s={k.status} />
                    {k.blocked_by ? (
                      <div className="ox-muted">
                        por {k.blocked_by === 'operator' ? 'Operaciones' : 'el cliente'}
                      </div>
                    ) : null}
                  </td>
                  <td data-label="Envío">
                    {k.shipment ? (
                      <>
                        <St s={k.shipment.status} />{' '}
                        <span className="ox-muted">{k.shipment.city}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label="Alta">{when(k.created_at)}</td>
                  <td data-label="Acciones">
                    <div className="ox-row">
                      {k.status === 'active' || k.status === 'inactive' ? (
                        <OpsAction
                          orgId={orgId}
                          path={`cards/${k.id}/block`}
                          label="Bloquear"
                          tone="danger"
                          success="Bloqueada."
                        />
                      ) : null}
                      {k.status === 'blocked' ? (
                        <OpsAction
                          orgId={orgId}
                          path={`cards/${k.id}/unblock`}
                          label="Desbloquear"
                          success="Desbloqueada."
                        />
                      ) : null}
                      {k.shipment &&
                      ['requested', 'produced', 'shipped'].includes(k.shipment.status) ? (
                        <OpsAction
                          orgId={orgId}
                          path={`cards/${k.id}/shipment`}
                          label="Avanzar envío"
                          reason={false}
                          extra={{
                            status:
                              k.shipment.status === 'requested'
                                ? 'produced'
                                : k.shipment.status === 'produced'
                                  ? 'shipped'
                                  : 'delivered',
                          }}
                          success="Envío actualizado."
                        />
                      ) : null}
                      {k.status !== 'closed' && k.status !== 'replaced' ? (
                        <OpsAction
                          orgId={orgId}
                          path={`cards/${k.id}/close`}
                          label="Cerrar"
                          tone="danger"
                          success="Cerrada."
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
