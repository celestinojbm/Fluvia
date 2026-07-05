# Gestión de secretos

Estado: Versión inicial · Fase: 0 · Se endurece en F1 (CI) y F6 (hardening)

## Reglas

1. Ningún secreto en el repositorio. Los passwords de desarrollo en `0002_enable_rls.sql` son la única excepción consciente (roles locales de docker-compose); sandbox/staging/producción aprovisionan roles por infraestructura con credenciales gestionadas.
2. Secretos por entorno, sin reutilización entre entornos (V4 §43).
3. API keys (AUD-P2-015, migración 0016): se almacena solo **HMAC-SHA256 con pepper de servidor** (`API_KEY_HMAC_SECRET`, 64 hex, anti-mezcla — un dump de la base no basta para validar claves offline); `key_hash_version` versiona el esquema de hash (1=sha256 legado, se promueve a 2 en la primera autenticación exitosa). El secreto se muestra una única vez al crearse; prefijos identificables (`fluvia_sk_test_`, `fluvia_sk_live_`) para secret scanning propio y de GitHub.
4. Webhook secrets: por endpoint, con rotación de dos secretos activos durante la ventana de rotación.
5. Credenciales de proveedor: cifrado field-level (clave en secret manager) desde su primera aparición (F3/F5).
6. Local: `.env` (gitignored) + `.env.example` sin valores reales. CI: secretos del runner. Cloud: secret manager del proveedor (decisión de despliegue, ADR pendiente en F6).
7. Rotación: toda clase de secreto documenta su procedimiento de rotación antes de existir en sandbox (checklist en runbooks, F4).
8. Secret scanning en CI (F1-02) + revisión en code review.
