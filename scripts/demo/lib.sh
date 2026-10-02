# shellcheck shell=bash
# Biblioteca común de la demo local (start / stop / purge). Se carga con
# `source`; no se ejecuta sola.
#
# INSTANCIA = un prefijo (DEMO_PREFIX) + un checkout (DEMO_ROOT). Todo lo que
# la instancia crea o toca deriva de ese prefijo:
#
#   contenedores   $PREFIX-pg, $PREFIX-redis   (etiquetas fluvia.demo.prefix/root)
#   volumen        $PREFIX-pgdata              (etiquetas idem)
#   estado         $ROOT/.demo (prefijo por defecto) o $ROOT/.demo-$PREFIX
#                  ├─ instance                 marcador: prefix=… root=…
#                  ├─ {api,checkout,dashboard}.pid
#                  └─ *.log
#   puertos        DEMO_PORT_BASE (+0 API, +1 checkout, +2 dashboard),
#                  DEMO_PG_PORT, DEMO_REDIS_PORT (o cada DEMO_*_PORT suelto)
#   llamada        DEMO_WITH_CALL=1: contenedor $PREFIX-livekit (señal +3,
#   (opcional)     RTC TCP +4, RTC UDP +5) y agente de voz (+6), con claves
#                  propias de la instancia en $STATE/call (0700)
#   orígenes       DEMO_DASHBOARD_ORIGIN / DEMO_CHECKOUT_ORIGIN
#                  (por defecto http://127.0.0.1:<puerto>)
#
# Los DEFECTOS reproducen exactamente la demo existente: fluvia-demo-*,
# fluvia-demo-pgdata, 3300/3301/3302, 55432/56379 y el estado en .demo/ con
# los mismos nombres de PID y log. Así no se rompe una demo ya en marcha.

H=127.0.0.1
DEFAULT_PREFIX=fluvia-demo

die() {
  echo "ERROR: $*" >&2
  exit "${DIE_CODE:-1}"
}

demo_config() {
  ROOT="${DEMO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  [ -d "$ROOT" ] || die "DEMO_ROOT no existe: $ROOT"
  ROOT="$(cd "$ROOT" && pwd -P)"
  PREFIX="${DEMO_PREFIX:-$DEFAULT_PREFIX}"
  [[ "$PREFIX" =~ ^[a-z][a-z0-9-]{1,40}$ ]] || die "DEMO_PREFIX inválido: '$PREFIX' (a-z, 0-9, '-')"
  IS_DEFAULT=0
  [ "$PREFIX" = "$DEFAULT_PREFIX" ] && IS_DEFAULT=1
  if [ "$IS_DEFAULT" = 1 ]; then STATE="$ROOT/.demo"; else STATE="$ROOT/.demo-$PREFIX"; fi
  MARKER="$STATE/instance"

  PORT_BASE="${DEMO_PORT_BASE:-3300}"
  API_PORT="${DEMO_API_PORT:-$PORT_BASE}"
  CHECKOUT_PORT="${DEMO_CHECKOUT_PORT:-$((PORT_BASE + 1))}"
  DASHBOARD_PORT="${DEMO_DASHBOARD_PORT:-$((PORT_BASE + 2))}"
  PG_PORT="${DEMO_PG_PORT:-55432}"
  REDIS_PORT="${DEMO_REDIS_PORT:-56379}"
  LIVEKIT_PORT="${DEMO_LIVEKIT_PORT:-$((PORT_BASE + 3))}"
  LIVEKIT_TCP_PORT="${DEMO_LIVEKIT_TCP_PORT:-$((PORT_BASE + 4))}"
  LIVEKIT_UDP_PORT="${DEMO_LIVEKIT_UDP_PORT:-$((PORT_BASE + 5))}"
  AGENT_PORT="${DEMO_AGENT_PORT:-$((PORT_BASE + 6))}"
  WITH_CALL="${DEMO_WITH_CALL:-0}"
  for p in "$API_PORT" "$CHECKOUT_PORT" "$DASHBOARD_PORT" "$PG_PORT" "$REDIS_PORT" \
    "${DEMO_WORKER_METRICS_PORT:-$((PORT_BASE + 9))}" "$LIVEKIT_PORT" "$LIVEKIT_TCP_PORT" \
    "$LIVEKIT_UDP_PORT" "$AGENT_PORT"; do
    [[ "$p" =~ ^[0-9]{2,5}$ ]] || die "puerto inválido: $p"
  done

  PG_CONTAINER="$PREFIX-pg"
  REDIS_CONTAINER="$PREFIX-redis"
  LK_CONTAINER="$PREFIX-livekit"
  # Imagen del servidor de llamadas (Apache-2.0), versión fijada.
  LK_IMAGE="${DEMO_LIVEKIT_IMAGE:-livekit/livekit-server:v1.13.7}"
  CALL_DIR="$STATE/call"
  VOLUME="$PREFIX-pgdata"
  DASHBOARD_ORIGIN="${DEMO_DASHBOARD_ORIGIN:-http://$H:$DASHBOARD_PORT}"
  CHECKOUT_ORIGIN="${DEMO_CHECKOUT_ORIGIN:-http://$H:$CHECKOUT_PORT}"
  # worker: opcional (DEMO_WITH_WORKER=1); se lista siempre para que stop/purge
  # reconozcan su PID si se arrancó.
  # voice-agent: opcional (DEMO_WITH_CALL=1); se lista por la misma razón.
  SERVICES=(api checkout dashboard worker voice-agent)
  WORKER_METRICS_PORT="${DEMO_WORKER_METRICS_PORT:-$((PORT_BASE + 9))}"
}

demo_print_config() {
  cat <<EOF
instancia     $PREFIX$([ "$IS_DEFAULT" = 1 ] && echo " (por defecto)")
checkout      $ROOT
estado        $STATE  (PID y logs)
contenedores  $PG_CONTAINER, $REDIS_CONTAINER
volumen       $VOLUME
puertos       API $API_PORT · checkout $CHECKOUT_PORT · dashboard $DASHBOARD_PORT · PG $PG_PORT · Redis $REDIS_PORT
orígenes      dashboard $DASHBOARD_ORIGIN · checkout $CHECKOUT_ORIGIN
EOF
  if [ "$WITH_CALL" = 1 ]; then
    echo "llamada       $LK_CONTAINER ($LK_IMAGE) · señal $LIVEKIT_PORT · RTC TCP $LIVEKIT_TCP_PORT · RTC UDP $LIVEKIT_UDP_PORT · agente $AGENT_PORT"
  fi
}

# Una instancia NO por defecto no puede usar los puertos de la demo por
# defecto (evita que una segunda demo se cruce con la que está en marcha).
demo_guard_default_ports() {
  [ "$IS_DEFAULT" = 1 ] && return 0
  [ "${DEMO_ALLOW_DEFAULT_PORTS:-0}" = 1 ] && return 0
  local p
  for p in "$API_PORT" "$CHECKOUT_PORT" "$DASHBOARD_PORT" "$PG_PORT" "$REDIS_PORT"; do
    case "$p" in 3300 | 3301 | 3302 | 55432 | 56379)
      die "la instancia '$PREFIX' usaría el puerto $p de la demo por defecto; elige otros (DEMO_PORT_BASE, DEMO_PG_PORT, DEMO_REDIS_PORT)" ;;
    esac
  done
}

port_busy() { (exec 3<>"/dev/tcp/$H/$1") 2>/dev/null; }

# UDP no se puede sondear con /dev/tcp: se mira la tabla del kernel (Linux y
# WSL). En otros sistemas devuelve «libre» y el propio `docker run` fallaría.
udp_busy() {
  local hex f files=()
  hex="$(printf '%04X' "$1")"
  # Solo las tablas que existen (mawk aborta si falta una, p. ej. sin IPv6).
  for f in /proc/net/udp /proc/net/udp6; do [ -r "$f" ] && files+=("$f"); done
  [ "${#files[@]}" -gt 0 ] || return 1
  awk -v h=":$hex" 'FNR > 1 && toupper($2) ~ h"$" { f = 1 } END { exit !f }' "${files[@]}"
}

# Directorio de trabajo de un proceso (Linux/WSL por /proc; macOS por lsof).
proc_cwd() {
  local pid="$1"
  if [ -e "/proc/$pid/cwd" ]; then
    readlink "/proc/$pid/cwd" 2>/dev/null
  elif command -v lsof >/dev/null; then
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  fi
}

pid_alive() { kill -0 "$1" 2>/dev/null; }

container_exists() { docker inspect "$1" >/dev/null 2>&1; }
volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

label_of() { # tipo(container|volume) nombre etiqueta
  local fmt="{{ index .Config.Labels \"$3\" }}"
  [ "$1" = volume ] && fmt="{{ index .Labels \"$3\" }}"
  docker "$1" inspect -f "$fmt" "$2" 2>/dev/null | sed 's/<no value>//'
}

# Comprueba que un contenedor/volumen pertenece a ESTA instancia:
#  - con etiquetas: prefijo y checkout deben coincidir;
#  - sin etiquetas (creado por la versión anterior del script): solo se acepta
#    para el prefijo POR DEFECTO, con el nombre exacto.
owns_resource() { # tipo nombre
  local kind="$1" name="$2" lp lr
  lp="$(label_of "$kind" "$name" fluvia.demo.prefix)"
  lr="$(label_of "$kind" "$name" fluvia.demo.root)"
  if [ -n "$lp" ] || [ -n "$lr" ]; then
    [ "$lp" = "$PREFIX" ] && [ "$lr" = "$ROOT" ] && return 0
    echo "  $kind $name pertenece a otra instancia (prefix=$lp root=$lr)" >&2
    return 1
  fi
  if [ "$IS_DEFAULT" != 1 ]; then
    echo "  $kind $name no tiene etiquetas de instancia y '$PREFIX' no es el prefijo por defecto" >&2
    return 1
  fi
  # Recurso de la versión anterior del script (sin etiquetas): solo es de
  # esta instancia si ESTE checkout tiene estado propio que lo pruebe. Sin
  # esto, otro checkout con el prefijo por defecto podría adoptar o borrar
  # los recursos de la demo en marcha.
  legacy_state_ok && return 0
  echo "  $kind $name (sin etiquetas) no consta como creado desde $ROOT: falta su estado .demo/" >&2
  return 1
}

# Evidencia de que ESTE checkout arrancó la instancia por defecto con la
# versión anterior del script: su .demo/ tiene marcador, PIDs o logs.
legacy_state_ok() {
  [ -d "$STATE" ] || return 1
  [ -f "$MARKER" ] && return 0
  compgen -G "$STATE/*.pid" >/dev/null && return 0
  [ -f "$STATE/api.log" ] || [ -f "$STATE/seed.log" ]
}

# Verifica TODO antes de actuar. Devuelve 0 solo si el estado, los procesos
# vivos y los recursos de Docker pertenecen a esta instancia. No modifica nada.
verify_instance() {
  local ok=0 f pid cwd svc
  if [ ! -d "$STATE" ]; then
    echo "  no existe el estado de la instancia: $STATE" >&2
    return 1
  fi
  if [ -f "$MARKER" ]; then
    grep -qx "prefix=$PREFIX" "$MARKER" || { echo "  $MARKER no es de '$PREFIX'" >&2; ok=1; }
    grep -qx "root=$ROOT" "$MARKER" || { echo "  $MARKER no es de $ROOT" >&2; ok=1; }
  elif [ "$IS_DEFAULT" != 1 ]; then
    echo "  falta el marcador $MARKER (¿estado de otra instancia?)" >&2
    ok=1
  fi
  for f in "$STATE"/*.pid; do
    [ -e "$f" ] || continue
    svc="$(basename "$f" .pid)"
    case " ${SERVICES[*]} " in *" $svc "*) ;; *)
      echo "  archivo PID inesperado: $f" >&2; ok=1; continue ;;
    esac
    pid="$(cat "$f")"
    [[ "$pid" =~ ^[0-9]+$ ]] || { echo "  PID inválido en $f" >&2; ok=1; continue; }
    pid_alive "$pid" || continue # obsoleto: el proceso ya no existe
    cwd="$(proc_cwd "$pid")"
    if [ "$cwd" != "$ROOT/apps/$svc" ]; then
      echo "  el PID $pid ($svc) no corre en $ROOT/apps/$svc (cwd=${cwd:-desconocido})" >&2
      ok=1
    fi
  done
  container_exists "$PG_CONTAINER" && { owns_resource container "$PG_CONTAINER" || ok=1; }
  container_exists "$REDIS_CONTAINER" && { owns_resource container "$REDIS_CONTAINER" || ok=1; }
  container_exists "$LK_CONTAINER" && { owns_resource container "$LK_CONTAINER" || ok=1; }
  if container_exists "$PG_CONTAINER"; then
    docker inspect -f '{{ range .Mounts }}{{ .Name }} {{ end }}' "$PG_CONTAINER" | grep -qw "$VOLUME" ||
      { echo "  $PG_CONTAINER no monta el volumen $VOLUME" >&2; ok=1; }
  fi
  volume_exists "$VOLUME" && { owns_resource volume "$VOLUME" || ok=1; }
  return "$ok"
}

live_pids() { # imprime "servicio pid" de los procesos vivos de la instancia
  local f pid
  for f in "$STATE"/*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f")"
    pid_alive "$pid" && echo "$(basename "$f" .pid) $pid"
  done
}
