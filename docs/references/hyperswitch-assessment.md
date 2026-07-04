# Evaluación: Hyperswitch (juspay/hyperswitch)

Estado: Activo · Fase 0 · Licencia: Apache-2.0 según conocimiento a 2026-01; **verificar en el repo antes de adoptar código** (el proxy de esta sesión impide la verificación en vivo; tarea F0-VER en backlog). Lenguaje: Rust.

## Problema que resuelve
Orquestador de pagos open-source completo: enrutamiento multi-proveedor, normalización de conectores, lifecycle de pagos, vault, reintentos, control center.

## Qué adoptar (conceptos)
- **Modelo de conector/adaptador**: interfaz única con normalización estricta de estados, errores y monedas por proveedor — valida nuestro diseño de `PaymentProviderAdapter` (V4 §22).
- **Separación intent/attempt**: su modelo de `payment_attempt` por intento real confirma nuestra FSM separada.
- Taxonomía de errores normalizados conservando el error crudo del proveedor.

## Qué adaptar
- Su máquina de estados de pagos: más rica que la nuestra; usar como checklist de estados que el MVP decide no soportar aún (capturas múltiples, mandates).
- Patrones de health/latency por conector para el circuit breaker (Fase 5).

## Qué usar como inspiración
Control center (panel admin), estructura de contract tests por conector.

## Qué rechazar
- **Rust**: reescribir el stack o depender de un binario externo contradice el monolito TS y añade una frontera operativa sin necesidad en el MVP.
- **Adoptar la plataforma entera**: su alcance (routing multi-proveedor) es exactamente lo que §9 pospone.
- Su complejidad de despliegue (múltiples servicios) para un volumen sandbox.

## Adoptar vs construir
Construir la orquestación mínima propia. Hyperswitch optimiza el problema "N proveedores, routing inteligente"; el MVP tiene 1 mock + 1 proveedor futuro. El costo de integrar/operar Hyperswitch supera al de nuestro núcleo reducido, y perderíamos la transaccionalidad misma-BD con el ledger.

## Riesgos de la decisión
Reinventar normalizaciones que ellos ya depuraron → mitigado usando su repo como referencia de casos borde al escribir cada adapter.
