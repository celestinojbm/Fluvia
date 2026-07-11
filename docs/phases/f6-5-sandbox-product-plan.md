# F6.5 — Product Sandbox Completion (plan)

Estado: **PLANIFICADA — registrada por decisión #31** · Etapa **100% sandbox cerrado** (dentro del alcance aprobado por la decisión #28) · Este documento es el plan; **F6.5A–D se ejecutan en PRs separados y cada uno requiere autorización individual del propietario**.

Baseline: `claude/new-session-haeo7h` @ `0154c34d10346564b4076a829a8045fba88c86d1`.

Restricciones vigentes que F6.5 NO altera: **F5.1–F5.4 bloqueadas** · MockProvider único proveedor · sin proveedor real, credenciales reales ni `live` · sin exposición pública ni deploy (freeze #24) · sin sandbox compartido (PEND-006) · producción no autorizada · `docs/audits/independent-audit-v1/` inmutable · decisiones legales/licencias intactas.

> **Regla de oro**: F6.5 **consume la API que ya existe**; solo se añade un endpoint nuevo si es de lectura/export o estrictamente necesario para una acción UI ya soportada por el dominio. El núcleo auditado (ledger, idempotencia, webhooks runtime, migraciones de invariantes) no se toca salvo necesidad demostrada con ADR previo. **Badge «SANDBOX — dinero simulado» obligatorio en toda UI nueva** (honestidad Nivel A visible en el producto).

## 1. Resumen ejecutivo

El backend de Fluvia está mucho más maduro que su superficie de producto. La API expone el ciclo completo (intents, checkout sessions, payment links, refunds, payouts, disputas con evidencia, casos operativos con four-eyes, settlement reports, webhook events/endpoints, customers, auth con MFA) y el checkout hosted existe; pero el dashboard solo cubre la mitad operativa (casos, conciliación, disputas, payouts, merchants, audit events) y no tiene páginas para lo más básico del producto: ver pagos, refunds, sesiones de checkout, gestionar webhooks o API keys. Tampoco hay onboarding UI, export CSV, dataset demo «showroom» ni guion de demostración. **F6.5 cierra esa brecha sin tocar el núcleo auditado**: mayormente UI sobre endpoints existentes, más demo data, export y documentación de uso. Riesgo técnico bajo; el riesgo real es scope creep hacia F5.1 — contenido por los guardrails de §13.

## 2. Baseline y estado actual

F6 aprobada para sandbox cerrado / hardening (decisión #28, ratificación de Hermes). Plan F5 versionado (decisión #29) y F5.0 registrado documentalmente (decisión #30); la revisión legal externa queda pendiente por decisión del propietario y **no bloquea F6.5** (que es 100% sandbox cerrado, sin dinero real ni terceros).

## 3. Qué ya existe en el producto sandbox (inspección 2026-07-11 sobre `0154c34`)

- **API** (`apps/api`): ~55 rutas `/v1` — payment intents (create/confirm/cancel/get/list), checkout sessions (+confirm/status), payment links (+sessions), refunds, payouts, disputes (+evidence), operational cases (+ack/resolve; case adjustments approve/reject con four-eyes), settlement reports (+entries), webhook events, webhook endpoints, customers, organizations/account, auth (sesión, logout, MFA setup/activate/disable, verify-email). Rate limit, error catalog, card-data-guard, metrics.
- **Checkout** (`apps/checkout`): página de sesión `c/[id]` + payment link `l/[id]`; `requires_action` asíncrono tipo PSE modelado en el FSM.
- **Dashboard** (`apps/dashboard`): login (MFA en API), home de org, cases, reconciliation (+detalle), disputes (+detalle+acciones), events (audit), payouts (+detalle), merchants — con tests de vista.
- **Núcleo**: ledger [1]–[9] + hash-chain + anclaje, idempotencia con timeouts, outbox/inbox, conciliación F4, RBAC (owner/admin/analyst/finance), auditoría, seeds deterministas (`pnpm seed`), drills, observabilidad, CI con gates duros.

## 4. Qué está suficientemente maduro

Núcleo financiero completo y auditado (no se toca) · ciclo de pago end-to-end por API · checkout hosted · panel operativo (casos/conciliación/disputas/payouts) · auth+MFA+RBAC · seeds base · CI.

## 5. Qué falta para que se sienta producto completo

1. **Dashboard — páginas «de producto»**: payments (lista+detalle+timeline), refunds (lista+crear), checkout sessions, payment links (crear/copiar URL), settlement reports (la ruta existe, la página no), customers.
2. **Webhooks como feature visible**: UI de endpoints (crear/rotar secreto), historial de entregas con reintento.
3. **API keys UI** (la API ya exige MFA step-up para `keys:manage`).
4. **Onboarding**: sin signup/registro ni crear-organización guiado en UI — hoy todo nace por seeds.
5. **Demo data rica + guion**: dataset «showroom» determinista (varios merchants, pagos en todos los estados, disputas, payouts, reportes de conciliación con diferencias) + comando de reset + guion de demo.
6. **Reporting/export**: no hay CSV/export en ninguna ruta.
7. **Documentación de uso interno**: guía de «cómo demostrar Fluvia».
8. **Badge de honestidad**: «SANDBOX — dinero simulado» en checkout y dashboard.

## 6. Alcance de F6.5

Completar la **superficie de producto** sobre la API existente: páginas de dashboard faltantes, gestión de webhooks/API keys en UI, onboarding mock, demo data + guion, export CSV de lectura, docs de uso interno, tests de vista y smoke e2e.

## 7. Qué NO incluye F6.5

Proveedor real o adaptador (F5.1/F5.3) · credenciales reales · `live` · exposición pública o deploy (freeze #24) · sandbox compartido (PEND-006) · emails reales (verify-email queda mock/log) · datos reales · cambios de gates/licencias/`independent-audit-v1/` · secret manager vendor (F5.2) · rediseño del FSM del MockProvider · declaraciones de «listo para producción».

## 8. Módulos/áreas a trabajar

| Área | Acción en F6.5 |
| --- | --- |
| Checkout | Pulir UX (estados claros, badge SANDBOX, recibo simulado); ya funcional |
| Dashboard | Páginas nuevas: payments, refunds, checkout-sessions, payment links, settlements, customers, webhooks, API keys |
| Merchant/account | Onboarding mock guiado (crear org/merchant desde UI, con auditoría) |
| MockProvider | Exponer «escenarios» vía demo data; NO cambiar su FSM |
| Webhooks simulados | UI de endpoints + entregas + resend (rutas ya existen) |
| Refunds | UI de creación (reusa `POST /v1/refunds` con idempotency-key) + lista/detalle |
| Disputes | Ya cubierto; pulir evidencia/timeline |
| Payouts simulados | Ya cubierto; enlazar desde merchant |
| Reconciliation | Ya cubierto; enlazar a settlement reports UI |
| Ledger visibility | Vista de **solo lectura** por merchant (balances/entradas) |
| Reporting/export | Endpoints CSV de **lectura** (settlement entries, payments, payouts) |
| Audit log | Ya cubierto (events); añadir filtros |
| RBAC/permisos | Ya existe; cada página nueva respeta roles (tests por rol) |
| Demo data | Dataset showroom determinista + `demo:reset` + guion |
| Observability | Nada nuevo; smoke sobre metrics existentes |
| Tests | Test de vista por página nueva + smoke e2e del recorrido demo |
| Documentación | `docs/product/sandbox-demo-guide.md` (uso interno) |

## 9–10. Milestones (cada uno en PR(s) separados, con autorización individual)

### F6.5A — Superficie de pagos en dashboard

- **Objetivo**: páginas payments (lista+detalle+timeline de estados), refunds (lista+crear), checkout sessions, payment links (crear/copiar). Badge SANDBOX global.
- **Alcance**: UI + tests; cero cambios de API salvo algún GET de detalle si faltara (docs-only justificado en el PR).
- **Archivos/áreas probables**: `apps/dashboard/app/o/[orgId]/{payments,refunds,checkout-sessions,links}/…` + `apps/dashboard/app/lib/*-view.tsx` + tests.
- **Riesgos**: acciones de escritura desde UI (refund/link) — mitigar reusando exactamente los endpoints existentes con idempotency-key.
- **Tests**: test de vista por página (patrón existente) + tests de acción + RBAC por rol.
- **Criterio de salida**: recorrido pago→refund completo desde el navegador; suite verde; invariantes [1]–[9]; evidencia CI.
- **Auditoría externa**: no; revisión adversarial interna (disciplina de la casa).

### F6.5B — Developer surface: webhooks + API keys UI

- **Objetivo**: página de webhook endpoints (crear/rotar secreto/desactivar), entregas con resend; página de API keys (crear/revocar con el MFA step-up ya implementado).
- **Alcance**: UI sobre rutas existentes; sin cambios de runtime de webhooks/auth.
- **Archivos/áreas probables**: `apps/dashboard/app/o/[orgId]/{webhooks,api-keys}/…` + libs + tests.
- **Riesgos**: superficie de seguridad — no relajar step-up ni firmas.
- **Tests**: vistas + flujo step-up + no-regresión de seguridad.
- **Criterio de salida**: un developer configura webhooks y keys sin tocar la API a mano; suite verde.
- **Auditoría externa**: no; **sí** revisión adversarial interna enfocada en auth.

### F6.5C — Onboarding mock + demo data showroom

- **Objetivo**: signup/crear-org guiado (mock, sin email real), merchant onboarding desde UI; dataset demo rico determinista + `demo:reset` + guion de demo paso a paso.
- **Alcance**: UI de onboarding + `packages/seeds` (dataset showroom) + guion.
- **Archivos/áreas probables**: `apps/dashboard/app/(signup|onboarding)/…`, `packages/seeds/src/…`, `docs/product/…`.
- **Riesgos**: onboarding toca identity/auth — mantener las mismas validaciones; los seeds NO deben burlar invariantes (sembrar vía servicios, no SQL directo).
- **Tests**: onboarding e2e (API), determinismo del seed, invariantes [1]–[9] verdes tras el seed.
- **Criterio de salida**: demo completa desde cero en <10 min con el guion.
- **Auditoría externa**: no.

### F6.5D — Export, docs y cierre

- **Objetivo**: endpoints CSV (lectura), filtros de audit, `sandbox-demo-guide.md`, smoke e2e del recorrido completo, actualización STATE/HANDOFF/BACKLOG, cierre de F6.5 con evidencia.
- **Alcance**: export de lectura + docs + smoke.
- **Archivos/áreas probables**: `apps/api/src/routes/…` (solo GET/export), `apps/dashboard` (botones export), `docs/product/…`.
- **Riesgos**: export = riesgo de fuga entre tenants si se hace mal — RLS + tests de tenant-escape sobre los endpoints nuevos.
- **Tests**: CSV correcto + aislamiento multi-tenant del export.
- **Criterio de salida**: F6.5 cerrada con evidencia CI; **opcional** (decisión del propietario): delta audit del incremento UI antes de darla por cerrada.
- **Auditoría externa**: opcional al final del conjunto (F6.5A–D añaden superficie de escritura en dashboard; un delta corto sería coherente con la disciplina del repo, pero no es gate).

## 11. Riesgos técnicos

Flake conocido de DB compartida en CI (gestionado con reruns autorizados) · acciones de escritura desde UI mal idempotentes (mitigar: reusar endpoints con idempotency-key) · export CSV cruzando tenants (RLS + tests) · seeds que burlen invariantes (sembrar vía servicios) · páginas server-side de Next filtrando datos sin RBAC (tests por rol).

## 12. Riesgos de scope creep

«Ya que estamos, conectemos un proveedor de prueba real» (**es F5.1 — NO**) · «abramos el sandbox a un amigo» (**PEND-006 — NO**) · emails reales de verificación (**NO** — mock/log) · «deploy a un VPS para la demo» (**freeze #24 — NO**; la demo es local) · rediseñar el FSM del MockProvider (innecesario) · tocar el núcleo «para facilitar la UI» (exige ADR).

## 13. Guardrails para no cruzar a F5.1 ni producción

1. Regla por PR: la lista de archivos **no puede tocar** `packages/{ledger,idempotency}`, `packages/db/migrations` ni `.github/`, salvo ADR previo aprobado por el propietario.
2. Ningún PR introduce dependencias de proveedores de pago ni SDKs externos de pagos.
3. **Badge «SANDBOX — dinero simulado» visible en toda UI nueva.**
4. `LiveKeysDisabledError` y el gate de licencias `--strict` quedan intactos (CI lo verifica).
5. Cada milestone termina con: suite verde + invariantes [1]–[9] + drills + revisión adversarial interna + evidencia CI en el registro.
6. Un PR por incremento acotado; **merge solo con autorización explícita del propietario** (protocolo de siempre).

## 14. Primer PR técnico recomendado después de este docs-only

**F6.5A — payments dashboard**: la brecha más visible y de menor riesgo (mayormente lectura sobre endpoints existentes). **Aún NO autorizado** — requiere autorización individual del propietario.

## 15. Criterios de cierre de F6.5 completa

- F6.5A–D mergeados con CI verde y evidencia registrada.
- Recorrido demo completo (onboarding → link/checkout → pago → webhook → refund → disputa → payout → conciliación → export) ejecutable en local con el guion, 100% mock.
- Ningún gate real movido; freeze #24, live, producción y sandbox compartido intactos.
- STATE/HANDOFF/BACKLOG reflejan el cierre; decisión de delta audit opcional tomada por el propietario.

## 16. Confirmaciones críticas

Sandbox es sandbox · mock es mock · producción es producción · no se declara `live` · no se declara legalmente listo · no se conecta proveedor real · no se usan datos reales · no se abre sandbox compartido · no se levanta el freeze #24 · F5.1–F5.4 siguen bloqueadas · `docs/audits/independent-audit-v1/` inmutable.
