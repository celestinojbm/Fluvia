# F5.0 — Investigación legal/compliance preliminar (Colombia)

Estado: **INVESTIGACIÓN PRELIMINAR — NO es dictamen legal** · Fecha de consulta de fuentes: **2026-07-11** · Autorizado por decisión #30 (F5.0, solo documental) · Baseline: `claude/new-session-haeo7h` @ `9d433002f12aa098aca5a54ebd2f08c5a32717fe`.

> **Aviso de método (honestidad V4 Nivel A).** Quien redacta este documento NO es abogado. Aquí no hay conclusiones legales definitivas. Cada afirmación relevante lleva un **estado epistémico**: `verificado-con-fuente` · `interpretación-técnica-preliminar` · `pregunta-para-abogado` · `pregunta-para-proveedor` · `decisión-pendiente-del-propietario` · `fuente-no-accesible`. «Verificado con fuente» significa únicamente que la fuente citada dice lo transcrito — **no** que Fluvia cumpla, esté exenta o clasifique de una u otra forma. La clasificación regulatoria de Fluvia es una **pregunta para abogado colombiano**, no una conclusión de este documento.

## 1. Resumen ejecutivo

F5.0 convierte la matriz jurisdiccional (antes «conocimiento preliminar NO verificado») en un paquete de investigación con **fuentes oficiales/primarias, URL y fecha de consulta**. El hallazgo estructural preliminar: en Colombia las **«pasarelas de pago» no están definidas ni son vigiladas por la Superintendencia Financiera (SFC) por el solo hecho de serlo**; la regla aplicable depende de la **actividad concreta** —en particular, si la entidad **recauda/mantiene fondos** de terceros—. El **Sistema de Pago de Bajo Valor** (Decreto 1692 de 2020) sí regula a **agregadores** y **adquirentes no vigilados**, imponiéndoles segregación de fondos, un **Registro de Adquirentes no Vigilados** ante la SFC y **capital mínimo**. Por eso la pregunta central para el abogado es: **¿la actividad real de Fluvia (orquestador que NO custodia fondos) la deja fuera del régimen de adquirencia/SEDPE, o la ubica como adquirente no vigilado / proveedor de servicios de pago con obligaciones asociadas?** Este documento instruye esa pregunta con fuentes; **no la responde**.

## 2. Alcance de F5.0

- Investigación con fuentes oficiales/primarias de los temas de la matriz Colombia + fecha de consulta + estado epistémico.
- Encuadre del rol regulatorio **preliminar** de Fluvia como conjunto de preguntas.
- Cierre documental de las dos tareas de licencias (LGPL-3.0, CC-BY-4.0): obligaciones descritas + preguntas para revisión legal.
- Checklists de abogado / proveedor / criterios de selección (en `legal-questions-checklist.md`).

## 3. Qué NO autoriza F5.0

No autoriza F5.1–F5.4, ni código, ni proveedor real, ni credenciales, ni `live`, ni exposición pública, ni sandbox compartido, ni producción; no levanta el freeze #24. No presenta conclusiones legales. No cambia las decisiones de licencias ya aceptadas (decisión del propietario 2026-07-10). No toca `docs/audits/independent-audit-v1/`.

## 4. Metodología

Consulta de fuentes oficiales/primarias vía búsqueda y fetch directo (2026-07-11). Se distingue entre **fetch directo del texto primario** (mayor confianza) y **hallazgo vía búsqueda con URL oficial identificada** (texto primario pendiente de lectura directa). Toda aplicación a Fluvia se marca como pregunta-para-abogado. Cuando una fuente no fue accesible desde el entorno, se marca `fuente-no-accesible`.

## 5. Tabla de fuentes consultadas (2026-07-11)

| Fuente | URL | Tipo | Acceso | Nota |
| --- | --- | --- | --- | --- |
| GNU LGPL-3.0 (texto) | https://www.gnu.org/licenses/lgpl-3.0.en.html | Primaria (FSF) | Fetch directo ✅ | §2, §3, §4(a), §4(d)(1) |
| Creative Commons BY 4.0 (legalcode) | https://creativecommons.org/licenses/by/4.0/legalcode.en | Primaria (CC) | Fetch directo ✅ | §3(a)(1)(A) |
| Ley 1480 de 2011 (Estatuto Consumidor), art. 51 | https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=44306 | Oficial (Función Pública) | Fetch directo ✅ | Reversión del pago |
| Decreto 1692 de 2020 (Sistema de Pago de Bajo Valor) | https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=153787 | Oficial (Función Pública) | Fetch directo ✅ | Agregador/adquirente/segregación/registro/capital |
| Ley 1581 de 2012 (Protección de datos) | https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981 | Oficial (Función Pública) | Vía búsqueda ✅ (URL oficial) | RNBD administrado por SIC |
| SFC — SEDPE / Ley 1735 de 2014 | https://www.superfinanciera.gov.co/publicaciones/10101317/ | Oficial (SFC) | Vía búsqueda ✅ | SEDPE vigiladas por SFC |
| UIAF — normatividad / sujetos obligados | https://www.uiaf.gov.co/normativa-2 | Oficial (UIAF) | Vía búsqueda ✅ | Reporte vía SIREL; Resolución 314 (activos virtuales) |
| DIAN — factura electrónica / retenciones | https://www.dian.gov.co/impuestos/factura-electronica/ | Oficial (DIAN) | Vía búsqueda ✅ | Fact. electrónica; IVA sobre comisión; retenciones |
| SFC — concepto sobre pasarelas de pago (2023094068-002, 2023) | Citado vía compilación secundaria (ochgroup) | Secundaria (cita de concepto SFC) | Vía búsqueda ⚠️ | Confirmar el concepto en fuente SFC directa |
| Banco de la República (conceptos SPBV) | https://www.banrep.gov.co/ | Oficial (BanRep) | No consultado a fondo | Pendiente si aplica a rails |

## 6. Matriz de temas T1–T12 (estado epistémico por afirmación)

- **T1 — Rol de Fluvia (orquestador/pasarela/agregador/no-custodio).** `pregunta-para-abogado`. Las «pasarelas de pago» no están definidas ni vigiladas por la SFC per se; la regla depende de la actividad concreta (`verificado-con-fuente` respecto del marco; SFC/Decreto 1692). Si Fluvia **no recauda/mantiene fondos**, `interpretación-técnica-preliminar`: podría quedar fuera del régimen de adquirente no vigilado — **requiere confirmación legal**.
- **T2 — Perímetro SFC/SEDPE.** SEDPE (Ley 1735/2014) **captan recursos** y son vigiladas por la SFC (`verificado-con-fuente`). Fluvia **no capta depósitos** en su diseño (`interpretación-técnica-preliminar`) → preliminarmente no sería SEDPE; `pregunta-para-abogado`.
- **T3 — SARLAFT/UIAF.** Existen sujetos obligados a reportar a la UIAF por sector; el reporte se hace por SIREL (`verificado-con-fuente`). Si Fluvia es sujeto obligado y bajo qué norma → `pregunta-para-abogado`.
- **T4 — KYC/KYB.** Sobre quién recae (adquirente/proveedor vs Fluvia vs merchant) → `pregunta-para-abogado` + `pregunta-para-proveedor`.
- **T5 — Ley 1480 art. 51 (reversión).** Texto oficial transcrito (`verificado-con-fuente`). Si Fluvia es «participante del proceso de pago» del parágrafo 1 (emisores, administradores de SPBV, bancos) → `pregunta-para-abogado`; obligaciones operativas de refunds/contracargos derivadas → `pregunta-para-abogado`.
- **T6 — Ley 1581 (habeas data).** La SIC administra el RNBD; hay umbral de registro (preliminarmente ~100.000 UVT o entidad pública, vía reglamentario) (`verificado-con-fuente` respecto del marco; el umbral exacto/su vigencia → `pregunta-para-abogado`). Residencia/transferencia de datos si se despliega fuera de Colombia → `pregunta-para-abogado` + `decisión-pendiente-del-propietario` (dónde se despliega).
- **T7 — DIAN.** Factura electrónica obligatoria para quien venda bienes/preste servicios; IVA sobre la comisión de intermediación; retención en la fuente y retención de IVA con prioridad a agregadores/adquirentes (Resolución 000165 de 2023; Decreto 1625 de 2016; ET art. 365) (`verificado-con-fuente` respecto del marco; aplicación exacta a los fees de Fluvia → `pregunta-para-abogado`/`revisión contable`).
- **T8 — Métodos/rails.** PSE, tarjetas, Nequi/Daviplata, efectivo — implicaciones legales por método → `pregunta-para-proveedor` + `pregunta-para-abogado`.
- **T9 — Disputas/contracargos.** Reglas de franquicias + Ley 1480 → `pregunta-para-proveedor` + `pregunta-para-abogado`.
- **T10 — Payouts/liquidación no-custodia.** Adquirentes no vigilados deben **segregar** fondos recaudados (patrimonios autónomos o alianzas con establecimientos de crédito), con Registro ante la SFC y capital ≥ 1.700 SMMLV + 2% de fondos liquidados (Decreto 1692/2020, art. 2.17.3.1.2) (`verificado-con-fuente`). Si Fluvia **no recauda**, este régimen preliminarmente no aplicaría → `pregunta-para-abogado` (es la pregunta bisagra de T1).
- **T11 — LGPL-3.0** (`@img/sharp-libvips-linux-x64`) — ver §17.
- **T12 — CC-BY-4.0** (`caniuse-lite`) — ver §18.

## 7. Rol regulatorio preliminar de Fluvia

`interpretación-técnica-preliminar` + `pregunta-para-abogado`: Fluvia se describe como **orquestador no-custodio** (no retiene fondos; el dinero fluye del comprador al merchant vía un proveedor/adquirente autorizado — invariante del diseño). Según el marco (`verificado-con-fuente`): (a) las pasarelas de pago no son vigiladas por la SFC por su sola condición; (b) la **adquirencia** y el **agregador** sí están regulados por el Decreto 1692/2020, con la obligación central de **segregar los fondos recaudados**; (c) el factor determinante es si se **recauda/mantiene** dinero de terceros. **Pregunta central para abogado:** dada la actividad real de Fluvia (orquestación sin recaudo/custodia), ¿queda fuera del régimen de adquirente no vigilado y de SEDPE, o cae en «proveedor de servicios de pago»/«adquirente no vigilado» con las obligaciones asociadas? Este documento **no** lo concluye.

## 8. SFC / SEDPE

`verificado-con-fuente`: las SEDPE (Ley 1735 de 2014) captan recursos exclusivamente mediante depósitos electrónicos y son **inspeccionadas, vigiladas y controladas por la SFC**; deben cumplir SARLAFT. `interpretación-técnica-preliminar`: Fluvia no capta depósitos, por lo que preliminarmente no encajaría como SEDPE. `pregunta-para-abogado`: confirmar y descartar figuras cercanas (adquirente no vigilado, proveedor de servicios de pago del SPBV).

## 9. SARLAFT / UIAF

`verificado-con-fuente`: existen sujetos obligados a reportar a la UIAF definidos por sector y norma; el canal es SIREL; hay obligaciones específicas para proveedores de servicios de activos virtuales (Resolución 314). `pregunta-para-abogado`: ¿es Fluvia sujeto obligado hoy? ¿Qué actividad futura (recaudo, cripto, etc.) la convertiría en tal, y con qué reportes/plazos?

## 10. KYC / KYB

`pregunta-para-abogado` + `pregunta-para-proveedor`: determinar la asignación de responsabilidad de debida diligencia (adquirente/proveedor autorizado vs Fluvia vs merchant) en el modelo no-custodio, y qué evidencia/registro exige.

## 11. Ley 1480 art. 51 / reversión de pagos

`verificado-con-fuente` (texto oficial, Función Pública i=44306): la reversión aplica a ventas por comercio electrónico (Internet, PSE, etc.) pagadas con tarjeta u otro instrumento electrónico, cuando hay fraude, operación no solicitada, producto no recibido, o no correspondiente/defectuoso; los **participantes del proceso de pago** deben reversar a solicitud del consumidor. **Parágrafo 1**: participantes = «los emisores de los instrumentos de pago, las entidades administradoras de los Sistemas de Pago de Bajo Valor, los bancos que manejan las cuentas y/o depósitos bancarios del consumidor y/o del proveedor, entre otros». `pregunta-para-abogado`: ¿es Fluvia «participante» en el sentido del parágrafo? ¿Qué obligaciones operativas de refund/contracargo se derivan para el orquestador?

## 12. Ley 1581 / habeas data / SIC / RNBD

`verificado-con-fuente` (marco): la SIC (Delegatura de Protección de Datos) vigila y administra el **Registro Nacional de Bases de Datos (RNBD)**; el registro es obligatorio para responsables por encima de un umbral (preliminarmente ~100.000 UVT o entidades públicas, vía norma reglamentaria — el umbral y su vigencia deben confirmarse). `pregunta-para-abogado`: obligación de registro de Fluvia, régimen de autorización/transferencia internacional de datos, y residencia de datos según el cloud de despliegue (`decisión-pendiente-del-propietario`).

## 13. DIAN / IVA / retenciones / facturación electrónica

`verificado-con-fuente` (marco): factura electrónica obligatoria para quien venda bienes/preste servicios; el IVA de la comisión de intermediación se factura; existe retención en la fuente para pagos con tarjeta y una propuesta/decreto que prioriza a agregadores/adquirentes como agentes de retención de IVA (Resolución 000165 de 2023 art. 7; Decreto 1625 de 2016 art. 1.6.1.4.2; ET art. 365). `pregunta-para-abogado`/`revisión contable`: tratamiento exacto de IVA y retenciones sobre los **fees de Fluvia**, y obligaciones de facturación.

## 14. Métodos de pago / rails en Colombia

`interpretación-técnica-preliminar` (de la matriz existente): PSE (transferencia ACH, asíncrona), tarjetas (adquirencia Credibanco/Redeban), Nequi/Daviplata, efectivo (Efecty/Baloto). Implicaciones legales por método → `pregunta-para-abogado` + `pregunta-para-proveedor`.

## 15. Disputas / contracargos

`pregunta-para-proveedor` (reglas de franquicias, plazos, evidencia) + `pregunta-para-abogado` (articulación con Ley 1480 art. 51). El motor de conciliación de F4 consumiría los reportes del proveedor — sin cambios de runtime en F5.0.

## 16. Payouts / liquidación no-custodia

`verificado-con-fuente`: los adquirentes no vigilados deben mantener los fondos recaudados **separados** de sus recursos propios (patrimonios autónomos o alianzas con establecimientos de crédito); hay Registro de Adquirentes no Vigilados ante la SFC y capital ≥ 1.700 SMMLV + 2% de los fondos liquidados de los 12 meses previos (Decreto 1692/2020, art. 2.17.3.1.2). `interpretación-técnica-preliminar`: si Fluvia **no recauda** (invariante no-custodio), este régimen preliminarmente no le aplicaría; `pregunta-para-abogado` (bisagra con T1/T7).

## 17. LGPL-3.0 — `@img/sharp-libvips-linux-x64`

`verificado-con-fuente` (GNU, gnu.org/licenses/lgpl-3.0.en.html): para quien **distribuye** una aplicación que enlaza **dinámicamente** con una biblioteca LGPL-3.0 **sin modificar**, como componente separado y reemplazable:

- **§4(a)**: dar aviso prominente de que la Library se usa y está cubierta por la LGPL, y **acompañar** la obra combinada con copia de la GNU GPL y de la LGPL.
- **§4(d)(1)**: usar un mecanismo de biblioteca compartida que opere con una versión **modificada e interface-compatible** de la Library — es decir, que el usuario pueda **relinkar/reemplazar** la biblioteca; esto exime de entregar el código fuente completo de la aplicación.
- **§2**: si se **modifica** la Library, hay que conveyarla bajo LGPL.
- **§3**: el enlace **estático** dispara requisitos adicionales.

`interpretación-técnica-preliminar` (consistente con `license-exceptions.json`): el componente hoy está *dormant* (no se usa `next/image`), es binario dinámico, sin modificar y reemplazable → las obligaciones activas al **primer release público/comercial** serían las de §4(a)/§4(d)(1) (avisos + copia de licencias + no impedir el relink). `pregunta-para-abogado`: confirmar la forma exacta de cumplimiento y qué cambia si se modifica libvips, se enlaza estáticamente o se empaqueta de forma no reemplazable (la excepción registrada ya caduca en esos casos). **No se cambia `license-exceptions.json` en F5.0.**

## 18. CC-BY-4.0 — `caniuse-lite`

`verificado-con-fuente` (Creative Commons, §3(a)(1)(A)): al redistribuir, deben conservarse: identificación del/los creador(es); aviso de copyright; referencia a la licencia; aviso del disclaimer de garantías; URI/enlace al material; e indicación de modificaciones (§3(a)(1)(B)); e indicar que el material está bajo CC-BY-4.0 con el texto o URI de la licencia (§3(a)(1)(C)). `interpretación-técnica-preliminar`: coincide con la obligación de atribución ya registrada para `caniuse-lite`. `pregunta-para-abogado`: forma concreta de la atribución en el producto distribuido. **No se cambia `license-exceptions.json` en F5.0.**

## 19. Riesgos abiertos

- **RA-1** Tratar interpretación técnica como dictamen legal → mitigado con etiquetado epistémico; nada se concluye sin abogado.
- **RA-2** Confirmar el concepto SFC sobre pasarelas en **fuente SFC directa** (hoy vía compilación secundaria) → `pregunta-para-abogado`/verificación adicional.
- **RA-3** Umbral RNBD y vigencia exacta → confirmar norma reglamentaria vigente.
- **RA-4** Residencia de datos y su interacción con el cloud de despliegue → `decisión-pendiente-del-propietario` (D3 del plan F5).
- **RA-5** La pregunta bisagra (¿recauda o no?) determina casi todo el perímetro; debe cerrarse legalmente antes de F5.1.

## 20. Preguntas que requieren abogado

Ver `legal-questions-checklist.md` §1 (lista completa). Núcleo: rol regulatorio no-custodio (SFC/SPBV/SEDPE), sujeto obligado UIAF, KYC/KYB, Ley 1480 art. 51, Ley 1581/RNBD/transferencia de datos, DIAN/IVA/retenciones, LGPL-3.0 y CC-BY-4.0.

## 21. Preguntas que requieren proveedor

Ver `legal-questions-checklist.md` §2. Núcleo: modelo de liquidación (no-custodia), métodos, webhooks/firmas/reintentos, contracargos, KYB, reportes de conciliación, pricing, certificaciones.

## 22. Criterios de salida de F5.0

- Cada tema T1–T12 con fuente + fecha + estado epistémico + acción asignada. ✅ (este documento)
- Rol regulatorio **instruido como pregunta** con contexto, no resuelto. ✅
- Checklists de abogado/proveedor/criterios de selección. ✅ (`legal-questions-checklist.md`)
- Licencias LGPL-3.0 y CC-BY-4.0 con obligaciones descritas + preguntas para abogado, sin cambiar `license-exceptions.json`. ✅
- Matriz jurisdiccional actualizada con fuente/fecha/estado, **sin declarar cierre legal**. ✅
- Cero cambios de código/gates; freeze #24 intacto. ✅

## 23. Próximos pasos propuestos (NO autorizados aquí)

1. **Decisión humana**: buscar **abogado colombiano** especializado (pagos/fintech/SPBV) para responder `legal-questions-checklist.md` §1 — es la salida natural de F5.0.
2. Confirmar en fuente SFC directa el tratamiento de «pasarelas de pago» (RA-2).
3. Solo tras dictamen: registrar un **ADR de jurisdicción** con evidencia y decidir F5.1 (evaluación formal de proveedor). Nada de esto es F5.0 ni está autorizado.

---

### Fuentes (consulta 2026-07-11)

- GNU LGPL-3.0 — https://www.gnu.org/licenses/lgpl-3.0.en.html
- Creative Commons BY 4.0 — https://creativecommons.org/licenses/by/4.0/legalcode.en
- Ley 1480 de 2011 (Función Pública) — https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=44306
- Decreto 1692 de 2020 (Función Pública) — https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=153787
- Ley 1581 de 2012 (Función Pública) — https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981
- SFC — SEDPE — https://www.superfinanciera.gov.co/publicaciones/10101317/
- UIAF — normatividad — https://www.uiaf.gov.co/normativa-2
- DIAN — factura electrónica — https://www.dian.gov.co/impuestos/factura-electronica/
