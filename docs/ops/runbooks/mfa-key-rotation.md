# Runbook · Rotación de la clave de cifrado de secretos TOTP (`MFA_SECRET_KEY`)

**Tipo**: mantenimiento PLANIFICADO (no responde a una alerta) · **Sev**: — · F6 · Decidido en [ADR-0012](../../adr/0012-secret-manager-produccion.md).

**Qué rota**: la clave AES-256-GCM (`MFA_SECRET_KEY`) que cifra EN REPOSO el secreto TOTP de cada usuario con MFA (`users.totp_secret_enc` y el pendiente de enrolamiento `users.totp_pending_secret_enc`). **NO** cambia el secreto TOTP en claro — los códigos del Authenticator del usuario siguen verificando igual —, solo su cifrado en la base. Mismo mecanismo que la rotación de `WEBHOOK_SECRET_ENC_KEY` (ver `webhook-enc-key-rotation.md`).

**Cuándo**: sospecha de exposición de la clave, política de rotación periódica, o antes del sandbox compartido (PEND-006).

**Cómo funciona (por qué sin downtime)**: el descifrado usa un **keyring** — la clave ACTUAL (con la que se cifra) + claves RETIRADAS (solo descifran). El TAG de AES-GCM disambigua qué clave corresponde a cada blob (una clave ajena jamás autentica), así que varias conviven sin versionar el blob ni tocar el esquema. Un barrido re-cifra los secretos a la clave actual para poder eliminar la retirada.

**Invariante que hace la rotación sin ventana**: _ninguna instancia debe cifrar con una clave que otra instancia viva todavía no pueda descifrar_. El `AuthService` construye su keyring **una vez al arranque** del proceso (inyección por env, sin hot-reload), así que durante un rolling restart la flota queda mixta. Por eso la clave nueva se **pre-siembra como RETIRADA (solo-descifra) en TODA la flota ANTES** de promoverla a actual: cuando una instancia ya reiniciada empiece a cifrar un secreto TOTP nuevo (un enrolamiento) con la clave nueva, toda instancia —reiniciada o no— ya la tiene en su keyring y la descifra. Saltarse este paso deja una ventana en la que una API vieja no podría verificar un TOTP recién enrolado.

## Precondiciones

- Genera la clave NUEVA: `openssl rand -hex 32` (64 hex). Consérvala fuera del repo (hoy: variable de entorno inyectada al arranque; destino ADR-0012: secret manager del proveedor).
- Acceso para desplegar cambios de env y para correr el CLI con `AUTH_DATABASE_URL` (rol `fluvia_auth`, mínimo privilegio — el barrido NO usa superusuario).
- La clave VIEJA (la actual de hoy) a mano.
- `MFA_SECRET_KEY_RETIRED` acepta **lista por comas** (varias retiradas conviven).

## Procedimiento (cuatro fases, sin downtime)

Estado inicial: `MFA_SECRET_KEY = VIEJA`, `MFA_SECRET_KEY_RETIRED` vacío.

**Fase 1 — pre-sembrar la NUEVA como solo-descifra en TODA la flota (deploy):**

1. Fija (sin cambiar aún la actual):
   - `MFA_SECRET_KEY` = clave **VIEJA** (sigue siendo la actual).
   - `MFA_SECRET_KEY_RETIRED` = clave **NUEVA** (retirada = solo descifra).
2. Despliega (rolling restart) y **espera a que TODA la flota esté en esta config**. Nadie cifra con la nueva todavía; toda instancia ya puede descifrarla. No hay ventana (aún no existe ningún secreto bajo la nueva).

**Fase 2 — promover la NUEVA a actual, la VIEJA a retirada (deploy):**

3. Intercambia:
   - `MFA_SECRET_KEY` = clave **NUEVA** (ahora actual — cifra con ella los enrolamientos nuevos).
   - `MFA_SECRET_KEY_RETIRED` = clave **VIEJA** (retirada).
4. Despliega (rolling restart). La flota queda mixta, pero **toda instancia tiene AMBAS claves**, así que cualquier secreto TOTP se descifra y toda verificación de código funciona. Los secretos existentes siguen bajo la vieja hasta el barrido.

**Fase 3 — re-cifrar los secretos a la clave nueva (barrido):**

5. Con la Fase 2 desplegada en toda la flota, ejecuta el barrido (rol `fluvia_auth`, mínimo privilegio, por lotes, idempotente y reanudable):
   ```
   pnpm --filter @fluvia/auth run rotate:mfa-key
   ```
   Salida: `total=… reencrypted=… alreadyCurrent=… failed=…`. Re-cifra cada `totp_secret_enc`/`totp_pending_secret_enc` que aún esté bajo la vieja, a la nueva, preservando el secreto TOTP en claro. Si se interrumpe, **vuelve a correrlo**: los lotes ya commiteados persisten y los migrados quedan `alreadyCurrent`.
6. Repite hasta `reencrypted=0` **y** `failed=0`. Un `failed>0` señala secretos bajo una clave que **no** está en el keyring (revisa `failedIds`): resuélvelos antes de seguir (ver Rollback).

**Fase 4 — eliminar la clave vieja (deploy):**

7. **Prueba de vuelo de solo-lectura** (no muta) antes de tocar nada:
   ```
   pnpm --filter @fluvia/auth run rotate:mfa-key -- --check
   ```
   Exige `underRetired=0` **y** `undecryptable=0` (imprime «safe to REMOVE …»). Es el chequeo independiente de que no queda ningún secreto bajo la clave que vas a borrar.
8. Con eso confirmado, **borra** `MFA_SECRET_KEY_RETIRED` (deja solo la nueva como actual) y despliega. La clave vieja ya no se necesita; retírala/destrúyela según tu política.

## Verificación

1. Tras la Fase 3, el barrido reporta `reencrypted=0`, `failed=0` y `alreadyCurrent=total` en una corrida limpia.
2. El `--check` de la Fase 4 reporta `underRetired=0` y `undecryptable=0`.
3. Tras la Fase 4, los usuarios con MFA siguen pudiendo iniciar sesión (verifican su código TOTP igual que antes) y los enrolamientos nuevos funcionan.
4. Ningún error `no MFA enc key in the keyring can decrypt this secret` en los logs de la API (indicaría un secreto bajo una clave que ya no está en el keyring — no debería ocurrir si respetaste el gate de la Fase 4).

## Rollback

- **Antes de la Fase 4**: para revertir, vuelve a poner la clave vieja como `MFA_SECRET_KEY` (actual) y la nueva como retirada, y re-corre el barrido (migra de vuelta). Ambas descifran mientras estén en el keyring, así que la reversión es también sin ventana.
- **Secretos `failed`/`undecryptable`**: son secretos TOTP bajo una clave ausente del keyring (una clave vieja que olvidaste listar como retirada, o corrupción). La recuperación correcta es **volver a añadir la clave que falte** a `MFA_SECRET_KEY_RETIRED` y re-desplegar — eso restaura el login del usuario. **OJO**: mientras el secreto sea indescifrable, el `AuthService` lanza al verificar (`matchActiveTotp`), así que el usuario **tampoco puede usar un código de respaldo** (el fallback ni se alcanza) — la ÚNICA salida es re-añadir la clave. Si la clave está perdida de verdad, un admin debe deshabilitar MFA para ese usuario fuera de banda (y el usuario re-enrola).
- **Regla dura**: NUNCA elimines una clave del keyring mientras existan secretos cifrados con ella. La prueba es el `--check` (`underRetired=0` y `undecryptable=0`) **o** el barrido en `reencrypted=0`/`failed=0`. Borrarla antes bloquea a los usuarios afectados de MFA **por completo** (TOTP Y códigos de respaldo — el fallback ni se alcanza) hasta re-añadir la clave; si además la DESTRUISTE, sus secretos son irrecuperables (un admin deshabilita MFA para ellos y re-enrolan).

## Notas (límites honestos, V4 Nivel A)

- Este runbook cubre **solo** `MFA_SECRET_KEY`. La rotación de `WEBHOOK_SECRET_ENC_KEY` es un runbook aparte (`webhook-enc-key-rotation.md`, mismo mecanismo). El pepper de API keys (`API_KEY_HMAC_SECRET`, one-way — no re-cifrable) es la pata que RESTA de ADR-0012 (mecánica distinta: multi-pepper, las keys viejas conservan el suyo hasta re-emitirse).
- El barrido corre en **lotes con cotas de tiempo por transacción** (statement/lock/idle): los locks `FOR UPDATE` se sueltan entre lotes, así que un login concurrente (que hace `SELECT … FOR UPDATE` sobre su propia fila de `users`) espera a lo sumo un lote, no el barrido entero.
- El barrido re-cifra **todos** los usuarios con secreto TOTP, incluidos los `deleted_at` (soft-deleted): así retirar la clave vieja es seguro aunque un usuario borrado conserve su blob.
- El **secret manager de ADR-0012 aún no está integrado en el sandbox** (no hay infra externa); hoy las claves llegan por variables de entorno validadas. La integración concreta llega en el despliegue real (F5).

## Drill

Pendiente de ejecución en drill (como los demás runbooks operativos). La CAPACIDAD está cubierta por tests contra PG real (`packages/auth/test/mfa-rotate.test.ts` + `mfa-crypto.test.ts`): keyring de descifrado por trial, re-cifrado que preserva el secreto TOTP, fila mixta, resiliencia ante secretos indescifrables (`failed`), inspección de solo-lectura, idempotencia, y **end-to-end**: un usuario cuyo secreto está bajo la clave retirada autentica por el `AuthService` real (ventana de rotación), y tras el barrido autentica con solo la clave actual.
