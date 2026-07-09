# Runbook · Rotación de la clave de cifrado de webhooks (`WEBHOOK_SECRET_ENC_KEY`)

**Tipo**: mantenimiento PLANIFICADO (no responde a una alerta) · **Sev**: — · F6 · Decidido en [ADR-0012](../../adr/0012-secret-manager-produccion.md).

**Qué rota**: la clave AES-256-GCM (`WEBHOOK_SECRET_ENC_KEY`) que cifra EN REPOSO los secretos de firma de cada endpoint de webhook (`webhook_endpoints.secret_enc`/`prev_secret_enc`). **NO** rota los secretos `whsec_` de los comercios (eso es `rotateSecret` por endpoint, otra cosa) — solo su cifrado en la base. Las firmas hacia el comercio no cambian.

**Cuándo**: sospecha de exposición de la clave, política de rotación periódica, o antes del sandbox compartido (PEND-006).

**Cómo funciona (por qué sin downtime)**: el descifrado usa un **keyring** — la clave ACTUAL (con la que se cifra) + claves RETIRADAS (solo descifran). El TAG de AES-GCM disambigua qué clave corresponde a cada blob (una clave ajena jamás autentica), así que varias conviven sin versionar el blob ni tocar el esquema. Un barrido re-cifra los blobs a la clave actual para poder eliminar la retirada.

**Invariante que hace la rotación sin ventana**: _ninguna instancia debe cifrar con una clave que otra instancia viva todavía no pueda descifrar_. El keyring se lee **una vez al arranque** del proceso (inyección por env, sin hot-reload), así que durante un rolling restart la flota queda mixta. Por eso la clave nueva se **pre-siembra como RETIRADA (solo-descifra) en TODA la flota ANTES** de promoverla a actual: cuando una instancia ya reiniciada empiece a cifrar con la nueva, toda instancia —reiniciada o no— ya la tiene en su keyring y la descifra. Saltarse este paso deja una ventana en la que un worker viejo no puede descifrar un blob recién escrito (se recupera por reintentos, pero no es «sin interrupción»).

## Precondiciones

- Genera la clave NUEVA: `openssl rand -hex 32` (64 hex). Consérvala fuera del repo (hoy: variable de entorno inyectada al arranque; destino ADR-0012: secret manager del proveedor).
- Acceso para desplegar cambios de env y para correr el CLI con `ADMIN_DATABASE_URL` (rol admin).
- La clave VIEJA (la actual de hoy) a mano.
- `WEBHOOK_SECRET_ENC_KEY_RETIRED` acepta **lista por comas** (varias retiradas conviven).

## Procedimiento (cuatro fases, sin downtime)

Estado inicial: `WEBHOOK_SECRET_ENC_KEY = VIEJA`, `WEBHOOK_SECRET_ENC_KEY_RETIRED` vacío.

**Fase 1 — pre-sembrar la NUEVA como solo-descifra en TODA la flota (deploy):**

1. Fija (sin cambiar aún la actual):
   - `WEBHOOK_SECRET_ENC_KEY` = clave **VIEJA** (sigue siendo la actual).
   - `WEBHOOK_SECRET_ENC_KEY_RETIRED` = clave **NUEVA** (retirada = solo descifra).
2. Despliega (rolling restart) y **espera a que TODA la flota esté en esta config**. Nadie cifra con la nueva todavía; toda instancia ya puede descifrarla. No hay ventana (aún no existe ningún blob bajo la nueva).

**Fase 2 — promover la NUEVA a actual, la VIEJA a retirada (deploy):**

3. Intercambia:
   - `WEBHOOK_SECRET_ENC_KEY` = clave **NUEVA** (ahora actual — cifra con ella).
   - `WEBHOOK_SECRET_ENC_KEY_RETIRED` = clave **VIEJA** (retirada).
4. Despliega (rolling restart). La flota queda mixta, pero **toda instancia tiene AMBAS claves** (las de Fase 1 tienen `retired=[NUEVA]`, las de Fase 2 `retired=[VIEJA]`), así que cualquier blob se descifra lo escriba quien lo escriba. Los blobs existentes siguen bajo la vieja hasta el barrido.

**Fase 3 — re-cifrar los blobs a la clave nueva (barrido):**

5. Con la Fase 2 desplegada en toda la flota, ejecuta el barrido (rol admin, cross-tenant, por lotes, idempotente y reanudable):
   ```
   pnpm --filter @fluvia/webhooks run rotate:webhook-key
   ```
   Salida: `total=… reencrypted=… alreadyCurrent=… failed=…`. Re-cifra cada `secret_enc`/`prev_secret_enc` que aún esté bajo la vieja, a la nueva, preservando el secreto en claro. Si se interrumpe (p. ej. contención de locks), **vuelve a correrlo**: los lotes ya commiteados persisten y los migrados quedan `alreadyCurrent`.
6. Repite hasta `reencrypted=0` **y** `failed=0`. Un `failed>0` señala blobs bajo una clave que **no** está en el keyring (revisa `failedIds`): resuélvelos antes de seguir (ver Rollback).

**Fase 4 — eliminar la clave vieja (deploy):**

7. **Prueba de vuelo de solo-lectura** (no muta) antes de tocar nada:
   ```
   pnpm --filter @fluvia/webhooks run rotate:webhook-key -- --check
   ```
   Exige `underRetired=0` **y** `undecryptable=0` (imprime «safe to REMOVE …»). Este es el chequeo independiente de que no queda ningún blob bajo la clave que vas a borrar.
8. Con eso confirmado, **borra** `WEBHOOK_SECRET_ENC_KEY_RETIRED` (deja solo la nueva como actual) y despliega. La clave vieja ya no se necesita; retírala/destrúyela según tu política.

## Verificación

1. Tras la Fase 3, el barrido reporta `reencrypted=0`, `failed=0` y `alreadyCurrent=total` en una corrida limpia.
2. El `--check` de la Fase 4 reporta `underRetired=0` y `undecryptable=0`.
3. Tras la Fase 4, las entregas de webhook siguen firmando y llegando (`fluvia_webhook_deliveries_total{result="delivered"}` incrementa; el comercio verifica la firma igual que antes).
4. Ningún error `no webhook enc key in the keyring can decrypt this secret` en los logs del worker (indicaría un blob bajo una clave que ya no está en el keyring — no debería ocurrir si respetaste el gate de la Fase 4).

## Rollback

- **Antes de la Fase 4**: para revertir, vuelve a poner la clave vieja como `WEBHOOK_SECRET_ENC_KEY` (actual) y la nueva como retirada, y re-corre el barrido (migra de vuelta). Ambas descifran mientras estén en el keyring, así que la reversión es también sin ventana.
- **Blobs `failed`/`undecryptable`**: son secretos bajo una clave ausente del keyring (una clave vieja que olvidaste listar como retirada, o corrupción). Añade la clave que falte a `WEBHOOK_SECRET_ENC_KEY_RETIRED` y re-corre; si no hay tal clave, el `whsec_` de ese endpoint está perdido y hay que re-emitirlo (`rotateSecret`) y avisar al comercio.
- **Regla dura**: NUNCA elimines una clave del keyring mientras existan blobs cifrados con ella. La prueba es el `--check` (`underRetired=0` y `undecryptable=0`) **o** el barrido en `reencrypted=0`/`failed=0`. Borrarla antes = secretos irrecuperables.

## Notas (límites honestos, V4 Nivel A)

- Este runbook cubre **solo** `WEBHOOK_SECRET_ENC_KEY`. La rotación de `MFA_SECRET_KEY` (secreto TOTP) y del pepper de API keys (`API_KEY_HMAC_SECRET`, one-way — no re-cifrable) son incrementos aparte (ADR-0012, patas siguientes).
- El re-cifrado es un **barrido de mantenimiento** (CLI admin), no lazy-en-acceso — suficiente para la escala pre-sandbox y sin tocar los privilegios del rol del deliverer. Un re-cifrado lazy/continuo puede añadirse si la escala lo exige.
- El barrido corre en **lotes con cotas de tiempo por transacción** (statement/lock/idle, como `withTenantTransaction`): los locks `FOR UPDATE` se sueltan entre lotes, así que una escritura de gestión de endpoints (create/rotate/disable) espera a lo sumo un lote, no el barrido entero.
- El **secret manager de ADR-0012 aún no está integrado en el sandbox** (no hay infra externa); hoy las claves llegan por variables de entorno validadas. La integración concreta llega en el despliegue real (F5).

## Drill

Pendiente de ejecución en drill (como los demás runbooks operativos). La CAPACIDAD está cubierta por tests contra PG real (`packages/webhooks/test/rotate.test.ts` + `crypto.test.ts`): keyring de descifrado por trial, re-cifrado cross-tenant que preserva el claro, fila mixta, resiliencia ante blobs indescifrables (`failed`), inspección de solo-lectura, e idempotencia.
