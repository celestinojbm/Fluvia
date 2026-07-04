# Evaluación: Svix (svix/svix-webhooks)

Estado: Activo · Fase 0 · Licencia: MIT (server open-source) según conocimiento a 2026-01 (verificar, F0-VER). Servidor en Rust; SDKs multi-lenguaje; también servicio SaaS.

## Problema que resuelve
Entrega de webhooks como servicio: firmas versionadas, reintentos con backoff, rotación de secretos, DLQ, reenvíos, portal de endpoints, multi-tenancy.

## Comparación exigida (§10.4): interno vs Svix SaaS vs Svix autohospedado

| Dimensión | Interno (elegido para MVP) | Svix SaaS | Svix self-hosted |
|-----------|---------------------------|-----------|------------------|
| Firmas/rotación | Implementamos su esquema conceptual (HMAC versionado `v1=`, timestamp) | Resuelto | Resuelto |
| Reintentos/DLQ/replay | Sobre nuestro outbox (ya necesario para todo lo demás) | Resuelto | Resuelto |
| SSRF | Debemos implementarlo sí o sí (también para cualquier fetch saliente) | Delegado | Parcialmente nuestro |
| Multi-tenant | Nuestro modelo RLS uniforme | Mapeo a su modelo de apps | Ídem + operar su stack |
| Datos de eventos | Permanecen en nuestra base (evidencia/conciliación local) | Payloads salen a un tercero (clasificación de datos, residencia) | Permanecen, pero +1 servicio y BD |
| Costo/dependencia | Horas de ingeniería acotadas | $ + dependencia externa en el camino crítico | Operación de servicio Rust ajeno |

**Decisión (ADR-0009): implementación interna para el MVP**, con el contrato de firma deliberadamente compatible en concepto (HMAC versionado + timestamp + ids de evento/intento) para que migrar a Svix sea un cambio de transporte, no de contrato con los comercios. Reevaluar cuando el volumen o los requisitos de deliverability superen lo razonable para el worker propio (criterio en el ADR).

## Qué adoptar como inspiración inmediata
Esquema de firma y headers, modelo endpoint/event/attempt, política de desactivación de endpoints rotos con aviso, documentación de verificación para receptores (su enfoque de "webhook security" es el estado del arte).
