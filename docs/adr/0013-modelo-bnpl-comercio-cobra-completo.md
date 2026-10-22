# ADR 0013 — Modelo BNPL: el comercio cobra completo, el cliente paga en cuotas

- Estado: **Propuesto** (borrador; pendiente de aceptación formal del propietario en revisión del PR)
- Fecha: 2026-10-22
- Decisor: Celestino Briceño (propietario)

## Contexto
Fluvia se construyó como infraestructura de pagos con ledger de doble partida (fases 1–4, F6/F6.5 en sandbox cerrado). El propietario define ahora el modelo comercial: compra ahora, paga después (tipo Afterpay), arrancando en Venezuela frente a Cashea.

## Decisión
1. El comercio recibe el **total** de la venta en una sola liquidación, menos la comisión de Fluvia.
2. El cliente paga en **cuotas sin interés**.
3. Ingreso de Fluvia: **comisión al comercio**.
4. El adelanto lo financia un **socio financiero** (banco o fondo); Fluvia no presta con balance propio.
5. Mercado inicial: **Venezuela**.
6. Mientras sea sandbox, todo mensaje comercial va con **«Próximamente»**.

## Consecuencias
- El ledger, la FSM, la idempotencia, outbox/webhooks y settlement/payout existentes son la base; se añaden los dominios **cuotas**, **fondeo del socio** y **riesgo/scoring** (ver `docs/product/MODELO.md` §5).
- Revisa la decisión #15 (Colombia) y el alcance de F5.0: la investigación legal debe repetirse para Venezuela (BNPL/crédito al consumo, rol del socio, custodia).
- La decisión #25 (fee 2 %) queda como parámetro de sandbox; el pricing BNPL real sigue pendiente (PEND-002, pospuesto, issue #78).
- La landing (PR #80) debe reflejar el modelo BNPL, no una pasarela de pagos genérica.
- No autoriza dinero real, `live`, producción ni socio real.
