# ADR-0006 — Idempotencia durable en PostgreSQL

Estado: Aceptado · Fase 0 · Contrato completo en `../architecture/idempotency.md`

## Contexto
V2/V3 apoyaban idempotencia en locks de Redis; si el lock expira antes de terminar el proceso, un segundo request duplica el efecto. V4 §19 exige fuente durable.

## Decisión
La garantía vive en Postgres: tabla `idempotency_keys` (PK compuesta tenant+endpoint+key, hash de request, respuesta persistida) insertada **en la misma transacción que el efecto**, más claves naturales únicas en cada tabla de dominio (defensa aunque la capa API falle). Redis solo como fast-path opcional futuro, nunca la garantía.

## Alternativas
Redis con TTL (rechazado: pierde ante crash/expiración); dedup solo por unique de dominio sin replay de respuesta (rechazado: el cliente no puede distinguir replay de error).

## Consecuencias
+ Crash-safe por construcción (misma transacción); replay exacto de respuesta; el Gate Idempotencia es demostrable. − Crecimiento de la tabla → retención configurable con purga administrada (excepción de clasificación de datos, F1-09).

## Evidencia
Diseño validado por el patrón del spike (`ON CONFLICT DO NOTHING` + PK compuesta); pruebas formales en F2-09/F2-10.
