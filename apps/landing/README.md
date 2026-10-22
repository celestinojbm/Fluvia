# Portada Fluvia

La única acción es el formulario de correo. El servidor valida el correo y hace `POST` a un webhook de Google Sheets. No envía un mensaje a quien se registra y no usa servicios de pago.

## Variable

Copia `.env.example` a `.env.local` en esta carpeta (Next la lee aquí, no en la raíz del monorepo):

```
LANDING_SHEETS_WEBHOOK_URL=
```

Pega la URL del web app (`https://script.google.com/macros/s/…/exec`). Si la dejas vacía, `POST /api/contacto` responde que el envío no está configurado y no guarda nada.

Quien tenga esa URL puede añadir filas. No la subas al repositorio.

## Apps Script

En la hoja: **Extensiones → Apps Script**. La primera fila puede ser `correo`, `fecha`, `origen`. El script solo añade filas debajo.

```javascript
function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  sheet.appendRow([body.email, body.date, body.origin]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(
    ContentService.MimeType.JSON
  );
}
```

El cuerpo que manda la portada es `{ "email", "date", "origin": "fluvia" }`. `date` va en ISO. La ruta solo da por bueno el envío si la respuesta trae `"ok": true`.

## Publicar el web app

1. **Implementar → Nueva implementación → Aplicación web.**
2. Ejecutar como **Yo**. Quién tiene acceso: **Cualquier persona** (si no, Google responde una página de acceso y el formulario no confirma el guardado).
3. Autoriza el acceso a la hoja cuando Google lo pida.
4. Copia la URL que termina en `/exec` en `LANDING_SHEETS_WEBHOOK_URL`.
5. Reinicia `pnpm --filter @fluvia/landing dev`.

Cada cambio del script pide una implementación nueva; la URL de `/exec` se mantiene si editas la misma implementación.
