# Fluvia — identidad «Menta» y sistema de diseño

Sustituye a «Corriente» ([`fluvia-visual-direction.md`](fluvia-visual-direction.md)) y a las composiciones de [`fluvia-surfaces.md`](fluvia-surfaces.md). Se aplica a Comercios, Personal, Operaciones, checkout, tarjeta y justificante.

## 1. Referencia y paleta

- **Paleta:** la fijó el encargo con valores exactos («precisión obligatoria»).
- **Imagen de referencia:** no llegó a esta sesión. No se extrajo ningún color de ella ni se pudo comparar la composición con ella.
- **Tipografía de la referencia:** no se intentó identificar.

| Token            | Valor     | Uso                                                                                       |
| ---------------- | --------- | ----------------------------------------------------------------------------------------- |
| `--fl-mint`      | `#B2FCE4` | Lienzo de las tres superficies y del checkout; marca. RGB 178 252 228                     |
| `--fl-black`     | `#000000` | Texto principal, botones primarios, identidad, barra sandbox                              |
| `--fl-white`     | `#FFFFFF` | Superficies de lectura: tablas, formularios, paneles                                      |
| `--fl-ink-2`     | `#404040` | Texto secundario (8.9:1 sobre menta, 10.4:1 sobre blanco); borde de campos (≥ 3:1)        |
| `--fl-line`      | `#D9E2DE` | Divisores decorativos. **No** delimita controles: con 1.32:1 sobre blanco no llega al 3:1 |
| `--fl-surface-2` | `#F4F7F6` | Cabeceras de tabla y zonas hundidas sobre blanco                                          |
| `--fl-ok`        | `#146C2E` | Confirmado                                                                                |
| `--fl-warn`      | `#8A4B00` | Aviso / retenido                                                                          |
| `--fl-bad`       | `#B42318` | Error / bloquear; `--fl-bad-on-dark #FF9D90` sobre negro                                  |
| `--fl-credit`    | `#2C4A9A` | **Solo** crédito; nunca dinero propio                                                     |
| `--fl-sim`       | `#5A3B9C` | Simulación / proveedor simulado                                                           |

**Fuente única de los tokens:** `apps/dashboard/app/brand.css`. Existe una copia idéntica en `apps/checkout/app/brand.css`.

- Los nombres antiguos (`--fx-*`, `--bg`, `--brand`, `--canvas`…) apuntan a estos tokens, así que ninguna pantalla conserva arena ni verde azulado.
- Ninguna hoja de pantalla define colores en `:root`.
- `test/brand-tokens.test.ts` verifica:
  - que las dos copias son iguales
  - la paleta exacta
  - 22 pares texto/fondo (≥ 4.5:1 para texto, ≥ 3:1 para bordes de control)
  - la ausencia de los colores anteriores en cada hoja

**Decisión discutible:** el encargo pedía «bordes neutros #D9E2DE». Se usa así en divisores. En campos de formulario se usa `#404040`, porque `#D9E2DE` no cumple WCAG 1.4.11 para identificar un control.

## 2. Tipografía

**Manrope**, de [@fontsource-variable/manrope](https://github.com/fontsource/font-files) 5.3.0. Licencia OFL-1.1, copyright The Manrope Project Authors. Se sirve desde `/_next/static`, sin peticiones externas (la CSP mantiene `font-src 'self'`).

| Rol                | Tamaño / peso                        | Notas                             |
| ------------------ | ------------------------------------ | --------------------------------- |
| Cifra protagonista | clamp(2.5–4.5 rem) / 800, −0.04 em   | `tabular-nums`, interlineado 1    |
| Título de página   | clamp(1.75–2.25 rem) / 800, −0.03 em |                                   |
| Sección            | 1.0625–1.25 rem / 800                |                                   |
| Texto              | 0.9375 rem / 500, 1.55               |                                   |
| Etiqueta           | 0.75 rem / 800, +0.1 em, versalitas  |                                   |
| Tablas             | 0.8125–0.9 rem; importes 750–800     | Alineados a la derecha, tabulares |

## 3. Marca

Original para este encargo. **No es una marca registrada ni se ha comprobado jurídicamente** (búsqueda de anterioridades pendiente). No reutiliza el símbolo, las flechas ni las letras de Afterpay.

**Símbolo «meandro».** Una pieza de 48×48 con radio 12 y una banda de 8 u que cambia de cauce (el río entre dos orillas). Se reconoce a 16 px.

- Primera propuesta: una «f» en un cuadrado redondeado. **Se descartó** por parecerse al símbolo de Facebook.
- Variantes: negra (banda menta), menta (banda negra) y blanca (banda negra).

**Logotipo.** Letras construidas con geometría, no una tipografía convertida:

- x-altura 50 u, ascendente 72 u, asta 13 u
- «i» con punto cuadrado
- «a» de un piso
- «v» con fondo plano
- siempre en minúsculas

**Firma.** El símbolo mide de ascendente a base. La separación es 1/3 del símbolo y el área de respeto, 1/2.

**Ficheros:**

- SVG: `docs/design/brand/svg/` (símbolo, logotipo y firma en negro, blanco y sobre menta, y `favicon.svg`)
- favicon de las apps: `apps/*/app/icon.svg`
- componentes: `FluviaSymbol`, `FluviaWordmark`, `FluviaLogo` (`app/lib/brand.tsx`, `apps/checkout/app/brand.tsx`)
- lámina de usos, proporciones y prohibiciones: [`brand/lamina-marca.png`](brand/lamina-marca.png); fuente en `brand/lamina-marca.html`

**Aplicación:**

- **Tarjeta virtual:** negra, con la banda del meandro a escala, el logotipo blanco y la terminación sobre negro. Nunca muestra PAN ni CVV.
- **Justificante:** firma arriba, importe en banda negra y borde troquelado. En papel, negro sobre blanco y sin fondos.

## 4. Composición por superficie

Las tres superficies comparten marca y componentes. La composición cambia según el trabajo de cada una.

### 4.1 Comercios — mostrador

- **Navegación:** riel claro sobre menta con estado activo en píldora negra. La acción principal, **«Nueva venta»**, es un botón negro fijo en el riel.
- **Panel:** la cifra cobrada va **sobre el lienzo** como primera lectura, y la evolución diaria en una pieza aparte. «Saldo en Fluvia» es la pieza negra. Las métricas van en una sola franja de estado de cuenta, no en tarjetas iguales. Los avisos son blancos con borde de color.
- **Terminal «Cobrar»:** un dispositivo negro con el importe a 3.5 rem en blanco, la moneda en una píldora menta y «Cobrar» en menta. El historial queda en blanco al lado.
- **Nueva venta:** las miniaturas sin foto llevan la inicial sobre menta. El producto en el carrito se marca en menta con contorno negro. El ticket es blanco con el total protagonista. En móvil hay una barra negra con el total.
- **Checkout:** una hoja blanca con el importe en banda negra, los métodos de pago como filas grandes y un único botón negro.

### 4.2 Personal — aplicación financiera

- **Navegación:** en escritorio, barra superior con navegación en píldoras (no un riel). En móvil, pestañas en una barra negra flotante.
- **Inicio:** la prioridad es el saldo propio, en una cifra de hasta 4.25 rem sobre el lienzo, seguido de las acciones. La composición del dinero propio usa una barra con colores distintos para disponible (negro), retenido (aviso) y garantía (trama diagonal de bloqueo). El crédito va en una pieza blanca con contorno índigo y la frase «no es saldo propio». Los próximos pagos llevan la fecha en un chip negro.
- **Tarjeta:** pieza gráfica propia con «Datos y uso» debajo y los controles a la derecha. «Bloquear» va en rojo.

### 4.3 Operaciones — trabajo intensivo

- **Barra superior:** blanca con borde negro y el buscador en el centro (es la herramienta principal).
- **Navegación:** compacta sobre menta.
- **Tablas:** densas (40 px por fila), cabecera fija, números tabulares. Por debajo de 768 px se apilan.
- **Acciones:**
  - **Consultar:** enlaces.
  - **Actuar:** botones con **candado** (piden motivo, quedan en auditoría y pueden pedir step-up) dentro de un **panel negro**, separado de la lectura blanca.
  - **Bloquear o congelar:** en rojo.

## 5. Componentes

| Componente             | Especificación                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Botones                | Píldora, mínimo 44 px de alto; primario negro; secundario con contorno de 2 px; sensible en rojo |
| Campos                 | 48 px, radio 12, borde `#404040` de 1.5 px                                                       |
| Selectores segmentados | Píldora blanca con la opción activa en negro                                                     |
| Estados                | Punto + palabra; nunca solo color                                                                |
| Tablas                 | Cabecera `surface-2` en versalitas; importes a la derecha                                        |
| Avisos                 | Fondo suave o blanco con borde izquierdo de color                                                |
| Vacíos                 | Símbolo invertido + qué hacer                                                                    |
| Foco                   | Anillo negro de 3 px con separación (menta sobre negro)                                          |

## 6. Dependencias incorporadas

| Paquete                        | Versión       | Licencia | Motivo                                                                                          | Alternativa descartada |
| ------------------------------ | ------------- | -------- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| `@fontsource-variable/manrope` | 5.3.0 (fija)  | OFL-1.1  | Fuente pedida, alojada localmente                                                               | —                      |
| `lucide-react`                 | 1.49.0 (fija) | ISC      | Sustituye los iconos dibujados a mano detrás de la misma API `Icon` (un solo sistema de iconos) | —                      |

**Licencia de Manrope.** OFL-1.1 se clasifica como «restringida» en la política. El propietario **confirmó por escrito** (2026-10-02) la autorización para incorporar Manrope bajo OFL-1.1, conservando sus avisos y cumpliendo sus términos; consta en `docs/compliance/license-exceptions.json` **solo para `@fontsource-variable/manrope`** (no se extiende a otras fuentes ni paquetes). Cumplimiento: el aviso de copyright y el texto íntegro de la licencia se sirven junto a la fuente en `/licenses/manrope-OFL-1.1.txt` (ambas apps; `test/brand-tokens.test.ts` comprueba que son idénticos al LICENSE del paquete); la fuente no se modifica ni se vende por separado.

**No incorporado: shadcn/ui.** Necesita Tailwind y Radix y habría duplicado el sistema de CSS con tokens que ya cubre botones, campos, tablas, diálogos y estados. Los componentes existentes se personalizaron en su lugar.

**No usado: UI UX Pro Max.** No está disponible en este entorno. Tampoco se usó ninguna skill de diseño, Figma ni recursos de pago.

## 7. Pendiente y limitaciones conocidas

- Las pantallas técnicas usan el puente común: paneles, tablas, estados y foco del sistema. No tienen composición propia. Sus tablas se desplazan con teclado en móvil y no se apilan (detalle en `rediseno-menta/README.md` §3).
- Sin modo oscuro (fuera de esta jornada).
- Capturas en JPEG con calidad 62–72.
- La identidad no tiene validación de marca registrada.
- La imagen de referencia no llegó a la sesión. Ver `rediseno-menta/README.md`.
