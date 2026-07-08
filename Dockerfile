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
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# ---- build: instala TODAS las deps (tsx corre en runtime, no se podan) y
#      valida tipos (pnpm build = tsc --noEmit en todo el monorepo). ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---- runtime: slim, no-root. El `command` concreto (api | worker) lo fija
#      docker-compose; por defecto arranca el API. ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# El usuario `node` viene con la imagen oficial; el proceso jamás corre como root.
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@fluvia/api", "start"]
