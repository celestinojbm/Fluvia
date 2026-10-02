-- ============================================================================
-- FLUVIA 0062_assistant_buyer.sql  (jornada restaurantes y cobro presencial)
--
-- Asistente del COMPRADOR en el checkout y en el seguimiento del pedido.
-- Reutiliza las tablas y la RLS de 0055 (tenant + titular): el titular de un
-- comprador es un identificador DERIVADO de su credencial (sesión de checkout
-- o pedido del token de seguimiento), así que dos compradores nunca comparten
-- conversación aunque compren en el mismo comercio. No hay cuentas nuevas ni
-- acceso a billetera: las herramientas del comprador son de lectura y solo
-- ven SU checkout o SU pedido.
-- ============================================================================

ALTER TABLE assistant_conversations DROP CONSTRAINT assistant_conversations_owner_kind_check;
ALTER TABLE assistant_conversations ADD CONSTRAINT assistant_conversations_owner_kind_check
  CHECK (owner_kind IN ('consumer', 'user', 'buyer'));
ALTER TABLE assistant_conversations DROP CONSTRAINT assistant_conversations_surface_check;
ALTER TABLE assistant_conversations ADD CONSTRAINT assistant_conversations_surface_check
  CHECK (surface IN ('personal', 'commerce', 'buyer'));
-- La superficie y el tipo de titular van juntos: un comprador nunca abre una
-- conversación de Personal o de Comercio, ni al revés.
ALTER TABLE assistant_conversations ADD CONSTRAINT assistant_conversations_buyer_surface
  CHECK ((owner_kind = 'buyer') = (surface = 'buyer'));
