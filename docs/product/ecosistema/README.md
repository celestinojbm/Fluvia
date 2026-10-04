# Ecosistema Fluvia — la misma compra en Personal, Comercio y Operaciones

Entorno: **sandbox**. Ninguna capacidad mueve dinero real; cada pantalla lo dice.

| Documento                                         | Qué contiene                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| [ARQUITECTURA.md](ARQUITECTURA.md)                | Inventario, desconexiones encontradas, recorrido canónico, identificadores |
| [DISENO.md](DISENO.md)                            | Auditoría visual (A1–A7), decisiones, estados cubiertos                    |
| Este README                                       | Mapa pantalla → función → API → prueba → estado; real/sandbox/socio; demo  |
| [TAP-TO-PAY](../restaurantes-cobro/TAP-TO-PAY.md) | Contrato presencial (POS, Tap to Pay) y lo que falta para cobrar de verdad |

## Mapa pantalla → función → API/contrato → prueba → estado

Estado: **sandbox** = funciona de punta a punta con dinero simulado; **real** = funciona
con datos reales (solo lectura de tasas públicas); **bloqueado** = depende de un socio que
no existe todavía (la UI no lo ofrece).

| Superficie · pantalla                                          | Función                                                                                                             | API / contrato                                                                                              | Prueba                                                                                         | Estado                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| Personal · Inicio `/personal`                                  | Saldo real protagonista; equivalencia secundaria con fuente; pagos en confirmación                                  | `GET /v1/personal/overview`, `/me`, tasas `GET /v1/fx/rates`                                                | `tasas-moneda` §2, `ecosistema` §1                                                             | sandbox (saldos) · real (tasas BCV)    |
| Personal · Tus saldos `/personal/saldos`                       | Cinco cifras por moneda real que nunca se suman; política 100→400 como máximo, no promesa                           | `GET /v1/personal/me` (`policy.max_multiplier_bps`, `tiers`), `/v1/personal/capabilities?market=VE`         | `design-a11y` (Saldos), `ecosistema` §7 (200 %)                                                | sandbox                                |
| Personal · Pagar `/personal/pedidos/:id/pagar`                 | Métodos decididos por el servidor con motivo; confirmación explícita con importe exacto                             | `GET /v1/personal/shop/orders/:id/payment-options`, `POST …/pay` (exige capacidad del mercado del comercio) | `journeys.test` «sin tarjeta, sin saldo o sin línea», `tiendas-personal` §4, `tasas-moneda` §3 | sandbox                                |
| Personal · Pedido `/personal/pedidos/:id`                      | «Pago y devoluciones»: método, reparto, devoluciones con estado canónico, inciertos; motivo del rechazo             | `GET /v1/personal/journeys/:ref` (`issuer.decline_code`)                                                    | `journeys.test` (tres superficies, devolución parcial), `ecosistema` §1, §2, §4, §8            | sandbox                                |
| Personal · Actividad `/personal/actividad`                     | Una fila por compra (pedido + autorización deduplicados por `journey_ref`)                                          | `GET /v1/personal/purchases` (`journey_ref`)                                                                | `journeys.test` «no se cuenta dos veces»                                                       | sandbox                                |
| Personal · Compra con tarjeta `/personal/actividad/compra/:id` | Líneas, enlace al pedido y la misma operación                                                                       | `GET /v1/personal/journeys/:ref`                                                                            | `ecosistema` §1                                                                                | sandbox                                |
| Comercio · Venta `/o/:org/orders/:id`                          | Panel «Operación»: canal, comprador de Personal, entrega, intentos, devoluciones, asientos, «Verificar»             | `GET /v1/organizations/:org/journeys/:ref`, `POST …/verify` (`reconciliation:manage`, auditado)             | `journeys.test` (tres superficies, respuesta perdida), `ecosistema` §1, §2, §4                 | sandbox                                |
| Operaciones · Caso `/operaciones/:org/operacion/:ref`          | 1 Consulta (solo lectura) · 2 Propuesta (abre caso) · 3 Decisión ejecutada; asientos de ambos lados                 | `GET /v1/programs/:org/journeys/:ref`, `POST …/verify` (step-up), `POST …/cases`                            | `journeys.test` (respuesta perdida, aislamiento), `ecosistema` §1, §2, §5, `design-a11y`       | sandbox                                |
| Operaciones · Transacciones                                    | Cada autorización lleva a su caso                                                                                   | `GET /v1/programs/:org/authorizations`                                                                      | `design-a11y` (abre el caso desde Transacciones)                                               | sandbox                                |
| Operaciones · Capacidades `/operaciones/:org/capacidades`      | Retirar una capacidad (freno, motivo, auditoría); restablecer exige otra persona con step-up                        | `GET /v1/programs/:org/capabilities`, `POST …/capabilities/withdrawals`, `POST …/withdrawals/:id/restore`   | `capabilities.test` (7), `journeys.test` «retira una capacidad», `ecosistema` §6               | sandbox (control real sobre la oferta) |
| Tres superficies · franja de tasas                             | USD/EUR del BCV rotulados «BCV»; USDT con «≈» (referencia cruzada, nunca BCV); sin tasa → se retira la equivalencia | `GET /v1/fx/rates` (BCV portada + histórico, CoinGecko)                                                     | `tasas-moneda` §1–§4; captura `estados/sin-tasa-*`                                             | real (solo mostrar)                    |
| Tap to Pay / datáfono                                          | Contrato presencial y simulador explícito                                                                           | ver [TAP-TO-PAY.md](../restaurantes-cobro/TAP-TO-PAY.md); capacidad `pos.tap_to_pay`, `pos.terminal`        | `restaurante-cobro` §5                                                                         | sandbox · datáfono **bloqueado**       |

Identificador compartido: `journey_ref` = id del pedido (o del enlace de cobro). La clave
entre emisor y comercio es `card_authorizations.network_ref = 'acq:<attempt_id>'`. Detalle
en [ARQUITECTURA.md](ARQUITECTURA.md).

## Real, sandbox y pendiente de socio

Fuente única: `packages/capabilities/src/catalog.ts` (techo por mercado, versionado en el
código). Operaciones solo puede **bajar** una capacidad (retirarla), nunca subirla.

| Capacidad (`clave`)                                        | Venezuela                       | Colombia            | Qué falta para dinero real                                  |
| ---------------------------------------------------------- | ------------------------------- | ------------------- | ----------------------------------------------------------- |
| Pagar con saldo (`pay.wallet`)                             | sandbox                         | no ofrecida         | Custodia con entidad autorizada y licencia de pagos         |
| Cuotas (`pay.installments`)                                | sandbox                         | no ofrecida         | Financiador autorizado, política aprobada, KYC/score reales |
| Tarjeta de otro banco (`pay.external_card`)                | sandbox                         | sandbox             | Procesador/adquirente PCI DSS con contrato                  |
| Tap to Pay (`pos.tap_to_pay`)                              | sandbox                         | sandbox             | Proveedor certificado (SDK del SO y del adquirente)         |
| Datáfono (`pos.terminal`)                                  | **pendiente socio**             | **pendiente socio** | Integración y certificación con un adquirente               |
| Tarjeta virtual / física (`card.*`)                        | sandbox                         | no ofrecida         | Emisor BIN sponsor, procesador de emisión, plásticos        |
| Aceptación fuera de Fluvia (`card.network_acceptance`)     | **pendiente socio**             | no ofrecida         | Membresía de red vía emisor patrocinador                    |
| Línea de crédito (`credit.line`)                           | sandbox                         | no ofrecida         | Entidad que otorgue crédito, aprobación regulatoria         |
| Ingresar / retirar (`wallet.funding`, `wallet.withdrawal`) | sandbox                         | no ofrecida         | Banco recaudador y pagador con API y conciliación           |
| USDT (`wallet.usdt`)                                       | **no ofrecida**                 | no ofrecida         | Custodio autorizado; Fluvia no mueve USDT                   |
| Tasas de referencia (`fx.reference_rates`)                 | datos reales, solo para mostrar | no ofrecida         | Convertir dinero exigiría un proveedor de cambio            |
| Tiendas conectadas (`shops.connected`)                     | **pendiente socio**             | **pendiente socio** | Autorización de cada comerciante                            |

Ninguna fila es «operativa». La prueba `capabilities.test` «ninguna capacidad está
operativa en dinero real» falla si alguien sube una sin cambiar este documento.

## Recorridos probados contra el stack real

`apps/dashboard/e2e/real-stack/ecosistema.spec.ts` (navegador, API, PostgreSQL y worker
reales; corre en CI en el job «E2E restaurante y cobro presencial»):

1. **Compra aprobada** — la clienta paga con saldo; Personal, Comercio y Operaciones
   muestran el mismo pedido, cobro y autorización.
2. **Respuesta perdida** — importe terminado en 13: «En confirmación», reintentos sin
   segundo cargo, anular rechazado; solo la verificación del proveedor lo cierra.
3. **Cuotas sandbox** — con línea aprobada; plan y deuda del cliente en Personal y
   Operaciones.
4. **Devolución sin fondos liquidados** — «No procesada», nunca «Devuelta».
5. **Aislamiento** — otro cliente no ve el pedido; sin rol de Operaciones no entra.
6. **Capacidad retirada** — Personal deja de ofrecer el método y el servidor lo rechaza;
   restablecer exige otra persona con step-up.
7. **Accesibilidad** — texto al 200 % y movimiento reducido sin desborde.
8. **Rechazo y recuperación** — la clienta fija un límite por compra en su tarjeta; el
   emisor rechaza (`card_limit_exceeded`) sin cargo y el pedido dice el motivo con enlace a
   «Cambiar límites»; Comercio ve «Rechazado». Quita el límite, reintenta desde el pedido:
   aprobado, dos intentos y **un único cobro**.

`apps/api/test/journeys.test.ts` cubre además la **devolución parcial** (tras liquidar al
comercio, `partially_refunded` en las tres superficies y el saldo vuelve) y los **métodos
no ofrecidos con motivo** (sin tarjeta en la moneda, sin saldo, sin línea).

## Evidencias

- `capturas/` — 20 pantallas × 390/768/1440 (1440 reducida a 1080), stack real, saneadas
  (ids como `••••1234`, sin tokens ni URLs).
- `comparativas/` — antes (#70, `4d9c41b`) / después, mismas rutas y datos: p01, p03, p04,
  p09, p10, p11, c04, o02 a 390 y 1440.
- `estados/` — sin tasa disponible (el importe original queda y la equivalencia se
  retira) y pago rechazado con su motivo.

## Demo independiente

`scripts/instancia-ecosistema.sh` crea una instancia propia (`fluvia-ecosistema`):
contenedores `fluvia-ecosistema-pg` / `-redis`, volumen `fluvia-ecosistema-pgdata`,
estado, PID y logs en `<checkout>/.demo-fluvia-ecosistema/`. No toca otras instancias.

```bash
git clone https://github.com/celestinojbm/Fluvia.git fluvia-ecosistema
cd fluvia-ecosistema && git checkout claude/fluvia-ecosistema-integrado
corepack enable && pnpm install --frozen-lockfile
scripts/instancia-ecosistema.sh config   # puertos y nombres resueltos
scripts/instancia-ecosistema.sh up       # aborta antes de crear nada si un puerto está ocupado
scripts/instancia-ecosistema.sh status
scripts/instancia-ecosistema.sh down     # para solo esta instancia; conserva el volumen
scripts/instancia-ecosistema.sh purge --yes-delete-data   # borrado explícito, aparte
```

| Pieza       | URL                                                           |
| ----------- | ------------------------------------------------------------- |
| Personal    | http://127.0.0.1:3422/personal                                |
| Comercio    | http://127.0.0.1:3422/login → Casa Ávila (`/o/<org>`)         |
| Operaciones | http://127.0.0.1:3422/login → programa (`/operaciones/<org>`) |
| Checkout    | http://127.0.0.1:3421                                         |
| API         | http://127.0.0.1:3420                                         |

Usuarios **sintéticos** de la semilla (solo sandbox, sin valor fuera de la demo):

| Rol                         | Correo                     | Contraseña              |
| --------------------------- | -------------------------- | ----------------------- |
| Clienta de Personal         | `cliente@demo.fluvia.test` | `demo-cliente-password` |
| Comercio Casa Ávila         | `tiendas@demo.fluvia.test` | `demo-tiendas-password` |
| Operaciones (programa)      | `ops@demo.fluvia.test`     | `demo-ops-password`     |
| Propietario (segunda firma) | `owner@demo.fluvia.test`   | `demo-owner-password`   |

Escenario de respuesta perdida: en Casa Ávila, «Individual de fique (escenario de prueba:
respuesta perdida)», Bs 150,13. El worker lo verifica en su siguiente ciclo; Comercio u
Operaciones pueden pedir «Verificar».

Sin Tailscale Serve/Funnel, sin producción, sin proveedores reales ni servicios del HomeLab.
