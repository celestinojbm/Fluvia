# Webhooks salientes

Estado: Activo · Fase: 0 · ADR-0009 (internos primero; Svix como opción futura)

> **Estado de implementación (F3-07, 2026-07-05): IMPLEMENTADO.** Migración `0019` (tablas `webhook_endpoints`/`webhook_events`/`webhook_attempts` + rol `fluvia_webhook` de privilegio mínimo), paquete `@fluvia/webhooks` (firma §2, calendario de reintentos §3, SSRF guard con pinning §4, catálogo §5 con meta-test doc↔código), fan-out desde el relay del outbox y deliverer claim-lease en el worker, gestión por API (`/v1/webhook_endpoints`, scope `webhooks:manage`). Desviaciones registradas en backlog: reenvío manual auditado y auto-disable con notificación quedan para F3-09/F6.
>
> **F3-09a (2026-07-05): visibilidad de la cola + reenvío manual auditado de eventos `dead`.** Migración `0026` (columna `resent_from_event_id` + función SECURITY DEFINER acotada `webhook_event_resend`). API de operación: `GET /v1/webhook_events` (lista con filtros endpoint/status, scope `read`), `GET /v1/webhook_events/:id` (detalle con `payload` + historial de intentos), `POST /v1/webhook_events/:id/resend` (scope `webhooks:manage`). Reenviar NO resucita el evento muerto (estado terminal inmutable): genera un evento `pending` fresco que clona (tenant, endpoint, topic, payload) enlazado vía `resent_from_event_id`, y escribe un audit event `webhook_event.resent` en la misma transacción. Solo eventos `dead` se reenvían (si no, `invalid_state_transition`). Pendiente F6: auto-disable de endpoints crónicos con notificación.

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
- Failover de conexión (V2-N2, F6): si la conexión (TCP/TLS) **jamás se estableció** con una IP — nadie recibió un byte del payload — el intento prueba las demás IPs **ya validadas** de la misma resolución (máx. 3; el cap acota el trabajo extra por fila). Jamás re-resuelve, y jamás si el socket conectó o hubo respuesta HTTP (aun 5xx): re-enviar el mismo intento firmado a otra IP sería doble entrega dentro del intento; ese reintento pertenece al calendario. El attempt registra la IP que contestó (o todas las inalcanzables en el error si ninguna conectó).
- TLS estricto: `rejectUnauthorized: true` EXPLÍCITO (el default de Node es anulable con `NODE_TLS_REJECT_UNAUTHORIZED=0`; fijado en código, el footgun no aplica — probado contra un receptor self-signed que jamás recibe el payload firmado); SNI solo con nombre DNS (RFC 6066).
- HTTPS obligatorio (HTTP solo en entorno local), puertos permitidos 443 (+80 local), sin seguir redirects cross-host, límite de tamaño de respuesta, registro del destino resuelto en cada attempt.

## 5. Catálogo de eventos del MVP (normalizado; auditoría D3)

`payment_intent.created|processing|requires_action|succeeded|failed|canceled`,
`refund.created|processing|succeeded|failed|canceled`,
`checkout_session.completed|expired`,
`payout.requested|in_transit|paid|failed`,
`dispute.open|under_review|won|lost`,
`merchant.updated`.

Reservados post-MVP: `charge.*`, `settlement.*`. `payout.*` (F4-07) y `dispute.*` (F4-08) se graduaron de reservados a activos con **F4-09**: los motores los emiten al outbox y el fan-out (§1) los entrega a los endpoints suscritos (el estado payout indeterminate queda interno/silente, no se emite). El catálogo vive en código (`packages/webhooks/src/events.ts`) y este documento se genera/verifica contra él (F3).

## 6. Por qué no Svix todavía

Ver `references/svix-assessment.md`: excelente producto, pero introduce dependencia externa/autohospedaje con su propia base de datos para un volumen sandbox trivial, y el modelo multi-tenant + SSRF guard deben ser correctos de todos modos para el inbox y el panel. El diseño interno copia sus conceptos verificables (firma versionada, attempt log, rotación) para que una migración futura sea de transporte, no de contrato.
