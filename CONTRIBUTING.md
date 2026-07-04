# Contribuir a Fluvia

## Reglas no negociables (Nivel A del Prompt V4)

1. Dinero solo como `Money` (bigint, unidades menores). Prohibido float/double para montos.
2. Asientos contables publicados: inmutables. Correcciones = compensación.
3. Ninguna llamada de red dentro de una transacción SQL. Eventos → outbox.
4. Toda operación financiera mutante es idempotente ANTES de exponerse.
5. Aislamiento multi-tenant: tenant derivado de identidad autenticada + RLS; jamás de un id del payload.
6. Prohibido `any` en código financiero o de seguridad (excepción documentada en el PR).
7. No declarar capacidades que no existen o son simuladas.

## Flujo de trabajo (V4 §46)

Antes de tocar código: leer `docs/agents/STATE.md`, el backlog y los ADR relevantes. Seleccionar UNA unidad pequeña del backlog, declarar alcance y criterios de aceptación en el PR.

Cada PR debe incluir:
- Pruebas (la lógica financiera crítica exige tests de integración con Postgres real).
- Actualización de la documentación afectada (FSM ↔ `payment-state-machines.md`, DDL ↔ `database-schema.md`, gates ↔ `production-gates.md`).
- Clasificación de datos de toda tabla nueva y si es tenant-scoped (RLS) o global.
- **Dependencias nuevas de runtime**: justificación de licencia, mantenimiento y alternativa nativa considerada. AGPL u otras licencias virales: prohibidas en el árbol del monolito.
- Actualización de `docs/agents/STATE.md` al cerrar la unidad.

## Convenciones

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- TypeScript strict, ESM. Código e identificadores en inglés; documentación en español.
- `save-exact` + lockfile: las versiones se fijan siempre.
- Los estados de FSM solo se mutan por el servicio de dominio; los diagramas se regeneran desde el código.
