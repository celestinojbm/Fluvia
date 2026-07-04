# ADR-0001 — Monolito modular en TypeScript

Estado: Aceptado · Fase 0 · Nivel B del prompt V4 (default confirmado)

## Contexto
Fluvia necesita transacciones atómicas entre dominio, ledger y outbox; el equipo constructor es pequeño y el volumen inicial es sandbox.

## Decisión
Un monolito modular en TypeScript (paquetes de dominio en un monorepo pnpm/Turborepo) desplegado como `api` + `worker` (+ frontends Next.js). Los módulos se comunican por interfaces importadas, no por HTTP interno.

## Alternativas
Microservicios (rechazado: transacciones distribuidas exactamente donde más duele — dinero); serverless (rechazado: workers de polling y transacciones largas de migración encajan mal); Rust/Go (rechazado para v1: velocidad del equipo y ecosistema compartido front/back priman; reevaluable por módulo con evidencia de rendimiento).

## Consecuencias
+ Atomicidad simple, refactors baratos, un solo pipeline. − Disciplina de límites entre módulos necesaria (revisión en PR + regla "cada paquete posee sus tablas").

## Riesgos
Acoplamiento gradual → mitigado con la regla de acceso por interfaz y tests por paquete. Extracción futura de webhook-delivery o ledger si el volumen lo exige (criterios en V4 §11).

## Evidencia
Monorepo operativo (spike); build/test por paquete funcionando.
