# ADR-0009 — Webhooks salientes internos; Svix como opción futura

Estado: Aceptado · Fase 0 · Comparación en `../references/svix-assessment.md`

## Contexto
V4 §10.4 exige comparar construir, usar Svix SaaS o autohospedarlo.

## Decisión
Motor interno sobre el outbox propio (firma HMAC-SHA256 versionada `v1=` con timestamp, endpoint/event/attempt, rotación de dos secretos, backoff con jitter, DLQ, reenvío auditado, SSRF guard completo). Contrato de firma conceptualmente compatible con el patrón Svix para que una migración futura no rompa a los comercios.

## Alternativas
Svix SaaS (rechazado MVP: payloads de pagos salen a un tercero — clasificación de datos — y añade dependencia en el camino crítico); Svix self-hosted (rechazado MVP: operar un servicio Rust + su BD para volumen sandbox).

## Consecuencias
+ Datos y evidencia locales, RLS uniforme, sin costo/dependencia. − Deliverability avanzada (pools de IP, reputación) no existe → criterio de reevaluación: >~1M entregas/mes, requisitos de deliverability de clientes, o coste de mantenimiento del worker superando la integración.

## Evidencia
Diseño en `../architecture/webhook-delivery.md`; implementación F3.
