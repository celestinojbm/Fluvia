#!/usr/bin/env bash
# Instancia INDEPENDIENTE «fluvia-restaurantes» (sandbox) con recursos propios:
# cluster PostgreSQL, Redis, logs, PIDs y datos en $FLUVIA_RR_HOME. No toca
# otras instancias ni puertos ocupados: comprueba cada puerto antes de usarlo y
# se detiene si alguno está ocupado. Solo detiene procesos cuyos PID guardó.
#
#   scripts/instancia-restaurantes.sh up      # crea (si hace falta), migra, construye y arranca
#   scripts/instancia-restaurantes.sh status
#   scripts/instancia-restaurantes.sh down    # detiene SOLO lo que arrancó este script
#
# Puertos por defecto (rango 3380–3383 + 55438/56385), elegidos fuera de los
# usados por las demos (3300–3302, 331x, 332x), fluvia-ci (334x) y
# LiveKit/asistente (336x). Se pueden cambiar con FLUVIA_RR_BASE / _PG / _REDIS.
# Proveedores: SOLO sandbox (MockPaymentProvider y simulador presencial). Sin
# credenciales externas, sin dinero real.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${FLUVIA_RR_HOME:-$HOME/.fluvia-restaurantes}"
BASE="${FLUVIA_RR_BASE:-3380}"
API_PORT=$((BASE)); CHECKOUT_PORT=$((BASE + 1)); DASH_PORT=$((BASE + 2)); METRICS_PORT=$((BASE + 3))
PG_PORT="${FLUVIA_RR_PG:-55438}"; REDIS_PORT="${FLUVIA_RR_REDIS:-56385}"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
LOGS="$HOME_DIR/logs"; PIDS="$HOME_DIR/pids"; PGDATA="$HOME_DIR/pg"
mkdir -p "$LOGS" "$PIDS"
# PostgreSQL no corre como root: en ese caso se delega en el usuario `postgres`.
PGRUN=()
if [ "$(id -u)" = 0 ]; then PGRUN=(runuser -u postgres --); fi

port_busy() { (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
own_pid() { [ -f "$PIDS/$1.pid" ] && kill -0 "$(cat "$PIDS/$1.pid")" 2>/dev/null; }

db_env() {
  local u="postgres://%s@127.0.0.1:$PG_PORT/fluvia"
  export NODE_ENV=local NEXT_TELEMETRY_DISABLED=1
  export ADMIN_DATABASE_URL="$(printf "$u" postgres:postgres)"
  export APP_DATABASE_URL="$(printf "$u" fluvia_app:fluvia_app_dev_password)"
  export WORKER_DATABASE_URL="$(printf "$u" fluvia_worker:fluvia_worker_dev_password)"
  export RELAY_DATABASE_URL="$(printf "$u" fluvia_relay:fluvia_relay_dev_password)"
  export AUTH_DATABASE_URL="$(printf "$u" fluvia_auth:fluvia_auth_dev_password)"
  export INBOX_DATABASE_URL="$(printf "$u" fluvia_inbox:fluvia_inbox_dev_password)"
  export WEBHOOK_DATABASE_URL="$(printf "$u" fluvia_webhook:fluvia_webhook_dev_password)"
  export REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
  export FLUVIA_PROGRAM_TENANT_ID="${FLUVIA_PROGRAM_TENANT_ID:-e744e6eb-95cf-5762-95a7-268a0917e747}"
}

up() {
  for p in "$API_PORT" "$CHECKOUT_PORT" "$DASH_PORT" "$METRICS_PORT"; do
    if port_busy "$p"; then echo "Puerto $p ocupado: no se arranca nada (usa FLUVIA_RR_BASE)."; exit 1; fi
  done
  # PostgreSQL propio
  if [ ! -d "$PGDATA" ]; then
    mkdir -p "$PGDATA"
    [ ${#PGRUN[@]} -gt 0 ] && chown postgres "$PGDATA" "$HOME_DIR" && chmod 755 "$HOME_DIR" && touch "$LOGS/postgres.log" && chown postgres "$LOGS/postgres.log"
    "${PGRUN[@]}" "$PG_BIN/initdb" -D "$PGDATA" -U postgres --auth=trust >"$LOGS/initdb.log"
  fi
  if ! own_pid pg; then
    if port_busy "$PG_PORT"; then echo "Puerto $PG_PORT ocupado (PostgreSQL)."; exit 1; fi
    "${PGRUN[@]}" "$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p $PG_PORT -k /tmp -c listen_addresses=127.0.0.1" \
      -l "$LOGS/postgres.log" start >/dev/null
    head -1 "$PGDATA/postmaster.pid" >"$PIDS/pg.pid"
    "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='fluvia'" | grep -q 1 ||
      "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U postgres fluvia
  fi
  # Redis propio
  if ! own_pid redis; then
    if port_busy "$REDIS_PORT"; then echo "Puerto $REDIS_PORT ocupado (Redis)."; exit 1; fi
    redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$HOME_DIR" --daemonize yes \
      --pidfile "$PIDS/redis.pid" --logfile "$LOGS/redis.log" >/dev/null
  fi
  db_env
  cd "$ROOT"
  pnpm -s migrate >"$LOGS/migrate.log" 2>&1
  pnpm -s seed >"$LOGS/seed.log" 2>&1 || true
  # `next build` reescribe tsconfig.json/next-env.d.ts: se restauran SOLO si
  # estaban sin cambios antes (nunca se descarta trabajo ajeno).
  local gen=(apps/dashboard/tsconfig.json apps/dashboard/next-env.d.ts
    apps/checkout/tsconfig.json apps/checkout/next-env.d.ts)
  local clean=0
  git diff --quiet -- "${gen[@]}" 2>/dev/null && clean=1
  (cd apps/dashboard && npx next build >"$LOGS/build-dashboard.log" 2>&1)
  (cd apps/checkout && npx next build >"$LOGS/build-checkout.log" 2>&1)
  [ "$clean" = 1 ] && git checkout -- "${gen[@]}" 2>/dev/null || true
  start() { # nombre, dir, comando...
    # El PID se escribe DESDE la sesión nueva ($$ antes del exec): es el líder
    # de sesión y de grupo, así `down` detiene el árbol completo (npx → node).
    local name=$1 dir=$2; shift 2
    (cd "$dir" && setsid bash -c 'echo $$ >"$0"; exec "$@"' "$PIDS/$name.pid" "$@" \
      >"$LOGS/$name.log" 2>&1 </dev/null &)
    for _ in $(seq 1 50); do [ -s "$PIDS/$name.pid" ] && break; sleep 0.1; done
  }
  start api apps/api env HOST=127.0.0.1 PORT="$API_PORT" \
    CHECKOUT_BASE_URL="http://127.0.0.1:$CHECKOUT_PORT" \
    ASSISTANT_STORAGE_DIR="$HOME_DIR/assistant" node --import tsx src/server.ts
  start worker apps/worker env WORKER_METRICS_HOST=127.0.0.1 WORKER_METRICS_PORT="$METRICS_PORT" node --import tsx src/main.ts
  start checkout apps/checkout env FLUVIA_API_URL="http://127.0.0.1:$API_PORT" \
    npx next start -H 127.0.0.1 -p "$CHECKOUT_PORT"
  start dashboard apps/dashboard env FLUVIA_API_URL="http://127.0.0.1:$API_PORT" \
    FLUVIA_DASHBOARD_ORIGIN="http://127.0.0.1:$DASH_PORT" \
    npx next start -H 127.0.0.1 -p "$DASH_PORT"
  for u in "http://127.0.0.1:$API_PORT/health" "http://127.0.0.1:$DASH_PORT/login"; do
    for _ in $(seq 1 90); do curl -s -o /dev/null "$u" && break; sleep 1; done
    curl -s -o /dev/null -w "$u %{http_code}\n" "$u"
  done
  echo "Panel: http://127.0.0.1:$DASH_PORT · Checkout: http://127.0.0.1:$CHECKOUT_PORT · Logs: $LOGS"
}

status() {
  for n in pg redis api worker checkout dashboard; do
    if own_pid "$n"; then echo "$n: en marcha (pid $(cat "$PIDS/$n.pid"))"; else echo "$n: detenido"; fi
  done
}

down() {
  for n in dashboard checkout worker api; do
    if own_pid "$n"; then kill -- -"$(cat "$PIDS/$n.pid")" 2>/dev/null || kill "$(cat "$PIDS/$n.pid")"; fi
    rm -f "$PIDS/$n.pid"
  done
  for _ in $(seq 1 30); do
    busy=0
    for p in "$API_PORT" "$CHECKOUT_PORT" "$DASH_PORT" "$METRICS_PORT"; do port_busy "$p" && busy=1; done
    [ "$busy" = 0 ] && break; sleep 0.5
  done
  [ "$busy" = 0 ] || echo "Aviso: algún puerto de la instancia sigue ocupado; revisa $LOGS."
  if own_pid redis; then kill "$(cat "$PIDS/redis.pid")"; fi
  rm -f "$PIDS/redis.pid"
  if own_pid pg; then "${PGRUN[@]}" "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null; fi
  rm -f "$PIDS/pg.pid"
  echo "Detenida (datos conservados en $HOME_DIR)."
}

case "${1:-}" in
  up) up ;;
  status) status ;;
  down) down ;;
  *) echo "uso: $0 up|status|down"; exit 2 ;;
esac
