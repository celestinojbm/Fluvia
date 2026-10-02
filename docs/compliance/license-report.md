# Reporte de licencias transitivas (generado)

- **Fecha**: 2026-10-02 · **Commit base**: `fb9eb1150e596b358a9dd7b1e3f666b1924533ef`
- **Herramienta**: `pnpm licenses list --json` (nativa de pnpm; licencias DECLARADAS en manifests — ver limitaciones)
- **Comandos**: `pnpm licenses list --prod --json` (gate) · `pnpm licenses list --json` (informativo)
- **Regenerar**: `pnpm licenses:report` · **Gate**: `pnpm licenses:check` (CI, job security)

## Producción (lo que se distribuye) — GATE

Total: **132 paquetes** · permitidas 129 · restringidas 3 · prohibidas 0 · desconocidas 0

| Licencia | Paquetes | Clasificación |
| --- | --- | --- |
| 0BSD | 1 | permitida |
| Apache-2.0 | 9 | permitida |
| BSD-3-Clause | 4 | permitida |
| CC-BY-4.0 | 1 | restringida |
| ISC | 9 | permitida |
| LGPL-3.0-or-later | 1 | restringida |
| MIT | 106 | permitida |
| OFL-1.1 | 1 | restringida |

### Restringidas — DECISIÓN HUMANA registrada en license-exceptions.json (bloquean release hasta decidirse)

- `@fontsource-variable/manrope@5.3.0` — **OFL-1.1** — **estado: aceptada** (decisión humana registrada)
  - **Aprobado por**: Celestino Briceño · **Fecha de aprobación**: 2026-10-01
  - **Razón**: Fuente de la identidad visual solicitada por el propietario. OFL-1.1 permite uso, incrustacion y redistribucion con el software, incluido uso comercial; no impone licencia al producto
  - **Obligaciones**: Conservar el aviso de copyright y el texto OFL al redistribuir la fuente; no vender la fuente por separado; no usar el nombre reservado si se modifica la fuente (aqui no se modifica)
  - **reviewBy**: confirmar en la revision del PR de la jornada de diseño; re-evaluar en el gate de primer release publico/comercial
  - **La aceptación NO autoriza producción/release.**
- `@img/sharp-libvips-linux-x64@1.3.4` — **LGPL-3.0-or-later** — **estado: aceptada** (decisión humana registrada)
  - **Aprobado por**: Celestino Briceño · **Fecha de aprobación**: 2026-07-10
  - **Razón**: Componente LGPL usado como biblioteca/binario separado, sin modificaciones locales, enlazado dinamicamente y reemplazable; actualmente no se carga porque no se usa next/image; sin distribucion publica actual
  - **Obligaciones**: Mantener el componente sin modificaciones locales salvo nueva revision; conservar avisos/licencia; incluir aviso de terceros y referencia al fuente upstream de libvips en cualquier release publico/comercial; no impedir reemplazo/relinking del componente; si se modifica libvips, se enlaza estaticamente o se empaqueta de forma no reemplazable, esta excepcion caduca
  - **reviewBy**: revision legal LGPLv3 antes del primer release publico/comercial
  - **La aceptación NO autoriza producción/release.**
  - **LGPLv3**: requiere **revisión legal antes del primer release público/comercial**; la excepción caduca si cambia el modo de uso, si se modifica libvips, si se enlaza estáticamente o si se empaqueta de forma no reemplazable.
- `caniuse-lite@1.0.30001800,1.0.30001813` — **CC-BY-4.0** — **estado: aceptada** (decisión humana registrada)
  - **Aprobado por**: Celestino Briceño · **Fecha de aprobación**: 2026-07-10
  - **Razón**: Base de datos de compatibilidad de navegadores usada por Next/Browserslist; no es codigo de aplicacion; obligacion principal de atribucion al redistribuir; uso comun del ecosistema; sin distribucion publica actual
  - **Obligaciones**: Conservar LICENSE del paquete en artefactos distribuidos; incluir atribucion/aviso de terceros en cualquier release publico o comercial; no remover avisos de licencia
  - **reviewBy**: re-evaluar en el gate de primer release publico/comercial
  - **La aceptación NO autoriza producción/release.**

### Prohibidas / desconocidas en producción

- (ninguna)

## Árbol completo incl. devDependencies — INFORMATIVO (no se distribuyen)

Total: **357 paquetes** · fuera del tier permitido: `@fontsource-variable/manrope` (OFL-1.1), `@img/sharp-libvips-linux-x64` (LGPL-3.0-or-later), `argparse` (Python-2.0), `axe-core` (MPL-2.0), `caniuse-lite` (CC-BY-4.0)

## Resultado

**PASS** — sin prohibidas ni desconocidas en producción.

## Limitaciones conocidas

- Reporta licencias **DECLARADAS** en los `package.json` del árbol (igual que el SBOM SPDX de syft): no hay escaneo file-level ni análisis de NOTICE/vendored code.
- El árbol proviene del lockfile (incluye optional deps de todas las plataformas pineadas, p. ej. los binarios de sharp/libvips).
- Este reporte es una FOTO del commit indicado; el check de CI es el gate vivo por commit.
