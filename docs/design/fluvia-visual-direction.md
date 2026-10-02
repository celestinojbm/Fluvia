# Dirección visual de Fluvia — «Corriente»

> **Sustituido (2026-10-02)** por la identidad «Menta»: [`identidad-menta.md`](identidad-menta.md). Se conserva como histórico; sus colores y composiciones ya no se aplican.

Estado: **aplicada en el dashboard del comercio y el checkout** (sandbox). Esta guía se registró antes de implementar y es la referencia para cualquier pantalla nueva. Sin dependencias nuevas: tipografía del sistema, iconos SVG propios, gráficos en SVG inline (la CSP solo permite recursos propios).

## 1. Idea

Fluvia es el **cauce** por el que pasa el dinero de un comercio de barrio: claro, tranquilo y confiable. La interfaz combina un **verde río profundo** (estructura, confianza) con **arena cálida** (el lienzo, cercano y comercial) y un **sol** que solo marca lo que pide atención o celebra (más vendido, existencias bajas). Nada de grises fríos de panel técnico: el producto debe sentirse como una tienda bien llevada, no como una consola.

Principios:

1. **Una cifra protagonista por pantalla.** El resto se subordina (tamaño, peso, color).
2. **El producto se ve.** Fotos o un marcador diseñado; nunca una lista de texto donde se elige mercancía.
3. **Estados honestos y visibles.** Cobrado, sin confirmar, anulado, simulado: color + icono + palabra, nunca solo color.
4. **Lo técnico va detrás.** Explicaciones de fuente y periodo en `details`/notas secundarias; la advertencia de sandbox siempre visible pero discreta.
5. **Composición distinta por tarea.** Panel = banda protagonista + franja de métricas + columnas; catálogo = lista rica; venta = mostrador + ticket; ventas/clientes = tabla + ficha.

## 2. Paleta (tokens en `apps/dashboard/app/platform.css`, espejo en el checkout)

Contrastes calculados (WCAG 2.x) sobre su fondo real.

| Token                        | Valor                 | Uso                                                                  | Contraste                            |
| ---------------------------- | --------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| `--fx-ink`                   | `#10201F`             | Texto principal                                                      | 16.8:1 blanco · 15.1:1 arena         |
| `--fx-ink-2`                 | `#465553`             | Texto secundario                                                     | 7.8:1 · 7.0:1                        |
| `--fx-ink-3`                 | `#5B6866`             | Metadatos (≥ 13 px)                                                  | 5.8:1 · 5.2:1                        |
| `--fx-canvas`                | `#F6F2EB`             | Lienzo «arena clara»                                                 | —                                    |
| `--fx-surface`               | `#FFFFFF`             | Superficies                                                          | —                                    |
| `--fx-sunken`                | `#EFE9DF`             | Zonas hundidas, pistas de gráfico                                    | —                                    |
| `--fx-line`                  | `#E4DCCF`             | Bordes suaves                                                        | decorativo                           |
| `--fx-line-strong`           | `#8A8374`             | Bordes de control                                                    | 3.8:1 (≥ 3:1)                        |
| `--fx-river`                 | `#0B6B6B`             | Marca, acción primaria, enlaces                                      | 6.3:1 · 5.7:1; blanco encima 6.3:1   |
| `--fx-river-strong`          | `#08504F`             | Hover, texto sobre `--fx-river-soft`                                 | 9.3:1 / 7.8:1                        |
| `--fx-river-soft`            | `#DFF0EC`             | Selección, fondos informativos                                       | —                                    |
| `--fx-deep`                  | `#0D2E2D`             | Barra lateral                                                        | blanco 14.5:1; `#A9C9C5` 8.2:1       |
| `--fx-sun`                   | `#E9A23B`             | Acento de relleno (barras, insignias) — **nunca texto sobre blanco** | tinta encima 7.8:1                   |
| `--fx-sun-ink`               | `#7A4600`             | Texto de advertencia                                                 | 7.8:1 blanco · 7.0:1 sobre `#FDF1DC` |
| `--fx-ok` / `--fx-ok-soft`   | `#1D6A3B` / `#E5F3EA` | Cobrado, confirmado                                                  | 5.8:1                                |
| `--fx-bad` / `--fx-bad-soft` | `#A02A1E` / `#FBEAE6` | Rechazo, error                                                       | 6.3:1                                |
| `--fx-sim` / `--fx-sim-soft` | `#5A3B9C` / `#EFEAFA` | Simulación (cuotas)                                                  | 7.0:1                                |
| `--fx-focus`                 | `#1B74E4`             | Anillo de foco (3 px)                                                | ≥ 3:1 sobre todos los fondos         |

Gráficos: **cobrado** = `--fx-river`; **registrado** = `--fx-sun`; **devuelto** = `--fx-bad`. Siempre con leyenda en texto y tabla accesible equivalente.

## 3. Tipografía

Pila del sistema (sin descargas; la CSP y la política de licencias no admiten fuentes externas): `"Inter", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif`. Cifras con `font-variant-numeric: tabular-nums`.

| Rol                  | Tamaño / peso                         | Notas                 |
| -------------------- | ------------------------------------- | --------------------- |
| Cifra protagonista   | 2.5rem (40 px) / 750, −0.02em         | Una por pantalla      |
| Título de página     | 1.75rem / 720, −0.015em               |                       |
| Título de sección    | 1.05rem / 680                         |                       |
| Antetítulo (eyebrow) | 0.72rem / 700, mayúsculas, +0.1em     | Contexto: «Hoy · Bs.» |
| Cuerpo               | 0.95rem (15 px) / 400, interlínea 1.5 |                       |
| Meta                 | 0.82rem / 500                         | `--fx-ink-3`          |

## 4. Espaciado, forma y elevación

- Escala de 4 px: 4 · 8 · 12 · 16 · 24 · 32 · 48.
- Radios: tarjetas 14 px, controles 10 px, píldoras 999 px, miniaturas 10 px.
- Elevación: una sola sombra suave para superficies (`0 1px 2px` + `0 6px 16px` al 6 %); el carrito flotante en móvil usa la sombra fuerte.
- Contenido máximo 80rem; gutter 16 px (móvil) / 32 px (escritorio).

## 5. Componentes

| Componente              | Descripción                                                                                     | Reemplaza / reutiliza                 |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| Barra lateral «cauce»   | Verde profundo con ondas sutiles; secciones con antetítulo; activo en arena con barra de acento | Reestiliza `AppShell`                 |
| Cabecera de página      | Antetítulo + título + acciones; sin párrafos técnicos largos                                    | `PageHead` (+ `eyebrow`)              |
| Selector segmentado     | Periodo (Hoy / 7 días / 30 días) y moneda (VES · USD · COP) como enlaces `aria-current`         | Nuevo `Segmented`                     |
| Banda protagonista      | Cifra grande + gráfico de barras diarias + leyenda                                              | Nuevo `HeroMetric` + `DayBars` (SVG)  |
| Franja de métricas      | 4 métricas en una sola superficie con divisores (no tarjetas idénticas)                         | Nuevo `MetricStrip`                   |
| Tarjeta de saldo        | Pendiente / disponible del ledger, con nota «lo vendido no es saldo»                            | Nuevo                                 |
| Lista clasificada       | Más vendidos: miniatura, nombre, barra proporcional, cantidad e importe                         | Nuevo `RankList`                      |
| Miniatura de producto   | Foto 1:1 o marcador (inicial + ondas en el color de la categoría)                               | Nuevo `ProductThumb`                  |
| Insignia de existencias | «Quedan 3» (sol), «Agotado» (error), «Sin control» (neutro)                                     | Nuevo `StockBadge`                    |
| Lista rica de catálogo  | Fila con miniatura, nombre + variantes, SKU, categoría, existencias, precio                     | Sustituye la tabla plana              |
| Mostrador (POS)         | Rejilla de tarjetas con foto, precio grande, variantes como chips, añadir con un toque          | Reestiliza `SellWorkspace`            |
| Ticket (carrito)        | Columna fija a la derecha (escritorio) / hoja inferior con total siempre visible (móvil)        | Reestiliza `.fx-cart`                 |
| Píldora de estado       | Punto + texto; tonos ok/warn/bad/sim/info/neutral                                               | `Status` (sin cambios de API)         |
| Línea de tiempo         | Eventos de la venta (registrada, cobro, devolución, anulación)                                  | Nuevo en el detalle                   |
| Iconos                  | Trazo 1.8, 24×24, `currentColor`, `aria-hidden`                                                 | Se extrae a `lib/icons.tsx`           |
| Estados de página       | Cargando (esqueleto), vacío (ilustración de ondas + acción), error, sin acceso, sesión caducada | `Empty`, `ReadProblem`, `loading.tsx` |

Movimiento: 120–180 ms `ease-out` en hover/presión y al añadir al ticket (pulso de la línea); sin movimiento con `prefers-reduced-motion`.

## 6. Composición de las pantallas principales

### Panel (Inicio)

```
┌ Antetítulo «Bodega Demo · hoy» ─ Título «Panel» ──────── [Hoy|7 días|30 días] [Bs.|US$|$] ┐
├────────────────────────────────────────────┬───────────────────────────────┤
│ COBRADO (confirmado)                       │ SALDO EN FLUVIA (ledger)       │
│ Bs. 12.430,50        ▂▃▅▂▇▅▆ barras/día    │ Pendiente de liquidación  …    │
│ 14 cobros · leyenda: registrado / cobrado  │ Disponible                …    │
├────────────────────────────────────────────┴───────────────────────────────┤
│ Ventas registradas │ Sin confirmar │ Devoluciones │ Pendientes / anuladas    │  ← franja
├──────────────────────────────┬─────────────────────────────────────────────┤
│ Más vendidos (cobrados)      │ Actividad reciente                           │
│ [img] Café 500 g  ███▌  12   │ #128 Cobrada · Bs. 120,00 · hace 5 min       │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ Atención: existencias bajas · cobros sin confirmar · devoluciones abiertas  │
└ Detalles: qué mide cada cifra, fuente y periodo UTC (desplegable) ──────────┘
```

### Catálogo

Cabecera con «Nuevo producto»; barra de búsqueda (nombre o SKU) + chips de categoría + filtro de estado/existencias; **lista rica** agrupando variantes bajo su producto base; resumen superior «12 productos · 2 con existencias bajas · 1 agotado». Ficha de producto en dos columnas: formulario (con galería de imágenes) + panel de existencias (entrada/ajuste, movimientos).

### Nueva venta (POS)

Dos zonas: **mostrador** (búsqueda grande con foco inicial; Enter con un SKU exacto añade el producto; chips de categoría; rejilla de tarjetas con foto) y **ticket** fijo (líneas con cantidad editable, cliente, nota, total grande, «Revisar venta»). En móvil el ticket es una hoja inferior con el total siempre visible.

### Ventas y clientes

Tabla legible (número, fecha, cliente, productos, estado, total) con búsqueda por número, cliente o producto (nombre o SKU) y filtro de estado; ficha de venta en dos columnas: líneas con precio histórico y variante + línea de tiempo | panel de cobro, existencias y acciones (cobrar, anular, justificante). Ficha de cliente con métricas por moneda e historial.

### Checkout y justificante

Cabecera con el nombre del comercio y la marca Fluvia discreta; importe protagonista; resumen con miniaturas; métodos como tarjetas seleccionables; comprobante con estado grande (icono + texto) y advertencia de sandbox en el pie. El justificante imprimible conserva la misma jerarquía.

## 7. Lenguaje

Comercial y natural («Cobrado», «Pendiente de cobro», «Quedan 3», «Anular venta»). Las precisiones técnicas (UTC, fuente, idempotencia) van en notas secundarias. Se mantienen visibles: aviso de sandbox, resultado incierto («Cobro sin confirmar: no cobres de nuevo») y simulación de cuotas.
