# ADR-0004 — Ledger interno reducido

Estado: Aceptado · Fase 0 · Comparación completa en `../references/formance-ledger-assessment.md`

## Contexto
V4 §10.2 exige comparar Formance Ledger como servicio contra un ledger interno reducido.

## Decisión
Ledger interno: tablas propias (`ledger_accounts/transactions/entries` + `balance_projections`) en la misma base que el dominio, con posting según `../architecture/ledger-design.md`.

## Razón decisiva
Atomicidad **dominio + ledger + outbox en una sola transacción SQL**. Con un ledger externo, cada pago requeriría coordinación distribuida (dos fuentes de verdad, sagas, reconciliación adicional interna) — la clase de complejidad que V4 §11 manda evitar.

## Alternativas
Formance como servicio (rechazado por lo anterior; candidato de extracción futura), Formance embebido como librería (no es su modelo), TigerBeetle (rechazado: modelo de cuentas de alto rendimiento pero otra frontera operativa y sin RLS/tenancy propio).

## Consecuencias
+ Transaccionalidad total, RLS uniforme, evidencia auditable local. − Debemos mantener la corrección contable nosotros: mitigado con alcance pequeño (13 cuentas plantilla), constraint diferido de balanceo, property tests y script de invariantes externo (Gate Ledger).

## Criterio de reevaluación
Volumen de posting sostenido que degrade la base transaccional, o necesidad contable (multi-libro, agregaciones complejas) fuera de nuestro alcance → evaluar extracción con migración de esquema documentada.
