# Fluvia — dirección visual por superficie (Comercios, Personal, Operaciones)

> **Sustituido (2026-10-02)** por la identidad «Menta»: [`identidad-menta.md`](identidad-menta.md). Se conserva como histórico; sus colores y composiciones ya no se aplican.

Registrada antes de construir las pantallas de la jornada integral. Amplía «Corriente» ([`fluvia-visual-direction.md`](fluvia-visual-direction.md)): **misma identidad** (tokens `--fx-*`, marca de ondas, pila tipográfica del sistema, iconos SVG propios, CSP sin recursos externos) y **una composición distinta por superficie**, porque cada una sirve una tarea distinta.

Skills de diseño: en este entorno no hay skills de diseño de interfaz instaladas para el código del panel (las disponibles generan artefactos, presentaciones o documentos). No se usaron; la dirección se aplica a mano sobre los tokens existentes.

## 1. Identidad compartida

| Elemento   | Regla                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Marca      | Ondas río + sol (`FluviaMark`), palabra «Fluvia» + nombre de la superficie («Personal», «Operaciones»)                                   |
| Tipografía | Pila del sistema; cifras con `tabular-nums`; una cifra protagonista por pantalla                                                         |
| Color      | Tokens «Corriente». Nuevo token **`--px-credit` `#2c4a9a`** (índigo, 8.1:1 sobre blanco) solo para **crédito**; nunca para dinero propio |
| Estados    | Punto + palabra (+ icono donde aporta). Nunca solo color                                                                                 |
| Importes   | Unidades menores → `formatAmount` exacto (sin coma flotante), con código ISO cuando el símbolo es ambiguo (Bs. VES)                      |
| Foco       | Anillo `--fx-focus` 3 px; «Saltar al contenido» primero                                                                                  |
| Sandbox    | Aviso discreto pero permanente: datos sintéticos, proveedores simulados, sin dinero real                                                 |

## 2. Fluvia Personal — «Remanso» (aplicación financiera)

- **Composición**: una columna de lectura (máx. 72rem). Móvil/tablet: **barra de pestañas inferior** fija (Inicio, Movimientos, Tarjetas, Cuotas, Más); escritorio ≥ 1024 px: **riel lateral estrecho** con las mismas secciones + Crédito y Perfil.
- **Inicio**: banda protagonista oscura (`--fx-deep`) con **saldo propio disponible**; debajo, una **barra de composición** que separa visualmente _propio disponible_, _retenido_ y _garantía bloqueada_ (los tres son del cliente) y, en un bloque aparte con borde índigo, el **crédito** (límite, usado, reservado, disponible) con la frase «el crédito no es saldo propio». Luego **próximos pagos** como lista con fecha en chip, y **actividad** reciente.
- **Tarjeta**: representación gráfica (verde profundo, `•••• 1234`, sin número ni CVV) y controles como lista de interruptores/acciones (bloquear, límites, reemplazar, ver datos en componente seguro del emisor).
- **Formularios**: un paso por pantalla; importe grande; confirmación explícita antes de mover dinero; mensajes de error del catálogo traducidos; resultado incierto ⇒ «no sabemos si se aplicó; comprueba antes de repetir».
- **Tono**: segunda persona, frases cortas, sin jerga («Garantía bloqueada», «Te queda por pagar»).

## 3. Fluvia Operaciones — «Sala de control» (investigar y actuar)

- **Composición**: barra superior oscura con programa, buscador global de clientes y operador; navegación lateral compacta clara; contenido ancho (máx. 96rem).
- **Resumen**: **franja de colas** (revisiones, casos abiertos, inciertos, eventos sin objeto, aprobaciones) como contadores-enlace, seguida de una **tabla por moneda** (propio, retenido, garantía, deuda, límites, reservado, obligación con la red, vencido). Sin tarjetas iguales.
- **Ficha 360 del cliente**: cabecera de identidad con estado y perfil sintético; **dos paneles**: a la izquierda secciones ancladas (saldos, crédito, tarjetas, compras y cuotas, movimientos, casos, auditoría) y a la derecha **panel de acciones** con motivo obligatorio y **step-up** (contraseña) cuando el servidor lo exige.
- **Tablas**: cabecera fija, filas compactas (40 px), estados con punto + palabra, importes alineados a la derecha, filtros arriba, vacío explicativo.
- **Acciones sensibles**: diálogo de confirmación con motivo; si el servidor responde `mfa_step_up_required`, el diálogo pide la contraseña y reintenta; doble aprobación visible («propuesto por… · falta otra persona»).

## 4. Fluvia Comercios — continuidad

Sin cambios de composición: «Corriente» (panel, mostrador, ventas). Se añaden el método **«Fluvia Personal»** en el checkout (código de pago de un solo uso) y la pantalla **«Por confirmar»** (cobros y devoluciones inciertos con resolución por consulta verificable).

## 5. Responsive y accesibilidad

390 / 768 / 1440 px sin scroll horizontal: tablas que se convierten en listas apiladas por debajo de 768 px; barra inferior en Personal hasta 1023 px. Teclado: todo accionable con Tab/Enter/Espacio; diálogos con foco atrapado y Escape. Estados: **carga** (esqueleto), **vacío** (explica qué hacer), **error** (qué pasó y qué hacer), **sesión caducada** (pantalla propia con enlace a entrar).
