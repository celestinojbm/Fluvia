# Runbook · Investigación por auditoría

**Disparador**: cualquier investigación («¿quién hizo X?», «¿qué pasó con este recurso?»), preparación de un post-mortem, o correlación tras otra alerta. Transversal, sin severidad propia.

**Qué es**: el `audit_log` (F1-05) es un registro **append-only** de las acciones sensibles, con actor, método de auth, acción, recurso, resultado, nivel de riesgo, razón y `request_id`. Es la fuente de verdad para reconstruir qué ocurrió. No se edita ni se borra (por diseño; la purga clasificada de F1-09 no toca clases financieras/auditoría).

## Diagnóstico / consulta

1. **Panel → «Eventos»** (`/o/:orgId/events`). Requiere el permiso `audit:read` (owner/admin/finance/analyst); el enlace se oculta a quien no lo tiene, pero el API es la fuente de verdad (403).
2. La tabla muestra, del más reciente al más antiguo: **fecha y hora**, **actor** (`user` / `api_key` + id), **acción** (p. ej. `case_adjustment.applied`, `webhook_event.resent`, `operational_case.resolved`), **recurso** (tipo + id), **resultado** (`success` / `failure`) y **riesgo** (`low` / `medium` / `high`).
3. Pagina hacia atrás con **«Ver más antiguos»** (cursor `?before=<id>`, sin JS) hasta cubrir la ventana temporal del incidente.
4. Correlaciona por `request_id` con los logs estructurados de la API/worker para la traza extremo a extremo (V4: correlación por `request_id` mientras OTel esté diferido a F6).

## Qué buscar según el caso

- **Ajuste monetario disputado**: filtra por `case_adjustment.proposed` / `.applied` / `.rejected` → verifica que **proponente ≠ aprobador** (four-eyes) y la razón registrada.
- **Reenvío de webhook**: `webhook_event.resent` → actor y evento origen.
- **Acceso o cambio administrativo**: acciones sobre `api-keys`, `merchants`, `memberships`.
- **Fallos de auth / abuso**: `result=failure` con riesgo `high`; correlaciona con lockouts (alerta «Abuso de auth», 429 en `/v1/auth/*`).

## Preservación de evidencia

- **No se limpia nada.** El `audit_log` y el ledger son append-only precisamente para investigar.
- Para un incidente SEV-1/SEV-2, exporta/anota los `request_id` y los ids de recurso relevantes antes de cualquier remediación, y enlázalos en el post-mortem (`incident-response.md`).

## Escalación

- Un actor `api_key` (máquina/IA) sobre una acción que debía ser humana (p. ej. un intento de aprobar un ajuste) es una **anomalía**: el sistema ya lo rechaza (`HumanActorRequiredError`), pero investiga el origen de la key.
- Un `failure` de riesgo `high` inesperado sobre datos financieros → SEV-1, `incident-response.md`.

## Drill (F4-06b)

Pendiente: ejecutar una acción auditada (p. ej. un reenvío o un ajuste four-eyes) → localizarla en el panel «Eventos» con su actor/razón → paginar por cursor → correlacionar por `request_id`.
