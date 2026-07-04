# Transactional Outbox e Inbox

Estado: Activo · Fase: 0 · ADR-0007

## 1. Outbox (eventos salientes de dominio)

Escritura: el cambio de dominio y su evento se insertan en `outbox_events` **en la misma transacción** (Nivel A: nada de llamadas externas dentro de la transacción). El spike ya define la tabla con `status pending|delivered|dead`, `attempts`, `next_attempt_at`, índice parcial por pendientes.

Relay worker (`apps/worker`):

```
loop:
  BEGIN
  SELECT ... FROM outbox_events
   WHERE status='pending' AND next_attempt_at <= now()
   ORDER BY id  LIMIT batch
   FOR UPDATE SKIP LOCKED            -- claim seguro multi-worker
  por evento: despachar → delivered | attempts++, backoff exponencial con jitter
  attempts >= max (Nivel C) → status='dead' (DLQ) + alerta
  COMMIT
```

Garantía: **at-least-once**; los consumidores deduplican por `event_id`. Orden: best-effort por `id`; los handlers no dependen de orden estricto (las FSM validan transiciones). Replay controlado: acción administrativa re-encola eventos `dead` registrando quién lo ordenó.

Destinos del relay en el MVP: motor de webhooks salientes y colas internas de jobs. El relay NO contiene lógica de negocio.

## 2. Inbox (eventos entrantes del proveedor)

Recepción de webhook del proveedor (V4 §28):

```
1. Leer raw body (necesario para verificar firma) con límite de tamaño.
2. Verificar firma + timestamp (tolerancia configurable, default ±5 min).
3. INSERT provider_events (provider, provider_event_id UNIQUE, raw, headers permitidos)
   ON CONFLICT DO NOTHING  → duplicado = respuesta 200 sin reprocesar.
4. Responder éxito SOLO tras persistencia durable (COMMIT).
5. Procesamiento asíncrono: worker consume provider_events pendientes,
   valida payload con Zod (inválido → raw_provider_payloads_dlq con datos
   sensibles redactados + métrica + caso), aplica transición FSM idempotente,
   postea ledger si corresponde, registra resultado.
```

Eventos fuera de orden: el handler consulta el estado actual y la FSM decide; lo no aplicable queda registrado como `ignored_out_of_order` para conciliación.

## 3. Poison messages

Evento que falla N veces → DLQ (`dead`) con `last_error`, métrica y caso operativo. Nada se descarta silenciosamente; el replay es manual y auditado.

## 4. Redis en este diseño

Redis puede transportar colas de trabajo **después** de que la intención esté durable en Postgres (patrón: outbox → relay → cola Redis → worker). En el MVP el polling directo a Postgres es suficiente (volumen sandbox); introducir Redis como transporte será decisión medida (Nivel C/ADR menor).

## 5. Métricas

Profundidad de pendientes, edad del evento más viejo, tasa de fallo por topic, eventos `dead`, latencia commit→delivered (SLO baseline p95 < 60 s).
