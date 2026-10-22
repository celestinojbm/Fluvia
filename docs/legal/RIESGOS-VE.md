> **BORRADOR — no es asesoría legal.** Mapa de riesgos preparado por Legal y Cumplimiento para revisión de un abogado venezolano y un asesor de sanciones de EE. UU. Lo marcado [verificar] no está confirmado.

# Fluvia — Análisis de riesgos legales para Venezuela (BNPL-07)

**Estado:** BORRADOR v1 · 22-oct-2026 (hora del Este de EE. UU.) · Preparado para Líder de Fluvia / Celestino Briceño.
**Aviso:** esto no es asesoría legal definitiva. Es un mapa de riesgos para llevarle a un abogado venezolano y a un asesor de sanciones de EE. UU. Lo marcado **[verificar]** no lo confirmé con una fuente primaria en esta revisión. Hay normas venezolanas que cito de memoria, solo por su nombre, y deben confirmarse en Gaceta Oficial.
**Base en el repo (solo lectura):** `docs/product/MODELO.md`, `docs/adr/0013-modelo-bnpl-comercio-cobra-completo.md`, `docs/agents/BACKLOG.md` (BNPL-07), `docs/compliance/jurisdiction-matrix.md` (solo Colombia; **no hay matriz para Venezuela**) en las ramas de los PR #81/#80 de celestinojbm/Fluvia.

Modelo evaluado (MODELO.md §1-§2): el comercio cobra el total menos la comisión en una sola liquidación; el cliente paga en N cuotas; **un socio financiero (banco o fondo) financia el adelanto**; Fluvia cobra la comisión (MDR) y se encarga del scoring y la cobranza; se opera en VES y USD con tasa oficial para los planes indexados y Pago Móvil para cobrar cuotas.

---

## Resumen de riesgos

| # | Tema | Riesgo | ¿Bloquea el lanzamiento? |
|---|---|---|---|
| 1 | Sanciones OFAC (si hay alguna persona de EE. UU. en la cadena) | **Alto** | Sí, mientras no haya un dictamen de sanciones |
| 2 | Controles cambiarios, tasa BCV, IGTF | **Medio** | Parcial (hace falta definir la moneda del contrato y el tratamiento del IGTF) |
| 3 | Licencia SUDEBAN/BCV (crédito / ITFB) | **Alto** | Sí |
| 4 | Consumidor, intereses, mora e indexación | **Alto** | Sí para "sin interés", la mora y la indexación |
| 5 | Colombia (2.ª fase) | Medio | No para Venezuela |

---

## 1. Sanciones OFAC — Riesgo ALTO

**Hechos verificados (fuentes oficiales):**
- El programa vigente es el de Venezuela-Related Sanctions / Venezuela Sanctions Regulations, 31 CFR part 591. Página oficial con la lista de órdenes ejecutivas y licencias generales: https://ofac.treasury.gov/sanctions-programs-and-country-information/venezuela-related-sanctions
- **GL 57** (emitida el 14-abr-2026 según la síntesis de búsqueda, **[verificar fecha]**; texto oficial en https://ofac.treasury.gov/media/935516/download?inline= ): autoriza las transacciones "ordinarily incident and necessary" para prestar **servicios financieros** a, desde o en beneficio del **Banco Central de Venezuela**, Banco de Venezuela, Banco Digital de los Trabajadores, Banco del Tesoro, sus entidades con participación del 50 % o más, y personas bloqueadas *solo* por la E.O. 13884 por ser "Government of Venezuela" (excluye a quienes están en la lista SDN). La definición de "financial services" incluye pagos digitales, billeteras, cambio de divisas y procesamiento de fondos. **No** desbloquea bienes y **no** autoriza otras transacciones prohibidas por la VSR (párrafo c). La nota 3 aclara que la BSA, la USA PATRIOT Act y las normas de FinCEN siguen aplicando.
- Las GL 52-58 se publicaron en el Federal Register el 30-sep-2026: https://www.federalregister.gov/documents/2026/09/30/2026-20008/publication-of-venezuela-sanctions-regulations-web-general-licenses-52-53-54-55-56-57-and-58
- OFAC registra acciones recientes sobre Venezuela el 28-sep-2026 (licencias enmendadas) y el **16-oct-2026** ("Issuance of Amended Venezuela-related General License and Frequently Asked Question"): https://ofac.treasury.gov/recent-actions/general-licenses → **[verificar] qué licencia se enmendó el 16-oct y si afecta a la GL 57.**
- Otras licencias relevantes que aparecen en la página del programa: GL 16C (cuentas de personas de EE. UU. y remesas personales con ciertos bancos), GL 25 (servicios, software y tecnología de comunicaciones por internet), GL 35 (trámites administrativos con el Gobierno de Venezuela), GL 34A, GL 24A (telecomunicaciones/correo, 18-jun-2026).

**Órdenes ejecutivas del programa** (cito de memoria; deben cotejarse con la página de OFAC): E.O. 13692 (2015), 13808 (2017), 13827 (2018), 13835 (2018), 13850 (2018) y 13884 (2019, bloqueo del Gobierno de Venezuela, que incluye al BCV) **[verificar números y vigencia]**.

**Análisis preliminar:**
- *¿Puede operar un socio financiero o procesador de EE. UU.?* Con la GL 57, el trato con el BCV y con los cuatro bancos públicos está autorizado dentro del ámbito de "financial services", siempre que no participe ninguna persona de la lista SDN ni otro bloqueo. Con bancos privados venezolanos que no estén sancionados, el riesgo principal es la debida diligencia (filtrar contra la lista SDN, la regla del 50 % y la E.O. 13884 cuando haya participación del Estado). En la práctica, muchos bancos y procesadores de EE. UU. aplican un *de-risking* y no aceptan Venezuela aunque la ley lo permita: es un riesgo **comercial** además de legal.
- *Uso de la tasa BCV:* consultar y usar la tasa que publica el BCV como referencia contractual no parece una "transacción" con el BCV, pero **[verificar con un asesor de sanciones]**, sobre todo si una persona de EE. UU. firma, programa o cobra contratos indexados a ella. Mientras siga vigente la GL 57, el riesgo es bajo.
- *Fragilidad:* las GL se enmiendan o revocan con frecuencia (hubo cambios el 28-sep y el 16-oct-2026). Un producto que depende de una GL necesita un plan de salida.
- *Celestino / Fluvia como persona de EE. UU.:* si la empresa o algún socio está constituido o reside en EE. UU., **toda** la operación queda bajo la jurisdicción de OFAC **[verificar estructura societaria]**.

**Bloquea:** el lanzamiento con dinero real mientras no haya (a) estructura societaria definida, (b) un dictamen de sanciones de EE. UU. y (c) una política de *screening*.
**Cambios en el producto:** filtrar contra la lista SDN a comercios, clientes y socios (también los beneficiarios finales y la regla del 50 %); bloquear a entidades del Gobierno o PDVSA como comercios hasta que haya un dictamen; dejar en el ledger trazabilidad de la licencia que respalda cada flujo; un *kill switch* por país o contraparte; guardar la tasa BCV como dato con fuente y fecha, sin integración "con" el BCV.

---

## 2. Controles cambiarios, tasa BCV, facturación en divisas e IGTF — Riesgo MEDIO

**Estado conocido (todo [verificar] en Gaceta Oficial):**
- **Convenio Cambiario N.° 1** (2018, Gaceta Oficial Extraordinaria N.° 6.405 **[verificar]**): establece la libre convertibilidad y permite pactar obligaciones en moneda extranjera.
- **Ley de Ilícitos Cambiarios:** derogada por un decreto constituyente de 2018 **[verificar Gaceta N.° 41.452 y fecha]**. Eso no elimina las demás normas penales ni las de legitimación de capitales.
- **Tasa oficial:** el BCV publica el tipo de cambio de referencia. Las obligaciones en divisas suelen poder pagarse en bolívares a la tasa del día de pago **[verificar: art. 128 de la Ley del BCV y el Convenio N.° 1]**.
- **IGTF:** grava los pagos en divisas o criptoactivos fuera del sistema bancario nacional, entre otros. La tasa y los sujetos se han modificado varias veces (Ley de 2022 y decretos posteriores) **[verificar tasa vigente a oct-2026]**.
- **Facturación:** SENIAT exige expresar la factura en bolívares, con el equivalente en divisas cuando corresponda **[verificar providencia vigente]**.
- La circular de SUDEBAN SIB-II-GGR-GNP-02178 (8-feb-2018) prohíbe a los bancos destinar fondos de crédito a comprar divisas (aparece en el índice https://sudeban.gob.ve/index.php/normativas/ ) **[verificar vigencia]**.

**Bloquea:** decidir en qué moneda se pacta la cuota (USD pagadero en Bs a tasa BCV, o Bs indexados), lo que conecta con el punto 4.
**Cambios en el producto:** guardar la moneda del contrato y la moneda de pago por separado; registrar la tasa BCV con *timestamp* y fuente por cada cuota; aplicar el IGTF por medio de pago (Pago Móvil en Bs frente a USD en efectivo o Zelle); facturar la comisión al comercio en Bs con referencia en USD; no ofrecer cambio de divisas como servicio.

---

## 3. Licencia SUDEBAN/BCV para el BNPL — Riesgo ALTO

**Hechos verificados:**
- **Resolución SUDEBAN N.° 001.21** (4-ene-2021), "Normas que Regulan los Servicios de Tecnología Financiera (FINTECH)", publicada en la Gaceta Oficial N.° 42.151 del 17-jun-2021 (reimpresa en la G.O. 42.162 del 6-jul-2021 según BDO). Crea las **Instituciones de Tecnología Financiera del Sector Bancario (ITFB)**, que requieren autorización de SUDEBAN. Fuentes: https://accesoalajusticia.org/sudeban-regula-servicios-de-tecnologia-financiera-fintech/ · https://epaclaw.com/pdf/normativafintech.pdf · índice oficial: https://sudeban.gob.ve/index.php/normativas/ (no pude leer el texto oficial completo en sudeban.gob.ve: **[verificar]**). Según los resúmenes, las ITFB prestan servicios tecnológicos *a* bancos, deben ser sociedades anónimas domiciliadas en el país y necesitan opinión vinculante del OSFIN **[verificar requisitos de capital y accionistas]**.

**Análisis preliminar:**
- Si Fluvia o el socio **adelanta dinero al comercio y cobra las cuotas al cliente**, eso es sustancialmente una operación de crédito. Hacerlo de forma habitual con fondos de terceros puede considerarse una actividad reservada a instituciones del sector bancario (Decreto Ley de Instituciones del Sector Bancario **[verificar artículo y Gaceta]**).
- Hay tres encuadres posibles para el abogado: (a) **un banco local es el acreedor** y Fluvia es su ITFB o proveedor tecnológico; (b) **el comercio vende a plazo** (venta con reserva de dominio o crédito comercial) y Fluvia administra; (c) **Fluvia compra la cartera**, con riesgo de captación o intermediación no autorizada. MODELO.md menciona un "fondo" como socio: si el fondo capta dinero del público en Venezuela, el riesgo es alto (SUNAVAL/SUDEBAN) **[verificar]**.
- Recibir los pagos de las cuotas (COPY-COMERCIO punto 3) puede convertir a Fluvia en recaudador o custodio, lo que contradice la invariante de "no custodia" del repo.
- Para referencia de mercado, conviene que el abogado revise cómo está estructurado Cashea (sin asumir nada).

**Bloquea:** sí. No hay lanzamiento sin un dictamen sobre quién es el acreedor y qué licencia o registro aplica.
**Cambios en el producto:** que el acreedor sea un campo explícito del plan (`creditor_id`); los cobros, a una cuenta del banco o socio (Fluvia no custodia); preparar reportes regulatorios y de PLD/FT (SUDEBAN/UNIF) **[verificar si Fluvia es sujeto obligado]**; KYC del cliente y KYB del comercio antes de lanzar.

---

## 4. Consumidor, intereses, mora e indexación (BNPL-07) — Riesgo ALTO

**Normas a revisar (de memoria, todas [verificar] vigencia y texto):**
- **Ley Orgánica de Precios Justos** (SUNDDE; decreto de 2014 y reformas): márgenes de ganancia, prohibición de usura, régimen sancionatorio. Debe confirmarse si "sin interés" con recargos ocultos puede considerarse usura o especulación.
- **Ley Antimonopolio** (2014, Superintendencia Antimonopolio): exclusividades con comercios, cláusulas de nación más favorecida, prácticas desleales en comparaciones publicitarias (ya se quitó la comparación con Cashea del copy).
- **Tasas máximas del BCV:** el BCV fija tasas activas máximas y, para el crédito comercial bancario, usa la Unidad de Valor de Crédito Comercial (UVCC) indexada al tipo de cambio oficial **[verificar resolución BCV vigente, p. ej. la Resolución 19-09-01, y si existe un régimen para el crédito al consumo]**.
- **Restricción a la indexación:** hay criterios del TSJ y de la normativa bancaria que limitan la indexación en el crédito al consumo y la vivienda **[verificar]**. Indexar las cuotas en Bs a la tasa BCV (MODELO.md §5.5) **puede ser la parte más sensible**.
- **Mora:** límites al interés moratorio (Código Civil/Comercio y normas BCV) **[verificar]**.

**"Sin interés":** sigue en pausa. Solo debería volver si (i) el precio de contado y el precio en cuotas son iguales, (ii) no hay comisiones al cliente que funcionen como interés, (iii) la indexación USD→Bs no se presenta como interés encubierto y (iv) la mora es legal y está divulgada.
**Bloquea:** el copy de "sin interés", la tabla de mora y el mecanismo de indexación.
**Cambios en el producto:** pantalla de divulgación previa (precio de contado, número y monto de cuotas, moneda, tasa de referencia, mora); fijar la mora en un parámetro por jurisdicción y apagarla por defecto; no cobrar comisión al cliente hasta que haya dictamen; poder elegir entre cuota fija en USD y cuota en Bs; registro de evidencia del consentimiento.

---

## 5. Nota breve — Colombia (2.ª fase)

- **No encontré una ley específica de BNPL** vigente en Colombia **[verificar proyectos de ley en curso]**. Aplica la Ley 1480/2011 (arts. 45 y 55): divulgación en tasa efectiva anual, mora solo sobre cuotas vencidas y usura conocida por la SIC si el acreedor no está vigilado: http://secretariasenado.gov.co/senado/basedoc/ley_1480_2011_pr001.html . La SIC exige informar el precio de contado y las tasas en la financiación: https://sedeelectronica.sic.gov.co/temas/proteccion-al-consumidor/derechos-y-deberes/financiacion-de-compras . El Decreto 1368/2014 reglamenta la financiación directa: https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=58565
- **Usura:** la SFC certifica el interés bancario corriente. Para julio de 2026, la tasa de consumo y ordinario fue de 19,19 % E.A. y la de usura de **28,79 % E.A.** (Resolución 0965 de 2026): https://www.superfinanciera.gov.co/publicaciones/10116173/superfinanciera-certifica-el-interes-bancario-corriente/ → **[verificar certificación vigente para oct-2026]**.
- **Decreto 1692/2020:** régimen de adquirentes o agregadores no vigilados (segregación de fondos, registro, capital), ya documentado en `jurisdiction-matrix.md` y en F5.0. Sigue pendiente decidir si Fluvia recauda.
- **SFC:** prestar con recursos captados del público requiere vigilancia de la SFC; con recursos propios o del socio, la vigilancia la ejerce la SIC. **Riesgo: medio.**

---

## Lista de bloqueos para el lanzamiento en Venezuela
1. Dictamen de sanciones de EE. UU. (estructura societaria, GL 57 y cambio del 16-oct-2026, socio y procesador) y política de *screening* contra la lista SDN.
2. Dictamen venezolano sobre quién es el acreedor y qué licencia aplica (ITFB / sector bancario / venta a plazo).
3. Socio financiero real y contrato (fuera de alcance mientras siga el freeze #24).
4. Validación de la moneda del contrato, la indexación a la tasa BCV, el interés y la mora (BNPL-07).
5. Tratamiento del IGTF y de la facturación SENIAT de la comisión.
6. Definir quién recibe los pagos de las cuotas (no custodia por parte de Fluvia).
7. PLD/FT: ¿es Fluvia sujeto obligado? KYC/KYB.
8. Términos de uso, política de privacidad y divulgación previa al cliente.

## Preguntas para un abogado venezolano
1. Con el modelo de MODELO.md §2, ¿qué figura jurídica es: crédito al consumo, venta a plazo del comercio con cesión de cartera, o servicio tecnológico (ITFB) de un banco?
2. ¿Necesita Fluvia autorización de SUDEBAN como ITFB (Res. 001.21) u otro registro? ¿Qué requisitos de capital, accionistas y domicilio exige hoy?
3. ¿Puede un fondo extranjero o local financiar el adelanto sin incurrir en intermediación o captación no autorizada? ¿Interviene SUNAVAL?
4. ¿Puede pactarse la cuota en USD y pagarse en Bs a la tasa BCV del día? ¿Es lícito indexar cuotas en Bs al crédito al consumo? ¿Qué resolución del BCV aplica (tasas máximas, UVCC)?
5. ¿Qué límite tiene el interés moratorio? ¿Puede cobrarse un cargo fijo por retraso?
6. ¿Bajo qué condiciones puede anunciarse "sin interés" sin infringir la Ley de Precios Justos ni la publicidad engañosa?
7. ¿Siguen vigentes el Convenio Cambiario N.° 1 y la derogación de la Ley de Ilícitos Cambiarios? ¿Cuál es la tasa vigente del IGTF y a qué pagos de cuotas aplica?
8. ¿Cómo se factura la comisión al comercio (moneda, SENIAT)?
9. ¿Es Fluvia sujeto obligado de PLD/FT ante la UNIF? ¿Qué KYC mínimo se exige?
10. ¿Puede Fluvia recibir los pagos de las cuotas (Pago Móvil) sin ser institución bancaria?
11. ¿Hay riesgo antimonopolio en pactar exclusividad con comercios (colegios, agencias de viaje, BNPL-10)?
12. Protección de datos personales y del buró de crédito en Venezuela: ¿qué régimen aplica?

**Pregunta para un asesor de sanciones de EE. UU.:** si Fluvia, Celestino o el socio son personas de EE. UU., ¿cubre la GL 57 (en la versión vigente tras el 16-oct-2026) el procesamiento de pagos BNPL con comercios y bancos venezolanos? ¿Usar la tasa BCV como referencia contractual requiere autorización?
