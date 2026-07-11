import { MESSAGES, type Locale } from '../messages';
import type { ApiKey } from './api';

/**
 * Superficie de desarrollador (F6.5B) — API keys, SOLO LECTURA por sesión
 * (`keys:read`). El serializer del API devuelve únicamente metadata
 * (label/prefix/scopes/entorno/estado) — NUNCA el secreto ni su hash. Crear o
 * revocar una key exige `keys:manage` + step-up MFA (re-autenticación reciente),
 * flujo que el dashboard actual no soporta: la vista queda de solo lectura y lo
 * declara. Esta vista jamás renderiza un campo secreto (garantía verificada por
 * tests estructurales que fallan si `secret`/`secret_hash` aparece).
 */

function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '—';
}

export function ApiKeysList({
  keys,
  orgId,
  locale,
  signOutHref,
}: {
  keys: ApiKey[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
}) {
  const t = MESSAGES[locale];
  return (
    <main className="dash" aria-labelledby="keys-title">
      <header className="dash-head">
        <div>
          <h1 id="keys-title">{t.apiKeysTitle}</h1>
          <p className="org">
            <a href={`/o/${orgId}`}>{t.backToDashboard}</a>
          </p>
        </div>
        <a className="signout" href={signOutHref}>
          {t.signOut}
        </a>
      </header>

      <section className="card">
        <p className="hint">{t.apiKeysReadOnlyNote}</p>
        {keys.length === 0 ? (
          <p className="empty">{t.apiKeysEmpty}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t.apiKeysTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.colLabel}</th>
                  <th scope="col">{t.colPrefix}</th>
                  <th scope="col">{t.colScopes}</th>
                  <th scope="col">{t.colEnvironment}</th>
                  <th scope="col">{t.colStatus}</th>
                  <th scope="col">{t.colCreated}</th>
                  <th scope="col">{t.colLastUsed}</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.label}</td>
                    <td>
                      <code>{k.key_prefix}…</code>
                    </td>
                    <td>{k.scopes.join(', ')}</td>
                    <td>{k.environment}</td>
                    <td>
                      {k.revoked_at ? (
                        <span className="badge badge-revoked">{t.keyRevoked}</span>
                      ) : (
                        <span className="badge badge-active">{t.keyActive}</span>
                      )}
                    </td>
                    <td>{when(k.created_at)}</td>
                    <td>{when(k.last_used_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">{t.secretNeverShownNote}</p>
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
