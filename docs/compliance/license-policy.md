# Política de licencias de dependencias (RA-F6-004)

Estado: Activa (2026-07-10) · Origen: re-auditoría F6 delta, hallazgo RA-F6-004 (P2) · Forma ejecutable: `scripts/check-licenses.mjs` (las listas SPDX del script son el espejo 1:1 de §2 — cambiar una exige cambiar la otra en el mismo PR).

## 1. Objetivo y alcance

Garantizar que ninguna dependencia (directa o **transitiva**) imponga obligaciones incompatibles con distribuir Fluvia comercialmente. El **gate duro** aplica a las dependencias de **producción** (lo que se distribuye/ejecuta en el producto); las `devDependencies` (tooling de build/test) se reportan como **informativas** — no se distribuyen, pero se vigilan en el mismo reporte.

## 2. Clasificación

- **Permitidas** (uso libre, salvo ambigüedad en el manifest): `MIT`, `MIT-0`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `CC0-1.0`, `Unlicense`, `BlueOak-1.0.0`.
- **Restringidas — requieren decisión humana ANTES de producción/release**: `MPL-2.0`, `EPL-2.0`, toda la familia `LGPL-*` (copyleft débil / scoped a archivo), `CC-BY-*` (atribución en datos), `Python-2.0`, `Artistic-2.0`, licencias duales ambiguas y cualquier copyleft débil equivalente.
- **Prohibidas para producción/release sin aprobación legal explícita**: familia `GPL-*`, `AGPL-*`, `SSPL`, `BUSL`, `Commons Clause`, licencias no comerciales (`CC-BY-NC-*`, "NonCommercial"), licencias que impongan abrir el producto completo, propietarias no autorizadas, `UNLICENSED` y paquetes **sin licencia verificable**.
- **Desconocidas**: licencia vacía, `UNKNOWN`, custom o expresión SPDX no parseable → se tratan como bloqueantes del gate (fallan el check) hasta clasificarse.

**Duales/expresiones SPDX**: `A OR B` → basta que UNA rama sea permitida (el consumidor elige); `A AND B` → TODAS deben ser permitidas; expresiones mixtas o no parseables → desconocida (revisión humana).

## 3. Decisión humana y excepciones

- **Nada dudoso se acepta automáticamente.** El check LISTA las restringidas/desconocidas; aceptar el riesgo es del **propietario** (con revisión legal cuando aplique), NUNCA del tooling ni del agente.
- Una decisión se registra en `docs/compliance/license-exceptions.json` (versionado, revisable en code review): `{ "package", "license", "status": "aceptada" | "rechazada", "reason", "approvedBy", "date" }`. Solo `status: "aceptada"` desbloquea el modo `--strict` para ese paquete.
- **Producción/release público queda BLOQUEADO** mientras exista en producción una licencia prohibida, desconocida o restringida **sin decisión registrada** (enlaza con `production-gates.md`).

## 4. Check y reproducibilidad

- `pnpm licenses:check` — el gate (corre en CI, job `security`): **falla** ante prohibida o desconocida en producción; las restringidas sin decisión producen warning visible (y fallo en `--strict`, el modo objetivo una vez registradas las decisiones).
- `pnpm licenses:report` — regenera `docs/compliance/license-report.md` (fecha, commit, comandos, totales, listas, resultado). Regenerarlo al cambiar el lockfile o antes de un release.
- Herramienta: `pnpm licenses list --json` (nativa; licencias declaradas en manifests — misma fuente que el SBOM SPDX de syft en CI). Limitaciones documentadas en el reporte.

## 5. Actualización de esta política

Cambios de clasificación = PR con razón + actualización sincronizada de `scripts/check-licenses.mjs`. Ampliar la lista de permitidas o aceptar una excepción es SIEMPRE decisión del propietario.
