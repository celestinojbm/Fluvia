# Taxonomía de errores del API

Estado: Activo · Fase: 1 (F1-08) · Espejo del código: `apps/api/src/error-catalog.ts` + contrato golden `apps/api/test/golden/error-catalog.v1.json` · Cierra AUD-P2-009

## 1. Sobre estable

Toda respuesta de error, sin excepción (dominio, validación, forma del request, 404, 5xx), sale del catálogo con este sobre:

```jsonc
{
  "error": {
    "type": "conflict_error",       // categoría (familia HTTP coherente, ver §3)
    "code": "insufficient_balance", // código legible por máquina, del catálogo cerrado
    "message": "…",                 // texto PÚBLICO y estable del catálogo
    "details": [ … ],               // SOLO donde el catálogo lo declara (hoy: validation_error)
    "request_id": "…"               // correlación con logs (header x-request-id)
  }
}
```

Reglas duras (probadas por contract tests):
- **El `message` interno de los errores de dominio jamás llega al cliente** (AUD-P2-009): va solo a logs. El cliente recibe el texto público del catálogo.
- Los 5xx son opacos (`internal_error`, sin detalle).
- Fastify nunca responde con su forma por defecto (`{statusCode, error, message}`): todo pasa por el catálogo.
- `details` es imposible en códigos que no lo declaran (`errorBody` lo descarta).
- Anti-enumeración: los recursos cross-tenant responden `not_found`, indistinguible de inexistente.

## 2. Versionado del catálogo

- Versión actual: **v1** (`ERROR_CATALOG_VERSION`). El golden comprometido en git ES el contrato: el test `error-contract.test.ts` compara el catálogo runtime contra él campo a campo.
- **Aditivo** (código nuevo): permitido dentro de la misma versión; se actualiza el golden en el mismo PR.
- **Breaking** (cambiar/eliminar `code`, `status` o `type` de un código existente): exige bump de versión + nota de deprecación aquí. El golden lo hace imposible por accidente.

## 3. Categorías y familia HTTP (invariante probada)

| type | HTTP permitido |
|------|----------------|
| `validation_error` | 400, 413, 415 |
| `authentication_error` | 401 |
| `authorization_error` | 403 |
| `not_found_error` | 404 |
| `conflict_error` | 409 |
| `locked_error` | 423 |
| `rate_limit_error` | 429 (reservado: F1-04b) |
| `internal_error` | ≥500 |

## 4. Catálogo v1 (resumen)

Fuente de verdad: `error-catalog.ts`. Códigos: `validation_error`, `invalid_json`, `bad_request`, `payload_too_large`, `unsupported_media_type`, `invalid_verification_token`, `reversal_note_required` · `invalid_credentials`, `invalid_session`, `invalid_api_key`, `invalid_signature` · `email_not_verified`, `insufficient_permissions`, `insufficient_scope`, `live_keys_disabled` · `not_found` · `email_taken`, `merchant_name_taken`, `organization_slug_taken`, `insufficient_balance`, `idempotency_conflict`, `already_reversed`, `cannot_reverse_reversal` · `account_locked` · `rate_limited` (reservado) · `internal_error`.

## 5. Cómo añadir un error nuevo

1. Clase de error en el paquete de dominio (mensaje interno libre: es para logs).
2. Entrada en `ERROR_CATALOG` (código + categoría + mensaje público) y mapeo en `DOMAIN_ERROR_CODES`.
3. Actualizar el golden en el mismo commit (el contract test obliga).
4. Test del endpoint que lo produce asertando `error.code`.
