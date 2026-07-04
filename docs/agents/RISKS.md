# Registro de riesgos

Estado: Activo · Se revisa al cierre de cada fase

| ID | Riesgo | Clase | Prob. | Impacto | Mitigación | Dueño/Estado |
|----|--------|-------|-------|---------|------------|--------------|
| R-01 | Drift entre proyección de balance y ledger | Financiero | Media | Crítico | Guard optimista + rebuild verificable + drift check con alerta + script de invariantes externo (F2-05/06) | Abierto (diseño listo) |
| R-02 | Duplicación de efectos por retry/carrera | Financiero | Media | Crítico | Idempotencia multicapa durable (ADR-0006) + Gate Idempotencia | Abierto (diseño listo) |
| R-03 | Tenant escape | Seguridad | Baja | Crítico | Defensa en profundidad + RLS forzado + suite de escape en CI | Parcialmente mitigado (spike verde) |
| R-04 | Pérdida de eventos salientes/entrantes | Operativo | Baja | Alto | Outbox/Inbox durable + DLQ + replay auditado (ADR-0007) | Abierto (diseño listo) |
| R-05 | Estado ambiguo del proveedor tratado como fallo → doble cobro | Financiero | Media | Alto | Estado `indeterminate` + consulta/webhook/conciliación; nunca retry ciego (§23) | Abierto (diseño listo) |
| R-06 | Codificar supuestos legales sin jurisdicción definida | Regulatorio | Media | Alto | País abstracto; matriz PEND-001 bloquea Fase 5; nada legal en código | Mitigado por proceso |
| R-07 | Presentar sandbox como capacidad productiva | Regulatorio | Baja | Crítico | Production gates con evidencia obligatoria; lenguaje de docs; Nivel A | Mitigado por gobernanza |
| R-08 | Deuda del spike tratada como base definitiva sin revisión | Técnico | Media | Medio | Spike marcado como revisable; F1-03/F2-01 lo migran formalmente | Abierto |
| R-09 | Complejidad del monorepo crece sin dueño humano | Operativo | Media | Medio | Backlog único, ADRs, regla de dependencia justificada en PR | Abierto |
| R-10 | Dependencia AGPL u otra licencia viral entra al árbol | Legal | Baja | Alto | Revisión de licencia por dependencia nueva (CONTRIBUTING) + scanning CI (F1-02) | Mitigado por proceso |
| R-11 | SSRF vía webhooks salientes | Seguridad | Media | Alto | Guard obligatorio pre-primer-delivery (F3-07, bloqueante) | Abierto |
| R-12 | Passwords dev de roles BD reutilizados fuera de local | Seguridad | Baja | Alto | Solo docker local; aprovisionamiento gestionado desde sandbox (F1-02); documentado | Aceptado temporalmente |
| R-13 | Licencias de referencias no verificadas en vivo (proxy de sesión) | Legal | Baja | Medio | F0-VER antes de adoptar cualquier código de referencia | Abierto |
