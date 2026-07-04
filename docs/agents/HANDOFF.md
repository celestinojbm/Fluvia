# HANDOFF — Guía para el siguiente agente o equipo

Actualizado: 2026-07-04 (cierre de Fase 0)

## Empieza aquí, en este orden

1. `docs/README.md` — índice de la Fase 0 y convenciones.
2. `docs/agents/STATE.md` — qué existe de verdad y qué no.
3. `docs/agents/DECISIONS.md` + `docs/adr/` — decisiones cerradas; no las reabras sin evidencia nueva (proceso ADR).
4. `docs/agents/BACKLOG.md` — tu trabajo sale de ahí; respeta el DAG.
5. `CONTRIBUTING.md` — invariantes Nivel A y reglas de PR.

## Reglas de oro operativas

- **No inicies Fase 1 sin PEND-003 aprobado por el humano.**
- Una unidad de backlog por PR; tests de integración con Postgres real para todo lo financiero.
- El spike (`packages/money`, `packages/db`) es evidencia, no fundación sagrada: F1-03/F2-01 lo migran formalmente; si encuentras algo mal en él, corrígelo con test que lo demuestre.
- Toda tabla nueva: clasificación de datos + decisión RLS en el PR.
- Las políticas RLS SIEMPRE con `NULLIF(current_setting('app.tenant_id', true), '')::uuid` (hallazgo empírico documentado).
- Si te desvías del Prompt V4 o de un ADR: registra la desviación (instrucción original, razón, alternativa, ADR si aplica).

## Cómo reproducir el entorno del spike

```bash
pnpm install
docker compose up -d postgres   # o PG16 local en :5432 con usuario postgres/trust
pnpm migrate
pnpm test && pnpm build
```

## Trampas conocidas

1. `DELETE`/`TRUNCATE` están bloqueados por trigger en TODAS las tablas core del spike — los tests no limpian datos: crean tenants frescos por corrida (aislamiento por RLS). La purga clasificada llega en F1-09.
2. Los passwords de `fluvia_app`/`fluvia_worker` en `0002` son SOLO para local (R-12).
3. `fluvia_worker` tiene BYPASSRLS: úsalo únicamente en el relay/entrega, jamás en código de API.
4. El runner de migraciones usa advisory lock global; no lo ejecutes en paralelo con tests que abran transacciones largas de admin.

## Estado emocionalmente honesto

La Fase 0 está completa y verificada, pero es papel + un spike: el 95% del sistema no existe. El valor de esta entrega es que el siguiente incremento (F1-01/F1-02) tiene criterios, dependencias y gates definidos — construye pequeño y con evidencia.
