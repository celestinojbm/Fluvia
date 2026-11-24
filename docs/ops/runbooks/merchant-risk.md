# Runbook — Comercios estatales y congelación (#92)

Estado: Activo · Migración `0069_merchant_state_block_and_freeze.sql` · CLI `merchant-risk` (`@fluvia/identity`).

**Contexto.** Hasta que haya dictamen de sanciones (#82, borrador `docs/legal/RIESGOS-VE.md` §1), Fluvia **no da de alta** comercios del Gobierno de Venezuela ni con participación estatal (PDVSA incluida). Además, desde 0069 `merchants.status = 'frozen'` se hace cumplir en el **motor**: antes existía pero ningún servicio lo leía, así que un comercio "congelado" seguía cobrando.

## Qué hace el motor (no depende de que el servicio se acuerde)

| Pieza | Dónde | Efecto | API |
| --- | --- | --- | --- |
| Afiliación declarada (`none` / `government` / `state_owned`) | `merchants.state_affiliation` | `government`/`state_owned` no pueden estar **activos**: alta, reactivación o re-declaración fallan (SQLSTATE `FV452`). `NULL` = comercio legado sin declarar | `403 merchant_onboarding_blocked` |
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

Lista los comercios **activos** declarados estatales o con nombre en la lista. Con `--include-undeclared` añade los legados sin declaración (anteriores a 0069). Solo lee: no congela nada.

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

1. `screen` → revisar cada fila con Legal.
2. Estatal confirmado → `freeze` con la evidencia en `--reason`.
3. Falso positivo por nombre → `denylist-retire` del patrón **solo si Legal lo aprueba**; si el patrón es correcto pero el comercio no es estatal, se deja activo (el guard solo actúa al renombrar o reactivar).
4. `screen --include-undeclared` → pedir la declaración a los legados (hoy por soporte; la corrección la hace plataforma con el comercio **congelado**, ver C).

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

## Verificación

- `show --merchant <uuid>` muestra `FROZEN`/`ACTIVE` y la afiliación.
- Un `POST /v1/payment_intents` del comercio congelado responde `403 merchant_frozen` y no crea filas; la `Idempotency-Key` sigue disponible para reintentar tras descongelar.
- Auditoría: `audit_events` con `action = 'platform.operation'`, `resource_id = <merchant>` y la razón (panel «Eventos», `audit-investigation.md`).

## Relación con el kill switch (#91, PR #104)

El kill switch corta por país, comercio, organización o proveedor con su propia tabla y SQLSTATE (`FV451`); la congelación es el **estado del comercio**. Son independientes y los dos se aplican en el motor: para una contención inmediata por país usa el kill switch; para un comercio concreto que no debe operar, congélalo.
