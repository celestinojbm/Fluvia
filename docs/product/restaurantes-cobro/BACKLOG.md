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
| R1 | Modelo: tipo de negocio, módulos, habilitación de cobro presencial, rol `staff` | hecho | `0057`, `business.ts`, `rbac.test.ts` |
| R1 | Estructura del local: sucursales, salones, mesas (QR), estaciones, modificadores, disponibilidad, roles de local | hecho (dominio) | `0058`, `venue.ts`, `dining.test.ts` |
| R1 | Pedidos, líneas con precio histórico, comandas por estación con revisiones, eventos | hecho (dominio) | `0059`, `dining.ts`, `dining.test.ts` |
| R1 | Cuenta y asignaciones de pago (modelo + invariantes en BD) | parcial: esquema e invariantes; falta servicio | `0060` |
| R1 | Cobro presencial (modelo + máquina de estados en BD) | parcial: esquema; falta servicio y simulador | `0061` |
| R2 | API: perfil de negocio, habilitación, configuración del local, personal | pendiente | |
| R3 | API + UI: POS de mesero, KDS (snapshot + eventos, reconexión) | pendiente | |
| R4 | `BillService`: cuenta completa, por monto, por ítems; resto; verificación de pagado | pendiente | |
| R4 | Cliente: menú QR, pedido, seguimiento, atención; asistente del comprador acotado | pendiente | |
| R5 | `InPersonService`, simulador explícito de terminal, pantalla «Cobrar» independiente | pendiente | |
| R5 | Tap to Pay real (SDK + proveedor + dispositivo) | **bloqueado** — ver abajo | |
| R6 | Lima en Personal/comprador, E2E en CI, capturas 390/768/1440 + KDS, instancia, docs | pendiente | |

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
