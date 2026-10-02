# Restaurantes y cobro presencial — entrega

PR borrador apilado sobre `claude/presentacion-asistente-fluvia`. Backlog y
checkpoint: [BACKLOG.md](BACKLOG.md). Investigación y bloqueo de Tap to Pay:
[TAP-TO-PAY.md](TAP-TO-PAY.md). Capturas: [evidence/](evidence/).

**Real / simulado / bloqueado — en una línea:**
- **Real** (PostgreSQL y servicios propios): pedidos, cocina, cuenta dividida y
  QR, con cobros por el flujo de pago existente contra el proveedor sandbox;
  asistente del comprador en checkout y seguimiento (servidor, permisos,
  aislamiento y transporte reales; ver §5 para sus proveedores).
- **Simulado y marcado:** el terminal de cobro presencial, la decisión del
  proveedor en la habilitación de cobro y los proveedores de IA/voz del
  asistente en local y CI («Proveedor simulado» visible en la interfaz).
- **Bloqueado:** Tap to Pay real (sin proveedor para Venezuela). Ninguna
  lectura de tarjeta física fue probada.

**Cierre.** El SHA final y el resultado del CI de cada job están en la
descripción del PR (un commit no puede citar su propio SHA). La última
validación local completa está en §8.

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
| Asistente del comprador | botón «Pregunta a Fluvia» en `/p#token` y `/c/:id#secreto` | comensal / comprador | Pregunta por SU pedido, SU pago o qué lleva un plato → respuesta con datos del servidor → enlaces que llevan al control real de la página (pagar, estado, llamar). Solo lectura. |

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
| Asistente del comprador (checkout / seguimiento) | `/v1/buyer/assistant/*` (credencial del comprador por cabeceras); BFF del checkout `/api/asistente/*` | `buyer-assistant.test.ts` (10), `buyer-bff.test.ts` (4), E2E (aislamiento, anclas, caducidad, pago tras usar el asistente) | Real (proveedores de IA **simulados** en local/CI) |
| Lima en Personal | — | capturas antes/después 390/1440 | Real |
| Regresión del POS minorista | rutas existentes | `commerce-real-stack.spec.ts` (14/14 local), CI existente | Real |

## 3. Migraciones, reglas y límites

| Migración | Contenido | Reglas en el motor |
|---|---|---|
| 0057 | `business_profiles`, `collection_enablements` (+eventos), rol `staff` | módulos de lista cerrada, versión optimista |
| 0058 | sucursales, salones, mesas (QR aleatorio), estaciones, rutas, disponibilidad, modificadores, `venue_staff`; ingredientes/alérgenos | RLS forzada, sin DELETE (flags `active`), `venue_table_by_token` SECURITY DEFINER |
| 0059 | pedidos, líneas (precio y modificadores congelados), comandas con revisión, `dining_events` | una mesa = un pedido abierto; línea enviada inmutable; anulación final |
| 0060 | cuenta, líneas, asignaciones (link de cobro único por parte) | Σ asignaciones vivas ≤ total (trigger diferido con lock de la cuenta); link de cobro único con mismo comercio, monto y moneda; artículo en una sola parte viva; **ningún intent nuevo sobre un link deshabilitado** |
| 0061 | dispositivos, cobros presenciales | máquina de estados en BD; importe y vínculo inmutables; `client_key` único |
| 0062 | titular `buyer` y superficie `buyer` en conversaciones del asistente | `owner_kind = 'buyer'` ⇔ `surface = 'buyer'` (CHECK); la RLS por tenant + titular de 0055 aísla a cada comprador |

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

`scripts/instancia-restaurantes.sh` es un envoltorio de la infraestructura de
demo existente (`scripts/demo/*`). No duplica el arranque. PostgreSQL 16 y
Redis 7 corren en **contenedores Docker propios**, así que no hace falta
PostgreSQL ni Redis nativos.

```
scripts/instancia-restaurantes.sh config   # configuración resuelta (no crea nada)
scripts/instancia-restaurantes.sh up       # comprueba, crea/arranca, migra, siembra, construye, arranca
scripts/instancia-restaurantes.sh status
scripts/instancia-restaurantes.sh down     # para SOLO lo suyo; conserva los datos
scripts/instancia-restaurantes.sh purge --yes-delete-data   # borra SUS contenedores y volumen
```

**Puertos por defecto** (sujetos a comprobación en la máquina de destino):

| Servicio | Puerto |
|---|---|
| API | 3380 |
| Checkout | 3381 |
| Panel | 3382 |
| Métricas del worker | 3383 |
| PostgreSQL | 55439 |
| Redis | 56386 |

55438/56385 son de `fluvia-asistente`; 3300–3302, 331x y 332x son de las demos.
Se cambian con `FLUVIA_RR_BASE`, `FLUVIA_RR_PG` y `FLUVIA_RR_REDIS`.

**Recursos propios.**
- Contenedores: `fluvia-restaurantes-pg` y `fluvia-restaurantes-redis`.
- Volumen: `fluvia-restaurantes-pgdata`.
- Estado y logs: `<checkout>/.demo-fluvia-restaurantes/`.
- Contenedores y volumen llevan las etiquetas `fluvia.demo.prefix` y
  `fluvia.demo.root`. Nunca se adopta ni se borra un recurso con otras
  etiquetas.

**Garantías del arranque (`up`)**

1. **Comprueba todo antes de crear nada.**
   - Los 6 puertos.
   - Que ningún proceso de Next sirva ya `apps/checkout` o `apps/dashboard`
     desde ese checkout: el `next build` lo rompería. Por eso cada instancia
     usa su propio checkout.
   - Que los recursos con su nombre no sean de otra instancia.
2. **Seed con postcondiciones, no solo con código de salida.**
   - Seed principal: Demo Fluvia, `owner@` verificado, programa de Personal y
     `cliente@`.
   - Seed de restaurantes por la API real: 4 mesas, 4 platos, personal con su
     rol, habilitación sandbox `enabled` en ambas organizaciones, URL de menú
     de M1, y login de cada persona.
   - Si algo falta, falla con el motivo concreto.
3. **Código HTTP esperado por servicio.** API `/health` 200, checkout `/p`
   200, panel `/login` 200 y worker `/health` 200. Un 500 o un 404 hacen
   fallar el arranque y muestran el log.
4. **Identidad de cada proceso.** Se guarda en `<svc>.proc`: PID, grupo,
   instante de inicio (`/proc/<pid>/stat`), `boot_id`, instancia y checkout.
   Además, el proceso hereda `FLUVIA_DEMO_INSTANCE=<prefijo>@<checkout>`.
5. **Arranque fallido.** Se limpia SOLO lo de ese intento:
   - procesos propios verificados;
   - contenedores creados en ese intento;
   - contenedores que estaban parados vuelven a pararse.

   El volumen (los datos) se conserva siempre.
6. **Sin restauraciones de archivos.** `next build` ya no modifica archivos
   versionados: `tsconfig.json` trae lo que Next exige, y `next-env.d.ts`
   está fuera de git (`next-types.d.ts` es el versionado). Si un build
   cambiara algo versionado, el arranque lo **avisa** y no restaura nada.

**Garantías de la parada (`down`)**

- Para solo los procesos cuya identidad coincide entera: instancia,
  checkout, inicio, grupo y `boot_id`. Un PID que coincide con un archivo
  antiguo pero es otro proceso (reciclado) **no se toca**; solo se retira el
  archivo obsoleto.
- Escala TERM → KILL revalidando la identidad.
- Si queda algo propio en marcha, o un contenedor no se detiene, termina con
  **código 4** y lo nombra.
- Contenedores detenidos y volumen conservado. Borrar datos es solo `purge
  --yes-delete-data`, con la instancia parada.

**Verificado en este entorno (Docker 29, Linux)**

Se probó con dos instancias simultáneas, cada una con su propio worktree:
- `fluvia-restaurantes`: 3380–3383, PG 55439, Redis 56386.
- `fluvia-otra`, una demo normal: 3390–3392, PG 55440, Redis 56387.

Resultados:
- Ambas arrancaron con los códigos esperados.
- `down` de restaurantes las paró solo a ella: `fluvia-otra` siguió en 200,
  con sus contenedores arriba, y también siguió la instancia de CI en 334x.
- Rearrancar conservó los datos, y el seed es idempotente.
- E2E de 7 escenarios contra la instancia: 7/7.
- Pruebas de seguridad de la parada:
  - PID reciclado en el mismo directorio, sin metadatos: no se tocó.
  - Metadatos de otro proceso: no se tocó.
  - Proceso propio que sobrevive a la señal (simulado): `down` → código 4.
  - Arranque con seed incompleto: se eliminaron solo los contenedores creados
    y el volumen quedó.
  - Arranque con otra instancia sirviendo desde el mismo checkout: abortó sin
    crear nada.
  - `purge` sin el argumento: se negó.

No se arrancó ni detuvo nada fuera de este entorno.

**E2E contra la instancia:**
`DEMO_APP_URL=http://127.0.0.1:3382 API_URL=http://127.0.0.1:3380
ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55439/fluvia
pnpm --filter @fluvia/dashboard exec playwright test -c
e2e/real-stack/playwright.config.ts restaurante-cobro`

## 5. Asistente del comprador: qué es real y qué es de prueba

**Real**
- **Credencial del comprador.** Es la misma de su página:
  - checkout: sesión + `client_secret`;
  - seguimiento: el token privado del pedido.

  Se valida en el servidor en cada petición.
- **Titular.** Es un id derivado del alcance. La RLS (0055 + 0062) impide que
  un comprador vea la conversación de otro.
- **Caducidad.**
  - Checkout: abierto y no vencido, o completado hace menos de 24 h.
  - Pedido: activo, o cerrado/anulado hace menos de 24 h.
- **Herramientas de solo lectura, sin ids de entrada.**
  - `get_payment_status`
  - `get_my_order`
  - `get_menu_info`: solo lo que cargó el comercio; nunca garantiza aptitud
    para alergias.
- **Acciones.** Son anclas de la propia página (`#pagar`, `#estado`,
  `#llamar`, `#pedido`). Enfocan el control real **sin tocar el hash**, que
  guarda la credencial.
- **BFF del checkout.** Cookie httpOnly por credencial con ruta propia, guarda
  CSRF (cabecera no simple + mismo origen), lista cerrada de rutas y
  streaming.
- **Transporte.** SSE para el chat, subida de fotos y notas de voz, y llamada
  WebRTC por LiveKit. La llamada del comprador se verificó en el navegador
  contra LiveKit local: «Conectada por WebRTC con el agente de PRUEBA».

**De prueba (explícito en la interfaz)**
- En local, CI y la instancia: modelo de lenguaje, transcripción y voz
  **simulados**. La interfaz muestra «Proveedor simulado» y cada respuesta
  dice «[Simulado]». El agente de voz es el agente de PRUEBA.
- Los proveedores reales se activan con `ASSISTANT_*`, `ANTHROPIC_*` y
  `SPEECH_*` (ver `docs/product/presentacion-asistente/ASISTENTE.md`).
  Sus integraciones se probaron contra servidores de contrato locales, no
  contra los servicios reales.

**Dependencia de la llamada en el checkout:** la CSP se fija al construir. Sin
`LIVEKIT_PUBLIC_URL` al hacer `next build`, la llamada falla con el aviso «No
se pudo conectar… Sigue por chat» y el chat sigue funcionando.

## 6. URLs y credenciales sintéticas (instancia `fluvia-restaurantes`)

Verificadas en el navegador contra la instancia Docker de §4 (login y pantalla
de llegada). Son credenciales de DEMO, válidas solo en local/test: el guard
del seed impide sembrarlas fuera.

| Rol | Entrar en | Credenciales | Llega a |
|---|---|---|---|
| Restaurante (dueño) | http://127.0.0.1:3382/login | `dueno@restaurante.demo.fluvia.test` / `demo-dueno-password` | `/o/ce7e7208-90f2-5ac6-a939-16ea89de5fa0` (Inicio; Negocio, Sala, Cocina, Caja) |
| Mesero | http://127.0.0.1:3382/login | `mesero@restaurante.demo.fluvia.test` / `demo-mesero-password` | `…/sala` |
| Cocina | http://127.0.0.1:3382/login | `cocina@restaurante.demo.fluvia.test` / `demo-cocina-password` | `…/cocina` (KDS, estación Cocina) |
| Caja | http://127.0.0.1:3382/login | `caja@restaurante.demo.fluvia.test` / `demo-caja-password` | `…/sala` (cobra la cuenta) |
| Independiente | http://127.0.0.1:3382/login | `independiente@demo.fluvia.test` / `demo-independiente-password` | `/o/468a41e7-c180-5f2c-99d7-97b852a41ab1/cobrar` |
| Comprador | menú QR de la mesa M1: `http://127.0.0.1:3381/m/<token>` (lo imprime `up`; el token es aleatorio por instancia) | sin cuenta | pedido → `/p#token` (seguimiento + asistente) → pago `/c/<id>#secreto` |
| Personal (cliente) | http://127.0.0.1:3382/personal/entrar | `cliente@demo.fluvia.test` / `demo-cliente-password` | `/personal` |
| Comercio minorista | http://127.0.0.1:3382/login | `owner@demo.fluvia.test` / `demo-owner-password` | Demo Store |

Usa `127.0.0.1`, no `localhost`: la protección CSRF compara el origen exacto.

## 7. Procedimiento para la MSI (Ubuntu en WSL + Docker Desktop)

Para Hermes local. Desde la nube **no se arrancó nada en la MSI**.

1. **Requisitos.**
   - En Docker Desktop: Settings → Resources → WSL integration activado para
     la distro Ubuntu.
   - Dentro de Ubuntu: `docker version` responde, Node ≥ 20 y pnpm 10
     (`corepack enable`).
2. **Checkout propio para esta instancia.** No compartas el de otra demo en
   marcha (el `next build` rompería su `.next`; el script lo detecta y
   aborta). Clónalo en el sistema de archivos de Linux, no en `/mnt/c`:
   ```
   git clone https://github.com/celestinojbm/Fluvia.git ~/fluvia-restaurantes
   cd ~/fluvia-restaurantes && git checkout claude/restaurantes-cobro-presencial
   ```
3. **Comprueba la configuración y los puertos** (no crea nada):
   ```
   scripts/instancia-restaurantes.sh config
   for p in 3380 3381 3382 3383 55439 56386; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && echo "OCUPADO $p"; done
   ```
   Si alguno está ocupado, usa otra base, por ejemplo `FLUVIA_RR_BASE=3480
   FLUVIA_RR_PG=55449 FLUVIA_RR_REDIS=56396`, y repite con esos valores.
4. **Arranca:** `scripts/instancia-restaurantes.sh up`.
   - Tarda varios minutos: instala, migra, siembra, construye y arranca.
   - Debe terminar con 4 líneas `-> 200` y el bloque del seed de restaurantes
     con la URL del menú QR.
   - Si sale con error, el motivo está en la última línea y los logs en
     `.demo-fluvia-restaurantes/`.
5. **Abre** las URLs de §6 desde el navegador de Windows (WSL reenvía
   `127.0.0.1`).
6. **Opcional: E2E** con el comando del final de §4. Requiere `psql` en
   Ubuntu.
7. **Parar:** `scripts/instancia-restaurantes.sh down`. Código 0 = todo lo
   suyo parado; código 4 = algo propio sigue en marcha (lo nombra).
8. **Borrar los datos** (solo si se quiere): `scripts/instancia-restaurantes.sh
   purge --yes-delete-data`.

No toca las demos 3302/3312/3322 ni `fluvia-asistente`: otros nombres, otros
puertos, otro checkout, y comprobación de propiedad antes de cada acción.

## 8. Validación y notas de pruebas

- **payouts-redriver** (`apps/worker/test/payouts-redriver.test.ts`). La
  prueba usa `loadConfig({ NODE_ENV: 'test' })` con un objeto explícito, así
  que **ignora** las variables de entorno y siempre usa
  `127.0.0.1:5432/fluvia`. Se comprobó esa base local: tiene 25 payouts
  `requested` antiguos y el redriver reclama lotes de 20 (`batchSize ?? 20`).
  Por eso falla de forma intermitente en una BD local de larga vida. En CI la
  BD es nueva y pasa. No es una regresión de esta rama y no se cambió aquí;
  queda en el BACKLOG.
- Pruebas `skipIf` del agente de voz (3). Necesitan un LiveKit en marcha. En
  CI corren en el job «E2E asistente (WebRTC real)»; en la suite local sin
  LiveKit aparecen como saltadas, no como superadas.
