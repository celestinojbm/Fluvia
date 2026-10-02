#!/usr/bin/env bash
# Instancia INDEPENDIENTE «fluvia-restaurantes» (sandbox) sobre la MISMA
# infraestructura de la demo local (scripts/demo/*): PostgreSQL 16 y Redis 7
# en contenedores Docker PROPIOS (fluvia-restaurantes-pg / -redis, volumen
# fluvia-restaurantes-pgdata), procesos con identidad verificada, estado y
# logs en <checkout>/.demo-fluvia-restaurantes/. No requiere PostgreSQL ni
# Redis nativos. Pensada para Ubuntu (WSL) + Docker Desktop o Linux.
#
#   scripts/instancia-restaurantes.sh config   # imprime la configuración resuelta
#   scripts/instancia-restaurantes.sh up       # comprueba puertos, crea/arranca, migra, siembra, construye
#   scripts/instancia-restaurantes.sh status
#   scripts/instancia-restaurantes.sh down     # para SOLO lo suyo; conserva los datos (código ≠ 0 si algo queda)
#   scripts/instancia-restaurantes.sh purge --yes-delete-data   # borra SUS contenedores y volumen
#
# Puertos por defecto (sujetos a comprobación en la máquina de destino; el
# arranque aborta ANTES de crear nada si alguno está ocupado):
#   API 3380 · checkout 3381 · panel 3382 · métricas del worker 3383
#   PostgreSQL 55439 · Redis 56386
# 55438/56385 son de «fluvia-asistente»; 3300-3302/331x/332x de las demos.
# Se cambian con FLUVIA_RR_BASE (API; +1 checkout, +2 panel, +3 métricas),
# FLUVIA_RR_PG y FLUVIA_RR_REDIS. FLUVIA_RR_PREFIX cambia el nombre (otra
# instancia independiente con sus propios contenedores, volumen y estado).
#
# Proveedores: SOLO sandbox (MockPaymentProvider, simulador presencial y
# asistente con proveedores simulados). Sin credenciales externas ni dinero.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${FLUVIA_RR_BASE:-3380}"
export DEMO_PREFIX="${FLUVIA_RR_PREFIX:-fluvia-restaurantes}"
export DEMO_PORT_BASE="$BASE"
export DEMO_API_PORT="$BASE"
export DEMO_CHECKOUT_PORT="$((BASE + 1))"
export DEMO_DASHBOARD_PORT="$((BASE + 2))"
export DEMO_WORKER_METRICS_PORT="$((BASE + 3))"
export DEMO_PG_PORT="${FLUVIA_RR_PG:-55439}"
export DEMO_REDIS_PORT="${FLUVIA_RR_REDIS:-56386}"
export DEMO_WITH_WORKER=1
export DEMO_SEED_RESTAURANTS=1
# La llamada en vivo usa base+3..+6 por defecto y chocaría con las métricas.
if [ "${DEMO_WITH_CALL:-0}" = 1 ]; then
  export DEMO_LIVEKIT_PORT="${DEMO_LIVEKIT_PORT:-$((BASE + 4))}"
  export DEMO_LIVEKIT_TCP_PORT="${DEMO_LIVEKIT_TCP_PORT:-$((BASE + 5))}"
  export DEMO_LIVEKIT_UDP_PORT="${DEMO_LIVEKIT_UDP_PORT:-$((BASE + 6))}"
  export DEMO_AGENT_PORT="${DEMO_AGENT_PORT:-$((BASE + 7))}"
fi

status() {
  # shellcheck source=demo/lib.sh
  source "$HERE/demo/lib.sh"
  demo_config
  demo_print_config
  echo "worker        métricas $WORKER_METRICS_PORT"
  local svc f pid
  for svc in "${SERVICES[@]}"; do
    f="$STATE/$svc.pid"
    [ -f "$f" ] || { echo "$svc: detenido"; continue; }
    pid="$(cat "$f")"
    if owns_pid "$svc" "$pid" 2>/dev/null; then
      echo "$svc: en marcha (grupo $pid, desde $(sed -n 's/^started_at=//p' "$STATE/$svc.proc" 2>/dev/null))"
    else
      echo "$svc: detenido (archivo PID obsoleto)"
    fi
  done
  for c in "$PG_CONTAINER" "$REDIS_CONTAINER"; do
    if container_exists "$c"; then
      echo "$c: $(docker inspect -f '{{ .State.Status }}' "$c")"
    else
      echo "$c: no existe"
    fi
  done
  volume_exists "$VOLUME" && echo "$VOLUME: conservado" || echo "$VOLUME: no existe"
}

case "${1:-}" in
  config) DEMO_PRINT_CONFIG=1 exec "$HERE/demo/start-local-demo.sh" ;;
  up) exec "$HERE/demo/start-local-demo.sh" ;;
  status) status ;;
  down) exec "$HERE/demo/stop-local-demo.sh" ;;
  purge) shift; exec "$HERE/demo/purge-local-demo.sh" "$@" ;;
  *)
    echo "uso: $0 config|up|status|down|purge --yes-delete-data" >&2
    exit 2
    ;;
esac
