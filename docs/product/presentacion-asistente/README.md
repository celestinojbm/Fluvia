# Jornada «presentación comercial, nuevas secciones y asistente multimodal» — entrega

- **Rama:** `claude/presentacion-asistente-fluvia`, apilada sobre `claude/diseno-identidad-menta` (`2142be8`, PR #67).
- **PR:** borrador #68.
- **Estado vivo:** [`BACKLOG.md`](BACKLOG.md).
- **Asistente:** [`ASISTENTE.md`](ASISTENTE.md) (arquitectura, datos, variables, activación, evaluación de LiveKit, coste).
- **Imágenes:** [`imagenes.md`](imagenes.md) (procedencia y licencias).
- **Imágenes de referencia 1 y 2:** **no llegaron a la sesión**. No se compara la composición con ellas. Se aplicaron las especificaciones escritas.

## 1. Pantalla → función → API/proveedor → prueba → estado real

| Pantalla                                              | Función                                                                                                                                       | API / proveedor                                                                              | Prueba                                        | Estado real                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `/` (sin sesión)                                      | Portada, entradas Personas/Comercios, carril de categorías                                                                                    | —                                                                                            | E2E `presentacion-asistente` @390/768/1440    | Entregado                                                                        |
| `/donde-comprar`                                      | Búsqueda, ciudad, categorías, estados vacío/error, paginación                                                                                 | `GET /v1/public/directory`, `/cities`                                                        | `directory-routes.test.ts` (12) + E2E         | Entregado                                                                        |
| `/donde-comprar/:slug`                                | Ficha pública (solo datos redactados por el comercio; «Demo»)                                                                                 | `GET /v1/public/directory/:slug`                                                             | API + E2E (404 si no existe o se retira)      | Entregado                                                                        |
| `/conoce/{billetera,tarjeta,cuotas}`                  | Explicadores con las condiciones de la **política activa**                                                                                    | `GET /v1/public/programs/:id/terms`                                                          | `personal-journey.test.ts` + E2E              | Entregado (política sintética, declarada así)                                    |
| `/como-funciona`, `/comercios`, `/ayuda`, `/creditos` | Pasos enlazados a pantallas reales; guías; créditos y licencias                                                                               | —                                                                                            | E2E (navegación), revisión de enlaces         | Entregado                                                                        |
| `/o/:org/directorio`                                  | Editor del perfil público; publicar con confirmación; retirar                                                                                 | `PUT/POST /v1/organizations/:org/directory/profiles/:merchant(/publish\|/hide)`              | API (RBAC, versión, auditoría) + E2E          | Entregado                                                                        |
| `/personal` (inicio)                                  | «Descubre dónde comprar», aparte del dinero                                                                                                   | directorio público                                                                           | captura 390/768/1440, sin scroll horizontal   | Entregado                                                                        |
| `/o/:org` (inicio)                                    | Tarea opcional «no apareces en Dónde comprar»                                                                                                 | `GET …/directory/profiles`                                                                   | unitarias del panel                           | Entregado                                                                        |
| Asistente (Personal y Comercio)                       | Panel, streaming, detener, reintentar, historial, acciones, IA/simulado                                                                       | `/v1/personal/assistant/*`, `/v1/organizations/:org/assistant/*` · conversación **simulada** | `assistant-routes.test.ts` (19) + E2E         | Entregado con **proveedor simulado**                                             |
| Fotos en el asistente                                 | Archivo o cámara, vista previa, progreso, borrar antes de enviar                                                                              | `POST …/attachments` (validación por contenido, EXIF eliminado)                              | unitarias de medios + API + E2E               | Entregado. La visión real depende de X-01                                        |
| Notas de voz                                          | Grabar, detener, escuchar, borrar, transcribir y editar                                                                                       | `POST …/transcriptions` · STT **simulado**                                                   | unitarias (WAV/Ogg/WebM real/MP4) + API + E2E | Entregado con **STT simulado**                                                   |
| Respuesta hablada                                     | «Escuchar» (el texto sigue disponible)                                                                                                        | `POST …/speech` · TTS **simulado** (tono)                                                    | API                                           | Entregado con **TTS simulado**                                                   |
| «Hablar con Fluvia»                                   | Consentimiento, estados, silencio, colgar, dispositivo, interrupción, transcripción, foto y pantalla voluntarias, resumen, micrófono liberado | `POST …/call/token` · transporte **simulado** (llamada local)                                | E2E con audio falso de locuciones             | **Simulada**. La llamada real está bloqueada por X-03 (y falta `livekit-client`) |

## 2. Implementado, de prueba o bloqueado

| Capacidad                                         | Implementado y verificado                                                                                                                                                                                                                                                                                         | De prueba (determinista, etiquetado)                                                                    | Bloqueado y por qué                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Conversación + visión                             | Adaptador Anthropic (SSE, herramientas, imagen) probado contra un **servidor de contrato** local que valida el protocolo                                                                                                                                                                                          | Proveedor simulado (sin claves)                                                                         | Proveedor real **no verificado**: no hay clave del producto (X-01)                                        |
| STT / TTS                                         | Adaptador compatible con OpenAI (multipart, WAV) probado por la API **y por el agente en una llamada WebRTC** contra servidor de contrato                                                                                                                                                                         | Voz/transcripción de prueba                                                                             | Proveedor real **no verificado** (X-02)                                                                   |
| Llamada WebRTC                                    | **Transporte y audio reales**: navegador (`livekit-client`) ⇄ LiveKit 1.13.7 ⇄ agente (`apps/voice-agent`); token por sala con despacho del agente; consentimiento, silencio, interrupción, reconexión (señal, completa y corte real del servidor), foto, colgar con micrófono liberado; E2E en navegador y en CI | Agente de **prueba**: transcribe con duración y habla con tono sintético, etiquetado «Agente de prueba» | Conversación inteligente por voz con proveedor externo: no ejecutada (X-01, X-02)                         |
| Llamada sin servidor de llamadas                  | Modo local simulado (sin WebRTC), solo si no hay LiveKit configurado y dicho en pantalla                                                                                                                                                                                                                          | —                                                                                                       | —                                                                                                         |
| Concurrencia y límites                            | Concurrencia por titular en Redis (varias réplicas, prueba con dos réplicas reales); límites por titular y organización autenticados                                                                                                                                                                              | —                                                                                                       | El directorio **público** (sin sesión) sigue limitado por la IP que ve la API, que es la del panel (T-03) |
| Audio                                             | Duración leída del contenedor, MP4 fragmentado incluido; duración desconocida → 422                                                                                                                                                                                                                               | —                                                                                                       | —                                                                                                         |
| Adjuntos                                          | Disco privado local                                                                                                                                                                                                                                                                                               | —                                                                                                       | Almacén de objetos de producción (X-04)                                                                   |
| Directorio, explicadores, herramientas, retención | Real en este stack                                                                                                                                                                                                                                                                                                | —                                                                                                       | —                                                                                                         |

No se afirma ninguna conversación ni llamada inteligente hecha con un proveedor de prueba.

## 3. Recursos incorporados y licencias

| Recurso                                                 | Licencia                                                                         | Decisión                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 10 fotos (`apps/dashboard/public/presentacion/`)        | CC0 1.0, verificada en origen                                                    | Sin personas reconocibles ni marcas. Ver `imagenes.md`                                                                    |
| Iconos nuevos (Lucide, ya incluido)                     | ISC                                                                              | Sin dependencia nueva                                                                                                     |
| Muestras de prueba (`packages/assistant/test/fixtures`) | Propias (generadas con ffmpeg/ImageMagick y una grabación sintética de Chromium) | Solo para pruebas                                                                                                         |
| Adaptadores Anthropic, OpenAI-compatible y LiveKit      | —                                                                                | **Sin SDK**: `fetch` y `crypto` de Node. No hay dependencias de ejecución nuevas. El gate de licencias pasa en `--strict` |
| `livekit-client` 2.22.3 (panel, carga diferida)         | Apache-2.0                                                                       | Incorporado; licencias `--strict` OK                                                                                      |
| `@livekit/rtc-node` 1.1.0 (agente de voz)               | Apache-2.0                                                                       | Incorporado; binario nativo por npm                                                                                       |
| Servidor LiveKit 1.13.7                                 | Apache-2.0                                                                       | Imagen `livekit/livekit-server:v1.13.7` en demo y CI (en este entorno se compiló desde el módulo Go oficial)              |

## 4. Verificación

Ver la sección «Resultados» del PR y `BACKLOG.md`. Comprobaciones:

- unitarias del panel
- `packages/assistant`
- suite completa de la API (PostgreSQL real)
- E2E de la jornada (390/768/1440)
- regresión de checkout, devoluciones y justificante
- a11y con axe de las pantallas nuevas
- CI del PR

## 5. Instancia `fluvia-asistente` (procedimiento para Hermes local)

Nada de esto se ha arrancado desde la nube en tu MSI. Hermes lo ejecuta en local. Usa un checkout propio, su prefijo, sus puertos, sus logs, su volumen y su contenedor de LiveKit. No toca las demos de 3302/3312/3322 ni las otras instancias.

| Servicio                          | Puerto (solo 127.0.0.1) |
| --------------------------------- | ----------------------- |
| API · checkout · panel            | 3360 · 3361 · 3362      |
| LiveKit señal · RTC TCP · RTC UDP | 3363 · 3364 · 3365/udp  |
| Agente de voz (control)           | 3366                    |
| Métricas del worker               | 3369                    |
| PostgreSQL · Redis                | 55438 · 56385           |

```bash
# 1. Checkout propio en el SHA del PR
git clone https://github.com/celestinojbm/Fluvia.git ~/fluvia-asistente && cd ~/fluvia-asistente
git checkout <SHA del PR #68>
# 2. Ver la configuración resuelta (no arranca nada)
export DEMO_PREFIX=fluvia-asistente DEMO_PORT_BASE=3360 DEMO_PG_PORT=55438 DEMO_REDIS_PORT=56385
DEMO_WITH_CALL=1 DEMO_PRINT_CONFIG=1 scripts/demo/start-local-demo.sh
# 3. Arrancar (comprueba puertos TCP y UDP y pertenencia ANTES de crear nada)
DEMO_WITH_WORKER=1 DEMO_WITH_CALL=1 scripts/demo/start-local-demo.sh
# 4. Parar SOLO esta instancia (conserva volumen y contenedores)
scripts/demo/stop-local-demo.sh
# Borrar sus datos (aparte y explícito):
# scripts/demo/purge-local-demo.sh --yes-delete-data
```

- **Claves de la llamada:** se generan una vez en `.demo-fluvia-asistente/call/` (0700; `secrets.env` 0600). Llegan a la API y al agente por el entorno, no por la línea de órdenes.
- **Propiedad de procesos:** cada servicio (API, checkout, panel, worker y agente) tiene su PID en el estado de la instancia. La parada verifica el cwd antes de actuar.
- **Probar la llamada:** Personal → «Pregunta a Fluvia» → «Hablar con Fluvia». Debe decir «Agente de prueba» salvo que exportes `ASSISTANT_SPEECH_PROVIDER` y `SPEECH_*` antes del paso 3.
- **Limitaciones de lo verificado:**
  - El script no se ha ejecutado de principio a fin aquí, porque este entorno no tiene Docker. Sí se verificó:
    - la configuración resuelta
    - el rechazo por puerto TCP y UDP ocupado, antes de crear estado
    - la generación de claves y permisos
    - que el `livekit.yaml` generado funciona con el servidor LiveKit real y la prueba WebRTC del agente
  - En Docker Desktop (Windows/WSL) los puertos UDP publicados en 127.0.0.1 suelen funcionar. Si el audio no llega, el cliente cae a TCP (3364).
