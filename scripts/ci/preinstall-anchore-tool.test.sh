#!/usr/bin/env bash
# Tests de preinstall-anchore-tool.sh contra un servidor HTTP local (sin red).
# Reproduce el fallo de PR #111 (HTTP 504 transitorio) y comprueba que el
# script reintenta, verifica el checksum, deja el layout que lee
# @actions/tool-cache y falla cerrado (sin marcador `.complete`).
#
# Uso: bash scripts/ci/preinstall-anchore-tool.test.sh   (requiere python3)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script="$here/preinstall-anchore-tool.sh"
work=$(mktemp -d)
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- Asset falso: tarball con un binario `syft` que responde a `version`. ---
mkdir -p "$work/pkg" "$work/srv/anchore/syft/releases/download/v1.2.3"
printf '#!/bin/sh\necho "syft 1.2.3"\n' >"$work/pkg/syft"
chmod +x "$work/pkg/syft"
asset="$work/srv/anchore/syft/releases/download/v1.2.3/syft_1.2.3_linux_amd64.tar.gz"
tar -czf "$asset" -C "$work/pkg" syft
good_sha=$(sha256sum "$asset" | cut -d' ' -f1)
bad_sha=$(printf '0%.0s' $(seq 64))

# --- Servidor: responde 504 a las primeras N peticiones (contador en fichero). ---
cat >"$work/server.py" <<'PY'
import http.server, os, sys
root, fails_file, port_file = sys.argv[1], sys.argv[2], sys.argv[3]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=root, **k)
    def do_GET(self):
        n = int(open(fails_file).read() or 0)
        if n > 0:
            open(fails_file, "w").write(str(n - 1))
            self.send_error(504, "Gateway Timeout")
            return
        super().do_GET()
    def log_message(self, *a):
        pass
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(s.server_address[1]))
s.serve_forever()
PY
echo 0 >"$work/fails"
python3 "$work/server.py" "$work/srv" "$work/fails" "$work/port" &
server_pid=$!
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
[ -s "$work/port" ] || fail "el servidor de test no arrancó"
base="http://127.0.0.1:$(cat "$work/port")/anchore"

run() { # run <cache dir> <args...>
  local cache=$1
  shift
  RUNNER_TOOL_CACHE="$cache" ANCHORE_RELEASES_BASE="$base" bash "$script" "$@"
}

# 1) Camino feliz: layout de tool-cache (versión sin "v", arch x64) + marcador.
cache="$work/cache1"
run "$cache" syft v1.2.3 "$good_sha" >/dev/null
[ -x "$cache/syft/1.2.3/x64/syft" ] || fail "binario no instalado en <cache>/syft/1.2.3/x64"
[ -f "$cache/syft/1.2.3/x64.complete" ] || fail "falta el marcador .complete"
[ "$("$cache/syft/1.2.3/x64/syft" version)" = "syft 1.2.3" ] || fail "binario instalado incorrecto"
echo "ok 1 - instala en el layout de @actions/tool-cache"

# 2) El fallo de PR #111: 504 transitorio en las primeras peticiones -> reintenta.
echo 2 >"$work/fails"
cache="$work/cache2"
run "$cache" syft v1.2.3 "$good_sha" >/dev/null 2>&1 || fail "no se recuperó de dos 504 seguidos"
[ "$(cat "$work/fails")" = "0" ] || fail "el servidor no llegó a devolver los 504"
[ -f "$cache/syft/1.2.3/x64.complete" ] || fail "falta .complete tras reintentar"
echo "ok 2 - reintenta ante HTTP 504 transitorio"

# 3) Checksum incorrecto: falla y NO deja binario ni marcador.
cache="$work/cache3"
if run "$cache" syft v1.2.3 "$bad_sha" >/dev/null 2>&1; then
  fail "aceptó un asset con checksum distinto del fijado"
fi
[ ! -e "$cache/syft/1.2.3/x64.complete" ] || fail "dejó .complete con checksum malo"
[ ! -e "$cache/syft/1.2.3/x64/syft" ] || fail "dejó el binario con checksum malo"
echo "ok 3 - falla cerrado ante checksum incorrecto"

# 4) Asset inexistente (404 persistente): falla sin marcador.
cache="$work/cache4"
if run "$cache" syft v9.9.9 "$good_sha" >/dev/null 2>&1; then
  fail "no falló con un asset inexistente"
fi
[ ! -e "$cache/syft/9.9.9/x64.complete" ] || fail "dejó .complete sin asset"
echo "ok 4 - falla cerrado si el asset no existe"

# 5) Argumentos inválidos: se rechazan antes de descargar nada.
for args in "curl v1.2.3 $good_sha" "syft 1.2 $good_sha" "syft v1.2.3 ABC" "syft v1.2.3"; do
  # shellcheck disable=SC2086
  if run "$work/cache5" $args >/dev/null 2>&1; then
    fail "aceptó argumentos inválidos: $args"
  fi
done
[ ! -e "$work/cache5" ] || fail "creó el cache con argumentos inválidos"
echo "ok 5 - rechaza argumentos inválidos"

echo "preinstall-anchore-tool: 5/5 ok"
