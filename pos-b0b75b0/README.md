# Evidencia visual saneada — POS sandbox (PR #55)

- **Commit**: `b0b75b00b2272f7e39a0f2adf71a5104c159a105` (cabeza del PR #55, rama `claude/keen-keller-hydhh2`); árbol limpio: True
- **BUILD_ID**: dashboard `O3oKK9Es6SonOj-IfL0S8` · checkout `G1Yj7K_Mwetv6fS72z___` (el BUILD_ID del dashboard aparece en el HTML de cada captura)
- **Modo**: next build + next start (producción), MockProvider, datos de seed de demo en BD recién creada
- **Generado (UTC)**: 2026-09-29T18:44:25.903Z
- **Saneado**: Playwright screenshot `mask` (negro) sobre .org, .pos-refs, .pos-url, .pos-recent-list; verificación automática del texto visible restante. Oculto: nombre de la organización, IDs de sesión de checkout y de pago, URL del checkout y filas del historial. El `client_secret` nunca se pinta en pantalla.
- **Comprobaciones**: 16/16 OK (ver `manifest.json`).

Esta rama solo contiene evidencia. No contiene código y no forma parte del PR #55.

| Archivo | Viewport (px) | Caso | Pantalla | Fase observada | Overflow horizontal (px) | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| `390px-1-aprobado.png` | 390 | 1-aprobado | POS: pago aprobado | `succeeded` | 0 | `1fb4ccf0ddd699290e5225be5fbd721b253f4878f5e865b5d203e0aaef8714af` |
| `390px-2-rechazado-recuperacion.png` | 390 | 2-rechazado-recuperacion | POS: tras el rechazo, checkout nuevo abierto para la misma venta | `awaiting_payment` | 0 | `f6823f10573884cc0afd604b97443341eb8d0206d3b41bb4ec63d98115681d0e` |
| `390px-3-en-proceso.png` | 390 | 3-en-proceso | POS: pago en proceso (asíncrono) | `processing` | 0 | `4c6836edf8665cf43c5d77027bade5852a7ffda07a051af9ef42b185b50ea9c7` |
| `768px-1-aprobado.png` | 768 | 1-aprobado | POS: pago aprobado | `succeeded` | 0 | `0285c836debbc9bec5770f3cdc56313f7def9c7f6784b24cf3cd0eeb11b032fa` |
| `768px-2-rechazado-recuperacion.png` | 768 | 2-rechazado-recuperacion | POS: tras el rechazo, checkout nuevo abierto para la misma venta | `awaiting_payment` | 0 | `947d5e20fc15d41a03334683aea21dd787cc1e515f175853e65ee92e0035da69` |
| `768px-3-en-proceso.png` | 768 | 3-en-proceso | POS: pago en proceso (asíncrono) | `processing` | 0 | `209def993804c1e841fb6d1516cda2abe62b2660a76ea1a071195d991195e6e7` |
| `1440px-1-aprobado.png` | 1440 | 1-aprobado | POS: pago aprobado | `succeeded` | 0 | `9c73e00087e9a83debe69fa9cab24851ed7e3203834029a7936f75d3bde8b7bb` |
| `1440px-2-rechazado-recuperacion.png` | 1440 | 2-rechazado-recuperacion | POS: tras el rechazo, checkout nuevo abierto para la misma venta | `awaiting_payment` | 0 | `d9b794eb2b0c2a8fe7896bd60dbc154950540d6c5c554e0ce1ea7b8030420c8d` |
| `1440px-3-en-proceso.png` | 1440 | 3-en-proceso | POS: pago en proceso (asíncrono) | `processing` | 0 | `9d82bf824bd413ab26cd5c77901ef5f1ae985a29d2ed6a10bc8522d9c6f5e993` |

Notas:
- En el caso «rechazado con recuperación» se captura el estado DESPUÉS de la recuperación (checkout nuevo abierto para la misma venta). Que es la misma venta (mismo link, sesión nueva) y que hubo 1 creación y 2 aperturas se verifica automáticamente en cada ancho (ver comprobaciones). La pantalla intermedia «Pago rechazado» no está en esta selección de 9.
- «En proceso» es el estado final observable en local: el pago asíncrono del MockProvider solo se resuelve con un webhook del proveedor simulado, que en local no se envía.
- La revisión visual la cierra el propietario.
