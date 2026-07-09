# Runbook · Rotación del pepper HMAC de API keys (`API_KEY_HMAC_SECRET`)

**Tipo**: mantenimiento PLANIFICADO (no responde a una alerta) · **Sev**: — · F6 · Decidido en [ADR-0012](../../adr/0012-secret-manager-produccion.md).

**Qué rota**: el pepper HMAC-SHA256 (`API_KEY_HMAC_SECRET`) con el que se hashea el secreto de cada API key (`api_keys.key_hash = hmac(pepper, secret)`, v2 — AUD-P2-015). El secreto `fluvia_sk_...` del comercio **NO** cambia; solo su hash en reposo.

**En qué se DIFERENCIA de las otras dos patas de rotación** (webhook-enc, MFA): esas cifran con AES-GCM (reversible) y un barrido re-cifra TODO → el pepper es **HMAC ONE-WAY**: un hash guardado NO se puede re-hashear a un pepper nuevo sin el secreto en claro (que solo el llamador tiene, al autenticar). Por eso:

- El re-hash pepper-viejo→nuevo es **PEREZOSO**, dentro de `authenticate_api_key` (migr. 0044) — la misma llamada que ya sube v1(sha256)→v2(hmac): si el hash matchea con un pepper RETIRADO, se re-hashea al ACTUAL y se fija su huella.
- **NO hay barrido en bloque.** Las keys que nunca se autentican (dormidas) no se migran solas: para llegar a `underRetired = 0` (y poder borrar el pepper viejo) hay que **revocar las dormidas** (el comercio re-emite si las necesita).
- El gate de retiro es una **huella por-fila** (`api_keys.key_hash_pepper_fp`, one-way, no secreta) + el CLI `--check`.

**Cuándo**: sospecha de exposición del pepper, política de rotación periódica, o antes del sandbox compartido (PEND-006).

## Precondiciones

- Genera el pepper NUEVO: `openssl rand -hex 32` (64 hex). Fuera del repo (hoy: env inyectada al arranque; destino ADR-0012: secret manager).
- Acceso para desplegar cambios de env y para correr el CLI con `ADMIN_DATABASE_URL` (rol admin — `api_keys` tiene RLS por-tenant, cruzar tenants exige superusuario, como el barrido de webhooks).
- El pepper VIEJO (el actual de hoy) a mano. `API_KEY_HMAC_SECRET_RETIRED` acepta **lista por comas**.

## Fase 0 — backfill de la huella (UNA sola vez, tras desplegar la migración 0044)

La migración añade `key_hash_pepper_fp` NULL en las filas v2 existentes (la BD no puede derivarla — no tiene el pepper). Marca esas filas como bajo el pepper ACTUAL para que el gate sea exacto:

```
pnpm --filter @fluvia/identity run rotate:api-key-pepper -- --backfill
```

**Correcto SOLO antes de la primera rotación** (cuando el pepper actual == el que produjo esas filas). Corriéndolo DESPUÉS de promover un pepper nuevo marcaría filas viejas como «actuales» y el gate leería «seguro» en falso. Por eso el CLI **RECHAZA `--backfill` si `API_KEY_HMAC_SECRET_RETIRED` está configurado** (guard duro, no solo esta nota). Tras el backfill, `--check` debe reportar `unmarked=0`.

**Despliegue de la migración 0044** (una nota de orden, no de esta rotación en sí): 0044 cambia la ARIDAD de `authenticate_api_key` (DROP de la firma de 2 args + CREATE de la de 4) — como cualquier migración de firma no-aditiva (p. ej. 0016). Despliega la migración y la versión de la app que llama a la firma de 4 args **juntas**: si se despliegan desordenadas hay una ventana breve de auth (una instancia vieja llama a la firma de 2 args ya borrada, o una nueva a la de 4 aún no creada). El compose de despliegue (`migrate → api+worker`) ya las ordena.

## Procedimiento de rotación (cuatro fases, sin ventana de autenticación)

Estado inicial: `API_KEY_HMAC_SECRET = VIEJO`, `API_KEY_HMAC_SECRET_RETIRED` vacío, `unmarked=0` (backfill hecho).

**Fase 1 — pre-sembrar el NUEVO como solo-verifica en TODA la flota (deploy):**

1. Fija (sin cambiar aún el actual):
   - `API_KEY_HMAC_SECRET` = pepper **VIEJO** (sigue siendo el actual — hashea las keys nuevas).
   - `API_KEY_HMAC_SECRET_RETIRED` = pepper **NUEVO** (retirado = solo verifica).
2. Despliega (rolling restart) y espera a que TODA la flota esté en esta config. Nadie hashea con el nuevo todavía; toda instancia ya puede VERIFICAR una key bajo el nuevo. Sin ventana (aún no existe ninguna key bajo el nuevo).

**Fase 2 — promover el NUEVO a actual, el VIEJO a retirado (deploy):**

3. Intercambia:
   - `API_KEY_HMAC_SECRET` = pepper **NUEVO** (ahora actual — hashea las keys nuevas).
   - `API_KEY_HMAC_SECRET_RETIRED` = pepper **VIEJO** (retirado).
4. Despliega (rolling restart). La flota queda mixta, pero **toda instancia tiene AMBOS peppers**, así que cualquier key verifica. Y ARRANCA el re-hash perezoso: cada key vieja que se autentica se re-hashea del viejo al nuevo (fijando la huella nueva).

**Fase 3 — ventana de migración perezosa (esperar + medir):**

5. No cambies config. Deja que las keys se autentiquen y se re-hasheen solas. Mide el avance:
   ```
   pnpm --filter @fluvia/identity run rotate:api-key-pepper -- --check
   ```
   `underRetired` (keys vivas aún bajo el viejo) baja según se usan las keys. `underCurrent` sube. `unknown>0` señalaría un pepper que olvidaste listar (añádelo a retirados). Elige una ventana acorde a tu perfil de uso (p. ej. hasta que la mayoría de keys activas hayan rotado).

**Fase 4 — retirar el pepper viejo (deploy):**

6. Cuando el `--check` reporte `underRetired=0` **y** `unmarked=0` **y** `unknown=0` (imprime «safe to REMOVE …»): si quedan stragglers vivos bajo el viejo (keys dormidas que no se re-autenticaron), **revócalos** — el `--check` lista sus ids; el comercio re-emite si aún las necesita. Repite `--check` hasta `underRetired=0`.
7. **Borra** `API_KEY_HMAC_SECRET_RETIRED` (deja solo el nuevo como actual) y despliega. El pepper viejo ya no se necesita; destrúyelo según tu política.

## Verificación

1. Tras la Fase 2, `--check` muestra `underRetired>0` bajando con el uso; `unknown=0`.
2. La Fase 4 exige `underRetired=0`, `unmarked=0`, `unknown=0` antes de borrar.
3. Tras la Fase 4, las integraciones siguen autenticando con su `fluvia_sk_...` (el secreto no cambió); las keys re-emitidas por revocación usan el pepper nuevo desde su creación.

## Rollback

- **Antes de la Fase 4**: para revertir, vuelve a poner el pepper viejo como `API_KEY_HMAC_SECRET` (actual) y el nuevo como retirado, y redespliega. Ambos verifican mientras estén en el keyring; las keys ya re-hasheadas al nuevo se re-hashean de vuelta al viejo al autenticar. Sin ventana.
- **Keys `unknown`** (bajo un pepper fuera del keyring): añade el pepper que falte a `API_KEY_HMAC_SECRET_RETIRED` y redespliega — recupera su autenticación. Si el pepper está perdido de verdad, esas keys NO pueden autenticar: revócalas y el comercio re-emite.
- **Regla dura**: NUNCA borres un pepper del keyring mientras exista una key VIVA hasheada con él. La prueba es el `--check` (`underRetired=0` Y `unmarked=0` Y `unknown=0`). Borrarlo antes bloquea a esas keys (dejan de autenticar) hasta re-añadir el pepper o re-emitirlas.

## Notas (límites honestos, V4 Nivel A)

- Con esto quedan HECHAS las **tres** patas de rotación de secretos de ADR-0012: `WEBHOOK_SECRET_ENC_KEY`, `MFA_SECRET_KEY` (ambas keyring AES-GCM + barrido) y `API_KEY_HMAC_SECRET` (pepper one-way + re-hash perezoso). Resta el cifrado field-level de credenciales de proveedor (F5).
- La **huella** `key_hash_pepper_fp` es one-way. Límite honesto: SÍ es un dato derivado del pepper que se persiste — un ORÁCULO de verificación (con un dump se puede confirmar un pepper adivinado offline, sin conocer ningún secreto; el `key_hash` no daba eso porque exige el secreto en claro). NO es explotable contra un pepper aleatorio de 256 bits (confirmar exige adivinar los 256 bits), pero es una exposición NUEVA respecto al `key_hash` — el trade-off aceptado a cambio de un gate de retiro verificable. 128 bits (32 hex) hacen las colisiones del gate despreciables.
- El backfill y el `--check` corren por **lotes con cotas de tiempo por transacción** (statement/lock/idle); el `--check` es SOLO LECTURA.
- El **secret manager de ADR-0012 aún no está integrado en el sandbox** (no hay infra externa); hoy los peppers llegan por variables de entorno validadas. La integración concreta llega en el despliegue real (F5).

## Drill

Pendiente de ejecución en drill (como los demás runbooks operativos). La CAPACIDAD está cubierta por tests contra PG real (`packages/identity/test/api-keys.test.ts`): create fija la huella; una key bajo el pepper RETIRADO autentica y se RE-HASHEA al actual (y luego autentica con solo el actual); el gate `inspectApiKeyPepper` cuenta bajo-retirado y baja a 0 al re-hashear; un pepper fuera del keyring se reporta `unknown` y NO autentica; el backfill marca las filas sin huella.
