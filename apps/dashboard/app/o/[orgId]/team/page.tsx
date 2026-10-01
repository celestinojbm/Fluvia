import { orgContext } from '../../../lib/org-context';
import { orgPath, readApi, type Member } from '../../../lib/commerce-api';
import { CAPABILITIES, ROLE_ORDER, ROLE_PERMISSIONS_MIRROR } from '../../../lib/team-matrix';
import { Callout, PageHead, ROLE_LABELS, ReadProblem, dateTime, roleLabel } from '../../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function TeamPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { token } = await orgContext(orgId);
  const members = await readApi<{ members: Member[] }>(token, orgPath(orgId, '/members'));
  return (
    <main className="fx-page" aria-labelledby="team-title">
      <PageHead
        id="team-title"
        title="Equipo"
        description="Personas con acceso a esta organización y lo que su rol les permite."
      />
      <Callout tone="info" title="Invitaciones y cambios de rol: aún no disponibles">
        <p>
          La API no expone hoy invitar miembros ni cambiar roles desde el panel; por eso no hay
          botones para ello. Los permisos se aplican en el servidor en cada acción.
        </p>
      </Callout>
      <div className="fx-grid">
        <section className="fx-panel" aria-labelledby="members-title">
          <header>
            <h2 id="members-title">Miembros</h2>
          </header>
          <div className="fx-panel-body" style={{ paddingTop: 8 }}>
            {members.kind !== 'ok' ? (
              <ReadProblem kind={members.kind} what="el equipo" />
            ) : (
              <div className="fx-table-wrap">
                <table className="fx-table is-stack">
                  <caption className="sr-only">Miembros de la organización</caption>
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Rol</th>
                      <th scope="col">Miembro desde</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.data.members.map((m) => (
                      <tr key={m.membership_id}>
                        <td data-label="Email">{m.email}</td>
                        <td data-label="Rol">{roleLabel(m.role)}</td>
                        <td data-label="Desde">{dateTime(m.since)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
        <section className="fx-panel" aria-labelledby="matrix-title">
          <header>
            <h2 id="matrix-title">Qué puede hacer cada rol</h2>
          </header>
          <div
            className="fx-panel-body fx-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Matriz de permisos (desplazable)"
          >
            <table className="fx-table fx-matrix">
              <caption className="sr-only">Matriz de permisos por rol</caption>
              <thead>
                <tr>
                  <th scope="col">Capacidad</th>
                  {ROLE_ORDER.map((r) => (
                    <th scope="col" key={r}>
                      {ROLE_LABELS[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CAPABILITIES.map((c) => (
                  <tr key={c.permission}>
                    <th scope="row" style={{ fontWeight: 600, background: 'none' }}>
                      {c.label}
                      <span className="fx-cell-sub">
                        <code>{c.permission}</code>
                      </span>
                    </th>
                    {ROLE_ORDER.map((r) => {
                      const yes = ROLE_PERMISSIONS_MIRROR[r].includes(c.permission);
                      return (
                        <td key={r}>
                          <span aria-hidden="true">{yes ? '✓' : '—'}</span>
                          <span className="sr-only">{yes ? 'Sí' : 'No'}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
