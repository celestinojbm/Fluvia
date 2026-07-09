# Runbook · Restore de backup (recuperación de desastre)

**Cuándo**: pérdida/corrupción de la base primaria, promoción de una copia a un entorno nuevo, o el **drill periódico** de recuperación. **Sev**: SEV-1 si es una recuperación real (integridad financiera en juego).

**Qué significa**: toda la verdad financiera de Fluvia vive en Postgres (ledger append-only + proyecciones + auditoría). Un backup solo vale si **se ha probado restaurarlo** y el ledger restaurado pasa las invariantes fuera del código de la app. Este runbook cubre el procedimiento y el criterio de la **Fase 6 · Gate Restore** (`production-gates.md`): «Backup restaurado + ledger verificado + proyecciones reconstruidas + conciliación post-restore».

## Estrategia de backup

| Aspecto                                                | Estado                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Backup lógico** (`pg_dump -Fc`)                      | ✅ probado en drill (formato custom, restaurable con `pg_restore`; incluye esquema, datos, GRANTs y políticas RLS) |
| **Cadencia / retención / cifrado en reposo / offsite** | 🔵 DISEÑO — decisión de infraestructura de despliegue (F6/F7); no se simula aquí                                   |
| **PITR / WAL archiving** (RPO→segundos)                | 🔵 DISEÑO — F6/F7; el backup lógico da RPO = «último dump»                                                         |

> El drill usa un backup **lógico** consistente: su RPO es el instante del `pg_dump`. Para RPO cercano a cero en producción se añade WAL archiving/PITR (decisión de F6/F7); el criterio de Gate Restore (restaurar + verificar + reconstruir) es idéntico para ambos.

## Diagnóstico (recuperación real)

1. **Confirma el alcance**: ¿corrupción lógica (una tabla, un tenant) o pérdida total de la instancia? La corrupción de datos financieros JAMÁS se «arregla» con SQL manual (V4 §30) — se restaura de un backup íntegro.
2. **Elige el backup**: el más reciente cuya integridad esté verificada. Nunca restaures a ciegas sobre la primaria; restaura a una base/instancia **nueva** y verifícala antes de promoverla.
3. **Los roles son globales del cluster** (`fluvia_app`/`fluvia_worker`/…): un `pg_dump` a nivel de base restaura GRANTs y políticas que los referencian, pero los roles deben existir en el cluster destino (los crea `migrate`/`0002`).

## Resolución

1. **Restaura a una base fresca** (nunca sobre la primaria):
   ```bash
   createdb -O postgres fluvia_restored
   pg_restore --no-password -d "$ADMIN_URL_restored" backup.dump
   ```
2. **Verifica el ledger sobre la copia, fuera del ORM** (el corazón del gate):
   ```bash
   psql "$ADMIN_URL_restored" -v ON_ERROR_STOP=1 -f scripts/verify-ledger-invariants.sql
   # → NOTICE FLUVIA_INVARIANTS_OK  (o EXCEPTION FLUVIA_INVARIANT_VIOLATION con el detalle)
   ```
   Cualquier violación ⇒ el backup está corrupto o incompleto: NO lo promuevas; elige otro.
3. **Reconstruye proyecciones si hiciera falta**: si una proyección quedó fuera de sincronía (o se restauró un backup sin ellas), `LedgerService.rebuildProjection(tenantId, accountId)` las re-materializa desde los asientos — reparación **EXPLÍCITA**, nunca automática (V4 §30). El ledger (append-only) es la fuente; las proyecciones son derivables.
4. **Conciliación post-restore**: corre la conciliación del/los periodo(s) afectado(s) contra el settlement report del proveedor ([`reconciliation-discrepancy.md`](./reconciliation-discrepancy.md)) para confirmar que la copia restaurada cuadra con la realidad externa antes de promoverla.
5. **Promueve** la copia verificada (repunta la app a la nueva base) y **retira** la corrupta de rotación.

## Verificación

1. `FLUVIA_INVARIANTS_OK` sobre la copia restaurada (asientos balanceados por tx, proyecciones == recompute, sin drift).
2. Paridad con la fuente cuando aplique (conteos + Σamount), y saldos de control conocidos exactos.
3. La copia conserva **RLS FORZADO** + políticas por-tenant (el backup preserva el aislamiento, no solo los datos).
4. La app arranca contra la copia con los roles de mínimo privilegio (`/health` + `/ready`).

## Escalación

- Invariantes rotas en TODOS los backups disponibles → incidente de integridad mayor: congelar escritura, involucrar al owner; la corrupción no se parchea a mano.
- Restore correcto pero conciliación post-restore con discrepancias → seguir [`reconciliation-discrepancy.md`](./reconciliation-discrepancy.md) (four-eyes para cualquier ajuste de dinero).

## Drill (F6 · Gate Restore)

✅ **Ejecutado — PASS 7/7** (`pnpm --filter @fluvia/api run drill:restore`, `apps/api/drills/restore-drill.ts`). Ensaya el procedimiento completo contra un Postgres 16 real:

1. Siembra un **estado contable conocido** (captura → asientos + proyección + transacción), toma un snapshot de la fuente (conteos + Σamount + saldo del marcador + **checksums row-level** de asientos y transacciones) y confirma `FLUVIA_INVARIANTS_OK` en la fuente (sanity).
2. **Backup** con `pg_dump -Fc`; `pg_restore --list` prueba que el archivo es legible e incluye las tablas del ledger.
3. **Restore** en una base FRESCA (`fluvia_restore_drill`) con `pg_restore --exit-on-error` y `code === 0` **asserteado** — un restore PARCIAL falla el drill, no pasa como verde; sin tocar la fuente.
4. **Ledger verificado** sobre la copia: `verify-ledger-invariants.sql` → `FLUVIA_INVARIANTS_OK` (auditoría fuera del ORM).
5. **Paridad** fuente↔copia: conteos de `ledger_entries`/`ledger_accounts`/`balance_projections`/`ledger_transactions` + Σamount + saldo del marcador, **y checksums row-level** (`md5(string_agg(row::text ORDER BY id))`) de asientos y transacciones — detectan pérdida de filas o corrupción de valores que preservaría los agregados (RPO = 0 para el dump lógico).
6. **Proyecciones reconstruibles**: se inyecta drift en la copia → las invariantes lo **DETECTAN** (no falso-verde) → `rebuildProjection` (rol `fluvia_app`, explícito) → invariantes verdes de nuevo.
7. **Postura de seguridad preservada**: RLS FORZADO en 3/3 tablas core + políticas por-tenant restauradas.

Cubre los cuatro sub-criterios del Gate Restore (restaurado + verificado + proyecciones reconstruidas + base para conciliación post-restore) y limpia la base de restore al terminar. **A diferencia de los demás drills, este se EJECUTA en CI** (job `quality`, tras la suite, sobre la BD poblada por los tests — una copia realista; con un paso previo que asegura `pg_dump 16+`): el Gate Restore queda verificado por commit, no solo local (TM-04). Requiere las herramientas cliente `pg_dump`/`pg_restore`/`psql` y un Postgres migrado.
