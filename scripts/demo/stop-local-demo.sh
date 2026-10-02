#!/usr/bin/env bash
# Para UNA instancia de la demo local y CONSERVA sus datos.
#
#  1. Verifica primero que todo pertenece a la instancia (DEMO_PREFIX +
#     checkout DEMO_ROOT): marcador de estado, PIDs leídos de SU directorio de
#     estado y corriendo en SU checkout, contenedores y volumen con SU nombre y
#     etiquetas. Si algo no coincide, se detiene SIN actuar.
#  2. Para SOLO los procesos propios (grupo entero; setsid en el arranque),
#     verificados por instancia, checkout, inicio del proceso, grupo y
#     boot_id (no basta con el PID), y los contenedores (`docker stop`). Si
#     algo propio sigue en marcha, termina con código 4. NO borra contenedores ni volumen: para
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

FAILED=0
# Solo procesos PROPIOS (owns_pid: instancia, checkout, inicio, grupo,
# boot_id). Un archivo PID cuyo número hoy es de otro proceso se ignora.
mapfile -t OWN < <(live_pids)
for line in "${OWN[@]}"; do
  read -r svc pid <<<"$line"
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
done
for line in "${OWN[@]}"; do
  read -r svc pid <<<"$line"
  for _ in $(seq 1 20); do pid_alive "$pid" || break; sleep 0.5; done
  # Sigue vivo: se revalida (que siga siendo NUESTRO) antes de forzar.
  if pid_alive "$pid" && owns_pid "$svc" "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do pid_alive "$pid" || break; sleep 0.5; done
  fi
  if pid_alive "$pid" && owns_pid "$svc" "$pid" 2>/dev/null; then
    echo "   $svc: SIGUE EN MARCHA (grupo $pid)" >&2
    FAILED=1
  else
    echo "   $svc: parado (grupo $pid)"
    rm -f "$STATE/$svc.pid" "$STATE/$svc.proc"
  fi
done
# Archivos PID obsoletos (proceso inexistente o ajeno): se retiran sin tocar
# ningún proceso.
for f in "$STATE"/*.pid; do
  [ -e "$f" ] || continue
  svc="$(basename "$f" .pid)"
  pid="$(cat "$f")"
  if ! owns_pid "$svc" "$pid" 2>/dev/null; then
    rm -f "$f" "$STATE/$svc.proc"
  fi
done

for c in "$PG_CONTAINER" "$REDIS_CONTAINER" "$LK_CONTAINER"; do
  if container_exists "$c"; then
    if docker stop "$c" >/dev/null; then
      echo "   $c: detenido (se conserva)"
    else
      echo "   $c: NO se pudo detener" >&2
      FAILED=1
    fi
  fi
done
if [ "$FAILED" = 1 ]; then
  DIE_CODE=4 die "la instancia «$PREFIX» NO quedó parada del todo (ver arriba)"
fi
echo "Instancia «$PREFIX» parada. Datos conservados en el volumen $VOLUME."
echo "Volver a arrancarla: el mismo comando de arranque. Borrar los datos: purge-local-demo.sh --yes-delete-data"
