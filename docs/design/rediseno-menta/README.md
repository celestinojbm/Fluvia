# Rediseño «Menta» — entrega

- **Sistema de diseño y marca:** [`../identidad-menta.md`](../identidad-menta.md)
- **Lámina de marca:** [`../brand/lamina-marca.png`](../brand/lamina-marca.png)
- **SVG de la marca:** [`../brand/svg/`](../brand/svg/)
- **Rama:** `claude/diseno-identidad-menta`, apilada sobre `claude/jornada-integral-wallet-credito` (`5c8949c`)
- **Imagen de referencia:** no llegó a esta sesión. La paleta sale del bloque «precisión obligatoria» del encargo.

## 1. Comparativas antes/después

Están en `comparativas/<pantalla>-<ancho>.jpg`. Cada fichero muestra la misma ruta y el mismo ancho, en página completa:

- **Antes:** build de `5c8949c`.
- **Después:** build de esta rama.

Las dos capturas usan la misma instancia, el mismo seed y la misma sesión. Ids, URLs y códigos aparecen enmascarados.

- **Anchos:** 390, 768 y 1440 px. Hay 31 pantallas × 3 anchos, más el checkout con sesión nueva.
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

Estas pantallas solo recibieron paleta, tipografía y componentes. Siguen el sistema, pero su composición es la heredada:

- Pagos (lista y detalle)
- Payouts
- Sesiones de checkout
- Enlaces de pago
- Eventos de webhook
- Endpoints de webhook
- Disputas
- Conciliación
- Claves de API
- Casos del comercio
- Operación avanzada
- Onboarding
- Comercios del grupo
- Cuotas del comercio (lista y detalle)

Son pantallas secundarias o técnicas. Las tablas de pagos y webhooks se desplazan dentro de su contenedor a 390 px: la página no desborda, pero no se apilan.

## 4. Verificación

| Comprobación                                                                      | Resultado                                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `design-capture` (sin scroll horizontal, sin 5xx)                                 | 31 pantallas × 390/768/1440 ✓                                                                      |
| `design-a11y` (axe WCAG 2.x A/AA, controles ≥ 44 px, primer Tab con foco visible) | 0 infracciones graves o críticas en 31 pantallas × 390/1440, incluido el contraste de color real ✓ |
| `integral-real-stack`                                                             | 12/12: Personal, Operaciones y Comercios; teclado; vacíos; sesión caducada ✓                       |
| `commerce-real-stack`                                                             | 14/14: catálogo, carrito, cobros, rechazo, cuotas, anulación, permisos, sesión caducada ✓          |
| `journey-real-stack`                                                              | 7/7: POS por teclado a 390 px, devolución, justificante ✓                                          |
| Unitarias del panel                                                               | 534 + 35 de tokens (paleta, sincronía, 22 contrastes, ausencia de la identidad anterior)           |

Todas las pruebas E2E se ejecutaron contra el **build de producción** (`next build && next start`) en la instancia local `fluvia-ci`. Ninguna de ellas corre en CI, igual que el resto de `real-stack`. CI sí ejecuta las unitarias, el E2E del justificante, el lint, los tipos y el gate de licencias.

**Defectos encontrados y corregidos durante la verificación:**

1. La regla global `form input { width: 100% }` deformaba los radios y las casillas de verificación («Pedir una tarjeta»).
2. Las tablas apiladas de Operaciones se salían de su contenedor a 390 px y ocultaban los valores. Ya fallaba antes del rediseño, como muestra la comparativa.
3. Las tablas desplazables de Operaciones no se alcanzaban con el teclado (axe `scrollable-region-focusable`).
4. Chips, segmentos, filtros y botones pequeños medían entre 32 y 40 px.
5. Una regla heredada más específica dejaba sin texto el segmento activo del panel.

## 5. Ejecutar la versión nueva en una instancia independiente

El objetivo es levantar la versión nueva **sin tocar** las demos actuales ni sus checkouts, contenedores o volúmenes. Se usan un checkout aparte, otro prefijo y otros puertos.

```bash
# 1. Checkout propio (no reutilizar el de ninguna demo)
git clone <repo> fluvia-menta && cd fluvia-menta
git checkout claude/diseno-identidad-menta
pnpm install --frozen-lockfile

# 2. Comprobar que los puertos elegidos están libres en la máquina
ss -ltn | grep -E ':(335[0-9]|55437|56384)\b' && echo "OCUPADO: elige otros"

# 3. Instancia con prefijo y puertos propios (scripts/demo/lib.sh)
DEMO_PREFIX=fluvia-menta DEMO_PORT_BASE=3350 DEMO_PG_PORT=55437 DEMO_REDIS_PORT=56384 \
  scripts/demo/start-local-demo.sh

# 4. Parar o retirar SOLO esta instancia
DEMO_PREFIX=fluvia-menta scripts/demo/stop-local-demo.sh
```

- **Puertos:**
  - No se usan 3302, 3312, 3322 ni 3340–3349 (`fluvia-ci`).
  - Si las demos actuales ocupan otros puertos, elige una base libre y vuelve a comprobarla con el paso 2.
- **Aislamiento:** el script se niega a arrancar si el estado o los recursos con ese prefijo pertenecen a otro checkout.
- **Despliegue:** no se ha desplegado nada.
- **Demos en esta sesión:** las demos no existen en el contenedor de esta sesión, así que no se han tocado.
