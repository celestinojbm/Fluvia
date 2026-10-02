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
#
# Llamada por WebRTC (opcional, DEMO_WITH_CALL=1): servidor LiveKit en un
# contenedor propio ($PREFIX-livekit, solo 127.0.0.1) y agente de voz de
# PRUEBA (o con voz real si se exportan ASSISTANT_SPEECH_PROVIDER y SPEECH_*).
# Las claves de LiveKit y del agente se generan una vez por instancia en
# $STATE/call (0700) y llegan a los procesos por el entorno, no por la línea
# de órdenes.
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
  for c in "$PG_CONTAINER" "$REDIS_CONTAINER" "$LK_CONTAINER"; do
    container_exists "$c" && { owns_resource container "$c" || die "el contenedor $c pertenece a otra instancia"; }
  done
  volume_exists "$VOLUME" && { owns_resource volume "$VOLUME" || die "el volumen $VOLUME pertenece a otra instancia"; }
fi

# `next build` reescribe apps/*/.next de ESTE checkout: si otro proceso de
# Next sirve desde aquí (otra instancia del mismo checkout), el build lo
# rompería. Cada instancia necesita su propio checkout (p. ej. git worktree).
for app in checkout dashboard; do
  for d in /proc/[0-9]*; do
    [ "$(readlink "$d/cwd" 2>/dev/null)" = "$ROOT/apps/$app" ] || continue
    grep -qa next "$d/cmdline" 2>/dev/null || continue
    die "el proceso ${d#/proc/} ya sirve apps/$app desde $ROOT; usa un checkout propio para esta instancia (git worktree add …)"
  done
done

# TODOS los puertos se comprueban ANTES de crear ningún recurso.
APP_PORTS=("$API_PORT" "$CHECKOUT_PORT" "$DASHBOARD_PORT")
[ "${DEMO_WITH_WORKER:-0}" = 1 ] && APP_PORTS+=("$WORKER_METRICS_PORT")
for p in "${APP_PORTS[@]}"; do
  port_busy "$p" && die "el puerto $p ya está en uso (¿otra demo u otro servicio?)"
done
# Un contenedor PROPIO en marcha ocupa su puerto; si no está en marcha, el
# puerto tiene que estar libre.
container_running "$PG_CONTAINER" || { port_busy "$PG_PORT" && die "el puerto $PG_PORT (PostgreSQL) ya está en uso"; }
container_running "$REDIS_CONTAINER" || { port_busy "$REDIS_PORT" && die "el puerto $REDIS_PORT (Redis) ya está en uso"; }
if [ "$WITH_CALL" = 1 ]; then
  port_busy "$AGENT_PORT" && die "el puerto $AGENT_PORT (agente de voz) ya está en uso"
  # Si el contenedor de esta instancia está en marcha, los puertos son suyos.
  if ! docker ps -q --filter "name=^${LK_CONTAINER}\$" | grep -q .; then
    for p in "$LIVEKIT_PORT" "$LIVEKIT_TCP_PORT"; do
      port_busy "$p" && die "el puerto $p (LiveKit) ya está en uso"
    done
    udp_busy "$LIVEKIT_UDP_PORT" && die "el puerto UDP $LIVEKIT_UDP_PORT (LiveKit) ya está en uso"
  fi
fi

mkdir -p "$STATE"
printf 'prefix=%s\nroot=%s\n' "$PREFIX" "$ROOT" >"$MARKER"
LABELS=(--label "fluvia.demo.prefix=$PREFIX" --label "fluvia.demo.root=$ROOT")

# ---- Limpieza de un arranque FALLIDO -----------------------------------------
# Solo lo creado o arrancado en ESTE intento: procesos propios (verificados),
# contenedores creados ahora (se eliminan; el VOLUMEN se conserva siempre) y
# contenedores que estaban parados y se arrancaron ahora (se vuelven a parar).
CREATED_CONTAINERS=()
STARTED_CONTAINERS=()
STARTED_SERVICES=()
STARTUP_OK=0
cleanup_failed_start() {
  local code=$? svc pid
  [ "$STARTUP_OK" = 1 ] && return
  [ "$code" = 0 ] && code=1
  echo "==> Arranque fallido (código $code): limpiando SOLO lo de este intento" >&2
  for svc in "${STARTED_SERVICES[@]}"; do
    pid="$(cat "$STATE/$svc.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && owns_pid "$svc" "$pid"; then
      kill -- "-$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do pid_alive "$pid" || break; sleep 0.5; done
      pid_alive "$pid" && kill -KILL -- "-$pid" 2>/dev/null
      echo "   $svc: parado" >&2
    fi
    pid_alive "${pid:-0}" || rm -f "$STATE/$svc.pid" "$STATE/$svc.proc"
  done
  for c in "${CREATED_CONTAINERS[@]}"; do
    docker rm -f -v "$c" >/dev/null 2>&1 && echo "   $c: eliminado (creado en este intento)" >&2
  done
  for c in "${STARTED_CONTAINERS[@]}"; do
    docker stop "$c" >/dev/null 2>&1 && echo "   $c: detenido (estaba parado antes)" >&2
  done
  echo "   Datos conservados (volumen $VOLUME). Logs: $STATE" >&2
  exit "$code"
}
trap cleanup_failed_start EXIT
make_container() { # nombre, args de docker run...
  local name="$1"; shift
  if container_exists "$name"; then
    container_running "$name" || { docker start "$name" >/dev/null && STARTED_CONTAINERS+=("$name"); }
  else
    docker run -d --name "$name" "${LABELS[@]}" "$@" >/dev/null
    CREATED_CONTAINERS+=("$name")
  fi
}

echo "==> PostgreSQL 16 y Redis 7 en contenedores propios ($PREFIX-*), solo en $H"
volume_exists "$VOLUME" || docker volume create "${LABELS[@]}" "$VOLUME" >/dev/null
make_container "$PG_CONTAINER" -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fluvia -p "$H:$PG_PORT:5432" \
  -v "$VOLUME":/var/lib/postgresql/data postgres:16
make_container "$REDIS_CONTAINER" -p "$H:$REDIS_PORT:6379" redis:7
# Un contenedor reutilizado conserva su puerto: debe coincidir con el pedido.
docker port "$PG_CONTAINER" 5432/tcp | grep -q ":$PG_PORT\$" ||
  die "$PG_CONTAINER publica $(docker port "$PG_CONTAINER" 5432/tcp | head -1), no $H:$PG_PORT"
docker port "$REDIS_CONTAINER" 6379/tcp | grep -q ":$REDIS_PORT\$" ||
  die "$REDIS_CONTAINER publica $(docker port "$REDIS_CONTAINER" 6379/tcp | head -1), no $H:$REDIS_PORT"
pg_ready=0
for _ in $(seq 1 60); do
  docker exec "$PG_CONTAINER" pg_isready -U postgres -d fluvia >/dev/null 2>&1 && { pg_ready=1; break; }
  sleep 1
done
[ "$pg_ready" = 1 ] || die "PostgreSQL ($PG_CONTAINER) no respondió en 60 s; ver: docker logs $PG_CONTAINER"
# pg_isready responde durante el arranque inicial del contenedor (initdb);
# una consulta real confirma que la base «fluvia» acepta conexiones.
for _ in $(seq 1 30); do
  docker exec "$PG_CONTAINER" psql -U postgres -d fluvia -Atc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done

if [ "$WITH_CALL" = 1 ]; then
  echo "==> Servidor de llamadas LiveKit ($LK_CONTAINER, solo $H)"
  mkdir -p "$CALL_DIR" && chmod 700 "$CALL_DIR"
  if [ ! -f "$CALL_DIR/secrets.env" ]; then
    rnd() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
    umask 077
    printf 'LIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\nASSISTANT_AGENT_SECRET=%s\n' \
      "$PREFIX" "$(rnd)" "$(rnd)" >"$CALL_DIR/secrets.env"
    umask 022
  fi
  # shellcheck disable=SC1091
  . "$CALL_DIR/secrets.env"
  # Mismo puerto dentro y fuera: el servidor anuncia $H:<puerto> en ICE.
  cat >"$CALL_DIR/livekit.yaml" <<YAML
port: $LIVEKIT_PORT
bind_addresses: ['0.0.0.0']
rtc:
  tcp_port: $LIVEKIT_TCP_PORT
  udp_port: $LIVEKIT_UDP_PORT
  use_external_ip: false
  node_ip: $H
keys:
  $LIVEKIT_API_KEY: $LIVEKIT_API_SECRET
room:
  empty_timeout: 60
  max_participants: 4
logging:
  level: info
YAML
  # El directorio es 0700; el archivo debe poder leerlo el usuario del contenedor.
  chmod 644 "$CALL_DIR/livekit.yaml"
  make_container "$LK_CONTAINER" \
    -p "$H:$LIVEKIT_PORT:$LIVEKIT_PORT" -p "$H:$LIVEKIT_TCP_PORT:$LIVEKIT_TCP_PORT" \
    -p "$H:$LIVEKIT_UDP_PORT:$LIVEKIT_UDP_PORT/udp" \
    -v "$CALL_DIR/livekit.yaml:/etc/livekit.yaml:ro" \
    "$LK_IMAGE" --config /etc/livekit.yaml
  docker port "$LK_CONTAINER" "$LIVEKIT_PORT/tcp" | grep -q ":$LIVEKIT_PORT\$" ||
    die "$LK_CONTAINER no publica $H:$LIVEKIT_PORT (¿contenedor de una configuración anterior?)"
  for _ in $(seq 1 30); do curl -s -o /dev/null "http://$H:$LIVEKIT_PORT" && break; sleep 1; done
fi

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
pnpm install --frozen-lockfile >"$STATE/install.log" 2>&1 ||
  die "pnpm install falló; ver $STATE/install.log"
pnpm migrate >"$STATE/migrate.log" 2>&1 || die "las migraciones fallaron; ver $STATE/migrate.log"
pnpm seed >"$STATE/seed.log" 2>&1 || die "el seed falló; ver $STATE/seed.log"
sed 's/^/   /' "$STATE/seed.log"
# Postcondiciones del seed (no basta con que el comando termine): comercio
# de demo con su dueño verificado y programa de Personal con su cliente.
seed_ok="$(cat <<'SQL' | docker exec -i "$PG_CONTAINER" psql -U postgres -d fluvia -Atq -v prog="$FLUVIA_PROGRAM_TENANT_ID" 2>&1
SELECT concat_ws(',',
  CASE WHEN NOT EXISTS (SELECT 1 FROM organizations WHERE slug = 'demo-fluvia') THEN 'organización Demo Fluvia' END,
  CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE email = 'owner@demo.fluvia.test' AND email_verified_at IS NOT NULL) THEN 'owner@demo.fluvia.test' END,
  CASE WHEN NOT EXISTS (SELECT 1 FROM organizations WHERE id = :'prog') THEN 'programa de Personal' END,
  CASE WHEN NOT EXISTS (SELECT 1 FROM consumers WHERE tenant_id = :'prog' AND email = 'cliente@demo.fluvia.test') THEN 'cliente@demo.fluvia.test' END)
SQL
)"
[ -z "$seed_ok" ] || die "seed incompleto (falta: $seed_ok); ver $STATE/seed.log"

echo "==> Build de checkout y dashboard (next build)"
# El build no debe tocar archivos versionados. Si lo hiciera, se AVISA y no
# se restaura nada (podría ser trabajo del propietario).
tracked_before="$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null || true)"
(cd apps/checkout && npx next build >"$STATE/build-checkout.log" 2>&1)
# Con llamada, la CSP del panel (fijada al construir) admite el origen de LiveKit.
if [ "$WITH_CALL" = 1 ]; then
  (cd apps/dashboard && LIVEKIT_PUBLIC_URL="ws://$H:$LIVEKIT_PORT" npx next build \
    >"$STATE/build-dashboard.log" 2>&1)
else
  (cd apps/dashboard && npx next build >"$STATE/build-dashboard.log" 2>&1)
fi

tracked_after="$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null || true)"
if [ "$tracked_before" != "$tracked_after" ]; then
  echo "   AVISO: el build cambió archivos versionados (no se restauran):" >&2
  diff <(echo "$tracked_before") <(echo "$tracked_after") | sed -n 's/^> /     /p' >&2
fi

echo "==> Arrancando API, checkout y dashboard (solo $H)"
start() { # nombre, dir, comando...
  # setsid ⇒ sesión y grupo propios; el pid guardado ES el líder del grupo
  # (stop-local-demo.sh para el grupo entero). Sin heredar la terminal. El
  # proceso lleva la etiqueta de la instancia y se registra su identidad
  # (inicio, grupo, boot_id) para que la parada no dependa solo del PID.
  local name="$1" dir="$2" pid=""; shift 2
  rm -f "$STATE/$name.pid" "$STATE/$name.proc"
  (cd "$ROOT/$dir" && FLUVIA_DEMO_INSTANCE="$(instance_tag)" \
    setsid bash -c 'echo $$ >"$0"; exec "$@"' "$STATE/$name.pid" "$@" \
    >"$STATE/$name.log" 2>&1 </dev/null &)
  for _ in $(seq 1 50); do
    pid="$(cat "$STATE/$name.pid" 2>/dev/null || true)"
    [ -n "$pid" ] && break
    sleep 0.1
  done
  [ -n "$pid" ] || die "$name no arrancó (sin PID); ver $STATE/$name.log"
  record_proc "$name" "$pid"
  STARTED_SERVICES+=("$name")
}
if [ "$WITH_CALL" = 1 ]; then
  # Claves por el ENTORNO de la API y del agente (no en la línea de órdenes).
  (
    export ASSISTANT_CALL_PROVIDER=livekit LIVEKIT_URL="ws://$H:$LIVEKIT_PORT" \
      LIVEKIT_API_KEY LIVEKIT_API_SECRET ASSISTANT_AGENT_URL="http://$H:$AGENT_PORT" \
      ASSISTANT_AGENT_SECRET
    start api apps/api env HOST=$H PORT="$API_PORT" CHECKOUT_BASE_URL="$CHECKOUT_ORIGIN" \
      npx tsx src/server.ts
  )
  (
    export LIVEKIT_INTERNAL_URL="ws://$H:$LIVEKIT_PORT" LIVEKIT_API_KEY LIVEKIT_API_SECRET \
      AGENT_CONTROL_SECRET="$ASSISTANT_AGENT_SECRET"
    start voice-agent apps/voice-agent env AGENT_HOST=$H AGENT_PORT="$AGENT_PORT" \
      node --import tsx src/main.ts
  )
else
  start api apps/api env HOST=$H PORT="$API_PORT" CHECKOUT_BASE_URL="$CHECKOUT_ORIGIN" \
    npx tsx src/server.ts
fi
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

# Código ESPERADO por servicio (un 500 o un 404 no es un arranque correcto).
CHECKS=("api|http://$H:$API_PORT/health|200" "checkout|http://$H:$CHECKOUT_PORT/p|200"
  "dashboard|http://$H:$DASHBOARD_PORT/login|200")
[ "${DEMO_WITH_WORKER:-0}" = 1 ] && CHECKS+=("worker|http://$H:$WORKER_METRICS_PORT/health|200")
[ "$WITH_CALL" = 1 ] && CHECKS+=("voice-agent|http://$H:$AGENT_PORT/health|200")
for c in "${CHECKS[@]}"; do
  IFS='|' read -r svc url want <<<"$c"
  if got="$(expect_http "$url" "$want" 120)"; then
    echo "   $url -> $want"
  else
    tail -15 "$STATE/$svc.log" >&2 || true
    die "$svc respondió $got en $url (se esperaba $want); ver $STATE/$svc.log"
  fi
done

# Datos sintéticos de restaurantes (opcional): por la API ya en marcha, con
# postcondiciones comprobadas; si fallan, el arranque falla.
if [ "${DEMO_SEED_RESTAURANTS:-0}" = 1 ]; then
  echo "==> Seed de restaurantes (DEMO_SEED_RESTAURANTS=1)"
  SEED_API_URL="http://$H:$API_PORT" \
    pnpm -s --filter @fluvia/seeds run seed:restaurantes >"$STATE/seed-restaurantes.log" 2>&1 ||
    { cat "$STATE/seed-restaurantes.log" >&2; die "el seed de restaurantes falló"; }
  sed 's/^/   /' "$STATE/seed-restaurantes.log"
fi
STARTUP_OK=1
trap - EXIT

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

$([ "$WITH_CALL" = 1 ] && echo "Llamada:      asistente → «Hablar con Fluvia» (WebRTC; agente de PRUEBA salvo
                que se exporten ASSISTANT_SPEECH_PROVIDER y SPEECH_*)
")
Parar (CONSERVA los datos):   ${PFX}scripts/demo/stop-local-demo.sh
Borrar los datos (aparte):    ${PFX}scripts/demo/purge-local-demo.sh --yes-delete-data
EOF
