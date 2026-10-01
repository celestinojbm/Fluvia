# Fluvia integral — especificación común (comercio, wallet, crédito, tarjetas y operación)

Estado: **sandbox, en construcción** en la rama `claude/jornada-integral-wallet-credito` (draft PR contra `claude/jornada-bolivares-diseno`, HEAD de partida `c5384dd`). Sin proveedores financieros reales, sin emisión real, sin dinero real. Esta especificación se registró **antes** de ampliar el código y es el contrato que siguen migraciones, servicios, API y pantallas. El backlog vivo está en [`BACKLOG.md`](BACKLOG.md).

> Fluvia no es banco, emisor, adquirente, financiador ni custodio. Todo lo descrito funciona con **adaptadores simulados** y **políticas de referencia sintéticas**. Ninguna cifra de este documento (multiplicador, inicial, tasas, plazos) es una condición comercial: son parámetros configurables pendientes de validación comercial y regulatoria.

## 1. Base reutilizada (inspección del HEAD `c5384dd`)

| Pieza existente                                                         | Cómo se reutiliza                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@fluvia/ledger` (doble partida, idempotencia, guard de no negatividad) | Fuente de verdad de wallet, garantía y deuda: se amplía el catálogo de cuentas con un ámbito `consumer` |
| RLS forzado por `tenant_id` + `withTenantTransaction`                   | Aislamiento por organización; se añade un segundo contexto `app.consumer_id` (aislamiento por cliente)  |
| `@fluvia/auth` (scrypt, sesiones, step-up) e `@fluvia/identity` (RBAC)  | Comercio y operador siguen en el plano de sesión; el consumidor tiene credenciales y sesiones propias   |
| `@fluvia/audit` (append-only, redacción)                                | Toda acción sensible de operación y del consumidor                                                      |
| `@fluvia/idempotency`                                                   | `Idempotency-Key` en toda escritura de la API nueva                                                     |
| `PaymentProvider` (`payments-core`)                                     | Punto de enganche del comercio: un proveedor de enrutamiento manda los tokens `fcp_` al emisor Fluvia   |
| Checkout, pedidos, existencias, cuotas simuladas (`0049`–`0051`)        | Intactos. La «simulación de cuotas» del comercio conserva su naturaleza (no toca ledger)                |

## 2. Superficies

| Superficie             | Quién                                                 | Autenticación                                                                                     | Dónde                                     |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Fluvia Comercios**   | Miembros de una organización comercio                 | Sesión de dashboard (`fluvia_sess_`), rol por organización                                        | `apps/dashboard` `/o/[orgId]/…` (existe)  |
| **Fluvia Personal**    | Clientes (consumidores) del programa                  | **Credenciales y sesiones propias** (`fluvia_csess_`), tabla `consumers` separada de `users`      | `apps/dashboard` `/personal/…`            |
| **Fluvia Operaciones** | Miembros de la organización **programa** con permisos | Sesión de dashboard + permisos `program:*` + **step-up** en acciones sensibles + doble aprobación | `apps/dashboard` `/operaciones/[orgId]/…` |

Decisión: las tres superficies comparten la app Next.js (`apps/dashboard`) con **layouts, navegación y sesión distintos**, para no duplicar el BFF, la CSP y los componentes base. Una sesión de consumidor nunca alcanza rutas de comercio u operación (prefijo de token distinto, guardas distintas en la API) y viceversa.

## 3. Organización programa (tenancy)

- El programa de consumo (wallet, crédito y tarjetas) pertenece a una **organización programa** (`consumer_programs.tenant_id`). Sus clientes, cuentas, líneas, tarjetas y casos viven en ese tenant (RLS forzado).
- Dentro del programa, cada fila de cliente lleva `consumer_id`. La política RLS exige `tenant_id = app.tenant_id` **y**, cuando la transacción fija `app.consumer_id`, `consumer_id = app.consumer_id`. El plano del consumidor **siempre** lo fija; el de operación no.
- Un comercio es otra organización. La compra cruza organizaciones **solo** por el contrato de red (§8): el comercio nunca lee datos del programa y el programa nunca escribe en el tenant del comercio.

## 4. Entidades

| Entidad                                    | Tabla                                       | Notas                                                                                      |
| ------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Programa                                   | `consumer_programs`                         | Moneda(s) habilitada(s), proveedor emisor y de fondeo configurados, política activa        |
| Cliente                                    | `consumers`                                 | Email, nombre, estado (`active`, `suspended`, `closed`), `synthetic` = true en sandbox     |
| Credenciales y sesiones del cliente        | `consumer_credentials`, `consumer_sessions` | Solo rol `fluvia_auth`; token guardado como hash                                           |
| Ingreso de fondos                          | `wallet_fundings`                           | `pending → confirmed / failed`; único por `(provider, provider_ref)`                       |
| Transferencia / retiro                     | `wallet_transfers`                          | P2P dentro del programa y retiro simulado con estado incierto                              |
| Garantía                                   | `collateral_movements`                      | Bloqueo / liberación / aplicación; el saldo vive en el ledger                              |
| Política de crédito                        | `credit_policies`                           | Versionada, `draft → active → retired`, parámetros validados; `is_reference`, `synthetic`  |
| Solicitud                                  | `credit_applications`                       | `submitted → approved / rejected / manual_review → approved / rejected`; explicación JSON  |
| Línea de crédito                           | `credit_lines`                              | Una por cliente y moneda; límite aprobado; `active / frozen / closed`                      |
| Tarjeta                                    | `cards`                                     | Virtual o física; `last4` simulado, **nunca PAN ni CVV**; estado y límites                 |
| Envío de tarjeta física                    | `card_shipments`                            | `requested → produced → shipped → delivered / returned`                                    |
| Código de pago                             | `card_payment_tokens`                       | Token de red de un solo uso (`fcp_…`), hash en BD, caduca; lleva la oferta aceptada        |
| Autorización                               | `card_authorizations`                       | Reparto saldo propio / crédito, reservas, capturas, reversos, devoluciones                 |
| Movimiento de autorización                 | `card_authorization_events`                 | Captura, reverso, devolución, con clave de idempotencia                                    |
| Compra financiada y plan                   | `credit_plans`, `credit_installments`       | Calendario exacto, inicial, versión de condiciones aceptadas                               |
| Pago de cuota                              | `credit_repayments`                         | Desde la wallet; aplicado a cuotas por orden                                               |
| Evento del proveedor                       | `program_provider_events`                   | Fondeo, emisor y red; dedup por `(source, event_id)`; fuera de orden tolerado              |
| Caso operativo                             | `program_cases`                             | Incierto, discrepancia, incidencia de cliente, aplicación de garantía                      |
| Operación del proveedor simulado (externo) | `sandbox_provider_operations`               | Estado «externo» del proveedor simulado para que la consulta de resultados sea verificable |

## 5. Ledger del programa

Nuevas cuentas en el catálogo cerrado (`chart-of-accounts.ts`), ámbito `consumer` (una por cliente y moneda, nombre `code:consumerId`) y `platform`:

| Código                           | Ámbito   | Tipo      | Lado   | Significado                                                                |
| -------------------------------- | -------- | --------- | ------ | -------------------------------------------------------------------------- |
| `consumer.wallet.available`      | consumer | liability | credit | Dinero propio del cliente, disponible                                      |
| `consumer.wallet.held`           | consumer | liability | credit | Dinero propio reservado por autorizaciones/transferencias en curso         |
| `consumer.collateral`            | consumer | liability | credit | Dinero propio bloqueado como garantía (sigue siendo del cliente)           |
| `consumer.credit.receivable`     | consumer | asset     | debit  | Deuda del cliente con el programa (principal dispuesto)                    |
| `program.funding.clearing`       | platform | asset     | debit  | Fondos recibidos del proveedor de fondeo, pendientes de liquidar a caja    |
| `program.network.payable`        | platform | liability | credit | Obligación con la red/adquirente por compras capturadas (pago al comercio) |
| `program.withdrawals.in_transit` | platform | liability | credit | Retiros enviados al banco del cliente, aún sin confirmar                   |

Reglas de posting (catálogo cerrado; nada fuera de él es representable):

```
funding.confirm X         D program.funding.clearing     / C consumer.wallet.available
transfer.p2p X            D wallet.available(origen)     / C wallet.available(destino)
withdrawal.emit X         D wallet.available             / C program.withdrawals.in_transit
withdrawal.settle X       D withdrawals.in_transit       / C program.funding.clearing
withdrawal.fail X         D withdrawals.in_transit       / C wallet.available
collateral.lock X         D wallet.available             / C consumer.collateral
collateral.release X      D consumer.collateral          / C wallet.available
collateral.apply X        D consumer.collateral          / C consumer.credit.receivable   (aplicación a deuda vencida, manual y auditada)
auth.hold W               D wallet.available             / C wallet.held                  (parte de saldo propio)
auth.release W            D wallet.held                  / C wallet.available
capture.wallet W          D wallet.held                  / C program.network.payable
capture.credit C          D consumer.credit.receivable   / C program.network.payable      (el crédito NUNCA pasa por la wallet)
refund.wallet W           D program.network.payable      / C wallet.available
refund.credit C           D program.network.payable      / C consumer.credit.receivable
repayment X               D wallet.available             / C consumer.credit.receivable
```

Guardas: toda cuenta que decrece se declara `nonNegativeAccounts` (bajo lock). Consecuencias: no se gasta saldo ajeno a la reserva, no se libera más garantía que la bloqueada, no se reduce la deuda por debajo de cero.

**Crédito disponible** = `límite aprobado − deuda (ledger) − reservas de crédito vivas` calculado **en el servidor, dentro de la transacción y bajo `FOR UPDATE` de la línea**. Las reservas de crédito no son dinero (no hay asiento hasta la captura): son filas de `card_authorizations` con `credit_held > 0`. El navegador nunca calcula disponibilidad.

## 6. Monedas

VES y las monedas ya soportadas por `@fluvia/money`. Cada fila monetaria lleva `currency`; una línea de crédito, una tarjeta y una autorización tienen **una** moneda; no se suman monedas ni hay conversión. Una compra en una moneda sin línea/saldo en esa moneda se rechaza (`currency_not_supported`).

## 7. Garantía, elegibilidad y crédito

### 7.1 Política versionada

`credit_policies.params` (validado con Zod; ejemplo de la **política de referencia `ref-sandbox` v1**, sintética):

| Parámetro                     | Referencia                     | Nota                                                                                     |
| ----------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `maxMultiplierBps`            | 40000 (×4)                     | **Máximo ilustrativo**; el límite real lo fija el nivel de riesgo                        |
| `tiers`                       | A ×4 · B ×3 · C ×2 · D rechazo | Nivel de riesgo derivado de datos **sintéticos declarados** + historial interno          |
| `minCollateral` / `maxLimit`  | por moneda                     |                                                                                          |
| `manualReviewAbove`           | por moneda                     | Solicitudes por encima ⇒ revisión manual                                                 |
| `installmentCounts`           | 1, 3, 6                        |                                                                                          |
| `intervalDays`                | 30                             |                                                                                          |
| `downPaymentBps`              | 2500 (25 %)                    | Inicial con saldo propio en compras en cuotas                                            |
| `interestBps`, `lateFee`      | 0                              | **Pendiente de validación comercial**: el motor admite valores, la referencia no los usa |
| `graceDays`                   | 5                              | Días tras el vencimiento antes de marcar «vencida»                                       |
| `collateralApplication`       | `manual_operator`              | Aplicación de garantía solo por operador con doble aprobación                            |
| `pendingCommercialValidation` | true                           | Se muestra en pantallas de operación y personal                                          |

Activar una versión requiere permiso `program:credit_manage`, step-up y **una segunda persona** (aprobador ≠ autor). Solo una versión activa por programa.

### 7.2 Solicitud y evaluación

1. El cliente solicita una línea en una moneda con un límite deseado.
2. El motor evalúa con la política activa y registra entradas, reglas aplicadas, resultado y **explicación legible** (`reasons[]`). Nunca verifica ingresos, identidad ni buró: en sandbox el «perfil de riesgo» es un dato sintético declarado y así se muestra.
3. Límite propuesto = `min(solicitado, garantía bloqueada × multiplicador del nivel, maxLimit)`. Nivel D o garantía < mínimo ⇒ rechazo. Por encima de `manualReviewAbove` ⇒ `manual_review` (cola de Operaciones).
4. Aprobación ⇒ crea o actualiza la línea (`credit_lines`), auditado. Recargar la wallet **no** amplía el crédito: el límite solo cambia por una nueva evaluación o por un operador (auditado, step-up).

### 7.3 Garantía

- La garantía es **dinero propio bloqueado**, no un pago. Nunca se consume automáticamente como inicial ni como cuota.
- Garantía requerida = `ceil(exposición × 10000 / multiplicadorBps)`, con exposición = deuda + reservas de crédito. **Liberar** solo se permite si tras liberar la garantía sigue cubriendo la exposición; además el límite aprobado se reduce a `garantía restante × multiplicador` (nunca por debajo de la exposición). Todo bajo lock de la línea.
- **Aplicación** a deuda vencida: solo por operador, con motivo, doble aprobación y caso asociado (`collateral.apply`). Configurable (`collateralApplication`), pendiente de validación comercial.

### 7.4 Deuda y vencimientos

Una compra capturada con crédito crea un `credit_plan` con calendario (`Money.allocate`: Σ cuotas = principal exacto). Estados de cuota: `scheduled → paid / partially_paid / overdue / cancelled`. «Vencida» se marca por un proceso explícito con fecha de corte (no por el paso del tiempo en lectura). Mora e intereses: 0 en la referencia (pendiente).

## 8. Tarjetas y red

### 8.1 Adaptador de emisión

```ts
interface CardIssuerAdapter {
  name: string;
  issueCard(input: {
    cardId;
    consumerRef;
    form: 'virtual' | 'physical';
    currency;
  }): Promise<{ issuerRef; last4; expMonth; expYear }>;
  setCardState(input: { issuerRef; state: 'active' | 'blocked' | 'closed' }): Promise<void>;
  createRevealSession(input: {
    issuerRef;
  }): Promise<{ mode: 'iframe' | 'unavailable'; url: string | null; expiresAt: string | null }>;
  requestShipment(input: { issuerRef; address }): Promise<{ shipmentRef }>;
}
```

`SimulatedCardIssuer`: genera `last4` y referencias opacas; **no genera números de tarjeta** (ni PAN completo ni CVV en ninguna capa). `createRevealSession` devuelve `unavailable` en sandbox: la UI muestra el componente seguro con el aviso «los datos sensibles los mostrará el emisor en su componente seguro». Un emisor real implementa el mismo contrato (iframe/SDK del proveedor, PCI fuera de Fluvia).

### 8.2 Ciclo de vida

`requested → active` (virtual: al emitir; física: `inactive` hasta **activación** tras entrega) · `active ⇄ blocked` (cliente u operador) · `replaced` (al reemplazar se emite una nueva y la anterior queda `replaced`) · `closed` (terminal; requiere sin autorizaciones vivas). Límites por tarjeta: por operación y por día (moneda de la tarjeta).

### 8.3 Autorización: cómo se elige la fuente

Entrada: tarjeta, importe, moneda, comercio, `network_ref` (idempotencia de red) y, si viene de un código de pago, la oferta aceptada.

1. Bloqueos: tarjeta `active`, cliente `active`, moneda de la tarjeta, límites de la tarjeta (operación y día, contando autorizaciones vivas y capturadas del día).
2. Reparto según modo:
   - **Código de pago «saldo»** o tarjeta en modo `wallet_only`: todo de saldo propio.
   - **Código de pago «cuotas»**: inicial = `ceil(importe × downPaymentBps / 10000)` de saldo propio; resto de crédito.
   - **Tarjeta en modo `wallet_first`** (por defecto, compras sin código): saldo propio hasta lo disponible; el resto de crédito (plan de 1 cuota).
   - Modo `credit_only`: todo crédito.
3. Bajo lock de la línea de crédito y con el guard del ledger: reserva de saldo (`auth.hold`) y reserva de crédito (fila). Si cualquiera no alcanza ⇒ **rechazo** `insufficient_funds` / `credit_limit_exceeded` sin efectos.
4. Respuesta `approved` con `authorization_id`. Mismo `network_ref` ⇒ misma respuesta (replay).

**Captura** (total o parcial, varias capturas hasta el importe autorizado): consume primero la parte de crédito o la de saldo **en la proporción del reparto** (la inicial se captura primero). Lo no capturado se libera con **reverso** o al expirar (proceso explícito). **Devolución** (parcial/total, nunca más que lo capturado neto): devuelve primero al **crédito** (reduce deuda y cuotas desde la última) y luego al saldo propio. Todas las operaciones son idempotentes por clave.

### 8.4 Compra en un comercio Fluvia (cruce de organizaciones)

1. En Fluvia Personal el cliente elige «Pagar en comercio», ve la oferta (saldo o cuotas, con calendario e inicial) y la **acepta**: se emite un código `fcp_…` de un solo uso que caduca en 10 minutos (hash en BD).
2. En el checkout del comercio elige «Fluvia Personal» e introduce el código.
3. El `PaymentConfirmationService` del comercio usa el **proveedor de enrutamiento** (`FluviaRoutingProvider`): `fcp_…` ⇒ red Fluvia (autoriza y captura en el programa); cualquier otro token ⇒ MockProvider (sin cambios).
4. El comercio registra su cobro como siempre (`merchant.pending`); el programa registra la obligación con la red (`program.network.payable`). **Aprobación de crédito ≠ liquidación al comercio**: el comercio cobra por el circuito de liquidación existente; el desembolso (retraso, condiciones) es configurable (`program.settlementDelayDays`) y no depende de que el cliente pague sus cuotas.
5. Devolución desde el comercio ⇒ `refundPayment` del proveedor de enrutamiento ⇒ devolución en el programa.

### 8.5 Incertidumbre

- Si el comercio no recibe respuesta (timeout), su intento queda `indeterminate` (mecanismo existente) y la reserva del programa **se conserva**. El `IndeterminateResolver` consulta al proveedor (`queryPayment` / `queryRefund`) y aplica el resultado verificado por `resolveFromProvider`. Si la fuente no responde, el caso queda en la cola visible de Operaciones.
- **Devoluciones indeterminadas** (hueco declarado en jornadas anteriores): el contrato `PaymentProvider` gana `queryRefund`; el MockProvider registra sus decisiones en `sandbox_provider_operations` para que la consulta sea verificable; el webhook simulado acepta `refund.succeeded/failed`; worker y operador pueden resolver.
- Eventos de red/fondeo duplicados se descartan por `(source, event_id)`; los fuera de orden se aplican solo si la transición es válida, si no se registran `ignored_out_of_order`.

## 9. Permisos (servidor)

| Permiso                 | owner/admin | finance | support | analyst | read_only |
| ----------------------- | ----------- | ------- | ------- | ------- | --------- |
| `program:read`          | ✓           | ✓       | ✓       | ✓       | ✓         |
| `program:credit_manage` | ✓           | ✓       |         |         |           |
| `program:cards_manage`  | ✓           |         | ✓       |         |           |
| `program:cases_manage`  | ✓           | ✓       | ✓       |         |           |

Acciones con step-up obligatorio: cambiar límite, activar política, aprobar/rechazar revisión manual, bloquear/desbloquear/cerrar tarjeta por operador, aplicar garantía, resolver incierto. Doble aprobación (aprobador ≠ proponente): activar política y aplicar garantía. Todas auditadas con motivo.

El consumidor solo actúa sobre **sus** recursos (RLS + filtro de servicio); un id ajeno responde 404 indistinguible de inexistente.

## 10. Estados (resumen)

```
wallet_fundings:       pending → confirmed | failed
wallet_transfers:      processing → completed | failed | indeterminate → completed | failed
credit_applications:   submitted → approved | rejected | manual_review → approved | rejected
credit_lines:          active ⇄ frozen → closed
cards:                 requested → inactive → active ⇄ blocked → replaced | closed
card_shipments:        requested → produced → shipped → delivered | returned
card_authorizations:   approved → partially_captured → captured | reversed | expired ; declined (terminal)
credit_plans:          active → paid | cancelled
credit_installments:   scheduled → partially_paid → paid ; scheduled → overdue → paid ; → cancelled
program_cases:         open → acknowledged → resolved
```

## 11. Contratos de API (prefijos)

- Consumidor: `POST /v1/personal/auth/{register,login,logout}`, `GET /v1/personal/me`, `/v1/personal/wallet/{balances,statement,fundings,transfers,withdrawals}`, `/v1/personal/collateral/{lock,release}`, `/v1/personal/credit/{applications,lines,plans,repayments}`, `/v1/personal/cards…`, `/v1/personal/payment-codes`.
- Operación: `/v1/programs/:orgId/{consumers,applications,lines,policies,cards,authorizations,plans,cases,events,reconciliation}` (sesión + permisos `program:*`).
- Red/fondeo simulados: `POST /v1/sandbox/programs/:orgId/{funding-events,network-events}` (solo sandbox; firmados por secreto de sandbox o sesión de operador).
- Comercio: sin rutas nuevas obligatorias; el checkout acepta el método `fluvia_personal` con el código.

Errores: taxonomía v1 existente (`error-catalog.ts`) ampliada con `insufficient_funds`, `credit_limit_exceeded`, `card_inactive`, `card_blocked`, `collateral_committed`, `currency_not_supported`, `payment_code_invalid`, `policy_not_active`.

## 12. Fuera de alcance (dependencias externas)

Emisor y procesador real, red de tarjetas, banco de fondeo, verificación de identidad/ingresos/buró, licencias y acuerdos — ver la sección de dependencias pendientes del cierre de la jornada.
