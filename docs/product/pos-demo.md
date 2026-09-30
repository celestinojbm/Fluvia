# POS sandbox — estado del producto, mapa de pantallas y demo

Estado: **incremento sandbox, sin merge** (PR draft apilado sobre `claude/pos-justificante`) · Proveedor: **MockProvider únicamente** · Datos: **sintéticos** (seed de demo) · Fluvia no es banco, adquirente ni procesador. Nada de esto autoriza producción, exposición pública ni sandbox compartido (decisión #24, PEND-006).

## 1. Estado del producto (verificado contra el stack real el 2026-09-30)

Leyenda de estado: **Sandbox** = implementado y verificado en sandbox cerrado · **Incompleto** = funciona con un hueco conocido y declarado · **Bloqueado por decisión** = no se construye hasta que el propietario decida.

| Pantalla (ruta) | Funcionalidad real | API utilizada | Estado | Pendiente |
| --- | --- | --- | --- | --- |
| Login / registro / onboarding (`/login`, `/signup`, `/onboarding`) | Sesión por cookie httpOnly; alta de organización y comercio de prueba | `/v1/auth/*`, `POST /v1/organizations`, `POST /v1/organizations/:org/onboarding/merchant` | Sandbox · Incompleto | Cuentas con MFA no pueden entrar al dashboard (declarado en la UI) |
| Panel (`/o/:org`) | Últimos pagos, devoluciones, checkouts, enlaces y cola de webhooks; barra común del recorrido | `GET /v1/organizations/:org/{payment_intents,refunds,checkout_sessions,payment_links,webhook_events}` | Sandbox | — |
| Cobrar / POS (`/o/:org/pos`) | Venta de cobro único → checkout alojado → seguimiento → recuperación de la misma venta → devolución → justificante | `POST …/payment_links`, `POST /v1/payment_links/:id/sessions`, `GET …/checkout_sessions/:id`, `GET …/payment_intents/:id`, `GET …/payment_links/:id/sale`, `POST …/refunds` | Sandbox | Sin «cancelar cobro» ni desactivar enlace por sesión (contrato inexistente); listados limitados a 100 sin filtros de servidor |
| Checkout del comprador (`checkout /c/:id`, `/l/:id`) | Pago con tarjeta de prueba aprobada/rechazada o transferencia asíncrona | `GET /v1/checkout_sessions/:id/status`, `POST …/confirm`, `GET /v1/payment_links/:id` | Sandbox | Exposición pública **congelada** (decisión #24) |
| Pagos (`/o/:org/payments`, `/:id`) | Lista y detalle con línea de tiempo; justificante y «Abrir en el POS»; registrar devolución | `GET …/payment_intents[/:id]`, `GET …/refunds?payment_intent_id=`, `GET …/checkout_sessions`, `POST …/refunds` | Sandbox | Comercio mostrado por id (no por nombre) en la lista |
| Devoluciones (`/o/:org/refunds`, `/:id`) | Lista y detalle | `GET …/refunds[/:id]` | Sandbox | — |
| Justificante (`/o/:org/pos/receipts/:id`) | Justificante operativo imprimible de un cobro confirmado y sus devoluciones | BFF que compone `payment_intents/:id`, `merchants/:id`, `payment_links/:id/sale`, `refunds` | Sandbox · **Bloqueado por decisión** en lo fiscal | No es factura: numeración fiscal, impuestos y datos del comprador dependen de PEND-007 |
| Sesiones de checkout, enlaces de pago (`/checkout-sessions`, `/payment-links`) | Lista/detalle; crear enlace | `GET/POST …/payment_links`, `GET …/checkout_sessions` | Sandbox | — |
| Comercios (`/merchants`) | Lista y búsqueda | `GET …/merchants` | Sandbox | — |
| Conciliación, casos, payouts, disputas | Operación F4 con four-eyes | `…/reconciliation*`, `…/operational-cases*`, `…/payouts*`, `…/disputes*` | Sandbox · Incompleto | Deuda CSRF de `operational-cases`, `case-adjustments`, `disputes/*/evidence` (documentada, sin autorizar) |
| Webhooks, endpoints, API keys, auditoría | Superficie de desarrollador | `…/webhook_events*`, `…/webhook_endpoints*`, `…/api-keys*`, `…/audit-events` | Sandbox · Incompleto | Step-up de API keys no cubre cuentas con MFA (gap B2-MFA) |
| Saldo, comisiones y liquidación | No hay pantalla de saldo; la devolución usa `merchant.available` | (ledger interno) | **Bloqueado por decisión** | Fees, liquidación, país y exponente COP: PEND-002/PEND-007/PEND-008. Ningún camino de producto libera fondos |

## 2. Qué cambió en este incremento

1. **Lenguaje del comercio** — `app/lib/status-labels.tsx`: estados legibles (es/en) en panel, pagos, detalle, devoluciones, checkouts, enlaces y «Cobros recientes». El código técnico se conserva en `data-status`/`title` y, en los detalles, visible como `<code>`. Un estado desconocido se muestra tal cual. «Reembolso» → «Devolución» (la palabra del POS); «Payment links/intents» → «Enlaces de pago/Pagos».
2. **Formulario de devolución del detalle** en unidades **mayores** con la misma regla que el POS (`parseMajorAmount`); errores conocidos explicados, con el código técnico al lado. Antes pedía unidades menores (un «10» en USD eran 0,10).
3. **Horas** renderizadas en servidor marcadas «UTC». Antes el mismo cobro se veía 13:41 en el POS (hora local) y 18:41 en el detalle sin indicar zona. No se fija una zona de país (PEND-007).
4. **Navegación continua** — `app/lib/flow-nav.tsx`: barra común *Panel · Cobrar · Pagos · Devoluciones · Cerrar sesión* con `aria-current` en panel, POS, justificante, pagos y devoluciones (oculta al imprimir, objetivos de 44 px). El detalle del pago enlaza al **justificante** (solo cobros confirmados) y al **POS** (su checkout más reciente).
5. **Bug**: en todos los detalles el enlace decía «← Volver al panel» y llevaba a la lista; ahora dice «← Volver a la lista».
6. **Demo local privada** (`scripts/demo/`) y recorrido E2E contra el stack real (`e2e/real-stack/journey-real-stack.spec.ts`).

No se tocaron ledger, idempotencia, migraciones, `.github/`, proveedores, ni reglas de país/moneda/COP. Único cambio fuera del dashboard: `apps/api/src/server.ts` acepta `HOST` opcional (por defecto `0.0.0.0`, como antes).

## 3. Mapa de pantallas y recorridos

```
Login ─► Panel ──(Cobrar)──► POS: Nueva venta
                              │  Crear venta (cobro único, idempotente)
                              ▼
                        Presentar checkout ──(Abrir checkout)──► Checkout del comprador
                              │                                   ├─ tarjeta aprobada ─► «Pago completado»
                              │                                   ├─ tarjeta rechazada ─► «Pago rechazado»
                              │                                   └─ transferencia asíncrona ─► «Pago pendiente»
                              ▼ (seguimiento cada 2,5 s)
             ┌────────────────┼──────────────────────────┐
         Aprobado         Rechazado                 En proceso (incierto)
             │         «Recuperar la venta»:        sin «Nuevo cobro»: no se
             │         checkout nuevo de la         puede cobrar otra vez hasta
             │         MISMA venta ─► Aprobado      un desenlace verificado
             ▼
   Devolver… (todo / una parte) ─► Confirmar ─► Devuelta · Cancelada (sin saldo) · Sin confirmar
             ▼
   Ver justificante ─► Imprimir            Cobros recientes ─► Seguir / Ver justificante / Detalle
             ▲                                                          │
             └──────── Detalle del pago (Pagos) ◄───────────────────────┘
                        └─ «Abrir en el POS» vuelve al seguimiento del cobro
```

## 4. Escenarios demostrados (stack real, instalación limpia)

`scripts/demo/start-local-demo.sh` + `npx playwright test -c e2e/real-stack/playwright.config.ts journey` con `DEMO_APP_URL=http://127.0.0.1:3302`: **7/7**. Formulario de venta, devolución y navegación hechos **con teclado**; sin scroll horizontal a **390, 768 y 1440 px** en cada pantalla. Capturas saneadas (UUID → `••••1234`, URLs fuera), 390 y 1440:

| # | Pantalla | Capturas |
| --- | --- | --- |
| 1 | Panel con la barra común | [1440](pos-evidence/demo-01-panel-1440.png) · [390](pos-evidence/demo-01-panel-390.png) |
| 2 | POS: nueva venta | [1440](pos-evidence/demo-02-pos-nueva-venta-1440.png) · [390](pos-evidence/demo-02-pos-nueva-venta-390.png) |
| 3 | Presentar checkout | [1440](pos-evidence/demo-03-pos-presentar-checkout-1440.png) · [390](pos-evidence/demo-03-pos-presentar-checkout-390.png) |
| 4–5 | Checkout del comprador / pagado | [4·390](pos-evidence/demo-04-checkout-comprador-390.png) · [5·390](pos-evidence/demo-05-checkout-pagado-390.png) |
| 6 | **Cobro aprobado** | [1440](pos-evidence/demo-06-pos-aprobado-1440.png) · [390](pos-evidence/demo-06-pos-aprobado-390.png) |
| 7–8 | **Devolución parcial**: confirmar / hecha | [7·390](pos-evidence/demo-07-devolucion-confirmar-390.png) · [8·1440](pos-evidence/demo-08-devolucion-parcial-hecha-1440.png) · [8·390](pos-evidence/demo-08-devolucion-parcial-hecha-390.png) |
| 9 | **Justificante** con la devolución | [1440](pos-evidence/demo-09-justificante-parcial-1440.png) · [390](pos-evidence/demo-09-justificante-parcial-390.png) |
| 10 | Detalle del pago → justificante / POS | [1440](pos-evidence/demo-10-detalle-del-pago-1440.png) · [390](pos-evidence/demo-10-detalle-del-pago-390.png) |
| 11–13 | **Rechazo con recuperación** | [11·390](pos-evidence/demo-11-checkout-rechazado-390.png) · [12·390](pos-evidence/demo-12-pos-rechazado-recuperar-390.png) · [13·1440](pos-evidence/demo-13-pos-recuperado-aprobado-1440.png) |
| 14–15 | **Pago incierto** (asíncrono) | [14·390](pos-evidence/demo-14-checkout-pendiente-390.png) · [15·1440](pos-evidence/demo-15-pos-pago-en-proceso-1440.png) · [15·390](pos-evidence/demo-15-pos-pago-en-proceso-390.png) |
| 16 | Cobros recientes con los desenlaces | [1440](pos-evidence/demo-16-cobros-recientes-1440.png) · [390](pos-evidence/demo-16-cobros-recientes-390.png) |

**Saldo de demo.** La devolución funciona porque el **seed** deja 300.000 COP en `merchant.available` del comercio Demo Store (`releaseSettlement` llamado solo por el seed). Es **saldo sembrado de demostración**, no una liquidación del producto: ningún camino del producto libera fondos. Agotado ese saldo, la devolución termina «Cancelada» por falta de saldo (comportamiento real, captura 28 del incremento de devolución).

## 5. Demo que el propietario puede abrir

**Enlace**: no hay un enlace remoto, y no debe haberlo sin decisión: la exposición está congelada (#24) y PEND-006 sigue abierta. La demo corre **en la máquina del propietario** y se abre en esa misma máquina:

```bash
git fetch origin && git switch claude/pos-experiencia-demo
scripts/demo/start-local-demo.sh          # ~5–10 min la primera vez (install + build)
# abrir en ESA máquina: http://127.0.0.1:3302/login
#   owner@demo.fluvia.test / demo-owner-password   (credenciales de DEMO)
scripts/demo/stop-local-demo.sh           # para y borra solo lo suyo
```

- Requisitos: bash (Linux, macOS o WSL2), Node ≥ 20, pnpm 10, Docker.
- Todo escucha **solo en 127.0.0.1**: API 3300, checkout 3301, dashboard 3302, PostgreSQL 55432 y Redis 56379 en contenedores propios `fluvia-demo-*` (puertos configurables con `DEMO_*_PORT`). No publica nada en la LAN, no abre túneles, no toca servicios existentes, no tiene coste.
- Verificado en el entorno cloud: arranque desde cero (exit 0), escucha solo en loopback, recorrido 7/7 contra esa instancia, `stop` sin residuos. **No verificado desde la MSI**: no tengo acceso a ella; el primer arranque allí es la prueba pendiente.
- Usar `127.0.0.1` y no `localhost`: la protección CSRF compara el origen exacto.

**Si se quiere abrir desde OTRO dispositivo** (p. ej. el móvil del propietario), hace falta publicar puertos y eso **no se ha hecho**. Cambio exacto para revisión, a ejecutar solo por el propietario si lo autoriza (red privada del tailnet, **no Funnel**):

```bash
# En la MSI, con la demo ya arrancada. <msi> = nombre MagicDNS de la máquina.
tailscale serve --bg --https=8443 http://127.0.0.1:3302   # dashboard
tailscale serve --bg --https=8444 http://127.0.0.1:3301   # checkout del comprador
# Relanzar dashboard/API con los orígenes públicos del tailnet:
#   FLUVIA_DASHBOARD_ORIGIN=https://<msi>.<tailnet>.ts.net:8443
#   CHECKOUT_BASE_URL=https://<msi>.<tailnet>.ts.net:8444
# Revertir: tailscale serve --https=8443 off ; tailscale serve --https=8444 off
```

Eso comparte el sandbox con los dispositivos del tailnet: decide PEND-006, no este PR.

## 6. Pendientes

- **Worker fuera de la demo**: sus métricas escuchan en `0.0.0.0:9464`. Sin worker, los checkouts abiertos no expiran solos y un pago asíncrono se queda «en proceso» (no hay webhook del MockProvider que lo resuelva). Para incluirlo: `HOST` opcional también en `apps/worker/src/main.ts`.
- Tras un rechazo, «Cobros recientes» muestra «Checkout abierto · Pago: Rechazado»: es la verdad de la API (la sesión sigue abierta hasta expirar) pero se lee contradictorio. Decisión de copy, no de datos.
- Lista de Pagos muestra el comercio por id; el terminal muestra ids completos de sesión/pago (útil para soporte; decidir si se acortan).
- Contratos que faltan (sin simular): cancelar cobro / desactivar enlace por sesión, filtros y paginación > 100.
- CI: el recorrido completo es **local** (necesita PG, Redis y API reales); en CI sigue el E2E del justificante contra la API sintética.
- Decisiones del propietario sin tocar: PEND-002 (pricing), PEND-006 (sandbox compartido), PEND-007 (país), PEND-008 (exponente COP).
