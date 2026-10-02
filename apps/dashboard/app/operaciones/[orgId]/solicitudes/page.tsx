import { OpsAction } from '../../lib/ops-action';
import { readOps } from '../../lib/server';
import { Failed, St, money, when } from '../../lib/ui';

export const dynamic = 'force-dynamic';

interface App {
  id: string;
  consumer_id: string;
  currency: string;
  requested_limit: string;
  collateral_at_evaluation: string;
  status: string;
  risk_tier: string;
  proposed_limit: string;
  approved_limit: string | null;
  decision: {
    reasons: { code: string; message: string }[];
    policy: { code: string; version: number };
    review?: { reason: string };
  };
  decided_by: string;
  created_at: string;
}

export default async function Solicitudes({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ estado?: string; linea?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const estado = sp.estado ?? 'manual_review';
  const r = await readOps<{ data: App[] }>(
    orgId,
    `/applications${estado === 'todas' ? '' : `?status=${estado}`}`
  );
  if (r.kind !== 'ok') return <Failed />;
  const history = sp.linea
    ? await readOps<{
        line: { currency: string; approved_limit: string };
        history: {
          old_limit: string | null;
          new_limit: string;
          source: string;
          reason: string;
          actor_user_id: string | null;
          created_at: string;
        }[];
      }>(orgId, `/lines/${sp.linea}`)
    : null;
  const base = `/operaciones/${orgId}/solicitudes`;
  return (
    <main aria-labelledby="ox-apps">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">Crédito</p>
          <h1 id="ox-apps">Solicitudes y límites</h1>
        </div>
      </div>
      {history && history.kind === 'ok' ? (
        <section
          className="ox-section"
          aria-labelledby="ox-hist"
          style={{ marginTop: 0, marginBottom: 24 }}
        >
          <h2 id="ox-hist">Historial de límites de la línea</h2>
          <div
            className="ox-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Tabla (desplazable con teclado)"
          >
            <table className="ox-table is-stack">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Origen</th>
                  <th className="ox-num">Antes</th>
                  <th className="ox-num">Después</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {history.data.history.map((h, i) => (
                  <tr key={i}>
                    <td data-label="Fecha">{when(h.created_at)}</td>
                    <td data-label="Origen">
                      {h.source === 'operator'
                        ? 'Operador'
                        : h.source === 'application'
                          ? 'Solicitud'
                          : h.source === 'collateral_release'
                            ? 'Liberación de garantía'
                            : h.source}
                    </td>
                    <td data-label="Antes" className="ox-num">
                      {h.old_limit ? money(h.old_limit, history.data.line.currency) : '—'}
                    </td>
                    <td data-label="Después" className="ox-num">
                      {money(h.new_limit, history.data.line.currency)}
                    </td>
                    <td data-label="Motivo">{h.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <nav className="ox-filters" aria-label="Estado">
        {[
          ['manual_review', 'En revisión'],
          ['approved', 'Aprobadas'],
          ['rejected', 'Rechazadas'],
          ['todas', 'Todas'],
        ].map(([v, l]) => (
          <a key={v} href={`${base}?estado=${v}`} aria-current={estado === v ? 'true' : undefined}>
            {l}
          </a>
        ))}
      </nav>
      {r.data.data.length === 0 ? (
        <div className="ox-empty">
          {estado === 'manual_review'
            ? 'No hay solicitudes esperando revisión.'
            : 'Sin solicitudes en este estado.'}
        </div>
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
                <th>Cliente</th>
                <th className="ox-num">Solicitado</th>
                <th className="ox-num">Garantía al evaluar</th>
                <th className="ox-num">Propuesto</th>
                <th>Estado</th>
                <th>Explicación</th>
                <th>Decisión</th>
              </tr>
            </thead>
            <tbody>
              {r.data.data.map((a) => (
                <tr key={a.id}>
                  <td data-label="Cliente">
                    <a href={`/operaciones/${orgId}/clientes/${a.consumer_id}`}>Ver cliente</a>
                    <div className="ox-muted">
                      {when(a.created_at)} · nivel {a.risk_tier}
                    </div>
                  </td>
                  <td data-label="Solicitado" className="ox-num">
                    {money(a.requested_limit, a.currency)}
                  </td>
                  <td data-label="Garantía" className="ox-num">
                    {money(a.collateral_at_evaluation, a.currency)}
                  </td>
                  <td data-label="Propuesto" className="ox-num">
                    {money(a.proposed_limit, a.currency)}
                  </td>
                  <td data-label="Estado">
                    <St s={a.status} />
                    {a.approved_limit ? (
                      <div className="ox-muted">{money(a.approved_limit, a.currency)}</div>
                    ) : null}
                  </td>
                  <td data-label="Explicación">
                    <ul className="ox-reasons">
                      {a.decision.reasons.map((x) => (
                        <li key={x.code}>{x.message}</li>
                      ))}
                    </ul>
                    <div className="ox-muted">
                      Política {a.decision.policy.code} v{a.decision.policy.version}
                    </div>
                  </td>
                  <td data-label="Decisión">
                    {a.status === 'manual_review' ? (
                      <div className="ox-row">
                        <OpsAction
                          orgId={orgId}
                          path={`applications/${a.id}/decision`}
                          label="Aprobar"
                          tone="primary"
                          extra={{ decision: 'approve' }}
                          fields={[
                            {
                              name: 'limit',
                              label: `Límite (máx. ${money(a.proposed_limit, a.currency)})`,
                              type: 'amount',
                              required: false,
                              placeholder: 'Propuesto',
                            },
                          ]}
                          success="Solicitud aprobada."
                        />
                        <OpsAction
                          orgId={orgId}
                          path={`applications/${a.id}/decision`}
                          label="Rechazar"
                          tone="danger"
                          extra={{ decision: 'reject' }}
                          success="Solicitud rechazada."
                        />
                      </div>
                    ) : (
                      <span className="ox-muted">
                        {a.decided_by === 'operator'
                          ? `Operador: ${a.decision.review?.reason ?? ''}`
                          : 'Motor'}
                      </span>
                    )}
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
