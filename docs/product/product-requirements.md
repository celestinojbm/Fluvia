# PRD inicial — Fluvia

Estado: Borrador activo · Fase: 0

## 1. Qué es Fluvia

Fluvia es una **capa de infraestructura y orquestación de pagos** para empresas, comercios, plataformas y desarrolladores. No es banco, adquirente, emisor, custodio ni procesador certificado, y no se presentará como tal mientras no exista evidencia documental de licencias y contratos (Prompt V4 §6).

Los pagos reales los procesan **proveedores autorizados**; Fluvia aporta la API uniforme, el ledger de doble partida, la orquestación de estados, el checkout, los webhooks, la conciliación y las herramientas operativas.

## 2. Problema

Integrar pagos en LATAM implica: APIs de proveedor heterogéneas, webhooks poco confiables, ausencia de ledger propio, conciliación manual en hojas de cálculo y errores de duplicación/pérdida de movimientos. Los comercios medianos no pueden costear el equipo que Stripe/Adyen tienen internamente.

## 3. Usuarios y personas

| Persona | Necesidad principal |
|---------|--------------------|
| Desarrollador integrador | API predecible, sandbox realista, errores estables, webhooks verificables, SDK TS |
| Operador financiero del comercio | Balance confiable, liquidaciones trazables, conciliación con evidencia |
| Operador de plataforma (Fluvia) | Panel administrativo, casos, congelamiento, reproceso de eventos, auditoría |
| Comprador final | Checkout rápido, claro, accesible y seguro |

## 4. Propuesta de valor

1. **Integridad financiera verificable**: ledger de doble partida inmutable + conciliación con casos y evidencia, no "confía en nosotros".
2. **Confiabilidad de eventos**: outbox/inbox transaccional; ningún evento crítico vive solo en RAM.
3. **Multi-tenant real**: aislamiento por defensa en profundidad (aplicación + RLS + pruebas de escape).
4. **DX de primer nivel**: sandbox-first, idempotencia en todos los endpoints mutantes, documentación OpenAPI, errores legibles por máquina.

## 5. Capacidades del producto (visión completa)

Organizaciones, comercios, onboarding, usuarios/roles, API keys, payment intents, checkout sessions, payment links, customers, refunds, eventos y webhooks, balances, fees, reservas, liquidaciones, payouts, conciliación, métricas, logs, casos operativos, adaptadores de proveedores. (Detalle de inclusión por fase en `mvp-scope.md` y `phase-plan.md`.)

## 6. Métricas de éxito del MVP (sandbox)

- Flujo E2E de §8 del prompt ejecutable localmente con un solo comando, reproducible.
- 0 discrepancias no explicadas entre ledger y proyección de balances tras las suites de concurrencia.
- 100% de eventos de dominio entregados u observables en DLQ (ningún evento perdido silenciosamente).
- Time-to-first-payment (sandbox) de un desarrollador nuevo: < 30 minutos siguiendo la documentación.

## 7. Requisitos no funcionales (resumen)

Prioridades en el orden del V4 §4. En concreto para el MVP: integridad financiera y aislamiento multi-tenant son invariantes (Nivel A); latencia y throughput se miden y se optimizan después (baseline en `architecture/system-overview.md`).

## 8. Modelo comercial (decisión pendiente, no bloqueante)

Opciones registradas: fee por transacción sobre el fee del proveedor, suscripción por volumen, o mixto. No bloquea las Fases 1–3; bloquea el diseño fino del motor de fees (Fase 4). Registrado en `agents/DECISIONS.md` como PEND-002.

## 9. Flujo de fondos (MVP)

En el MVP **no hay fondos reales**: el flujo de fondos es contable-simulado vía MockProvider. Los balances representan obligaciones contables derivadas del ledger, nunca depósitos. El flujo con proveedor real (Fase 5) mantendrá a Fluvia fuera de la custodia: los fondos van del pagador al proveedor/adquirente y de este al comercio; Fluvia registra, orquesta y concilia.
