# HANDOFF — Guía para el siguiente agente o equipo

Actualizado: 2026-07-07 · **Fases 1–4 COMPLETAS — Fase 4 cerrada (Gate Conciliación cumplido); LISTA PARA RE-AUDITORÍA** (paquete en `docs/audits/`)

## Empieza aquí, en este orden

1. `docs/README.md` — índice de la Fase 0 y convenciones.
2. `docs/agents/STATE.md` — qué existe de verdad y qué no.
2bis. `docs/audits/audit-closure-register-v1.md` — estado vivo de los hallazgos de la auditoría independiente; NO construyas sobre un área con hallazgo P1 abierto sin leer su fila.
3. `docs/agents/DECISIONS.md` + `docs/adr/` — decisiones cerradas; no las reabras sin evidencia nueva (proceso ADR).
4. `docs/agents/BACKLOG.md` — tu trabajo sale de ahí; respeta el DAG.
5. `CONTRIBUTING.md` — invariantes Nivel A y reglas de PR.

## Reglas de oro operativas

- Vigente: **no toques `docs/audits/independent-audit-v1/`** (inmutable), no emitas credenciales `live` (bloqueado por código, PEND-004), y la **exposición pública** de la API de pagos/checkout/webhooks sigue **CONGELADA** (decisión #24) hasta la re-auditoría + PEND-006 — todo está construido en sandbox, jamás expuesto. Cada incremento registra su run de CI verde en `audit-closure-register-v1.md` antes de declararse completado.
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
3. NINGÚN rol de runtime tiene BYPASSRLS (ADR-0011): `fluvia_relay` es el único con visión cross-tenant, SOLO sobre `outbox_events` y por política explícita; `fluvia_worker` es un cascarón sin privilegios. El relay corre en `apps/worker` con publisher de log (la entrega real llega con F2-12/F3-07).
3bis. La tabla `idempotency_keys` ya tiene PK `(tenant_id, endpoint, key)` — el middleware de F2-09 debe usar SIEMPRE el endpoint normalizado en la clave.
4. El runner de migraciones usa advisory lock global; no lo ejecutes en paralelo con tests que abran transacciones largas de admin.

## Estado emocionalmente honesto

Fases 1–4 existen de verdad y están probadas contra Postgres 16 real, con una auditoría independiente integrada (**0 P1 abiertos, 0 P2 abiertos**) y **los 7 runbooks operativos ejecutados en drill**. Lo que existe: seguridad núcleo (F1), ledger + posting + idempotencia + outbox/inbox (F2), pagos **sandbox** end-to-end (F3: intents/attempts/confirm/refunds/checkout/links/webhooks/dashboard/SDK) y conciliación + operaciones (F4: reconciliación con four-eyes, panel admin, fees al 2%, payouts, disputas, observabilidad/watchdogs, runbooks drilled). Lo que NO existe (y así debe declararse): NINGÚN proveedor real (Fase 5, tras la matriz de jurisdicción Colombia + F0-VER), NINGUNA exposición pública ni uso `live` (congelado por decisión #24 hasta la re-auditoría + PEND-006), y el **restore drill** (Fase 6, Gate Restore — única pata restante de AUD-P2-007). Próximo paso: **el propietario solicita la re-auditoría** (paquete de entrada en `docs/audits/`); tras ella decide Fase 5 (proveedor real) o Fase 6 (hardening). Construye pequeño y con evidencia.
