# Transactional Outbox e Inbox

Estado: Activo · Fase: 0→2 · ADR-0007 · ADR-0011 (rol del relay)

> **Estado de implementación (2026-07-04, F2-11): OUTBOX COMPLETO en sandbox.** Construido: tabla `outbox_events`, escritura transaccional con **envelope común** (`@fluvia/events`, AUD-P2-005), relay multi-worker (`@fluvia/outbox`, rol `fluvia_relay` de privilegio mínimo — ADR-0011), DLQ y replay auditado. Publisher actual = log estructurado (sandbox): la entrega efectiva a consumidores llega con F2-12 (inbox) y F3-07 (webhooks). NO construido: el inbox (§3).

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

## 3. Inbox (eventos entrantes del proveedor)

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

## 4. Poison messages

Evento que falla N veces → DLQ (`dead`) con `last_error`, métrica y caso operativo. Nada se descarta silenciosamente; el replay es manual y auditado.

## 5. Redis en este diseño

Redis puede transportar colas de trabajo **después** de que la intención esté durable en Postgres (patrón: outbox → relay → cola Redis → worker). En el MVP el polling directo a Postgres es suficiente (volumen sandbox); introducir Redis como transporte será decisión medida (Nivel C/ADR menor).

## 6. Métricas

Profundidad de pendientes, edad del evento más viejo, tasa de fallo por topic, eventos `dead`, latencia commit→delivered (SLO baseline p95 < 60 s).
