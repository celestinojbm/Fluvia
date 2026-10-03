import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { PersonalShell } from '../lib/shell';
import { personalToken, readPersonal } from '../lib/server';
import type { Me } from '../lib/types';
import { safePersonalNext } from '../lib/next-path';
import { loadFx } from '../../lib/fx-server';
import { FxProvider } from '../../lib/fx-ui';
import '../../platform.css';
import '../personal.css';
import '../personal-app.css';
import '../../lib/rates.css';

export const dynamic = 'force-dynamic';

/**
 * Pantallas autenticadas de Fluvia Personal. Sin cookie ⇒ /personal/entrar;
 * sesión caducada ⇒ pantalla propia (no una lista vacía que parezca «sin
 * datos»); API caída ⇒ aviso de conexión.
 */
export default async function PersonalLayout({ children }: { children: ReactNode }) {
  const here = safePersonalNext((await headers()).get('x-fluvia-personal-path'));
  const entrar = (extra = '') =>
    `/personal/entrar?${extra}${here === '/personal' ? '' : `${extra ? '&' : ''}next=${encodeURIComponent(here)}`}`.replace(
      /\?$/,
      ''
    );
  if (!(await personalToken())) redirect(entrar());
  const me = await readPersonal<Me>('/me');
  if (me.kind === 'unauthorized') {
    return (
      <main className="px-gate" aria-labelledby="px-expired">
        <h1 id="px-expired">Tu sesión caducó</h1>
        <p>Por seguridad cerramos las sesiones inactivas. Entra de nuevo para continuar.</p>
        <p>
          <a className="px-btn px-btn-primary" href={entrar('expirada=1')}>
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
  const fx = await loadFx();
  return (
    <FxProvider initialRates={fx.rates} initialDisplay={fx.display}>
      <PersonalShell name={me.data.consumer.display_name}>{children}</PersonalShell>
    </FxProvider>
  );
}
