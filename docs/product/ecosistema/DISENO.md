# Ecosistema — auditoría visual y decisiones de diseño

Base: identidad «Menta» (`docs/design/identidad-menta.md`): menta `#B2FCE4` como lienzo,
negro para texto y acción principal, blanco para lectura, lima `#DFFE1C` como acento escaso,
Manrope servida en local. No se añadió ninguna biblioteca visual, tipografía ni recurso
externo: el trabajo usa los tokens de `brand.css` y las hojas de cada superficie.

## Auditoría del estado anterior (capturas «antes», HEAD de #70 `4d9c41b`)

Capturas reales del stack (no maquetas), 390/768/1440 px, con los mismos datos que el
«después». Hallazgos, de más a menos grave:

| #   | Superficie                         | Hallazgo                                                                                                                                                                                                   | Por qué importa                                                                                                   |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A1  | Personal · Inicio                  | Con el selector en USD, la cifra protagonista del saldo era el **equivalente estimado** (US$ 16,57) y el saldo real de la cuenta (Bs 14.360,00) quedaba en letra de 12 px. Lo mismo en garantía y crédito. | Un saldo se lee por su cifra grande. La jerarquía presentaba una conversión como si fuera el dinero de la cuenta. |
| A2  | Personal · Pagar                   | «Pagar» cobraba con un toque, sin paso de confirmación. Las cuotas se ofrecían según la política, sin mirar si había línea, saldo para la inicial o capacidad.                                             | Confirmación explícita pedida; el navegador decidía elegibilidad.                                                 |
| A3  | Personal · Actividad               | La misma compra aparecía dos veces (pedido + compra con tarjeta).                                                                                                                                          | Dos filas para un solo cargo sugieren doble cobro.                                                                |
| A4  | Comercio · Venta                   | Un pedido en línea de un cliente de Personal aparecía como «Venta sin cliente asignado», sin entrega, método, devoluciones ni asientos.                                                                    | El comercio no veía el mismo caso que el cliente.                                                                 |
| A5  | Operaciones · Transacciones        | La autorización no llevaba a su pedido ni a su cobro; no había vista de caso.                                                                                                                              | Imposible intervenir con trazabilidad.                                                                            |
| A6  | Tres superficies · franja de tasas | «USDT 866,46» al lado de USD/EUR del BCV, sin indicar que es una referencia cruzada (solo lo decía la etiqueta accesible).                                                                                 | USDT nunca debe parecer BCV ni cotización directa.                                                                |
| A7  | Personal · Pagar (móvil)           | Métodos no disponibles con `opacity: .55`: el motivo bajaba de contraste.                                                                                                                                  | El porqué de un «no» es información.                                                                              |

## Decisiones (concretas)

1. **Saldo real primero (A1).** Inicio y «Tus saldos» muestran la cifra de la cuenta
   denominada (`Money`, 2 rem–3.5 rem, tabulares). La equivalencia es una línea secundaria
   con «≈», fuente y Fecha Valor (`Equivalence`). Garantía y crédito igual, con equivalencia
   compacta.
2. **Cinco cifras que nunca se suman.** Nueva pantalla `/personal/saldos`: una cuenta por
   moneda real, con celdas de color semántico + texto: negro = propio disponible; blanco =
   garantía; azul crédito (`--fl-credit`) = límite y disponible; blanco = deuda y
   vencimientos; ámbar (`--fl-warn-soft`) = pendiente o sin confirmar. Rejilla de 1, 2 y 4
   columnas a 390/720/1100 px.
3. **Política como máximo, no promesa.** «Por cada 100 de garantía, el límite puede llegar
   hasta 400/300/200 según nivel; no es una concesión». Se lee de la política activa (`/me`).
4. **Métodos decididos por el servidor (A2, A7).** Cada método lleva icono propio (saldo
   negro/menta, cuotas azul crédito, otra tarjeta neutro), etiqueta «Simulado» si la
   capacidad es sandbox y, si no está disponible, el motivo en negro sobre gris claro sin
   opacidad (≥ 10:1).
5. **Confirmación explícita.** «Revisar y confirmar» abre un resumen: comercio, método,
   reparto (hoy con saldo / con crédito en cuotas), total, aviso violeta de simulación con
   lo que faltaría para dinero real y botón «Confirmar y pagar Bs X» con el importe exacto.
6. **Operación compartida.** Personal: tarjeta «Pago y devoluciones» (método, reparto,
   devoluciones con estado canónico, inciertos con siguiente paso y última verificación,
   «leído del servidor»). Comercio: panel «Operación» dentro de la venta (no otra pantalla).
   Operaciones: caso en tres columnas numeradas — 1 Consulta (solo lectura), 2 Propuesta
   (abre un caso), 3 Decisión ejecutada — y asientos de ambos lados con clave enmascarada.
7. **Densidad por usuario.** Personal: tarjetas grandes, una idea por bloque, barra
   inferior. Comercio: paneles y tablas compactas en la rejilla existente de la venta.
   Operaciones: tablas, columnas y estados textuales; ningún gráfico decorativo.
8. **Franja de tasas (A6).** «BCV» visible tras USD/EUR (≥ 481 px) y «≈» en USDT siempre;
   en móvil la fuente se lee en el detalle (un toque).
9. **Barra de acción adaptable.** Con texto al 200 % o etiquetas largas el total y el botón
   se apilan; la prueba de 200 % encontró un desborde de 4 px y quedó cubierta.

## Estados cubiertos

| Estado                  | Dónde se ve                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Carga                   | `loading.tsx` de Personal (esqueletos) y del panel                                                               |
| Vacío                   | «Sin cuotas por vencer», «Sin casos abiertos», «Ninguna retirada registrada»                                     |
| Error / lectura perdida | `ErrorPanel` («Tu dinero no se movió»); en pedido y venta, aviso propio si falla solo la lectura de la operación |
| Sesión caducada         | pantalla propia de Personal; «Tu sesión caducó» en Operaciones                                                   |
| Acceso denegado         | «Sin acceso» / «Tu rol no incluye Operaciones»; 404 indistinguible para pedidos ajenos                           |
| Pago rechazado          | «Pago rechazado · No se cobró nada» + motivo de su tarjeta (p. ej. límite) y «Cambiar límites»; reintento        |
| Resultado incierto      | «En confirmación», «Pago sin confirmar», «Desenlace sin verificar» con siguiente paso                            |
| Actualización           | «Leído del servidor …» y recarga tras verificar                                                                  |
| Capacidad retirada      | método deshabilitado con «No se ofrece en este mercado en este momento»                                          |

## Verificación

- axe WCAG 2.x A/AA sin hallazgos graves, objetivos ≥ 44 px y foco visible en Saldos,
  pedido con operación, Capacidades y caso de Operaciones (`design-a11y.spec.ts`).
- Sin desborde horizontal a 390/768/1440 en las 20 pantallas de la comparativa.
- Texto al 200 % y `prefers-reduced-motion` en Saldos, pedido y pago
  (`ecosistema.spec.ts` §7).
