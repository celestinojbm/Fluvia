import { OpsAction } from '../../lib/ops-action';
import { readOps } from '../../lib/server';
import { Failed, when } from '../../lib/ui';

export const dynamic = 'force-dynamic';

interface Capability {
  key: string;
  label: string;
  market: string;
  status: 'sandbox' | 'operational' | 'pending_provider' | 'not_offered';
  ceiling: Capability['status'];
  offered: boolean;
  simulated: boolean;
  live_dependency: string;
  withdrawn: { reason: string; at: string } | null;
}
interface Withdrawal {
  id: string;
  market: string;
  capability: string;
  reason: string;
  withdrawn_by_user_id: string;
  withdrawn_at: string;
  lifted_at: string | null;
  lift_reason: string | null;
}

const STATUS: Record<Capability['status'], { label: string; tone: string }> = {
  sandbox: { label: 'Sandbox (simulado)', tone: 'info' },
  operational: { label: 'Operativo', tone: 'ok' },
  pending_provider: { label: 'Pendiente de socio', tone: 'warn' },
  not_offered: { label: 'No ofrecido', tone: 'neutral' },
};
const MARKET: Record<string, string> = { VE: 'Venezuela', CO: 'Colombia' };

/**
 * Capacidades por mercado. El TECHO es el catálogo versionado del código
 * (ninguna capacidad es operativa en dinero real); desde aquí solo se puede
 * RETIRAR una capacidad ofrecida (freno, con motivo y auditoría) y, OTRA
 * persona con step-up, restablecerla. Personal y Comercio dejan de ofrecer la
 * acción y el servidor la rechaza mientras esté retirada.
 */
export default async function Capacidades({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const r = await readOps<{
    markets: Array<{ market: string; capabilities: Capability[] }>;
    history: Withdrawal[];
  }>(orgId, '/capabilities');
  if (r.kind !== 'ok') return <Failed />;
  const { markets, history } = r.data;
  const label = new Map(markets.flatMap((m) => m.capabilities).map((c) => [c.key, c.label]));
  return (
    <main aria-labelledby="ox-caps">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">Configuración</p>
          <h1 id="ox-caps">Capacidades por mercado</h1>
        </div>
      </div>
      <p className="ox-muted">
        «Sandbox» significa que funciona con dinero simulado en este entorno. Nada aquí está
        contratado ni operativo con dinero real; cada fila dice qué socio falta. Retirar una
        capacidad la deja de ofrecer al instante; restablecerla exige a otra persona.
      </p>
      {markets.map(({ market: m, capabilities: caps }) => (
        <section key={m} className="ox-section" aria-labelledby={`ox-caps-${m}`}>
          <h2 id={`ox-caps-${m}`}>
            {MARKET[m] ?? m} ({m})
          </h2>
          <div
            className="ox-table-wrap"
            tabIndex={0}
            role="group"
            aria-label={`Capacidades en ${MARKET[m] ?? m} (desplazable)`}
          >
            <table className="ox-table is-stack">
              <thead>
                <tr>
                  <th>Capacidad · qué falta para dinero real</th>
                  <th>Estado</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {caps.map((c) => (
                  <tr key={c.key}>
                    <td data-label="Capacidad">
                      <strong>{c.label}</strong>
                      <br />
                      <code className="ox-mono">{c.key}</code>
                      <p className="ox-muted" style={{ margin: '4px 0 0' }}>
                        {c.live_dependency}
                      </p>
                    </td>
                    <td data-label="Estado">
                      <span className={`ox-status ox-${STATUS[c.status].tone}`}>
                        {STATUS[c.status].label}
                      </span>
                      {c.withdrawn ? (
                        <p className="ox-muted" style={{ margin: '4px 0 0' }}>
                          Retirada {when(c.withdrawn.at)}: {c.withdrawn.reason}
                        </p>
                      ) : null}
                    </td>
                    <td data-label="Acción">
                      {c.offered ? (
                        <OpsAction
                          orgId={orgId}
                          path="capabilities/withdrawals"
                          label="Retirar"
                          tone="danger"
                          extra={{ market: m, capability: c.key }}
                          confirm={`Se dejará de ofrecer «${c.label}» en ${MARKET[m] ?? m}. ¿Continuar?`}
                          success="Retirada. Personal y Comercio dejan de ofrecerla."
                        />
                      ) : (
                        <span className="ox-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="ox-section" aria-labelledby="ox-caps-hist">
        <h2 id="ox-caps-hist">Historial de retiradas</h2>
        {history.length === 0 ? (
          <div className="ox-empty">Ninguna retirada registrada.</div>
        ) : (
          <div className="ox-table-wrap" tabIndex={0} role="group" aria-label="Historial">
            <table className="ox-table is-stack">
              <thead>
                <tr>
                  <th>Capacidad</th>
                  <th>Retirada</th>
                  <th>Restablecida</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td data-label="Capacidad">
                      {label.get(h.capability) ?? h.capability} · {h.market}
                    </td>
                    <td data-label="Retirada">
                      {when(h.withdrawn_at)} · {h.reason}
                    </td>
                    <td data-label="Restablecida">
                      {h.lifted_at ? `${when(h.lifted_at)} · ${h.lift_reason}` : 'Vigente'}
                    </td>
                    <td data-label="Acción">
                      {h.lifted_at ? null : (
                        <OpsAction
                          orgId={orgId}
                          path={`capabilities/withdrawals/${h.id}/restore`}
                          label="Restablecer (otra persona)"
                          tone="primary"
                          success="Restablecida."
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
