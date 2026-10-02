-- ============================================================================
-- FLUVIA 0055_assistant.sql  (jornada presentación — asistente «Fluvia»)
--
-- Conversaciones, mensajes y adjuntos (fotos y notas de voz) del asistente de
-- Personal y Comercio.
--
-- Aislamiento DOBLE en el motor (RLS forzado):
--   tenant_id = app.tenant_id  Y  owner_id = app.actor_id
-- Los clientes de Personal comparten el tenant del programa: sin el filtro por
-- titular, uno podría leer la conversación de otro. La API fija ambos valores
-- con SET LOCAL en la misma transacción (ver packages/assistant/src/store.ts).
--
-- Sin DELETE para los roles de ejecución (meta-test): el borrado de un adjunto
-- antes de enviarlo es lógico (status = 'deleted', fichero eliminado del disco
-- por la API); la RETENCIÓN la aplica purge_assistant_data() (SECURITY
-- DEFINER, EXECUTE solo fluvia_worker), que borra filas vencidas y devuelve
-- las claves de almacenamiento para que el worker elimine los ficheros.
--
-- Clasificación de datos: CONFIDENCIAL (contenido aportado por el usuario,
-- posibles datos personales). Nunca se registra en logs.
-- ============================================================================

CREATE TABLE assistant_conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES organizations(id),
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN ('consumer', 'user')),
  owner_id    UUID NOT NULL,
  surface     TEXT NOT NULL CHECK (surface IN ('personal', 'commerce')),
  title       TEXT NOT NULL DEFAULT 'Conversación' CHECK (char_length(title) BETWEEN 1 AND 80),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE INDEX assistant_conversations_owner_idx
  ON assistant_conversations (tenant_id, owner_id, updated_at DESC);

CREATE TABLE assistant_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id),
  owner_id        UUID NOT NULL,
  conversation_id UUID NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL CHECK (char_length(content) <= 8000),
  -- Origen del texto del usuario: escrito, transcripción editada de voz o llamada.
  input_mode      TEXT NOT NULL DEFAULT 'text' CHECK (input_mode IN ('text', 'voice', 'call')),
  attachment_ids  UUID[] NOT NULL DEFAULT '{}',
  -- Acciones sugeridas (ids de la lista cerrada de pantallas) y herramientas usadas.
  actions         TEXT[] NOT NULL DEFAULT '{}',
  tools_used      TEXT[] NOT NULL DEFAULT '{}',
  provider        TEXT,
  simulated       BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'complete'
                    CHECK (status IN ('complete', 'cancelled', 'error')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assistant_messages_conversation_fk
    FOREIGN KEY (conversation_id, tenant_id) REFERENCES assistant_conversations (id, tenant_id)
);
CREATE INDEX assistant_messages_conv_idx ON assistant_messages (conversation_id, created_at);
CREATE INDEX assistant_messages_owner_day_idx ON assistant_messages (tenant_id, owner_id, created_at)
  WHERE role = 'user';

CREATE TABLE assistant_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id),
  owner_id        UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('image', 'audio')),
  mime            TEXT NOT NULL CHECK (mime IN (
                    'image/jpeg', 'image/png', 'image/webp',
                    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav')),
  bytes           INT NOT NULL CHECK (bytes > 0),
  width           INT CHECK (width IS NULL OR width > 0),
  height          INT CHECK (height IS NULL OR height > 0),
  duration_ms     INT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  sha256          TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Clave opaca del almacenamiento privado (jamás una ruta del usuario).
  storage_key     TEXT NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9a-f]{2}/[0-9a-f-]{36}$'),
  status          TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'sent', 'deleted')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE INDEX assistant_attachments_owner_idx ON assistant_attachments (tenant_id, owner_id, created_at);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_conversations', 'assistant_messages', 'assistant_attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
                AND owner_id = NULLIF(current_setting(''app.actor_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
                AND owner_id = NULLIF(current_setting(''app.actor_id'', true), '''')::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO fluvia_app', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fluvia_forbid_mutation()',
      t || '_no_truncate', t);
  END LOOP;
END $$;

-- Mensajes inmutables una vez escritos (salvo por la purga de retención).
CREATE TRIGGER assistant_messages_no_update
  BEFORE UPDATE ON assistant_messages
  FOR EACH ROW EXECUTE FUNCTION fluvia_forbid_mutation();
REVOKE UPDATE ON assistant_messages FROM fluvia_app;

-- ----------------------------------------------------------------------------
-- Retención: borra conversaciones sin actividad y adjuntos más antiguos que
-- p_days (o adjuntos «uploaded» huérfanos de más de 1 día) y devuelve las
-- claves de almacenamiento a eliminar. Sin parámetros de alcance por tenant:
-- imposible de usar para borrar datos de alguien en concreto.
-- ----------------------------------------------------------------------------
CREATE FUNCTION purge_assistant_data(p_days INT)
RETURNS TABLE (storage_key TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff TIMESTAMPTZ := now() - make_interval(days => GREATEST(p_days, 1));
BEGIN
  RETURN QUERY
  DELETE FROM assistant_attachments a
   WHERE a.created_at < cutoff
      OR (a.status = 'uploaded' AND a.created_at < now() - interval '1 day')
      OR (a.status = 'deleted')
  RETURNING a.storage_key;

  DELETE FROM assistant_messages m
   USING assistant_conversations c
   WHERE m.conversation_id = c.id AND c.updated_at < cutoff;
  DELETE FROM assistant_conversations c WHERE c.updated_at < cutoff;
END;
$$;

-- La función borra filas a propósito: los triggers de inmutabilidad de UPDATE
-- no afectan a DELETE; no hay trigger de DELETE en estas tablas.
REVOKE ALL ON FUNCTION purge_assistant_data(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_assistant_data(INT) TO fluvia_worker;
