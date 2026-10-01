#!/usr/bin/env bash
# BORRA los datos de UNA instancia de la demo local: sus contenedores y su
# volumen. Operación EXPLÍCITA y separada de la parada; nunca la hace
# stop-local-demo.sh.
#
# Exige:
#   - el argumento --yes-delete-data;
#   - que la instancia esté PARADA (ningún proceso vivo en su estado);
#   - que contenedores y volumen pertenezcan a la instancia (mismas
#     comprobaciones que la parada). Si algo no coincide, no toca nada.
#
# Uso:
#   DEMO_PREFIX=fluvia-demo2 scripts/demo/purge-local-demo.sh --yes-delete-data
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
demo_config

[ "${1:-}" = "--yes-delete-data" ] ||
  die "borrar datos exige el argumento --yes-delete-data (instancia «$PREFIX», volumen $VOLUME)"

echo "==> Borrando los datos de la instancia «$PREFIX» de $ROOT"
# Sin estado propio de la instancia en ESTE checkout no hay prueba de
# pertenencia: no se borra nada (aunque exista un volumen con ese nombre).
[ -d "$STATE" ] || DIE_CODE=3 die "no existe $STATE: este checkout no tiene la instancia «$PREFIX»; no se ha borrado nada"
verify_instance || DIE_CODE=3 die "la verificación de pertenencia falló; no se ha borrado nada"
[ -z "$(live_pids 2>/dev/null)" ] || die "la instancia sigue en marcha; párala antes con stop-local-demo.sh"

for c in "$PG_CONTAINER" "$REDIS_CONTAINER"; do
  container_exists "$c" && docker rm -f "$c" >/dev/null && echo "   $c: eliminado"
done
volume_exists "$VOLUME" && docker volume rm "$VOLUME" >/dev/null && echo "   $VOLUME: eliminado"
# El marcador se conserva: identifica la instancia de este checkout y permite
# volver a arrancarla (con datos nuevos del seed).
echo "Datos de «$PREFIX» borrados. El checkout, el marcador y los logs en $STATE se conservan."
