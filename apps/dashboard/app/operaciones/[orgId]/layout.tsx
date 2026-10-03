import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readApi, type SessionInfo } from '../../lib/commerce-api';
import { roleLabel } from '../../lib/ui';
import { OpsShell } from '../lib/ops-shell';
import { OpsAction } from '../lib/ops-action';
import type { Overview, Program } from '../lib/types';
import '../../platform.css';
import '../ops.css';
import '../../lib/rates.css';
import { loadFx } from '../../lib/fx-server';
import { FxProvider } from '../../lib/fx-ui';

export const dynamic = 'force-dynamic';

/**
 * Fluvia Operaciones sobre una organización PROGRAMA. Server-side: sin cookie
 * ⇒ /login; sesión caducada ⇒ pantalla propia; no miembro ⇒ sin acceso; la
 * organización aún no es programa ⇒ alta (con step-up, solo quien pueda).
 */
export default async function OpsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const token = (await cookies()).get('fluvia_session')?.value;
  if (!token) redirect('/login');
  const { orgId } = await params;
  const session = await readApi<SessionInfo>(token, '/v1/auth/session');
  if (session.kind === 'unauthorized') {
    return (
      <main className="ox-gate">
        <h1>Tu sesión caducó</h1>
        <p>Vuelve a iniciar sesión para seguir operando.</p>
        <a className="ox-btn ox-btn-primary" href="/logout">
          Iniciar sesión
        </a>
      </main>
    );
  }
  if (session.kind !== 'ok') {
    return (
      <main className="ox-gate">
        <h1>No pudimos conectar con Fluvia</h1>
        <p>El servicio no respondió. Recarga en unos segundos.</p>
      </main>
    );
  }
  const membership = session.data.memberships.find((m) => m.organization_id === orgId);
  if (!membership) {
    return (
      <main className="ox-gate">
        <h1>Sin acceso</h1>
        <p>Esta organización no existe o no eres miembro.</p>
        <a className="ox-btn ox-btn-primary" href="/">
          Mis organizaciones
        </a>
      </main>
    );
  }
  const r = await readApi<{ program: Program; overview: Overview }>(token, `/v1/programs/${orgId}`);
  if (r.kind === 'forbidden') {
    return (
      <main className="ox-gate">
        <h1>Tu rol no incluye Operaciones</h1>
        <p>
          Pide a una persona con rol de administración que te asigne un rol con permisos del
          programa.
        </p>
      </main>
    );
  }
  if (r.kind === 'unauthorized') redirect('/logout');
  if (r.kind === 'not_found' || r.kind === 'error') {
    return (
      <main className="ox-gate">
        <h1>{membership.organization_name} todavía no es un programa de Fluvia Personal</h1>
        <p>
          Activar el programa crea la política de referencia SINTÉTICA (pendiente de validación
          comercial) y habilita wallet, crédito y tarjetas con proveedores simulados.
        </p>
        <OpsAction
          orgId={orgId}
          path="setup"
          label="Activar programa (sandbox)"
          tone="primary"
          reason={false}
          fields={[
            { name: 'name', label: 'Nombre del programa', defaultValue: 'Fluvia Personal' },
            {
              name: 'currencies',
              label: 'Monedas',
              type: 'select',
              list: true,
              options: [
                { value: 'VES,USD', label: 'Bs y USD' },
                { value: 'VES', label: 'Solo Bs' },
              ],
            },
          ]}
          success="Programa activado."
        />
      </main>
    );
  }
  const { program, overview } = r.data;
  const fx = await loadFx();
  return (
    <FxProvider initialRates={fx.rates} initialDisplay={fx.display}>
      <OpsShell
        orgId={orgId}
        programName={program.name}
        role={roleLabel(membership.role)}
        queues={{
          cases: overview.queues.open_cases,
          reviews: overview.queues.manual_reviews,
          uncertain: overview.queues.uncertain,
        }}
      >
        {children}
      </OpsShell>
    </FxProvider>
  );
}
