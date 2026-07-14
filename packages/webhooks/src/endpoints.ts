import { insertAuditEvent, type AuditContext } from '@fluvia/audit';
import { withTenantTransaction, type Pool } from '@fluvia/db';
import {
  DEV_WEBHOOK_SECRET_ENC_KEY_HEX,
  encryptEndpointSecret,
  generateEndpointSecret,
  parseWebhookEncKey,
} from './crypto.js';
import { WEBHOOK_TOPICS, isWebhookTopic } from './events.js';
import { assertSafeWebhookUrl } from './ssrf.js';

export class WebhookEndpointNotFoundError extends Error {
  constructor() {
    super('Webhook endpoint not found');
    this.name = 'WebhookEndpointNotFoundError';
  }
}

export class InvalidWebhookTopicError extends Error {
  constructor(topic: string) {
    super(`Unknown webhook topic: ${topic} (catalog: ${WEBHOOK_TOPICS.join(', ')})`);
    this.name = 'InvalidWebhookTopicError';
  }
}

export interface WebhookEndpointDto {
  id: string;
  url: string;
  events: string[];
  status: string;
  description: string | null;
  createdAt: string;
  disabledAt: string | null;
}

export interface CreatedWebhookEndpoint extends WebhookEndpointDto {
  /** Secreto en claro — se entrega UNA unica vez. */
  secret: string;
}

/**
 * Modo de auditoría de las MUTACIONES (RA-F65B-003). Obligatorio y discriminado:
 * cada caller declara EXPLÍCITAMENTE si la mutación se audita (plano de sesión,
 * operador humano → `{ audit: userAuditContext(req) }`) o si intencionalmente no
 * se audita (plano de API key histórico → `{ audit: false }`). No existe un
 * tercer estado implícito por omisión: olvidar el argumento no compila.
 */
export type WebhookEndpointAuditMode = { audit: AuditContext } | { audit: false };

export interface WebhookEndpointServiceOptions {
  /** Clave AES (64 hex). Default SOLO local; en cloud viene de config. */
  encKeyHex?: string;
  /** SOLO local/test: relaja el guard de URL (http/redes privadas). */
  allowPrivateNetworks?: boolean;
  /** Ventana de validez del secreto anterior tras rotar (default 24 h). */
  rotationGraceMs?: number;
}

interface EndpointRow {
  id: string;
  url: string;
  events: string[];
  status: string;
  description: string | null;
  created_at: Date;
  disabled_at: Date | null;
}

function toDto(r: EndpointRow): WebhookEndpointDto {
  return {
    id: r.id,
    url: r.url,
    events: r.events,
    status: r.status,
    description: r.description,
    createdAt: r.created_at.toISOString(),
    disabledAt: r.disabled_at?.toISOString() ?? null,
  };
}

export class WebhookEndpointService {
  private readonly encKeyHex: string;
  private readonly allowPrivate: boolean;
  private readonly rotationGraceMs: number;

  constructor(
    /** Pool con rol fluvia_app (RLS forzado). */
    private readonly appPool: Pool,
    options: WebhookEndpointServiceOptions = {}
  ) {
    this.encKeyHex = options.encKeyHex ?? DEV_WEBHOOK_SECRET_ENC_KEY_HEX;
    parseWebhookEncKey(this.encKeyHex); // falla rapido
    this.allowPrivate = options.allowPrivateNetworks ?? false;
    this.rotationGraceMs = options.rotationGraceMs ?? 24 * 3600 * 1000;
  }

  /**
   * Crea un endpoint. `auditMode` OBLIGATORIO (RA-F65B-003): con
   * `{ audit: AuditContext }` (plano de SESIÓN, operador humano) el evento
   * `webhook_endpoint.created` se escribe en la MISMA transacción que el INSERT
   * (rastro atómico, patrón de `WebhookEventService.resend`); con
   * `{ audit: false }` (plano de API key histórico) la mutación es
   * intencionalmente no auditada — idéntico al comportamiento previo, pero
   * declarado. El secreto en claro se devuelve UNA vez y JAMÁS entra en el
   * resumen de auditoría.
   */
  async create(
    tenantId: string,
    input: { url: string; events?: string[]; description?: string; createdByUserId?: string },
    auditMode: WebhookEndpointAuditMode
  ): Promise<CreatedWebhookEndpoint> {
    assertSafeWebhookUrl(input.url, { allowPrivateNetworks: this.allowPrivate });
    const events = input.events ?? [];
    for (const topic of events) {
      if (!isWebhookTopic(topic)) throw new InvalidWebhookTopicError(topic);
    }
    const secret = generateEndpointSecret();
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<EndpointRow>(
        `INSERT INTO webhook_endpoints (tenant_id, url, secret_enc, events, description, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, url, events, status, description, created_at, disabled_at`,
        [
          tenantId,
          input.url,
          encryptEndpointSecret(this.encKeyHex, secret),
          events,
          input.description ?? null,
          input.createdByUserId ?? null,
        ]
      );
      const dto = toDto(res.rows[0]!);
      if (auditMode.audit) {
        await insertAuditEvent(c, {
          action: 'webhook_endpoint.created',
          tenantId,
          context: auditMode.audit,
          resourceType: 'webhook_endpoint',
          resourceId: dto.id,
          riskLevel: 'medium',
          // NUNCA el secreto: solo metadata segura.
          after: { url: dto.url, events: dto.events, status: dto.status },
        });
      }
      return { ...dto, secret };
    });
  }

  async list(tenantId: string): Promise<WebhookEndpointDto[]> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<EndpointRow>(
        `SELECT id, url, events, status, description, created_at, disabled_at
         FROM webhook_endpoints ORDER BY created_at DESC`
      );
      return res.rows.map(toDto);
    });
  }

  /** Detalle por id bajo RLS (F6.5B1): un endpoint ajeno/inexistente es
   *  invisible → 404 limpio, sin oráculo de existencia cross-tenant. */
  async get(tenantId: string, endpointId: string): Promise<WebhookEndpointDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<EndpointRow>(
        `SELECT id, url, events, status, description, created_at, disabled_at
         FROM webhook_endpoints WHERE id = $1`,
        [endpointId]
      );
      if (!res.rows[0]) throw new WebhookEndpointNotFoundError();
      return toDto(res.rows[0]);
    });
  }

  /**
   * Rotacion (webhook-delivery.md §2): el secreto anterior sigue firmando
   * durante la ventana de gracia — cada entrega lleva `v1=nuevo,v1=viejo`
   * hasta que expire, y el comercio migra sin perder verificaciones.
   * `auditMode` OBLIGATORIO (RA-F65B-003): `{ audit: ctx }` audita
   * `webhook_endpoint.rotated` atómicamente; `{ audit: false }` declara la
   * mutación no auditada (plano API-key histórico).
   */
  async rotateSecret(
    tenantId: string,
    endpointId: string,
    auditMode: WebhookEndpointAuditMode
  ): Promise<CreatedWebhookEndpoint> {
    const secret = generateEndpointSecret();
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<EndpointRow>(
        `UPDATE webhook_endpoints
         SET prev_secret_enc = secret_enc,
             prev_secret_expires_at = now() + make_interval(secs => $3::float8 / 1000),
             secret_enc = $2,
             updated_at = now()
         WHERE id = $1 AND status = 'active'
         RETURNING id, url, events, status, description, created_at, disabled_at`,
        [endpointId, encryptEndpointSecret(this.encKeyHex, secret), this.rotationGraceMs]
      );
      if (!res.rows[0]) throw new WebhookEndpointNotFoundError();
      const dto = toDto(res.rows[0]);
      if (auditMode.audit) {
        await insertAuditEvent(c, {
          action: 'webhook_endpoint.rotated',
          tenantId,
          context: auditMode.audit,
          resourceType: 'webhook_endpoint',
          resourceId: dto.id,
          riskLevel: 'high',
          // NUNCA el secreto (ni el nuevo ni el anterior).
          after: { url: dto.url, status: dto.status },
        });
      }
      return { ...dto, secret };
    });
  }

  /**
   * Desactivación IDEMPOTENTE (RA-F65B-002): solo la transición real
   * `active → disabled` establece `disabled_at` y (con `{ audit: ctx }`) emite
   * UN único evento `webhook_endpoint.disabled` en la misma transacción. Un
   * disable repetido es un no-op: devuelve el DTO ya disabled preservando el
   * `disabled_at` original y SIN evento adicional. Seguro frente a carreras:
   * el predicado `status = 'active'` se re-evalúa tras el lock de fila, así
   * que de dos disables concurrentes solo uno transiciona (y audita).
   * `auditMode` OBLIGATORIO (RA-F65B-003).
   */
  async disable(
    tenantId: string,
    endpointId: string,
    auditMode: WebhookEndpointAuditMode
  ): Promise<WebhookEndpointDto> {
    return withTenantTransaction(this.appPool, tenantId, async (c) => {
      const res = await c.query<EndpointRow>(
        `UPDATE webhook_endpoints
         SET status = 'disabled', disabled_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'active'
         RETURNING id, url, events, status, description, created_at, disabled_at`,
        [endpointId]
      );
      if (!res.rows[0]) {
        // Sin transición: inexistente/ajeno (RLS lo hace invisible → 404) o ya
        // disabled (no-op idempotente: mismo `disabled_at`, cero auditoría).
        const existing = await c.query<EndpointRow>(
          `SELECT id, url, events, status, description, created_at, disabled_at
           FROM webhook_endpoints WHERE id = $1`,
          [endpointId]
        );
        if (!existing.rows[0]) throw new WebhookEndpointNotFoundError();
        return toDto(existing.rows[0]);
      }
      const dto = toDto(res.rows[0]);
      if (auditMode.audit) {
        await insertAuditEvent(c, {
          action: 'webhook_endpoint.disabled',
          tenantId,
          context: auditMode.audit,
          resourceType: 'webhook_endpoint',
          resourceId: dto.id,
          riskLevel: 'medium',
          before: { url: dto.url },
          after: { status: dto.status },
        });
      }
      return dto;
    });
  }
}
