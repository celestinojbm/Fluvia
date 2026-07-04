# ADR-0011 — Rol dedicado del outbox relay (privilegio mínimo, sin BYPASSRLS)

Estado: Aceptado · Fase 2 (F2-11) · Origen: hallazgo AUD-P1-007 de la Auditoría Independiente v1 · Diseño en `../architecture/outbox-inbox.md`

## Contexto

El spike (0002) creó `fluvia_worker` con `BYPASSRLS` y grants amplios (`SELECT/INSERT/UPDATE` sobre todas las tablas presentes y futuras vía default privileges) antes de que existiera ningún consumidor. La auditoría lo señaló como riesgo estructural: un rol de fondo comprometido podía leer y modificar datos financieros de todos los tenants. El relay real (F2-11) solo necesita: leer eventos pendientes de TODOS los tenants y marcar el resultado del despacho.

## Decisión

1. **`fluvia_relay`**: rol nuevo y dedicado del relay, **sin BYPASSRLS**. La visibilidad cross-tenant se declara con **políticas RLS explícitas** (`outbox_relay_read`/`outbox_relay_update` con `USING (true)`) acotadas a `outbox_events` — el permiso queda auditable en `pg_policy`, no escondido en un atributo de rol.
2. **Grants mínimos**: `SELECT` sobre `outbox_events` y `UPDATE` **por columna** limitado a los campos de despacho (`status, attempts, next_attempt_at, locked_by, delivered_at, last_error`). El relay NO puede reescribir `payload/topic/tenant_id`, ni insertar, ni borrar, ni ver ninguna otra tabla.
3. **`fluvia_worker` queda como cascarón de proceso** (conectar + `SELECT 1` de readiness): pierde `BYPASSRLS`, todos los privilegios de tabla/secuencia y los default privileges futuros. Ningún rol de runtime tiene `BYPASSRLS` (meta-test lo fija para siempre).
4. **Claim = lease**: el claim atómico (`FOR UPDATE SKIP LOCKED` + `attempts+1` + `next_attempt_at = now()+lease`) es la única sincronización entre relays; la publicación ocurre FUERA de la transacción (Nivel A). Un crash devuelve la fila al pool al expirar el lease, sin reaper.
5. **dead → pending solo por replay auditado** (`replayDeadOutboxEvents`): operación de plataforma con razón obligatoria y evento `platform.operation` (riesgo alto) con los ids realmente tocados, en la misma transacción, sobre el pool administrativo.

## Alternativas

- Mantener `fluvia_worker` con BYPASSRLS "porque ya existía" (rechazado: exactamente el hallazgo).
- BYPASSRLS en el rol nuevo con grants mínimos (rechazado: mismo efecto práctico, pero el permiso cross-tenant queda invisible fuera de `pg_roles`; la política explícita domina en auditabilidad).
- Relay singleton con advisory lock (rechazado: SKIP LOCKED escala horizontalmente y el CA exige 2 workers sin doble entrega).
- Estado `processing` + reaper de huérfanos (rechazado: el lease sobre `next_attempt_at` da la misma semántica sin estados nuevos ni proceso extra).

## Consecuencias

+ Compromiso del relay ≠ acceso a datos financieros: el radio de explosión queda en marcar eventos como entregados/fallidos. + El meta-test de privilegios convierte la decisión en invariante permanente. − Un rol más que aprovisionar por entorno (`RELAY_DATABASE_URL`, cubierto por la anti-mezcla). − At-least-once: los consumidores deben deduplicar por `event_id` (ya exigido por ADR-0007).

## Evidencia

Migración `0009_outbox_relay_role.sql` · `packages/outbox` (relay + replay) con 12 tests de integración (2 workers sin doble entrega, backoff con jitter, veneno→dead, lease expirado, replay auditado, límites de privilegio) · meta-tests de roles en `tenant-escape.test.ts` (ningún rol runtime con BYPASSRLS; worker con cero privilegios; relay solo outbox_events con UPDATE por columna).
