# Alcance PCI

Estado: Activo · Fase: 0 · Objetivo: mantener a Fluvia en el alcance MÍNIMO posible (orientación SAQ A-like), sin declarar cumplimiento sin evaluación formal.

## Estrategia

1. **El backend de Fluvia nunca ve PAN ni CVV.** La captura de datos de tarjeta ocurre en componentes alojados/tokenización del proveedor (equivalente a Stripe Elements / campos del PSP); Fluvia solo maneja tokens opacos (`payment_method_tokens`).
2. El MockProvider replica este contrato: incluso en sandbox, el "formulario de tarjeta" del checkout entrega un token, jamás el PAN al API de Fluvia — así ninguna integración se acostumbra a mandarnos tarjetas.
3. Defensas activas: el API rechaza estructuras que aparenten datos de tarjeta en endpoints no permitidos (heurística conservadora + log de incidente, sin pretender que un blocklist de nombres de campo "resuelve PCI" — V4 §34); prohibido PAN/CVV en URLs, logs, analytics y mensajes de error (redacción en logger); TLS en todo tránsito.
4. Sin vault propio de tarjetas en el MVP (fuera de alcance §9). Si algún día se evalúa, requiere ADR + arquitectura y certificación dedicadas (Nivel A).

## Trabajo pendiente

- Evaluación PCI aplicable formal: gate de producción (§51); no se afirma ningún nivel de cumplimiento hasta entonces.
- Revisión del alcance al integrar el proveedor real (Fase 5): confirmar que el flujo de tokenización del proveedor mantiene a Fluvia fuera del CDE.
