# Plan de preparación de Fase 5 — SOLO PLANIFICACIÓN (opción B)

Estado: **PLANIFICACIÓN — pendiente de decisión humana** · **Fase 5 NO iniciada** · Este documento es estratégico/documental, NO implementación · Registrado por decisión #29 (opción B: preparar Fase 5 sin iniciarla).

Baseline: `claude/new-session-haeo7h` @ `eb2d570f3ce4d2b982c500e11a4d361b58040c7f` (F6 aprobada para sandbox cerrado / hardening sandbox sobre `8f126c4049653b11e6a46903c68d9138e8c2a4ab`, decisión #28, ratificación de Hermes).

Restricciones vigentes que este plan NO altera: Freeze #24 vigente · Live bloqueado por código (decisión #19) · Producción NO autorizada · Sandbox compartido NO autorizado (PEND-006) · MockProvider único proveedor · Sin proveedor real · Sin exposición pública.

> **Ninguna etapa F5.0–F5.4 está autorizada.** Cada una requiere una decisión humana explícita y separada del propietario. Este documento es el mapa, no el permiso. Complementa (no reemplaza) `docs/product/phase-plan.md`.

---

## 1. Resumen ejecutivo

Fluvia llega a esta planificación con F1–F4 + F6 completas y auditadas (dos auditorías independientes + delta F6 ratificado por Hermes, 0 P0/P1/P2). Todo lo construible **dentro del sandbox cerrado ya está construido**. Lo que falta para operar con dinero real no es código especulativo: es (a) **verificación legal/regulatoria** (matriz Colombia, LGPLv3, rol regulatorio de Fluvia), (b) **decisiones de vendor** (proveedor de pagos, secret manager), (c) **infraestructura real de despliegue** (secret manager, backups PITR, exposición controlada), y (d) el **adaptador de proveedor real** con su cifrado de credenciales — construido solo cuando (a)–(c) existan.

La recomendación central: **la primera inversión de Fase 5 no es código sino la verificación legal de la matriz jurisdiccional y la evaluación formal de proveedores** — es el camino crítico, tiene el lead time más largo, y todo lo demás se diseña alrededor de sus respuestas.

## 2. Qué significa Fase 5

Fase 5 = **conectar Fluvia al mundo real**, en este orden conceptual:

1. **Matriz jurisdiccional Colombia verificada** con fuentes + revisión legal externa (hoy es conocimiento preliminar NO verificado — así lo declara `docs/compliance/jurisdiction-matrix.md`).
2. **Selección formal de proveedor de pagos** (contrato + sandbox del proveedor + contract tests).
3. **Adaptador de proveedor real** detrás de la interfaz que MockProvider ya implementa (tarjeta + método asíncrono tipo PSE ya ejercitado desde F3), con **cifrado field-level de credenciales** desde el primer día (ADR-0012 §4 ya lo fija).
4. **Infra de despliegue real**: secret manager (vendor + IAM, enfoque ya decidido en ADR-0012), backups PITR/offsite, copia offsite de anchors del ledger.
5. **Gates de exposición** (PEND-006) para sandbox compartido, y después la política de live keys (PEND-004).

## 3. Qué NO significa Fase 5

- NO es "salir a producción" — producción tiene sus propios gates (§8) que Fase 5 no satisface por sí sola.
- NO es custodiar dinero — el invariante no-custodio se mantiene (payouts vía proveedor autorizado); esto es central para el análisis regulatorio (SEDPE probablemente no aplica si no custodiamos — **a confirmar legalmente**).
- NO es levantar el freeze #24, ni emitir credenciales `live` (bloqueadas por código, decisión #19), ni exponer endpoints.
- NO es reescribir el núcleo: ledger, idempotencia, webhooks, RLS y outbox/inbox quedan como están — F5 **añade un adaptador y despliegue**, no toca los invariantes auditados.

## 4. Riesgos críticos

| # | Riesgo | Severidad | Mitigación propuesta |
|---|--------|-----------|----------------------|
| R1 | **Clasificación regulatoria errónea de Fluvia** (¿pasarela? ¿agregador? ¿SEDPE?) — construir sobre un supuesto legal falso | CRÍTICA | Revisión legal externa ANTES de firmar con proveedor; ninguna regla legal codificada hasta verificación (disciplina de la decisión #15) |
| R2 | **Elegir proveedor antes de verificar la matriz** — el proveedor condiciona métodos, liquidación, contracargos y hasta el modelo regulatorio | ALTA | Orden estricto: matriz verificada → evaluación formal → contrato |
| R3 | **Credenciales reales mal gestionadas** en la primera integración | ALTA | Secret manager operativo ANTES de recibir la primera credencial de sandbox-de-proveedor; cifrado field-level desde el día 1 (ADR-0012 §4); nunca credenciales reales en env de desarrollo |
| R4 | **Divergencia sandbox-del-proveedor vs producción-del-proveedor** (webhooks distintos, tiempos distintos) | MEDIA | Contract tests contra el sandbox del proveedor + los drills existentes (worker-down/restore/load-chaos) corriendo contra el adaptador real |
| R5 | **Deriva de alcance**: F5 "aprovecha" para tocar el núcleo | MEDIA | Regla de fase: F5 solo añade adaptador+infra; cualquier cambio al núcleo exige ADR y re-verificación de invariantes |
| R6 | **LGPLv3 sin revisión legal** llega al primer release | MEDIA | Ya es blocker registrado (`license-exceptions.json`, gate de producción); incluirlo en el mismo paquete de revisión legal que la matriz (una contratación, dos entregables) |
| R7 | **Exposición prematura** (abrir sandbox compartido sin PEND-006 completo) | ALTA | Los 7 ítems de PEND-006 son checklist bloqueante verificable en CI/config antes de exponer nada |

## 5. Gates antes de INICIAR Fase 5 (criterios de entrada)

1. ✅ F6 aprobada (cumplido — decisión #28).
2. ⬜ **Decisión humana explícita del propietario de iniciar F5** (este plan NO la constituye).
3. ⬜ **Matriz jurisdiccional Colombia**: toda fila con fuente citada + fecha, y revisión legal externa de las filas marcadas (proceso de cierre ya definido en `jurisdiction-matrix.md`).
4. ⬜ **Presupuesto/contratación legal** definidos (matriz + LGPLv3 + contrato de proveedor).
5. ⬜ **Registro como ADR de jurisdicción** con evidencia (paso 4 del proceso de cierre existente).

## 6. Gates antes de SANDBOX COMPARTIDO (PEND-006 — ya documentados, ninguno nuevo)

Los 7 del threat model §5 / production-gates §0: `trustProxy` acotado al poner proxy delante · Origin-check · CSP con nonce · cookie `Secure` por entorno · store **compartido** de rate limiting como default (Redis ya probado multi-instancia, TM-03) · aserción de `normal_side` en startup · valor definitivo de retención de idempotency keys (≥ ventana de retry del cliente — decisión del propietario). Más: la decisión humana PEND-006 en sí (condiciones para abrir a terceros).

## 7. Gates antes de LIVE (PEND-004)

- Política definitiva de credenciales `live`: qué gates exactos + **quién autoriza la primera emisión** (hoy `LiveKeysDisabledError` por código — decisión #19, la opción más restrictiva y reversible).
- Propuesta para esa política (a decidir por el propietario, no ahora): emisión live requiere (a) producción-gates §2 verdes, (b) proveedor real en producción con contrato firmado, (c) autorización nominal del propietario registrada en DECISIONS, (d) MFA + step-up del emisor, (e) límites de monto iniciales bajos y crecientes.

## 8. Gates antes de PRODUCCIÓN / release público

Los ya registrados en production-gates §0 (ninguno nuevo): proveedor real integrado y probado · secret manager vendor + IAM cableado · live keys autorizadas (PEND-004) · **revisión legal LGPLv3** + obligaciones de atribución cumplidas · cifrado field-level operativo · backups PITR/offsite de producción · copia offsite de anchors (operador) · gates de exposición (§6) · gates organizacionales/regulatorios de §2.

## 9. Arquitectura propuesta del proveedor real (solo conceptual — NO implementar)

- **Puerto ya existente**: el MockProvider define el contrato (intents, captura, refund, `requires_action` con redirección asíncrona tipo PSE, webhooks entrantes tardíos). El adaptador real implementa **la misma interfaz** — cero cambio en el núcleo.
- **Anti-corrupción**: el adaptador traduce el modelo del proveedor al modelo Fluvia en el borde; los eventos del proveedor entran SOLO por el inbox existente (firma verificada antes de persistir, ADR-0007 / decisión #21).
- **Credenciales**: tabla propia con cifrado field-level AES-256-GCM, clave en secret manager (ADR-0012 §4), patrón de clave versionada para rotación (el que ya usan las API keys v1→v2).
- **Conciliación**: el motor de conciliación de F4 consume los reportes de liquidación del proveedor — nueva *fuente*, mismo motor.
- **Degradación**: si el proveedor cae, los intents quedan en estados pendientes ya modelados; el redriver y los watchdogs existentes aplican sin cambios.
- **Contract tests**: suite dedicada contra el sandbox del proveedor (grabada/replayable para CI), separada del suite del núcleo.

## 10. Opciones de proveedor / rails (evaluación formal PENDIENTE — preliminares de la matriz)

Candidatos ya listados en la matriz: **Wompi (Bancolombia), PayU Latam, dLocal, Mercado Pago, ePayco**. Rails colombianos: PSE (ACH), tarjetas (adquirencia Credibanco/Redeban), Nequi/Daviplata, efectivo (Efecty/Baloto). Criterios de evaluación propuestos: cobertura de métodos (PSE + tarjetas mínimo) · calidad del sandbox y de los webhooks (idempotencia, reintentos, firmas) · modelo de liquidación y reportes conciliables · modelo de contracargos · requisitos KYB para Fluvia y sus merchants · pricing · soporte técnico/contractual. **Ninguna preferencia se fija aquí** — la evaluación formal (paso 3 del proceso de la matriz) decide.

## 11. Secret manager recomendado

El **enfoque ya está decidido y no se reabre**: ADR-0012 — inyección al arranque vía env, cero SDK en runtime, app agnóstica del vendor. Lo único pendiente para F5 es el **vendor + IAM**, que ADR-0012 difiere explícitamente al despliegue real. Criterios de selección propuestos (ligados a dónde se despliegue): manager nativo del cloud elegido (AWS Secrets Manager / GCP Secret Manager) por menor fricción IAM, o Vault si se quiere neutralidad multi-cloud a costa de operarlo. **Recomendación condicional**: elegir cloud primero, tomar su manager nativo, y registrar la elección como apéndice de despliegue del ADR-0012 (no como ADR nuevo).

## 12. Revisión legal / compliance requerida (una contratación, cuatro entregables)

1. **Matriz Colombia verificada** (filas SFC/SEDPE, SARLAFT/UIAF, Ley 1480 art. 51 reversiones, Ley 1581 habeas data + registro SIC, DIAN/retenciones/IVA sobre fees).
2. **Dictamen del rol regulatorio de Fluvia** como orquestador no-custodio (la conclusión más importante: determina si SEDPE/UIAF aplican).
3. **Revisión LGPLv3** de `@img/sharp-libvips-linux-x64` (obligaciones y cláusula de caducidad ya registradas en `license-exceptions.json`) + verificación de las obligaciones de atribución CC-BY-4.0.
4. **Revisión del contrato del proveedor** seleccionado antes de firmar.

## 13. Backlog propuesto por etapas (cada etapa con su propio gate; ninguna arranca sin autorización)

- **F5.0 — Verificación (sin código)**: cerrar matriz con fuentes → revisión legal externa (entregables §12.1–.3) → ADR de jurisdicción. *Gate de salida: matriz verificada + dictamen de rol.*
- **F5.1 — Selección de proveedor (sin código de producto)**: evaluación formal de los 5 candidatos con los criterios de §10 → contrato revisado (§12.4) → credenciales de sandbox-del-proveedor al secret manager. *Gate: contrato firmado + sandbox accesible.*
- **F5.2 — Infra de despliegue**: elección de cloud → secret manager vendor + IAM (apéndice ADR-0012) → PITR/backups → pipeline de despliegue. *Gate: secretos inyectados end-to-end en un entorno real sin exposición pública.*
- **F5.3 — Adaptador real**: cifrado field-level + tabla de credenciales → adaptador contra sandbox del proveedor → contract tests → conciliación con reportes reales del proveedor → drills existentes contra el adaptador. *Gate: suite + contract tests + drills verdes; revisión adversarial + auditoría delta del adaptador.*
- **F5.4 — Exposición controlada**: PEND-006 completo (§6) → decisión humana de sandbox compartido → después, PEND-004 (live) como decisión separada. *Gate: cada exposición con su decisión nominal del propietario.*

## 14. Decisiones humanas requeridas antes de construir

| # | Decisión | Bloquea |
|---|----------|---------|
| D1 | Iniciar F5.0 (contratar la verificación legal) — presupuesto y firma | Todo |
| D2 | Selección del proveedor (tras evaluación formal) | F5.2+ |
| D3 | Cloud de despliegue → vendor de secret manager | F5.2 |
| D4 | PEND-006: condiciones de sandbox compartido | F5.4 |
| D5 | PEND-004: política de live keys y quién autoriza | Live |
| D6 | Retención definitiva de idempotency keys | PEND-006 |
| D7 | Aceptar (o no) el dictamen legal y sus condiciones operativas | Producción |

## 15. Recomendación

**Preparar más antes de avanzar, con un paso concreto**: autorizar **solo F5.0** (verificación legal + cierre de matriz — sin código, sin infra, sin proveedor). Es el camino crítico con mayor lead time y menor costo técnico; su resultado puede cambiar el diseño de todo lo demás (hasta el candidato de proveedor). Pausar del todo también es válido — el repo queda en estado aprobado y estable — pero cada mes sin verificación legal es un mes añadido al lead time total de F5. **No se recomienda** autorizar F5 completa de una vez: las etapas tienen dependencias duras y decisiones humanas intercaladas (D1–D7).

## 16. Próximo paso recomendado

Autorizar **solo F5.0** (revisión legal + cierre de la matriz jurisdiccional Colombia + revisión LGPLv3), que es **sin código y sin infraestructura**. Es una decisión humana separada del propietario; este plan no la constituye. Alternativa igualmente válida: mantener la pausa estratégica. Cualquiera de F5.1–F5.4 permanece bloqueada hasta que F5.0 cierre y el propietario autorice la siguiente etapa.

---

## Referencias

- `docs/product/phase-plan.md` — plan de fases global.
- `docs/compliance/jurisdiction-matrix.md` — matriz Colombia (preliminar, no verificada).
- `docs/compliance/production-gates.md` §0 — estadios sandbox cerrado / sandbox compartido / producción.
- `docs/adr/0012-secret-manager-produccion.md` — enfoque de secret manager (vendor diferido a F5).
- `docs/compliance/license-exceptions.json` / `license-policy.md` — obligaciones LGPLv3 y CC-BY-4.0.
- `docs/audits/audit-closure-register-v1.md` §F6 Final Approval — aprobación F6 y baseline.
- `docs/agents/DECISIONS.md` #24 (freeze), #19 (live keys), #28 (F6 aprobada), #29 (este plan).
