# Evaluación: Stripe Samples — accept-a-payment

Estado: Activo · Fase 0 · Licencia: MIT según conocimiento a 2026-01 (verificar, F0-VER). Ejemplos oficiales multi-lenguaje.

## Problema que resuelve
Muestra los flujos canónicos de aceptación de pago: checkout alojado, elementos embebidos, confirmación, acciones adicionales (3DS), estados asíncronos.

## Qué adoptar (conceptos)
- **Tokenización del lado del cliente hacia el proveedor**: el backend del comercio jamás toca PAN — exactamente nuestra estrategia PCI (`security/pci-scope.md`), incluida en el MockProvider.
- **Confirmación server-side con client secret de un solo uso**: el monto y la moneda son del servidor; el navegador solo porta una credencial efímera del intent. Aplica a nuestro checkout (V4 §24 "nunca confíes en el monto del navegador").
- El patrón `requires_action` → el frontend resuelve la acción → el backend re-confirma; nuestros estados `requires_action`/`processing` lo reflejan.
- DX: mensajes de error accionables y estados visibles de extremo a extremo.

## Qué adaptar
- Su modelo de webhooks como fuente de verdad post-asíncrono (nosotros lo generalizamos con el inbox).

## Qué rechazar
- Copiar contratos exactos del API de Stripe (nombres, formas de objetos): Fluvia define contratos propios (§5); la semejanza es conceptual (intents/FSM son ya un estándar de la industria), no literal.
- Dependencia conceptual exclusiva de Stripe: nuestro adapter debe mapear igual de bien a proveedores LATAM cuyo modelo es más asíncrono (PSE, OXXO).

## Riesgos
Sesgo "card-first" en el diseño del checkout → mitigado modelando métodos asíncronos y `requires_action` desde la FSM inicial.
