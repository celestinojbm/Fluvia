# Tap to Pay y cobro presencial — investigación, arquitectura y bloqueo

Estado: **pendiente de proveedor**. Lo que funciona hoy es el contrato
presencial en el servidor, el **simulador explícito** de sandbox y la
alternativa por **QR/enlace** (checkout existente). **No se probó ninguna
lectura de tarjeta física.**

Consulta de fuentes oficiales: 2026-10-02.

## 1. Disponibilidad real para Venezuela

| Opción | Plataforma | ¿Venezuela? | Fuente | Nota |
|---|---|---|---|---|
| Stripe Terminal — Tap to Pay on Android | Android | **No** | docs.stripe.com/terminal/payments/setup-reader/tap-to-pay?platform=android | GA: AT, AU, BE, CA, CH, DE, DK, FI, FR, GB, IE, IT, MY, NL, NO, NZ, PL, PT, SE, SG, US. Preview: BG, CY, CZ, EE, ES, GI, HK, HR, HU, LI, LT, LU, LV, MT, MX, RO, SI, SK. |
| Stripe Terminal — Tap to Pay on iPhone | iOS | **No** | docs.stripe.com/terminal/payments/setup-reader/tap-to-pay?platform=ios | Además exige el entitlement de Apple. |
| Apple Tap to Pay on iPhone (lista de regiones y PSP) | iOS | **No** | developer.apple.com/tap-to-pay/regions | En Latinoamérica figuran PSP como Mercado Pago, SumUp, Symbiotic, Geopagos, Adyen (MX), Clip y Visa Acceptance Solutions, pero no Venezuela. |
| Pago Móvil NFC (Suiche 7B; BDV, BNC, Bancaribe, Bancamiga) | Android | Sí, pero **no es aceptación de tarjetas** | suiche7b.com.ve/?p=28924; Bloomberg Línea, 2025-09-18 | Es una transferencia Pago Móvil de teléfono a teléfono (P2P y P2C; C2P anunciado). No hay API pública. |
| Credicard (adquirente venezolano) | Terminales físicos y BDV Access Pay | Sí, terminales | bancodevenezuela.com (BDV–Credicard) | No se encontró un SoftPOS con SDK público para terceros. |
| Adyen, Square | — | **No verificado** | — | Las URLs de documentación devolvieron 404 desde este entorno. No se asume nada. |

Conclusión: no hay hoy un SoftPOS certificado, con SDK público, que un comercio
venezolano pueda contratar para aceptar tarjetas EMV sin contacto en su
teléfono. **Una cuenta extranjera no lo resuelve**: el SDK exige operar en un
país soportado, con una entidad, una cuenta de liquidación y un dispositivo de
ese mercado.

## 2. Requisitos técnicos de los SDK (para cuando haya proveedor)

- **Android (Stripe Terminal `com.stripe:stripeterminal-taptopay:5.8.1`)**:
  - Android 13 o superior, NFC y equipo sin root.
  - Google Mobile Services y almacén de claves por hardware.
  - Parche de seguridad de los últimos 12 meses.
  - Los emuladores no sirven; el lector simulado del SDK exige los mismos requisitos.
- **iPhone (ProximityReader)**:
  - iPhone XS o posterior.
  - Entitlement `com.apple.developer.proximity-reader.payment.acceptance`, aprobado por Apple.
  - Revisión de la app por Apple.
- **Web / Web NFC**: no es un terminal certificado. Web NFC lee NDEF, no hace
  transacciones EMV. Por eso el servidor declara `web` como `incompatible`.

## 3. Arquitectura móvil propuesta

```
App nativa Fluvia (Android/iOS)
  └─ SDK del proveedor (lectura EMV, PIN en pantalla segura; Fluvia NO ve PAN/CVV)
        │ connection token (lo emite el backend de Fluvia con credenciales del proveedor)
        ▼
API Fluvia ─ in_person_payments (0061) ─ payment_links (cobro único) ─ payment_intents/attempts
        ▲                                                     │
        └──── webhook firmado del proveedor → inbox → resolveFromProvider ──┘
```

Puntos de integración que faltan, todos marcados en el código:

1. **`ProviderAdapter` presencial**: crear el intent del proveedor con
   `card_present`/`tap_to_pay` y devolver su `client_secret` a la app. Hoy
   `MockPaymentProvider` hace el papel del proveedor sandbox.
2. **Connection token**: un endpoint `POST /in-person/connection-token` que la
   app llama al iniciar el SDK. Falta crearlo; requiere credenciales del proveedor.
3. **Registro del dispositivo**: `in_person_devices` ya guarda el veredicto del
   servidor. Con un proveedor real se añade la atestación del SDK
   (Play Integrity, App Attest).
4. **Webhook del proveedor**: se suma su verificador de firma al registro del
   inbox, como `mock`. Los estados se derivan del intent, igual que hoy.
5. **Habilitación**: `collection_enablements` pasa a `enabled` solo por
   decisión del proveedor (KYC/KYB). Hoy existe la decisión simulada, solo en
   local/test.

## 4. Contrato presencial (implementado)

Estados: `device_incompatible · preparing · ready · waiting_card · processing
· approved · declined · canceled · uncertain`.

**Quién mueve cada estado**
- La app solo prepara: preparing → ready → waiting_card.
- La app puede cancelar antes de procesar.
- El servidor fija approved, declined o uncertain desde el intent: por
  respuesta del proveedor o por webhook firmado vía inbox.

**Garantías**
- Las transiciones se validan en la BD (trigger).
- Importe y vínculo son inmutables.
- `client_key` es único por organización: un reintento del teléfono devuelve
  el mismo cobro.
- Cada cobro es una venta de cobro único existente. El índice de 0046 impide
  un segundo cargo.
- Un incierto retiene la venta: no se puede reabrir ni anular.
- `method = simulator` marca todo cobro simulado; el recibo lleva
  `simulated: true`.

## 5. Qué falta para un cobro real (bloqueo preciso)

1. **Proveedor/adquirente** con SoftPOS certificado operando en Venezuela, o
   en el país donde el comercio tenga entidad y liquidación.
2. **Contrato** y **credenciales** de ese proveedor (claves API, firma de
   webhooks).
3. **SDK móvil** del proveedor y **app nativa** de Fluvia publicada (Play
   Store / App Store). En iPhone, además, el entitlement de Apple.
4. **Dispositivo físico** compatible y **tarjetas de prueba** del proveedor.
5. **Decisiones comerciales pendientes**:
   - comisiones presenciales vs. remotas;
   - moneda de liquidación (VES/USD);
   - límites por transacción;
   - contracargos de tarjeta presente.

   No se tocaron impuestos, exponentes, fees ni liquidación.
