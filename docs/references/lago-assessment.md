# Evaluación: Lago (getlago/lago)

Estado: Activo · Fase 0 · **Licencia: AGPL-3.0** en su core según conocimiento a 2026-01 (con features premium bajo licencia comercial) — la advertencia del V4 §10.5 sobre licencia es correcta y decisiva. Verificar (F0-VER).

## Problema que resuelve
Billing y metering open-source: suscripciones, invoicing, dunning, usage-based billing, multi-gateway.

## Posición para Fluvia
**Solo referencia conceptual futura.** Billing/suscripciones están fuera del MVP (§9). No se adopta código ni se integra el servicio en el MVP.

## Implicación de la AGPL
Integrar código AGPL en el monolito propietario de Fluvia contaminaría la base (obligación de liberar fuente del servicio de red). Vías seguras si algún día se usa: (a) desplegarlo como **servicio separado sin modificar**, hablándole por API (la AGPL no se propaga por API a través de procesos separados), o (b) contrato comercial con Lago. Cualquier decisión futura requiere ADR + revisión de licencia formal.

## Qué observar como inspiración (sin código)
- Separación conceptual billing ↔ payments: los fees de Fluvia (Fase 4) son contabilidad de la transacción, no billing de suscripción — no mezclar dominios.
- Su modelo de eventos de uso (metering) como referencia si Fluvia algún día factura por volumen de API.
