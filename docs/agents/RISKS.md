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
| R-12 | Passwords dev de roles BD reutilizados fuera de local | Seguridad | Baja | Alto | Solo docker local; aprovisionamiento gestionado desde sandbox (F1-02); documentado; guard de entorno en F1-09 (AUD-P2-008) | Aceptado temporalmente |
| R-13 | Licencias de referencias no verificadas en vivo (proxy de sesión) | Legal | Baja | Medio | F0-VER antes de adoptar cualquier código de referencia | Abierto |
| R-14 | Sobregiro contable en operaciones two-legged (release/refund > saldo) | Financiero | — | Crítico | Guard `nonNegativeAccounts` bajo locks + golden tests (AUD-P1-010, lote AUD-1) | **Cerrado 2026-07-04** |
| R-15 | Entrada cross-tenant/cross-moneda en `ledger_entries` si el servicio se puentea | Financiero | — | Crítico | FK compuesta a nivel de motor + tests SQL crudo (AUD-P1-001, migración 0008) | **Cerrado 2026-07-04** |
| R-16 | Robo de API keys sin MFA/rate limiting en el plano de sesión | Seguridad | Media | Alto | F1-04b ampliado (AUD-P1-006): MFA TOTP + step-up + rate limiting antes de usuarios reales; live keys bloqueadas (decisión #19) | Abierto (gate de sandbox) |
| R-17 | Credenciales dev conectando a una base no-local por variables ausentes | Operativo | — | Alto | Anti-mezcla en `dbUrlsFromEnv` + `@fluvia/config`: arranque falla fuera de local sin URLs explícitas (AUD-P2-014) | **Cerrado 2026-07-04** |
