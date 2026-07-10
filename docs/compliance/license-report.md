# Reporte de licencias transitivas (generado)

- **Fecha**: 2026-07-10 · **Commit base**: `beabf26a9396f8906f1bdad7525bc3a30cb40648`
- **Herramienta**: `pnpm licenses list --json` (nativa de pnpm; licencias DECLARADAS en manifests — ver limitaciones)
- **Comandos**: `pnpm licenses list --prod --json` (gate) · `pnpm licenses list --json` (informativo)
- **Regenerar**: `pnpm licenses:report` · **Gate**: `pnpm licenses:check` (CI, job security)

## Producción (lo que se distribuye) — GATE

Total: **126 paquetes** · permitidas 124 · restringidas 2 · prohibidas 0 · desconocidas 0

| Licencia | Paquetes | Clasificación |
| --- | --- | --- |
| 0BSD | 1 | permitida |
| Apache-2.0 | 9 | permitida |
| BSD-3-Clause | 4 | permitida |
| CC-BY-4.0 | 1 | restringida |
| ISC | 8 | permitida |
| LGPL-3.0-or-later | 1 | restringida |
| MIT | 102 | permitida |

### Restringidas — REQUIEREN DECISIÓN HUMANA antes de producción/release

- `@img/sharp-libvips-linux-x64@1.2.4` — **LGPL-3.0-or-later** (sin decisión registrada en license-exceptions.json)
- `caniuse-lite@1.0.30001800` — **CC-BY-4.0** (sin decisión registrada en license-exceptions.json)

### Prohibidas / desconocidas en producción

- (ninguna)

## Árbol completo incl. devDependencies — INFORMATIVO (no se distribuyen)

Total: **355 paquetes** · fuera del tier permitido: `@img/sharp-libvips-linux-x64` (LGPL-3.0-or-later), `argparse` (Python-2.0), `axe-core` (MPL-2.0), `caniuse-lite` (CC-BY-4.0)

## Resultado

**PASS** — sin prohibidas ni desconocidas en producción; 2 restringida(s) pendiente(s) de decisión humana (bloquean release, no este check en modo normal).

## Limitaciones conocidas

- Reporta licencias **DECLARADAS** en los `package.json` del árbol (igual que el SBOM SPDX de syft): no hay escaneo file-level ni análisis de NOTICE/vendored code.
- El árbol proviene del lockfile (incluye optional deps de todas las plataformas pineadas, p. ej. los binarios de sharp/libvips).
- Este reporte es una FOTO del commit indicado; el check de CI es el gate vivo por commit.
