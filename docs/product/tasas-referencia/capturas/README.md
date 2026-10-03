# Capturas: tasas de referencia y moneda de visualización

Todas usan datos de clientes **sintéticos** de la demo (sin datos personales reales).

## `real-*`: tasas reales

Tomadas el 03/10/2026 desde el contenedor de desarrollo, con la API refrescando
de las fuentes oficiales (`FX_REFRESH=on`):

- **BCV:** USD/Bs 866,5612 y EUR/Bs 973,9281, ambas con Fecha Valor 02/10/2026,
  que rige hoy (sábado). La publicación con Fecha Valor 05/10/2026 (871,3689 USD)
  aparece como «próxima» y no se aplica antes de su fecha.
- **CoinGecko:** USDT/USD 0,99989371, actualizada a las 15:51 hora de Caracas.
- **USDT/Bs:** solo como referencia cruzada (866,4691).

| Pantalla | Archivos |
| --- | --- |
| Inicio con USD, Bs, EUR y USDT | `real-inicio-{USD,Bs,EUR,USDT}-{390,1440}.png` |
| Detalle y calculadora | `real-detalle-{390,1440}.png`, `real-calculadora-390.png` |
| Producto (precio original y equivalencia) | `real-producto-USD-{390,1440}.png` |
| Comercio | `real-comercio-USD-{390,1440}.png` |
| Operaciones | `real-operaciones-USD-{390,1440}.png` |

Estas cifras son una foto de ese momento: **no son datos vigentes**.

## `fixture-*`: datos de prueba

Son las capturas de la E2E `apps/dashboard/e2e/real-stack/tasas-moneda.spec.ts`,
con la API en `FX_REFRESH=off` y lecturas `fixture` deliberadamente irreales:
USD/Bs 500, EUR/Bs 550 y USDT/USD 0,998, de modo que la referencia cruzada da 499.
En pantalla llevan la etiqueta «Prueba» o «Datos de prueba».

| Pantalla | Archivos |
| --- | --- |
| Inicio con Bs, USD, EUR y USDT | `fixture-inicio-{Bs,USD,EUR,USDT}-{390,1440}.png` |
| Pagar pedido (importe cobrado fijo) | `fixture-pagar-USDT-{390,1440}.png` |
| Operaciones con USD, Bs, EUR y USDT | `fixture-operaciones-{USD,VES,EUR,USDT}-{390,1440}.png` |
| Comercio | `fixture-comercio-{390,1440}.png` |
| Detalle y calculadora | `fixture-detalle-calculadora-390.png` |
