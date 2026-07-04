# ADR-0010 — Fastify + Zod sin NestJS

Estado: Aceptado · Fase 0

## Contexto
V4 §12 propone "NestJS con Fastify o alternativa justificada".

## Decisión
Fastify directo + Zod para validación runtime + OpenAPI generado desde los schemas. Servicios de dominio como clases/funciones TypeScript planas inyectadas explícitamente (composition root manual), sin contenedor DI por decoradores.

## Justificación
En un sistema financiero queremos límites transaccionales, locks y contexto de tenant **visibles en el código del handler**, no detrás de interceptores/decoradores. NestJS aporta estructura a equipos grandes, pero: introduce metadata reflection y un ciclo de vida propio entre el request y la transacción; su capa sobre Fastify retrasa el acceso a features del servidor; y la validación con class-validator/class-transformer duplica lo que Zod ya hace mejor con inferencia de tipos (`.strict()` anti mass-assignment).

## Alternativas
NestJS+Fastify (viable; rechazado por lo anterior — si el equipo humano futuro lo prefiere, la lógica vive en paquetes de dominio y portar los handlers es barato); Hono/Express (menor ecosistema de plugins de producción o menor rendimiento).

## Consecuencias
+ Menos magia, stack más corto de depurar, arranque más simple. − Convenciones (módulos, guards) deben documentarse en `CONTRIBUTING.md` en lugar de venir impuestas por el framework.

## Evidencia
Patrón validado en el diseño del spike (handlers finos + servicios de dominio + `withTenantTransaction`).
