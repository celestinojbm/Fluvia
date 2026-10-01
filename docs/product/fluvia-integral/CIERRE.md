# Cierre — Jornada integral (Comercios, Personal, Operaciones)

> **Estado honesto:** software funcional **en sandbox**, con proveedores **simulados** y datos **sintéticos**. **No está listo para operar**: faltan proveedores reales, acuerdos comerciales y regulatorios, y los defectos técnicos del §8. No hay dinero real, emisión real ni producción.

## 1. Rama, PR y alcance

- Rama de integración: `claude/jornada-integral-wallet-credito`. Sale de `c5384dd8b2921ecd6786a4d4b9c615e3da75918e`.
- Draft PR único contra `claude/jornada-bolivares-diseno`: celestinojbm/fluvia#66. Sin merge ni despliegue.
- No se tocaron la rama `claude/jornada-bolivares-diseno`, el #65, las demos 3302/3312/3322 ni el HomeLab. Las demos no existen en este contenedor, así que nada se arrancó contra esos puertos.
- Verificación en navegador: una instancia propia `fluvia-ci` sobre estos puertos:

  | Servicio | Puerto |
  | -------- | ------ |
  | PG       | 55436  |
  | Redis    | 56383  |
  | API      | 3340   |
  | checkout | 3341   |
  | panel    | 3342   |
  | worker   | 3349   |

- Documentos: [`ESPECIFICACION.md`](ESPECIFICACION.md), [`BACKLOG.md`](BACKLOG.md), [`../../design/fluvia-surfaces.md`](../../design/fluvia-surfaces.md) y [`../../security/access-control.md`](../../security/access-control.md).

## 2. Funcionalidad real por superficie

Todo lo listado aquí está implementado, se ejecuta contra PostgreSQL real y tiene pruebas.

### Fluvia Personal (`/personal`, API `/v1/personal/*`)

- **Cuenta.** Registro, inicio de sesión y cierre del cliente con autenticación propia: sesiones `fluvia_csess_` y rol `fluvia_auth`. Límite de tasa por IP y por correo. Una sesión de cliente no abre rutas de comercio ni de operación, y al revés tampoco. La RLS combina `app.tenant_id` y `app.consumer_id`.
- **Wallet multimoneda.** VES, USD y las demás monedas conviven sin conversión. Operaciones disponibles:
  - ingreso por el banco simulado
  - transferencia P2P dentro del programa
  - retiro con estados `processing → completed | failed | indeterminate`
  - extracto paginado

  La reserva de un retiro incierto se conserva hasta que se resuelve.

- **Garantía.** Se bloquea desde saldo propio y se libera solo si la cobertura de la deuda lo permite. Una recarga duplicada no amplía el límite. La garantía es distinta de la inicial.
- **Crédito.** Flujo de solicitud → evaluación explicada (factores y versión de política) → aprobación automática o revisión manual. Línea con límite, usado, reservado y disponible. El crédito se muestra aparte del saldo propio.
- **Tarjetas.** Virtual y física (con envío simulado). Operaciones: bloquear, desbloquear, reemplazar y fijar límites diario y por operación. Los datos sensibles solo los ve el componente seguro del emisor simulado. La BD no guarda PAN ni CVV (hay una CHECK que rechaza secuencias de 12 o más dígitos).
- **Cuotas.** Código de pago `fcp_` de un solo uso, guardado como hash con TTL de 10 minutos. La oferta aceptada fija una inicial de `ceil(monto × bps / 10000)` y un calendario exacto donde Σ cuotas = principal. El cliente puede pagar cuotas. Una devolución reduce primero el crédito y cancela cuotas desde la última; lo ya pagado vuelve como fondos propios.
- **Estados de pantalla.** Carga, vacío, error y sesión caducada. Sin scroll horizontal a 390, 768 y 1440 px. Se puede usar con teclado.

### Fluvia Operaciones (`/operaciones/:orgId`, API `/v1/programs/:orgId/*`)

- **Pantallas.**
  - resumen con colas y tabla por moneda leída del ledger
  - clientes y ficha 360
  - solicitudes y revisiones, con historial de límites
  - tarjetas y envíos
  - transacciones con sus eventos
  - casos e inciertos
  - eventos y conciliación
  - política versionada
- **Permisos en servidor.** `program:read`, `program:credit_manage`, `program:cards_manage` y `program:cases_manage`. El acceso desde otra organización devuelve 404.
- **Controles de acción.** Toda acción exige motivo. Las sensibles piden step-up (contraseña) y quedan en auditoría. La activación de política requiere doble aprobación: quien propone no puede aprobar.
- **Eventos del proveedor.**
  - Se deduplican por (tenant, fuente, event_id).
  - Los que llegan fuera de orden se ignoran y quedan registrados.
  - Un evento sin objeto abre un caso que se puede reintentar.
  - La conciliación interna cruza el ledger con el registro del proveedor simulado.

### Fluvia Comercios (continuidad)

- **Checkout.** Nuevo método «Fluvia Personal» con código de pago. El cobro se enruta a la red simulada: autoriza y captura en el programa y en el comercio.
- **«Por confirmar».** Muestra cobros y devoluciones inciertos. Se resuelven consultando de forma verificable al proveedor (`queryPayment` / `queryRefund`), sin suposiciones. Las devoluciones indeterminadas también las resuelve el worker.

## 3. Contratos y adaptadores

| Contrato                                                         | Implementación sandbox                                                                                                 | Sustituir por                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `PaymentProvider.queryPayment/queryRefund`                       | `MockPaymentProvider(store)` + `SqlProviderOperationStore` (`sandbox_provider_operations`)                             | Consulta del PSP real                                                 |
| Proveedor de fondeo/retiro (`packages/personal/src/adapters.ts`) | `SimulatedFundingProvider`. Destinos `sim:approve`, `sim:decline`, `sim:pending`, `sim:timeout`, `sim:lost`            | API del banco VES (X-02)                                              |
| Emisor de tarjetas                                               | `SimulatedCardIssuer`. Referencias sin dígitos; sin PAN ni CVV                                                         | Emisor/procesador (X-01)                                              |
| Red de tarjetas                                                  | `FluviaCardNetwork` en proceso. Autoriza, captura total o parcial y concurrente, reversa, devuelve; con `dropResponse` | Red real (X-01); el puente en proceso desaparece                      |
| Enrutamiento del comercio                                        | `FluviaRoutingProvider`. Envía `fcp_` a la red y el resto al proveedor simulado                                        | Configuración por adquirente                                          |
| Evaluación de crédito                                            | Política de referencia `ref-sandbox` v1. Sintética, marcada `pendingCommercialValidation`                              | Política aprobada (X-04) + datos de identidad, ingresos y buró (X-03) |
| Eventos del proveedor                                            | `POST /v1/programs/:orgId/sandbox/provider-events`. Solo en local y test                                               | Webhook firmado del proveedor real                                    |

El multiplicador 4× (clase A) es **ilustrativo**. Las clases B, C y D usan ×3, ×2 y rechazo, también ilustrativos.

## 4. Migraciones y procedimiento de actualización

- `0052_consumer_program.sql` crea:
  - las tablas del programa
  - RLS por tenant y por cliente
  - los grants por rol
  - las nuevas razones de ledger
  - el actor `consumer` en auditoría
  - las guardas de motor, entre ellas `fluvia_credit_reservation_guard` y la CHECK anti-PAN
- `0053_program_maintenance.sql` crea las funciones SECURITY DEFINER `list_program_tenants()` y `list_tenants_with_uncertain_payments(int)` para `fluvia_worker`.
- CI valida ambas migraciones contra PG real y confirma que una segunda corrida no cambia nada.

Procedimiento en una instancia **no productiva**:

```bash
git fetch origin claude/jornada-integral-wallet-credito && git checkout <HEAD>
pnpm install --frozen-lockfile
pnpm migrate                      # aplica 0052 y 0053 (idempotente)
pnpm seed                         # incluye PROGRAM_DEMO (sintético, idempotente)
export FLUVIA_PROGRAM_TENANT_ID=e744e6eb-95cf-5762-95a7-268a0917e747   # activa el enrutamiento fcp_
export PROGRAM_MAINTENANCE_ENABLED=true PROGRAM_MAINTENANCE_INTERVAL_MS=60000  # worker (valores por defecto)
pnpm build
```

Si `FLUVIA_PROGRAM_TENANT_ID` no está definido, el comercio se comporta exactamente como antes. Para revertir basta con quitar la variable; las tablas quedan sin uso. No existe migración de bajada.

## 5. Pruebas y CI

- **Locales, todas en verde.**

  | Paquete       | Pruebas                                                         |
  | ------------- | --------------------------------------------------------------- |
  | ledger        | 71                                                              |
  | payments-core | 136                                                             |
  | personal      | 31 (dominio contra PG; casos negativos y de concurrencia)       |
  | api           | ~290 (incluye recorrido HTTP de 8 pasos, límite de tasa y wire) |
  | worker        | 48                                                              |
  | dashboard     | 534                                                             |
  | checkout      | 30                                                              |
  | identity      | 77                                                              |
  | seeds         | 8                                                               |
  | config        | 15                                                              |
  | audit         | 9                                                               |
  | db            | 89                                                              |

  Lint, format, typecheck y build también limpios.

- **Casos negativos cubiertos.** Cada uno tiene prueba:
  - rechazo de crédito
  - saldo insuficiente
  - límite excedido
  - autorizaciones concurrentes
  - duplicados (idempotencia y eventos)
  - timeout con reserva retenida
  - tarjeta bloqueada
  - otra organización y otro cliente (404)
- **E2E en navegador:** `apps/dashboard/e2e/real-stack/integral-real-stack.spec.ts`, 12 de 12 contra la instancia `fluvia-ci`. **No corre en CI**, porque necesita el stack completo, igual que el resto de `real-stack`.
- **CI del PR.** Hubo un fallo intermitente en `refund-integrity-routes` (run 36933662464): dos reembolsos paralelos devolvieron 409 en vez de 422. La causa es un entrelazado legítimo: el ganador ya había completado y el intent estaba `refunded`. El invariante de un solo refund se cumplió. La prueba se corrigió para aceptar ambos rechazos, sin saltarla. El estado de CI del HEAD final está en el PR.

## 6. Evidencia visual

`evidence/*.png`: 40 capturas saneadas, con ids, URLs y códigos enmascarados.

- **Personal:** 10–17
- **Operaciones:** 20–28
- **Comercio «Por confirmar»:** 30
- **Anchos:** 390 y 1440 px, más 768 en las pantallas clave

No están cuantizadas (6,8 MB).

## 7. Recorrido reproducible

1. Levanta PG 16 y Redis en puertos propios. Para verificar se usaron 55436 y 56383, **nunca** 3302, 3312 ni 3322. Exporta las URLs de los roles de BD (`ADMIN_/APP_/WORKER_/RELAY_/AUTH_/INBOX_/WEBHOOK_DATABASE_URL`), `REDIS_URL` y `FLUVIA_PROGRAM_TENANT_ID`.
2. Ejecuta `pnpm migrate && pnpm seed && pnpm build`.
3. Arranca los servicios:
   - API: `HOST=127.0.0.1 PORT=3340 CHECKOUT_BASE_URL=http://127.0.0.1:3341 npx tsx src/server.ts` (en `apps/api`)
   - Worker: `WORKER_METRICS_PORT=3349 npx tsx src/main.ts` (en `apps/worker`)
   - Checkout: `FLUVIA_API_URL=http://127.0.0.1:3340 npx next start -p 3341` (en `apps/checkout`)
   - Panel: `FLUVIA_API_URL=http://127.0.0.1:3340 FLUVIA_DASHBOARD_ORIGIN=http://127.0.0.1:3342 npx next start -p 3342` (en `apps/dashboard`)
4. Ejecuta el recorrido en navegador (desde `apps/dashboard`):
   `DEMO_EVIDENCE_DIR=<dir> PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npx playwright test -c e2e/real-stack/playwright.config.ts integral-real-stack`
5. Recorrido manual con las credenciales sintéticas del seed:
   - Personal: `cliente@demo.fluvia.test`
   - Operaciones: `owner@demo.fluvia.test` y `ops@demo.fluvia.test` (segunda persona para la doble aprobación)

## 8. Defectos técnicos pendientes

Son defectos de software. No dependen de terceros.

1. Un solo programa por despliegue (`FLUVIA_PROGRAM_TENANT_ID`).
2. El puente con la red de tarjetas corre en proceso. Con una red real hace falta un adaptador asíncrono con sus propios webhooks.
3. No hay un job de liquidación entre `program.network.payable` y la liberación al comercio. `settlementDelayDays` del programa se guarda pero no se usa.
4. Intereses y mora no están implementados. Una política con `interestBps` o `lateFeeBps` mayor que 0 se rechaza.
5. La autenticación del cliente no tiene MFA, verificación de correo, recuperación de contraseña ni KYC real.
6. El cursor del extracto puede empatar en `created_at`, y en ese caso podría repetir u omitir filas en el límite de página.
7. Los límites diarios de tarjeta usan el día en UTC, no la zona horaria del cliente.
8. Un retiro `sim:pending` solo se resuelve por evento. No hay consulta periódica.
9. Una devolución de red perdida queda incierta, sin re-envío controlado. Solo se cierra con un evento o una resolución manual.
10. La conciliación es interna más el registro simulado. No existe ingesta de ficheros de liquidación.
11. La interfaz solo está en español.
12. El E2E de navegador no corre en CI y las capturas PNG no están cuantizadas.

## 9. Dependencias externas pendientes

Son proveedores e integraciones.

- **X-01:** emisor o procesador y red de tarjetas (tokenización, componente seguro de datos y webhooks).
- **X-02:** banco o proveedor de fondeo y retiro en VES.
- **X-03:** verificación de identidad, ingresos y buró.

## 10. Permisos y acuerdos comerciales o regulatorios pendientes

Están separados de lo técnico.

- **X-04:** tasas, comisiones, mora, reglas de aplicación de la garantía, desembolso y multiplicadores reales.
- Licencias y autorización para emitir medios de pago y otorgar crédito.
- Base legal para el tratamiento de datos de crédito.
- Contratos con los proveedores X-01 a X-03.

Nada de esto se puede resolver desde el código.

## 11. Punto de control para continuar

1. Parte del HEAD de la rama `claude/jornada-integral-wallet-credito`.
2. Revisa `BACKLOG.md`: I-01 a I-19 están Hechos con salvedades y X-01 a X-04 están bloqueados por terceros.
3. Siguiente trabajo técnico sugerido, en orden: defectos 3 (liquidación), 6 (cursor), 9 (re-envío controlado), 5 (MFA del cliente) y después 12 (E2E en CI).
