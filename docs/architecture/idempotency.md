# Estrategia de idempotencia

Estado: Activo · Fase: 0 · ADR-0006 · Nota: el header `Idempotency-Key` sigue un draft IETF, no un RFC; este documento define el contrato propio de Fluvia.

> **Estado de implementación (2026-07-04, F2-09/F2-10): CAPA COMPLETA.** Construido: idempotencia del ledger (capa dominio) + `@fluvia/idempotency` (capa API): `IdempotencyService.execute` con claim en la MISMA transacción que el efecto, hash canónico sha256 (claves ordenadas recursivamente), los 5 casos del contrato §3 probados, carrera N→1, crash pre/post-COMMIT y `expires_at` (0013; la purga es F1-09). Los endpoints mutantes de pagos la cablean en F3-02 con el patrón exacto del test HTTP (`apps/api/test/idempotency-http.test.ts`). Sin fast-path Redis: PostgreSQL es la única fuente.

## 1. Principio

La idempotencia se diseña **antes** de exponer cualquier endpoint mutante (V4 §19, §49). Fuente de verdad: **PostgreSQL**. Redis solo puede añadir un fast-path/lock corto, y su pérdida total no debe permitir duplicados (Gate Idempotencia §51).

## 2. Capas

**Capa API (`idempotency_keys`):** para endpoints mutantes públicos (`POST /v1/payment_intents`, confirm, refunds…).

```
PK (tenant_id, endpoint, key)
request_hash    sha256 canónico del payload normalizado
status          in_progress | completed
response_status / response_body   respuesta persistida para replay
expires_at      retención configurable (`IDEMPOTENCY_RETENTION_HOURS`, default 24 h)
```

**Retención ≥ ventana de retry (F6, threat model §5):** `expires_at` lo fija el
servicio explícitamente desde `IDEMPOTENCY_RETENTION_HOURS` (default 24 h, rango
1 h–30 días). DEBE cubrir la ventana máxima de retry del cliente: si la key
expira antes de un reintento legítimo, la purga (F1-09) la borra y el efecto se
**RE-EJECUTA** (doble cobro). El valor definitivo lo fija el propietario antes
del sandbox compartido (PEND-006); aquí solo se hace configurable. **Salud:** el
`IdempotencyWatchdog` (0041 · `sweep_idempotency_orphans()`) alerta sobre claims
`in_progress` envejecidos (>1 h) — huérfanos que bloquean su `(tenant, endpoint,
key)` hasta la purga; jamás se borran automáticamente (podrían ser una operación
multi-paso externa viva — arriesgaría doble ejecución).

**Capa dominio:** claves naturales y unique constraints que hacen imposible el duplicado aunque la capa API falle: `ledger_transactions (tenant_id, idempotency_key)`, `provider_events (provider, provider_event_id)` (inbox), `webhook_attempts (event_id, attempt_no)`, un solo attempt activo por intent (unique parcial).

## 3. Contrato del endpoint mutante

| Situación                                         | Comportamiento                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key nueva                                         | Se inserta `in_progress` en la MISMA transacción que el efecto; al final se persiste la respuesta (`completed`)                                                                                                                                               |
| Key repetida + mismo `request_hash` + `completed` | Replay exacto de la respuesta persistida (mismo status y body)                                                                                                                                                                                                |
| Key repetida + mismo hash + `in_progress`         | `409 processing_in_flight` (el cliente reintenta luego); evita doble ejecución concurrente. Implementación: el duplicado espera hasta `lockTimeoutMs` (default 3 s) sobre el índice único — si el primero commitea a tiempo, el duplicado REPLAYA; si no, 409 |
| Key repetida + `request_hash` distinto            | `422 idempotency_key_reuse` — rechazo, nunca ejecutar                                                                                                                                                                                                         |
| Key ausente en endpoint que la exige              | `400 idempotency_key_required`                                                                                                                                                                                                                                |

Recuperación tras crash: si el proceso muere después del COMMIT, la key quedó `completed` con respuesta → replay. Si muere antes del COMMIT, no existe ni la key ni el efecto (misma transacción) → el reintento ejecuta limpio. Un `in_progress` COMMITEADO solo puede provenir de un flujo multi-paso ajeno a esta capa (aquí el claim y el efecto commitean juntos); NO se auto-resuelve: bloquea su `(tenant, endpoint, key)` con `processing_in_flight` hasta la purga administrada. Por eso el `IdempotencyWatchdog` (0041 · §2) lo surfacea y alerta para investigación manual — jamás se borra automáticamente (podría ser una operación externa viva, y borrarlo arriesgaría doble ejecución).

## 4. Idempotencia hacia proveedores

Toda llamada mutante al proveedor lleva la referencia idempotente que el proveedor soporte (o el `attempt_id` propio como referencia externa). Ante timeout ambiguo NO se reintenta a ciegas: attempt `indeterminate` → consulta/webhook/conciliación (V4 §23).

## 5. Retención

Configurable por entorno y endpoint (Nivel C). La purga de keys expiradas es un job administrado (excepción documentada a la prohibición de DELETE, por clasificación de datos técnicos — ver auditoría D/contradicción 1 y F1-09).

## 6. Pruebas exigidas (Gate Idempotencia)

Replay exacto; rechazo por payload distinto; carrera de N requests concurrentes con la misma key → 1 efecto; crash simulado antes/después de COMMIT; caída de Redis (si se añade fast-path) sin duplicados. Property test: para toda secuencia de reintentos, el número de efectos == 1.
