# Jornada — Restaurantes y cobro presencial · backlog persistente

Rama `claude/restaurantes-cobro-presencial`, apilada sobre
`claude/presentacion-asistente-fluvia` (cierre del #68 en `0c1443a`). Este archivo
es el checkpoint: si la jornada se corta, se retoma desde la primera fila no
cerrada.

Estados: **hecho** (código + prueba contra PostgreSQL real), **parcial**,
**pendiente**, **bloqueado** (dependencia externa; se indica cuál).

## Incrementos

| # | Bloque | Estado | Evidencia |
|---|--------|--------|-----------|
| R1 | Modelo: tipo de negocio, módulos, habilitación, rol `staff` | hecho | `0057`, `business.ts`, `rbac.test.ts` |
| R2 | Local: sucursales, salones, mesas QR, estaciones, modificadores, personal (API + UI) | hecho | `0058`, `venue.ts`, `dining-routes.test.ts`, E2E |
| R3 | Pedidos, comandas con revisiones, KDS en vivo con reconexión (API + UI) | hecho | `0059`, `dining.ts`, SSE, E2E con corte de red |
| R4 | Cuenta completa/dividida sobre ventas de cobro único; menú QR y seguimiento | hecho | `0060`, `bills.ts`, `dining-bills.test.ts`, E2E |
| R4 | Asistente del comprador (checkout y seguimiento, solo lectura) | **pendiente** | — |
| R5 | Contrato presencial, simulador explícito, «Cobrar» del independiente | hecho | `0061`, `in-person.ts`, `in-person-routes.test.ts`, E2E |
| R5 | Tap to Pay real (SDK, proveedor, dispositivo) | **bloqueado** — TAP-TO-PAY.md | — |
| R6 | Lima en restaurante, KDS, «Cobrar» y comprador (menú QR) | hecho | capturas en `evidence/` |
| R6 | Lima en Personal (inicio, tarjetas) | **pendiente** | — |
| R6 | E2E en CI, capturas 390/768/1440 y KDS 1024/1920, instancia, docs | hecho | job `e2e-restaurant`, `README.md`, `scripts/instancia-restaurantes.sh` |

## Siguiente al retomar

1. **Asistente del comprador.** Superficie `buyer` acotada al token de checkout o
   de seguimiento. Herramientas de lectura: estado del pedido y de la cuenta,
   menú del catálogo, cómo pagar. Sin billetera, sin datos internos y sin
   pedidos ajenos. Reutiliza conversación, fotos y notas con el mismo
   almacenamiento privado.
2. **Lima en Personal.** Acciones rápidas, categorías y detalles
   seleccionados; aplicarlo con la misma regla de contraste (texto y borde
   negros).
3. **Fragilidad preexistente.** `apps/worker/test/payouts-redriver.test.ts`
   reclama un lote de 20 en una BD compartida. En una BD local de larga vida
   con más de 20 payouts `requested` antiguos falla de forma intermitente; en
   CI (BD nueva) pasa. No se cambió en esta rama.

## Reglas de diseño ya fijadas (no reabrir sin motivo)

- **Cambiar de tipo de negocio no borra nada.** Solo cambia módulos visibles y
  qué rutas acepta el servidor.
- **Permisos efectivos en el servidor.** Rol de membresía `staff` = solo
  `org:read`. Lo que puede hacer en el local lo da `venue_staff` (rol
  manager/cashier/waiter/kitchen + sucursal o todas). owner/admin = completo.
- **Estados separados.** Pedido (`dining_orders.status`), preparación por línea
  (`prep_status`) y pago (cuenta/asignaciones → payment links/intents).
  «Listo» nunca implica «pagado».
- **Agregados posteriores = nueva revisión de comanda** (`kind` new/addition/void).
  Un trigger impide reenviar o sobrescribir una línea ya enviada. La anulación
  de una línea enviada genera una comanda `void`.
- **Concurrencia.** Versión optimista en pedido y comanda; una mesa no puede
  tener dos pedidos abiertos de personal (índice único).
- **KDS.** El snapshot autoritativo es la verdad al iniciar y al reconectar.
  `dining_events` (seq) son solo avisos en vivo: los seq pueden confirmarse
  fuera de orden.
- **QR de mesa** abre el menú y permite crear un pedido propio. Nunca da acceso
  a pedidos de otros comensales: el seguimiento exige el token del propio
  pedido, guardado solo como hash.
- **Cuenta dividida.** Cada asignación = su propio payment link `single_charge`
  ligado a la cuenta. Trigger diferido: Σ asignaciones vivas ≤ total; el link
  debe ser single-charge con el mismo monto, moneda y comercio. Un ítem, como
  mucho en una asignación viva. «Pagada» solo tras verificar en servidor.
- **Cobro presencial.** El cliente solo avanza estados de preparación o cancela.
  approved/declined/uncertain los fija el servidor desde el intent (resultado
  síncrono o webhook firmado). Nunca PAN/CVV en Fluvia.

## Bloqueo externo: Tap to Pay en Venezuela

Consultado el 2026-10-02 en documentación oficial:

- **Stripe Tap to Pay (Android/iPhone):** Venezuela no figura entre los países
  disponibles ni en preview.
- **Apple Tap to Pay on iPhone** (developer.apple.com/tap-to-pay/regions):
  Venezuela no figura.
- **«Pago Móvil NFC»** (Suiche 7B; BDV, BNC, Bancaribe, Bancamiga): es una
  transferencia Pago Móvil de teléfono a teléfono, no aceptación EMV de
  tarjetas. Sin API pública.
- **Credicard:** ofrece terminales físicos (y BDV Access Pay); no se encontró un
  SoftPOS con SDK público.
- **Adyen y Square:** no verificados (URLs de docs 404 desde este entorno).

Falta, para un cobro con tarjeta real: un adquirente/proveedor con SoftPOS
certificado que opere en Venezuela, un contrato y credenciales, su SDK móvil
nativo, y un dispositivo físico compatible. Hasta entonces: simulador explícito
(solo local/test) + QR/checkout como alternativa que funciona.
