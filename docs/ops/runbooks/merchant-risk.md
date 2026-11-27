# Runbook — Comercios estatales y congelación (#92)

Estado: Activo · Migración `0069_merchant_state_block_and_freeze.sql` · CLI `merchant-risk` (`@fluvia/identity`).

**Contexto.** Hasta que haya dictamen de sanciones (#82, borrador `docs/legal/RIESGOS-VE.md` §1; ese archivo aún no está en el repo), Fluvia **no da de alta** comercios del Gobierno de Venezuela ni con participación estatal (PDVSA incluida). Además, desde 0069 `merchants.status = 'frozen'` se hace cumplir en el **motor**: antes existía pero ningún servicio lo leía, así que un comercio "congelado" seguía cobrando.

**Decisión de producto (Celestino, PR #108).** La declaración de que el comercio **no** pertenece al Gobierno de Venezuela ni a PDVSA es **obligatoria en la API** al crear un comercio (`stateAffiliation` sin default): si falta, `400 validation_error`; si es `government`/`state_owned` (o el nombre está en la lista), `403 merchant_onboarding_blocked`. Los comercios **ya existentes** sin declaración **no se congelan ni se suspenden de golpe**. La migración los marca como `affiliation_declaration_status = 'pending_review'` (columna generada, consultable; el `status` no cambia). Después del deploy, Legal decide caso por caso (`screen --include-undeclared` y, si corresponde, `freeze`).

## Qué hace el motor (no depende de que el servicio se acuerde)

| Pieza | Dónde | Efecto | API |
| --- | --- | --- | --- |
| Afiliación declarada (`none` / `government` / `state_owned`) | `merchants.state_affiliation` | `government`/`state_owned` no pueden estar **activos**: alta, reactivación o re-declaración fallan (SQLSTATE `FV452`). `NULL` = comercio legado sin declarar | `403 merchant_onboarding_blocked` (alta nueva); `400` si falta el campo |
| Pendiente de declaración o revisión | `merchants.affiliation_declaration_status` | Columna generada: `pending_review` si `state_affiliation IS NULL`, `declared` si ya hay valor. Consultable (`WHERE affiliation_declaration_status = 'pending_review'`). **No congela ni suspende.** | — (flag de triage; Legal decide después del deploy) |
| Lista de nombres | `merchant_name_denylist` | Alta o renombrado cuyo nombre normalizado (sin tildes ni signos, siglas juntas: `P.D.V.S.A.` → `pdvsa`) contiene un patrón activo **por palabras completas** → `FV452` | `403 merchant_onboarding_blocked` |
| Congelación | `merchants.status = 'frozen'` | Sin `payment_intents`, `payment_attempts` ni `payouts` nuevos, y sin **emitir** payouts `requested` (`FV453`). Un payout pedido antes falla con `failure_code = merchant_frozen` (no queda atascado para el redriver) | `403 merchant_frozen` |
| Columnas protegidas | trigger `merchants_state_guard` | Los roles `fluvia_*` no pueden cambiar `status`, `state_affiliation`, `country` ni `tenant_id` (`42501`): un comercio no se descongela ni se "muda" de país solo | — |

**No se corta**, a propósito (igual que el kill switch de #91): lo ya en vuelo (webhooks, conciliación, fase 2 de un attempt ya enviado) y los **refunds** — devolver el dinero es la salida ordenada.

La API no dice **cuál** regla bloqueó ni el patrón: puede ser sensible (sanciones).

La declaración la exige `POST /v1/organizations/:orgId/merchants` y `…/onboarding/merchant` (campo `stateAffiliation`, sin valor por defecto) y queda en la auditoría `merchant.created` como evidencia.

## Comandos (plano de plataforma)

Corren con el pool **admin**. Toda escritura exige `--reason` y `--actor` (uuid del operador) y deja un `platform.operation` de riesgo alto en la misma transacción.

```bash
pnpm --filter @fluvia/identity run merchant-risk -- screen
```

Lista los comercios **activos** declarados estatales o con nombre en la lista. Con `--include-undeclared` añade los legados sin declaración (`affiliation_declaration_status = 'pending_review'`, anteriores a 0069). Solo lee: no congela nada. Equivale a consultar `WHERE affiliation_declaration_status = 'pending_review' AND status = 'active' AND deleted_at IS NULL`.

```bash
pnpm --filter @fluvia/identity run merchant-risk -- freeze --merchant <uuid> --actor <uuid-operador> --reason "Filial de PDVSA según registro mercantil (#92)"
```

```bash
pnpm --filter @fluvia/identity run merchant-risk -- unfreeze --merchant <uuid> --actor <uuid-operador> --reason "Falso positivo revisado por Legal 2026-12-01"
```

```bash
pnpm --filter @fluvia/identity run merchant-risk -- denylist-add --pattern "Corporación Venezolana de Guayana" --actor <uuid-operador> --reason "Legal 2026-12-01"
```

```bash
pnpm --filter @fluvia/identity run merchant-risk -- denylist-retire --id <uuid> --actor <uuid-operador> --reason "Falso positivo"
```

`denylist-list [--include-retired]` y `show --merchant <uuid>` son de solo lectura.

## Procedimientos

### A. Triage después de desplegar 0069 (una vez) y tras cada alta en la lista

**No congelar en masa** a los comercios `pending_review`. Siguen operando hasta que Legal decida, caso por caso.

1. `screen` → revisar cada fila con Legal (estatales declarados o nombre en la lista).
2. Estatal confirmado → `freeze` con la evidencia en `--reason`.
3. Falso positivo por nombre → `denylist-retire` del patrón **solo si Legal lo aprueba**; si el patrón es correcto pero el comercio no es estatal, se deja activo (el guard solo actúa al renombrar o reactivar).
4. `screen --include-undeclared` (o `SELECT id, name, country, status FROM merchants WHERE affiliation_declaration_status = 'pending_review' AND deleted_at IS NULL`) → pedir la declaración a los legados (hoy por soporte; la corrección la hace plataforma con el comercio **congelado**, ver C). Legal decide uno a uno si además hay que congelar.

### B. Un cliente reporta `403 merchant_onboarding_blocked`

1. No le digas qué regla saltó. Pide razón social y documento.
2. Si es privado y el nombre coincide con un patrón (falso positivo), escala a Legal; la salida es retirar o afinar el patrón (`denylist-retire` + `denylist-add` más específico).
3. Si declaró por error `government`/`state_owned`: puede volver a enviar el alta con `none` (no quedó ninguna fila).

### C. Corregir la declaración de un comercio existente

Solo plataforma (pool admin), y con el comercio **congelado** (con él activo, declarar `government`/`state_owned` falla por diseño):

1. `freeze` con razón.
2. `UPDATE merchants SET state_affiliation = '<valor>' WHERE id = '<uuid>'` en una sesión admin, dejando nota en el caso.
3. Si quedó `none`, `unfreeze`; si quedó estatal, permanece congelado hasta el dictamen.

### D. Levantar el bloqueo tras el dictamen

No es un flag operativo: hace falta una **migración nueva** que cambie el guard (`fluvia_merchant_state_guard`), revisada como decisión de producto y legal. Hasta entonces `unfreeze` de un comercio estatal falla siempre.

### E. Alertas del watchdog (migración 0070)

El worker corre `sweep_merchant_risk()` cada `MERCHANT_RISK_WATCHDOG_INTERVAL_MS` (5 min por defecto; `MERCHANT_RISK_WATCHDOG_ENABLED=false` lo apaga) y expone tres gauges. **No congela nada**: solo cuenta. La función devuelve números, nunca nombres ni patrones; el detalle se saca con el CLI.

| Gauge | Alerta (`observability.md` §4) | Qué hacer |
| --- | --- | --- |
| `fluvia_merchants_denylisted_active` | `> 0` · ALTA | Un comercio **activo** coincide con la denylist. Pasa cuando el comercio se dio de alta antes de 0069 o antes de un `denylist-add`: el guard no re-evalúa a los ya activos. `screen` → Legal → `freeze` (o `kill-switch engage --scope merchant` si hace falta cortar ya y Legal aún no decidió) **o** `denylist-retire` si el patrón es un falso positivo. Log del worker: `ACTIVE MERCHANTS MATCH THE STATE DENYLIST` en cada corrida. |
| `fluvia_merchants_pending_review_total` | `delta(…[1h]) > 0` · ALTA | Apareció un comercio **nuevo** sin declaración. La API lo impide (`400` si falta `stateAffiliation`), así que alguien creó la fila por otro camino: seed, SQL en una sesión admin o una regresión del endpoint. Localízalo (`SELECT id, tenant_id, name, created_at FROM merchants WHERE state_affiliation IS NULL ORDER BY created_at DESC LIMIT 10`), averigua el camino y corrige la declaración con el procedimiento C. Log del worker: `NEW merchant without state-affiliation declaration` (compara el total corrida a corrida, así que un `unfreeze` de un legado no lo dispara). Límite: si en la misma hora entra uno nuevo y Legal declara uno viejo, el `delta` queda en 0; el log del worker lo registra salvo que ambos caigan dentro de la misma corrida (5 min). |
| `fluvia_merchants_pending_review` | `min_over_time(…[7d]) > 0` · MEDIA | La cola de legados (#108) lleva una semana sin vaciarse. Es un **ticket para Legal**, no una página: estos comercios siguen cobrando por decisión de producto. `screen --include-undeclared` da la lista; se resuelve con A.4 y C. **No congelar en masa.** El worker lo registra como `info` solo cuando el número cambia. |

`fluvia_merchants_pending_review_total` incluye a los congelados; la diferencia con `fluvia_merchants_pending_review` son los que ya no pueden cobrar pero siguen sin declarar.

**Falla cerrado.** `merchants` tiene `FORCE RLS`: si el dueño de `sweep_merchant_risk()` no se salta RLS (en cloud, un rol owner sin `BYPASSRLS`), la función **lanza** `FLUVIA_MERCHANT_RISK_SWEEP_BLIND` en vez de devolver 0. En el worker se ve como `merchant risk watchdog run failed` en cada corrida y los gauges dejan de actualizarse. Un 0 en estos gauges significa sano; un error significa que el watchdog está ciego. Se arregla dando `BYPASSRLS` al dueño de la función o cambiando el dueño (`ALTER FUNCTION sweep_merchant_risk() OWNER TO …`).

**El watchdog dejó de correr** (alerta «Watchdog de riesgo sin corrida correcta», follow-up de #110). Si el job no corre, los tres gauges se quedan con su último valor y sus alertas no pueden saltar. El worker expone `fluvia_worker_job_last_success_timestamp_seconds{task="merchant_risk"}` y la alerta salta cuando envejece más de 3 intervalos (15 min con el default). Al arrancar arranca en la hora del boot, así que un worker que nunca logra una corrida correcta también alerta.

1. `fluvia_worker_job_runs_total{task="merchant_risk",result="error"}` sube → la corrida falla. El log dice `merchant risk watchdog run failed` con la causa. `FLUVIA_MERCHANT_RISK_SWEEP_BLIND` se arregla como arriba; un error de conexión es de la BD, no del watchdog.
2. No sube ninguno de los dos contadores → una corrida está **colgada** (el job no lanza la siguiente mientras la anterior siga en vuelo, y no loguea nada) o el timer murió. Mirar consultas del rol `fluvia_worker` en `pg_stat_activity` sobre `sweep_merchant_risk()`; reiniciar el worker si no hay otra causa.
3. Verificar: tras la siguiente corrida correcta, `time() - fluvia_worker_job_last_success_timestamp_seconds{task="merchant_risk"}` vuelve a menos de un intervalo.

`fluvia_worker_job_enabled{task="merchant_risk"} == 0` significa `MERCHANT_RISK_WATCHDOG_ENABLED=false`. En producción eso es una alerta MEDIA: sin el job nadie ve la denylist ni las altas sin declaración.

## Verificación

- `show --merchant <uuid>` muestra `FROZEN`/`ACTIVE`, la afiliación y `declaration=pending_review|declared`.
- Un `POST /v1/payment_intents` del comercio congelado responde `403 merchant_frozen` y no crea filas; la `Idempotency-Key` sigue disponible para reintentar tras descongelar.
- Auditoría: `audit_events` con `action = 'platform.operation'`, `resource_id = <merchant>` y la razón (panel «Eventos», `audit-investigation.md`).

## Relación con el kill switch (#91, PR #104)

El kill switch corta por país, comercio, organización o proveedor con su propia tabla y SQLSTATE (`FV451`); la congelación es el **estado del comercio**. Son independientes y los dos se aplican en el motor: para una contención inmediata por país usa el kill switch; para un comercio concreto que no debe operar, congélalo. La tabla de decisión completa está en [`kill-switch.md`](./kill-switch.md#kill-switch-o-congelación-cuál-usar).
