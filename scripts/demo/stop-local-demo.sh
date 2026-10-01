#!/usr/bin/env bash
# Para UNA instancia de la demo local y CONSERVA sus datos.
#
#  1. Verifica primero que todo pertenece a la instancia (DEMO_PREFIX +
#     checkout DEMO_ROOT): marcador de estado, PIDs leídos de SU directorio de
#     estado y corriendo en SU checkout, contenedores y volumen con SU nombre y
#     etiquetas. Si algo no coincide, se detiene SIN actuar.
#  2. Para los procesos (grupo entero; setsid en el arranque) y los
#     contenedores (`docker stop`). NO borra contenedores ni volumen: para
#     borrar los datos está scripts/demo/purge-local-demo.sh (paso aparte).
#
# Uso:
#   scripts/demo/stop-local-demo.sh                          # instancia por defecto
#   DEMO_PREFIX=fluvia-demo2 scripts/demo/stop-local-demo.sh # otra instancia
#   DEMO_ROOT=~/fluvia-demo/repo scripts/demo/stop-local-demo.sh
#     (parar la instancia de OTRO checkout sin ejecutar el script de ese
#      checkout; no modifica su código, solo sus PID en .demo/)
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
demo_config

echo "==> Parando la instancia «$PREFIX» de $ROOT"
if ! verify_instance; then
  DIE_CODE=3 die "la verificación de pertenencia falló; no se ha tocado nada"
fi

while read -r svc pid; do
  [ -n "${pid:-}" ] || continue
  # Revalida justo antes de actuar (el PID pudo reciclarse).
  if [ "$(proc_cwd "$pid")" != "$ROOT/apps/$svc" ]; then
    echo "   $svc: PID $pid ya no es de esta instancia; se omite" >&2
    continue
  fi
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  echo "   $svc: parado (grupo $pid)"
done < <(live_pids)
for _ in $(seq 1 20); do
  [ -z "$(live_pids)" ] && break
  sleep 0.5
done
rm -f "$STATE"/*.pid

for c in "$PG_CONTAINER" "$REDIS_CONTAINER"; do
  if container_exists "$c"; then
    docker stop "$c" >/dev/null && echo "   $c: detenido (se conserva)"
  fi
done
echo "Instancia «$PREFIX» parada. Datos conservados en el volumen $VOLUME."
echo "Volver a arrancarla: el mismo comando de arranque. Borrar los datos: purge-local-demo.sh --yes-delete-data"
