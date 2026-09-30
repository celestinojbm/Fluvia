#!/usr/bin/env bash
# Para la demo local y borra SOLO lo que creó start-local-demo.sh: procesos
# con pid en .demo/, contenedores fluvia-demo-* y su volumen. Nada más.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$ROOT/.demo"
for f in "$STATE"/*.pid; do
  [ -e "$f" ] || continue
  pid="$(cat "$f")"
  # setsid ⇒ el proceso lidera su propio grupo: se para el grupo entero.
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  rm -f "$f"
done
docker rm -f fluvia-demo-pg fluvia-demo-redis >/dev/null 2>&1 || true
docker volume rm fluvia-demo-pgdata >/dev/null 2>&1 || true
echo "Demo parada: procesos, contenedores fluvia-demo-* y volumen eliminados."
