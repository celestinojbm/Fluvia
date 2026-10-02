#!/usr/bin/env bash
# Demo LOCAL y PRIVADA de Fluvia (código real + MockProvider + cuotas simuladas).
#
# Pensado para la máquina del propietario y para abrirse en ESA máquina: todo
# escucha SOLO en 127.0.0.1. No publica puertos en la LAN, no abre túneles (ni
# Funnel), no toca servicios existentes del HomeLab y no gasta nada. Datos:
# seed de demo determinista (sintético).
#
# Requisitos: bash, Node >= 20, pnpm 10, Docker, curl.
#
# Uso (desde la raíz del checkout de la instancia):
#   scripts/demo/start-local-demo.sh            # instancia por defecto
#   DEMO_PREFIX=fluvia-demo2 DEMO_PORT_BASE=3310 DEMO_PG_PORT=55433 \
#     DEMO_REDIS_PORT=56380 scripts/demo/start-local-demo.sh   # segunda instancia
#
# Parametrización (ver scripts/demo/lib.sh): DEMO_PREFIX (contenedores,
# volumen, estado, PID y logs), DEMO_PORT_BASE o DEMO_API_PORT /
# DEMO_CHECKOUT_PORT / DEMO_DASHBOARD_PORT, DEMO_PG_PORT, DEMO_REDIS_PORT,
# DEMO_DASHBOARD_ORIGIN, DEMO_CHECKOUT_ORIGIN. Los defectos son los de siempre
# (fluvia-demo-*, 3300-3302, 55432/56379, .demo/), compatibles con la demo
# que ya esté en marcha.
#
# Seguridad: no arranca si la instancia ya está en marcha, si un puerto está
# ocupado, si un contenedor/volumen con su nombre pertenece a otra instancia,
# o si una instancia no por defecto pide los puertos de la demo por defecto.
# DEMO_PRINT_CONFIG=1 solo imprime la configuración resuelta y sale.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
demo_config

if [ "${DEMO_PRINT_CONFIG:-0}" = 1 ]; then
  demo_print_config
  exit 0
fi

need() { command -v "$1" >/dev/null || die "Falta $1"; }
need node; need pnpm; need docker; need curl

demo_guard_default_ports
echo "==> Instancia"
demo_print_config | sed 's/^/   /'

# Recursos con el nombre de esta instancia que pertenezcan a otra: no se tocan.
if [ -d "$STATE" ]; then
  verify_instance || die "el estado/recursos de '$PREFIX' no pertenecen a $ROOT; no se arranca nada"
  [ -z "$(live_pids)" ] || die "la instancia '$PREFIX' ya está en marcha (PIDs en $STATE); párala antes"
else
  for c in "$PG_CONTAINER" "$REDIS_CONTAINER"; do
    container_exists "$c" && { owns_resource container "$c" || die "el contenedor $c pertenece a otra instancia"; }
  done
  volume_exists "$VOLUME" && { owns_resource volume "$VOLUME" || die "el volumen $VOLUME pertenece a otra instancia"; }
fi

for p in "$API_PORT" "$CHECKOUT_PORT" "$DASHBOARD_PORT"; do
  port_busy "$p" && die "el puerto $p ya está en uso (¿otra demo u otro servicio?)"
done
container_exists "$PG_CONTAINER" || { port_busy "$PG_PORT" && die "el puerto $PG_PORT ya está en uso"; }
container_exists "$REDIS_CONTAINER" || { port_busy "$REDIS_PORT" && die "el puerto $REDIS_PORT ya está en uso"; }

mkdir -p "$STATE"
printf 'prefix=%s\nroot=%s\n' "$PREFIX" "$ROOT" >"$MARKER"
LABELS=(--label "fluvia.demo.prefix=$PREFIX" --label "fluvia.demo.root=$ROOT")

echo "==> PostgreSQL 16 y Redis 7 en contenedores propios ($PREFIX-*), solo en $H"
volume_exists "$VOLUME" || docker volume create "${LABELS[@]}" "$VOLUME" >/dev/null
container_exists "$PG_CONTAINER" ||
  docker run -d --name "$PG_CONTAINER" "${LABELS[@]}" -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fluvia -p "$H:$PG_PORT:5432" \
    -v "$VOLUME":/var/lib/postgresql/data postgres:16 >/dev/null
container_exists "$REDIS_CONTAINER" ||
  docker run -d --name "$REDIS_CONTAINER" "${LABELS[@]}" -p "$H:$REDIS_PORT:6379" redis:7 >/dev/null
docker start "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null
# Un contenedor reutilizado conserva su puerto: debe coincidir con el pedido.
docker port "$PG_CONTAINER" 5432/tcp | grep -q ":$PG_PORT\$" ||
  die "$PG_CONTAINER publica $(docker port "$PG_CONTAINER" 5432/tcp | head -1), no $H:$PG_PORT"
docker port "$REDIS_CONTAINER" 6379/tcp | grep -q ":$REDIS_PORT\$" ||
  die "$REDIS_CONTAINER publica $(docker port "$REDIS_CONTAINER" 6379/tcp | head -1), no $H:$REDIS_PORT"
for _ in $(seq 1 60); do
  docker exec "$PG_CONTAINER" pg_isready -U postgres -d fluvia >/dev/null 2>&1 && break
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
# Jornada integral: organización PROGRAMA de Fluvia Personal sembrada por el
# seed (id determinista). La API la usa para enrutar los códigos `fcp_` de los
# checkouts y el dashboard para las pantalla /personal.
export FLUVIA_PROGRAM_TENANT_ID=e744e6eb-95cf-5762-95a7-268a0917e747
# Asistente: adjuntos en un directorio PRIVADO de esta instancia (API y
# worker comparten el mismo). Proveedores simulados salvo que se exporten las
# variables ASSISTANT_* / ANTHROPIC_* / SPEECH_* / LIVEKIT_* (ver
# docs/product/presentacion-asistente/ASISTENTE.md).
export ASSISTANT_STORAGE_DIR="$STATE/assistant"
mkdir -p "$ASSISTANT_STORAGE_DIR" && chmod 700 "$ASSISTANT_STORAGE_DIR"

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
  (cd "$ROOT/$dir" && setsid bash -c 'echo $$ >"$0"; exec "$@"' "$STATE/$name.pid" "$@" \
    >"$STATE/$name.log" 2>&1 </dev/null &)
}
start api apps/api env HOST=$H PORT="$API_PORT" CHECKOUT_BASE_URL="$CHECKOUT_ORIGIN" \
  npx tsx src/server.ts
start checkout apps/checkout env FLUVIA_API_URL="http://$H:$API_PORT" \
  npx next start -H $H -p "$CHECKOUT_PORT"
start dashboard apps/dashboard env FLUVIA_API_URL="http://$H:$API_PORT" \
  FLUVIA_DASHBOARD_ORIGIN="$DASHBOARD_ORIGIN" npx next start -H $H -p "$DASHBOARD_PORT"

# Worker OPCIONAL y aislado (retención del asistente, resoluciones y
# vigilancias): misma BD y Redis de la instancia, métricas en su propio puerto.
if [ "${DEMO_WITH_WORKER:-0}" = 1 ]; then
  echo "==> Arrancando worker (DEMO_WITH_WORKER=1, métricas en $H:$WORKER_METRICS_PORT)"
  start worker apps/worker env WORKER_METRICS_HOST=$H WORKER_METRICS_PORT="$WORKER_METRICS_PORT" \
    npx tsx src/main.ts
fi

for url in "http://$H:$API_PORT/health" "http://$H:$CHECKOUT_PORT" "http://$H:$DASHBOARD_PORT/login"; do
  for _ in $(seq 1 90); do curl -s -o /dev/null "$url" && break; sleep 1; done
  curl -s -o /dev/null -w "   $url -> %{http_code}\n" "$url"
done

PFX=""
[ "$IS_DEFAULT" = 1 ] || PFX="DEMO_PREFIX=$PREFIX "
cat <<EOF

Demo «$PREFIX» lista (privada: solo accesible desde ESTA máquina)
  Abrir:        $DASHBOARD_ORIGIN/login     (usa 127.0.0.1, no «localhost»:
                la protección CSRF compara el origen exacto)
  Usuario:      owner@demo.fluvia.test / demo-owner-password   (credenciales de DEMO)
  Personal:     $DASHBOARD_ORIGIN/personal/entrar   (cliente@demo.fluvia.test / demo-cliente-password)
  Operaciones:  $DASHBOARD_ORIGIN/operaciones/e744e6eb-95cf-5762-95a7-268a0917e747
                (owner@demo.fluvia.test o ops@demo.fluvia.test / demo-ops-password)
  Recorrido:    Inicio → Nueva venta (catálogo, carrito, cliente) → Revisar →
                Confirmar → Cobrar ahora → Abrir checkout → pagar (tarjeta de
                prueba o «Pagar en cuotas», simulación) → Ventas → Ver justificante

Saldo de DEMO: el seed deja 300.000 COP «disponibles» en el comercio Demo Store
(releaseSettlement local). Es saldo sembrado para poder demostrar devoluciones,
NO una liquidación de producto: ningún camino del producto libera fondos.

Parar (CONSERVA los datos):   ${PFX}scripts/demo/stop-local-demo.sh
Borrar los datos (aparte):    ${PFX}scripts/demo/purge-local-demo.sh --yes-delete-data
EOF
