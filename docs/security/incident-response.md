# Respuesta a incidentes

Estado: Versión inicial · Fase: 0 · Se convierte en runbook operativo con on-call en F4/F6

## Clasificación

| Sev | Definición | Ejemplos |
|-----|------------|----------|
| SEV-1 | Integridad financiera o aislamiento comprometidos | Drift ledger↔proyección no explicado, tenant escape, asiento desbalanceado publicado, secreto live filtrado |
| SEV-2 | Degradación grave sin corrupción | Outbox atascado, proveedor caído sin circuit breaker efectivo, webhook delivery > SLO |
| SEV-3 | Degradación parcial | Latencia elevada, DLQ creciendo con causa conocida |

## Procedimiento (versión Fase 0)

1. **Contener**: para SEV-1 financiero, activar el freeze del flujo afectado (congelar pagos del comercio/plataforma — mecanismo F4) antes de investigar a fondo.
2. **Preservar evidencia**: no se "limpia" nada; el ledger y el audit log son append-only precisamente para esto.
3. **Investigar** con correlation IDs extremo a extremo.
4. **Corregir** solo por los caminos sancionados (compensaciones, replay de outbox/inbox, rebuild de proyecciones) — nunca SQL manual sobre datos financieros; si fuera inevitable, requiere four-eyes y queda en el audit log.
5. **Post-mortem sin culpas** con acciones rastreadas en el backlog.

Secretos comprometidos: rotación inmediata (procedimiento por clase en `secrets-management.md`), revocación de sesiones/keys afectadas, auditoría de uso del secreto en la ventana de exposición.
