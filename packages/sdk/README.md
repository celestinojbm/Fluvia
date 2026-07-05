# @fluvia/sdk

Cliente TypeScript tipado del **plano de integración (API key)** de Fluvia.
Cubre exactamente las rutas publicadas en `docs/api/openapi.v1.json`; un
`test/contract.test.ts` garantiza que el SDK y el contrato no se desincronicen
(en ninguna dirección).

Sin dependencias de runtime: usa `fetch` global (inyectable vía `fetchImpl`).

## Uso

```ts
import { FluviaClient, FluviaApiError } from '@fluvia/sdk';

const fluvia = new FluviaClient({
  baseUrl: 'https://api.fluvia.example',
  apiKey: process.env.FLUVIA_API_KEY!, // fluvia_sk_…
});

// Crear un payment intent (el Idempotency-Key se autogenera si no se pasa uno).
const intent = await fluvia.paymentIntents.create({
  merchant_id: merchantId,
  amount: 50_000, // unidades menores (COP → sin decimales)
  currency: 'COP',
});

// Confirmar (contrato asíncrono: devuelve `processing`; consulta el desenlace).
await fluvia.paymentIntents.confirm(intent.id, paymentMethodToken);
const settled = await fluvia.paymentIntents.get(intent.id); // status: succeeded | failed | …

try {
  await fluvia.refunds.create({ payment_intent_id: intent.id, amount: 20_000 });
} catch (err) {
  if (err instanceof FluviaApiError) {
    // Sobre de error estable del API: err.status, err.code, err.requestId.
    console.error(err.code, err.message);
  }
}
```

## Recursos cubiertos

`paymentIntents` (create/get/list/confirm/cancel) · `refunds` (create/get/list) ·
`customers` (create/get/list/update/delete) · `checkoutSessions` (create/get/list) ·
`paymentLinks` (create/get/list/disable) · `webhookEndpoints`
(create/list/rotate/disable) · `webhookEvents` (list/get/resend).

## Notas

- **Dinero**: montos en unidades menores (`bigint` en el servidor; `number` en el
  SDK — el JSON del API ya usa números enteros de unidades menores).
- **Idempotencia**: las creaciones que la exigen (intents, refunds, checkout
  sessions, payment links) generan un `Idempotency-Key` si no pasas uno; reintentar
  la misma llamada es seguro. Puedes fijar tu propia clave como segundo argumento.
- **Errores**: toda respuesta ≥400 lanza `FluviaApiError` con el `code` estable del
  catálogo (F1-08) y el `request_id` para trazabilidad.
- El plano PÚBLICO (checkout alojado `/status`/`/confirm`, apertura de payment
  links) y el plano de SESIÓN (dashboard) quedan fuera del SDK: este cubre solo la
  integración por API key.
