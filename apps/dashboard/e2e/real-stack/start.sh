#!/usr/bin/env bash
# Verificación LOCAL del justificante contra el stack real del sandbox:
# PostgreSQL 16 + Redis + API (MockProvider) + checkout + dashboard.
# Requisitos previos: PG y Redis escuchando en 127.0.0.1, `pnpm migrate` y
# `pnpm seed` aplicados, `next build` hecho en apps/checkout y apps/dashboard.
# Uso: apps/dashboard/e2e/real-stack/start.sh <dir-de-logs>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
LOGS="${1:?dir de logs}"
mkdir -p "$LOGS"
export NODE_ENV=local
export ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/fluvia
export APP_DATABASE_URL=postgres://fluvia_app:fluvia_app_dev_password@127.0.0.1:5432/fluvia
export WORKER_DATABASE_URL=postgres://fluvia_worker:fluvia_worker_dev_password@127.0.0.1:5432/fluvia
export RELAY_DATABASE_URL=postgres://fluvia_relay:fluvia_relay_dev_password@127.0.0.1:5432/fluvia
export AUTH_DATABASE_URL=postgres://fluvia_auth:fluvia_auth_dev_password@127.0.0.1:5432/fluvia
export INBOX_DATABASE_URL=postgres://fluvia_inbox:fluvia_inbox_dev_password@127.0.0.1:5432/fluvia
export WEBHOOK_DATABASE_URL=postgres://fluvia_webhook:fluvia_webhook_dev_password@127.0.0.1:5432/fluvia
export REDIS_URL=redis://127.0.0.1:6379
export NEXT_TELEMETRY_DISABLED=1

# API real con la bandera de timeout de devolución de un solo uso.
(cd "$ROOT/apps/api" && CHECKOUT_BASE_URL=http://127.0.0.1:3100 PORT=3000 \
  FLUVIA_E2E_REFUND_TIMEOUT_FLAG="$LOGS/refund-timeout.flag" \
  setsid npx tsx e2e/refund-timeout-server.ts >"$LOGS/api.log" 2>&1 &)
(cd "$ROOT/apps/checkout" && FLUVIA_API_URL=http://127.0.0.1:3000 \
  setsid npx next start -p 3100 >"$LOGS/checkout.log" 2>&1 &)
(cd "$ROOT/apps/dashboard" && FLUVIA_API_URL=http://127.0.0.1:3000 \
  FLUVIA_DASHBOARD_ORIGIN=http://127.0.0.1:3200 \
  setsid npx next start -p 3200 >"$LOGS/dashboard.log" 2>&1 &)

for url in http://127.0.0.1:3000/health http://127.0.0.1:3100 http://127.0.0.1:3200/login; do
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "$url" && break
    sleep 1
  done
  curl -s -o /dev/null -w "$url %{http_code}\n" "$url"
done
