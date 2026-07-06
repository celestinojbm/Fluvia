# Observabilidad base (F1-07)

Estado: Activo · Espejo del código en `@fluvia/observability`, `apps/api/src/metrics.ts` y `apps/worker/src/{main,metrics-server}.ts`

## 1. Qué existe (y qué no)

| Capa                                                                                                           | Estado            | Dónde                                            |
| -------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------ |
| Logs estructurados (pino) con redacción de secretos                                                            | ✅ desde F1-01    | `apps/api/src/app.ts`, `apps/worker/src/main.ts` |
| Correlación por `request_id` (header `x-request-id` saneado o UUID; eco en respuesta y en el sobre de error)   | ✅ desde F1-01    | `app.ts` (`genReqId`), `error-catalog.ts`        |
| Métricas en proceso + exposición Prometheus (`GET /metrics` en API y worker)                                   | ✅ F1-07          | `@fluvia/observability`                          |
| Health/readiness: API `GET /health` + `GET /ready` (toca la BD); worker `GET /health` en `WORKER_METRICS_PORT` | ✅ F1-01 / F1-07  | `app.ts`, `metrics-server.ts`                    |
| Trazas distribuidas (OTel)                                                                                     | ❌ diferido       | ver §5                                           |
| Dashboards/alertmanager desplegados                                                                            | ❌ fuera del repo | las reglas baseline viven en §4                  |

## 2. Métricas expuestas

Registro propio sin dependencias (`MetricsRegistry`: counter/gauge/histogram, formato
de texto Prometheus 0.0.4). Reglas duras:

- **Cardinalidad acotada**: la ruta HTTP es la PLANTILLA registrada
  (`/v1/organizations/:orgId`), jamás la URL cruda; los paths sin match colapsan en
  `unmatched`. Tope de 500 series por métrica; el exceso se descarta y se cuenta en
  `fluvia_metrics_dropped_series_total`.
- **Agregados anónimos**: prohibidos labels con tenant_id, user_id, emails o cualquier
  identificador. `/metrics` no revela datos de negocio (test lo verifica).
- **Un observador de métricas jamás rompe el proceso observado**: todos los hooks
  (`onStats`, `onCheck`, `onHeartbeat`) tragan errores del observador (probado).

### API (mismo puerto que la API)

| Métrica                                | Tipo      | Labels                      |
| -------------------------------------- | --------- | --------------------------- |
| `fluvia_http_requests_total`           | counter   | `method`, `route`, `status` |
| `fluvia_http_request_duration_seconds` | histogram | `method`, `route`           |

### Worker (`WORKER_METRICS_PORT`, default 9464)

| Métrica                                       | Tipo    | Labels                                                     |
| --------------------------------------------- | ------- | ---------------------------------------------------------- |
| `fluvia_worker_heartbeats_total`              | counter | —                                                          |
| `fluvia_outbox_relay_cycles_total`            | counter | —                                                          |
| `fluvia_outbox_relay_events_total`            | counter | `result` = `delivered` \| `retried` \| `dead`              |
| `fluvia_ledger_projection_drift_checks_total` | counter | —                                                          |
| `fluvia_ledger_projection_drift_accounts`     | gauge   | — (0 = sano)                                               |
| `fluvia_technical_purge_runs_total`           | counter | —                                                          |
| `fluvia_technical_purge_rows_total`           | counter | `class` (F1-09)                                            |
| `fluvia_inbox_cycles_total`                   | counter | — (F3-03b)                                                 |
| `fluvia_inbox_events_total`                   | counter | `result` = `processed` \| `ignored` \| `retried` \| `dead` |
| `fluvia_payment_attempts_swept_total`         | counter | — (F3-04)                                                  |
| `fluvia_payment_attempts_indeterminate`       | gauge   | —                                                          |
| `fluvia_payment_attempts_indeterminate_aged`  | gauge   | — (0 = sano)                                               |
| `fluvia_webhook_deliveries_total`             | counter | `result` = `delivered` \| `retried` \| `dead` (F3-07)      |
| `fluvia_checkout_sessions_swept_total`        | counter | `result` = `completed` \| `expired` (F3-05c-ii)            |
| `fluvia_settlement_reports_reconciled_total`  | counter | — (F4-02; reportes con periodo cerrado conciliados)        |
| `fluvia_reconciliation_entries_total`         | counter | `status` = `matched` \| `amount_mismatch` \| `missing_in_ledger` \| `missing_at_provider` (F4-02) |
| `fluvia_reconciliation_discrepancies_last`    | gauge   | — (0 = cuadrado; discrepancias del último barrido)         |

## 3. Correlación extremo a extremo (hoy)

`x-request-id` entrante (saneado anti log-injection) o UUID generado → `req.id` → todos
los logs del request (pino) → sobre de error (`error.request_id`) → metadatos de
auditoría (`audit_log.request_id` vía `meta(req)`). Un incidente se sigue con un solo
identificador desde el cliente hasta la fila de auditoría.

## 4. Alertas baseline (reglas para el scraper que exista)

> Cada alerta de esta tabla tiene su **runbook** (diagnóstico → resolución → verificación) en [`docs/ops/runbooks/`](../ops/runbooks/README.md) (F4-06a). La columna «Acción» es el resumen; el runbook es el procedimiento.

| Alerta                      | Expresión (PromQL orientativo)                                                        | Severidad | Acción                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drift contable              | `fluvia_ledger_projection_drift_accounts > 0`                                         | CRÍTICA   | Incidente: investigar ANTES de cualquier rebuild (V4 §30; la reparación es siempre explícita)                                                             |
| Chequeos de drift detenidos | `increase(fluvia_ledger_projection_drift_checks_total[10m]) == 0`                     | ALTA      | El watcher no corre: revisar worker                                                                                                                       |
| Eventos dead en outbox      | `increase(fluvia_outbox_relay_events_total{result="dead"}[5m]) > 0`                   | ALTA      | Revisar DLQ; replay SOLO auditado                                                                                                                         |
| Eventos dead en inbox       | `increase(fluvia_inbox_events_total{result="dead"}[5m]) > 0`                          | ALTA      | Webhook de proveedor envenenado: revisar DLQ; replay SOLO auditado                                                                                        |
| Indeterminados envejecidos  | `fluvia_payment_attempts_indeterminate_aged > 0`                                      | ALTA      | Dinero en desenlace desconocido >30 min: consultar al proveedor o conciliar (V4 §23) — JAMÁS resolver por asunción                                        |
| Webhooks salientes dead     | `increase(fluvia_webhook_deliveries_total{result="dead"}[15m]) > 0`                   | MEDIA     | Endpoint del comercio agotó el calendario de reintentos: revisar `webhook_attempts` (IP/status/error por intento); reenvío manual auditado llega en F3-09 |
| Discrepancias de conciliación | `fluvia_reconciliation_discrepancies_last > 0` o `increase(fluvia_reconciliation_entries_total{status=~"amount_mismatch\|missing_in_ledger\|missing_at_provider"}[1h]) > 0` | ALTA | Dinero real sin cuadrar contra el reporte del proveedor: investigar por `reconciliation_entries` (F4-02) — JAMÁS corrección silenciosa (V4 §30) |
| Worker sin latido           | `increase(fluvia_worker_heartbeats_total[5m]) == 0`                                   | ALTA      | Proceso caído o colgado                                                                                                                                   |
| Tasa de 5xx                 | `rate(fluvia_http_requests_total{status=~"5.."}[5m]) > 0`                             | ALTA      | 5xx debe ser ~0; cualquier valor sostenido es bug                                                                                                         |
| Latencia p99                | `histogram_quantile(0.99, rate(fluvia_http_request_duration_seconds_bucket[5m])) > 1` | MEDIA     | Contra baseline SLO de `system-overview.md` §5                                                                                                            |
| Abuso de auth               | `rate(fluvia_http_requests_total{route=~"/v1/auth/.*",status="429"}[5m])` elevado     | MEDIA     | Posible credential stuffing; correlacionar con lockouts en `audit_log`                                                                                    |
| API no lista                | `GET /ready` ≠ 200 (probe)                                                            | CRÍTICA   | BD inaccesible                                                                                                                                            |

## 5. Límites honestos y decisiones (Nivel C, reversibles)

- **OTel diferido (desviación registrada sobre el backlog original)**: el SDK de
  OpenTelemetry sin un collector real detrás sería capacidad simulada (V4 Nivel A:
  no declarar capacidades simuladas). Hoy la correlación es por `request_id` en logs;
  OTel entra cuando exista destino de despliegue con collector (F6). El diseño no lo
  bloquea: los hooks de métricas son el mismo punto de instrumentación que usará OTel.
- **Métricas en proceso**: se reinician con el proceso (semántica estándar; los rates
  se calculan en el scraper). Sin agregación multi-proceso hasta que haya >1 réplica.
- **`/metrics` sin autenticación**: expone SOLO agregados anónimos. En sandbox abierto
  es aceptable; en despliegues reales debe quedar en red interna de scrape (gate en
  `production-gates.md`).
- **Dashboards**: fuera del repo hasta F6; §4 es el contrato de alertas.
