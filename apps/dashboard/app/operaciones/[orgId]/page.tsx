import { OpsAction } from '../lib/ops-action';
import { readOps } from '../lib/server';
import type { Overview, Program } from '../lib/types';
import { Failed, Sandbox, money } from '../lib/ui';

export const dynamic = 'force-dynamic';

export default async function OpsHome({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const r = await readOps<{ program: Program; overview: Overview }>(orgId, '');
  if (r.kind !== 'ok') return <Failed />;
  const { overview: o, program } = r.data;
  const base = `/operaciones/${orgId}`;
  const q = o.queues;
  return (
    <main aria-labelledby="ox-home">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">Resumen del programa</p>
          <h1 id="ox-home">{program.name}</h1>
        </div>
        <div className="ox-row">
          <OpsAction
            orgId={orgId}
            path="reconciliation/run"
            label="Conciliar ahora"
            reason={false}
            success="Conciliación ejecutada: revisa Casos."
          />
          <OpsAction
            orgId={orgId}
            path="uncertain/resolve"
            label="Resolver inciertos"
            reason={false}
            tone="primary"
            success="Consulta verificada ejecutada."
          />
        </div>
      </div>
      <Sandbox />

      <nav className="ox-queues" aria-label="Colas de trabajo">
        <a href={`${base}/solicitudes`} className={q.manual_reviews ? 'is-hot' : ''}>
          <strong>{q.manual_reviews}</strong>
          <span>Solicitudes en revisión</span>
        </a>
        <a href={`${base}/casos?status=open`} className={q.open_cases ? 'is-hot' : ''}>
          <strong>{q.open_cases}</strong>
          <span>Casos abiertos</span>
        </a>
        <a href={`${base}/casos?tipo=inciertos`} className={q.uncertain ? 'is-hot' : ''}>
          <strong>{q.uncertain}</strong>
          <span>Inciertos con fondos retenidos</span>
        </a>
        <a href={`${base}/eventos?status=unmatched`} className={q.unmatched_events ? 'is-hot' : ''}>
          <strong>{q.unmatched_events}</strong>
          <span>Eventos sin objeto</span>
        </a>
        <a href={`${base}/politica`} className={q.pending_approvals ? 'is-hot' : ''}>
          <strong>{q.pending_approvals}</strong>
          <span>Aprobaciones pendientes</span>
        </a>
      </nav>

      <section className="ox-section" aria-labelledby="ox-money">
        <h2 id="ox-money">Dinero y riesgo por moneda (ledger)</h2>
        {o.by_currency.length === 0 ? (
          <div className="ox-empty">Aún no hay movimientos en el programa.</div>
        ) : (
          <div className="ox-table-wrap">
            <table className="ox-table is-stack">
              <thead>
                <tr>
                  <th>Moneda</th>
                  <th className="ox-num">Propio disponible</th>
                  <th className="ox-num">Retenido</th>
                  <th className="ox-num">Garantía</th>
                  <th className="ox-num">Límites aprobados</th>
                  <th className="ox-num">Deuda</th>
                  <th className="ox-num">Reservado crédito</th>
                  <th className="ox-num">Vencido</th>
                  <th className="ox-num">Obligación con la red</th>
                </tr>
              </thead>
              <tbody>
                {o.by_currency.map((c) => (
                  <tr key={c.currency}>
                    <td data-label="Moneda">
                      <strong>{c.currency}</strong>
                    </td>
                    <td data-label="Propio disponible" className="ox-num">
                      {money(c.wallet_available, c.currency)}
                    </td>
                    <td data-label="Retenido" className="ox-num">
                      {money(c.wallet_held, c.currency)}
                    </td>
                    <td data-label="Garantía" className="ox-num">
                      {money(c.collateral, c.currency)}
                    </td>
                    <td data-label="Límites aprobados" className="ox-num">
                      {money(c.approved_limits, c.currency)}
                    </td>
                    <td data-label="Deuda" className="ox-num ox-credit">
                      {money(c.debt, c.currency)}
                    </td>
                    <td data-label="Reservado crédito" className="ox-num">
                      {money(c.reserved, c.currency)}
                    </td>
                    <td
                      data-label="Vencido"
                      className={`ox-num${BigInt(c.overdue) > 0n ? ' ox-bad' : ''}`}
                    >
                      {money(c.overdue, c.currency)}
                    </td>
                    <td data-label="Obligación con la red" className="ox-num">
                      {money(c.network_payable, c.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ox-section" aria-labelledby="ox-act">
        <h2 id="ox-act">Actividad</h2>
        <dl className="ox-kv">
          <div>
            <dt>Clientes</dt>
            <dd>
              {o.consumers.total} · {o.consumers.suspended} suspendidos
            </dd>
          </div>
          <div>
            <dt>Tarjetas activas</dt>
            <dd>{o.cards.active}</dd>
          </div>
          <div>
            <dt>Tarjetas bloqueadas</dt>
            <dd>{o.cards.blocked}</dd>
          </div>
          <div>
            <dt>Envíos en curso</dt>
            <dd>{o.cards.in_transit}</dd>
          </div>
          <div>
            <dt>Autorizaciones 24 h</dt>
            <dd>
              {o.authorizations_last24h.approved} aprobadas · {o.authorizations_last24h.declined}{' '}
              rechazadas
            </dd>
          </div>
          <div>
            <dt>Liquidación al comercio</dt>
            <dd>{program.settlement_delay_days} día(s) tras la captura</dd>
          </div>
        </dl>
      </section>

      <section className="ox-section" aria-labelledby="ox-maint">
        <h2 id="ox-maint">Procesos con fecha de corte</h2>
        <p className="ox-muted">El worker los ejecuta cada minuto; aquí puedes forzarlos.</p>
        <div className="ox-row">
          <OpsAction
            orgId={orgId}
            path="maintenance/overdue"
            label="Marcar cuotas vencidas"
            reason={false}
            success="Proceso ejecutado."
          />
          <OpsAction
            orgId={orgId}
            path="maintenance/expire-authorizations"
            label="Expirar autorizaciones"
            reason={false}
            success="Proceso ejecutado."
          />
        </div>
      </section>
    </main>
  );
}
