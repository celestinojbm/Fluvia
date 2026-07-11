# Registro de decisiones

Estado: Activo · Índice ejecutivo; el detalle vive en los ADR (`../adr/`)

## Decisiones aceptadas (Fase 0)

| # | Decisión | Nivel V4 | ADR |
|---|----------|----------|-----|
| 1 | Monolito modular TypeScript; api + worker + frontends Next.js | B (confirmado) | 0001 |
| 2 | PostgreSQL única fuente durable; Redis solo acelerador | B (confirmado) | 0002 |
| 3 | SQL explícito (`pg`) en núcleo financiero; Kysely a evaluar para CRUD | B | 0003 |
| 4 | Ledger interno reducido; Formance solo referencia/extracción futura | B | 0004 |
| 5 | RLS forzado + contexto exclusivamente SET LOCAL transaction-scoped; roles app/worker | B | 0005 |
| 6 | Idempotencia durable en Postgres, misma transacción que el efecto | A/B | 0006 |
| 7 | Outbox + Inbox sobre Postgres con SKIP LOCKED, DLQ y replay auditado | B | 0007 |
| 8 | Money VO propio bigint (sin dinero.js) | B | 0008 |
| 9 | Webhooks salientes internos, contrato compatible-Svix | B | 0009 |
| 10 | Fastify + Zod sin NestJS | B | 0010 |
| 11 | Organization = frontera de tenant RLS; Merchant = autorización de aplicación | B | en `multi-tenancy.md` |
| 12 | IDs públicos: UUID aleatorio + prefijo de recurso | B | en `data-model.md` |
| 13 | Catálogo de eventos MVP normalizado (sin `charge.*`) | C | auditoría D3 |
| 14 | Purga de datos técnicos por clasificación (excepción controlada al no-DELETE) | B | `data-classification.md` |
| 15 | **País inicial: Colombia** (decidido por el propietario, 2026-07-04). Sin reglas legales codificadas hasta completar la matriz con revisión legal | Producto | `compliance/jurisdiction-matrix.md` |
| 16 | **Paquete de Fase 0 y ADRs 0001–0010 aprobados** por el propietario (2026-07-04) → Fase 1 desbloqueada | Gobernanza | ex PEND-003 |
| 17 | **Auditoría Independiente v1 integrada** (2026-07-04): informe inmutable en `docs/audits/independent-audit-v1/`; reconciliación evidencia-por-hallazgo en `audit-integration-plan-v1.md`; lote AUD-1 ejecutado; veredicto adoptado (continuar; congelar pagos públicos/live hasta cerrar bloqueantes) | Gobernanza | `docs/audits/` |
| 18 | **Reservas = cuentas del Chart, no bucket de proyección** (AUD-P2-013): `merchant.reserve`/`dispute.reserve`/`refund.liability` como cuentas; buckets solo `available`/`pending`. Cambiarlo exigirá ADR | B | `ledger-design.md` §2 |
| 19 | **Credenciales `live` bloqueadas por código** (AUD-P2-003): `LiveKeysDisabledError` hasta pasar production gates + decisión humana (PEND-004). Opción más restrictiva y reversible | A/B | `api-keys.ts` |
| 20 | **Rol dedicado del relay sin BYPASSRLS** (cierra AUD-P1-007): `fluvia_relay` con políticas RLS explícitas y UPDATE por columna solo en `outbox_events`; `fluvia_worker` reducido a cascarón; NINGÚN rol de runtime con BYPASSRLS (meta-test) | B | 0011 |
| 21 | **Inbox con el mismo patrón de rol mínimo** (F2-12, aplica ADR-0011): `fluvia_inbox` acotado a `provider_events`+DLQ; la API solo INSERT. Firma de webhooks entrantes: HMAC-SHA256 de `timestamp.body` con timestamp firmado, tolerancia ±5 min, comparación tiempo-constante; verificación SIEMPRE antes de persistir | B | `outbox-inbox.md` §3 |
| 22 | **Reversiones: únicas e irreversibles** (F2-07): una tx se revierte a lo sumo una vez (índice único de motor decide carreras); prohibido revertir una reversión — correcciones posteriores son transacciones forward nuevas; razón humana obligatoria con auditoría atómica | B | `ledger-design.md` §4 |
| 24 | **F3-01 adelantado a la re-auditoría** (propietario, 2026-07-05): los 5 bloqueantes P1 que motivaron la congelación están cerrados, y F3-01 es plano interno (schema+FSM+servicio, CERO endpoints). La solicitud de re-auditoría se pospone por decisión del propietario. La exposición pública de pagos (F3-02+ en sandbox abierto) sigue condicionada a re-auditoría y PEND-006 | Gobernanza | `f3-01-payment-intents.md` |
| 23 | **Modelo MFA: TOTP RFC 6238 + códigos de respaldo, sin SMS** (ex PEND-005; el propietario eligió la opción b con esta propuesta sobre la mesa, 2026-07-04). Secreto cifrado en reposo (AES-256-GCM, `MFA_SECRET_KEY`); anti-replay por step; fallos MFA → mismo lockout; step-up de 15 min para `keys:manage`. Reversible antes de exponer usuarios reales | B | F1-04b; migración 0014 |
| 25 | **Pricing sandbox v1: fee de plataforma 2% por transacción** (ex PEND-002; el propietario decidió «2% por el momento», 2026-07-06). 200 bps configurable por `PLATFORM_FEE_BPS`; motor `FlatBpsFeeSchedule` (redondeo por mayor residuo, invariante 0 ≤ Ff ≤ monto); la captura ya devengaba el margen `Ff−Fp`, esto fija cuánto cobra Fluvia. Reversible — es «por el momento», no el modelo comercial definitivo | Producto | F4-05c; `pricing.ts` |
| 26 | **Merge del stack F4+F6 (PRs #2–#10) a `claude/new-session-haeo7h`** (propietario, 2026-07-09, «Opción A»): merge commits (sin squash), orden estricto #2→#10 con re-apuntado del siguiente PR y CI verde tras CADA merge (runs #281, #304, #305, #306, #309, #314, #317, #318, #319 — todos push a la rama por defecto). Baseline de re-auditoría: `d60e45956bef4c1cc696ff4e3cca31c8bc8346d1`. Los PRs de dependabot que aparecieron tras el merge quedan SIN mergear (del propietario; no mover el baseline durante la re-auditoría) | Gobernanza | `audit-closure-register-v1.md` §Evidencia CI |
| 27 | **Merge de PR #23 (RA-F6-001) autorizado tras la aprobación del delta audit** (propietario, 2026-07-10): aprobación LIMITADA a RA-F6-001 (head auditado `227efca`); merge commit `888db82`, CI post-merge run #327 verde — **baseline actual**. La aprobación NO autoriza Fase 5, ni levantar el freeze (#24), ni `live`, ni proveedor real, ni producción. RA-F6-002…005 se integran como ABIERTOS y se remedian en PRs aislados (plan en el registro) | Gobernanza | `audit-closure-register-v1.md` §Re-auditoría F6 delta |
| 28 | **F6 APROBADA para el alcance `sandbox cerrado / hardening sandbox` tras la ratificación de Hermes** (propietario, 2026-07-11). Baseline aprobado: `claude/new-session-haeo7h` @ `8f126c4049653b11e6a46903c68d9138e8c2a4ab` (merge del PR #30; CI run #368 verde). Condición: Hermes cerró el delta final (RA-F6-002/003/005) + ratificación corta de F6-DELTA-001; RA-F6-001 cerrado por delta parcial previo; **0 P0/P1/P2 del delta F6**. **Límites (siguen bloqueados):** NO producción, NO Fase 5, NO `live`, NO proveedor real, NO dinero real, NO exposición pública, NO sandbox compartido, NO release público/comercial, NO levantar freeze #24. **Fase 5 requiere una decisión humana separada del propietario.** Producción sigue no autorizada; revisión legal LGPLv3 antes del primer release público/comercial | Gobernanza | `audit-closure-register-v1.md` §F6 Final Approval |

## Decisiones PENDIENTES que requieren humano

| ID | Decisión | Bloquea | Contexto |
|----|----------|---------|----------|
| **PEND-004** | Política definitiva de credenciales `live` (¿qué gates exactos + quién autoriza la primera emisión?) | Nada hoy (creación bloqueada por código, decisión #19) | AUD-P2-003; `production-gates.md` |
| **PEND-006** | Condiciones para abrir sandbox compartido a terceros | Exposición pública del sandbox | Requiere F1-04b + AUD-P2-015 |

Resueltas: ~~PEND-001~~ → Colombia (decisión #15). ~~PEND-002~~ → fee 2% por transacción (decisión #25). ~~PEND-003~~ → aprobado (decisión #16). ~~PEND-005~~ → TOTP + backup codes (decisión #23).

## Supuestos adoptados (más seguros y reversibles, §2)

1. Moneda de sandbox USD + CLP para tests de exponente 0 — reversible, no codifica jurisdicción.
2. Retención de idempotency keys 24 h en sandbox — Nivel C, configurable.
3. Baselines de SLO de `system-overview.md` §5 — Nivel C, se ajustan con medición.
