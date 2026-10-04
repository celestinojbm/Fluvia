#!/usr/bin/env bash
# Instancia INDEPENDIENTE «fluvia-ecosistema» (sandbox): Personal, Comercio y
# Operaciones viendo la MISMA compra. Usa la infraestructura de demo existente
# (scripts/demo/*): PostgreSQL 16 y Redis 7 en contenedores Docker PROPIOS
# (fluvia-ecosistema-pg / -redis, volumen fluvia-ecosistema-pgdata), procesos
# con identidad verificada (PID del líder de grupo + inicio + boot_id), estado
# y logs en <checkout>/.demo-fluvia-ecosistema/. No toca otras instancias ni
# sus volúmenes. Pensada para Ubuntu (WSL) + Docker Desktop o Linux.
#
#   scripts/instancia-ecosistema.sh config   # imprime la configuración resuelta
#   scripts/instancia-ecosistema.sh up       # comprueba puertos, crea/arranca, migra, siembra, construye
#   scripts/instancia-ecosistema.sh status
#   scripts/instancia-ecosistema.sh down     # para SOLO lo suyo; CONSERVA los datos
#   scripts/instancia-ecosistema.sh purge --yes-delete-data   # borra SUS contenedores y volumen
#
# Puertos por defecto (el arranque aborta ANTES de crear nada si alguno está
# ocupado): API 3420 · checkout 3421 · panel 3422 · métricas del worker 3423 ·
# PostgreSQL 55443 · Redis 56390. Ya asignados en la documentación: 3300-3302,
# 331x/332x (demos), 3340-3342 (fluvia-ci), 3360-3362 + 55438/56385
# (fluvia-asistente), 3380-3383 + 55439/56386 (fluvia-restaurantes), 3390-3392
# + 55440/56387 (fluvia-otra), 3400-3403 + 55441/56388 (fluvia-tiendas).
# Se cambian con FLUVIA_ECO_BASE (API; +1 checkout, +2 panel, +3 métricas),
# FLUVIA_ECO_PG y FLUVIA_ECO_REDIS. FLUVIA_ECO_PREFIX cambia el nombre.
#
# Siembra: demo base + Tiendas (Casa Ávila incluye el producto «escenario de
# prueba: respuesta perdida», Bs 150,13) + restaurantes. La API arranca con
# SANDBOX_SCENARIOS=1: un pago de la red Fluvia cuyo importe termina en 13 se
# procesa pero pierde la respuesta (solo local/test). El worker lo verifica solo
# en su siguiente ciclo; el comercio u Operaciones pueden pedir «Verificar».
# Proveedores: SOLO sandbox. Sin credenciales externas, sin Tailscale, sin
# producción ni servicios del HomeLab.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${FLUVIA_ECO_BASE:-3420}"
export DEMO_PREFIX="${FLUVIA_ECO_PREFIX:-fluvia-ecosistema}"
export DEMO_PORT_BASE="$BASE"
export DEMO_API_PORT="$BASE"
export DEMO_CHECKOUT_PORT="$((BASE + 1))"
export DEMO_DASHBOARD_PORT="$((BASE + 2))"
export DEMO_WORKER_METRICS_PORT="$((BASE + 3))"
export DEMO_PG_PORT="${FLUVIA_ECO_PG:-55443}"
export DEMO_REDIS_PORT="${FLUVIA_ECO_REDIS:-56390}"
export DEMO_WITH_WORKER=1
export DEMO_SEED_SHOPS=1
export DEMO_SEED_RESTAURANTS=1
# Escenarios sandbox de la red Fluvia (los hereda la API de ESTA instancia).
export SANDBOX_SCENARIOS=1
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
