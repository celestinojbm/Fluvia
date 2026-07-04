# Arquitectura del sistema

Estado: Activo · Fase: 0 · ADR-0001 (monolito modular), ADR-0002 (Postgres), ADR-0010 (Fastify)

## 1. Forma general

**Monolito modular TypeScript** desplegado como pocas unidades de proceso:

```
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│  apps/api  │  │ dashboard  │  │  checkout  │  │   admin    │   (Next.js, Fase 3+)
│  Fastify   │  └────────────┘  └────────────┘  └────────────┘
└─────┬──────┘
      │ importa paquetes de dominio (no HTTP interno)
┌─────▼───────────────────────────────────────────────┐
│ packages/: payments-core · ledger · provider-adapters│
│ webhooks · auth · reconciliation · money · database  │
│ shared-types · config · observability · security     │
└─────┬───────────────────────────────────────────────┘
      │                                   ┌──────────────┐
┌─────▼──────┐   outbox/inbox (Postgres)  │ apps/worker  │
│ PostgreSQL │◄──────────────────────────►│ relay+jobs   │
└────────────┘                            └──────┬───────┘
      ▲                                          │ HTTP (webhooks salientes,
┌─────┴──────┐                                   ▼  llamadas a proveedor)
│   Redis    │  cache / locks cortos / rate-limit│
└────────────┘                          proveedores externos
```

Reglas de módulo (V4 §11): responsabilidad clara, interfaz exportada, sin acceso directo a tablas de otro dominio (cada paquete posee sus tablas; el cruce va por interfaz), eventos internos vía outbox, testeable de forma aislada, extraíble con evidencia. No hay microservicios en el MVP.

## 2. Stack (Nivel B, cambios vía ADR)

| Capa | Elección | Nota |
|------|----------|------|
| Lenguaje | TypeScript strict, ESM, Node ≥ 20 | `any` prohibido en código financiero/seguridad |
| Monorepo | pnpm + Turborepo, lockfile + save-exact | operativo desde el spike |
| API | Fastify + Zod, REST `/v1`, OpenAPI generado | ADR-0010; NestJS descartado con justificación |
| Persistencia | PostgreSQL 16; SQL explícito (`pg`) en núcleo financiero | ADR-0003; Kysely se evaluará para CRUD no crítico en F1 |
| Cache/coordinación | Redis 7 | jamás única fuente duradera |
| Frontends | Next.js + Tailwind (dashboard, checkout, admin) | Fase 3; checkout SEPARADO del dashboard |
| Workers | proceso Node dedicado (`apps/worker`): outbox relay, webhook delivery, jobs de conciliación | claim con `FOR UPDATE SKIP LOCKED` |
| Observabilidad | pino (logs estructurados + correlation id), OpenTelemetry, métricas Prometheus | base en F1 |

## 3. Límites duros de runtime

1. Ninguna llamada de red dentro de una transacción SQL (Nivel A) — el patrón outbox/inbox es el único puente.
2. Todo dato externo pasa por schema Zod en el borde; `unknown` hasta validar.
3. Contexto de tenant solo por `set_config(..., local)` dentro de transacción (ver `multi-tenancy.md`).
4. Dinero solo como `Money` (bigint unidades menores) — el tipo no expone conversión a float.
5. Estados de FSM solo mutables por el servicio de dominio correspondiente.

## 4. Entornos (V4 §43)

`local` (docker-compose: Postgres, Redis, mock provider, mailhog), `test` (CI), `sandbox`, `staging`, `production` — credenciales, bases, secretos y API keys distintos por entorno; identificación visual en UIs; claves con prefijo por entorno (`fluvia_sk_test_…` / `fluvia_sk_live_…`).

## 5. Observabilidad — SLO baseline (Nivel C, ajustar con medición)

- p99 latencia API sandbox < 500 ms; p99 posting de ledger < 150 ms.
- Retraso de entrega de webhooks p95 < 60 s; tasa de fallo tras reintentos < 0.1%.
- Drift de proyecciones detectado: alerta < 5 min; objetivo de ocurrencia: 0.
- Profundidad de outbox pendiente: alerta si > umbral por 5 min.

Métricas mínimas y catálogo completo: V4 §39 adoptado íntegro; tablero inicial en F1-07.
