# Production Gates

Estado: Activo · Ningún entorno de Fluvia puede declararse "producción" sin completar los gates aplicables (V4 §51). Este documento es el checklist de evidencia; cada ítem enlazará a su prueba cuando exista.

## Estado global: 🔴 PRE-PRODUCCIÓN (Fase 0)

## 1. Gates técnicos mínimos

### Gate Ledger — 🔴
- [ ] Cada transacción balancea por activo (constraint diferido + tests) — diseño F2-02
- [x] *Precursor:* inmutabilidad de asientos a nivel motor verificada (spike, tests `FLUVIA_IMMUTABLE`)
- [ ] Scripts externos al ORM verifican invariantes (F2-06)
- [ ] Rebuild de proyección == ledger (F2-05)
- [ ] Compensaciones funcionan (F2-07)
- [ ] Concurrencia sin duplicados ni drift (F2-08)

### Gate Multi-tenant — 🟢 técnico (revisión formal en Fase 6)
- [x] Tenant A no lee ni escribe datos de Tenant B vía RLS (lectura, escritura por PK, UPDATE masivo, INSERT…SELECT, JOINs, sondas EXISTS, agregados — `tenant-escape.test.ts`)
- [x] Pool de conexiones no fuga contexto (test explícito de la MISMA conexión a través de transacciones A → sin contexto → B)
- [x] Autorización de aplicación (RBAC) activa con matriz verificada celda a celda (F1-04c)
- [x] Tests de bypass administrativo: `withPlatformOperation` exige razón, audita en la misma transacción (riesgo alto) y hace rollback conjunto (F1-06)
- [x] Suite ampliada de tenant escape en CI, incluidos **meta-tests estructurales** que verifican en `pg_catalog` que TODA tabla (presente o futura) con `tenant_id` tiene RLS forzado + política, que ningún rol de runtime tiene DELETE y que app/worker no tienen privilegio alguno sobre credenciales (F1-06)
- Nota de límite documentado: RLS defiende contra bugs de lógica, no contra ejecución de SQL arbitrario con el rol app (ver `architecture/multi-tenancy.md` §7); mitigación = consultas 100% parametrizadas + revisión Fase 6.

### Gate Idempotencia — 🔴 (diseñado)
- [ ] Mismo key + mismo payload → mismo resultado (F2-09)
- [ ] Mismo key + payload distinto → rechazado (F2-09)
- [ ] Crash recovery no duplica (F2-10)
- [ ] Pérdida de Redis no duplica (F2-10)

### Gate Conciliación — 🔴
- [ ] Archivo simulado produce discrepancias detectadas (F4-02)
- [ ] Casos creados, sin corrección silenciosa, evidencia de resolución (F4-03)

### Gate Seguridad — 🔴
- [ ] Sin High/Critical sin aceptación explícita; secret/dependency scanning; threat model actualizado; pruebas SSRF y tenant escape (F1-02, F3, F6)

### Gate Restore — 🔴
- [ ] Backup restaurado + ledger verificado + proyecciones reconstruidas + conciliación post-restore (F6)

## 2. Gates organizacionales y regulatorios (todos 🔴, requieren humanos)

Jurisdicción definida (PEND-001) · revisión legal · contrato con proveedor · ToS · privacy policy · refund policy · KYC/KYB · AML · sanciones · evaluación PCI aplicable · incident response operativo · on-call · monitoring y alertas · reconciliation operativa · load tests · rotación de secretos · gestión de vulnerabilidades · merchant freeze · pending payment procedure · política de retención · access matrix · payout review · procedimiento de disputas · procedimiento de fraude · soporte operativo · plan de continuidad · repositorio de evidencia · revisión de aislamiento · validación de ledger · revisión de idempotencia · certificación con proveedor · separación sandbox-producción.

**Regla operativa:** este archivo se actualiza en el mismo PR que aporta la evidencia de cada ítem; marcar un ítem sin enlace a evidencia es una violación de gobernanza (§2 "no declarar capacidades inexistentes").
