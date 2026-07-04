# ADR-0002 — PostgreSQL como fuente transaccional; Redis como acelerador

Estado: Aceptado · Fase 0 · Nivel B (default confirmado)

## Contexto
El sistema exige durabilidad de eventos financieros, RLS, constraints ricos y colas transaccionales.

## Decisión
PostgreSQL 16+ es la única fuente de verdad: dominio, ledger, outbox, inbox, idempotencia y auditoría viven ahí. Redis se usa exclusivamente para caché, locks cortos y rate limiting; su pérdida total no puede causar pérdida ni duplicación de movimientos (verificado por el Gate Idempotencia).

## Alternativas
Kafka/NATS para eventos (rechazado en MVP: el outbox sobre Postgres da at-least-once sin operar un broker); Redis Streams como cola primaria (rechazado: volatilidad/complejidad de persistencia AOF frente al requisito Nivel A).

## Consecuencias
+ Una sola tecnología durable que dominar; transacciones que abarcan dominio+eventos. − El polling del outbox añade latencia (aceptable vs. SLO baseline) y carga (mitigada con índice parcial + SKIP LOCKED).

## Evidencia
Spike: migraciones, RLS, triggers y advisory locks verificados contra PG16 real.
