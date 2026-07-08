# HANDOFF — Guía para el siguiente agente o equipo

Actualizado: 2026-07-08 · **Fases 1–4 COMPLETAS; Fase 6 (hardening) EN CURSO** (paquete de auditoría en `docs/audits/`)

## Hilo actual (Fase 6 · hardening) — retoma aquí

Rama de trabajo: `claude/session-direction-check-rnrwv6` (PR #2, draft, NO mergeado). Cada bundle: código + tests contra PG real + revisión adversarial (workflow) + verify (suite + `verify-ledger-invariants.sql` + drills) + evidencia CI en `docs/audits/audit-closure-register-v1.md` §Evidencia CI.

**Cerrado/endurecido en el §5 del threat model** (fuente de verdad del backlog F6): Webhooks/SSRF, Secretos/cadena (enfoque de secret-manager decidido en **ADR-0012** propuesto — inyección por env al arranque, sin SDK en runtime; **rotación de `WEBHOOK_SECRET_ENC_KEY` HECHA** — keyring de descifrado por trial + CLI admin de re-cifrado + runbook; faltan la rotación de MFA-key y del pepper de API keys), Multi-tenant, Idempotencia, Auth (parcial — el resto acoplado al canal de email), TM-01..06, TM-04 (worker-down + restore drills en CI), SHA-pinning de la cadena CI/build, y **Ledger — hash-chain de tamper-evidence** (migr. 0042: checkpoints append-only encadenados por sha256, sellado en dos fases con horizonte de txid, check [7] en el SQL de invariantes, `LedgerCheckpointer` en el worker; endurecido tras revisión adversarial de 18 hallazgos — advisory lock, `t.tenant_id` en el canónico, auto-sanado tras DR, alerta de estancamiento, y tests con `session_replication_role` de sesión), y **Ledger — anclaje EXTERNO del `chain_hash`** (migr. 0043: `ledger_chain_anchors` append-only + evento `ledger.chain_anchored` en `audit_events`, check [8], `LedgerChainAnchorer` en el worker; endurecido tras revisión adversarial — se eliminó un gauge `anchor_gap` inerte y se precisó el alcance honesto: [8] protege hasta el último anchor, la copia offsite es del operador).

**Disciplina que NO se salta**: verificar ANTES de proponer/construir (ha evitado varias trampas: el check de proyecciones-faltantes da falsos positivos con los fixtures; neutralizar `register` necesita el canal de email). Toda migración nueva se prueba en un DB fresco (migrate ×2, idempotente). `payouts-redriver.test.ts` es un flake conocido (pasa aislado; re-ejecutar, subir redis). El bypass de triggers en tests va SIEMPRE por `SET LOCAL session_replication_role=replica` (nunca `DISABLE TRIGGER` global — corre con los ~9 archivos de test en paralelo).

**El anclaje EXTERNO del `chain_hash` quedó HECHO** (migr. 0043, check [8]) — sobre la rama APILADA `claude/external-chain-hash-anchor-7sc0oj` (PR nuevo apilado sobre el #2, base = `session-direction-check-rnrwv6`). Publica el tip (`upto_seq`, `chain_hash`) a `ledger_chain_anchors` (append-only, SEPARADO de la cadena) + evento `ledger.chain_anchored` en `audit_events`; [8] rompe cuando un anchor no tiene checkpoint vivo (truncado/borrado) o su `chain_hash` difiere. La pata que RESTA es la **copia OFFSITE de los anchors**, responsabilidad del OPERADOR (el worker loguea el tip como artefacto exportable; no hay infra externa en sandbox — no se construye capacidad simulada, V4 Nivel A).

**El ADR de secret-manager quedó HECHO** (ADR-0012, **Propuesto**, rama `claude/secret-manager-adr`) — enfoque agnóstico de proveedor: inyección de secretos como env al arranque (contrato de env validado + anti-mezcla; cero SDK en runtime, cero lock-in), imagen sin secretos, rotación por clave versionada. Artefacto de DISEÑO (Nivel A; vendor + integración al desplegar, F5).

**La rotación de `WEBHOOK_SECRET_ENC_KEY` quedó HECHA** (rama APILADA `claude/webhook-enc-key-rotation`, sobre la del ADR) — PRIMERA pata de rotación con CÓDIGO. Keyring (clave actual + retiradas) que descifra probando cada clave (el tag AES-GCM disambigua; sin versionar el blob ni tocar el esquema) + `WEBHOOK_SECRET_ENC_KEY_RETIRED` en config (anti-mezcla) + `reencryptWebhookSecrets` (CLI admin `rotate:webhook-key`, cross-tenant, idempotente) + runbook `webhook-enc-key-rotation.md`. Probado vs PG real (`crypto.test.ts`/`rotate.test.ts`). Sin migración. **Endurecido tras revisión adversarial (4 lentes)**: barrido por LOTES con cotas de tiempo por tx (no cuelga reteniendo locks de toda la tabla) + resiliencia por fila (un blob indescifrable se REPORTA en `failed`, no aborta la plataforma) + prueba de vuelo de solo-lectura `rotate:webhook-key --check` (gate `underRetired=0`/`undecryptable=0` antes de borrar una clave) + runbook a **4 fases** (pre-siembra de la clave nueva como solo-descifra en toda la flota ANTES de promoverla — cierra la ventana de indescifrable del rolling restart que el «sin downtime» de 3 fases no disclosaba).

**La rotación de `MFA_SECRET_KEY` quedó HECHA** (rama APILADA `claude/mfa-secret-key-rotation`, sobre la de webhook-enc) — SEGUNDA pata de rotación con CÓDIGO, MISMO mecanismo que webhook-enc reutilizado. Keyring (actual + retiradas) en `totp.ts` que descifra por trial (tag AES-GCM) + `MFA_SECRET_KEY_RETIRED` en config (anti-mezcla) + el `AuthService` descifra `users.totp_secret_enc`/`totp_pending_secret_enc` con el keyring + `reencryptMfaSecrets` (CLI con rol `fluvia_auth` de MÍNIMO PRIVILEGIO — no superusuario; `rotate:mfa-key`, por lotes con cotas de tiempo, resiliencia `failed`, `--check` de solo-lectura) + runbook `mfa-key-rotation.md` a 4 fases. Probado vs PG real (`mfa-crypto.test.ts` 7 + `mfa-rotate.test.ts` 8, incl. **end-to-end por el `AuthService` real**: un usuario bajo la clave retirada autentica, y tras el barrido autentica con solo la actual). El secreto TOTP en claro NO cambia. Sin migración.

**Próximo incremento recomendado**: **rotación EFECTIVA del pepper de API keys** (`API_KEY_HMAC_SECRET`) — mecánica DISTINTA a las dos anteriores: el HMAC es ONE-WAY (no re-cifrable), así que un keyring de descifrado por trial NO aplica. Enfoque probable: **multi-pepper versionado** — un pepper ACTUAL (hashea las keys nuevas) + peppers viejos que solo se usan para VERIFICAR las keys existentes (el `key_hash_version` v1→v2 que las API keys ya modelan), con re-hash oportunista al validar (o forzar re-emisión). **VERIFICAR PRIMERO** cómo `api-keys.ts` versiona hoy el hash antes de construir. _Alternativas mayores_: **security review formal** (F6), o **no-negatividad de motor a nivel BD** (columna + trigger; OJO: las cuentas transitorias SÍ van negativas). **Verificar primero** (la disciplina del hilo) antes de construir.

## Empieza aquí, en este orden

1. `docs/README.md` — índice de la Fase 0 y convenciones.
2. `docs/agents/STATE.md` — qué existe de verdad y qué no.
   2bis. `docs/audits/audit-closure-register-v1.md` — estado vivo de los hallazgos de la auditoría independiente; NO construyas sobre un área con hallazgo P1 abierto sin leer su fila.
3. `docs/agents/DECISIONS.md` + `docs/adr/` — decisiones cerradas; no las reabras sin evidencia nueva (proceso ADR).
4. `docs/agents/BACKLOG.md` — tu trabajo sale de ahí; respeta el DAG.
5. `CONTRIBUTING.md` — invariantes Nivel A y reglas de PR.

## Reglas de oro operativas

- Vigente: **no toques `docs/audits/independent-audit-v1/`** (inmutable), no emitas credenciales `live` (bloqueado por código, PEND-004), y la **exposición pública** de la API de pagos/checkout/webhooks sigue **CONGELADA** (decisión #24) hasta la re-auditoría + PEND-006 — todo está construido en sandbox, jamás expuesto. Cada incremento registra su run de CI verde en `audit-closure-register-v1.md` antes de declararse completado.
- Una unidad de backlog por PR; tests de integración con Postgres real para todo lo financiero.
- El spike (`packages/money`, `packages/db`) es evidencia, no fundación sagrada: F1-03/F2-01 lo migran formalmente; si encuentras algo mal en él, corrígelo con test que lo demuestre.
- Toda tabla nueva: clasificación de datos + decisión RLS en el PR.
- Las políticas RLS SIEMPRE con `NULLIF(current_setting('app.tenant_id', true), '')::uuid` (hallazgo empírico documentado).
- Si te desvías del Prompt V4 o de un ADR: registra la desviación (instrucción original, razón, alternativa, ADR si aplica).

## Cómo reproducir el entorno del spike

```bash
pnpm install
docker compose up -d postgres   # o PG16 local en :5432 con usuario postgres/trust
pnpm migrate
pnpm test && pnpm build
```

## Trampas conocidas

1. `DELETE`/`TRUNCATE` están bloqueados por trigger en TODAS las tablas core del spike — los tests no limpian datos: crean tenants frescos por corrida (aislamiento por RLS). La purga clasificada llega en F1-09.
2. Los passwords de `fluvia_app`/`fluvia_worker` en `0002` son SOLO para local (R-12).
3. NINGÚN rol de runtime tiene BYPASSRLS (ADR-0011): `fluvia_relay` es el único con visión cross-tenant, SOLO sobre `outbox_events` y por política explícita; `fluvia_worker` es un cascarón sin privilegios. El relay corre en `apps/worker` con publisher de log (la entrega real llega con F2-12/F3-07).
   3bis. La tabla `idempotency_keys` ya tiene PK `(tenant_id, endpoint, key)` — el middleware de F2-09 debe usar SIEMPRE el endpoint normalizado en la clave.
4. El runner de migraciones usa advisory lock global; no lo ejecutes en paralelo con tests que abran transacciones largas de admin.

## Estado emocionalmente honesto

Fases 1–4 existen de verdad y están probadas contra Postgres 16 real, con una auditoría independiente integrada (**0 P1 abiertos, 0 P2 abiertos**) y **los 7 runbooks operativos ejecutados en drill**. Lo que existe: seguridad núcleo (F1), ledger + posting + idempotencia + outbox/inbox (F2), pagos **sandbox** end-to-end (F3: intents/attempts/confirm/refunds/checkout/links/webhooks/dashboard/SDK) y conciliación + operaciones (F4: reconciliación con four-eyes, panel admin, fees al 2%, payouts, disputas, observabilidad/watchdogs, runbooks drilled). Lo que NO existe (y así debe declararse): NINGÚN proveedor real (Fase 5, tras la matriz de jurisdicción Colombia + F0-VER), NINGUNA exposición pública ni uso `live` (congelado por decisión #24 hasta la re-auditoría + PEND-006), y el **restore drill** (Fase 6, Gate Restore — única pata restante de AUD-P2-007). Próximo paso: **el propietario solicita la re-auditoría** (paquete de entrada en `docs/audits/`); tras ella decide Fase 5 (proveedor real) o Fase 6 (hardening). Construye pequeño y con evidencia.
