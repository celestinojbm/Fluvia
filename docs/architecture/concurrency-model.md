# Modelo de concurrencia

Estado: Activo · Fase: 0 · Justificación formal exigida por la matriz de documentos; parámetros = Nivel C

## 1. Principio

No hay una única estrategia de locking (V4 §17.6): cada operación declara la suya. La tabla siguiente es normativa para el MVP.

| Operación | Estrategia | Justificación |
|-----------|-----------|---------------|
| Posting de ledger (multi-cuenta) | **Pesimista**: `SELECT … ORDER BY id FOR UPDATE` con IDs normalizados y ordenados determinísticamente | Contención esperada en cuentas calientes (clearing del proveedor); el orden total elimina deadlocks por diseño; la transacción es corta y sin red |
| Rollup de proyección | **Optimista**: `UPDATE … WHERE version = expected`, retry limitado | Detecta escrituras fuera del camino sancionado incluso bajo el lock pesimista (defensa en profundidad) |
| Transición de FSM (intent/attempt/refund) | `SELECT … FOR UPDATE` de la fila + guard de `version` | Una fila; barato; la FSM valida origen→destino |
| Claim de outbox/inbox | `FOR UPDATE SKIP LOCKED` | Múltiples workers sin bloqueo mutuo ni doble claim |
| Idempotencia | `INSERT … ON CONFLICT DO NOTHING` + PK compuesta | La unicidad la garantiza el motor, no la aplicación |
| Migraciones | `pg_advisory_lock` global | Un solo migrador a la vez (ya en el spike) |
| Duplicado de evento de proveedor | Unique `(provider, provider_event_id)` | Constraint > coordinación |

Aislamiento: `READ COMMITTED` como default + locks explícitos de la tabla anterior. `SERIALIZABLE` se reserva para flujos donde el análisis muestre anomalías no cubiertas (se decidirá con evidencia; Nivel C).

## 2. Reglas anti-deadlock (normativas)

1. Orden total de adquisición: cuentas por UUID ascendente; si un flujo toca filas de tablas distintas, orden fijo de tablas documentado en el servicio.
2. Transacciones cortas: prohibido I/O de red y trabajo de CPU pesado bajo locks.
3. Deadlocks (40P01) y serialization failures (40001): retry con backoff limitado (baseline 3 intentos) + métrica `ledger.deadlock_retries`; agotamiento → error explícito, nunca silencio.

## 3. Retries y doble efecto

Un retry de transacción completa es seguro solo porque (a) la idempotencia vive dentro de la misma transacción y (b) los efectos externos van por outbox. Regla: cualquier función que se reintente debe ser puramente transaccional.

## 4. Pruebas de concurrencia (F2, Gate Ledger)

- N postings concurrentes sobre cuentas compartidas con pares en orden aleatorio → 0 deadlocks no recuperados, sumas exactas, `version` == número de posts.
- Carrera de idempotencia: M requests idénticos concurrentes → 1 efecto.
- Confirmaciones/refunds simultáneos sobre el mismo intent → FSM consistente.
- Webhooks duplicados concurrentes → 1 procesamiento.
- Baseline de carga reproducible (el número exacto es Nivel C y se define con el entorno de CI; no se usa un número mágico como definición de calidad — corrección V4 sobre V3).
