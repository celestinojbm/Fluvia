# Restaurantes y cobro presencial — entrega

PR borrador apilado sobre `claude/presentacion-asistente-fluvia`. Backlog y
checkpoint: [BACKLOG.md](BACKLOG.md). Investigación y bloqueo de Tap to Pay:
[TAP-TO-PAY.md](TAP-TO-PAY.md). Capturas: [evidence/](evidence/).

**Real / simulado / bloqueado — en una línea:**
- **Real** (PostgreSQL y servicios propios): pedidos, cocina, cuenta dividida y
  QR, con cobros por el flujo de pago existente contra el proveedor sandbox.
- **Simulado y marcado:** el terminal de cobro presencial.
- **Bloqueado:** Tap to Pay real (sin proveedor para Venezuela). Ninguna
  lectura de tarjeta física fue probada.

## 1. Mapa de pantallas y flujos

| Pantalla | Ruta | Quién | Flujo |
|---|---|---|---|
| Negocio | `/o/:org/negocio` | owner/admin | Tipo y módulos (cambiar no borra nada) → habilitación de cobro → sucursales, salones, mesas (QR), estaciones → menú (estación, ingredientes, alérgenos, modificadores) → personal (rol de local por sucursal). |
| Sala | `/o/:org/sala` | mesero, cajero, encargado | Mapa de mesas en vivo (libre / abierta / cuenta pedida / llamado), pedidos por QR por aceptar, para llevar. |
| Pedido | `/o/:org/sala/:id` | mesero, cajero | Menú → modificadores → guardar → enviar a cocina → agregados (revisión) → anular con motivo → mover de mesa → pedir la cuenta. |
| Cuenta | (en el pedido) | cajero, encargado | Completa, partes iguales (resto exacto), por monto o por artículos. Cada parte se cobra por QR/checkout o por cobro presencial (simulado). Se cierra solo verificada. |
| Cocina (KDS) | `/o/:org/cocina` | cocina, encargado | Comandas por estación: Aceptar → En preparación → Listo → Entregado. Historial y «marcada por error» con motivo. Sonido opcional. Pantalla completa. |
| Cobrar | `/o/:org/cobrar` | independiente (owner) o quien puede cobrar | Importe, moneda y concepto → «Acercar tarjeta» → veredicto del dispositivo → simulador (sandbox) o QR/enlace → resultado verificado → recibo. |
| Menú QR (público) | checkout `/m/:token` | comensal | Menú (solo datos del catálogo) → modificadores → total → confirmar (idempotente). |
| Seguimiento (público) | checkout `/p#token` | comensal | Estado del pedido y de cada plato, llamar al personal, pagar la cuenta o su parte. |

**Navegación según el tipo de negocio**
- Restaurante: Sala, Cocina, Caja y Cobro presencial.
- Independiente: Cobrar y Mis cobros.
- Personal del local: solo sus pantallas de trabajo.

## 2. Función → contrato → prueba → estado

| Función | Contrato (API) | Prueba | Estado |
|---|---|---|---|
| Tipo de negocio y módulos | `GET/PUT /business-profile` (versión) | `dining.test.ts`, `dining-routes.test.ts`, E2E | Real |
| Habilitación de cobro (pending / enabled / restricted / suspended) | `GET /collection-enablement`, `POST …/requirements/:id/complete`, `POST …/sandbox-decision` (solo local/test) | `in-person-routes.test.ts`, `dining-routes.test.ts`, E2E | Real (decisión del proveedor **simulada**) |
| Rol `staff` + permisos de local por sucursal | `venue_staff`; `POST /venue/staff` | `rbac.test.ts`, `dining.test.ts`, `dining-routes.test.ts`, E2E (aislamiento) | Real |
| Sucursales, salones, mesas, QR, estaciones | `POST /venue/{branches,areas,tables,stations}`, `rotate-qr` | `dining-routes.test.ts`, E2E | Real |
| Menú, modificadores, disponibilidad, ingredientes y alérgenos | `/venue/products/:id/*`, `/venue/modifier-groups` | `dining.test.ts`, E2E | Real |
| Pedido con precio histórico | `POST /dining/orders`, `…/lines` | `dining.test.ts` (cambio de precio posterior), E2E | Real |
| Comandas por estación con revisiones (new / addition / void) | `…/send`, `…/lines/:id/void` | `dining.test.ts` (trigger de inmutabilidad), `dining-routes.test.ts`, E2E | Real |
| Concurrencia (versiones, mesa ocupada) | `expected_version` → 409 `version_conflict` / `table_occupied` | `dining.test.ts`, `dining-routes.test.ts`, `dining-bills.test.ts` | Real |
| KDS en vivo y reconexión | `GET /kitchen/snapshot`, `GET /dining/stream` (SSE), `GET /dining/events` | `dining-routes.test.ts` (SSE real), `venue-cobrar-kds.test.tsx`, E2E (corte de red sin pérdida ni duplicado) | Real |
| Recuperar una comanda marcada por error | `POST /kitchen/tickets/:id/action` con `reason` (`kitchen:recall`) | `dining.test.ts` | Real |
| Cuenta completa / dividida | `POST /dining/orders/:id/bill`, `/dining/bills/:id/allocations(/equal)`, `…/void` | `dining-bills.test.ts` (checkout real + webhook firmado + inbox), E2E | Real (proveedor **sandbox**) |
| Invariantes de la cuenta en el motor | trigger diferido con lock; links inactivos sin intents nuevos | `dining-bills.test.ts` (inserción directa), `pos-sale-single-charge.test.ts` | Real |
| Pedido del cliente por QR, aceptación, seguimiento, llamado | `/v1/public/tables/:token(/orders)`, `/v1/public/dining/orders/:tracking(/bill,/attention)` | `dining-routes.test.ts`, `dining-bills.test.ts`, E2E | Real |
| Cobro presencial (contrato y estados) | `/in-person/devices`, `/in-person/payments(/:id/state)` | `in-person-routes.test.ts` (idempotencia, toques duplicados y concurrentes, incierto con webhook duplicado) | Real (servidor) |
| Terminal presencial | `/in-person/payments/:id/simulate` (solo local/test) | `in-person-routes.test.ts`, `venue-cobrar-kds.test.tsx`, E2E | **Simulado** (`method=simulator`) |
| Tap to Pay con tarjeta física | SDK del proveedor + app nativa | — | **Bloqueado** (ver TAP-TO-PAY.md) |
| Asistente del comprador (checkout / seguimiento) | — | — | **Pendiente** (ver BACKLOG) |
| Regresión del POS minorista | rutas existentes | `commerce-real-stack.spec.ts` (14/14 local), CI existente | Real |

## 3. Migraciones, reglas y límites

| Migración | Contenido | Reglas en el motor |
|---|---|---|
| 0057 | `business_profiles`, `collection_enablements` (+eventos), rol `staff` | módulos de lista cerrada, versión optimista |
| 0058 | sucursales, salones, mesas (QR aleatorio), estaciones, rutas, disponibilidad, modificadores, `venue_staff`; ingredientes/alérgenos | RLS forzada, sin DELETE (flags `active`), `venue_table_by_token` SECURITY DEFINER |
| 0059 | pedidos, líneas (precio y modificadores congelados), comandas con revisión, `dining_events` | una mesa = un pedido abierto; línea enviada inmutable; anulación final |
| 0060 | cuenta, líneas, asignaciones (link de cobro único por parte) | Σ asignaciones vivas ≤ total (trigger diferido con lock de la cuenta); link de cobro único con mismo comercio, monto y moneda; artículo en una sola parte viva; **ningún intent nuevo sobre un link deshabilitado** |
| 0061 | dispositivos, cobros presenciales | máquina de estados en BD; importe y vínculo inmutables; `client_key` único |

**Límites conocidos**
1. Un comercio por organización para restaurante: se usa el primer comercio
   activo.
2. El historial del KDS cubre las últimas 50 comandas entregadas; la vista
   activa incluye las entregadas de los últimos 30 minutos.
3. El stream del KDS sondea la BD cada 1 s por conexión. Sirve para un
   local, no para miles de pantallas; el siguiente paso sería LISTEN/NOTIFY o
   Redis pub/sub.
4. La respuesta idempotente del pedido por QR guarda el token de seguimiento
   24 h en `idempotency_keys` (con RLS), para que un reintento lo recupere.
   En la tabla de pedidos solo queda su hash.
5. Si un pago confirma sobre una parte ya anulada (carrera extrema), la cuenta
   lo muestra como anomalía y la devolución se gestiona en Devoluciones. El
   trigger de 0060 cierra la ventana normal.
6. No se tocaron impuestos, exponentes, fees ni liquidación. Las comisiones
   del cobro presencial están pendientes de decisión comercial.

## 4. Instancia independiente reproducible

```
scripts/instancia-restaurantes.sh up       # PG + Redis + API + worker + checkout + panel propios
scripts/instancia-restaurantes.sh status
scripts/instancia-restaurantes.sh down     # detiene SOLO sus procesos; los datos quedan
```

**Puertos.** Por defecto 3380 (API), 3381 (checkout), 3382 (panel) y 3383
(métricas del worker), más PostgreSQL 55438 y Redis 56385. Están fuera de
los rangos de las demos (3300–3302, 331x, 332x), `fluvia-ci` (334x) y
LiveKit/asistente (336x). El script comprueba cada puerto y aborta si alguno
está ocupado. Se pueden cambiar con `FLUVIA_RR_BASE`, `FLUVIA_RR_PG` y
`FLUVIA_RR_REDIS`.

**Datos y logs.** Datos, logs y PIDs viven en `FLUVIA_RR_HOME` (por defecto
`~/.fluvia-restaurantes`).

**Proveedores.** Solo sandbox.

**Verificación.** El ciclo `up` → E2E de 6 escenarios → `down` se verificó
en el entorno de desarrollo. Se ejecutó dentro de la nube; no se arrancó ni
se detuvo nada en otras máquinas.

**Para la E2E contra esta instancia:**
`DEMO_APP_URL=http://127.0.0.1:3382 API_URL=http://127.0.0.1:3380
ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55438/fluvia
pnpm --filter @fluvia/dashboard exec playwright test -c
e2e/real-stack/playwright.config.ts restaurante-cobro`
