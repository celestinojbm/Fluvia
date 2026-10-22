# Modelo de negocio — Fluvia BNPL (borrador)

Estado: **BORRADOR** · Definido por el propietario (Celestino Briceño) el 2026-10-22 · ADR: [`docs/adr/0013-modelo-bnpl-comercio-cobra-completo.md`](../adr/0013-modelo-bnpl-comercio-cobra-completo.md)

> Este documento describe el modelo comercial objetivo. **No autoriza** dinero real, `live`, producción, proveedor real, socio financiero real ni contacto con terceros. Todo sigue en **sandbox cerrado** (freeze #24 vigente).

## 1. En una frase

Fluvia funciona como **Afterpay** (compra ahora, paga después): **el comercio cobra completo de una vez**, **el cliente paga en cuotas sin interés**, y **Fluvia cobra una comisión al comercio**. El adelanto al comercio lo **financia un socio financiero** (banco o fondo).

## 2. Actores y flujo del dinero

| Actor | Qué recibe | Qué paga |
|---|---|---|
| Cliente | El producto hoy | El precio en N cuotas **sin interés** |
| Comercio | El **total** de la venta en una sola liquidación (menos la comisión) | Comisión (MDR) a Fluvia |
| Socio financiero (banco/fondo) | Las cuotas del cliente + su parte de la comisión/fondeo | El adelanto al comercio |
| Fluvia | Comisión neta | Riesgo operativo/scoring, cobranza |

Flujo: compra aprobada → plan de cuotas creado → socio financia el adelanto → Fluvia liquida al comercio el total − comisión → el cliente paga cuotas → las cuotas reembolsan al socio.

## 3. Mercado y diferenciación

- **Arranca en Venezuela** (VES/USD) — decisión #15 actualizada el 2026-10-22. **Colombia es la segunda fase** (no descartada); la investigación legal F5.0 se conserva para esa fase. Venezuela tiene su propia revisión legal (BNPL-07).
- **Frente a Cashea**: según TalCual (17-oct-2026, artículo sobre colegios, atribuido a la empresa), en su modelo **Express** Cashea liquida a los aliados **cada 42 días** y **asume las cuotas**, así que el comercio tampoco carga con la morosidad. Fluvia busca liquidar al comercio el total, menos la comisión, en **una sola liquidación** (plazo por definir). La diferencia está en el momento y la forma de la liquidación, no en quién asume el riesgo. Es contexto interno: el copy público no compara con competidores (ver `COPY-COMERCIO.md`).
- Referentes: **Cashea** (BNPL líder en Venezuela) y **Fina**.

## 4. Mensajes (copy)

- Comercio: **«Tú cobras completo. Tu cliente paga en cuotas.»**
- Cliente: **«Compra hoy. Paga con calma.»**
- Mientras sea sandbox: mostrar **«Próximamente»** en toda promesa comercial (cuotas, liquidación, alta de comercio/cliente). Nada de tarifas vigentes ni CTAs de alta real.

## 5. Implicaciones para el roadmap

1. **Motor de cuotas** (nuevo dominio): plan de pagos (N cuotas, fechas, montos con redondeo por mayor residuo, 0 % interés), FSM de cuota (`scheduled → due → paid | late | defaulted | canceled`), recargos por mora (decisión pendiente), reembolsos/anulaciones que recalculan el plan. Todo sobre el ledger existente.
2. **Liquidación al comercio** (reaprovecha settlement/payout F4): liquidación única del total − comisión al aprobar la compra, independiente de las cuotas. Nuevas cuentas: `partner.funding`, `customer.receivable`, `merchant.payable`.
3. **Socio financiero**: modelo de fondeo (línea de crédito / compra de cartera / pool), cuentas por socio, conciliación de fondeo y de cuotas cobradas; reportes al socio. En sandbox: **socio simulado** (análogo a MockProvider).
4. **Riesgo / scoring**: límite de compra por cliente, decisión en el checkout, límites por comercio, reglas antifraude, KYC del cliente. Inicialmente reglas simples y deterministas en sandbox.
5. **VES**: operar en bolívares (y USD de referencia), tasa de cambio oficial para planes indexados, redondeos, Pago Móvil como medio de cobro de cuotas (simulado). Conecta con el issue #74.
6. **Pricing**: la comisión al comercio sustituye al «fee 2 % por transacción» (decisión #25) como modelo comercial; el valor sigue pendiente (PEND-002 pospuesto hasta tener clientes, issue #78).

## 6. Fuera de alcance hasta decisión explícita

Dinero real, socio financiero real, KYC real, cobranza real, comunicación con comercios/clientes, deploy público.
