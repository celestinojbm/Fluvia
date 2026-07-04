# ADR-0007 — Outbox e Inbox sobre PostgreSQL

Estado: Aceptado · Fase 0 · Diseño en `../architecture/outbox-inbox.md`

## Contexto
Nivel A: prohibidas llamadas externas dentro de transacciones SQL; prohibido que eventos críticos vivan solo en RAM.

## Decisión
- **Outbox**: `outbox_events` insertado en la transacción del cambio de dominio; relay worker con `FOR UPDATE SKIP LOCKED`, backoff exponencial con jitter, DLQ (`dead`) y replay auditado. Semántica at-least-once, consumidores deduplican.
- **Inbox**: `provider_events` con unique `(provider, provider_event_id)`; firma verificada antes de persistir; respuesta al proveedor solo tras COMMIT; procesamiento asíncrono con validación Zod y DLQ de payloads inválidos.

## Alternativas
Publicar a Redis/broker directamente desde el request (rechazado: ventana de pérdida entre COMMIT y publish, o publish sin COMMIT); CDC/logical replication (Debezium) (rechazado en MVP: infraestructura pesada para el volumen; reevaluable a escala); LISTEN/NOTIFY como único mecanismo (rechazado: no durable; puede añadirse como despertador del relay, optimización Nivel C).

## Consecuencias
+ Cero pérdida de eventos ante caídas; replay natural. − Polling añade latencia y carga (índice parcial + batch + posible NOTIFY como trigger de despertar).

## Evidencia
Tabla y semántica definidas en el spike; worker y pruebas en F2-11/F2-12.
