# Auditoría crítica del Prompt Maestro V4

Estado: Activo · Fase: 0 · Cubre entregables §52.2, §52.3, §52.28, §52.29, §52.30

## 1. Veredicto general

El V4 corrige las debilidades principales del V3 (número mágico de 500 transacciones, prohibición indiscriminada de DELETE, obligación de TDD ritual, regla simplista de transacciones) y añade el marco de gobernanza que faltaba (jerarquía A/B/C, gates, ADRs, formato de entrega). Es un marco sólido. Las observaciones siguientes son correcciones puntuales, vacíos detectados y decisiones tomadas bajo la autonomía de §2.

## 2. Aciertos que se adoptan sin cambios

- Jerarquía de decisión A/B/C (§3): elimina la ambigüedad sobre qué es negociable.
- Invariante de balanceo **por transacción y por activo/moneda** (§17.2): corrige el error clásico de "la suma global es cero".
- Idempotencia durable en Postgres con Redis solo como acelerador (§19): corrige la vulnerabilidad de expiración de lock del V2/V3.
- Outbox + Inbox (§21): la dirección correcta para no perder eventos.
- Estado ambiguo de proveedor ≠ fallo (§23): un timeout no autoriza reintentar operaciones no idempotentes.
- Production gates (§51) y prohibición de declarar producción sin evidencia.

## 3. Deficiencias detectadas y corrección propuesta (§52.28)

| # | Deficiencia | Corrección propuesta | Severidad |
|---|-------------|----------------------|-----------|
| D1 | No define política de **redondeo y reparto** para fees, splits y prorrateos (solo prohíbe float). | Reparto por **mayor residuo** en unidades menores (nunca se pierde ni crea 1 unidad). Implementado y probado en el spike (`Money.allocate`). Redondeo de fees porcentuales: half-even, documentado por moneda cuando se implemente el motor de fees. | Media |
| D2 | No exige una **taxonomía de errores de API** (códigos estables legibles por máquina) como entregable con fecha. | Añadida al backlog (F1-08) antes de exponer el primer endpoint público; sin ella los SDK y los reintentos de clientes se vuelven frágiles. | Media |
| D3 | §29 lista `charge.captured` pero el MVP no expone `Charge` como recurso público separado. | Catálogo de eventos del MVP normalizado a `payment_intent.*`, `refund.*`, `checkout_session.*`; `charge.*`/`dispute.*` se reservan para cuando existan esos recursos. Ver `architecture/webhook-delivery.md`. | Baja |
| D4 | "UTC" (§12) es insuficiente como política temporal: falta tolerancia de **clock skew** en verificación de webhooks y normalización de fechas de reportes de proveedor (zona del proveedor ≠ UTC). | Tolerancia de timestamp configurable (default ±5 min) en verificación de firmas; toda fecha de proveedor se normaliza a UTC conservando la original cruda para conciliación. | Media |
| D5 | No define **versionado del schema de eventos** de webhooks salientes. | Todo payload de evento lleva `schema_version`; cambios incompatibles crean versión nueva, nunca mutan la existente. | Media |
| D6 | No define estrategia de **datos de prueba/seeds** ni anonimización para staging. | Añadido al backlog (F1-10): seeds deterministas por entorno; staging jamás recibe copias de datos reales sin pseudonimización. | Baja |
| D7 | No fija **SLOs iniciales** aunque §39 los pide. | Baseline propuesta en `architecture/system-overview.md` §Observabilidad (p99 API < 500 ms sandbox, webhook delay p95 < 60 s, éxito de posting de ledger 100%). Son Nivel C: se ajustan con medición. | Baja |
| D8 | No define política de **actualización de dependencias** (solo pinning y scanning). | Lockfile + `save-exact` (ya activo en el spike) + revisión periódica programada; herramienta concreta (Renovate/Dependabot) se decide al configurar CI (F1-02). | Baja |
| D9 | Exige i18n + WCAG AA (§12) sin indicar cuándo bloquean. | Se interpreta como requisito de **Fase 3** (primeras UIs): estructura i18n (es/en) desde el primer componente y auditoría AA como criterio de cierre de Fase 3, no como bloqueo de Fases 1–2 (sin UI). | Baja |
| D10 | El patrón RLS + pooling requiere una regla explícita que el prompt solo insinúa (§14.2). | Regla fijada: el contexto de tenant SOLO se establece con `set_config(..., is_local => true)` dentro de una transacción; prohibido `SET` a nivel de sesión. Compatible con PgBouncer en transaction pooling. Ver `architecture/multi-tenancy.md`. | Alta |

## 4. Contradicciones o ambigüedades resueltas

1. **Inmutabilidad (§3.1) vs. DELETE selectivo (§17.4).** Resolución: la prohibición de UPDATE/DELETE es absoluta para asientos contables publicados, eventos financieros y auditoría; los datos técnicos (idempotency keys expiradas, sesiones, caché) se purgan por job administrado según `security/data-classification.md`. El spike V3 bloqueaba DELETE en *todas* las tablas, incluida `idempotency_keys`: se corrige en la Fase 1 para permitir purga por retención con auditoría (la corrección está registrada en el backlog F1-09; los triggers actuales se mantienen hasta entonces por ser el default más seguro).
2. **Idempotency-Key como "estándar" (§19).** Confirmado: el header `Idempotency-Key` es un draft del IETF HTTPAPI WG (`draft-ietf-httpapi-idempotency-key-header`), no un RFC publicado. Fluvia define su **contrato propio** documentado en `architecture/idempotency.md` y no atribuye el comportamiento a ninguna especificación externa.
3. **NestJS "o alternativa justificada" (§12).** Se elige Fastify + Zod sin NestJS (ADR-0010): menos capas de indirection sobre un dominio donde queremos límites transaccionales explícitos y visibles. NestJS queda como alternativa si el equipo humano lo prefiere por familiaridad.
4. **"Turborepo o alternativa"**: se mantiene Turborepo (ya operativo en el spike); el valor real llegará con apps múltiples en Fase 3.

## 5. Cambios realizados con criterio profesional (§52.30)

| Cambio | Instrucción original | Razón | Clasificación | Evidencia |
|--------|----------------------|-------|---------------|-----------|
| Trabajo V3 previo reclasificado como **spike desechable de Fase 0** | §52: no construir antes de cerrar Fase 0 | El spike (Money VO, migraciones RLS, triggers de inmutabilidad, runner de migraciones) valida empíricamente 4 decisiones de Fase 0 permitido por §50 ("spikes aislados y desechables") | Recomendado | Tests del spike ejecutados contra PostgreSQL 16 real; ver `agents/STATE.md` |
| Eliminado stub incompleto de `packages/ledger` | — | Código a medio escribir contradice "no acumular líneas sin verificar" (§46) | Obligatorio | Commit de Fase 0 |
| Money VO propio en lugar de `dinero.js` (V3 lo exigía) | V3 §2.3 | `bigint` nativo + validación por moneda cubre el 100% del requisito §16 sin dependencia externa; dinero.js v2 introduce su propio modelo de precisión y una dependencia a auditar | Recomendado (ADR-0008) | 21 tests unitarios del spike |
| Idempotencia y outbox 100% Postgres; Redis opcional | V3 mencionaba Redis para idempotencia | Alineado con §19/§21 del V4; Redis pasa a fast-path opcional | Obligatorio (ADR-0006/0007) | Diseño en `architecture/idempotency.md` |
| Ledger interno reducido (no Formance como servicio) | §10.2 pedía comparar | Transaccionalidad en la MISMA base de datos que el dominio (outbox, RLS, FSM) elimina la clase entera de fallas distribuidas; Formance queda como opción de extracción futura | Recomendado (ADR-0004) | `references/formance-ledger-assessment.md` |
| Webhooks salientes internos primero; Svix como opción de escala | §10.4 pedía comparar | Control del modelo multi-tenant y del SSRF-guard; el volumen del MVP no justifica el servicio externo | Recomendado (ADR-0009) | `references/svix-assessment.md` |

## 6. Elementos adicionales recomendados (§52.29)

1. **Contract tests del `PaymentProviderAdapter` desde la Fase 3** (no esperar a Fase 5): el MockProvider debe pasar la misma suite de contrato que pasará el proveedor real; así el contrato se endurece antes de firmar nada.
2. **`docs/agents/BACKLOG.md` como fuente única de trabajo**: §48 define el formato pero no dónde vive; se fija en el repo, versionado con el código.
3. **Job de verificación de invariantes fuera del ORM** (§51 Gate Ledger lo exige): script SQL puro `scripts/verify-ledger-invariants.sql` planificado en F2-06, ejecutable por cron y en CI.
4. **Presupuesto de complejidad**: toda dependencia nueva de runtime requiere justificación en el PR que la introduce (licencia, mantenimiento, alternativa nativa considerada). Regla añadida a `CONTRIBUTING.md`.
5. **Identificadores públicos con prefijo de recurso** (`pi_`, `cus_`, `whk_`…) sobre UUID aleatorio: mejora DX, soporte y logs sin filtrar orden temporal. Registrado en `architecture/data-model.md`.

## 7. Instrucciones que NO se siguieron literalmente

Ninguna instrucción de Nivel A fue modificada. Las desviaciones de Nivel B están registradas en la tabla §5 con su ADR. No hay desviaciones ocultas.
