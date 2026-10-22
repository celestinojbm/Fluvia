# Roadmap Venezuela → Colombia

Decisión de Celestino: **Venezuela primero** (USD y Bs a tasa BCV), **luego Colombia** (COP). EE. UU. es secundario.
Documento interno; no es copy público (sin cifras en copy público).

## Fases
1. **F-VE.0 Bloqueante legal** — análisis de Legal y Cumplimiento (#82, BNPL-07). Nada en producción ni dinero real antes.
2. **F-VE.1 Base multimoneda** — modelo de datos (#84) y tasa BCV (#83, BNPL-09).
3. **F-VE.2 Cobro local** — Pago Móvil y transferencias (#85), conciliación.
4. **F-VE.3 Identidad y localización** — KYC VE (#86), i18n es-VE (#87).
5. **F-CO** — Colombia/COP (#88), tras validar Venezuela.

## Multimoneda (USD / VES / COP)
- Montos en **unidades menores enteras** (centavos); nunca flotantes.
- Cada monto lleva código ISO 4217. Se guardan moneda de precio, moneda de pago, tasa aplicada y su marca de tiempo/fuente.
- La tasa se **fija por transacción** al momento de la venta; las cuotas registran la tasa usada en cada pago.

## Tasa BCV diaria
- Fuente: publicación oficial del BCV (fuente exacta a validar con Legal).
- Ingesta diaria programada (worker), con auditoría.
- Fallback: última tasa válida con antigüedad máxima configurable + alerta; si se supera, se bloquean cobros en VES.
- Redondeo: regla única documentada (half-even en unidad menor), aplicada solo en la conversión final.

## Conciliación
- Por moneda y por método de pago; referencias de Pago Móvil/transferencia vinculadas a la cuota.
- Diferencias por tasa/redondeo registradas explícitamente.

## i18n
- Locales `es-VE` y `es-CO`: formato de moneda, fecha y textos.

## KYC
- VE: cédula/RIF para cliente y comercio; alcance y retención según Legal.
- CO: a definir en F-CO.

## Pagos locales
- VE: Pago Móvil, transferencias bancarias (solo sandbox hasta cerrar #82).
- CO: a definir en F-CO.

## Riesgos pendientes de Legal (#82, BNPL-07)
- Sanciones OFAC.
- Controles cambiarios y uso de la tasa BCV.
- Licencias/registro para BNPL y cobros.
