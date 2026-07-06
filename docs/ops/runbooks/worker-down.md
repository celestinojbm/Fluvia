# Runbook · Worker caído o watcher detenido

**Alertas**: `increase(fluvia_worker_heartbeats_total[5m]) == 0` (proceso caído/colgado) · `increase(fluvia_ledger_projection_drift_checks_total[10m]) == 0` (un watcher no corre) · **Sev**: ALTA (SEV-2).

**Qué significa**: `apps/worker` corre los trabajos de fondo. Si el proceso muere o un job deja de latir, se **acumulan silenciosamente** riesgos: outbox/inbox sin despachar, indeterminados sin envejecer visiblemente, drift sin detectar, purga sin correr. El worker en sí no mueve dinero por su cuenta, pero es la red de seguridad que hace visible y recuperable lo que sí lo hace.

## Qué corre el worker (y su gate)

| Job | Gate `*_ENABLED` / `*_INTERVAL_MS` (default) | Métrica clave |
| --- | --- | --- |
| Heartbeat | (siempre; ~30 s) | `fluvia_worker_heartbeats_total` |
| Outbox relay | `RELAY_*` (1 s) | `fluvia_outbox_relay_events_total{result}` |
| Drift watcher | `DRIFT_CHECK_*` (60 s) | `fluvia_ledger_projection_drift_checks_total`, `..._accounts` |
| Inbox processor | `INBOX_*` (1 s) | `fluvia_inbox_events_total{result}` |
| Attempts watchdog | `ATTEMPTS_WATCHDOG_*` (60 s) | `fluvia_payment_attempts_indeterminate_aged` |
| Checkout watchdog | `CHECKOUT_WATCHDOG_*` (60 s) | `fluvia_checkout_sessions_swept_total{result}` |
| Reconciliation watchdog | `RECONCILIATION_WATCHDOG_*` (60 s) | `fluvia_reconciliation_discrepancies_last` |
| Technical purge | `PURGE_*` (1 h) | `fluvia_technical_purge_runs_total` |
| Webhook deliverer | `WEBHOOK_DELIVERY_*` (1 s) | `fluvia_webhook_deliveries_total{result}` |

Servidor de salud/métricas: `WORKER_METRICS_PORT` (default 9464), `GET /health` (200 `{status, heartbeats, env}`) y `GET /metrics` (Prometheus).

## Diagnóstico

1. **¿El proceso vive?** `GET :9464/health`. Sin respuesta → el proceso está caído/no arrancó. Con respuesta pero `heartbeats` sin avanzar entre dos lecturas → colgado.
2. **¿Un solo job detenido?** Si el heartbeat late pero una métrica de ciclo concreta (`*_cycles_total` / `*_checks_total`) no incrementa, es ese job: revisa si su `*_ENABLED` está en `false` (¿desactivado a propósito?) o si lanza una excepción por ciclo en los logs.
3. **¿Arrancó bien?** `checkReady()` corre `SELECT 1` antes de arrancar; si la BD estaba inaccesible al inicio, el worker no habrá subido → revisar conectividad y credenciales del rol (`fluvia_worker` y los pools por job).
4. Revisa por qué murió: OOM, excepción no capturada, `SIGTERM` de un despliegue.

## Resolución

1. **Reiniciar** el worker (en compose: el servicio `worker`; en cloud: el orquestador). El apagado es graceful (`SIGTERM`/`SIGINT` paran cada job y cierran los pools), así que un reinicio limpio no deja leases colgados: los claims usan `FOR UPDATE SKIP LOCKED` y expiran por lease.
2. Si un job estaba **desactivado** por error (`*_ENABLED=false`), corrígelo en la config del entorno y reinicia.
3. Tras el reinicio, los backlogs se **drenan solos**: el relay/inbox/deliverer reintentan con backoff; los watchdogs vuelven a barrer. No hay que «empujar» nada a mano.
4. **Verifica el daño acumulado** durante la caída, en orden de gravedad:
   - Drift: correr una vez el watcher / `ledger_projection_drift()` → si hay drift, [`ledger-drift.md`](./ledger-drift.md) (SEV-1).
   - Indeterminados envejecidos que se acumularon → [`indeterminate-payment.md`](./indeterminate-payment.md).
   - Discrepancias de conciliación de periodos que cerraron durante la caída → [`reconciliation-discrepancy.md`](./reconciliation-discrepancy.md).
   - Eventos `dead` acumulados en outbox/inbox → [`outbox-inbox-stuck.md`](./outbox-inbox-stuck.md).

## Verificación

1. `GET :9464/health` responde y `heartbeats` avanza entre lecturas.
2. Las métricas de ciclo de cada job vuelven a incrementar.
3. Las alertas derivadas (drift, indeterminados, dead) se despejan a medida que se drenan los backlogs.

## Escalación

- Reinicios en bucle (crash loop) → revisar logs de arranque; probable config/credenciales o una migración pendiente (`pnpm migrate`).
- Si durante la caída se acumuló un problema de **integridad** (drift, indeterminado no confirmable), ese problema escala por su propio runbook a SEV-1.

## Drill (F4-06b)

Pendiente: matar el worker → observar la alerta de heartbeat → reiniciar → confirmar `/health` y el reanudado de los ciclos + el drenado de cualquier backlog.
