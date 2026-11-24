# Runbook · Kill switch por país o contraparte

**Disparadores**: revocación o enmienda de una licencia (p. ej. una GL de OFAC), dictamen legal desfavorable, de-risking de un socio/banco, sospecha de fraude o compromiso de un comercio, coincidencia en screening (#90). **Sev**: la decide quien ordena el corte; el corte en sí es una acción de contención, no una corrección de dinero.

**Qué es** (issue #91, migración `0068_kill_switches.sql`): un interruptor que el **motor** (PostgreSQL) hace cumplir. Con un interruptor activo, todo `INSERT` en `payment_intents`, `payment_attempts` o `payouts` que toque el objetivo, y la emisión (`requested → in_transit`) de un payout pedido antes del corte, falla con SQLSTATE `FV451`, y la API responde `403 flow_suspended` (sin revelar el motivo). Ningún servicio tiene que comprobarlo: no hay forma de saltárselo desde el código de aplicación.

| Alcance    | Objetivo                                                                      | Corta                                                                                   |
| ---------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `country`  | ISO 3166-1 alfa-2 de `merchants.country`                                      | intents, confirmaciones y payouts de comercios de ese país                              |
| `merchant` | id (uuid) del comercio                                                        | intents, confirmaciones y payouts de ese comercio                                       |
| `tenant`   | id (uuid) de la organización (`tenant_id`)                                    | todo lo anterior para **todos** sus comercios, incluidos los que cree después del corte |
| `provider` | nombre del proveedor (`payment_attempts.provider`, sin distinguir mayúsculas) | confirmaciones (attempts nuevos) y payouts por ese proveedor                            |

**Payouts pedidos antes del corte**: los que siguen en `requested` (el banco nunca fue contactado) **no** salen. Al ejecutarlos (fase 2 o redriver) pasan a `failed` con `failure_code = 'flow_suspended'` y los fondos siguen en el disponible del comercio. Tras liberar, el comercio tiene que pedirlos de nuevo. Los que ya están `in_transit`/`indeterminate` sí se resuelven: salieron antes del corte.

**Corte por comercio vs. por organización**: una organización puede crear comercios nuevos desde la API. Si el motivo es la contraparte (sanciones, fraude), corta con `--scope tenant`; `--scope merchant` sirve para un comercio puntual de una organización legítima.

**Qué NO corta, a propósito**:

- Lo que **ya está en vuelo**: webhooks del proveedor, conciliación, watchdog de indeterminados y la fase 2 de un attempt enviado antes del corte. Son hechos ocurridos fuera de Fluvia; el ledger debe reflejarlos.
- **Refunds**: devolver al pagador es la salida ordenada. Si un dictamen exige congelarlos también, es una migración nueva con decisión explícita, no un efecto colateral.
- Lecturas (GET), creación de clientes, endpoints de webhook, etc.

## Activar

Plano de plataforma (pool **admin**). Exige el **uuid del operador** y una **razón** concreta (fuente, fecha, quién lo ordena). Cada orden queda en `audit_events` como `platform.operation` de riesgo alto, en la misma transacción.

```bash
pnpm --filter @fluvia/payments-core run kill-switch -- engage --scope country --target VE --actor <uuid-operador> --reason "GL 57 revocada por OFAC el AAAA-MM-DD; orden de <responsable>"
```

- Efecto **inmediato** para toda transacción que haga `INSERT` después del commit.
- Idempotente: si ya hay uno activo para ese objetivo, responde `ALREADY ACTIVE` con el existente (la orden queda auditada igual; la razón original no se reescribe).
- `merchant` valida que el comercio exista (un uuid mal copiado sería un corte que no corta nada).

## Verificar

1. `kill-switch -- list` muestra el interruptor `ACTIVE`.
2. Un `POST /v1/payment_intents` del comercio/país afectado devuelve `403` con `error.code = "flow_suspended"`.
3. Logs de la API: `money movement blocked by kill switch` (nivel `warn`) con el id del interruptor.
4. `audit_events`: `action = 'platform.operation'` con `after_summary->>'operation' = 'kill_switch.engage'`.

## Liberar

Exige su propia razón (normalmente, la referencia del dictamen que autoriza reanudar). Una sola vez por interruptor; volver a cortar crea uno nuevo, de modo que el historial queda completo.

```bash
pnpm --filter @fluvia/payments-core run kill-switch -- release --id <uuid-interruptor> --actor <uuid-operador> --reason "Dictamen <ref> del AAAA-MM-DD autoriza reanudar"
```

Después: `kill-switch -- history --limit 20` y un cobro de prueba en sandbox del objetivo.

## Lo que este runbook no resuelve

- **Comunicación al comercio**: el `403 flow_suspended` es genérico a propósito (el motivo puede ser sensible). Avisar al comercio es una decisión de negocio/legal, no del operador.
- **`country` es el país declarado** por el comercio en el onboarding, no uno verificado: un comercio que declare otro país lo esquiva. Mientras no haya KYC que lo verifique, para contrapartes concretas usa `tenant`.
- **`merchants.status = 'frozen'`** existe en el esquema pero **no** se hace cumplir en el flujo de pagos; para suspender un comercio usa este kill switch (`--scope merchant` o `--scope tenant`).
- **Screening SDN** (#90) y **bloqueo de entidades del Gobierno/PDVSA** (#92): cuando existan, su resultado debe aplicarse con este mismo mecanismo.
