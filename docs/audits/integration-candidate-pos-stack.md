# Candidato de integración — pila POS (#56 + #55 → #57 → #58)

Rama: `integration/fluvia-pos-candidato` · base: `claude/new-session-haeo7h` @ `ed2f368f79`.
Candidato para **revisión**: no se fusiona, no se despliega y no autoriza producción
(PEND-007 y PEND-008 — país, moneda y exponente — siguen pendientes).

## Orden y SHAs compuestos

| # | PR | Rama fuente | HEAD revisado | Merge en la candidata |
|---|----|-------------|---------------|-----------------------|
| 1 | #56 | `claude/eloquent-cerf-pouaga` | `9101a59214a60824e240d06851a9ba438075a9e5` | `integration(1/4)` |
| 2 | #55 | `claude/keen-keller-hydhh2` | `b0b75b00b2272f7e39a0f2adf71a5104c159a105` | `integration(2/4)` |
| 3 | #57 | `claude/pos-charge-tracking-recovery` | `df1fc18a951ab70e244bf4917c26d1d1577077ff` | `integration(3/4)` |
| 4 | #58 | `claude/pos-single-charge-invariant` | `af1e62b60f91468d91b486399749f90cb62f6283` | `integration(4/4)` = `2a0e0d38d8` |

Método: `git merge --no-ff <SHA>` en ese orden (merge de la rama fuente, historia
preservada). #55 ⊂ #57 ⊂ #58 son ancestros lineales; #56 es independiente.

## Fidelidad

Verificado con diff textual (idénticos byte a byte):

- `diff(base, #56)` == `diff(#58, candidata)` → el contenido de #56 entra completo y sin alterar.
- `diff(base, #58)` == `diff(#56, candidata)` → el contenido de #55/#57/#58 entra completo y sin alterar.

Los conjuntos de ficheros son disjuntos: #56 toca `apps/checkout/package.json`,
`apps/dashboard/package.json`, `pnpm-lock.yaml`; la pila POS no toca ninguno de los tres.

## Conflictos

**Ninguno** (ni textual ni semántico detectado por el gate). Ninguna rama fuente
necesita una corrección para no divergir de este candidato.

## Gate ejecutado sobre la combinación (`2a0e0d38d8`, local, 2026-09-30)

Entorno: PostgreSQL 16.13 en clúster recién inicializado (`initdb`, auth scram),
Redis 7.0.15, Node 22.22.2, pnpm 10.33.0. MockProvider únicamente.

| Paso | Resultado |
|------|-----------|
| `pnpm install --frozen-lockfile` | OK |
| `pnpm lint` / `pnpm format:check` | OK / OK |
| `pnpm build` (tipos + build, 21 tareas) | OK |
| `pnpm migrate` sobre PG16 limpio | OK — 47 migraciones (hasta `0047_pos_sale_release_guard.sql`) |
| Segunda corrida de migraciones | `schema up to date, nothing applied` |
| `pnpm test` (PG real + Redis) | OK — 144 ficheros, 1356 tests, 0 fallos, 0 omitidos |
| `verify-ledger-invariants.sql` | `FLUVIA_INVARIANTS_OK` |
| drills worker-down / restore / load-chaos | PASS / PASS / PASS |
| `pnpm licenses:check --strict` | OK — 128 paquetes prod, sin prohibidas/desconocidas |
| `pnpm audit --audit-level high` (pnpm 11.13.0, como CI) | **exit 0** — 4 moderate (fastify ×2, vitest, @vitest/mocker), 0 high/critical |
| Mismo audit sobre la base `ed2f368` | exit 1 — 38 (11 moderate, 25 high, 2 critical): **heredado**; #56 lo corrige |
| SBOM (syft) / grype | No ejecutable en local (binarios no disponibles); lo cubre el CI del candidato |

`docs/compliance/license-exceptions.json` y `.grype.yaml` no cambian respecto a la base.

### Recorridos POS (`packages/payments-core/test/pos-sale-single-charge.test.ts`, 17/17)

- **Dos checkouts concurrentes** de la misma venta ⇒ exactamente uno cobra; el otro
  `SaleAlreadyChargedError` sin attempt (también carrera de 8).
- **Respuesta incierta** (`tok_timeout` ⇒ attempt `indeterminate`) ⇒ la venta queda
  `in_progress`, otro checkout y un checkout nuevo son rechazados; solo una resolución
  verificada del proveedor la libera (rechazo) o la cierra (éxito).
- **Cancelación de un intent autorizado** ⇒ rechazada por servicio y por el motor
  (`FLUVIA_SALE_RELEASE_UNVERIFIED`, también con `UPDATE` directo del rol app);
  un `failed` local tampoco libera la venta.

## Observaciones (no bloquean la composición; decisión del propietario)

1. **No existe vía de anulación verificada.** 0047 rechaza *toda* cancelación local
   de un intent de venta de cobro único; el MockProvider no expone void. El requisito
   «rechazada mientras no haya anulación verificada» se cumple porque la vía positiva
   no existe: una venta con autorización viva queda retenida sin salida operativa
   hasta que se implemente el void verificado. Hoy `authorized` no es alcanzable
   por el código (los tests lo fuerzan).
2. El audit de CI usa `pnpm@11.13.0`, que npm marca como *broken version* e ignora el
   campo `pnpm.overrides` de `package.json` (lee el lockfile resuelto). Heredado de la base.
3. Las 4 moderate (fastify <5.12.1, vitest <4.1.11) no rompen el gate (umbral High) y
   no se han aceptado ni silenciado.

## Checkpoint

Hecho: A, B, C (PR draft), D local completo salvo SBOM/grype, E pendiente del CI remoto.
Siguiente paso: leer el CI del candidato y separar fallos heredados vs. nuevos.
