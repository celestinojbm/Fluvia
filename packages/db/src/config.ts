/**
 * Cadenas de conexion por rol. Los defaults apuntan a la infra local de
 * docker-compose; en cualquier otro entorno DEBEN venir por variables de
 * entorno.
 *
 *  - admin  -> superusuario: SOLO migraciones y seeding administrativo.
 *  - app    -> fluvia_app: rol de la API, RLS forzado.
 *  - worker -> fluvia_worker: rol del relay del outbox, BYPASSRLS.
 */
export interface DbUrls {
  admin: string;
  app: string;
  worker: string;
}

export function dbUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): DbUrls {
  return {
    admin:
      env.ADMIN_DATABASE_URL ??
      'postgres://postgres:postgres@127.0.0.1:5432/fluvia',
    app:
      env.APP_DATABASE_URL ??
      'postgres://fluvia_app:fluvia_app_dev_password@127.0.0.1:5432/fluvia',
    worker:
      env.WORKER_DATABASE_URL ??
      'postgres://fluvia_worker:fluvia_worker_dev_password@127.0.0.1:5432/fluvia',
  };
}
