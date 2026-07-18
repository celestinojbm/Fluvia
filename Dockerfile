# syntax=docker/dockerfile:1.24.0@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# ============================================================================
# Imagen única del backend de Fluvia (API + worker). Ambos corren el monorepo
# vía tsx (dependencia usada en runtime); el servicio elige la app con `command`
# en docker-compose. Multi-stage: `build` instala + valida tipos; `runtime` es
# slim y corre como usuario no-root.
# ============================================================================
# Base pineada por DIGEST (threat model §5 — cadena de suministro): un tag es
# mutable (quien controle el registry puede re-apuntarlo); el digest fija la
# capa base y hace del upgrade un cambio EXPLÍCITO en el diff (Dependabot
# propone el bump del digest de este `FROM` cuando el tag avanza). El frontend
# BuildKit de la línea 1 (`docker/dockerfile`) — que BuildKit DESCARGA Y EJECUTA
# para parsear este archivo — va ahora igualmente pineado por digest, y las
# actions de CI por SHA de commit: mismo vector cerrado en toda la cadena.
# Nota: Dependabot bumpea el `FROM` y las actions, pero NO la directiva
# `# syntax=` (solo parsea `FROM`); su digest se revisa/bumpea a mano, junto con
# la base — costo deliberado de la inmutabilidad frente a un frontend ejecutable.
FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Hornea el pnpm pineado (packageManager) en la capa base para que el runtime
# (FROM base) NO tenga que descargarlo en el primer uso (sin red en runtime).
# CA de build OPCIONAL y EFIMERA (RA-F65C3-EXT-007): entornos cuyo egress TLS
# esta interceptado por una CA propia la montan como BuildKit secret
# (`--secret id=fluvia_build_ca,src=...`). El secret vive SOLO durante este
# RUN (tmpfs, jamas una capa), se referencia via NODE_EXTRA_CA_CERTS SOLO
# dentro del RUN, no se copia, no queda en ENV, ni en history, ni en el
# filesystem final. Sin secret, el build se comporta exactamente igual.
RUN --mount=type=secret,id=fluvia_build_ca,required=false \
    if [ -s /run/secrets/fluvia_build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/fluvia_build_ca; fi \
    && corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# ---- build: instala TODAS las deps (tsx corre en runtime, no se podan) y
#      valida tipos (pnpm build = tsc --noEmit en todo el monorepo). ----
FROM base AS build
COPY . .
RUN --mount=type=secret,id=fluvia_build_ca,required=false \
    if [ -s /run/secrets/fluvia_build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/fluvia_build_ca; fi \
    && pnpm install --frozen-lockfile
RUN pnpm build

# ---- runtime-pruned: etapa INTERMEDIA (jamas se publica como artefacto app)
#      que poda el tooling de seeds ANTES de que /app entre a la imagen final.
#      F6.5C3 + RA-F65C3-EXT-002: el tooling de seeds es LOCAL (local/test) y
#      `demo:reset` es ademas DESTRUCTIVO — jamas viaja en la imagen app (plan
#      F6.5C §6). Un `rm` DESPUES de un COPY solo oculta el contenido en la
#      capa superior: el codigo seguiria recuperable desde la capa inferior
#      del artefacto OCI. Por eso el pruning ocurre AQUI y la etapa final copia
#      UNICAMENTE el snapshot ya podado: ninguna capa del manifiesto final
#      contiene packages/seeds. Se eliminan tambien symlinks del workspace
#      hacia @fluvia/seeds (node_modules/.pnpm incluidos), caches de build y
#      los scripts `seed`/`showroom:seed`/`demo:reset` del package.json de
#      ESTE snapshot (el package.json del repo para desarrollo local no
#      cambia; el flujo showroom/demo corre siempre desde el checkout).
#      Ningun paquete runtime depende de @fluvia/seeds (verificado por tests).
FROM build AS runtime-pruned
RUN rm -rf /app/packages/seeds \
      /app/node_modules/@fluvia/seeds \
      /app/node_modules/.pnpm/node_modules/@fluvia/seeds \
      /app/.turbo /app/node_modules/.cache && \
    find /app -name .turbo -type d -prune -exec rm -rf {} + && \
    find /app -type l \( -lname '*packages/seeds*' -o -lname '*@fluvia/seeds*' \) -delete && \
    node -e "const fs=require('fs');const p='/app/package.json';const pkg=JSON.parse(fs.readFileSync(p,'utf8'));for(const s of ['seed','showroom:seed','demo:reset'])delete pkg.scripts[s];fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n');" && \
    if find /app \( -path '*packages/seeds*' -o -path '*@fluvia/seeds*' \) -print -quit | grep -q .; then \
      echo 'runtime-pruned: seeds tooling still present' >&2; exit 1; \
    fi

# ---- runtime: slim, no-root, SIN heredar ninguna capa de build. La UNICA
#      copia de /app procede del snapshot ya podado (runtime-pruned); la etapa
#      final NO ejecuta ningun rm posterior al COPY. El `command` concreto
#      (api | worker) lo fija docker-compose; por defecto arranca el API. ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=runtime-pruned /app /app
# El usuario `node` viene con la imagen oficial; el proceso jamás corre como root.
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@fluvia/api", "start"]
