# Clasificación de datos

Estado: Activo · Fase: 0 · Gobierna cifrado, acceso, retención, borrado y la excepción a "DELETE prohibido"

| Clase | Ejemplos | Cifrado | Retención | Borrado |
|-------|----------|---------|-----------|---------|
| **Financiero-inmutable** | ledger_transactions/entries, audit_events, provider_events procesados, webhook_attempts | En reposo (proveedor de BD) | Indefinida (mínimo legal por jurisdicción, PEND-001) | **PROHIBIDO** (triggers). Corrección = compensación |
| **Financiero-operativo** | payment_intents, refunds, balances proyectados, casos | En reposo | Indefinida en MVP | Prohibido DELETE; estados terminales + `deleted_at` lógico si aplica |
| **PII** | customers (nombre, email), usuarios | En reposo; campos sensibles field-level cuando lleguen | Según jurisdicción | **Pseudonimización**, nunca borrado de asientos: se sustituyen campos PII conservando la integridad contable (resuelve el conflicto derecho-al-olvido vs inmutabilidad, V4 §35) |
| **Secretos** | API key hashes, webhook secrets, credenciales de proveedor, TOTP seeds | Hash irreversible o cifrado field-level + secret manager | Hasta rotación/revocación | Revocación lógica; material criptográfico rotado se destruye |
| **Datos de tarjeta** | — | **No existen en Fluvia** (tokenización del proveedor; ver `pci-scope.md`) | — | — |
| **Técnico** | idempotency_keys expiradas, sesiones expiradas, rate-limit counters, caché | N/A | TTL corto (Nivel C) | **Purga administrada permitida** por job auditado (excepción documentada a los triggers; se implementa en F1-09) |
| **Diagnóstico** | logs, trazas, métricas | En tránsito/reposo del stack de observabilidad | 30–90 días (Nivel C) | Expiración automática; logs JAMÁS contienen PAN/CVV/secretos (redacción en logger) |

Reglas: toda tabla nueva declara su clase en el PR que la crea; los payloads crudos de proveedor archivados en DLQ se guardan con redacción de campos sensibles; exportaciones de datos requieren permiso y quedan auditadas; backups heredan la clase más alta de su contenido (cifrados siempre).
