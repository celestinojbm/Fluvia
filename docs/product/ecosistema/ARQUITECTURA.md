# Ecosistema Fluvia — inventario y recorrido canónico

Rama `claude/fluvia-ecosistema-integrado`, apilada sobre `claude/personal-movil-tiendas`
(#70, HEAD verificado `4d9c41b`, 10/10 checks en verde el 2026-10-03). Base de #70:
`claude/restaurantes-cobro-presencial` (#69, `1f7c7f8`). La cadena baja por #68…#59 hasta
`claude/new-session-haeo7h`. No se toca ninguna de esas ramas.

## Inventario (lo que existe y se amplía)

| Pieza | Dónde | Papel en esta jornada |
|---|---|---|
| Pedido del comercio con precio del servidor, reserva y enlace de cobro único | `@fluvia/commerce` `OrderService` (0049–0051) | **Fuente canónica del pedido** (`journey_ref`) |
| Estado de pago **derivado** de los intents del enlace | `ORDER_SELECT` en `orders.ts` | Fuente canónica de «pagado / en confirmación / pendiente» |
| Intents, attempts y devoluciones con FSM en el motor | `@fluvia/payments-core` (0017, 0020) | Cobro, incertidumbre y devolución |
| Red Fluvia simulada (`FluviaCardNetwork`) | `@fluvia/personal/network.ts` | Une el attempt del comercio con la autorización del emisor: `network_ref = acq:<attempt_id>`, `merchant_ref = <tenant>:<merchant>` |
| Autorización, capturas, devoluciones del emisor | `card_authorizations`, `card_authorization_events` (0052) | Lado del cliente: saldo/crédito usado y devuelto |
| Ledger de doble partida con clave idempotente | `ledger_transactions` | Comercio: `attempt:<id>:capture`, `refund:<id>:*`; programa: `auth:<id>:*` |
| Resolución de inciertos por consulta verificable | `UncertainPaymentResolver` (comercio), `resolveUncertainWithdrawals` (programa) | Única vía para cerrar un incierto |
| Tiendas Fluvia: carrito, pedido idempotente, pago con tarjeta Fluvia o checkout alojado | `ShopService`, `/v1/personal/shop/*` (#70) | Recorrido de compra de Personal |
| POS, cobro presencial (simulador), restaurante y KDS | `/o/:org/pos`, `cobrar`, `sala`, `cocina` (#63–#69) | Recorrido del comercio |
| Operaciones del programa: autorizaciones, casos, doble aprobación, conciliación | `/v1/programs/:org/*`, `program_cases`, `program_approvals` | Consola de Operaciones |
| Tasas de referencia BCV/USDT con caché y estado | `apps/api/src/fx`, 0066 | Equivalencias de visualización |
| Identidad «Menta», tokens CSS, Manrope | `apps/dashboard/app/globals.css`, `docs/design/identidad-menta.md` | Base visual |
| Instancias aisladas | `scripts/instancia-*.sh` | Demo nueva e independiente |

## Desconexiones encontradas (antes de cambiar nada)

Prueba: `apps/api/test/journeys.test.ts`. Ejecutada sobre `4d9c41b` + solo la prueba:
**4 de 4 fallan**.

1. **La misma compra aparecía dos veces en Actividad de Personal**: una fila por el pedido
   de la tienda y otra por la compra con tarjeta (autorización del emisor). Nada unía la
   autorización con el pedido.
2. **Operaciones no podía llegar de una autorización a su pedido** ni ver el cobro o la
   devolución del lado del comercio.
3. **El comercio no tenía una lectura de un pedido con su cobro, intentos, devoluciones y
   asientos** en un mismo sitio; cada pieza vivía en una pantalla distinta.
4. **Una devolución en curso o incierta no era visible para el cliente** (solo el importe ya
   devuelto).

## Recorrido canónico

```
Personal (cliente)                    Comercio (tenant del comercio)            Programa (tenant de Fluvia Personal)
──────────────────                    ───────────────────────────────           ────────────────────────────────────
carrito ─► POST /shop/orders ───────► commerce_orders  (journey_ref = id)
                                       └─ payment_link (cobro único)
pagar ─► código fcp_ de un uso ──────► payment_intent ─► payment_attempt ──────► card_authorization
                                                          provider_ref=fnet_<auth>   network_ref = acq:<attempt>
                                                          ledger attempt:<id>:*      merchant_ref = <tenant>:<merchant>
                                                                                     ledger auth:<id>:*
devolución ◄──────────────────────── refunds (status)  ─────────────────────────► card_authorization_events (refund)
```

**Identificadores que unen las vistas**

| Id | Fuente | Personal | Comercio | Operaciones |
|---|---|---|---|---|
| `journey_ref` (= id de `commerce_orders`) | comercio | sí | sí | sí |
| `payment.intent_id` | comercio | sí | sí | sí |
| `payment.attempts[].id` | comercio | no (solo estado) | sí | sí |
| `issuer.authorization_id` | programa | sí | **no** (ve `fnet_…` como referencia del proveedor) | sí |
| `refunds[].id` | comercio | sí | sí | sí |
| Asientos del ledger | ambos | no | los suyos | ambos lados |

**Fuente canónica por estado**

| Estado | Fuente | Regla |
|---|---|---|
| Pagado / en confirmación / pendiente / rechazado / anulado | intents del enlace del pedido (derivado) | Nunca del navegador; «volver del checkout» no confirma nada |
| Devolución | `refunds.status` | `processing`/`indeterminate` = **incierta**, no «devuelta» |
| Reparto saldo/crédito y devuelto al cliente | `card_authorizations` | Solo cliente y Operaciones |
| Preparación / entrega | `shop_order_requests.fulfillment_status` | Solo avanza con el pedido cobrado (regla del motor) |
| Capacidad ofrecida | catálogo `@fluvia/capabilities` + retiradas de Operaciones (0067) | La acción no se ofrece si no existe |

La composición vive en un único servicio de lectura (`JourneyService`, API). Las tres
proyecciones filtran campos; ninguna calcula un estado propio.
