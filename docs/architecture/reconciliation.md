# Estrategia de conciliación

Estado: Activo · Fase: 0 · La conciliación es obligatoria (V4 §30) y llega en Fase 4; el modelo de datos se prepara desde Fase 2.

## 1. Qué se compara

Tres planos que deben contar la misma historia:

1. **Dominio Fluvia**: payment_intents, attempts, refunds y sus FSM.
2. **Ledger**: ledger_transactions/entries y proyecciones de balance.
3. **Proveedor**: provider_transactions, provider_events y reportes (en MVP, el "reporte de liquidación" generado por el MockProvider, deliberadamente con discrepancias inyectables para probar el pipeline).

## 2. Verificaciones

- **Integridad interna continua** (desde F2, no espera a F4): balanceo por transacción y moneda (constraint diferido + script SQL externo al ORM), proyección == rebuild desde entries (drift check programado), outbox sin eventos envejecidos.
- **Cruce dominio↔ledger**: todo intent `succeeded` tiene sus asientos de captura/fees; todo refund `succeeded` tiene compensación; nada de asientos huérfanos sin objeto de dominio.
- **Cruce Fluvia↔proveedor** (batch): por referencia externa — faltantes en un lado, duplicados, diferencias de monto/moneda/fee, estados incompatibles, fechas fuera de ventana (normalización a UTC conservando la fecha cruda del proveedor), referencias desconocidas.

## 3. Casos, no parches

Cada discrepancia crea un `reconciliation_item` → `operational_case` con severidad, dueño, evidencia (payloads/asientos vinculados), estado y resolución. **Prohibida la corrección silenciosa**: todo ajuste pasa por asiento en `recon.differences` con caso, razón, actor y aprobación (four-eyes para montos sobre umbral, Nivel C).

## 4. Cadencia

- Continua: invariantes internas y drift de proyecciones (alerta < 5 min).
- Programada: batch contra reportes del proveedor (diaria en sandbox).
- Bajo demanda: por operación desde el panel admin (investigación).

Un recálculo nocturno **no** es la única defensa (V4 §30): las invariantes internas corren continuamente.

## 5. Gate Conciliación (§51)

Prueba obligatoria: archivo simulado con discrepancias conocidas → produce exactamente los casos esperados, ninguna corrección silenciosa, evidencia de resolución trazable. Implementación y evidencia en Fase 4 (F4-01/F4-02 del backlog).
