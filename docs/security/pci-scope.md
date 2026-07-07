# Alcance PCI

Estado: Activo · Fase: 0 · **§3 (guard de tarjeta) construido en F6 (TM-06)** · Objetivo: mantener a Fluvia en el alcance MÍNIMO posible (orientación SAQ A-like), sin declarar cumplimiento sin evaluación formal.

## Estrategia

1. **El backend de Fluvia nunca ve PAN ni CVV.** La captura de datos de tarjeta ocurre en componentes alojados/tokenización del proveedor (equivalente a Stripe Elements / campos del PSP); Fluvia solo maneja tokens opacos (`payment_method_tokens`).
2. El MockProvider replica este contrato: incluso en sandbox, el "formulario de tarjeta" del checkout entrega un token, jamás el PAN al API de Fluvia — así ninguna integración se acostumbra a mandarnos tarjetas.
3. Defensas activas — **construidas y probadas (F6, TM-06)**: el API rechaza estructuras que aparenten datos de tarjeta en el borde (`apps/api/src/card-data-guard.ts`, hook `preValidation` — ANTES de auth, Zod o cualquier handler): valor con forma de PAN (13–19 dígitos + IIN de marca + Luhn — un epoch-ms de 13 dígitos NO dispara), campo con nombre inequívoco de tarjeta (`card_number`, `pan`, …) o de CVV, en cualquier profundidad del body (recorrido acotado anti-DoS) → **422 `card_data_not_allowed`** + log de incidente que JAMÁS incluye el valor + métrica `fluvia_card_data_rejected_total`. Probado sobre HTTP real (`card-data-guard.test.ts`: rechazo pre-auth y pre-validación, cero falsos positivos — la suite completa de 193 tests pasa con el guard activo). Heurística conservadora, sin pretender que un blocklist "resuelve PCI" (V4 §34). Además: prohibido PAN/CVV en URLs, logs, analytics y mensajes de error (redacción en logger); TLS en todo tránsito.
4. Sin vault propio de tarjetas en el MVP (fuera de alcance §9). Si algún día se evalúa, requiere ADR + arquitectura y certificación dedicadas (Nivel A).

## Trabajo pendiente

- Evaluación PCI aplicable formal: gate de producción (§51); no se afirma ningún nivel de cumplimiento hasta entonces.
- Revisión del alcance al integrar el proveedor real (Fase 5): confirmar que el flujo de tokenización del proveedor mantiene a Fluvia fuera del CDE.
