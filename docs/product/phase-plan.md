# Plan por fases

Estado: Activo · **Fases 1–4 COMPLETAS** (Fase 4 cerrada 2026-07-07 — Gate Conciliación cumplido; **lista para re-auditoría**, `docs/audits/`) · Fase 5/6 según decisión del propietario · Basado en V4 §50, ajustado con criterio propio (los ajustes están anotados)

| Fase | Objetivo | Entregables clave | Criterio de salida |
|------|----------|-------------------|--------------------|
| **0 — Descubrimiento y decisiones** ✅ | Cerrar decisiones críticas antes de construir | Este paquete documental completo (`docs/README.md`) + spike de validación (Money, RLS, inmutabilidad) | 30 entregables de §52 publicados; ADRs 0001–0010 aceptados |
| **1 — Fundación** ✅ | Plataforma mínima segura sin dinero | Monorepo+CI, Postgres+migraciones, Redis, config por entorno, auth (registro/login/MFA), organizations, merchants, RBAC, RLS activo y probado, audit log, observabilidad base, taxonomía de errores | Tests de tenant-escape verdes en CI; audit log operativo; pipeline completo (lint, types, unit, integration) |
| **2 — Núcleo financiero** ✅ | Motor contable correcto bajo concurrencia | Money (promovido del spike), ledger + Chart of Accounts, idempotencia, outbox, inbox, proyecciones de balance, suites de concurrencia y property-based | Gate Ledger + Gate Idempotencia en verde; script de invariantes fuera del ORM ejecutándose en CI |
| **3 — Sandbox de pagos** ✅ | Flujo de pago E2E simulado | Payment intents + FSMs, MockProvider, checkout, payment links, customers, webhooks salientes, refunds, dashboard mínimo | Flujo E2E de `mvp-scope.md` §1 verde en CI |
| **4 — Conciliación y operaciones** ✅ **(cerrada 2026-07-07)** | Operar lo construido | Reconciliation + casos, panel admin, reserves/fees/settlement/payout/disputas como abstracciones contables, runbooks | **Gate Conciliación en verde; los 7 runbooks probados en drill (F4-06b)** ✅ |
| **5 — Proveedor real en sandbox** | Primer proveedor autorizado | Adapter real, tokenización del proveedor, firmas, refunds reales sandbox, reportes, contract tests, E2E | Contract tests del adapter real y del mock idénticos y verdes |
| **6 — Hardening** | Resistencia y seguridad | Security review, concurrencia, performance, load, soak, chaos, restore drills, revisión PCI scope, revisión threat model | Gate Seguridad + Gate Restore en verde |
| **7 — Production readiness** | Solo con gates completos | Evidencia de §51 completa | Autorización humana explícita |

Ajustes respecto al V4:
1. Los **contract tests del adapter** se escriben en Fase 3 contra el MockProvider (no en Fase 5): el proveedor real debe pasar una suite que ya existe.
2. La **taxonomía de errores de API** se adelanta a Fase 1 (deficiencia D2 de la auditoría).
3. i18n/WCAG AA se materializan en Fase 3 con la primera UI (deficiencia D9).

Regla transversal: la idempotencia (Fase 2) existe **antes** de exponer el primer endpoint financiero mutante (Fase 3), como exige §49.
