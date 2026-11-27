#!/usr/bin/env bash
# Preinstala un binario de Anchore (syft o grype) en el tool cache del runner
# para que anchore/sbom-action y anchore/scan-action lo ENCUENTREN y no lo
# descarguen ellas mismas.
#
# Por qué: ambas actions solo descargan si `tool-cache.find(<tool>, <versión>)`
# falla, y entonces ejecutan `install.sh` traído de la rama `main` (sin pin),
# que antes de descargar consulta https://github.com/anchore/<tool>/releases/<v>.
# Ese endpoint devolvió HTTP 504 en 4 de 4 intentos (PR #111) y tumbó el job
# aunque el árbol estaba limpio. Aquí se descarga el asset del release
# directamente, con reintentos, y se verifica contra un SHA256 FIJADO en el
# repo (más estricto que install.sh, que confía en el checksums.txt del mismo
# release que descarga).
#
# Uso: preinstall-anchore-tool.sh <syft|grype> <vX.Y.Z> <sha256 linux_amd64>
# Entorno: RUNNER_TOOL_CACHE (obligatorio, lo define el runner).
#          ANCHORE_RELEASES_BASE (opcional, solo para tests).
#
# Falla cerrado: cualquier error (descarga, checksum, binario que no arranca)
# termina con exit != 0 y NO deja el marcador `.complete`, así que la action no
# puede usar un binario a medio instalar.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "uso: $0 <syft|grype> <vX.Y.Z> <sha256>" >&2
  exit 2
fi

tool=$1
version=$2
sha256=$3

case "$tool" in
  syft | grype) ;;
  *)
    echo "herramienta no soportada: '$tool' (syft|grype)" >&2
    exit 2
    ;;
esac
if ! [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "versión inválida: '$version' (se espera vX.Y.Z)" >&2
  exit 2
fi
if ! [[ "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "sha256 inválido: '$sha256' (64 hex en minúsculas)" >&2
  exit 2
fi
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "solo linux/x86_64 (el checksum fijado es del asset linux_amd64)" >&2
  exit 2
fi
: "${RUNNER_TOOL_CACHE:?RUNNER_TOOL_CACHE no definido}"

ver=${version#v}
base=${ANCHORE_RELEASES_BASE:-https://github.com/anchore}
url="$base/$tool/releases/download/v$ver/${tool}_${ver}_linux_amd64.tar.gz"

# Layout de @actions/tool-cache: <cache>/<tool>/<semver limpio>/<arch> + marcador
# <...>/<arch>.complete. arch = os.arch() de Node, que en x86_64 es "x64".
dest="$RUNNER_TOOL_CACHE/$tool/$ver/x64"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Descargando $url"
# --retry reintenta solo errores TRANSITORIOS (timeouts y HTTP 408/429/500/
# 502/503/504, incluido el 504 observado); un 404 falla al instante. Sin
# --retry-delay curl usa backoff exponencial (1, 2, 4, 8, 16, 32 s).
curl -fsSL \
  --retry 6 --retry-connrefused --retry-max-time 180 \
  --connect-timeout 15 --max-time 120 \
  -o "$tmp/asset.tar.gz" "$url"

echo "$sha256  $tmp/asset.tar.gz" | sha256sum -c -

tar -xzf "$tmp/asset.tar.gz" -C "$tmp" "$tool"

rm -rf "$dest" "$dest.complete"
mkdir -p "$dest"
install -m 0755 "$tmp/$tool" "$dest/$tool"

# Sanidad: el binario arranca antes de marcarlo como instalado.
"$dest/$tool" version >/dev/null

touch "$dest.complete"
echo "$tool $ver instalado en $dest"
