import { OpsAction } from '../../lib/ops-action';
import { readOps } from '../../lib/server';
import type { ApprovalRow, PolicyRow } from '../../lib/types';
import { Failed, St, money, when } from '../../lib/ui';
import { PolicyDraft } from './policy-draft';

export const dynamic = 'force-dynamic';

export default async function Politica({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const [pol, app] = await Promise.all([
    readOps<{ data: PolicyRow[] }>(orgId, '/policies'),
    readOps<{ data: ApprovalRow[] }>(orgId, '/approvals'),
  ]);
  if (pol.kind !== 'ok' || app.kind !== 'ok') return <Failed />;
  const active = pol.data.data.find((p) => p.status === 'active');
  return (
    <main aria-labelledby="ox-pol">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">Riesgo</p>
          <h1 id="ox-pol">Política y aprobaciones</h1>
        </div>
      </div>
      <p className="ox-sandbox">
        La política de referencia es SINTÉTICA. Multiplicador, inicial, tasas, mora y aplicación de
        garantía son parámetros de prueba pendientes de validación comercial y regulatoria; no son
        condiciones publicadas.
      </p>

      <section aria-labelledby="ox-appr">
        <h2 id="ox-appr" className="ox-eyebrow">
          Aprobaciones (doble firma)
        </h2>
        {app.data.data.length === 0 ? (
          <div className="ox-empty">No hay aprobaciones.</div>
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
                  <th>Acción</th>
                  <th>Detalle</th>
                  <th>Estado</th>
                  <th>Propuesta</th>
                  <th>Decisión</th>
                </tr>
              </thead>
              <tbody>
                {app.data.data.map((a) => (
                  <tr key={a.id}>
                    <td data-label="Acción">
                      {a.action === 'policy.activate'
                        ? 'Activar política'
                        : 'Aplicar garantía a deuda vencida'}
                    </td>
                    <td data-label="Detalle">
                      {a.action === 'collateral.apply' ? (
                        <>
                          {money(
                            String(a.payload.amount ?? '0'),
                            String(a.payload.currency ?? 'VES')
                          )}{' '}
                          · <a href={`/operaciones/${orgId}/clientes/${a.subject_id}`}>cliente</a>
                        </>
                      ) : (
                        <span className="ox-mono">{a.subject_id.slice(0, 8)}</span>
                      )}
                      <div className="ox-muted">{a.reason}</div>
                    </td>
                    <td data-label="Estado">
                      <St s={a.status} />
                    </td>
                    <td data-label="Propuesta">
                      {when(a.created_at)}
                      <div className="ox-mono">{a.proposed_by_user_id.slice(0, 8)}</div>
                    </td>
                    <td data-label="Decisión">
                      {a.status === 'proposed' ? (
                        <div className="ox-row">
                          <OpsAction
                            orgId={orgId}
                            path={`approvals/${a.id}/decision`}
                            label="Aprobar"
                            tone="primary"
                            reason={false}
                            extra={{ decision: 'approve' }}
                            success="Aprobada y ejecutada."
                          />
                          <OpsAction
                            orgId={orgId}
                            path={`approvals/${a.id}/decision`}
                            label="Rechazar"
                            tone="danger"
                            reason={false}
                            extra={{ decision: 'reject' }}
                            success="Rechazada."
                          />
                        </div>
                      ) : (
                        <span className="ox-muted">{a.decided_by_user_id?.slice(0, 8) ?? ''}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ox-section" aria-labelledby="ox-versions">
        <h2 id="ox-versions">Versiones</h2>
        <div
          className="ox-table-wrap"
          tabIndex={0}
          role="group"
          aria-label="Tabla (desplazable con teclado)"
        >
          <table className="ox-table is-stack">
            <thead>
              <tr>
                <th>Política</th>
                <th>Estado</th>
                <th>Origen</th>
                <th>Activada</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pol.data.data.map((p) => (
                <tr key={p.id}>
                  <td data-label="Política">
                    <strong>
                      {p.code} v{p.version}
                    </strong>
                    {p.is_reference ? <div className="ox-muted">Referencia sintética</div> : null}
                  </td>
                  <td data-label="Estado">
                    <St s={p.status} />
                  </td>
                  <td data-label="Origen">
                    {p.created_by_user_id
                      ? `Operador ${p.created_by_user_id.slice(0, 8)}`
                      : 'Sistema'}
                  </td>
                  <td data-label="Activada">{p.activated_at ? when(p.activated_at) : '—'}</td>
                  <td data-label="Acciones">
                    {p.status === 'draft' ? (
                      <OpsAction
                        orgId={orgId}
                        path={`policies/${p.id}/propose-activation`}
                        label="Proponer activación"
                        success="Propuesta creada: otra persona debe aprobarla."
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {active ? (
        <section className="ox-section" aria-labelledby="ox-params">
          <h2 id="ox-params">Parámetros vigentes y nueva versión</h2>
          <PolicyDraft
            orgId={orgId}
            code={active.code}
            params={JSON.stringify(active.params, null, 2)}
          />
        </section>
      ) : null}
    </main>
  );
}
