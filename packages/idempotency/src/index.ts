import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from '@fluvia/db';

/**
 * F2-09 — Capa de idempotencia API (ADR-0006, contrato de idempotency.md §3).
 *
 * Diseño (implementa el contrato caso a caso):
 *  - El CLAIM de la key se inserta EN LA MISMA transaccion que el efecto y la
 *    respuesta se persiste `completed` antes del COMMIT. Consecuencias:
 *      * crash ANTES del COMMIT  => ni key ni efecto (rollback conjunto);
 *        el reintento ejecuta limpio.
 *      * crash DESPUES del COMMIT => key `completed` con respuesta; el
 *        reintento replaya sin re-ejecutar.
 *  - Dos requests concurrentes con la misma key: el segundo se bloquea en el
 *    indice unico hasta el COMMIT del primero (dentro de `lockTimeoutMs`) y
 *    entonces replaya; si el primero tarda mas que el timeout, el segundo
 *    recibe `processing_in_flight` (409) y reintenta luego — jamas hay doble
 *    ejecucion.
 *  - Mismo key con payload distinto (hash canonico sha256): rechazo 422
 *    `idempotency_key_reuse`; el handler NUNCA se ejecuta.
 *  - PostgreSQL es la UNICA fuente (Gate Idempotencia): no hay fast-path
 *    Redis; su perdida es irrelevante para la garantia.
 *  - `expires_at` (0013) solo gobierna la purga administrada (F1-09):
 *    mientras la fila exista se comporta igual.
 */

export class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Header ausente o malformado en un endpoint que lo exige (HTTP 400). */
export class IdempotencyKeyRequiredError extends IdempotencyError {
  constructor() {
    super('The Idempotency-Key header is required and must be 1-255 printable characters');
  }
}

/** Otra request con la misma key sigue en vuelo (HTTP 409; reintentar luego). */
export class ProcessingInFlightError extends IdempotencyError {
  constructor(readonly key: string) {
    super(`A request with idempotency key "${key}" is still being processed`);
  }
}

/** Misma key con payload DISTINTO: jamas se ejecuta (HTTP 422). */
export class IdempotencyKeyReuseError extends IdempotencyError {
  constructor(readonly key: string) {
    super(`Idempotency key "${key}" was already used with a different payload`);
  }
}

export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Valida el valor del header; lanza si falta o es invalido. */
export function assertValidIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_RE.test(value)) {
    throw new IdempotencyKeyRequiredError();
  }
  return value;
}

/** JSON canonico: claves ordenadas recursivamente (independiente del orden de envio). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** sha256 hex del payload normalizado (idempotency.md §2). */
export function computeRequestHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export interface ExecuteIdempotentInput {
  tenantId: string;
  /** Identificador estable del endpoint (p.ej. 'POST /v1/payment_intents'). */
  endpoint: string;
  key: string;
  /** Hash canonico del payload (computeRequestHash). */
  requestHash: string;
  /**
   * Efecto + respuesta, ejecutado EXACTAMENTE una vez por (tenant, endpoint,
   * key). Corre DENTRO de la transaccion del claim: todo su SQL debe usar el
   * client recibido; PROHIBIDO llamar servicios que abran su propia
   * transaccion o hacer llamadas externas (Nivel A).
   */
  handler: (client: PoolClient) => Promise<IdempotentResponse>;
}

export interface ExecuteIdempotentResult extends IdempotentResponse {
  /** true si se devolvio la respuesta persistida sin re-ejecutar el handler. */
  replayed: boolean;
}

export interface IdempotencyServiceOptions {
  /** Espera maxima sobre una key en vuelo antes de responder 409 (default 3000). */
  lockTimeoutMs?: number;
}

interface StoredKeyRow {
  request_hash: string;
  status: string;
  response_status: number | null;
  response_body: unknown;
}

export class IdempotencyService {
  private readonly lockTimeoutMs: number;

  constructor(
    /** Pool con rol fluvia_app (RLS por tenant sobre idempotency_keys). */
    private readonly appPool: Pool,
    options: IdempotencyServiceOptions = {}
  ) {
    const t = Math.floor(options.lockTimeoutMs ?? 3_000);
    if (!Number.isFinite(t) || t < 1 || t > 60_000) {
      throw new RangeError('lockTimeoutMs must be between 1 and 60000');
    }
    this.lockTimeoutMs = t;
  }

  async execute(input: ExecuteIdempotentInput): Promise<ExecuteIdempotentResult> {
    const client = await this.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
      // Acota la espera sobre el claim de otra request en vuelo (55P03).
      await client.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);

      let claimed;
      try {
        claimed = await client.query(
          `INSERT INTO idempotency_keys (tenant_id, endpoint, key, request_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, endpoint, key) DO NOTHING
           RETURNING key`,
          [input.tenantId, input.endpoint, input.key, input.requestHash]
        );
      } catch (err) {
        if ((err as { code?: string }).code === '55P03') {
          throw new ProcessingInFlightError(input.key);
        }
        throw err;
      }

      if ((claimed.rowCount ?? 0) === 0) {
        // Key ya comprometida por una request anterior: decidir por contrato.
        const existing = await client.query<StoredKeyRow>(
          `SELECT request_hash, status, response_status, response_body
           FROM idempotency_keys
           WHERE endpoint = $1 AND key = $2`,
          [input.endpoint, input.key]
        );
        await client.query('COMMIT'); // solo lectura
        const row = existing.rows[0];
        if (!row) {
          // Solo posible si otra rama del RLS la oculta: tratar como conflicto.
          throw new IdempotencyKeyReuseError(input.key);
        }
        if (row.request_hash !== input.requestHash) {
          throw new IdempotencyKeyReuseError(input.key);
        }
        if (row.status !== 'completed' || row.response_status === null) {
          // in_progress COMMITEADO: huerfano de un flujo multi-paso ajeno a
          // esta capa (aqui nunca se commitea in_progress). Cliente reintenta.
          throw new ProcessingInFlightError(input.key);
        }
        return { status: row.response_status, body: row.response_body, replayed: true };
      }

      // Somos los primeros: efecto + respuesta en ESTA transaccion.
      const response = await input.handler(client);
      await client.query(
        `UPDATE idempotency_keys
         SET status = 'completed', response_status = $3, response_body = $4, updated_at = now()
         WHERE endpoint = $1 AND key = $2`,
        [input.endpoint, input.key, response.status, JSON.stringify(response.body ?? null)]
      );
      await client.query('COMMIT');
      return { ...response, replayed: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
