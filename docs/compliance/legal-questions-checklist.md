# Checklist de preguntas — F5.0 (abogado / proveedor / contador) + criterios y decisiones

Estado: **PREPARACIÓN — F5.0 (docs)** · 2026-07-11 · Decisión #30. Complementa `f5-0-legal-research.md`. **No es asesoría legal.** Estas son las preguntas que el propietario debe llevar a los terceros correspondientes.

## 1. Preguntas para ABOGADO externo (Colombia, pagos/fintech)

1. **Rol regulatorio (bisagra).** Dado que Fluvia **orquesta pagos sin recaudar ni custodiar fondos** (el dinero fluye comprador → proveedor/adquirente autorizado → merchant, y Fluvia nunca lo mantiene), ¿queda **fuera** del régimen de adquirencia del Decreto 1692 de 2020 y de SEDPE, o se clasifica como «proveedor de servicios de pago» / «adquirente no vigilado» con obligaciones asociadas (segregación de fondos, Registro ante la SFC, capital ≥ 1.700 SMMLV + 2%)?
2. **SFC — perímetro.** ¿Requiere Fluvia alguna autorización, inscripción o registro ante la SFC en su modelo no-custodio? ¿Qué actividad concreta cruzaría el umbral de vigilancia?
3. **SEDPE.** Confirmar que, al no captar depósitos, Fluvia no es SEDPE (Ley 1735 de 2014); ¿hay figura cercana que sí aplique?
4. **SARLAFT / UIAF.** ¿Es Fluvia **sujeto obligado** a implementar SARLAFT y a reportar a la UIAF hoy? Si no, ¿qué actividad futura la convertiría en tal, con qué reportes (ROS/otros) y plazos (SIREL)?
5. **KYC / KYB.** ¿Sobre quién recae la debida diligencia de conocimiento de cliente/comercio en el modelo no-custodio (proveedor autorizado vs Fluvia vs merchant)? ¿Qué evidencia debe conservarse?
6. **Ley 1480 art. 51 (reversión).** ¿Es Fluvia «participante del proceso de pago» (parágrafo 1)? ¿Qué obligaciones operativas de reversión/refund/contracargo le impone, y cómo se articula con las reglas de las franquicias?
7. **Ley 1581 (habeas data).** ¿Debe Fluvia **registrar sus bases de datos ante la SIC (RNBD)**? ¿Cuál es el umbral vigente (UVT) y aplica a Fluvia? ¿Qué exige la ley sobre **autorización, aviso de privacidad, transferencia/transmisión internacional y residencia** de datos si el despliegue es fuera de Colombia?
8. **DIAN / tributario.** Tratamiento de **IVA sobre los fees** de Fluvia, **retención en la fuente** y **retención de IVA** (¿es Fluvia agente de retención como agregador/adquirente?), y obligaciones de **factura electrónica** (Resolución 000165 de 2023; Decreto 1625 de 2016; ET art. 365). *(Puede requerir también contador/tributarista — §3.)*
9. **Habilitaciones.** ¿Qué licencias/habilitaciones (si alguna) requiere operar como orquestador de pagos en Colombia?
10. **LGPL-3.0** (`@img/sharp-libvips-linux-x64`, dinámico, sin modificar, reemplazable, hoy dormant): ¿qué obligaciones concretas (§4(a) avisos + copia de GPL/LGPL; §4(d)(1) permitir relink) se activan al **primer release público/comercial** y cómo se cumplen? ¿Qué cambia si se modifica libvips, se enlaza estáticamente o se empaqueta de forma no reemplazable?
11. **CC-BY-4.0** (`caniuse-lite`): forma exacta de la **atribución** exigida (§3(a)(1)(A)–(C)) en un producto distribuido.

## 2. Preguntas para PROVEEDOR de pagos

1. **Modelo de liquidación**: ¿confirmás que Fluvia **no custodia** (los fondos van del comprador al merchant vía el proveedor, sin que Fluvia los mantenga)?
2. **Métodos**: cobertura de **PSE + tarjetas** como mínimo; ¿Nequi/Daviplata/efectivo?
3. **Webhooks**: algoritmo de **firma**, **idempotencia**, política de **reintentos**, tiempos; ¿sandbox con webhooks tardíos/`requires_action` asíncrono tipo PSE?
4. **Sandbox vs producción**: ¿mismos contratos y semántica? Calidad/estabilidad del sandbox.
5. **Contracargos/disputas**: flujos, plazos, evidencia, articulación con Ley 1480.
6. **KYB**: requisitos para Fluvia y para sus merchants.
7. **Reportes de conciliación**: formato, granularidad, frecuencia (para el motor de conciliación de F4).
8. **Pricing** y condiciones contractuales.
9. **Certificaciones/seguridad** (PCI DSS u otras) exigidas al modelo.

## 3. Preguntas para CONTADOR / tributarista (si aplica)

1. Tratamiento de IVA y retenciones sobre los fees de Fluvia; ¿Fluvia como agente de retención?
2. Facturación electrónica de las comisiones (obligación, formato, periodicidad).
3. Retefuente/ICA aplicables a las comisiones.

## 4. Criterios de selección de proveedor (para F5.1 — NO se elige aquí)

Cobertura de métodos (PSE + tarjetas mínimo) · calidad del sandbox y de los webhooks (idempotencia, reintentos, firmas) · modelo de liquidación **no-custodia** conciliable · modelo de contracargos · requisitos KYB · pricing · soporte técnico/contractual · certificaciones. **Ninguna preferencia ni contrato se decide en F5.0.**

## 5. Documentos / evidencias que el propietario debe conseguir

- Contratación de **abogado colombiano** (pagos/fintech/SPBV) para responder §1.
- Confirmación en **fuente SFC directa** del tratamiento de «pasarelas de pago» (RA-2 del research).
- **Revisión legal LGPLv3** y verificación de la atribución CC-BY-4.0 (§1.10–1.11).
- Si aplica, **contador/tributarista** para §3.
- Norma reglamentaria vigente del **umbral RNBD** (UVT).

## 6. Decisiones humanas requeridas antes de F5.1

- **D-A**: contratar (o no) la revisión legal externa — presupuesto y alcance.
- **D-B**: aceptar (o no) el dictamen del abogado y sus condiciones operativas.
- **D-C**: cloud de despliegue → implica residencia de datos (Ley 1581) y vendor de secret manager (ADR-0012).
- **D-D**: qué material se mantiene **fuera del repo** (dictamen legal, contratos, PII) vs qué investigación pública se versiona.
- **D-E**: solo tras D-B, autorizar F5.1 (evaluación formal de proveedor). **F5.1–F5.4 siguen bloqueadas.**
