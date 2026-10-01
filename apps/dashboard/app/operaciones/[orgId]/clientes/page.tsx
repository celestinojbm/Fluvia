import { readOps } from '../../lib/server';
import type { ConsumerRow } from '../../lib/types';
import { Failed, St, when } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function Clientes({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { orgId } = await params;
  const { q } = await searchParams;
  const r = await readOps<{ data: ConsumerRow[] }>(
    orgId,
    `/consumers${q ? `?q=${encodeURIComponent(q)}` : ''}`
  );
  if (r.kind !== 'ok') return <Failed />;
  const rows = r.data.data;
  return (
    <main aria-labelledby="ox-cl">
      <div className="ox-head">
        <div>
          <p className="ox-eyebrow">Clientes</p>
          <h1 id="ox-cl">{q ? `Resultados para «${q}»` : 'Clientes del programa'}</h1>
        </div>
        <form className="ox-row" role="search" action="">
          <label className="sr-only" htmlFor="ox-cq">
            Buscar
          </label>
          <input
            id="ox-cq"
            name="q"
            defaultValue={q}
            placeholder="Correo, nombre o id"
            className="ox-field"
            style={{
              minHeight: 36,
              padding: '0 10px',
              borderRadius: 8,
              border: '1px solid var(--fx-line-strong)',
            }}
          />
          <button className="ox-btn" type="submit">
            Buscar
          </button>
        </form>
      </div>
      {rows.length === 0 ? (
        <div className="ox-empty">
          {q ? 'Ningún cliente coincide con la búsqueda.' : 'Aún no hay clientes registrados.'}
        </div>
      ) : (
        <div className="ox-table-wrap">
          <table className="ox-table is-stack">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Estado</th>
                <th>Perfil (sintético)</th>
                <th className="ox-num">Casos abiertos</th>
                <th className="ox-num">Cuotas vencidas</th>
                <th>Alta</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td data-label="Cliente">
                    <a href={`/operaciones/${orgId}/clientes/${c.id}`}>
                      <strong>{c.display_name}</strong>
                    </a>
                    <div className="ox-muted">{c.email}</div>
                  </td>
                  <td data-label="Estado">
                    <St s={c.status} />
                  </td>
                  <td data-label="Perfil">{c.synthetic_risk_profile}</td>
                  <td
                    data-label="Casos abiertos"
                    className={`ox-num${c.open_cases ? ' ox-warn' : ''}`}
                  >
                    {c.open_cases}
                  </td>
                  <td
                    data-label="Cuotas vencidas"
                    className={`ox-num${c.overdue_installments ? ' ox-bad' : ''}`}
                  >
                    {c.overdue_installments}
                  </td>
                  <td data-label="Alta">{when(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
