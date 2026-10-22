# ADR 0013 — Modelo BNPL: el comercio cobra completo, el cliente paga en cuotas

- Estado: **Propuesto** (borrador; pendiente de aceptación formal del propietario en revisión del PR)
- Fecha: 2026-10-22
- Decisor: Celestino Briceño (propietario)

## Contexto
Fluvia se construyó como infraestructura de pagos con ledger de doble partida (fases 1–4, F6/F6.5 en sandbox cerrado). El propietario define ahora el modelo comercial: compra ahora, paga después (tipo Afterpay), arrancando en Venezuela frente a Cashea.

## Decisión
1. El comercio recibe el **total** de la venta en una sola liquidación, menos la comisión de Fluvia.
2. El cliente paga en **cuotas (condiciones de interés y mora pendientes de BNPL-07)**.
3. Ingreso de Fluvia: **comisión al comercio**.
4. El adelanto lo financia un **socio financiero** (banco o fondo); Fluvia no presta con balance propio.
5. Mercado inicial: **Venezuela**; **Colombia** en segunda fase.
6. Mientras sea sandbox, todo mensaje comercial va con **«Próximamente»**.

## Consecuencias
- El ledger, la FSM, la idempotencia, outbox/webhooks y settlement/payout existentes son la base; se añaden los dominios **cuotas**, **fondeo del socio** y **riesgo/scoring** (ver `docs/product/MODELO.md` §5).
- Decisión #15 actualizada: **Venezuela primero, Colombia como segunda fase** (no descartada). F5.0 (Colombia) se conserva para esa fase; Venezuela requiere su propia revisión legal (BNPL-07).
- La decisión #25 (fee 2 %) queda como parámetro de sandbox; el pricing BNPL real sigue pendiente (PEND-002, pospuesto, issue #78).
- La landing (PR #80) debe reflejar el modelo BNPL, no una pasarela de pagos genérica.
- No autoriza dinero real, `live`, producción ni socio real.
