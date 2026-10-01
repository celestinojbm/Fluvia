#!/usr/bin/env bash
# Para la demo local y borra SOLO lo que creó start-local-demo.sh: procesos
# con pid en su directorio de estado, contenedores $DEMO_NAME-* (por defecto
# fluvia-demo-*) y su volumen. Nada más: otra demo con otro DEMO_NAME no se toca.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${DEMO_NAME:-fluvia-demo}"
case "$NAME" in *[!a-z0-9-]*|'') echo "DEMO_NAME inválido: $NAME" >&2; exit 1;; esac
STATE="$ROOT/.demo"
[ "$NAME" = fluvia-demo ] || STATE="$ROOT/.demo-$NAME"
for f in "$STATE"/*.pid; do
  [ -e "$f" ] || continue
  pid="$(cat "$f")"
  # setsid ⇒ el proceso lidera su propio grupo: se para el grupo entero.
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  rm -f "$f"
done
docker rm -f "$NAME-pg" "$NAME-redis" >/dev/null 2>&1 || true
docker volume rm "$NAME-pgdata" >/dev/null 2>&1 || true
echo "Demo parada: procesos, contenedores $NAME-* y volumen eliminados."
