import { apiBase, fetchMerchants } from '../../../lib/api';
import { orgContext } from '../../../lib/org-context';
import { orgPath, readApi } from '../../../lib/commerce-api';
import { Callout, PageHead, ShortId, Status, dateTime } from '../../../lib/ui';

export const dynamic = 'force-dynamic';

const METHODS: Array<{
  name: string;
  status: string;
  tone: 'ok' | 'warn' | 'sim' | 'neutral';
  detail: string;
}> = [
  {
    name: 'Tarjeta de prueba',
    status: 'Activo · sandbox',
    tone: 'ok',
    detail: 'Proveedor simulado (MockProvider): aprobada o rechazada según la tarjeta de prueba.',
  },
  {
    name: 'Transferencia de prueba (asíncrona)',
    status: 'Activo · sandbox',
    tone: 'warn',
    detail:
      'Queda «en proceso» hasta una confirmación verificada del proveedor simulado; sin ella el cobro no se da por hecho.',
  },
  {
    name: 'Pagar en cuotas',
    status: 'Simulación',
    tone: 'sim',
    detail:
      'Experiencia de demostración: sin financiador, crédito ni cobro real. No marca la venta como pagada.',
  },
  {
    name: 'Métodos reales (tarjetas, transferencias, pago móvil…)',
    status: 'No conectados',
    tone: 'neutral',
    detail: 'Bloqueado hasta superar los production gates y decidir mercado y proveedor.',
  },
];

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { token } = await orgContext(orgId);
  const [org, merchants] = await Promise.all([
    readApi<{ id?: string; name?: string; slug?: string; created_at?: string }>(
      token,
      orgPath(orgId, '')
    ),
    fetchMerchants({ apiBase: apiBase(), token, orgId }),
  ]);
  return (
    <main className="fx-page" aria-labelledby="set-title">
      <PageHead
        id="set-title"
        title="Configuración"
        description="Datos del comercio y estado real de los métodos de pago."
      />
      <div className="fx-grid fx-grid-2">
        <section className="fx-panel" aria-labelledby="org-title">
          <header>
            <h2 id="org-title">Organización</h2>
          </header>
          <div className="fx-panel-body">
            {org.kind === 'ok' ? (
              <dl className="fx-dl">
                <dt>Nombre</dt>
                <dd>{org.data.name ?? '—'}</dd>
                <dt>Identificador</dt>
                <dd>
                  <ShortId id={orgId} />
                </dd>
                {org.data.created_at ? (
                  <>
                    <dt>Creada</dt>
                    <dd>{dateTime(org.data.created_at)}</dd>
                  </>
                ) : null}
                <dt>Entorno</dt>
                <dd>
                  <Status tone="warn">Sandbox · dinero simulado</Status>
                </dd>
              </dl>
            ) : (
              <p className="fx-hint">No pudimos leer los datos de la organización.</p>
            )}
          </div>
        </section>
        <section className="fx-panel" aria-labelledby="mer-title">
          <header>
            <h2 id="mer-title">Comercios</h2>
            <a className="fx-link" href={`/o/${orgId}/merchants`}>
              Ver comercios
            </a>
          </header>
          <div className="fx-panel-body" style={{ paddingTop: 8 }}>
            <table className="fx-table is-stack">
              <caption className="sr-only">Comercios de la organización</caption>
              <thead>
                <tr>
                  <th scope="col">Comercio</th>
                  <th scope="col">País</th>
                  <th scope="col">Moneda</th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {merchants.map((m) => (
                  <tr key={m.id}>
                    <td data-label="Comercio">{m.name}</td>
                    <td data-label="País">{m.country}</td>
                    <td data-label="Moneda">{m.defaultCurrency}</td>
                    <td data-label="Estado">
                      <Status tone={m.status === 'active' ? 'ok' : 'warn'} code={m.status}>
                        {m.status === 'active' ? 'Activo' : 'Congelado'}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <section className="fx-panel" aria-labelledby="pm-title" style={{ marginTop: 16 }}>
        <header>
          <h2 id="pm-title">Métodos de pago</h2>
        </header>
        <div className="fx-panel-body" style={{ paddingTop: 8 }}>
          <table className="fx-table is-stack">
            <caption className="sr-only">Estado real de los métodos de pago</caption>
            <thead>
              <tr>
                <th scope="col">Método</th>
                <th scope="col">Estado</th>
                <th scope="col">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {METHODS.map((m) => (
                <tr key={m.name}>
                  <td data-label="Método" className="fx-cell-main">
                    {m.name}
                  </td>
                  <td data-label="Estado">
                    <Status tone={m.tone}>{m.status}</Status>
                  </td>
                  <td data-label="Detalle">{m.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Callout tone="info" title="Mercado, moneda e impuestos">
        <p>
          La dirección de producto apunta a Venezuela, pero no se cambió ningún contrato: el país
          del onboarding, el formato y las monedas siguen el registro actual (VES aún no está en
          él), no se calculan impuestos y el exponente de COP sigue abierto. Son decisiones
          pendientes (PEND-007, PEND-008), no configuraciones de esta pantalla.
        </p>
      </Callout>
    </main>
  );
}
