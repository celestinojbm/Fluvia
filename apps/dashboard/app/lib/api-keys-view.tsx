import { MESSAGES, type Locale } from '../messages';
import type { ApiKey } from './api';
import { CreateApiKeyForm, RevokeKeyButton } from './api-key-actions';

/**
 * Superficie de desarrollador (F6.5B + F6.5B2) — API keys. Lectura por sesión
 * (`keys:read`): el serializer del API devuelve solo metadata — NUNCA el secreto
 * ni su hash. Crear/revocar (F6.5B2) existe ahora también por sesión
 * (`keys:manage` + step-up MFA); los controles solo se muestran a esos roles
 * (hint UX — el API es la fuente de verdad). El secreto de una key creada se
 * revela UNA vez (SecretRevealOnce). Esta vista jamás renderiza un campo secreto
 * persistido (garantía verificada por tests estructurales).
 */

function when(v: string | null): string {
  return v ? v.replace('T', ' ').slice(0, 16) : '—';
}

export function ApiKeysList({
  keys,
  orgId,
  locale,
  signOutHref,
  canManage = false,
}: {
  keys: ApiKey[];
  orgId: string;
  locale: Locale;
  signOutHref: string;
  /** El operador puede crear/revocar keys (rol con keys:manage). */
  canManage?: boolean;
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
        {!canManage && <p className="hint">{t.apiKeysReadOnlyNote}</p>}
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
                  {canManage && <th scope="col">{t.colAction}</th>}
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
                    {canManage && (
                      <td>
                        {k.revoked_at ? (
                          <span>—</span>
                        ) : (
                          <RevokeKeyButton orgId={orgId} keyId={k.id} locale={locale} />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canManage ? (
          <CreateApiKeyForm orgId={orgId} locale={locale} />
        ) : (
          <p className="hint">{t.keysManageNoRole}</p>
        )}
        <p className="hint">{t.secretNeverShownNote}</p>
      </section>
      <p className="notice">{t.sandboxNotice}</p>
    </main>
  );
}
