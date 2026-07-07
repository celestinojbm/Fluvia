import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@fluvia/config';
import { createPool, type Pool } from '@fluvia/db';
import { AuthService } from '@fluvia/auth';
import { ApiKeyService, IdentityService } from '@fluvia/identity';
import { buildApp } from '../src/app.js';
import { findCardData, looksLikePan, luhnValid } from '../src/card-data-guard.js';

/**
 * TM-06 (threat model §5 / pci-scope.md §3) — el API RECHAZA estructuras que
 * aparenten datos primarios de tarjeta (PAN/CVV) en el borde, ANTES de auth,
 * validación Zod o cualquier handler. Fluvia solo acepta tokens (`tok_…`).
 * Heurística conservadora: se prueba tanto la detección (PAN real-shaped,
 * campos de tarjeta, anidamiento) como la NO-detección (epoch ms de 13
 * dígitos, teléfonos, UUIDs, montos) — un guard con falsos positivos en un
 * API de pagos sería peor que ninguno.
 */

// PANs de PRUEBA públicos (docs de la industria); jamás tarjetas reales.
const VISA_16 = '4242424242424242';
const VISA_13 = '4222222222222';
const MC_16 = '5500000000000004';
const AMEX_15 = '340000000000009';
const EPOCH_MS_13 = '1783453142618'; // 13 dígitos, prefijo 1 ⇒ NO es IIN de marca

describe('luhnValid / looksLikePan (heurística pura)', () => {
  it('valida Luhn correctamente', () => {
    expect(luhnValid(VISA_16)).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
  });

  it('reconoce PANs de prueba de las marcas (13–19 dígitos + IIN + Luhn)', () => {
    expect(looksLikePan(VISA_16)).toBe(true);
    expect(looksLikePan(VISA_13)).toBe(true);
    expect(looksLikePan(MC_16)).toBe(true);
    expect(looksLikePan(AMEX_15)).toBe(true);
    // Formateados como suelen viajar:
    expect(looksLikePan('4242 4242 4242 4242')).toBe(true);
    expect(looksLikePan('5500-0000-0000-0004')).toBe(true);
  });

  it('NO marca valores legítimos de un API de pagos (conservador)', () => {
    expect(looksLikePan(EPOCH_MS_13)).toBe(false); // timestamp epoch-ms
    expect(looksLikePan('573001234567')).toBe(false); // teléfono CO con país (12 díg.)
    expect(looksLikePan(randomUUID())).toBe(false); // UUID
    expect(looksLikePan('150000')).toBe(false); // monto
    expect(looksLikePan('tok_visa_approved')).toBe(false); // token del proveedor
    expect(looksLikePan('12345678901234567890')).toBe(false); // 20 dígitos
    // 16 dígitos con prefijo de marca pero Luhn INVÁLIDO ⇒ no es un PAN.
    expect(looksLikePan('4242424242424241')).toBe(false);
  });
});

describe('findCardData (recorrido del body)', () => {
  it('detecta un PAN por VALOR en cualquier profundidad (pan_value), sin exponer el valor', () => {
    const hit = findCardData({ metadata: { notes: [{ ref: VISA_16 }] } });
    expect(hit).toEqual({ path: 'metadata.notes[0].ref', kind: 'pan_value' });
    expect(JSON.stringify(hit)).not.toContain(VISA_16);
  });

  it('detecta un campo con NOMBRE de tarjeta y valor numérico aunque no pase Luhn (pan_field)', () => {
    expect(findCardData({ card_number: '123456789012' })).toEqual({
      path: 'card_number',
      kind: 'pan_field',
    });
    expect(findCardData({ 'Card-Number': 4242424242424241 })).toEqual({
      path: 'Card-Number',
      kind: 'pan_field',
    });
  });

  it('detecta un campo de código de seguridad (cvv_field)', () => {
    expect(findCardData({ payment: { cvv: '123' } })).toEqual({
      path: 'payment.cvv',
      kind: 'cvv_field',
    });
    expect(findCardData({ cvc2: 1234 })).toEqual({ path: 'cvc2', kind: 'cvv_field' });
  });

  it('NO marca bodies legítimos (montos, refs, teléfonos, tokens, expiry)', () => {
    expect(
      findCardData({
        merchant_id: randomUUID(),
        amount: 150_000,
        currency: 'COP',
        description: `ref ${EPOCH_MS_13}`,
        provider_ref: EPOCH_MS_13,
        phone: '+57 300 123 4567',
        token: 'tok_visa_approved',
        expiry: '12/26',
      })
    ).toBeNull();
  });

  it('el recorrido está acotado (un body hostil ultra-anidado no lo vuelve cuadrático)', () => {
    let deep: Record<string, unknown> = { pan: VISA_16 };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    // Más allá de la cota de profundidad no se recorre: devuelve null sin colgarse.
    expect(findCardData(deep)).toBeNull();
  });
});

describe('guard sobre HTTP real (preValidation, antes de auth y de Zod)', () => {
  let app: FastifyInstance;
  let appPool: Pool;
  let authPool: Pool;
  let adminPool: Pool;
  let key: string;
  let merchantId: string;

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
    appPool = createPool({ connectionString: config.db.app, max: 4 });
    authPool = createPool({ connectionString: config.db.auth, max: 2 });
    adminPool = createPool({ connectionString: config.db.admin, max: 2 });
    const apiKeyService = new ApiKeyService(appPool);
    app = buildApp({
      config,
      appPool,
      authService: new AuthService(authPool),
      identityService: new IdentityService(appPool),
      apiKeyService,
    });
    await app.ready();

    const org = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        ['TM06 Org', `tm06-${randomUUID()}`]
      )
    ).rows[0]!.id;
    merchantId = (
      await adminPool.query<{ id: string }>(
        'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
        [org, `tm06-shop-${randomUUID().slice(0, 8)}`]
      )
    ).rows[0]!.id;
    key = (await apiKeyService.create(org, { label: 'tm06', scopes: ['read', 'payments:write'] }))
      .secret;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await Promise.all([appPool.end(), authPool.end(), adminPool.end()]);
  });

  it('rechaza un PAN ANTES de autenticar (sin Authorization ⇒ 422, no 401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      payload: { merchant_id: randomUUID(), amount: 1000, currency: 'COP', note: VISA_16 },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('card_data_not_allowed');
    expect(body.error.type).toBe('unprocessable_error');
    expect(body.error.request_id).toBeTruthy();
    // El PAN JAMÁS se refleja en la respuesta.
    expect(res.body).not.toContain(VISA_16);
  });

  it('rechaza un campo de tarjeta ANTES de la validación Zod (422, no validation_error)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': `tm06-${randomUUID()}` },
      payload: {
        merchant_id: merchantId,
        amount: 1000,
        currency: 'COP',
        cvv: '123', // campo desconocido para el schema — el guard gana la carrera
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('card_data_not_allowed');
  });

  it('NO bloquea un request legítimo con números grandes no-tarjeta (sin falso positivo)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': `tm06-${randomUUID()}` },
      payload: {
        merchant_id: merchantId,
        amount: 150_000,
        currency: 'COP',
        description: `pedido ${EPOCH_MS_13}`,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('created');
  });

  it('el incidente queda contado en /metrics (fluvia_card_data_rejected_total)', async () => {
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('fluvia_card_data_rejected_total');
    // Y el PAN de los rechazos anteriores no aparece por ningún lado.
    expect(metrics.body).not.toContain(VISA_16);
  });
});
