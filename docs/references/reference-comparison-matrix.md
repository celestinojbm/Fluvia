# Matriz comparativa de referencias

Estado: Activo · Fase 0 · Detalle por referencia en los assessments de este directorio. Licencias según conocimiento a 2026-01; verificación en vivo pendiente (F0-VER) porque el entorno de esta sesión restringe el acceso a repos externos.

| Referencia | Licencia (verificar) | Problema que resuelve | Decisión Fase 0 | Riesgo principal |
|------------|---------------------|-----------------------|-----------------|------------------|
| Hyperswitch | Apache-2.0 | Orquestación multi-proveedor completa | **Inspiración conceptual** (adapters, intent/attempt, errores normalizados); no adoptar plataforma ni Rust | Reinventar casos borde de conectores → usarlo como checklist |
| Formance Ledger | MIT histórico / revisar | Ledger doble partida como servicio | **No adoptar como servicio**; ledger interno (ADR-0004); candidato de extracción futura | Menos madurez contable propia → property tests + invariantes externas |
| Stripe accept-a-payment | MIT | Flujos canónicos de checkout/tokenización | **Adoptar conceptos** (tokenización client→provider, confirm server-side, requires_action) | Sesgo card-first → modelar métodos asíncronos desde el día 1 |
| Svix | MIT (server) | Webhook delivery como servicio | **Interno para MVP** con contrato compatible (ADR-0009); reevaluar por volumen | Deliverability a escala → criterio de migración documentado |
| Lago | **AGPL-3.0** | Billing/metering | **Solo referencia futura**; jamás código en el monolito | Contaminación AGPL → solo servicio separado o licencia comercial |

## Referencias adicionales incorporadas (§10.6)

| Referencia | Uso | Por qué |
|------------|-----|---------|
| PostgreSQL docs (RLS, constraint triggers, SKIP LOCKED) | Normativa de implementación | Los tres mecanismos que sostienen tenancy, balanceo y colas |
| draft-ietf-httpapi-idempotency-key-header | Referencia (no estándar) | Confirma que definimos contrato propio de idempotencia |
| OWASP ASVS + API Security Top 10 | Checklist de seguridad F1/F6 | Base de las pruebas BOLA/mass-assignment/SSRF |

No se añaden más referencias por ahora: cada una de las anteriores cubre una necesidad concreta del backlog.
