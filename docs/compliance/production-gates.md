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

### Gate Multi-tenant — 🟡 (parcial)
- [x] Tenant A no lee ni escribe datos de Tenant B vía RLS (tests del spike: lectura, escritura, PK directa)
- [x] Pool de conexiones no fuga contexto (patrón SET LOCAL transaction-scoped + test "sin contexto = 0 filas")
- [ ] Autorización de aplicación (RBAC) activa (F1-04)
- [ ] Tests de bypass administrativo (F1-06)
- [ ] Suite ampliada de tenant escape en CI (F1-06)

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
