# Evaluación: Formance Ledger (formancehq/ledger)

Estado: Activo · Fase 0 · Licencia: históricamente MIT; Formance ha evolucionado su licenciamiento por componentes — **verificación obligatoria antes de cualquier adopción** (F0-VER). Lenguaje: Go.

## Problema que resuelve
Ledger de doble partida como servicio: API de transacciones balanceadas, scripting (Numscript), multimoneda, agregación de balances.

## Comparación exigida (§10.2): usarlo como servicio vs. ledger interno reducido

| Dimensión | Formance como servicio | Ledger interno (elegido) |
|-----------|------------------------|--------------------------|
| Consistencia | Transacción distribuida app↔ledger (dos commits; requiere sagas/outbox extra para atomicidad con dominio) | **Misma transacción SQL** que el dominio, outbox y RLS |
| Multi-tenant | Namespacing propio; RLS de Fluvia no aplica dentro | RLS uniforme en toda la base |
| Complejidad operativa | +1 servicio, +1 esquema, +1 superficie de fallas y upgrades | Cero servicios nuevos |
| Capacidades | Muy superior (Numscript, agregaciones, madurez de casos borde) | Reducidas al Chart of Accounts propio |
| Latencia | Salto de red por posting | Local a la transacción |
| Costo de salida | Datos contables en formato de terceros | Esquema propio y simple |
| Auditoría/idempotencia | Buenas, del lado del servicio | Bajo nuestras invariantes y triggers verificables |

**Decisión (ADR-0004): ledger interno reducido.** La razón decisiva es la atomicidad dominio+ledger+outbox en una sola transacción Postgres: elimina la clase entera de inconsistencias distribuidas que el V4 (§11) manda evitar. Formance queda como candidato de **extracción futura** si el volumen o las necesidades contables lo justifican; nuestro modelo (transactions/entries balanceadas por moneda, append-only) es conceptualmente compatible para una migración.

## Qué adoptar como inspiración
- Invariante de balanceo por transacción y activo (idéntico al nuestro).
- Idea de "dry-run" de posting para previsualizar asientos (útil en el panel admin, Fase 4).
- Su disciplina de API de reversión con referencia al asiento original.

## Riesgos de la decisión
Nuestro ledger tendrá menos casos borde resueltos → mitigado con property-based tests y el script de invariantes externo (Gate Ledger), y manteniendo el alcance contable pequeño (13 cuentas plantilla).
