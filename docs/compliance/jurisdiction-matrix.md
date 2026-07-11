# Matriz de jurisdicción — Colombia

Estado: **País seleccionado: Colombia** (PEND-001 resuelta por el propietario, 2026-07-04) · La **investigación con fuentes y la revisión legal siguen pendientes** y bloquean la Fase 5 (proveedor real). Nada de esta matriz se codifica en el producto hasta que cada fila esté verificada y revisada legalmente. · **F5.0 (2026-07-11, decisión #30)** añadió investigación con fuentes oficiales a la columna «Verificación» — ver `f5-0-legal-research.md` y `legal-questions-checklist.md`. **NINGUNA fila está cerrada legalmente**: F5.0 documenta fuentes y deja preguntas para abogado; no hay dictamen externo. Estados epistémicos: `verif` = verificado-con-fuente (la fuente dice lo transcrito, NO que Fluvia cumpla/quede exenta) · `abogado` = pregunta-para-abogado · `preliminar` = interpretación técnica preliminar.

## Implicaciones inmediatas para el MVP (sin riesgo legal)

- Moneda principal de sandbox: **COP** (exponente 2, ya soportada en `@fluvia/money`); USD/CLP se mantienen en tests multi-moneda.
- El MockProvider simulará, además de tarjeta, un **método asíncrono de redirección tipo PSE** (el método dominante colombiano es asíncrono): ejercita `requires_action`, estados pendientes largos y webhooks tardíos desde la Fase 3.
- Candidatos de proveedor para Fase 5 (evaluación formal pendiente): Wompi, PayU Latam, dLocal, Mercado Pago, ePayco.

## Matriz (conocimiento preliminar — TODA fila requiere verificación con fuente y fecha antes de Fase 5)

| Dimensión | Conocimiento preliminar (NO verificado) | Verificación |
|-----------|------------------------------------------|--------------|
| Moneda | COP, exponente 2; alta sensibilidad a redondeos en montos grandes | Pendiente (sin dimensión legal nueva en F5.0) |
| Métodos de pago | PSE (transferencia bancaria vía ACH Colombia, asíncrona), tarjetas, Nequi/Daviplata, efectivo (Efecty/Baloto) | `preliminar`; implicaciones por método → `abogado`+`proveedor` (F5.0 §14) |
| Proveedores/adquirentes | Wompi (Bancolombia), PayU, dLocal, Mercado Pago, ePayco; adquirencia: Credibanco, Redeban | `proveedor` — evaluación formal en F5.1 (NO en F5.0) |
| Regulador financiero | Superintendencia Financiera de Colombia (SFC); SEDPE para depósitos electrónicos (no aplica si no custodiamos) | `verif`: SEDPE captan recursos y son vigiladas por la SFC (Ley 1735/2014, SFC, 2026-07-11); las «pasarelas de pago» no son vigiladas per se (concepto SFC 2023094068-002, vía compilación — confirmar en fuente directa). Clasificación de Fluvia → `abogado` (F5.0 §7–8) |
| KYC/KYB · AML | SARLAFT como marco AML; listas ONU/OFAC + vinculantes locales | `verif`: existen sujetos obligados que reportan a la UIAF por SIREL (UIAF, 2026-07-11). ¿Es Fluvia sujeto obligado? → `abogado` (F5.0 §9–10) |
| Protección al consumidor | Estatuto del Consumidor (Ley 1480/2011); reglas de reversión de pagos (art. 51) relevantes para refunds/contracargos | `verif`: texto oficial art. 51 (Función Pública i=44306, 2026-07-11). ¿Es Fluvia «participante del proceso de pago»? → `abogado` (F5.0 §11) |
| Privacidad / datos | Ley 1581/2012 (habeas data), registro de bases ante SIC; evaluar residencia de datos | `verif`: SIC administra el RNBD (Ley 1581, Función Pública i=49981, 2026-07-11). Umbral de registro, transferencia internacional y residencia → `abogado` (F5.0 §12) |
| Facturación / impuestos | Factura electrónica DIAN; retenciones (retefuente/ICA) sobre fees; IVA sobre comisiones | `verif`: factura electrónica + IVA sobre comisión + retenciones con prioridad a agregadores/adquirentes (DIAN, Resolución 000165 de 2023, 2026-07-11). Aplicación a fees de Fluvia → `abogado`/contador (F5.0 §13) |
| Contracargos/disputas | Reglas de franquicias + reversiones Ley 1480 | `proveedor` (reglas/plazos) + `abogado` (Ley 1480 art. 51) (F5.0 §15) |
| Liquidaciones/payouts | Vía proveedor autorizado; Fluvia no custodia (invariante) | `verif`: adquirentes no vigilados deben segregar fondos + Registro SFC + capital ≥ 1.700 SMMLV + 2% (Decreto 1692/2020 art. 2.17.3.1.2, 2026-07-11). Si Fluvia NO recauda, ¿aplica? → `abogado` (bisagra, F5.0 §16) |
| Reportes obligatorios | UIAF si aplicara por rol; a confirmar que como orquestador no-custodio no aplica | `abogado`: confirmar si Fluvia es sujeto obligado (F5.0 §9) |
| Sandbox/calidad de API | Wompi y Mercado Pago con sandbox público; evaluar calidad de webhooks por proveedor | `proveedor` — F5.1 (NO en F5.0) |
| Riesgo cambiario | No aplica en MVP (solo COP doméstico); FX fuera de alcance | — |

## Proceso de cierre (gate de Fase 5)

1. Completar cada fila con fuente citada y fecha.
2. Revisión legal externa de las filas marcadas.
3. Selección del proveedor con evaluación formal (contrato + sandbox + contract tests).
4. Registrar el cierre como ADR de jurisdicción con evidencia.
