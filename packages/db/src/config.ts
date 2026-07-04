/**
 * Cadenas de conexion por rol. Los defaults apuntan a la infra local de
 * docker-compose; en cualquier otro entorno DEBEN venir por variables de
 * entorno.
 *
 *  - admin  -> superusuario: SOLO migraciones y seeding administrativo.
 *  - app    -> fluvia_app: rol de la API, RLS forzado.
 *  - worker -> fluvia_worker: cascaron del proceso worker (solo SELECT 1;
 *              sin privilegios de tabla desde 0009, ADR-0011).
 *  - relay  -> fluvia_relay: rol del outbox relay, privilegio minimo
 *              (SELECT + UPDATE por columna SOLO en outbox_events).
 *  - inbox  -> fluvia_inbox: rol del procesador del inbox, privilegio minimo
 *              (SELECT + UPDATE por columna en provider_events + INSERT DLQ).
 *  - auth   -> fluvia_auth: unico rol con acceso a credenciales/sesiones.
 */
export interface DbUrls {
  admin: string;
  app: string;
  worker: string;
  relay: string;
  inbox: string;
  auth: string;
}

const LOCAL_ENVS = new Set(['development', 'dev', 'test', 'local', '']);

/**
 * AUD-P2-014: los defaults con contrasenas de desarrollo SOLO son validos en
 * entorno local/test. En cualquier otro entorno (NODE_ENV/FLUVIA_ENV) cada
 * URL debe venir explicita; si falta alguna, fallamos ruidosamente en el
 * arranque en vez de conectar con credenciales dev a una base equivocada.
 */
export function dbUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): DbUrls {
  const runtimeEnv = (env.FLUVIA_ENV ?? env.NODE_ENV ?? '').toLowerCase();
  const isLocal = LOCAL_ENVS.has(runtimeEnv);

  const missing: string[] = [];
  const pick = (name: string, value: string | undefined, localDefault: string): string => {
    if (value) return value;
    if (isLocal) return localDefault;
    missing.push(name);
    return '';
  };

  const urls: DbUrls = {
    admin: pick(
      'ADMIN_DATABASE_URL',
      env.ADMIN_DATABASE_URL,
      'postgres://postgres:postgres@127.0.0.1:5432/fluvia'
    ),
    app: pick(
      'APP_DATABASE_URL',
      env.APP_DATABASE_URL,
      'postgres://fluvia_app:fluvia_app_dev_password@127.0.0.1:5432/fluvia'
    ),
    worker: pick(
      'WORKER_DATABASE_URL',
      env.WORKER_DATABASE_URL,
      'postgres://fluvia_worker:fluvia_worker_dev_password@127.0.0.1:5432/fluvia'
    ),
    relay: pick(
      'RELAY_DATABASE_URL',
      env.RELAY_DATABASE_URL,
      'postgres://fluvia_relay:fluvia_relay_dev_password@127.0.0.1:5432/fluvia'
    ),
    inbox: pick(
      'INBOX_DATABASE_URL',
      env.INBOX_DATABASE_URL,
      'postgres://fluvia_inbox:fluvia_inbox_dev_password@127.0.0.1:5432/fluvia'
    ),
    auth: pick(
      'AUTH_DATABASE_URL',
      env.AUTH_DATABASE_URL,
      'postgres://fluvia_auth:fluvia_auth_dev_password@127.0.0.1:5432/fluvia'
    ),
  };

  if (missing.length > 0) {
    throw new Error(
      `FLUVIA_CONFIG: environment "${runtimeEnv}" requires explicit database URLs; missing: ${missing.join(', ')}`
    );
  }

  return urls;
}
