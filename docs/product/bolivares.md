# Bolívares venezolanos (VES) — moneda funcional en el sandbox

Estado: **sandbox, sin merge**. Sin conversiones, tasas de cambio, redenominaciones ni impuestos.

## Código verificado en fuente oficial

| Dato | Valor | Fuente |
| --- | --- | --- |
| Código alfabético | **VES** | ISO 4217 «List one», agencia de mantenimiento (SIX Financial Information), publicación `2026-09-17` — <https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml> |
| Código numérico | 928 | ídem |
| Unidades menores | **2** (céntimos) | ídem |
| VED / 926 | Existe en la lista, **no se usa** | ISO 4217 Amendment 170 (01-10-2021): «VED/926 … for any internal needs during the redenomination process, but is not replacing VES as the official currency code. The Central Bank of Venezuela will not adopt the new codes in the local system, VES/928 remains in use … the valid code after 1 October 2021 to use in any future transactions» — <https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/amendments/dl_currency_iso_amendment_170.pdf> |
| Símbolo | **Bs.** | Resolución del BCV sobre la nueva expresión monetaria (vigente desde 01-10-2021): los montos «continuarán representándose con el símbolo Bs.», divisibles en 100 céntimos. **Verificado solo en fuente secundaria** (p. ej. <https://eldiario.com/2021/09/29/preguntas-frecuentes-reconversion-monetaria/>); no se obtuvo el texto de la Gaceta. El CLDR de los navegadores todavía trae «Bs.S», por eso el símbolo se fija en la presentación |

Huellas de los documentos consultados el 2026-10-01 (para reproducir la verificación):

```
33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff  list-one.xml (Pblshd="2026-09-17")
a4d89c7c0c5cc042146bc19b197beb8e4f3a179484a8135db6ddee2ba5b7e1ca  dl_currency_iso_amendment_170.pdf
```

`VED` se rechaza explícitamente (`validation_error` en la API, `UnknownCurrencyError` en el dominio) para que nadie registre importes con el código interno de la reconversión.

## Qué cubre

| Superficie | Cómo | Prueba |
| --- | --- | --- |
| Dominio `@fluvia/money` | `VES: { exponent: 2 }`; `fromDecimal` rechaza un tercer decimal (nunca redondea); `allocate` exacto | `packages/money/test/money.test.ts` (bloque VES) |
| Catálogo, venta, cobro | Precio en céntimos `BIGINT`; total en servidor; el link de cobro único hereda importe y moneda; el motor rechaza mezclar monedas (`order_currency_mismatch`) | `packages/commerce/test/ves.test.ts`, `apps/api/test/commerce-routes.test.ts` («bolívares (VES) por HTTP») |
| Ledger | Cuentas por moneda (`ensureChart(…, 'VES')`); nada se suma entre monedas | `ves.test.ts` |
| Devoluciones | Parcial exacta (Bs. 250,75 − 100,25 = 150,50), exceso rechazado, total ⇒ `refunded` | `ves.test.ts` |
| Cuotas simuladas | Reparto entero con Σ = total; Bs. 100,00 / 3 = 33,34 + 33,33 + 33,33; propiedad hasta 2^53−1 céntimos | `ves.test.ts` |
| Indicadores | Agrupados por moneda: VES, USD y COP nunca se suman | `ves.test.ts`, panel con selector de moneda |
| Presentación | `formatAmount` exacto (BigInt → cadena decimal → `Intl`, sin `/100` en coma flotante): «Bs. 1.234,56»; con `code` → «Bs. 1.234,56 VES». Dashboard y checkout comparten el mismo archivo (test de paridad) | `apps/dashboard/test/money-format.test.ts` |
| POS / onboarding | `VES` en la lista de monedas del POS (paridad con el dominio) y del alta de comercio | `pos-logic.test.ts` |

## Compatibilidad con proveedores simulados

- **MockProvider** (cobros, devoluciones, liquidaciones) no inspecciona la moneda: VES funciona igual que el resto. No es una afirmación sobre proveedores reales.
- **Proveedor de cuotas simulado**: trabaja en unidades menores de la moneda del pedido; sin restricciones de moneda.
- El método de prueba asíncrono se etiqueta «Transferencia de prueba», no con una marca local; no se renombró para aparentar compatibilidad con medios venezolanos (pago móvil, etc.), que no existen en el sandbox.

**Bloqueo documentado para un proveedor real**: ninguno del sandbox. Antes de un proveedor real hay que verificar si opera en VES, con qué exponente y si exige importes en USD (habitual en adquirentes internacionales). Eso es una decisión de mercado (PEND-007), no se resuelve aquí.

## Qué NO hace (límites de la jornada)

- No convierte ni muestra equivalencias VES ↔ USD; no hay tasa BCV ni tipo de cambio.
- No redenomina ni reinterpreta importes históricos.
- No calcula IVA ni IGTF.
- No cambia el exponente de COP (PEND-008 sigue abierta: el dominio usa 2, la presentación 0).
- Las ventas históricas conservan su moneda: no se migran filas.
