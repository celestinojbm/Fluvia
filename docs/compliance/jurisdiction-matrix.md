# Matriz de jurisdicción — Colombia

Estado: **País seleccionado: Colombia** (PEND-001 resuelta por el propietario, 2026-07-04) · La **investigación con fuentes y la revisión legal siguen pendientes** y bloquean la Fase 5 (proveedor real). Nada de esta matriz se codifica en el producto hasta que cada fila esté verificada y revisada legalmente.

## Implicaciones inmediatas para el MVP (sin riesgo legal)

- Moneda principal de sandbox: **COP** (exponente 2, ya soportada en `@fluvia/money`); USD/CLP se mantienen en tests multi-moneda.
- El MockProvider simulará, además de tarjeta, un **método asíncrono de redirección tipo PSE** (el método dominante colombiano es asíncrono): ejercita `requires_action`, estados pendientes largos y webhooks tardíos desde la Fase 3.
- Candidatos de proveedor para Fase 5 (evaluación formal pendiente): Wompi, PayU Latam, dLocal, Mercado Pago, ePayco.

## Matriz (conocimiento preliminar — TODA fila requiere verificación con fuente y fecha antes de Fase 5)

| Dimensión | Conocimiento preliminar (NO verificado) | Verificación |
|-----------|------------------------------------------|--------------|
| Moneda | COP, exponente 2; alta sensibilidad a redondeos en montos grandes | Pendiente |
| Métodos de pago | PSE (transferencia bancaria vía ACH Colombia, asíncrona), tarjetas, Nequi/Daviplata, efectivo (Efecty/Baloto) | Pendiente |
| Proveedores/adquirentes | Wompi (Bancolombia), PayU, dLocal, Mercado Pago, ePayco; adquirencia: Credibanco, Redeban | Pendiente |
| Regulador financiero | Superintendencia Financiera de Colombia (SFC); SEDPE para depósitos electrónicos (no aplica si no custodiamos) | Pendiente + revisión legal |
| KYC/KYB · AML | SARLAFT como marco AML; listas ONU/OFAC + vinculantes locales | Pendiente + revisión legal |
| Protección al consumidor | Estatuto del Consumidor (Ley 1480/2011); reglas de reversión de pagos (art. 51) relevantes para refunds/contracargos | Pendiente + revisión legal |
| Privacidad / datos | Ley 1581/2012 (habeas data), registro de bases ante SIC; evaluar residencia de datos | Pendiente + revisión legal |
| Facturación / impuestos | Factura electrónica DIAN; retenciones (retefuente/ICA) sobre fees; IVA sobre comisiones | Pendiente + revisión contable |
| Contracargos/disputas | Reglas de franquicias + reversiones Ley 1480 | Pendiente |
| Liquidaciones/payouts | Vía proveedor autorizado; Fluvia no custodia (invariante) | Pendiente por proveedor |
| Reportes obligatorios | UIAF si aplicara por rol; a confirmar que como orquestador no-custodio no aplica | Pendiente + revisión legal |
| Sandbox/calidad de API | Wompi y Mercado Pago con sandbox público; evaluar calidad de webhooks por proveedor | Pendiente (Fase 5) |
| Riesgo cambiario | No aplica en MVP (solo COP doméstico); FX fuera de alcance | — |

## Proceso de cierre (gate de Fase 5)

1. Completar cada fila con fuente citada y fecha.
2. Revisión legal externa de las filas marcadas.
3. Selección del proveedor con evaluación formal (contrato + sandbox + contract tests).
4. Registrar el cierre como ADR de jurisdicción con evidencia.
