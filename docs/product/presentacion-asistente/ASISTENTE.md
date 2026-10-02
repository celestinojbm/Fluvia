# Asistente «Fluvia» — arquitectura, proveedores, seguridad y operación

## 1. Qué hace y qué no

**Qué hace.** El asistente está en Personal y en Comercio. Responde en streaming y consulta datos con **herramientas de solo lectura**, que el servidor autoriza con la identidad de la sesión. Después propone enlaces a pantallas reales. Acepta:

- fotos, validadas en el servidor
- notas de voz, con transcripción que se puede editar
- una llamada de voz

**Qué no puede hacer.** Aprobar crédito, mover fondos, confirmar o anular pagos, emitir tarjetas ni cambiar permisos. Ninguna instrucción del chat lo permite, porque **no existe ninguna herramienta de escritura**. No basta con que las instrucciones lo prohíban. Si alguien lo pide, el asistente le lleva a la pantalla donde la persona lo hace ella misma, con su confirmación.

## 2. Piezas

| Pieza                   | Dónde                                                                   | Notas                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interfaces de proveedor | `packages/assistant/src/providers.ts`                                   | Hay una interfaz por capacidad: `ConversationProvider` (conversación+visión), `SpeechToTextProvider`, `TextToSpeechProvider` y `CallTransport`. Cada una declara `simulated`.                                              |
| Proveedores simulados   | `simulated.ts`                                                          | Son deterministas. La conversación simulada reconoce palabras clave y llama a las **mismas** herramientas de lectura. Cada respuesta empieza por «[Simulado]».                                                             |
| Conversación real       | `anthropic.ts`                                                          | API de Mensajes por SSE (`fetch`, sin SDK), según la documentación oficial «Streaming messages». Usa la clave y el modelo **del producto**.                                                                                |
| Voz real                | `speech-http.ts`                                                        | API de audio compatible con OpenAI, con el contrato de su especificación OpenAPI oficial: `/audio/transcriptions` y `/audio/speech` (`wav`).                                                                               |
| Llamada real            | `livekit.ts`                                                            | Solo emite el **token** (JWT HS256), con estructura según «Access tokens & grants» de LiveKit. Vale para una sala y una identidad, dura como máximo 15 min y no lleva permisos de administración ni de grabación.          |
| Validación de medios    | `media.ts`                                                              | Comprueba el formato real por firma de bytes. Lee dimensiones y duración del propio contenedor (JPEG/PNG/WebP; WAV/Ogg/WebM/MP4) y **elimina EXIF/XMP/comentarios**.                                                       |
| Persistencia            | `store.ts`, migración `0055_assistant.sql`                              | RLS por **tenant y titular** (`app.actor_id`). Así, dos clientes del mismo programa no ven lo del otro.                                                                                                                    |
| Almacenamiento          | `storage.ts`                                                            | Disco privado (`ASSISTANT_STORAGE_DIR`, ficheros 0600 y claves opacas). Nunca se sirve directamente: el contenido pasa por la API tras autorizar al titular, con `Cache-Control: private, no-store`.                       |
| Orquestación            | `engine.ts`                                                             | Gestiona cuota diaria, concurrencia, rondas de herramientas, cancelación con guardado parcial y errores.                                                                                                                   |
| Herramientas            | `apps/api/src/assistant-tools.ts`                                       | **Personal:** saldo, crédito, próximas cuotas, tarjetas (solo últimos 4 dígitos), actividad y directorio. **Comercio:** resumen de 7 días, cobros por confirmar y estado del directorio. Ninguna acepta ids en su entrada. |
| Rutas                   | `apps/api/src/routes/assistant.ts`                                      | `/v1/personal/assistant/*` (sesión del cliente) y `/v1/organizations/:org/assistant/*` (sesión de operador + `payments:read`).                                                                                             |
| BFF                     | `apps/dashboard/app/lib/assistant-bff.ts`                               | Lista cerrada de rutas, CSRF y streaming. Propaga la cancelación.                                                                                                                                                          |
| UI                      | `apps/dashboard/app/lib/assistant/`                                     | Panel, nota de voz y llamada.                                                                                                                                                                                              |
| Retención               | `apps/worker/src/assistant-retention.ts` + `purge_assistant_data(días)` | Solo el rol del worker puede ejecutarla.                                                                                                                                                                                   |

## 3. Datos: qué se guarda, cuánto tiempo y cómo se borra

| Dato                | Se guarda                                                                                                    | Retención                                                                                | Borrado                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Mensajes            | Texto. Si el mensaje contiene un número de tarjeta válido (Luhn) o un CVV, se **elimina antes de guardarlo** | `ASSISTANT_RETENTION_DAYS` (30 por defecto) desde la última actividad de la conversación | Purga del worker                                                                                         |
| Fotos               | Sin metadatos, en almacenamiento privado                                                                     | Igual que los mensajes. Si no se envían, 1 día                                           | La persona puede **borrarlas antes de enviar** (fichero eliminado al momento). Después, purga del worker |
| Notas de voz        | Solo mientras se transcriben                                                                                 | Ninguna                                                                                  | **Se borran justo después de transcribir.** Lo que llega al asistente es la transcripción revisada       |
| Audio de la llamada | Igual que las notas: cada turno se transcribe y se borra                                                     | Ninguna                                                                                  | Igual que las notas                                                                                      |
| Logs                | Solo códigos y contadores                                                                                    | Los del despliegue                                                                       | Nunca se registran contenidos, ficheros, tokens ni claves                                                |

## 4. Variables de entorno (sin secretos)

| Variable                                                                                                       | Por defecto             | Efecto                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASSISTANT_PROVIDER`                                                                                           | (vacío)                 | Con valor `anthropic` y **también** `ANTHROPIC_API_KEY` y `ASSISTANT_MODEL`, usa la conversación real. Si falta cualquiera, usa la simulada                                            |
| `ANTHROPIC_API_KEY`, `ASSISTANT_MODEL`, `ANTHROPIC_BASE_URL`                                                   | —, —, API pública       | Credencial y modelo del **producto**. No hay modelo por defecto: hay que elegirlo                                                                                                      |
| `ASSISTANT_SPEECH_PROVIDER`                                                                                    | (vacío)                 | `openai_compatible` + `SPEECH_API_KEY`, `SPEECH_BASE_URL`, `SPEECH_STT_MODEL`, `SPEECH_TTS_MODEL`, `SPEECH_TTS_VOICE`                                                                  |
| `ASSISTANT_CALL_PROVIDER`                                                                                      | (vacío)                 | `livekit` + `LIVEKIT_URL` (la del navegador), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ASSISTANT_AGENT_URL` y `ASSISTANT_AGENT_SECRET`. Si falta alguna, la llamada es local simulada |
| `LIVEKIT_PUBLIC_URL` (panel, **al construir**)                                                                 | (vacío)                 | Añade ese origen a `connect-src` de la CSP                                                                                                                                             |
| Agente: `LIVEKIT_INTERNAL_URL`, `AGENT_CONTROL_SECRET` (≥ 24), `AGENT_HOST`/`AGENT_PORT`, `AGENT_MAX_SESSIONS` | —, —, 127.0.0.1/3366, 4 | Voz real del agente con las mismas `ASSISTANT_SPEECH_PROVIDER` + `SPEECH_*`                                                                                                            |
| `ASSISTANT_REQUESTS_PER_MINUTE`                                                                                | 60                      | Peticiones por titular/minuto (organización ×10)                                                                                                                                       |
| `WORKER_METRICS_HOST`                                                                                          | 0.0.0.0                 | En demos, `127.0.0.1`                                                                                                                                                                  |
| `ASSISTANT_STORAGE_DIR`                                                                                        | `.data/assistant`       | Directorio privado, el mismo para la API y el worker                                                                                                                                   |
| `ASSISTANT_MESSAGES_PER_DAY` · `ASSISTANT_CONCURRENT_STREAMS` · `ASSISTANT_MAX_INPUT_CHARS`                    | 200 · 1 · 2000          | Uso                                                                                                                                                                                    |
| `ASSISTANT_MAX_IMAGE_BYTES` · `ASSISTANT_MAX_IMAGE_PIXELS` · `ASSISTANT_MAX_IMAGES_PER_MESSAGE`                | 5 MiB · 40 MP · 3       | Fotos                                                                                                                                                                                  |
| `ASSISTANT_MAX_AUDIO_BYTES` · `ASSISTANT_MAX_AUDIO_SECONDS` · `ASSISTANT_MAX_CALL_SECONDS`                     | 4 MiB · 120 · 600       | Voz y llamada                                                                                                                                                                          |
| `ASSISTANT_RETENTION_DAYS` · `ASSISTANT_MAX_OUTPUT_TOKENS` · `ASSISTANT_MAX_TOOL_ROUNDS`                       | 30 · 700 · 3            | Retención, longitud y coste                                                                                                                                                            |

**Nunca** se usan la sesión ni los créditos de una herramienta de desarrollo (por ejemplo, Claude Code) como credencial del asistente del producto.

## 5. Activación de los proveedores reales (paso exacto)

1. **Conversación y visión.**
   - Crea una clave de API **del producto** en la consola del proveedor.
   - Exporta en la API `ASSISTANT_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=…` y `ASSISTANT_MODEL=<modelo elegido>`. Elige un modelo con visión y uso de herramientas.
   - Reinicia la API. `GET …/assistant/status` debe devolver `conversation.simulated: false`.
2. **Voz.**
   - Elige un proveedor con API compatible con `/audio/transcriptions` y `/audio/speech`.
   - Exporta `ASSISTANT_SPEECH_PROVIDER=openai_compatible` y las cinco variables `SPEECH_*`.
   - Reinicia la API.
3. **Llamada.**
   - Despliega LiveKit (autoalojado o Cloud) y `apps/voice-agent`, en la misma red privada que la API. El control del agente solo escucha en loopback o en red privada.
   - Exporta en la API: `ASSISTANT_CALL_PROVIDER=livekit`, `LIVEKIT_URL=wss://…`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ASSISTANT_AGENT_URL` y `ASSISTANT_AGENT_SECRET`.
   - En el agente exporta: `LIVEKIT_INTERNAL_URL`, las mismas claves de LiveKit, `AGENT_CONTROL_SECRET` (el mismo secreto) y, para voz real, `ASSISTANT_SPEECH_PROVIDER` + `SPEECH_*`.
   - Construye el panel con `LIVEKIT_PUBLIC_URL=wss://…`, para la CSP.
   - En producción hace falta TURN si los clientes están tras NAT estricto. No está probado aquí.

### Flujo de la llamada

1. El navegador pide permiso de micrófono. Si se deniega, no se pide sala.
2. `POST …/call/token`: la API despacha al agente a una sala nueva, para esa identidad. Solo si el agente responde, emite un token de vida corta, de solo micrófono y para esa sala.
3. El navegador entra y publica el micrófono. El agente escucha **solo** a esa identidad.
4. El agente detecta turnos (umbral adaptativo al ruido), transcribe y envía el texto por el canal de datos.
5. El panel envía el texto a la **misma conversación** del chat. La conversación usa la sesión de la persona y herramientas de solo lectura.
6. El panel manda la respuesta al agente, que la dice. Si la persona habla mientras el agente habla, el agente se calla (interrupción).
7. **El agente no tiene credenciales de Fluvia ni acceso a datos.** Solo oye, transcribe y habla.
8. Al colgar se envía «bye», el agente sale y se libera el micrófono. Si la persona se va sin colgar, el agente espera 20 s por si vuelve (reconexión completa) y luego sale.

## 6. Evaluación de LiveKit Agents

**Elección.** LiveKit cubre lo que pide la llamada sin construir un SFU propio:

- WebRTC con reconexión
- detección de turno e interrupción en el agente
- tokens por sala y vida corta
- servidor libre (Apache-2.0) o servicio gestionado

**En contra:**

- Hace falta un **proceso agente** aparte (Python o Node), con su despliegue y monitorización.
- Se depende de una pieza de infraestructura más. LiveKit Cloud tiene coste por minuto de participante. Autoalojado necesita TURN.
- La latencia final depende de la cadena STT → modelo → TTS. Un modelo «realtime» de voz a voz la reduce, pero ata a un proveedor.

**Alternativa descartada por ahora:** WebRTC directo contra la API de voz en tiempo real de un proveedor. Es menos infraestructura, pero ata la llamada a un solo proveedor y deja las herramientas y la autorización en el navegador o en un relay propio.

**Hecho.**

- **Implementado:** servidor LiveKit, agente propio (`@livekit/rtc-node`) y cliente del panel (`livekit-client`). Se eligió un agente propio en vez del marco LiveKit Agents: pocas piezas, sin credenciales de Fluvia en el agente, y misma lógica de herramientas y autorización en la API.
- **Verificado:**
  - transporte WebRTC y audio en ambos sentidos
  - interrupción
  - reconexión: cierre de señalización, reconexión completa y congelación real del servidor
  - colgar

  Los entornos y pruebas son:
  - navegador real: `llamada-webrtc.spec.ts`
  - cliente `rtc-node`: `webrtc.integration.test.ts` y `speech-contract.integration.test.ts`
  - CI: job `e2e-assistant`

- **No verificado:** conversación inteligente por voz con proveedores externos. Falta X-01 y X-02.

### Robustez del agente y de los turnos

- Cada tarea asíncrona de una llamada (hablar, transcribir, escuchar, colgar) pasa por `CallSession.task()`: un fallo se registra con su sala y limpia el estado de **esa** sesión (deja de «hablar» y avisa). El manejador global de rechazos no es la red de seguridad: si algo llega allí, se registra como error y se cuenta en `/health` (`unhandled`), sin ocultarlo.
- Un turno del chat lleva `client_message_id`. Reintentar el mismo turno nunca crea otro mensaje de usuario: si la respuesta ya estaba completa se reproduce (sin proveedor ni herramientas); si se cortó o falló, se regenera sobre el mismo mensaje y sin consumir cuota. La misma clave con otro texto es un 409.

## 7. Coste operativo estimado (supuestos explícitos)

Son órdenes de magnitud para decidir, **no precios**: consulta las tarifas vigentes de cada proveedor antes de activarlo.

Supuestos:

- 1.000 usuarios activos al mes
- 20 mensajes por usuario y mes
- unos 2.500 tokens de entrada (instrucciones, historial y resultados de herramientas) y 300 de salida por mensaje
- un 10 % de mensajes con una foto (≈ 1.500 tokens de imagen)
- un 15 % de usuarios graban 5 notas de 20 s al mes
- un 5 % de usuarios hacen 2 llamadas de 3 min al mes

| Partida               | Volumen mensual                                                            | Fórmula                                                                         |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Conversación          | 20.000 mensajes → ~50 M tokens de entrada + 6 M de salida (+3 M de imagen) | (entrada × precio de entrada + salida × precio de salida) del modelo elegido    |
| Transcripción (notas) | 150 usuarios × 5 × 20 s ≈ 250 min                                          | minutos × precio por minuto de STT                                              |
| Voz (respuestas)      | Opcional; depende del uso de «Escuchar»                                    | caracteres × precio por carácter de TTS                                         |
| Llamadas              | 50 usuarios × 2 × 3 min = 300 min                                          | minutos × (STT + TTS + tokens del modelo + minutos de LiveKit por participante) |
| Almacenamiento        | Fotos: 2.000 × ~0,5 MB ≈ 1 GB, retenidas 30 días                           | Despreciable frente a lo anterior                                               |

**Palancas:** `ASSISTANT_MESSAGES_PER_DAY`, `ASSISTANT_MAX_OUTPUT_TOKENS`, `ASSISTANT_MAX_TOOL_ROUNDS`, el historial enviado (20 mensajes), `ASSISTANT_MAX_CALL_SECONDS` y la caché de instrucciones del proveedor, si existe.

## 8. Pruebas

- `packages/assistant/test/unit.test.ts` (24):
  - medios reales, incluida una grabación real de MediaRecorder sin duración en cabecera
  - política
  - token de LiveKit
  - parser SSE
  - simulador
- `apps/api/test/assistant-routes.test.ts` (19, PostgreSQL real):
  - aislamiento entre clientes del mismo programa y entre organizaciones (API, almacenamiento y RLS)
  - streaming y herramientas
  - orden de mover dinero, que no se ejecuta
  - tarjeta eliminada del texto
  - fotos: EXIF, 415 y borrado
  - voz: duración, borrado tras transcribir y 422 por longitud
  - cuota 429
  - cancelación con guardado parcial
  - purga solo para el worker
- `apps/dashboard/e2e/real-stack/presentacion-asistente.spec.ts` (navegador real, stack local):
  - chat, foco y historial
  - fotos
  - nota de voz
  - permiso denegado
  - llamada con interrupción y micrófono liberado
  - planos separados
