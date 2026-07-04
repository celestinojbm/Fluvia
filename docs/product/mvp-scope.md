# Alcance estricto del MVP

Estado: Activo · Fase: 0

## 1. Demostración E2E obligatoria (V4 §8)

El MVP se considera completo cuando este flujo corre localmente, reproducible y con evidencia:

crear usuario → organización → comercio → API key sandbox → customer → payment intent → checkout session → abrir checkout → tokenizar/simular método → confirmar pago → respuesta simulada del proveedor → evento del proveedor recibido, verificado y deduplicado (inbox) → transición de la FSM → asientos en el ledger → proyección de balance → webhook firmado al comercio → operación visible en dashboard → refund → asiento compensatorio → proyección actualizada → conciliación → discrepancias visibles si existen → evidencia auditable.

## 2. Decisiones de alcance de Fase 0

| Dimensión | Decisión MVP |
|-----------|--------------|
| País | **Colombia** (decidido 2026-07-04). Sin reglas legales codificadas hasta completar `compliance/jurisdiction-matrix.md` con revisión legal (bloquea Fase 5, no F1–F4) |
| Moneda | Modelo multi-moneda desde el día 1; sandbox opera con **COP** como moneda principal + USD y CLP (exponente 0) en tests multi-moneda |
| Proveedor | **MockPaymentProvider** únicamente; candidatos reales para Fase 5: Wompi, PayU, dLocal, Mercado Pago |
| Método de pago | Tarjeta simulada con tokenización del lado del "proveedor" (el backend de Fluvia nunca ve PAN/CVV, ni siquiera simulado) + **método asíncrono de redirección tipo PSE** en el MockProvider (ejercita `requires_action`, pendientes largos y webhooks tardíos) |
| Tenancy | Organization → Merchant; multi-tenant real con RLS desde la primera migración |
| Entornos | local y test; sandbox/staging al final de Fase 3 |

## 3. Dentro del MVP

- Identidad: registro, verificación de correo, login con MFA TOTP, sesiones revocables, RBAC básico (owner, admin, developer, finance, read_only).
- Organizaciones, comercios, API keys sandbox (hash, secreto mostrado una vez, scopes básicos).
- Customers con metadata validada.
- Payment intents + FSM completa; payment attempts; refunds totales y parciales.
- Checkout session alojado (app separada) + payment links básicos.
- Ledger de doble partida interno con Chart of Accounts inicial y proyecciones de balance.
- Idempotencia durable en todos los endpoints mutantes.
- Outbox (salida) + Inbox (entrada de eventos del proveedor) con DLQ y replay administrativo.
- Webhooks salientes firmados (HMAC, timestamp, reintentos con backoff, SSRF guard).
- Conciliación contra el "reporte" del MockProvider con creación de casos.
- Dashboard comercial mínimo (overview, payments, refunds, balance, developers/webhooks).
- Panel admin mínimo (buscar comercios, ver eventos, reprocesar webhooks, casos de conciliación).
- Auditoría append-only de acciones sensibles.
- Observabilidad: logs estructurados con correlation ID, métricas base, health/readiness.

## 4. Fuera del MVP (V4 §9)

Banco propio, custodia real, tarjetas emitidas, wallet regulada, préstamos/crédito, cripto, FX propio, marketplace global, múltiples países reales, múltiples proveedores reales, routing inteligente, vault propio de tarjetas, billing/suscripciones complejas, motor autónomo de fraude con IA, apps móviles nativas, programa completo de chargebacks (solo el modelo de datos queda preparado), multirregión, decenas de SDKs.

Regla: cualquier propuesta de reincorporar algo de esta lista requiere justificación escrita de que es indispensable para demostrar el núcleo.

## 5. Criterios de salida del MVP

1. Flujo §1 verde en CI con Postgres y Redis reales.
2. Gates técnicos de ledger, multi-tenant e idempotencia de `compliance/production-gates.md` en verde para entorno sandbox.
3. Suites de concurrencia (confirmaciones/refunds/webhooks duplicados) sin duplicados ni drift.
4. Documentación de integración suficiente para el time-to-first-payment < 30 min.
