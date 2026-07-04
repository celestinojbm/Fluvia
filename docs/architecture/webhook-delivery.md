# Webhooks salientes

Estado: Activo · Fase: 0 · ADR-0009 (internos primero; Svix como opción futura)

## 1. Modelo

`webhook_endpoints` (por merchant: url, secreto activo + secreto anterior durante rotación, eventos suscritos, estado) → `webhook_events` (instancia de evento a entregar, `event_id` público `whe_…`, `schema_version`) → `webhook_attempts` (uno por intento: status HTTP, latencia, error, `attempt_id`).

Origen: exclusivamente el outbox (ningún webhook se emite desde un request síncrono).

## 2. Firma y verificación

- HMAC-SHA256 sobre `"{timestamp}.{event_id}.{raw_body}"`.
- Headers: `Fluvia-Signature: v1=<hmac>`, `Fluvia-Timestamp`, `Fluvia-Event-Id`, `Fluvia-Attempt-Id`.
- Durante rotación de secreto se firma con ambos (`v1=`, `v1=` múltiple) por una ventana configurable.
- Tolerancia de timestamp recomendada al receptor: ±5 min (documentada con ejemplos de verificación en TS; SDK en F3).
- `schema_version` dentro del payload; cambios incompatibles = nueva versión, nunca mutación (auditoría D5).

## 3. Entrega y reintentos

Backoff exponencial con jitter, calendario configurable (Nivel C; baseline: 0s, 30s, 2m, 10m, 1h, 6h, 24h → `dead`/desactivación propuesta). Timeout por intento configurable (baseline 10 s). Éxito = 2xx. Historial completo consultable; reenvío manual auditado desde el panel admin. Endpoints con fallo persistente → desactivación controlada con notificación al comercio (nunca silenciosa).

## 4. Protección SSRF (obligatoria antes del primer delivery real)

- Resolver DNS y validar **todas** las IPs (v4 y v6) contra denylist: rangos privados (RFC1918, ULA), loopback, link-local (169.254.0.0/16 — metadata endpoints), multicast.
- Re-validación en cada intento (protección contra DNS rebinding): conectar a la IP validada, no re-resolver.
- HTTPS obligatorio (HTTP solo en entorno local), puertos permitidos 443 (+80 local), sin seguir redirects cross-host, límite de tamaño de respuesta, registro del destino resuelto en cada attempt.

## 5. Catálogo de eventos del MVP (normalizado; auditoría D3)

`payment_intent.created|processing|requires_action|succeeded|failed|canceled`,
`refund.created|processing|succeeded|failed`,
`checkout_session.completed|expired`,
`merchant.updated`.

Reservados post-MVP: `charge.*`, `dispute.*`, `settlement.*`, `payout.*`. El catálogo vive en código (`packages/webhooks/src/events.ts`) y este documento se genera/verifica contra él (F3).

## 6. Por qué no Svix todavía

Ver `references/svix-assessment.md`: excelente producto, pero introduce dependencia externa/autohospedaje con su propia base de datos para un volumen sandbox trivial, y el modelo multi-tenant + SSRF guard deben ser correctos de todos modos para el inbox y el panel. El diseño interno copia sus conceptos verificables (firma versionada, attempt log, rotación) para que una migración futura sea de transporte, no de contrato.
