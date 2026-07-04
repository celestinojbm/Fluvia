# HANDOFF — Guía para el siguiente agente o equipo

Actualizado: 2026-07-04 (integración Auditoría v1 + lote AUD-1; Fase 2 en curso)

## Empieza aquí, en este orden

1. `docs/README.md` — índice de la Fase 0 y convenciones.
2. `docs/agents/STATE.md` — qué existe de verdad y qué no.
2bis. `docs/audits/audit-closure-register-v1.md` — estado vivo de los hallazgos de la auditoría independiente; NO construyas sobre un área con hallazgo P1 abierto sin leer su fila.
3. `docs/agents/DECISIONS.md` + `docs/adr/` — decisiones cerradas; no las reabras sin evidencia nueva (proceso ADR).
4. `docs/agents/BACKLOG.md` — tu trabajo sale de ahí; respeta el DAG.
5. `CONTRIBUTING.md` — invariantes Nivel A y reglas de PR.

## Reglas de oro operativas

- ~~No inicies Fase 1 sin PEND-003~~ (aprobado). Vigente: **no toques `docs/audits/independent-audit-v1/`** (inmutable), no emitas credenciales `live` (bloqueado por código, PEND-004), y F3 (pagos públicos/checkout/webhooks externos) sigue CONGELADA hasta cerrar los bloqueantes del registro de cierre.
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
3. `fluvia_worker` tiene BYPASSRLS pero desde 0008 CERO privilegios sobre ledger/proyecciones/api_keys; el rol definitivo del relay se diseña en F2-11 (ADR-0011). Jamás en código de API.
3bis. La tabla `idempotency_keys` ya tiene PK `(tenant_id, endpoint, key)` — el middleware de F2-09 debe usar SIEMPRE el endpoint normalizado en la clave.
4. El runner de migraciones usa advisory lock global; no lo ejecutes en paralelo con tests que abran transacciones largas de admin.

## Estado emocionalmente honesto

Fase 1 (seguridad núcleo) y el corazón de Fase 2 (ledger + posting) existen de verdad, con 174 tests contra PG16 real y una auditoría independiente integrada con evidencia por hallazgo. Lo que NO existe: pagos como producto (API pública, FSMs, proveedores, checkout, webhooks, conciliación) — y así debe declararse. Próximo incremento: **F2-11** (outbox relay) absorbiendo AUD-P1-007 (rol mínimo, ADR-0011) y AUD-P2-005 (envelope). Construye pequeño y con evidencia.
