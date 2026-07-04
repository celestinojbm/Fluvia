# Política de seguridad

## Reportar vulnerabilidades

Reporta de forma privada al propietario del repositorio (no abras issues públicos con detalles explotables). Incluye pasos de reproducción y alcance estimado. Respuesta objetivo: 72 h.

## Alcance actual

El proyecto está en Fase 0 (sandbox, sin dinero real ni datos de tarjeta). Aun así tratamos como críticas: escape de tenant, manipulación del ledger, bypass de idempotencia, SSRF y fuga de secretos.

Documentos: `docs/security/threat-model.md`, `docs/security/data-classification.md`, `docs/security/pci-scope.md`, `docs/security/secrets-management.md`, `docs/security/incident-response.md`.

## Compromisos de diseño

- El backend jamás procesa PAN/CVV (tokenización del proveedor; también en sandbox).
- API keys solo hasheadas; secretos mostrados una única vez.
- Audit log append-only para acciones sensibles.
- RLS forzado en toda tabla tenant-scoped.
