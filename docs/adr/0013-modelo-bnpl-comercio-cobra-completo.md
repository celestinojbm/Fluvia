# ADR-0013 — Modelo BNPL: el comercio cobra su venta de una vez (total menos comisión), el cliente paga en cuotas

Estado: **Propuesto** (borrador; pendiente de aceptación formal del propietario, Celestino Briceño, en revisión del PR) · Fecha: 2026-10-22 · Bloqueado por BNPL-07 (revisión legal Venezuela) para todo lo relativo a interés, mora, acreedor y recurso

## Contexto

Fluvia se construyó como infraestructura de pagos con ledger de doble partida (fases 1–4, F6/F6.5 en sandbox cerrado). El propietario define ahora el modelo comercial: compra ahora, paga después (tipo Afterpay), arrancando en Venezuela. El contexto competitivo es interno (ver `docs/product/MODELO.md` §3) y no se usa en copy público.

## Decisión

1. El comercio recibe el **total** de la venta en una sola liquidación, menos la comisión de Fluvia.
2. El cliente paga en **cuotas** (condiciones de interés y mora pendientes de BNPL-07).
3. Ingreso de Fluvia: **comisión al comercio**.
4. El adelanto lo financia un **socio financiero** (banco o fondo); Fluvia no presta con balance propio.
5. Mercado inicial: **Venezuela**; **Colombia** en segunda fase.
6. Mientras sea sandbox, todo mensaje comercial va con **«Próximamente»**.

## Alternativas

- **Pasarela de pagos genérica (modelo anterior)**: descartada como propuesta principal; el ledger y la liquidación se reutilizan como base.
- **Fluvia presta con balance propio**: descartada; exige capital y licencia de crédito que hoy no existen.
- **El comercio cobra en cuotas a la par del cliente**: descartada; contradice la propuesta de valor (el comercio cobra de una vez).
- **Cobrar interés al cliente como ingreso principal**: no se adopta; depende de BNPL-07 y queda fuera del copy.

## Consecuencias

- El ledger, la FSM, la idempotencia, outbox/webhooks y settlement/payout existentes son la base; se añaden los dominios **cuotas**, **fondeo del socio** y **riesgo/scoring** (ver `docs/product/MODELO.md` §5).
- Decisión #15 actualizada: **Venezuela primero, Colombia como segunda fase** (no descartada). F5.0 (Colombia) se conserva para esa fase; Venezuela requiere su propia revisión legal (BNPL-07).
- La decisión #25 (fee de sandbox) queda como parámetro de sandbox; el pricing BNPL real sigue pendiente (PEND-002, pospuesto, issue #78).
- La landing (PR #80) debe reflejar el modelo BNPL, no una pasarela de pagos genérica.
- No autoriza dinero real, `live`, producción ni socio real.

## Riesgos

- **Regulatorio**: las cuotas probablemente cuentan como crédito; falta definir el acreedor y la licencia aplicable (SUDEBAN), sanciones OFAC e indexación a tasa BCV (BNPL-07).
- **Pérdida crediticia**: no está definido si el socio compra la cartera con o sin recurso contra Fluvia o contra el comercio (impagos, devoluciones, contracargos, fraude). Hasta resolverlo, el copy no promete ausencia de recurso.
- **Socio financiero**: no existe aún; sin contrato no hay fondeo ni operación real.
- **Copy**: riesgo de reutilizar contexto interno (competidores, cifras) como copy público; mitigado con tests de la landing y advertencias en los documentos.

## Evidencia

`docs/product/MODELO.md`, `docs/product/COPY-COMERCIO.md`, decisión #32 en `docs/agents/DECISIONS.md`, BNPL-01…10 en `docs/agents/BACKLOG.md`. Revisión de copy de Legal y Cumplimiento (22-oct-2026) y revisión automática de Claude Code en el PR #81.
