# Modelo de amenazas

Estado: Activo · Fase: 0 · Revisión obligatoria en Fase 6 y ante cambios de superficie

Alcance actual: sandbox, sin dinero real, sin datos de tarjeta reales. Aun así el modelo se construye como si fueran reales: los controles de Fase 1–3 son los mismos que exigirá producción.

## 1. Activos

Fondos contables (ledger), credenciales (API keys, sesiones, secretos de webhook, credenciales de proveedor), PII de customers, integridad de eventos, disponibilidad del pipeline de pagos, confianza/reputación.

## 2. Amenazas priorizadas y mitigaciones

| Amenaza (V4 §34) | Vector típico | Mitigaciones (documento) | Estado |
|---|---|---|---|
| Tenant escape | IDOR, filtro por `organization_id` del cliente, fuga de contexto de pool | Defensa en profundidad + RLS forzado + regla SET LOCAL (`multi-tenancy.md`) | Parcial (spike verde; suite ampliada F1) |
| Ledger manipulation | UPDATE/DELETE directo, asiento desbalanceado, bypass del servicio | Triggers de inmutabilidad, constraint diferido de balanceo, sin DELETE grant, script de invariantes externo | Parcial (triggers verdes; constraint F2) |
| Duplicate capture / duplicate refund | Retries de red, doble click, webhooks duplicados, carreras | Idempotencia multicapa (`idempotency.md`), unique constraints, FSM con FOR UPDATE | Diseñado (F2) |
| Webhook forgery / replay (entrantes) | Falsificar evento de proveedor | Verificación de firma antes de procesar, tolerancia de timestamp, dedup por `provider_event_id` | Diseñado (F3) |
| Webhook spoofing (salientes) / SSRF | Endpoint malicioso apuntando a metadata/red interna | SSRF guard completo (`webhook-delivery.md` §4), HMAC + timestamp | Diseñado (F3, bloqueante para primer delivery) |
| API key theft | Repos, logs, phishing | Hash en reposo, secreto mostrado una vez, prefijos detectables por secret scanning, scopes, rotación, revocación | Parcial (hash en spike) |
| Account takeover / credential stuffing | Password reuse | MFA TOTP, rate limiting, detección de stuffing, sesiones revocables, step-up para acciones sensibles | Diseñado (F1) |
| Horizontal privilege escalation | Manipulación de merchant_id/rol | RBAC en servicio + pruebas BOLA por endpoint | Diseñado (F1) |
| Mass assignment | Payload con campos extra | Zod `.strict()` en todo DTO (patrón ya en spike), mapeo explícito DTO→entidad | Parcial |
| Payout destination change | Insider o cuenta comprometida | Step-up + four-eyes + ventana de espera + auditoría (payouts reales bloqueados en MVP) | Bloqueado por diseño |
| Insider abuse | Operador con permisos amplios | Panel admin separado, acciones con razón obligatoria, four-eyes, audit append-only, no proponer-y-aprobar | Diseñado (F4) |
| Provider compromise | Webhooks/API del proveedor comprometidos | Validación Zod + DLQ, conciliación detecta drift, circuit breakers | Diseñado |
| Supply chain | Dependencia maliciosa | Lockfile + save-exact (activo), dependencia nueva justificada en PR, scanning + SBOM en CI (F1-02) | Parcial |
| Race conditions | Concurrencia en confirm/refund/projection | `concurrency-model.md` + suites dedicadas | Diseñado (F2) |
| Enumeration | IDs secuenciales, mensajes reveladores | UUID + prefijos, errores uniformes (404 indistinguible de cross-tenant), rate limiting | Parcial |
| Secret leakage | Logs, errores, analytics | Clasificación de datos + redacción en logger + secret scanning CI | Diseñado (F1) |
| Restore inconsistencies | Backup restaurado con proyecciones viejas | Runbook: restore → rebuild proyecciones → conciliación post-restore (Gate Restore) | Diseñado (F6) |
| Fraudulent onboarding | Comercios falsos | Fuera del MVP real (sin dinero); modelo de verification requirements preparado | Aceptado (sandbox) |
| Session theft | XSS, cookies débiles | Secure cookies, CSP, SameSite, rotación de sesión, revocación | Diseñado (F1/F3) |

## 3. Supuestos de confianza

- El superusuario de la base de datos y la infra local están fuera del alcance del modelo en Fase 0–3 (entorno local/CI); entran en Fase 6 con secret manager y acceso mínimo.
- El MockProvider es código propio: no se confía en él igualmente — pasa por el mismo inbox verificado (así el pipeline queda probado).

## 4. Deuda de seguridad registrada

1. Passwords de roles de BD en migración 0002: solo desarrollo; para sandbox/staging se aprovisionan por secret manager (F1-02). 
2. Sin rate limiting hasta F1.
3. Sin cifrado field-level de credenciales de proveedor hasta F3 (no existen aún).
