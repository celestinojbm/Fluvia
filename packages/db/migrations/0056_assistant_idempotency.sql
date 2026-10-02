-- ============================================================================
-- FLUVIA 0056_assistant_idempotency.sql  (cierre del asistente — T-07)
--
-- Reintentar un turno del asistente creaba OTRO mensaje de usuario y volvía a
-- llamar al proveedor y a las herramientas. Ahora cada turno lleva una clave
-- del cliente (`client_message_id`): el mismo turno no puede guardarse dos
-- veces en una conversación, y cada respuesta apunta al mensaje de usuario que
-- contesta (`reply_to`).
--
--  - Turno con respuesta completa → se reproduce la guardada (sin proveedor ni
--    herramientas).
--  - Respuesta cancelada o con error → se regenera sobre el MISMO mensaje de
--    usuario (no se duplica ni consume cuota).
--
-- Sin claves foráneas nuevas: la retención (purge_assistant_data) borra por
-- antigüedad y no debe depender del orden entre filas. Columnas nulas: los
-- mensajes anteriores y los clientes de la API que no envían clave siguen
-- funcionando como antes.
-- ============================================================================

ALTER TABLE assistant_messages
  ADD COLUMN client_message_id UUID,
  ADD COLUMN reply_to UUID;

CREATE UNIQUE INDEX assistant_messages_client_turn_uniq
  ON assistant_messages (conversation_id, client_message_id)
  WHERE role = 'user' AND client_message_id IS NOT NULL;

CREATE INDEX assistant_messages_reply_to_idx
  ON assistant_messages (reply_to, created_at)
  WHERE reply_to IS NOT NULL;
