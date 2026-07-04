# Estrategia de idempotencia

Estado: Activo · Fase: 0 · ADR-0006 · Nota: el header `Idempotency-Key` sigue un draft IETF, no un RFC; este documento define el contrato propio de Fluvia.

> **Estado de implementación (AUD-P3-002, 2026-07-04): PARCIAL.** Construido: idempotencia del ledger (`ledger_transactions.idempotency_key` único por tenant, replay exacto con comparación de payload completo — AUD-P2-001) y la tabla `idempotency_keys` con PK `(tenant_id, endpoint, key)` (0008, AUD-P1-009). NO construido: el middleware HTTP que consuma esa tabla (F2-12); ningún endpoint expone aún `Idempotency-Key`.

## 1. Principio

La idempotencia se diseña **antes** de exponer cualquier endpoint mutante (V4 §19, §49). Fuente de verdad: **PostgreSQL**. Redis solo puede añadir un fast-path/lock corto, y su pérdida total no debe permitir duplicados (Gate Idempotencia §51).

## 2. Capas

**Capa API (`idempotency_keys`):** para endpoints mutantes públicos (`POST /v1/payment_intents`, confirm, refunds…).

```
PK (tenant_id, endpoint, key)
request_hash    sha256 canónico del payload normalizado
status          in_progress | completed
response_status / response_body   respuesta persistida para replay
expires_at      retención configurable (Nivel C; default inicial 24 h para sandbox)
```

**Capa dominio:** claves naturales y unique constraints que hacen imposible el duplicado aunque la capa API falle: `ledger_transactions (tenant_id, idempotency_key)`, `provider_events (provider, provider_event_id)` (inbox), `webhook_attempts (event_id, attempt_no)`, un solo attempt activo por intent (unique parcial).

## 3. Contrato del endpoint mutante

| Situación | Comportamiento |
|-----------|----------------|
| Key nueva | Se inserta `in_progress` en la MISMA transacción que el efecto; al final se persiste la respuesta (`completed`) |
| Key repetida + mismo `request_hash` + `completed` | Replay exacto de la respuesta persistida (mismo status y body) |
| Key repetida + mismo hash + `in_progress` | `409 processing_in_flight` (el cliente reintenta luego); evita doble ejecución concurrente |
| Key repetida + `request_hash` distinto | `422 idempotency_key_reuse` — rechazo, nunca ejecutar |
| Key ausente en endpoint que la exige | `400 idempotency_key_required` |

Recuperación tras crash: si el proceso muere después del COMMIT, la key quedó `completed` con respuesta → replay. Si muere antes del COMMIT, no existe ni la key ni el efecto (misma transacción) → el reintento ejecuta limpio. El estado `in_progress` huérfano (crash entre transacciones de un flujo multi-paso) expira por TTL corto y se resuelve consultando el recurso por clave natural.

## 4. Idempotencia hacia proveedores

Toda llamada mutante al proveedor lleva la referencia idempotente que el proveedor soporte (o el `attempt_id` propio como referencia externa). Ante timeout ambiguo NO se reintenta a ciegas: attempt `indeterminate` → consulta/webhook/conciliación (V4 §23).

## 5. Retención

Configurable por entorno y endpoint (Nivel C). La purga de keys expiradas es un job administrado (excepción documentada a la prohibición de DELETE, por clasificación de datos técnicos — ver auditoría D/contradicción 1 y F1-09).

## 6. Pruebas exigidas (Gate Idempotencia)

Replay exacto; rechazo por payload distinto; carrera de N requests concurrentes con la misma key → 1 efecto; crash simulado antes/después de COMMIT; caída de Redis (si se añade fast-path) sin duplicados. Property test: para toda secuencia de reintentos, el número de efectos == 1.
