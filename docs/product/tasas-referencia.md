# Tasas de referencia y moneda de visualización

Fluvia muestra **equivalencias de referencia** entre USD, Bs, EUR y USDT. Son solo
informativas: no cambian la moneda de ninguna cuenta, pedido o cobro, no convierten
fondos y no se usan en el ledger, el crédito, las cuotas ni la liquidación.

## Fuentes implementadas

| Par | Fuente | Método | Fecha que se muestra |
| --- | --- | --- | --- |
| USD/Bs | Banco Central de Venezuela (portada `bcv.org.ve`) | Tipo de cambio oficial de referencia («Venta») | **Fecha Valor** publicada por el BCV |
| EUR/Bs | BCV (misma publicación) | Ídem | Fecha Valor |
| USD/Bs y EUR/Bs (histórico) | BCV, `EstadisticasGeneral/2_1_2{a-d}{AA}_smc.xls` (trimestral, una hoja por día) | Columna «Bs./M.E. Venta (ASK)» | Fecha Valor de cada hoja |
| USDT/USD | CoinGecko `/api/v3/simple/price?ids=tether&vs_currencies=usd&include_last_updated_at=true` | Precio agregado de mercado | `last_updated_at` de CoinGecko |
| USDT/Bs | **Referencia cruzada**: USDT/USD (CoinGecko) × USD/Bs (BCV) | Cálculo decimal exacto | Fecha Valor del BCV + hora de CoinGecko |

- **USDT/Bs directo:** no hay una fuente pública, documentada y verificable que
  informe mercado, dirección (compra/venta) y método. No se muestra. La referencia
  cruzada nunca se presenta como precio P2P o ejecutable.
- **Nunca USDT = USD:** sin lectura de CoinGecko, USDT aparece como «No disponible».
- **Sin scraping de interfaces privadas** y sin servicios contratados. El BCV se lee
  de su portada pública y de sus archivos estadísticos públicos.

### Reglas de fecha (America/Caracas)

- La tasa que rige **hoy** es la de mayor Fecha Valor que no sea posterior a hoy.
- El BCV publica por adelantado: por ejemplo, el viernes 02/10 publica la Fecha
  Valor del lunes 05/10. Esa publicación se muestra como «próxima» y **no se aplica
  antes de su fecha**. La aplicable sale del histórico oficial (Fecha Valor 02/10).
- En fines de semana y feriados rige la última Fecha Valor publicada.
- Se distingue la Fecha Valor del BCV de la hora en que Fluvia la consultó.

### Estados

| Estado | Cuándo |
| --- | --- |
| Vigente | BCV: rige hoy o hay una próxima publicada. USDT: la fuente actualizó hace ≤ 30 min. |
| Desactualizada | BCV: la fuente no responde y la última Fecha Valor tiene más de 4 días. USDT: más de 30 min sin actualización. |
| No disponible | No hay lectura válida: no se muestra ningún valor (nunca 0 ni uno inventado). |
| Datos de prueba | Lecturas `fixture` de pruebas automáticas; no son cotizaciones. |

Si la fuente cae, se conserva la última lectura válida **con su fecha original** y
un aviso («No pudimos consultar al BCV desde …»). Las lecturas son de solo inserción
(`fx_rate_readings`, migración 0066): ninguna se modifica para «refrescar» su hora.

## Obtención en servidor y caché compartida

- El navegador **nunca** consulta al BCV ni a CoinGecko. La API refresca en segundo
  plano y guarda lecturas en PostgreSQL. Esa es la caché compartida por todos los
  usuarios y réplicas. `GET /v1/fx/rates` (público, limitado por IP, `max-age=30`)
  solo lee esa caché. El panel la sirve en `/api/fx/rates` y refresca cada minuto
  mientras la pestaña está visible.
- Una sola réplica consulta a la vez (`pg_try_advisory_lock`), y ninguna lo hace si
  otra tuvo éxito hace menos de un intervalo.
- Hay reintentos acotados con backoff exponencial. Ante un 429 se espera 60 s.
  Después de un ciclo fallido, el siguiente se aplaza (×2 por fallo, con tope de 6 h).
- TLS se verifica siempre. El BCV no envía su certificado intermedio, así que se
  incluye el intermedio público «Sectigo Public Server Authentication CA DV R36»
  (`apps/api/src/fx/ca/`), que encadena a una raíz del sistema. Detrás de un proxy
  se respeta `HTTPS_PROXY`/`NO_PROXY`.

## Configuración

| Variable | Por defecto | Notas |
| --- | --- | --- |
| `FX_REFRESH` | `on` (`off` si `NODE_ENV=test`) | `off` en CI: sin red externa |
| `FX_BCV_INTERVAL_SECONDS` | 1800 | mínimo 600 |
| `FX_USDT_INTERVAL_SECONDS` | 300 | mínimo 60 |
| `FX_COINGECKO_DEMO_API_KEY` | — | Opcional. Sin clave se usa el acceso público (límites más bajos). |
| `FX_COINGECKO_PRO_API_KEY` | — | Opcional. Cambia la base a `pro-api.coingecko.com`. |
| `FX_BCV_URL`, `FX_COINGECKO_BASE_URL` | oficiales | solo para pruebas |
| `FX_HTTP_TIMEOUT_MS`, `FX_MAX_ATTEMPTS`, `FX_BACKOFF_BASE_MS` | 20000, 3, 2000 | |

Las claves solo existen en el servidor. Si falta una clave, CoinGecko funciona con
el acceso público. Si el acceso público se limita, el estado pasa a
«Desactualizada» o «No disponible» con su aviso.

## Interfaz

- **Etiqueta «Bs»** (sin punto ni sufijo «VES»). VES sigue siendo el código interno.
- **Franja de tasas** fija bajo la barra superior en Personal, Comercio y
  Operaciones. Muestra USD, EUR y USDT en Bs, y un aviso «Prueba» o «Aviso». Al
  pulsarla se abre el detalle (fuente, unidad, Fecha Valor, hora de la fuente,
  hora de consulta, estado, método y próxima publicación) con la calculadora.
- **Selector USD · Bs · EUR · USDT** (USD por defecto). Se guarda **en este
  dispositivo** (cookie `fluvia_display` y `localStorage`), porque no existe un
  contrato de preferencias por usuario. Solo recalcula equivalencias.
- **Importes convertidos.** El protagonista aparece en la moneda elegida con la
  etiqueta «Equivalente estimado», con el original debajo («Saldo original: Bs …»)
  y la fuente y fecha de la conversión. Si la moneda coincide, o si no hay tasa, el
  protagonista es el original. Saldo propio, garantía, crédito, pendiente y
  devoluciones se convierten por separado y **nunca se suman**. Las cuentas en
  monedas distintas siguen separadas. No se crean cuentas EUR/USDT ficticias.
- **Compras.** Producto, carrito y resumen conservan el precio original y añaden
  «≈ … equivalente estimado a tasa actual». La confirmación de pago dice
  explícitamente «Se cobrará exactamente Bs … en bolívares (Bs), la moneda del
  pedido».
- **Movimientos y comprobantes** conservan sus importes originales.
- **Calculadora informativa** (importe, de, a, resultado, tasa usada, intercambio,
  copiar). No ejecuta pagos, transferencias ni cambio de divisas.

Aritmética: decimal exacta con BigInt. Se redondea half-up solo al presentar
(2 decimales; la tasa usada, a 8).

## Pendiente o fuera de alcance

- **Preferencia por usuario:** requiere un contrato de preferencias que hoy no existe.
- **Cotización USDT/Bs directa:** solo con una fuente verificable (mercado,
  dirección y método).
- **Feriados:** no hay un calendario de feriados del BCV. El estado se deduce de la
  próxima Fecha Valor publicada y de la salud de la fuente (umbral de 4 días).
