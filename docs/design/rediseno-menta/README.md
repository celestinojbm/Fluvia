# Rediseño «Menta» — entrega

- **Sistema de diseño y marca:** [`../identidad-menta.md`](../identidad-menta.md)
- **Lámina de marca:** [`../brand/lamina-marca.png`](../brand/lamina-marca.png)
- **SVG de la marca:** [`../brand/svg/`](../brand/svg/)
- **Rama:** `claude/diseno-identidad-menta`, apilada sobre `claude/jornada-integral-wallet-credito` (`5c8949c`)
- **Imagen de referencia:** no llegó a esta sesión, ni en el encargo inicial ni en el mensaje del 2026-10-02 que la anunciaba adjunta (solo llegó el texto). No se comparó la composición con ella. Se verificó lo que el texto describe: fondo #B2FCE4, negro y blanco, barra Sandbox negra, tipografía geométrica (Manrope) y composición clara. La identidad propia de Fluvia (símbolo y logotipo) se conserva.

## 1. Comparativas antes/después

Están en `comparativas/<pantalla>-<ancho>.jpg`. Cada fichero muestra la misma ruta y el mismo ancho, en página completa:

- **Antes:** build de `5c8949c`.
- **Después:** build de esta rama.

Las dos capturas usan la misma instancia, el mismo seed y la misma sesión. Ids, URLs y códigos aparecen enmascarados.

- **Anchos:** 390, 768 y 1440 px. Hay 49 pantallas × 3 anchos (147 comparativas): las 31 de la primera entrega más 18 de gestión y técnicas (`g01`–`g06`, `t01`–`t12`), con el checkout con sesión nueva incluido.
- **Diferencias de datos:**
  - Entre las dos capturas se ejecutaron las pruebas E2E, que crean ventas, cobros y movimientos. Por eso algunas listas tienen más filas o importes distintos en el «después». El diseño se compara pantalla a pantalla, no las cifras.
  - El checkout «antes» quedó capturado con un enlace ya usado. `k01-checkout-*` compara ese mismo estado («enlace inválido o expirado»). `k02-checkout-pago-*` muestra el pago con una sesión nueva, que no tiene «antes».
- **Barra de pestañas de Personal en móvil:** es fija. En una captura de página completa aparece a la altura de la ventana, no al pie.

Las capturas se regeneran con `apps/dashboard/e2e/real-stack/design-capture.spec.ts` (cabecera del fichero).

## 2. Pantallas terminadas

En las pantallas de esta sección se cambió la composición, no solo los colores.

| Superficie  | Pantalla                                                                          | Cambio de composición                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Comercios   | Shell (riel, barra móvil, cajón)                                                  | Riel claro, «Nueva venta» como acción fija, estado activo en píldora negra, marca nueva                                                      |
| Comercios   | Panel (`/o/:org`)                                                                 | Cifra cobrada sobre el lienzo, evolución en pieza aparte, franja de estado de cuenta, saldo en pieza negra, avisos blancos                   |
| Comercios   | Cobrar (POS)                                                                      | Terminal negro con el importe protagonista y «Cobrar» en menta                                                                               |
| Comercios   | Nueva venta (carrito)                                                             | Productos sobre menta, selección en contorno negro, ticket blanco, barra negra del total en móvil                                            |
| Comercios   | Justificante                                                                      | Ticket con firma, importe en banda negra, borde troquelado; versión de impresión                                                             |
| Comercios   | Acceso, alta y selector de organización                                           | Firma de la marca, tarjeta centrada con margen a 390 px                                                                                      |
| Checkout    | Pago, cuotas y estados                                                            | Hoja blanca, importe en banda negra, métodos en filas grandes, un único botón negro                                                          |
| Personal    | Shell                                                                             | Barra superior con navegación en píldoras (escritorio); pestañas negras flotantes (móvil)                                                    |
| Personal    | Inicio                                                                            | Saldo propio protagonista, barra de composición (disponible / retenido / garantía con trama), crédito índigo separado, chips de fecha negros |
| Personal    | Tarjetas                                                                          | Tarjeta negra con meandro, «Datos y uso» bajo la tarjeta, controles; radios de «Pedir una tarjeta» corregidos                                |
| Personal    | Movimientos, ingresar, enviar, retirar, cuotas, crédito, perfil, entrar           | Formularios en un paso, importes grandes, estados con punto + palabra                                                                        |
| Operaciones | Shell                                                                             | Barra blanca con buscador central, navegación compacta en rejilla con riel _sticky_                                                          |
| Operaciones | Resumen, clientes, solicitudes, tarjetas, transacciones, casos, eventos, política | Tablas densas en blanco, cabecera fija, filtros en píldora; tablas desplazables accesibles con teclado                                       |
| Operaciones | Ficha 360                                                                         | Panel de acciones negro separado de la lectura; acciones sensibles con candado y en rojo                                                     |

## 3. Pantallas pendientes

No queda ninguna pantalla con la identidad anterior.

Las pantallas técnicas listadas arriba usan el **puente común**, no una composición propia por pantalla. Su estructura sigue siendo cabecera + panel con tabla, porque es la adecuada para consulta técnica. Sus tablas se desplazan dentro de un contenedor accesible con teclado a 390 px y no se apilan, porque el marcado heredado no tiene etiquetas por celda. Si se quiere apilarlas, hay que añadir `data-label` a cada vista (cambio pequeño, pantalla a pantalla).

No incluido en esta jornada (por instrucción): modo oscuro.

## 4. Verificación

| Comprobación                                                                      | Resultado                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `design-capture` (sin scroll horizontal, sin 5xx)                                 | 49 pantallas × 390/768/1440 ✓                                                                                 |
| `design-a11y` (axe WCAG 2.x A/AA, controles ≥ 44 px, primer Tab con foco visible) | 0 infracciones graves o críticas en 50 pantallas × 390/1440, incluido el contraste de color real ✓            |
| `integral-real-stack`                                                             | 12/12: Personal, Operaciones y Comercios; teclado; vacíos; sesión caducada ✓                                  |
| `commerce-real-stack`                                                             | 14/14: catálogo, carrito, cobros, rechazo, cuotas, anulación, permisos, sesión caducada ✓                     |
| `journey-real-stack`                                                              | 7/7: POS por teclado a 390 px, devolución, justificante ✓                                                     |
| Unitarias del panel                                                               | 570, incluidas las de tokens (paleta, sincronía, 22 contrastes, aviso OFL, ausencia de la identidad anterior) |

Todas las pruebas E2E se ejecutaron contra el **build de producción** (`next build && next start`) en la instancia local `fluvia-ci`. Ninguna de ellas corre en CI, igual que el resto de `real-stack`. CI sí ejecuta las unitarias, el E2E del justificante, el lint, los tipos y el gate de licencias.

**Defectos encontrados y corregidos durante la verificación:**

1. La regla global `form input { width: 100% }` deformaba los radios y las casillas de verificación («Pedir una tarjeta»).
2. Las tablas apiladas de Operaciones se salían de su contenedor a 390 px y ocultaban los valores. Ya fallaba antes del rediseño, como muestra la comparativa.
3. Las tablas desplazables de Operaciones no se alcanzaban con el teclado (axe `scrollable-region-focusable`).
4. Chips, segmentos, filtros y botones pequeños medían entre 32 y 40 px.
5. Una regla heredada más específica dejaba sin texto el segmento activo del panel.

## 5. Ejecutar la versión nueva en una instancia independiente

Esto levanta la versión nueva **sin tocar** las cuatro demos existentes ni sus checkouts, contenedores o volúmenes. Usa un checkout aparte, el prefijo `fluvia-menta` y puertos propios. Requiere docker, node y pnpm. El script crea sus propios contenedores PostgreSQL 16 y Redis 7, etiquetados con el prefijo.

```bash
# 1. Checkout propio en un directorio nuevo (no reutilizar el de ninguna demo)
git clone https://github.com/celestinojbm/Fluvia.git fluvia-menta
cd fluvia-menta
git checkout claude/diseno-identidad-menta
git rev-parse HEAD        # debe coincidir con el SHA entregado en el PR #67

# 2. Comprobar que los puertos elegidos están libres (no debe imprimir nada)
ss -ltn | grep -E ':(3350|3351|3352|55437|56384)\b'

# 3. Instalar dependencias y arrancar la instancia con prefijo y puertos propios.
#    El script instala, migra, siembra, compila (next build) y arranca.
pnpm install --frozen-lockfile
DEMO_PREFIX=fluvia-menta DEMO_PORT_BASE=3350 DEMO_PG_PORT=55437 DEMO_REDIS_PORT=56384 \
  scripts/demo/start-local-demo.sh

# 4. Parar SOLO esta instancia (conserva su volumen)
DEMO_PREFIX=fluvia-menta scripts/demo/stop-local-demo.sh
```

**Direcciones** (solo en esta máquina, 127.0.0.1):

| Servicio    | URL                                                                    |
| ----------- | ---------------------------------------------------------------------- |
| API         | http://127.0.0.1:3350                                                  |
| Checkout    | http://127.0.0.1:3351                                                  |
| Panel       | http://127.0.0.1:3352/login                                            |
| Personal    | http://127.0.0.1:3352/personal/entrar                                  |
| Operaciones | http://127.0.0.1:3352/operaciones/e744e6eb-95cf-5762-95a7-268a0917e747 |

**Credenciales sintéticas del seed:**

- Comercio: `owner@demo.fluvia.test` / `demo-owner-password`
- Personal: `cliente@demo.fluvia.test` / `demo-cliente-password`

**Garantías del script** (`scripts/demo/lib.sh`):

- Se niega a arrancar si algún puerto coincide con los de la demo por defecto.
- Se niega a arrancar si el estado o los contenedores con ese prefijo pertenecen a otro checkout.
- `stop` y `purge` solo actúan sobre recursos etiquetados con `fluvia.demo.prefix=fluvia-menta` y este directorio.

**Puertos.** No se usan 3302, 3312, 3322 ni 3340–3349 (instancia de verificación `fluvia-ci`). Si alguna de las cuatro demos ocupa otros puertos, elige otra base libre y repite el paso 2.

**Despliegue.** No se ha desplegado ni fusionado nada. Las demos no existen en el contenedor de esta sesión y no se han tocado.
