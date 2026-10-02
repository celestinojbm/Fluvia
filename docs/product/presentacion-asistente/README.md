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

## 2. Real, de prueba o bloqueado

| Capacidad                                                  | Ahora                                          | Para que sea real                                                       |
| ---------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Conversación + visión                                      | **Proveedor de prueba** (simulado, etiquetado) | `ASSISTANT_PROVIDER=anthropic` + clave y modelo **del producto** (X-01) |
| Transcripción (STT) / voz (TTS)                            | **Proveedor de prueba**                        | `ASSISTANT_SPEECH_PROVIDER=openai_compatible` + `SPEECH_*` (X-02)       |
| Llamada WebRTC                                             | **Llamada simulada local**                     | Servidor LiveKit + agente + `livekit-client` en el panel (X-03)         |
| Almacenamiento de adjuntos                                 | Disco privado local                            | Almacén de objetos privado y cifrado (X-04)                             |
| Directorio, explicadores, herramientas, límites, retención | **Real** (en este stack)                       | —                                                                       |

No se afirma ninguna conversación ni llamada real hecha con un proveedor simulado.

## 3. Recursos incorporados y licencias

| Recurso                                                 | Licencia                                                                         | Decisión                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 10 fotos (`apps/dashboard/public/presentacion/`)        | CC0 1.0, verificada en origen                                                    | Sin personas reconocibles ni marcas. Ver `imagenes.md`                                                                    |
| Iconos nuevos (Lucide, ya incluido)                     | ISC                                                                              | Sin dependencia nueva                                                                                                     |
| Muestras de prueba (`packages/assistant/test/fixtures`) | Propias (generadas con ffmpeg/ImageMagick y una grabación sintética de Chromium) | Solo para pruebas                                                                                                         |
| Adaptadores Anthropic, OpenAI-compatible y LiveKit      | —                                                                                | **Sin SDK**: `fetch` y `crypto` de Node. No hay dependencias de ejecución nuevas. El gate de licencias pasa en `--strict` |
| `livekit-client`                                        | Apache-2.0                                                                       | **No incorporado** todavía: no hay servidor contra el que probarlo                                                        |

## 4. Verificación

Ver la sección «Resultados» del PR y `BACKLOG.md`. Comprobaciones:

- unitarias del panel
- `packages/assistant`
- suite completa de la API (PostgreSQL real)
- E2E de la jornada (390/768/1440)
- regresión de checkout, devoluciones y justificante
- a11y con axe de las pantallas nuevas
- CI del PR

## 5. Instancia independiente

Usa su propio checkout, prefijo, puertos, logs y volúmenes. No toca las demos existentes (3302/3312/3322 ni las otras instancias). Elige un prefijo y una base de puertos libres. Ejemplo:

```bash
git clone https://github.com/celestinojbm/Fluvia.git fluvia-asistente && cd fluvia-asistente
git checkout claude/presentacion-asistente-fluvia   # comprobar el SHA entregado en el PR
ss -ltn | grep -E ':(3360|3361|3362|3369|55438|56385)\b'   # no debe imprimir nada
pnpm install --frozen-lockfile
DEMO_PREFIX=fluvia-asistente DEMO_PORT_BASE=3360 DEMO_PG_PORT=55438 DEMO_REDIS_PORT=56385 \
  DEMO_WITH_WORKER=1 scripts/demo/start-local-demo.sh
# Parar SOLO esta instancia (conserva su volumen):
DEMO_PREFIX=fluvia-asistente scripts/demo/stop-local-demo.sh
```

- **Portada:** `http://127.0.0.1:3362/`
- **Personal:** `http://127.0.0.1:3362/personal/entrar`
- **Comercio:** `http://127.0.0.1:3362/login`
- **Credenciales de demostración:** las mismas del seed. Ver la salida del script.
- **Adjuntos del asistente:** `.demo-fluvia-asistente/assistant`, privado y propio de la instancia.
- **Proveedores:** simulados, salvo que exportes las variables de `ASISTENTE.md` §4 antes de arrancar.
