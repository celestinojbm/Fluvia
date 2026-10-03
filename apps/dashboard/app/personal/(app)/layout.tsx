import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { PersonalShell } from '../lib/shell';
import { personalToken, readPersonal } from '../lib/server';
import type { Me } from '../lib/types';
import '../../platform.css';
import '../personal.css';
import '../personal-app.css';

export const dynamic = 'force-dynamic';

/**
 * Pantallas autenticadas de Fluvia Personal. Sin cookie ⇒ /personal/entrar;
 * sesión caducada ⇒ pantalla propia (no una lista vacía que parezca «sin
 * datos»); API caída ⇒ aviso de conexión.
 */
export default async function PersonalLayout({ children }: { children: ReactNode }) {
  if (!(await personalToken())) redirect('/personal/entrar');
  const me = await readPersonal<Me>('/me');
  if (me.kind === 'unauthorized') {
    return (
      <main className="px-gate" aria-labelledby="px-expired">
        <h1 id="px-expired">Tu sesión caducó</h1>
        <p>Por seguridad cerramos las sesiones inactivas. Entra de nuevo para continuar.</p>
        <p>
          <a className="px-btn px-btn-primary" href="/personal/entrar?expirada=1">
            Entrar de nuevo
          </a>
        </p>
      </main>
    );
  }
  if (me.kind !== 'ok') {
    return (
      <main className="px-gate" aria-labelledby="px-down">
        <h1 id="px-down">No pudimos conectar con Fluvia</h1>
        <p>
          El servicio no respondió. Tu dinero no se movió: vuelve a intentarlo en unos segundos.
        </p>
        <p>
          <a className="px-btn px-btn-primary" href="/personal">
            Reintentar
          </a>
        </p>
      </main>
    );
  }
  return <PersonalShell name={me.data.consumer.display_name}>{children}</PersonalShell>;
}
