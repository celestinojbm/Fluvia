# Runbook · Eventos `dead` en outbox / inbox

**Alerta**: `increase(fluvia_outbox_relay_events_total{result="dead"}[5m]) > 0` (salida) o `increase(fluvia_inbox_events_total{result="dead"}[5m]) > 0` (entrada) · **Sev**: ALTA (SEV-2).

**Qué significa**:

- **Outbox `dead`**: un evento de dominio agotó el calendario de reintentos del relay (o fue veneno = payload que no valida contra el `EventEnvelopeSchema`) y quedó terminal. Ese evento no se despachó al fan-out de webhooks.
- **Inbox `dead`**: un evento de proveedor (`provider_events`) no se pudo procesar — veneno (falla el schema Zod del proveedor → va a `raw_provider_payloads_dlq` redactada) o agotó reintentos. Ese evento del proveedor no movió la máquina de estados.

> El relay (`fluvia_relay`) y el procesador de inbox (`fluvia_inbox`) tienen privilegio mínimo y **no pueden** hacer la transición `dead → pending`. El replay entra **solo** por una función auditada sobre el **admin pool** (ADR-0011).

## Diagnóstico

### Outbox
1. Localiza los eventos `dead` en `outbox_events` (por `status='dead'`): topic, `last_error`, `attempts`.
2. Clasifica la causa por `last_error`:
   - **Veneno** (envelope inválido) → es un **bug del productor** del evento, no un problema de entrega. Replaying no ayuda hasta corregir el productor. SEV-2, backlog.
   - **Agotó reintentos por fan-out/entrega** → el destino (deliverer de webhooks) estuvo caído; ver [`webhook-dead-letter.md`](./webhook-dead-letter.md) para la capa de entrega. El evento de outbox `dead` se replaya solo si el fan-out debe re-ejecutarse.

### Inbox
1. Localiza los `provider_events` con `status='dead'`; el payload crudo redactado está en `raw_provider_payloads_dlq`.
2. Clasifica:
   - **Firma HMAC inválida / payload no del proveedor esperado** → NO replayes: es tráfico ilegítimo o mal configurado; investiga el origen.
   - **Schema del proveedor cambió** (veneno legítimo) → corrige el schema/handler primero; recién entonces replay.
   - **`ignored_out_of_order`** es terminal y **correcto** (llegó tarde), no es `dead`, no requiere acción.

## Resolución (replay auditado — única vía)

Solo tras corregir la causa raíz y confirmar que el evento **debe** re-procesarse:

- **Outbox**: `replayDeadOutboxEvents(adminPool, { eventIds, reason, actorId?, requestId? })` (`packages/outbox/src/replay.ts`). `reason` es **obligatorio**. Corre envuelto en `withPlatformOperation` → queda auditado en la MISMA transacción como `platform.operation` de riesgo alto (`resourceType: 'outbox_event'`, `details.replayed_ids`). Pone `status='pending', attempts=0, next_attempt_at=now(), last_error=NULL` **solo** en los ids que estén en `dead`. Devuelve la lista realmente re-encolada.
- **Inbox**: `replayDeadProviderEvents(adminPool, { eventIds, reason, actorId?, requestId? })` (`packages/inbox/src/processor.ts`). Igual patrón auditado; además limpia `result=NULL, processed_at=NULL`.

> **No hay ruta HTTP ni script** para el replay: son funciones de servicio invocadas **programáticamente contra el admin pool**, con `reason` obligatorio. Una herramienta de operación (o una acción de panel) para esto es trabajo futuro — F6. Hasta entonces, el replay lo ejecuta un operador con acceso al admin pool, y **queda en el audit log**.

## Verificación

1. Los eventos vuelven a `pending` y el relay/inbox los toma en el siguiente ciclo (default 1 s).
2. El resultado pasa a `delivered`/`processed` (`fluvia_outbox_relay_events_total{result="delivered"}` / `fluvia_inbox_events_total{result="processed"}` incrementan).
3. El `audit_log` (**Eventos**) tiene el `platform.operation` del replay con el `reason` y los `replayed_ids`.

## Escalación

- Un evento que **reincide** en `dead` tras el replay = la causa raíz no se corrigió → no re-replayees en bucle; vuelve al diagnóstico.
- Veneno en outbox (envelope inválido) publicado por el productor es un **bug de integridad** de eventos → SEV-2, prioridad alta.

## Drill (F4-06b)

Pendiente: envenenar un evento (forzar `dead`) → verificar la alerta/DLQ → corregir causa → `replayDead*Events` con `reason` → confirmar re-proceso + el `platform.operation` auditado. (Las suites de `@fluvia/outbox` e `@fluvia/inbox` ya prueban el camino `dead` y el replay auditado.)
