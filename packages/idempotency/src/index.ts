import { createHash } from 'node:crypto';
import { withTenantTransaction, type Pool, type PoolClient } from '@fluvia/db';

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
 *  - RA-F6-001: la transaccion corre por `withTenantTransaction` (V2-R1), asi
 *    que las TRES cotas de tiempo (`statement_timeout`, `lock_timeout`,
 *    `idle_in_transaction_session_timeout`) quedan activas como SET LOCAL —
 *    un handler patologico o una sesion idle dentro de la tx no puede acaparar
 *    una conexion del pool sin limite.
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
  /**
   * RA-F6-001: maximo por sentencia dentro de la tx idempotente (default
   * 30 000 — el default sistemico de V2-R1). DEBE ser > `lockTimeoutMs` para
   * que un claim bloqueado siempre supere primero el lock_timeout (55P03 →
   * 409 `processing_in_flight`) y nunca un 57014 crudo.
   */
  statementTimeoutMs?: number;
  /**
   * RA-F6-001: maximo idle DENTRO de la tx idempotente antes de que Postgres
   * la aborte (default 60 000 — el default sistemico de V2-R1). Acota un
   * handler que se queda esperando I/O ajeno con la tx abierta.
   */
  idleInTxTimeoutMs?: number;
  /**
   * F6 (threat model §5): retencion de la key en HORAS (default 24). DEBE ser
   * >= la ventana maxima de retry del cliente: si la key expira antes de un
   * reintento legitimo, la fila se purga y el efecto se RE-EJECUTA (doble
   * cobro). El valor definitivo lo fija el propietario antes del sandbox
   * compartido (PEND-006); aqui solo se hace configurable.
   */
  retentionHours?: number;
}

interface StoredKeyRow {
  request_hash: string;
  status: string;
  response_status: number | null;
  response_body: unknown;
}

/** Techo de los *_timeout de Postgres (integer ms) — espejo de @fluvia/db. */
const PG_MAX_TIMEOUT_MS = 2_147_483_647;

export class IdempotencyService {
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleInTxTimeoutMs: number;
  private readonly retentionHours: number;

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
    const s = Math.floor(options.statementTimeoutMs ?? 30_000);
    if (!Number.isFinite(s) || s < 1 || s > PG_MAX_TIMEOUT_MS) {
      throw new RangeError('statementTimeoutMs must be between 1 and 2147483647');
    }
    // Contrato 55P03: un claim bloqueado debe agotar PRIMERO el lock_timeout
    // (→ 409 processing_in_flight); si statement <= lock, la espera podria
    // abortar como 57014 crudo y romper la semantica documentada.
    if (s <= t) {
      throw new RangeError('statementTimeoutMs must be greater than lockTimeoutMs');
    }
    this.statementTimeoutMs = s;
    const i = Math.floor(options.idleInTxTimeoutMs ?? 60_000);
    if (!Number.isFinite(i) || i < 1 || i > PG_MAX_TIMEOUT_MS) {
      throw new RangeError('idleInTxTimeoutMs must be between 1 and 2147483647');
    }
    this.idleInTxTimeoutMs = i;
    const h = Math.floor(options.retentionHours ?? 24);
    if (!Number.isFinite(h) || h < 1 || h > 720) {
      throw new RangeError('retentionHours must be between 1 and 720');
    }
    this.retentionHours = h;
  }

  async execute(input: ExecuteIdempotentInput): Promise<ExecuteIdempotentResult> {
    // RA-F6-001: la tx corre por el UNICO camino sancionado (withTenantTransaction,
    // V2-R1) — contexto de tenant + las TRES cotas (`statement_timeout`,
    // `lock_timeout`, `idle_in_transaction_session_timeout`) como SET LOCAL
    // parametrizado; mueren con el COMMIT/ROLLBACK.
    return withTenantTransaction(
      this.appPool,
      input.tenantId,
      async (client) => {
        let claimed;
        try {
          claimed = await client.query(
            // expires_at EXPLICITO desde config (F6): la retencion debe cubrir la
            // ventana de retry del cliente (el DEFAULT de la tabla es solo fallback).
            `INSERT INTO idempotency_keys (tenant_id, endpoint, key, request_hash, expires_at)
             VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
             ON CONFLICT (tenant_id, endpoint, key) DO NOTHING
             RETURNING key`,
            [input.tenantId, input.endpoint, input.key, input.requestHash, this.retentionHours]
          );
        } catch (err) {
          if ((err as { code?: string }).code === '55P03') {
            throw new ProcessingInFlightError(input.key);
          }
          throw err;
        }

        if ((claimed.rowCount ?? 0) === 0) {
          // Key ya comprometida por una request anterior: decidir por contrato.
          // Rama SOLO LECTURA: que termine en COMMIT (return) o ROLLBACK (throw)
          // es observacionalmente identico — no hay efecto que persistir.
          const existing = await client.query<StoredKeyRow>(
            `SELECT request_hash, status, response_status, response_body
             FROM idempotency_keys
             WHERE endpoint = $1 AND key = $2`,
            [input.endpoint, input.key]
          );
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
        return { ...response, replayed: false };
      },
      {
        lockTimeoutMs: this.lockTimeoutMs,
        statementTimeoutMs: this.statementTimeoutMs,
        idleInTxTimeoutMs: this.idleInTxTimeoutMs,
      }
    );
  }
}
