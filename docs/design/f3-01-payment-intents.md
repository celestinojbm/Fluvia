# F3-01 — Rediseño de `payment_intents` + FSM a nivel de motor (DISEÑO)

Estado: **Diseño aprobado para ejecución — NADA construido.** F3 sigue congelada por el
veredicto de la auditoría; este documento existe para descongelar F3-01 el mismo día del
veredicto favorable. Cierra la parte de diseño de **AUD-P2-002** (schema mínimo sin modelo
real) y define el meta-test que cerrará **AUD-P2-011** (FSM doc ↔ DDL sin verificación).

## 1. Problema

La tabla `payment_intents` actual (0001) es un placeholder: 5 estados planos en un CHECK,
sin merchant, sin vínculo causal con attempts/ledger, sin protección de transiciones. La
FSM normativa (`payment-state-machines.md` §1) tiene 12 estados y reglas de transición
que hoy nada hace cumplir.

## 2. Principios (heredados, no negociables)

1. **La FSM se hace cumplir EN el motor** (mismo patrón que el balanceo del ledger,
   F2-02): una transición ilegal debe ser imposible de commitear incluso con SQL crudo.
2. **Una sola fuente de verdad para las transiciones**, consumida por tres capas
   (doc, DDL, código) y verificada por meta-test — nunca tres copias que divergen.
3. Coherencia tenant a nivel de motor (patrón AUD-P1-001: FK compuestas).
4. Todo cambio de estado que mueve dinero ocurre en la MISMA transacción que su asiento
   (PostingService) y su evento de outbox. `indeterminate` jamás se resuelve por asunción
   (V4 §23).

## 3. Schema propuesto (migración 0017, se aplicará al ejecutar F3-01)

```sql
-- payment_intents se rediseña EN SITIO (la tabla actual no tiene consumidores).
ALTER TABLE payment_intents
  ADD COLUMN merchant_id UUID NOT NULL,             -- FK compuesta (id, tenant_id) a merchants
  ADD COLUMN capture_method TEXT NOT NULL DEFAULT 'automatic'
    CHECK (capture_method IN ('automatic', 'manual')),
  ADD COLUMN amount_captured BIGINT NOT NULL DEFAULT 0 CHECK (amount_captured >= 0),
  ADD COLUMN amount_refunded BIGINT NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN expires_at TIMESTAMPTZ,                -- TTL Nivel C para estados pre-confirmación
  ADD COLUMN failure_code TEXT;                     -- del catálogo de errores, no texto libre
-- status: CHECK regenerado con los 12 estados de payment-state-machines.md §1;
-- default 'created'. CHECK adicional: amount_refunded <= amount_captured <= amount.

CREATE TABLE payment_intent_transitions (           -- fuente de verdad EN la base
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
-- Seed: exactamente los pares del doc §1. Trigger BEFORE UPDATE OF status en
-- payment_intents: (OLD.status, NEW.status) debe existir en la tabla o
-- RAISE 'FLUVIA_INVALID_TRANSITION'. FORCE RLS no aplica (tabla de referencia,
-- solo lectura para roles de runtime; INSERT/UPDATE/DELETE de nadie).

CREATE TABLE payment_attempts (                     -- uno por intento real contra proveedor
  id, tenant_id, intent_id (FK compuesta con tenant), provider TEXT,
  provider_ref TEXT, status TEXT (FSM §2, 8 estados, misma mecánica de tabla
  de transiciones), amount BIGINT, last_error TEXT, submitted_at, resolved_at,
  UNIQUE (intent_id, attempt_number)
);
```

Inmutabilidad: ambas tablas con no_delete/no_truncate (clase financiera); `version`
optimista ya existe en `payment_intents` y se conserva.

## 4. Código (paquete nuevo `@fluvia/payments-core`)

- `INTENT_TRANSITIONS: Record<IntentStatus, IntentStatus[]>` y
  `ATTEMPT_TRANSITIONS: …` — mapas declarativos, ÚNICA copia en TS.
- La migración 0017 NO escribe los pares a mano: el seed SQL se genera desde el mapa TS
  (script `gen-fsm-seed.ts`, mismo patrón que el golden del catálogo de errores) y el
  resultado queda versionado en la migración. Cambiar la FSM = cambiar el mapa TS +
  regenerar + migración nueva.
- `PaymentIntentService.transition(intentId, to, ctx)`: SELECT … FOR UPDATE, valida
  contra el mapa TS (feedback rápido), UPDATE (el trigger re-valida al commit), asiento
  contable si aplica, evento de outbox — todo en una transacción.

## 5. Meta-test (cierra AUD-P2-011)

Tres comparaciones en un test permanente (`packages/payments-core/test/fsm-meta.test.ts`):

1. **Doc ↔ TS**: parsea las líneas `A --> B` del mermaid de
   `payment-state-machines.md` §1/§2 y exige igualdad EXACTA con los mapas TS
   (ni transiciones de más ni de menos).
2. **TS ↔ DDL**: `SELECT from_status, to_status FROM payment_intent_transitions`
   == mapa TS.
3. **Motor**: para CADA par (estado, estado) NO permitido, un UPDATE crudo como
   superusuario debe fallar con `FLUVIA_INVALID_TRANSITION` (matriz completa,
   mismo estilo que los tests de balanceo F2-02).

## 6. Qué NO entra en F3-01

- Endpoints públicos (F3-02, con la capa de idempotencia F2-09 ya lista).
- Checkout, MockProvider, webhooks (F3-03+; siguen congelados).
- Disputas y settlement (F4+). `partially_captured`/`refunded` entran en el schema y la
  FSM desde el día 1 para no migrar estados después, aunque la API los exponga más tarde.

## 7. Estimación y criterio de terminado

Talla M. CA: migración 0017 ×2 sobre PG fresco; matriz FSM completa probada a nivel
motor; meta-test doc↔TS↔DDL verde; `payment_intents` legacy sin datos (verificado antes
de regenerar el CHECK); cero endpoints nuevos.
