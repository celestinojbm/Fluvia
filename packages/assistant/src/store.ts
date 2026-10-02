import type { Pool, PoolClient } from '@fluvia/db';
import type { Surface } from './policy.js';

/**
 * Persistencia del asistente. TODA consulta va por `withOwner`, que fija en la
 * misma transacción `app.tenant_id` y `app.actor_id`: la política RLS de 0055
 * exige ambos, así que ni un error de la aplicación puede leer la conversación
 * o el adjunto de otro titular, aunque comparta tenant.
 */
export interface Owner {
  tenantId: string;
  ownerId: string;
  kind: 'consumer' | 'user';
  surface: Surface;
}

export class AssistantNotFoundError extends Error {
  constructor() {
    super('Assistant resource not found');
    this.name = new.target.name;
  }
}

export async function withOwner<T>(
  pool: Pool,
  owner: Owner,
  fn: (c: PoolClient) => Promise<T>
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true),
              set_config('statement_timeout', '5000', true)`,
      [owner.tenantId, owner.ownerId]
    );
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export interface ConversationDto {
  id: string;
  title: string;
  surface: Surface;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  inputMode: 'text' | 'voice' | 'call';
  attachmentIds: string[];
  actions: string[];
  toolsUsed: string[];
  provider: string | null;
  simulated: boolean;
  status: 'complete' | 'cancelled' | 'error';
  createdAt: string;
}

export interface AttachmentDto {
  id: string;
  kind: 'image' | 'audio';
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: 'uploaded' | 'sent' | 'deleted';
  storageKey: string;
  createdAt: string;
}

const conv = (r: Record<string, unknown>): ConversationDto => ({
  id: r.id as string,
  title: r.title as string,
  surface: r.surface as Surface,
  createdAt: (r.created_at as Date).toISOString(),
  updatedAt: (r.updated_at as Date).toISOString(),
});
const msg = (r: Record<string, unknown>): MessageDto => ({
  id: r.id as string,
  role: r.role as MessageDto['role'],
  content: r.content as string,
  inputMode: r.input_mode as MessageDto['inputMode'],
  attachmentIds: r.attachment_ids as string[],
  actions: r.actions as string[],
  toolsUsed: r.tools_used as string[],
  provider: (r.provider as string | null) ?? null,
  simulated: r.simulated as boolean,
  status: r.status as MessageDto['status'],
  createdAt: (r.created_at as Date).toISOString(),
});
const att = (r: Record<string, unknown>): AttachmentDto => ({
  id: r.id as string,
  kind: r.kind as AttachmentDto['kind'],
  mime: r.mime as string,
  bytes: r.bytes as number,
  width: (r.width as number | null) ?? null,
  height: (r.height as number | null) ?? null,
  durationMs: (r.duration_ms as number | null) ?? null,
  status: r.status as AttachmentDto['status'],
  storageKey: r.storage_key as string,
  createdAt: (r.created_at as Date).toISOString(),
});

export class AssistantStore {
  constructor(private readonly pool: Pool) {}

  run<T>(owner: Owner, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withOwner(this.pool, owner, fn);
  }

  async createConversation(c: PoolClient, owner: Owner, title: string): Promise<ConversationDto> {
    const r = await c.query(
      `INSERT INTO assistant_conversations (tenant_id, owner_kind, owner_id, surface, title)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        owner.tenantId,
        owner.kind,
        owner.ownerId,
        owner.surface,
        title.slice(0, 80) || 'Conversación',
      ]
    );
    return conv(r.rows[0]);
  }

  async listConversations(c: PoolClient, owner: Owner): Promise<ConversationDto[]> {
    const r = await c.query(
      `SELECT * FROM assistant_conversations WHERE surface = $1 ORDER BY updated_at DESC LIMIT 30`,
      [owner.surface]
    );
    return r.rows.map(conv);
  }

  async getConversation(c: PoolClient, owner: Owner, id: string): Promise<ConversationDto> {
    const r = await c.query(
      `SELECT * FROM assistant_conversations WHERE id = $1 AND surface = $2`,
      [id, owner.surface]
    );
    if (!r.rows[0]) throw new AssistantNotFoundError();
    return conv(r.rows[0]);
  }

  async touchConversation(c: PoolClient, id: string): Promise<void> {
    await c.query(`UPDATE assistant_conversations SET updated_at = now() WHERE id = $1`, [id]);
  }

  async listMessages(c: PoolClient, conversationId: string, limit = 60): Promise<MessageDto[]> {
    const r = await c.query(
      `SELECT * FROM (SELECT * FROM assistant_messages WHERE conversation_id = $1
                       ORDER BY created_at DESC LIMIT $2) m ORDER BY created_at`,
      [conversationId, limit]
    );
    return r.rows.map(msg);
  }

  async addMessage(
    c: PoolClient,
    owner: Owner,
    m: Omit<MessageDto, 'id' | 'createdAt'> & { conversationId: string }
  ): Promise<MessageDto> {
    const r = await c.query(
      `INSERT INTO assistant_messages
         (tenant_id, owner_id, conversation_id, role, content, input_mode, attachment_ids,
          actions, tools_used, provider, simulated, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        owner.tenantId,
        owner.ownerId,
        m.conversationId,
        m.role,
        m.content.slice(0, 8000),
        m.inputMode,
        m.attachmentIds,
        m.actions,
        m.toolsUsed,
        m.provider,
        m.simulated,
        m.status,
      ]
    );
    return msg(r.rows[0]);
  }

  /** Mensajes de usuario de hoy (UTC) para la cuota diaria. */
  async countUserMessagesToday(c: PoolClient): Promise<number> {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM assistant_messages
        WHERE role = 'user' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
    );
    return r.rows[0]!.n;
  }

  async addAttachment(
    c: PoolClient,
    owner: Owner,
    a: Omit<AttachmentDto, 'id' | 'status' | 'createdAt'> & { sha256: string }
  ): Promise<AttachmentDto> {
    const r = await c.query(
      `INSERT INTO assistant_attachments
         (tenant_id, owner_id, kind, mime, bytes, width, height, duration_ms, sha256, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        owner.tenantId,
        owner.ownerId,
        a.kind,
        a.mime,
        a.bytes,
        a.width,
        a.height,
        a.durationMs,
        a.sha256,
        a.storageKey,
      ]
    );
    return att(r.rows[0]);
  }

  async getAttachment(c: PoolClient, id: string): Promise<AttachmentDto> {
    const r = await c.query(`SELECT * FROM assistant_attachments WHERE id = $1`, [id]);
    if (!r.rows[0] || r.rows[0].status === 'deleted') throw new AssistantNotFoundError();
    return att(r.rows[0]);
  }

  async markDeleted(c: PoolClient, id: string): Promise<AttachmentDto> {
    const r = await c.query(
      `UPDATE assistant_attachments SET status = 'deleted', deleted_at = now()
        WHERE id = $1 AND status = 'uploaded' RETURNING *`,
      [id]
    );
    if (!r.rows[0]) throw new AssistantNotFoundError();
    return att(r.rows[0]);
  }

  async markSent(c: PoolClient, ids: string[]): Promise<void> {
    if (ids.length) {
      await c.query(
        `UPDATE assistant_attachments SET status = 'sent' WHERE id = ANY($1) AND status = 'uploaded'`,
        [ids]
      );
    }
  }
}
