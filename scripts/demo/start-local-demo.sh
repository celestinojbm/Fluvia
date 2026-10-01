#!/usr/bin/env bash
# Demo LOCAL y PRIVADA del POS sandbox de Fluvia (código real + MockProvider).
#
# Pensado para correr en la máquina del propietario (p. ej. la MSI) y abrirse
# en ESA misma máquina: todo escucha SOLO en 127.0.0.1. No publica puertos en
# la LAN, no abre túneles (ni Funnel), no toca servicios existentes del
# HomeLab y no gasta nada. Datos: seed de demo determinista (sintético).
#
# Requisitos: bash, Node >= 20, pnpm 10, Docker (para PG 16 + Redis 7 en
# contenedores propios `fluvia-demo-*`). Reversible: scripts/demo/stop-local-demo.sh
#
# Uso (desde la raíz del repo):
#   scripts/demo/start-local-demo.sh
# Variables opcionales (por si algún puerto ya está ocupado):
#   DEMO_PG_PORT=55432 DEMO_REDIS_PORT=56379 DEMO_API_PORT=3300
#   DEMO_CHECKOUT_PORT=3301 DEMO_DASHBOARD_PORT=3302
#   DEMO_NAME=fluvia-demo   prefijo de contenedores, volumen y estado. Con otro
#                           nombre (y otros puertos) corre una SEGUNDA demo
#                           aislada sin tocar la primera (otra BD, otro estado).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${DEMO_NAME:-fluvia-demo}"
case "$NAME" in *[!a-z0-9-]*|'') echo "DEMO_NAME inválido: $NAME" >&2; exit 1;; esac
STATE="$ROOT/.demo"
[ "$NAME" = fluvia-demo ] || STATE="$ROOT/.demo-$NAME"
PG_PORT="${DEMO_PG_PORT:-55432}"
REDIS_PORT="${DEMO_REDIS_PORT:-56379}"
API_PORT="${DEMO_API_PORT:-3300}"
CHECKOUT_PORT="${DEMO_CHECKOUT_PORT:-3301}"
DASHBOARD_PORT="${DEMO_DASHBOARD_PORT:-3302}"
H=127.0.0.1

need() { command -v "$1" >/dev/null || { echo "Falta $1" >&2; exit 1; }; }
need node; need pnpm; need docker; need curl
mkdir -p "$STATE"

echo "==> PostgreSQL 16 y Redis 7 en contenedores propios ($NAME-*), solo en $H"
docker volume create "$NAME-pgdata" >/dev/null
docker inspect "$NAME-pg" >/dev/null 2>&1 ||
  docker run -d --name "$NAME-pg" -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=fluvia -p "$H:$PG_PORT:5432" -v "$NAME-pgdata":/var/lib/postgresql/data \
    postgres:16 >/dev/null
docker inspect "$NAME-redis" >/dev/null 2>&1 ||
  docker run -d --name "$NAME-redis" -p "$H:$REDIS_PORT:6379" redis:7 >/dev/null
docker start "$NAME-pg" "$NAME-redis" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME-pg" pg_isready -U postgres -d fluvia >/dev/null 2>&1 && break
  sleep 1
done

# Credenciales de rol de DESARROLLO (las de docker-compose.yml / migración 0002):
# solo sirven dentro de este contenedor local.
pg() { echo "postgres://$1@$H:$PG_PORT/fluvia"; }
export NODE_ENV=local NEXT_TELEMETRY_DISABLED=1
export ADMIN_DATABASE_URL="$(pg postgres:postgres)"
export APP_DATABASE_URL="$(pg fluvia_app:fluvia_app_dev_password)"
export WORKER_DATABASE_URL="$(pg fluvia_worker:fluvia_worker_dev_password)"
export RELAY_DATABASE_URL="$(pg fluvia_relay:fluvia_relay_dev_password)"
export AUTH_DATABASE_URL="$(pg fluvia_auth:fluvia_auth_dev_password)"
export INBOX_DATABASE_URL="$(pg fluvia_inbox:fluvia_inbox_dev_password)"
export WEBHOOK_DATABASE_URL="$(pg fluvia_webhook:fluvia_webhook_dev_password)"
export REDIS_URL="redis://$H:$REDIS_PORT"

cd "$ROOT"
echo "==> Dependencias, migraciones y seed de demo (idempotentes)"
pnpm install --frozen-lockfile >"$STATE/install.log" 2>&1
pnpm migrate >"$STATE/migrate.log" 2>&1
pnpm seed | tee "$STATE/seed.log"

echo "==> Build de checkout y dashboard (next build)"
(cd apps/checkout && npx next build >"$STATE/build-checkout.log" 2>&1)
(cd apps/dashboard && npx next build >"$STATE/build-dashboard.log" 2>&1)

echo "==> Arrancando API, checkout y dashboard (solo $H)"
start() { # nombre, dir, comando...
  # setsid ⇒ sesión y grupo propios; el pid guardado ES el líder del grupo
  # (stop-local-demo.sh para el grupo entero). Sin heredar la terminal.
  local name="$1" dir="$2"; shift 2
  (cd "$dir" && setsid bash -c 'echo $$ >"$0"; exec "$@"' "$STATE/$name.pid" "$@" \
    >"$STATE/$name.log" 2>&1 </dev/null &)
}
start api apps/api env HOST=$H PORT="$API_PORT" CHECKOUT_BASE_URL="http://$H:$CHECKOUT_PORT" \
  npx tsx src/server.ts
start checkout apps/checkout env FLUVIA_API_URL="http://$H:$API_PORT" \
  npx next start -H $H -p "$CHECKOUT_PORT"
start dashboard apps/dashboard env FLUVIA_API_URL="http://$H:$API_PORT" \
  FLUVIA_DASHBOARD_ORIGIN="http://$H:$DASHBOARD_PORT" npx next start -H $H -p "$DASHBOARD_PORT"

for url in "http://$H:$API_PORT/health" "http://$H:$CHECKOUT_PORT" "http://$H:$DASHBOARD_PORT/login"; do
  for _ in $(seq 1 90); do curl -s -o /dev/null "$url" && break; sleep 1; done
  curl -s -o /dev/null -w "   $url -> %{http_code}\n" "$url"
done

cat <<EOF

Demo lista (privada: solo accesible desde ESTA máquina)
  Abrir:        http://$H:$DASHBOARD_PORT/login     (usa 127.0.0.1, no «localhost»:
                la protección CSRF compara el origen exacto)
  Usuario:      owner@demo.fluvia.test / demo-owner-password   (credenciales de DEMO)
  Recorrido:    Inicio → Nueva venta (catálogo, carrito, cliente) → Revisar →
                Confirmar → Cobrar ahora → Abrir checkout → pagar (tarjeta de
                prueba o «Pagar en cuotas», simulación) → Ventas → Ver justificante

Saldo de DEMO: el seed deja 300.000 COP «disponibles» en el comercio Demo Store
(releaseSettlement local). Es saldo sembrado para poder demostrar devoluciones,
NO una liquidación de producto: ningún camino del producto libera fondos. Cuando
se agote, las devoluciones terminan «Cancelada · sin saldo», que es el
comportamiento real documentado.

Parar y borrar todo:  DEMO_NAME=$NAME scripts/demo/stop-local-demo.sh
EOF
