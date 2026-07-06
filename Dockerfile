# syntax=docker/dockerfile:1
# ============================================================================
# Imagen única del backend de Fluvia (API + worker). Ambos corren el monorepo
# vía tsx (dependencia usada en runtime); el servicio elige la app con `command`
# en docker-compose. Multi-stage: `build` instala + valida tipos; `runtime` es
# slim y corre como usuario no-root.
# ============================================================================
FROM node:22-slim AS base
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
