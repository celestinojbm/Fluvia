import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@fluvia/db/testing';
import {
  DEV_WEBHOOK_SECRET_ENC_KEY_HEX,
  decryptEndpointSecretWithKeyring,
  encryptEndpointSecret,
  generateEndpointSecret,
  inspectWebhookSecretKeys,
  reencryptWebhookSecrets,
  type WebhookEncKeyring,
} from '../src/index.js';

/**
 * F6 (ADR-0012) — rotación de la clave de cifrado de webhooks contra PG real.
 * La clave nueva (ACTUAL) es la de config (DEV), la vieja (`OLD_KEY`) queda
 * RETIRADA; el barrido `reencryptWebhookSecrets` (rol admin, cross-tenant) migra
 * los blobs a la actual preservando el secreto en claro. Se re-cifra HACIA la
 * clave de config para dejar la BD consistente para el resto de la suite.
 *
 * Cada test crea sus PROPIOS tenants (los conteos exactos no dependen del orden).
 */

// Clave "vieja" del test (distinta de la de config/DEV = la "nueva/actual").
const OLD_KEY = '1a'.repeat(32);
// Clave que NO está en ningún keyring del test (blob "envenenado" / corrupto).
const UNKNOWN_KEY = '99'.repeat(32);
const CURRENT = DEV_WEBHOOK_SECRET_ENC_KEY_HEX;
const rotating: WebhookEncKeyring = { current: CURRENT, retired: [OLD_KEY] };
const currentOnly: WebhookEncKeyring = { current: CURRENT, retired: [] };

let ctx: TestContext;

/** Inserta un endpoint con secret (+prev opcional) cifrados. `prevKeyHex` permite
 *  cifrar el prev con OTRA clave (fila "mixta"); por defecto usa la de `secret`. */
async function seedEndpoint(
  tenant: string,
  keyHex: string,
  secret: string,
  prevSecret: string | null,
  prevKeyHex: string = keyHex
): Promise<string> {
  const res = await ctx.admin.query<{ id: string }>(
    `INSERT INTO webhook_endpoints (tenant_id, url, secret_enc, prev_secret_enc, events)
     VALUES ($1, 'https://example.test/hook', $2, $3, '{}') RETURNING id`,
    [
      tenant,
      encryptEndpointSecret(keyHex, secret),
      prevSecret === null ? null : encryptEndpointSecret(prevKeyHex, prevSecret),
    ]
  );
  return res.rows[0]!.id;
}

async function readBlobs(
  id: string
): Promise<{ secret_enc: string; prev_secret_enc: string | null }> {
  const r = await ctx.admin.query<{ secret_enc: string; prev_secret_enc: string | null }>(
    `SELECT secret_enc, prev_secret_enc FROM webhook_endpoints WHERE id = $1`,
    [id]
  );
  return r.rows[0]!;
}

const freshTenant = () => ctx.createTenant(`Rot ${randomUUID().slice(0, 8)}`);

beforeAll(async () => {
  ctx = await createTestContext();
}, 30_000);

afterAll(async () => {
  await ctx.close();
});

describe('rotación de la clave de cifrado de webhooks (0043-less; keyring + re-cifrado)', () => {
  it('re-cifra de la clave retirada a la actual, cross-tenant, preservando el claro', async () => {
    const orgA = await freshTenant();
    const orgB = await freshTenant();
    // Dos endpoints en orgA (uno con prev tras una rotación de secreto) + uno en orgB,
    // todos cifrados bajo la clave VIEJA.
    const s1 = generateEndpointSecret();
    const s1prev = generateEndpointSecret();
    const s2 = generateEndpointSecret();
    const ep1 = await seedEndpoint(orgA, OLD_KEY, s1, s1prev);
    const ep2 = await seedEndpoint(orgB, OLD_KEY, s2, null);

    // ANTES: el keyring de rotación (actual + retirada) descifra el blob viejo;
    // solo-actual NO puede (prueba que la clave vieja se necesita hasta re-cifrar).
    const before = await readBlobs(ep1);
    expect(decryptEndpointSecretWithKeyring(rotating, before.secret_enc)).toEqual({
      plaintext: s1,
      isCurrent: false,
    });
    expect(() => decryptEndpointSecretWithKeyring(currentOnly, before.secret_enc)).toThrow(
      /no webhook enc key/i
    );

    // Barrido acotado a estos tenants (la CLI real corre global).
    const res = await reencryptWebhookSecrets(ctx.admin, rotating, { tenantIds: [orgA, orgB] });
    expect(res.total).toBe(2);
    expect(res.reencrypted).toBe(2);
    expect(res.alreadyCurrent).toBe(0);
    expect(res.failed).toBe(0);

    // DESPUÉS: solo con la clave ACTUAL (retirada eliminada) se descifra todo,
    // y el secreto en claro es idéntico — solo cambió el cifrado en reposo.
    const a = await readBlobs(ep1);
    expect(decryptEndpointSecretWithKeyring(currentOnly, a.secret_enc)).toEqual({
      plaintext: s1,
      isCurrent: true,
    });
    expect(decryptEndpointSecretWithKeyring(currentOnly, a.prev_secret_enc!).plaintext).toBe(
      s1prev
    );
    const b = await readBlobs(ep2);
    expect(decryptEndpointSecretWithKeyring(currentOnly, b.secret_enc).plaintext).toBe(s2);
    // El prev NULL se preserva como NULL (no se cifra una cadena vacía).
    expect(b.prev_secret_enc).toBeNull();
  }, 30_000);

  it('es idempotente: una segunda corrida no re-cifra nada', async () => {
    const org = await freshTenant();
    const ep = await seedEndpoint(org, OLD_KEY, generateEndpointSecret(), null);
    const first = await reencryptWebhookSecrets(ctx.admin, rotating, { tenantIds: [org] });
    expect(first.reencrypted).toBe(1);
    const second = await reencryptWebhookSecrets(ctx.admin, rotating, { tenantIds: [org] });
    expect(second.reencrypted).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.alreadyCurrent).toBe(second.total);
    // El endpoint ya está bajo la clave actual.
    const blobs = await readBlobs(ep);
    expect(decryptEndpointSecretWithKeyring(currentOnly, blobs.secret_enc).isCurrent).toBe(true);
  }, 30_000);

  it('el filtro tenantIds acota el re-cifrado (no toca otros tenants)', async () => {
    const orgIncluded = await freshTenant();
    const isolated = await freshTenant();
    await seedEndpoint(orgIncluded, OLD_KEY, generateEndpointSecret(), null);
    const epIso = await seedEndpoint(isolated, OLD_KEY, generateEndpointSecret(), null);
    // Barrido acotado a orgIncluded: NO debe tocar `isolated`.
    await reencryptWebhookSecrets(ctx.admin, rotating, { tenantIds: [orgIncluded] });
    const blobs = await readBlobs(epIso);
    // Sigue bajo la clave VIEJA (solo-actual no lo descifra; el rotating sí).
    expect(() => decryptEndpointSecretWithKeyring(currentOnly, blobs.secret_enc)).toThrow();
    expect(decryptEndpointSecretWithKeyring(rotating, blobs.secret_enc).isCurrent).toBe(false);
    // Y un barrido que lo incluya sí lo migra (deja la BD consistente).
    await reencryptWebhookSecrets(ctx.admin, rotating, { tenantIds: [isolated] });
    const after = await readBlobs(epIso);
    expect(decryptEndpointSecretWithKeyring(currentOnly, after.secret_enc).isCurrent).toBe(true);
  }, 30_000);

  it('fila mixta (secret ACTUAL, prev RETIRADO): re-cifra el prev pendiente', async () => {
    const org = await freshTenant();
    const sCur = generateEndpointSecret();
    const sPrev = generateEndpointSecret();
    // secret bajo la ACTUAL, prev bajo la RETIRADA → la fila NO está del todo migrada.
    const ep = await seedEndpoint(org, CURRENT, sCur, sPrev, OLD_KEY);
    const res = await reencryptWebhookSecrets(ctx.admin, rotating, { tenantIds: [org] });
    expect(res.reencrypted).toBe(1);
    expect(res.alreadyCurrent).toBe(0);
    // Tras el barrido AMBOS blobs quedan bajo la actual, con los claros intactos.
    const a = await readBlobs(ep);
    expect(decryptEndpointSecretWithKeyring(currentOnly, a.secret_enc).plaintext).toBe(sCur);
    expect(decryptEndpointSecretWithKeyring(currentOnly, a.prev_secret_enc!).plaintext).toBe(sPrev);
  }, 30_000);

  it('resiliencia: una fila indescifrable se REPORTA (failed) sin abortar las demás', async () => {
    const org = await freshTenant();
    const good = generateEndpointSecret();
    const epGood = await seedEndpoint(org, OLD_KEY, good, null);
    // Blob bajo una clave que NO está en el keyring de rotación → indescifrable.
    const epPoison = await seedEndpoint(org, UNKNOWN_KEY, generateEndpointSecret(), null);

    const res = await reencryptWebhookSecrets(ctx.admin, rotating, { tenantIds: [org] });
    // La buena se migró; la envenenada se contó como fallo, SIN tirar el barrido.
    expect(res.total).toBe(2);
    expect(res.reencrypted).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.failedIds).toContain(epPoison);

    // La buena quedó bajo la actual; la envenenada quedó INTACTA (no se corrompió).
    const g = await readBlobs(epGood);
    expect(decryptEndpointSecretWithKeyring(currentOnly, g.secret_enc).plaintext).toBe(good);
    const p = await readBlobs(epPoison);
    expect(
      decryptEndpointSecretWithKeyring({ current: UNKNOWN_KEY, retired: [] }, p.secret_enc)
        .plaintext
    ).toBeTypeOf('string');
  }, 30_000);

  it('inspección de solo-lectura: cuenta bajo-retirada/actual/indescifrable sin mutar', async () => {
    const org = await freshTenant();
    await seedEndpoint(org, OLD_KEY, generateEndpointSecret(), null);
    await seedEndpoint(org, OLD_KEY, generateEndpointSecret(), null);
    const epPoison = await seedEndpoint(org, UNKNOWN_KEY, generateEndpointSecret(), null);

    // ANTES: dos bajo la retirada + uno indescifrable.
    const before = await inspectWebhookSecretKeys(ctx.admin, rotating, { tenantIds: [org] });
    expect(before.total).toBe(3);
    expect(before.underRetired).toBe(2);
    expect(before.underCurrent).toBe(0);
    expect(before.undecryptable).toBe(1);
    expect(before.undecryptableIds).toContain(epPoison);

    // La inspección NO muta: un segundo vistazo da lo mismo (nada se re-cifró).
    const again = await inspectWebhookSecretKeys(ctx.admin, rotating, { tenantIds: [org] });
    expect(again.underRetired).toBe(2);

    // Tras el barrido: nada bajo la retirada; el indescifrable sigue reportado.
    await reencryptWebhookSecrets(ctx.admin, rotating, { tenantIds: [org] });
    const after = await inspectWebhookSecretKeys(ctx.admin, rotating, { tenantIds: [org] });
    expect(after.underRetired).toBe(0);
    expect(after.underCurrent).toBe(2);
    expect(after.undecryptable).toBe(1);
  }, 30_000);
});
