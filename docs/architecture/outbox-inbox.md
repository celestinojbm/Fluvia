# Transactional Outbox e Inbox

Estado: Activo · Fase: 0→2 · ADR-0007 · ADR-0011 (rol del relay)

> **Estado de implementación (2026-07-04, F2-11+F2-12): OUTBOX e INBOX COMPLETOS en sandbox.** Outbox: tabla + envelope común (`@fluvia/events`) + relay multi-worker (`@fluvia/outbox`, rol `fluvia_relay` — ADR-0011) + DLQ + replay auditado; publisher actual = log estructurado (la entrega a consumidores llega con F3-07). Inbox: `provider_events` + `@fluvia/inbox` (firma HMAC verificada antes de persistir, dedup por motor, procesador claim-lease con rol `fluvia_inbox`, DLQ redactada, replay auditado); los handlers de negocio reales llegan con los adapters (F3-03).

## 1. Envelope común de eventos (AUD-P2-005)

TODO evento entra al outbox con el sobre de `@fluvia/events` — el productor lo valida al emitir y el relay lo re-valida antes de despachar (payload no conforme = veneno → `dead` sin llamar al publisher):

```jsonc
{
  "event_id": "evt_<uuid>",        // id público estable; dedup del consumidor
  "schema_version": 1,             // versión del payload de ESTE topic
  "occurred_at": "ISO-8601",       // momento del hecho, no del despacho
  "producer": "fluvia.ledger",     // módulo emisor
  "resource": { "type": "ledger_transaction", "id": "<uuid>" },
  "data": { /* payload del topic */ }
}
```

Productores actuales: `fluvia.ledger` → `ledger.transaction.posted` (en la MISMA transacción que el asiento).

## 2. Outbox: semántica normativa del relay (espejo de `packages/outbox`)

Escritura: el cambio de dominio y su evento se insertan en `outbox_events` **en la misma transacción** (Nivel A). Tabla: `status pending|delivered|dead`, `attempts`, `next_attempt_at`, `locked_by`, `last_error`, `delivered_at`, índice parcial por pendientes.

Despacho (Nivel A: la publicación ocurre FUERA de toda transacción SQL):

```
runOnce:
  0. Barrido de zombies: pending con attempts >= max y lease vencido → dead.
  1. CLAIM atómico (una sola sentencia):
       WITH eligible AS (SELECT id FROM outbox_events
         WHERE status='pending' AND attempts < max AND next_attempt_at <= now()
         ORDER BY next_attempt_at, id LIMIT batch FOR UPDATE SKIP LOCKED)
       UPDATE ... SET attempts = attempts+1,
                      next_attempt_at = now() + lease,   -- el claim ES el lease
                      locked_by = worker_id
     Dos relays jamás toman la misma fila; un crash devuelve la fila al pool
     cuando el lease expira (sin estados nuevos ni reaper).
  2. Validar envelope (veneno → dead inmediato, sin publisher).
  3. publish(evento)  → ok:   delivered + delivered_at (+ last_error=NULL)
                      → fallo: attempts < max → backoff exponencial con jitter
                               attempts = max → dead + last_error
```

Garantía: **at-least-once** (el proceso puede morir entre publish y marcar delivered); los consumidores deduplican por `event_id`. Orden: best-effort por antigüedad; los handlers no dependen de orden estricto (las FSM validan transiciones).

Replay: `dead → pending` SOLO vía `replayDeadOutboxEvents` — operación de plataforma (pool admin) con razón obligatoria, auditada con `platform.operation` (riesgo alto) y los ids realmente re-encolados, en la misma transacción. El rol relay no puede resucitar eventos.

Rol `fluvia_relay` (ADR-0011): sin BYPASSRLS — visibilidad cross-tenant por políticas RLS explícitas sobre `outbox_events` únicamente; `UPDATE` restringido por columna a los campos de despacho. `fluvia_worker` quedó como cascarón de proceso sin privilegios.

Destinos del relay en el MVP: motor de webhooks salientes y colas internas de jobs. El relay NO contiene lógica de negocio.

## 3. Inbox: semántica normativa (espejo de `packages/inbox`)

Recepción (V4 §28 — `InboxIngestService.ingest`, rol `fluvia_app` con SOLO INSERT):

```
1. Límite de tamaño sobre el raw body (default 1 MiB) → PayloadTooLargeError.
2. Verificar firma ANTES de persistir: HMAC-SHA256 hex de `${timestampMs}.${rawBody}`
   con timestamp FIRMADO y tolerancia ±5 min (configurable); comparación en
   tiempo constante. Firma inválida ⇒ excepción y CERO persistencia
   (un emisor no autenticado no llena la base).
3. INSERT provider_events (UNIQUE (provider, provider_event_id), raw exacto,
   headers allowlisted) ON CONFLICT DO NOTHING → duplicado detectado por
   rowCount, race-safe: N entregas concurrentes = 1 fila (probado).
4. El endpoint HTTP (F3) responde éxito SOLO después del COMMIT de la ingesta.
```

Procesamiento asíncrono (`InboxProcessor`, rol `fluvia_inbox` — mismo patrón claim-lease/backoff/zombie-sweep que el relay §2):

```
- Registro por provider: { schema Zod, handler }. Sin registro ⇒ dead
  ('no handler registered' — hueco de config, recuperable con replay auditado).
- JSON inválido o schema no conforme ⇒ VENENO: dead + copia REDACTADA en
  raw_provider_payloads_dlq (redactSummary; card_token y similares jamás
  viajan en claro). El handler NUNCA ve un payload no validado.
- handler → applied ⇒ processed · ignored_out_of_order / ignored ⇒ ignored
  (terminal, con result). Excepción ⇒ backoff con jitter; agotado ⇒ dead.
- dead → pending SOLO vía replayDeadProviderEvents (operación de plataforma
  auditada con razón e ids reales, pool admin).
```

Eventos fuera de orden: el handler consulta el estado actual y la FSM decide (F3); lo no aplicable queda registrado como `ignored_out_of_order` para conciliación — el estado terminal `ignored` no se reintenta.

Roles: `fluvia_app` solo INSERT (+ SELECT de las columnas del árbitro de dedup exigidas por ON CONFLICT); `fluvia_inbox` SELECT + UPDATE por columna de los campos de despacho + INSERT en la DLQ vía política RLS explícita. Sin BYPASSRLS (patrón ADR-0011); meta-tests permanentes.

## 4. Poison messages

Evento que falla N veces → DLQ (`dead`) con `last_error`, métrica y caso operativo. Nada se descarta silenciosamente; el replay es manual y auditado.

## 5. Redis en este diseño

Redis puede transportar colas de trabajo **después** de que la intención esté durable en Postgres (patrón: outbox → relay → cola Redis → worker). En el MVP el polling directo a Postgres es suficiente (volumen sandbox); introducir Redis como transporte será decisión medida (Nivel C/ADR menor).

## 6. Métricas

Profundidad de pendientes, edad del evento más viejo, tasa de fallo por topic, eventos `dead`, latencia commit→delivered (SLO baseline p95 < 60 s).
