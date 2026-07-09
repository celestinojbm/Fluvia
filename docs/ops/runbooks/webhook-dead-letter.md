# Runbook · Webhook saliente en `dead`

**Alerta**: `increase(fluvia_webhook_deliveries_total{result="dead"}[15m]) > 0` · **Sev**: MEDIA (SEV-3).

**Qué significa**: un evento de webhook hacia el endpoint de un comercio **agotó el calendario de reintentos** (0s → … → 24h) del deliverer (F3-07) y quedó en estado terminal `dead`. El comercio no recibió ese evento. La firma HMAC, el SSRF guard y el backoff son correctos; el problema es el endpoint destino (caído, 5xx sostenido, timeout, TLS).

## Diagnóstico

1. **Panel → «Eventos»** o la cola de webhooks del panel: localiza el evento `dead` (topic, endpoint, intentos).
2. Revisa el **historial de intentos** del evento (`webhook_attempts`): IP validada, status HTTP y error por cada intento. Distingue:
   - **5xx / timeout sostenido** → el endpoint del comercio está caído o lento.
   - **4xx** (401/403/404) → el comercio cambió la ruta o rechaza la firma → contactar al comercio; reenviar solo cuando confirme el fix.
   - **Error TLS / DNS** → certificado o dominio del endpoint.
3. Si son **muchos** eventos `dead` del **mismo endpoint**, es el endpoint (no un evento puntual): trátalo como problema del comercio, no reenvíes en masa a ciegas.

## Resolución

Una vez el endpoint del comercio esté sano (verificado, no asumido):

1. **Panel → cola de webhooks → botón «Reenviar»** sobre el evento `dead` (F3-09b-iii). Requiere el permiso `webhooks:manage` (owner/admin/developer).
2. El reenvío **NO resucita** el evento muerto (estado terminal inmutable): **clona** (tenant, endpoint, topic, payload) como un evento `pending` **fresco**, enlazado por `resent_from_event_id`, y lo audita como `webhook_event.resent` en la misma transacción.
3. El nuevo evento entra al deliverer normal y reintenta con su propio calendario.

> El reenvío es la única acción de escritura del plano de operación de webhooks; toda lectura/diagnóstico es de solo lectura.

## Verificación

1. Tras el reenvío aparece un evento `pending` fresco en la cola (enlazado al `dead` por `resent_from_event_id`).
2. Cuando el deliverer lo entrega, su resultado pasa a `delivered` (`fluvia_webhook_deliveries_total{result="delivered"}` incrementa).
3. El `audit_log` (**Eventos**) registra `webhook_event.resent` con el actor (usuario) y el evento origen.

## Escalación

- Si el endpoint del comercio sigue caído tras contactarlo, es cuestión del comercio, no un incidente de Fluvia: no reenvíes indefinidamente. El **auto-disable de endpoints crónicos** con notificación está diferido a F6 (hoy la alerta `result="dead"` cubre la operación).
- Un evento `dead` que **no debía** fallar (endpoint sano, firma correcta) apunta a un bug del deliverer → SEV-2, revisar `webhook-delivery.md`.

## Drill (F4-06b)

✅ **Ejecutado — PASS 5/5** (`pnpm --filter @fluvia/api run drill:webhook-dead-letter`, `apps/api/drills/webhook-dead-letter-drill.ts`). Ensaya el reenvío por SESIÓN sobre HTTP real (la acción del operador del panel, F3-09b-iii):

1. **Gate RBAC**: un rol `read_only` (sin `webhooks:manage`) → **403** al reenviar.
2. El **reenvío** por sesión (admin) → **201** con un evento `pending` **fresco**, enlazado al `dead` por `resent_from_event_id` (no lo resucita — lo CLONA).
3. El evento `dead` **sigue terminal** (inmutable): el reenvío clona, no reabre.
4. Rastro de auditoría **`webhook_event.resent`** (actor usuario, sobre el id fresco).
5. Reenviar un evento **NO-`dead`** (uno `delivered`) → **409** `invalid_state_transition` (solo los `dead` se reenvían).

El E2E de navegador de F3-09b-iii ya ejerció el clic desde el panel; este drill ancla la garantía de estado (clonar-no-resucitar) + el gate RBAC + la auditoría end-to-end sobre HTTP. Ejecución local.
