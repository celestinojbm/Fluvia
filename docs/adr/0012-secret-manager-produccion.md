# ADR-0012 — Gestión de secretos en producción: inyección desde secret manager + rotación

Estado: **Propuesto** · Fase 6 (hardening) · Origen: residual «Secretos/cadena» del threat model §5 + regla 6 de `../security/secrets-management.md` · Bloqueado por PEND-006 (sandbox compartido) · Vendor concreto diferido al despliegue (F5)

## Contexto

Hoy TODOS los secretos de runtime entran por **variables de entorno** validadas en `packages/config`: `required()` lanza fuera de local/test, `LOCAL_DEFAULTS` solo aplica en local/test, y la anti-mezcla impide arrastrar credenciales entre entornos. Los secretos que además viven en la BD ya están cifrados o pepper-izados (TOTP AES-256-GCM con `MFA_SECRET_KEY`; `whsec_` AES-256-GCM con `WEBHOOK_SECRET_ENC_KEY`; API keys en **HMAC-SHA256 con pepper** `API_KEY_HMAC_SECRET` que NUNCA se persiste). La imagen Docker (F3-11b) no contiene secretos. La regla 6 de `secrets-management.md` difería la fuente en cloud a «secret manager del proveedor (decisión de despliegue, **ADR pendiente en F6**)», y el threat model coloca el secret manager en el **tier de confianza superior** (§4, DBA/infra). Falta cerrar ese residual antes del sandbox compartido: dónde nacen los secretos en producción y cómo se rotan.

Este ADR decide el **enfoque** (portátil, sin atarse a un proveedor). El vendor concreto (AWS Secrets Manager / GCP Secret Manager / Vault / …) y su cableado IAM se fijan en el despliegue real (F5), donde existe un objetivo concreto.

## Decisión

1. **Inyección al arranque, no SDK en runtime.** El secret manager del proveedor es la **fuente de verdad**; el orquestador de despliegue **inyecta los secretos como variables de entorno** al iniciar el proceso. La app conserva su contrato actual (env validado + anti-mezcla) — **cero código de runtime nuevo** y **cero acoplamiento a un SDK de proveedor** en el proceso. El env es la costura que hace pluggable cualquier manager sin tocar la app (coherente con ADR-0001: núcleo sin lock-in de proveedor).
2. **Ningún secreto en el repo ni en la imagen.** Reafirma la regla 1 de `secrets-management.md`: la imagen (F3-11b) no lleva secretos; llegan SOLO en runtime por la integración del orquestador. Los passwords de dev de `0002` siguen siendo la única excepción consciente, acotada a local (guard de entorno).
3. **Rotación documentada por clase de secreto** (runbook, la otra pata del residual §5):
   - **Secretos de firma de webhooks** (`whsec_`): ya soportan **rotación con dos secretos activos** durante la ventana (F3-07) — rotan sin downtime, sin cambio de código.
   - **Pepper de API keys / clave MFA / clave de cifrado de webhooks** (`API_KEY_HMAC_SECRET`, `MFA_SECRET_KEY`, `WEBHOOK_SECRET_ENC_KEY`): rotación por **clave versionada** con re-hash/re-cifrado **perezoso** — el patrón que las API keys YA implementan (`key_hash_version`, v1→v2 en la primera autenticación). El runbook: publicar la versión nueva, re-derivar al primer uso, retirar la vieja tras cobertura. Se registra como **pata operacional** (el threat model §5 Auth ya la anota: «versión+rotación de pepper/MFA-key»); su implementación para MFA/webhook-enc es trabajo aparte, previo a una rotación real.
   - **Passwords de roles de BD**: rotados en el secret manager + reinicio rolling (los roles son de mínimo privilegio, ADR-0011; no hay BYPASSRLS que amplíe el radio).
4. **Credenciales de proveedor (F5)**: cifrado **field-level** en reposo con la clave en el secret manager (regla 5), desde su primera aparición al integrar el proveedor real. Este ADR fija la decisión para que F5 la construya de entrada; el runtime del cifrado NO se adelanta (no hay proveedor aún).
5. **Límite honesto (V4 Nivel A).** Este ADR es la **decisión de diseño**; NO hay integración de secret manager en el sandbox (no hay infra externa) — construir una integración falsa sería capacidad simulada. La integración es una preocupación de **despliegue**, realizada cuando exista un objetivo real (F5/producción). La costura estable (env validado + anti-mezcla) es lo que ya existe y prueba el enfoque.

## Alternativas

- **SDK del proveedor en runtime** (la app trae los secretos del manager por API al arrancar/en caliente): rechazado por defecto — ata la app a un vendor, añade una dependencia y un modo de fallo dentro del límite de confianza del proceso, y complica los tests; la costura de env es más simple y agnóstica. Reconsiderar solo si la **rotación en caliente sin reinicio** se vuelve requisito duro (entonces un SDK acotado a un adaptador detrás de la misma interfaz de config).
- **Secretos cifrados versionados en el repo** (SOPS / sealed-secrets / git-crypt) para los secretos de la APP: rechazado — sigue poniendo cifrotexto + gestión de claves en el repo, cuando el secret manager es la fuente de verdad. (SOPS puede ser elección del operador para manifiestos de despliegue GitOps — fuera del alcance de este ADR.)
- **Solo env, sin manager** (status quo): rechazado para producción — sin rotación/auditoría/control-de-acceso central; válido solo para local/CI.

## Consecuencias

+ La app queda **agnóstica de proveedor** y testeable (costura de env); sin acoplamiento a un SDK; la imagen Docker sigue **sin secretos**.
+ La rotación tiene un camino documentado por clase; el patrón de **clave versionada** (ya probado en API keys v1→v2) generaliza a las demás.
− La inyección al arranque implica que rotar un secreto estático (pepper/clave-enc) exige un **reinicio rolling** + el runbook de re-hash/re-cifrado versionado (no hay rotación en caliente para esos sin el trabajo de clave versionada).
− El **vendor concreto + IAM** es una decisión de despliegue diferida a F5; este ADR fija el enfoque, no el proveedor.

## Riesgos

- Si la **rotación por clave versionada** para pepper/MFA-key/webhook-enc no se construye antes de necesitar una rotación real, rotarlas invalidaría hashes/cifrotextos existentes (las API keys ya lo manejan perezoso v1→v2; MFA/webhook-enc necesitan el mismo patrón). Mitigación: registrado como pata operacional, trackeado en el §5.
- La inyección por env expone los secretos en el entorno del proceso (legible por quien pueda leer `/proc` del proceso): aceptable dentro del **tier de confianza superior** (infra/DBA, threat model §4); un SDK en runtime NO lo elimina (los secretos igual aterrizan en memoria).

## Evidencia

Contrato de env validado + anti-mezcla en `packages/config` (`required()` + `LOCAL_DEFAULTS` solo local/test); cifrado en reposo existente (TOTP AES-GCM `totp.ts`, webhook `whsec_` AES-GCM `webhooks/src/crypto.ts`); pepper HMAC fuera de la BD con `key_hash_version` (v1→v2 perezoso, `api-keys.ts`) como patrón de rotación versionada de referencia; imagen Docker sin secretos (F3-11b); mínimo privilegio de roles (ADR-0011). **Runtime del secret manager: diferido al despliegue real** — no hay infra externa en sandbox (sin capacidad simulada). Actualiza la regla 6 de `../security/secrets-management.md` y cierra la parte «ADR» del residual «Secretos/cadena» del threat model §5 (quedan: runbooks de rotación efectivos + cifrado field-level de credenciales de proveedor en F5).
