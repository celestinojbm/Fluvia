# ADR-0008 — Money Value Object propio sobre bigint

Estado: Aceptado · Fase 0

## Contexto
V4 §16 prohíbe float y exige un VO Money con validación por moneda, sin imponer librería. V3 sugería `dinero.js`.

## Decisión
Implementación propia (`@fluvia/money`): `bigint` en unidades menores + registro de monedas con exponente ISO-4217, inmutable, operaciones same-currency, `fromDecimal` sin redondeo silencioso (`PrecisionError`), `allocate` por mayor residuo (ni pierde ni crea unidades), serialización como string, schema Zod `.strict()`.

## Alternativas
- dinero.js v2 (rechazado: dependencia externa a auditar para un dominio que `bigint` nativo resuelve; su API genérica de "calculadoras" añade superficie sin beneficio aquí).
- big.js/decimal.js (rechazado: decimales arbitrarios invitan a montos no enteros; el dominio es unidades menores enteras).
- NUMERIC en BD + number en app (rechazado: number pierde precisión > 2^53 y reintroduce float en el borde).

## Consecuencias
+ Cero dependencias, semántica exacta del dominio, imposible mezclar monedas u operar floats por diseño de tipos. − Mantenemos nosotros el registro de monedas (pequeño y testeado); FX futuro requiere modelo aparte (ya previsto §16).

## Evidencia
Spike: 21 tests unitarios verdes (precisión, exponente 0, allocate sin pérdida, round-trip JSON > 2^53, strict schema anti mass-assignment).
